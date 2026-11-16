from __future__ import annotations

import base64
import hashlib
import json
import math
import re
import struct
import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backlog_api import jobs, search
from backlog_api.db.models import Item, ItemEmbedding, Job, Source, SourceChunk
from backlog_api.embeddings import EmbeddingClient
from backlog_api.events import DomainEvent, InProcessEventPublisher
from backlog_api.indexing import enqueue_item_indexing
from backlog_api.settings import Settings
from backlog_api.worker import FULLTEXT_ONLY_NOTE, IndexingWorker
from backlog_api_testkit import API, TokenFactory, create_project

OWNER = "alice@example.test"
DIM = 1536


def fake_vector(text: str, dim: int = DIM) -> list[float]:
    vector = [0.0] * dim
    for token in re.findall(r"\w+", text.lower()):
        digest = hashlib.sha256(token.encode()).digest()
        for offset in (0, 8):
            vector[int.from_bytes(digest[offset : offset + 4], "big") % dim] += 1.0 if digest[offset + 4] & 1 else -1.0
    norm = math.sqrt(sum(v * v for v in vector)) or 1.0
    return [v / norm for v in vector]


class FakeGateway:
    """MockTransport handler: deterministic feature-hashing embeddings, optional failures."""

    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.status = 200
        self.base64 = False

    def __call__(self, request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/embeddings"
        body = json.loads(request.content)
        self.requests.append(body)
        if self.status != 200:
            return httpx.Response(self.status, json={"error": {"message": "secret-token-leak"}})
        data = []
        for index, text in enumerate(body["input"]):
            vector: Any = fake_vector(text)
            if self.base64:
                vector = base64.b64encode(struct.pack(f"<{len(vector)}f", *vector)).decode()
            data.append({"object": "embedding", "index": index, "embedding": vector})
        return httpx.Response(200, json={"object": "list", "data": data, "model": body["model"]})


@pytest.fixture
def gateway() -> FakeGateway:
    return FakeGateway()


@pytest.fixture
def index_settings(settings: Settings) -> Settings:
    return settings.model_copy(
        update={
            "llm_base_url": "http://gateway.test",
            "job_max_attempts": 2,
            "job_retry_backoff_seconds": 0,
            "embedding_max_retries": 0,
        }
    )


@pytest.fixture
def embedder(index_settings: Settings, gateway: FakeGateway) -> EmbeddingClient:
    client = EmbeddingClient.from_settings(index_settings, transport=httpx.MockTransport(gateway))
    assert client is not None
    return client


@pytest.fixture
def make_worker(
    app: FastAPI, index_settings: Settings, event_publisher: InProcessEventPublisher
) -> Callable[[EmbeddingClient | None], IndexingWorker]:
    def build(client: EmbeddingClient | None) -> IndexingWorker:
        return IndexingWorker(app.state.db.sessionmaker, index_settings, client, event_publisher)

    return build


@pytest.fixture
async def project(client: httpx.AsyncClient, tokens: TokenFactory) -> dict[str, Any]:
    return await create_project(client, tokens, OWNER, "Indexing")


async def add_source(
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    project: dict[str, Any],
    name: str,
    text: str,
    mode: str = "searchable",
) -> dict[str, Any]:
    response = await client.post(
        f"{API}/projects/{project['id']}/sources",
        json={"name": name, "text": text, "mode": mode},
        headers=tokens.headers(OWNER),
    )
    assert response.status_code == 201, response.text
    return response.json()


async def get_source(sessionmaker: async_sessionmaker[AsyncSession], source_id: str) -> Source:
    async with sessionmaker() as session:
        source = await session.get(Source, uuid.UUID(source_id))
        assert source is not None
        return source


async def make_due(sessionmaker: async_sessionmaker[AsyncSession]) -> None:
    async with sessionmaker() as session:
        await session.execute(update(Job).where(Job.status == "queued").values(run_after=datetime.now(UTC)))
        await session.commit()


CATS = "# Cats\n\n## Care\n\nCats need fresh water, a scratching post and regular veterinary visits."
TAXES = "# Taxes\n\n## Filing\n\nAnnual tax returns must be filed before the deadline with the revenue office."


async def test_index_source_creates_chunks_embeddings_and_events(
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    project: dict[str, Any],
    sessionmaker: async_sessionmaker[AsyncSession],
    make_worker: Callable[[EmbeddingClient | None], IndexingWorker],
    embedder: EmbeddingClient,
    published_events: list[DomainEvent],
    gateway: FakeGateway,
) -> None:
    gateway.base64 = True
    source = await add_source(client, tokens, project, "Pets", CATS)
    assert await make_worker(embedder).drain() == 1
    stored = await get_source(sessionmaker, source["id"])
    assert (stored.index_status, stored.index_error) == ("indexed", None)
    assert stored.version >= 3
    async with sessionmaker() as session:
        chunks = (await session.scalars(select(SourceChunk).where(SourceChunk.source_id == stored.id))).all()
        job_status = await session.scalar(select(Job.status).where(Job.kind == jobs.INDEX_SOURCE))
    assert len(chunks) == 1 and chunks[0].embedding is not None
    assert chunks[0].heading_path == "Cats > Care"
    assert job_status == "done"
    types = [event.type for event in published_events]
    assert types[-2:] == ["source.updated", "source.indexed"]
    assert published_events[-2].data["indexStatus"] == "indexing"
    assert published_events[-1].data["chunks"] == 1


async def test_excluded_source_is_skipped_and_chunks_removed(
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    project: dict[str, Any],
    sessionmaker: async_sessionmaker[AsyncSession],
    make_worker: Callable[[EmbeddingClient | None], IndexingWorker],
    embedder: EmbeddingClient,
) -> None:
    source = await add_source(client, tokens, project, "Pets", CATS)
    worker = make_worker(embedder)
    await worker.drain()
    response = await client.patch(
        f"{API}/projects/{project['id']}/sources/{source['id']}",
        json={"mode": "excluded"},
        headers={**tokens.headers(OWNER), "If-Match": f'"{(await get_source(sessionmaker, source["id"])).version}"'},
    )
    assert response.status_code == 200, response.text
    await worker.drain()
    stored = await get_source(sessionmaker, source["id"])
    assert stored.index_status == "skipped"
    async with sessionmaker() as session:
        assert await session.scalar(select(func.count()).select_from(SourceChunk)) == 0


async def test_full_text_only_without_embedding_endpoint(
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    project: dict[str, Any],
    sessionmaker: async_sessionmaker[AsyncSession],
    make_worker: Callable[[EmbeddingClient | None], IndexingWorker],
) -> None:
    source = await add_source(client, tokens, project, "Pets", CATS)
    await add_source(client, tokens, project, "Taxes", TAXES)
    await make_worker(None).drain()
    stored = await get_source(sessionmaker, source["id"])
    assert stored.index_status == "indexed" and stored.index_error == FULLTEXT_ONLY_NOTE
    async with sessionmaker() as session:
        assert (
            await session.scalar(
                select(func.count()).select_from(SourceChunk).where(SourceChunk.embedding.is_not(None))
            )
            == 0
        )
        passages = await search.search_sources(session, uuid.UUID(project["id"]), "scratching post")
    assert [p.source_name for p in passages] == ["Pets"]


async def test_hybrid_search_ranks_relevant_passage_first_and_hides_excluded(
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    project: dict[str, Any],
    sessionmaker: async_sessionmaker[AsyncSession],
    make_worker: Callable[[EmbeddingClient | None], IndexingWorker],
    embedder: EmbeddingClient,
) -> None:
    pets = await add_source(client, tokens, project, "Pets", CATS)
    await add_source(client, tokens, project, "Taxes", TAXES)
    hidden = await add_source(client, tokens, project, "Hidden", "Cats scratching post secrets", mode="excluded")
    pinned = await add_source(client, tokens, project, "Pinned", "Unrelated pinned note about bridges", mode="pinned")
    await make_worker(embedder).drain()
    pid = uuid.UUID(project["id"])
    async with sessionmaker() as session:
        passages = await search.search_sources(session, pid, "veterinary visits for cats", embedder=embedder)
        assert passages[0].source_name == "Pets"
        assert passages[0].citation_id == f"src:{pets['id']}#0"
        assert passages[0].heading_path == "Cats > Care"
        assert search.parse_citation_id(passages[0].citation_id) == (uuid.UUID(pets["id"]), 0)
        assert all(p.source_id != uuid.UUID(hidden["id"]) for p in passages)
        # semantic-only match: no shared full-text term, vector search still returns something
        vector_only = await search.search_sources(session, pid, "zzzunmatched", embedder=embedder)
        assert vector_only
        searchable_only = await search.search_sources(session, pid, "bridges", modes=("searchable",), embedder=embedder)
        assert all(p.source_id != uuid.UUID(pinned["id"]) for p in searchable_only)
    response = await client.get(
        f"{API}/projects/{project['id']}/search", params={"q": "tax returns deadline"}, headers=tokens.headers(OWNER)
    )
    assert response.status_code == 200, response.text
    assert response.json()["passages"][0]["sourceName"] == "Taxes"


async def test_item_embeddings_debounced_deduped_and_skipped_when_unchanged(
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    project: dict[str, Any],
    sessionmaker: async_sessionmaker[AsyncSession],
    make_worker: Callable[[EmbeddingClient | None], IndexingWorker],
    embedder: EmbeddingClient,
    gateway: FakeGateway,
) -> None:
    headers = tokens.headers(OWNER)
    created = await client.post(
        f"{API}/projects/{project['id']}/items",
        json={"type": "capability", "title": "Single sign-on login"},
        headers=headers,
    )
    assert created.status_code == 201, created.text
    item = created.json()
    for title in ("Single sign-on login v2", "Single sign-on login v3"):
        etag = (await client.get(f"{API}/projects/{project['id']}/items/{item['id']}", headers=headers)).headers["ETag"]
        patched = await client.patch(
            f"{API}/projects/{project['id']}/items/{item['id']}",
            json={"title": title},
            headers={**headers, "If-Match": etag},
        )
        assert patched.status_code == 200, patched.text
    worker = make_worker(embedder)
    async with sessionmaker() as session:
        queued = (await session.scalars(select(Job).where(Job.kind == jobs.INDEX_ITEM))).all()
        assert len(queued) == 1
        assert queued[0].run_after > datetime.now(UTC) + timedelta(seconds=5)
    assert await worker.drain() == 0  # not due yet
    await make_due(sessionmaker)
    assert await worker.drain() == 1
    assert len(gateway.requests) == 1
    async with sessionmaker() as session:
        assert await session.scalar(select(func.count()).select_from(ItemEmbedding)) == 1
        assert await enqueue_item_indexing(session, uuid.UUID(item["id"]), uuid.UUID(project["id"]), delay=timedelta(0))
        await session.commit()
    assert await worker.drain() == 1
    assert len(gateway.requests) == 1  # unchanged content: skipped without calling the gateway


async def test_find_similar_items_returns_near_duplicate_and_excludes_self(
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    project: dict[str, Any],
    sessionmaker: async_sessionmaker[AsyncSession],
    make_worker: Callable[[EmbeddingClient | None], IndexingWorker],
    embedder: EmbeddingClient,
) -> None:
    headers = tokens.headers(OWNER)
    ids: dict[str, str] = {}
    for key, title in {
        "a": "Export monthly invoices as PDF",
        "b": "Export monthly invoices as PDF files",
        "c": "Dark mode for the settings page",
    }.items():
        response = await client.post(
            f"{API}/projects/{project['id']}/items", json={"type": "feature", "title": title}, headers=headers
        )
        ids[key] = response.json()["id"]
    await make_due(sessionmaker)
    await make_worker(embedder).drain()
    pid = uuid.UUID(project["id"])
    async with sessionmaker() as session:
        similar = await search.find_similar_items(session, pid, uuid.UUID(ids["a"]), min_score=0.2)
        assert [s.item_id for s in similar][:1] == [uuid.UUID(ids["b"])]
        assert uuid.UUID(ids["a"]) not in [s.item_id for s in similar]
        by_text = await search.find_similar_items(
            session, pid, text="monthly invoices export pdf", embedder=embedder, min_score=0.2
        )
        assert by_text and by_text[0].item_id in {uuid.UUID(ids["a"]), uuid.UUID(ids["b"])}
        hits = await search.search_items(session, pid, "dark mode", embedder=embedder)
        assert hits[0].item_id == uuid.UUID(ids["c"])
    response = await client.get(
        f"{API}/projects/{project['id']}/search", params={"q": "dark mode", "kind": "items"}, headers=headers
    )
    assert response.json()["items"][0]["itemId"] == ids["c"]


async def test_failures_are_retried_then_failed_with_sanitized_error(
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    project: dict[str, Any],
    sessionmaker: async_sessionmaker[AsyncSession],
    make_worker: Callable[[EmbeddingClient | None], IndexingWorker],
    embedder: EmbeddingClient,
    gateway: FakeGateway,
) -> None:
    gateway.status = 500
    source = await add_source(client, tokens, project, "Pets", CATS)
    worker = make_worker(embedder)
    await worker.drain()
    stored = await get_source(sessionmaker, source["id"])
    assert stored.index_status == "failed"
    assert stored.index_error == "Embedding endpoint answered HTTP 500."
    assert "secret-token-leak" not in (stored.index_error or "")
    async with sessionmaker() as session:
        job = (await session.scalars(select(Job).where(Job.kind == jobs.INDEX_SOURCE))).one()
    assert (job.status, job.attempts) == ("failed", 2)
    assert len(gateway.requests) == 2


async def test_reindex_endpoint_and_project_job(
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    project: dict[str, Any],
    sessionmaker: async_sessionmaker[AsyncSession],
    make_worker: Callable[[EmbeddingClient | None], IndexingWorker],
    embedder: EmbeddingClient,
    gateway: FakeGateway,
) -> None:
    source = await add_source(client, tokens, project, "Pets", CATS)
    await client.post(
        f"{API}/projects/{project['id']}/items",
        json={"type": "feature", "title": "Cat feeder"},
        headers=tokens.headers(OWNER),
    )
    worker = make_worker(embedder)
    await make_due(sessionmaker)
    await worker.drain()
    calls = len(gateway.requests)
    response = await client.post(
        f"{API}/projects/{project['id']}/sources/{source['id']}/reindex", headers=tokens.headers(OWNER)
    )
    assert response.status_code == 202
    assert (
        await client.post(
            f"{API}/projects/{project['id']}/sources/{uuid.uuid4()}/reindex", headers=tokens.headers(OWNER)
        )
    ).status_code == 404
    await worker.drain()
    assert len(gateway.requests) == calls + 1
    async with sessionmaker() as session:
        await jobs.enqueue(session, jobs.REINDEX_PROJECT, {"projectId": project["id"]})
        await session.commit()
    await worker.drain()
    assert len(gateway.requests) == calls + 3  # the source and the (forced) item again
    async with sessionmaker() as session:
        assert await session.scalar(select(func.count()).select_from(Item)) == 1
        chunks = await session.scalar(select(func.count()).select_from(SourceChunk))
        assert chunks == 1  # replaced, not duplicated
