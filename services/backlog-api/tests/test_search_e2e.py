"""End to end indexing and search: REST/MCP write -> background worker -> embeddings gateway -> search.

Unlike ``test_indexing.py`` (which drives the worker by hand with a mocked transport) the app here runs its own worker
loop and talks over HTTP to a fake OpenAI-compatible embeddings gateway served on a local socket.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any

import httpx
import pytest
from asgi_lifespan import LifespanManager
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from sqlalchemy import func, select

from backlog_api.auth.tokens import StaticKeySource
from backlog_api.db.models import Job
from backlog_api.main import create_app
from backlog_api.settings import Settings
from backlog_api_testkit import API, TokenFactory, create_project
from conftest import truncate_all
from live_testkit import serve
from test_indexing import DIM, fake_vector
from test_mcp import mcp_client

OWNER = "alice@example.test"
CATS = "# Cats\n\n## Care\n\nCats need fresh water, a scratching post and regular veterinary visits."
TAXES = "# Taxes\n\n## Filing\n\nAnnual tax returns must be filed before the deadline with the revenue office."
SECRET = "# Secrets\n\nCats scratching post veterinary visits: the excluded plan."  # noqa: S105


def gateway_app(calls: list[list[str]]) -> FastAPI:
    gateway = FastAPI()

    @gateway.post("/v1/embeddings")
    async def embeddings(body: dict[str, Any]) -> JSONResponse:
        calls.append(list(body["input"]))
        data = [{"object": "embedding", "index": i, "embedding": fake_vector(t)} for i, t in enumerate(body["input"])]
        return JSONResponse({"object": "list", "data": data, "model": body["model"]})

    return gateway


@pytest.fixture
async def embedding_calls() -> list[list[str]]:
    return []


@pytest.fixture
async def stack(
    settings: Settings, tokens: TokenFactory, database_url: str, embedding_calls: list[list[str]]
) -> AsyncIterator[FastAPI]:
    await truncate_all(database_url)
    async with serve(gateway_app(embedding_calls)) as gateway_url:
        live = settings.model_copy(
            update={
                "worker_enabled": True,
                "worker_poll_seconds": 0.1,
                "item_index_debounce_seconds": 0.2,
                "llm_base_url": gateway_url,
                "embedding_dim": DIM,
                "embedding_max_retries": 0,
                "mcp_similar_min_score": 0.2,
            }
        )
        app = create_app(live, key_source=StaticKeySource(tokens.jwks), configure_logs=False)
        async with LifespanManager(app, startup_timeout=30):
            yield app


@pytest.fixture
async def http(stack: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=stack), base_url="http://backlog-api.test"
    ) as client:
        yield client


async def eventually(check: Callable[[], Awaitable[Any]], what: str, seconds: float = 15) -> Any:
    deadline = asyncio.get_running_loop().time() + seconds
    while True:
        result = await check()
        if result:
            return result
        assert asyncio.get_running_loop().time() < deadline, f"timed out waiting for {what}"
        await asyncio.sleep(0.1)


@asynccontextmanager
async def tool_caller(app: FastAPI, tokens: TokenFactory) -> AsyncIterator[Callable[..., Awaitable[dict[str, Any]]]]:
    async def call(name: str, **arguments: Any) -> dict[str, Any]:
        async with mcp_client(app, tokens.headers(OWNER)) as client:
            result = await client.call_tool(name, arguments)
        assert not result.is_error, result.structured_content
        return result.structured_content or {}

    yield call


async def test_source_upload_is_indexed_and_found_with_a_citation(
    stack: FastAPI, http: httpx.AsyncClient, tokens: TokenFactory
) -> None:
    pid = (await create_project(http, tokens, OWNER, "E2E"))["id"]
    headers = tokens.headers(OWNER)
    upload = await http.post(
        f"{API}/projects/{pid}/sources",
        files={"file": ("pets.md", CATS.encode(), "text/markdown")},
        data={"mode": "searchable"},
        headers=headers,
    )
    assert upload.status_code == 201, upload.text
    pets = upload.json()
    taxes = (
        await http.post(
            f"{API}/projects/{pid}/sources",
            json={"name": "Taxes", "text": TAXES, "mode": "searchable"},
            headers=headers,
        )
    ).json()
    secret = (
        await http.post(
            f"{API}/projects/{pid}/sources",
            json={"name": "Secret", "text": SECRET, "mode": "excluded"},
            headers=headers,
        )
    ).json()

    async def indexed() -> bool:
        listed = (await http.get(f"{API}/projects/{pid}/sources", headers=headers)).json()["items"]
        status = {s["id"]: s["indexStatus"] for s in listed}
        return (
            status[pets["id"]] == "indexed" and status[taxes["id"]] == "indexed" and status[secret["id"]] == "skipped"
        )

    await eventually(indexed, "sources to be indexed")

    async with tool_caller(stack, tokens) as call:
        found = await call("search_sources", projectId=pid, query="veterinary visits for my cat")
        assert found["semantic"] is True
        top = found["passages"][0]
        assert top["citationId"] == f"src:{pets['id']}#0"
        assert top["sourceName"] == "pets.md" and top["headingPath"] == "Cats > Care"
        assert "veterinary" in top["text"]
        assert secret["id"] not in {p["sourceId"] for p in found["passages"]}
        assert all("excluded plan" not in p["text"] for p in found["passages"])
        taxes_hit = await call("search_sources", projectId=pid, query="tax returns deadline")
        assert taxes_hit["passages"][0]["sourceId"] == taxes["id"]

    rest = await http.get(f"{API}/projects/{pid}/search", params={"q": "scratching post"}, headers=headers)
    assert rest.status_code == 200
    assert rest.json()["passages"][0]["sourceName"] == "pets.md"
    assert "Secret" not in {p["sourceName"] for p in rest.json()["passages"]}

    # Excluding a searchable source removes its passages; including it again brings them back.
    current = (await http.get(f"{API}/projects/{pid}/sources/{pets['id']}", headers=headers)).json()
    patched = await http.patch(
        f"{API}/projects/{pid}/sources/{pets['id']}",
        json={"mode": "excluded"},
        headers={**headers, "If-Match": f'"{current["version"]}"'},
    )
    assert patched.status_code == 200, patched.text

    async def gone() -> bool:
        async with tool_caller(stack, tokens) as call:
            result = await call("search_sources", projectId=pid, query="scratching post veterinary")
        return pets["id"] not in {p["sourceId"] for p in result["passages"]}

    await eventually(gone, "excluded source to disappear from search")


async def test_item_update_is_re_embedded_after_the_debounce_and_found_as_similar(
    stack: FastAPI, http: httpx.AsyncClient, tokens: TokenFactory, embedding_calls: list[list[str]]
) -> None:
    pid = (await create_project(http, tokens, OWNER, "Similar"))["id"]
    headers = tokens.headers(OWNER)

    async def create(title: str, summary: str = "") -> dict[str, Any]:
        # Short explicit documents: the default template text would dominate the bag-of-words fake embeddings.
        body = {"type": "feature", "title": title, "document": f"## Summary\n{summary or title}"}
        response = await http.post(f"{API}/projects/{pid}/items", json=body, headers=headers)
        assert response.status_code == 201, response.text
        return response.json()

    invoices = await create("Export monthly invoices as PDF")
    other = await create("Dark mode for the settings page")
    target = await create("Placeholder", "nothing yet")
    async with tool_caller(stack, tokens) as call:

        async def indexed_both() -> bool:
            result = await call("find_similar_items", projectId=pid, text="export invoices pdf monthly")
            return {hit["id"] for hit in result["items"]} >= {invoices["id"]}

        await eventually(indexed_both, "items to be embedded")
        # Before the update the placeholder does not resemble invoices; afterwards it does.
        patched = await http.patch(
            f"{API}/projects/{pid}/items/{target['id']}",
            json={"title": "Export monthly invoices as PDF files", "document": "## Summary\nInvoices as PDF"},
            headers={**headers, "If-Match": '"1"'},
        )
        assert patched.status_code == 200, patched.text

        async def sent_to_gateway() -> bool:
            return any(batch[0].startswith("Export monthly invoices as PDF files") for batch in embedding_calls)

        await eventually(sent_to_gateway, "the debounced embedding job to send the updated item")

        async def similar() -> bool:
            result = await call("find_similar_items", projectId=pid, itemId=invoices["id"])
            ids = [hit["id"] for hit in result["items"]]
            return bool(ids) and ids[0] == target["id"]

        await eventually(similar, "the updated item to be re-embedded and found")
        result = await call("find_similar_items", projectId=pid, itemId=invoices["id"])
        ranked = [hit["id"] for hit in result["items"]]
        assert ranked.index(target["id"]) < ranked.index(other["id"]) if other["id"] in ranked else True
        assert invoices["id"] not in [hit["id"] for hit in result["items"]]
        rest = await http.get(
            f"{API}/projects/{pid}/search", params={"q": "invoices pdf", "kind": "items"}, headers=headers
        )
        assert rest.status_code == 200 and rest.json()["items"][0]["itemId"] in {invoices["id"], target["id"]}


async def test_edits_within_the_debounce_window_are_coalesced_into_one_embedding(
    stack: FastAPI, http: httpx.AsyncClient, tokens: TokenFactory, embedding_calls: list[list[str]]
) -> None:
    from backlog_api.indexing import configure_item_debounce

    configure_item_debounce(5.0)
    pid = (await create_project(http, tokens, OWNER, "Debounce"))["id"]
    headers = tokens.headers(OWNER)
    created = await http.post(f"{API}/projects/{pid}/items", json={"type": "feature", "title": "v1"}, headers=headers)
    item = created.json()
    for version in range(1, 5):
        response = await http.patch(
            f"{API}/projects/{pid}/items/{item['id']}",
            json={"title": f"edit {version}"},
            headers={**headers, "If-Match": f'"{version}"'},
        )
        assert response.status_code == 200
    await asyncio.sleep(1)
    assert embedding_calls == [], "nothing is embedded before the debounce delay has passed"
    async with stack.state.db.sessionmaker() as session:
        queued = await session.scalar(
            select(func.count()).select_from(Job).where(Job.kind == "index_item", Job.status == "queued")
        )
    assert queued == 1, "five writes to one item share a single queued embedding job"
