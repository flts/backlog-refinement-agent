"""Optimistic concurrency under real parallelism: same-version PATCHes, MCP versus REST, revision retention."""

from __future__ import annotations

import asyncio
import uuid
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backlog_api.db.models import Item, ItemRevision
from backlog_api_testkit import API, TokenFactory, add_member, create_project
from test_mcp import call_raw, mcp_client

OWNER = "alice@example.test"
CONTRIBUTOR = "bob@example.test"
RACERS = 8


@pytest.fixture
async def project(client: httpx.AsyncClient, tokens: TokenFactory) -> dict[str, Any]:
    created = await create_project(client, tokens, OWNER, "Races")
    assert (await add_member(client, tokens, created["id"], OWNER, CONTRIBUTOR)).status_code == 201
    return created


async def create_item(client: httpx.AsyncClient, tokens: TokenFactory, pid: str, **body: Any) -> dict[str, Any]:
    response = await client.post(
        f"{API}/projects/{pid}/items", json={"type": "feature", **body}, headers=tokens.headers(OWNER)
    )
    assert response.status_code == 201, response.text
    return response.json()


def patch(
    client: httpx.AsyncClient, tokens: TokenFactory, pid: str, item_id: str, version: int, user: str, **body: Any
):
    return client.patch(
        f"{API}/projects/{pid}/items/{item_id}",
        json=body,
        headers={**tokens.headers(user), "If-Match": f'"{version}"'},
    )


async def revisions(sessionmaker: async_sessionmaker[AsyncSession], item_id: str) -> list[ItemRevision]:
    async with sessionmaker() as session:
        rows = await session.scalars(
            select(ItemRevision).where(ItemRevision.item_id == uuid.UUID(item_id)).order_by(ItemRevision.version)
        )
        return list(rows.all())


async def test_concurrent_patches_with_the_same_if_match_yield_exactly_one_success(
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    project: dict[str, Any],
    sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    pid = project["id"]
    item = await create_item(client, tokens, pid, title="Race", document="## Summary\nOne\n\n## Scope\nS")
    users = [OWNER, CONTRIBUTOR]
    responses = await asyncio.gather(
        *(
            patch(
                client,
                tokens,
                pid,
                item["id"],
                1,
                users[i % 2],
                document=item["document"].replace("One", f"Edit {i}"),
            )
            for i in range(RACERS)
        )
    )
    ok = [r for r in responses if r.status_code == 200]
    conflicts = [r for r in responses if r.status_code == 409]
    assert len(ok) == 1 and len(conflicts) == RACERS - 1, [r.status_code for r in responses]
    winner = ok[0].json()
    assert winner["version"] == 2
    for response in conflicts:
        problem = response.json()
        assert problem["type"] == "/problems/version-conflict"
        assert problem["currentVersion"] == 2
        assert problem["changedSections"] == ["Summary"]
        assert problem["item"]["document"] == winner["document"]
        assert response.headers["etag"] == '"2"'
    stored = await revisions(sessionmaker, item["id"])
    assert [r.version for r in stored] == [1, 2]
    assert stored[1].document == winner["document"]


async def test_concurrent_patches_chained_by_etag_never_lose_an_update(
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    project: dict[str, Any],
    sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    """Writers retry on 409 with the version from the conflict: every edit lands, versions are gap free."""
    pid = project["id"]
    item = await create_item(client, tokens, pid, title="Chain")

    async def writer(index: int) -> None:
        version = 1
        while True:
            response = await patch(client, tokens, pid, item["id"], version, OWNER, title=f"Writer {index}")
            if response.status_code == 200:
                return
            assert response.status_code == 409, response.text
            version = response.json()["currentVersion"]

    await asyncio.gather(*(writer(i) for i in range(6)))
    async with sessionmaker() as session:
        stored = await session.get(Item, uuid.UUID(item["id"]))
    assert stored is not None and stored.version == 7
    assert [r.version for r in await revisions(sessionmaker, item["id"])] == list(range(1, 8))
    titles = {r.title for r in await revisions(sessionmaker, item["id"])}
    assert {f"Writer {i}" for i in range(6)} <= titles


async def test_mcp_apply_document_changes_racing_a_rest_patch(
    app: FastAPI,
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    project: dict[str, Any],
    sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    pid = project["id"]
    item = await create_item(client, tokens, pid, title="Mix", document="## Summary\nOne\n\n## Scope\nS")

    async def apply() -> dict[str, Any]:
        async with mcp_client(app, tokens.headers(CONTRIBUTOR)) as mcp:
            is_error, payload = await call_raw(
                mcp,
                "apply_document_changes",
                {
                    "projectId": pid,
                    "itemId": item["id"],
                    "baseVersion": 1,
                    "sections": [{"id": "s", "heading": "Scope", "markdown": "Agent scope"}],
                    "runId": "race",
                },
            )
            assert not is_error, payload
            return payload

    rest, agent = await asyncio.gather(
        patch(client, tokens, pid, item["id"], 1, OWNER, document="## Summary\nREST\n\n## Scope\nS"), apply()
    )
    assert rest.status_code in (200, 409), rest.text
    stored = await revisions(sessionmaker, item["id"])
    async with sessionmaker() as session:
        final = await session.get(Item, uuid.UUID(item["id"]))
    assert final is not None
    # Whichever side wins the lock, the other one is either merged (different sections) or reported, never lost.
    if rest.status_code == 200:
        assert agent["applied"] == ["s"] and agent["conflicted"] == []
        assert final.version == 3 and "REST" in final.document and "Agent scope" in final.document
    else:
        assert rest.json()["changedSections"] == ["Scope"]
        assert final.version == 2 and "Agent scope" in final.document and "REST" not in final.document
    assert [r.version for r in stored] == list(range(1, final.version + 1))


async def test_mcp_and_rest_edits_to_the_same_section_conflict_instead_of_overwriting(
    app: FastAPI,
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    project: dict[str, Any],
    sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    pid = project["id"]
    item = await create_item(client, tokens, pid, title="Same", document="## Summary\nOne")

    async def apply() -> dict[str, Any]:
        async with mcp_client(app, tokens.headers(OWNER)) as mcp:
            _, payload = await call_raw(
                mcp,
                "apply_document_changes",
                {
                    "projectId": pid,
                    "itemId": item["id"],
                    "baseVersion": 1,
                    "sections": [{"id": "s", "heading": "Summary", "markdown": "Agent"}],
                },
            )
            return payload

    rest, agent = await asyncio.gather(
        patch(client, tokens, pid, item["id"], 1, CONTRIBUTOR, document="## Summary\nHuman"), apply()
    )
    async with sessionmaker() as session:
        final = await session.get(Item, uuid.UUID(item["id"]))
    assert final is not None
    if rest.status_code == 200:  # the human went first: the agent's edit of the same section is reported
        assert agent["applied"] == [] and [c["sectionId"] for c in agent["conflicted"]] == ["s"]
        assert "Human" in final.document and "Agent" not in final.document
        assert final.version == 2
    else:  # the agent went first: the human gets a 409 and nothing was overwritten
        assert rest.status_code == 409 and agent["applied"] == ["s"]
        assert "Agent" in final.document and "Human" not in final.document


async def test_revision_count_stays_within_the_retention_limit_under_concurrency(
    app: FastAPI,
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    project: dict[str, Any],
    sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    app.state.settings = app.state.settings.model_copy(update={"revisions_keep": 5})
    pid = project["id"]
    item = await create_item(client, tokens, pid, title="Retention")

    async def writer(index: int) -> None:
        version = 1
        for round_ in range(3):
            while True:
                response = await patch(client, tokens, pid, item["id"], version, OWNER, title=f"W{index}-{round_}")
                if response.status_code == 200:
                    version = response.json()["version"]
                    break
                assert response.status_code == 409, response.text
                version = response.json()["currentVersion"]

    await asyncio.gather(*(writer(i) for i in range(4)))
    async with sessionmaker() as session:
        stored = await session.get(Item, uuid.UUID(item["id"]))
        count = await session.scalar(
            select(func.count()).select_from(ItemRevision).where(ItemRevision.item_id == uuid.UUID(item["id"]))
        )
    assert stored is not None and stored.version == 13
    assert count == 5
    kept = [r.version for r in await revisions(sessionmaker, item["id"])]
    assert kept == [9, 10, 11, 12, 13]
    listed = await client.get(f"{API}/projects/{pid}/items/{item['id']}/revisions", headers=tokens.headers(OWNER))
    assert [r["version"] for r in listed.json()["items"]] == [13, 12, 11, 10, 9]


async def test_unchanged_patch_creates_no_revision_even_when_concurrent(
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    project: dict[str, Any],
    sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    pid = project["id"]
    item = await create_item(client, tokens, pid, title="Same title")
    responses = await asyncio.gather(
        *(patch(client, tokens, pid, item["id"], 1, OWNER, title="Same title") for _ in range(4))
    )
    assert all(r.status_code == 200 for r in responses), [r.text for r in responses]
    assert [r.version for r in await revisions(sessionmaker, item["id"])] == [1]
