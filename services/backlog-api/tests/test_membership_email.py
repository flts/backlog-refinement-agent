"""Membership by email: normalisation, immediate access, revocation on every channel and last-owner races."""

from __future__ import annotations

import asyncio
import itertools
import uuid
from typing import Any
from urllib.parse import quote

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backlog_api.db.models import ProjectMember
from backlog_api.settings import Settings
from backlog_api_testkit import API, TokenFactory, add_member, create_project
from conftest import truncate_all
from live_testkit import running_replica
from test_mcp import mcp_client

OWNER = "alice@example.test"
SECOND_OWNER = "bob@example.test"
MEMBER = "carol@example.test"
MIXED = "  Dan@Example.TEST \t"
VARIANTS = ["dan@example.test", "DAN@EXAMPLE.TEST", "Dan@Example.Test", "  dan@example.test  ", MIXED]


def url(project_id: str, suffix: str = "") -> str:
    return f"{API}/projects/{project_id}{suffix}"


def member_url(project_id: str, email: str) -> str:
    return url(project_id, f"/members/{quote(email.strip(), safe='@')}")


async def members(client: httpx.AsyncClient, tokens: TokenFactory, project_id: str) -> dict[str, str]:
    response = await client.get(url(project_id, "/members"), headers=tokens.headers(OWNER))
    assert response.status_code == 200, response.text
    return {m["email"]: m["role"] for m in response.json()["items"]}


@pytest.fixture
async def project(client: httpx.AsyncClient, tokens: TokenFactory) -> dict[str, Any]:
    return await create_project(client, tokens, OWNER, "Membership")


# --- normalisation --------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("added", VARIANTS)
async def test_added_email_is_normalised_and_matches_every_spelling_in_the_token(
    added: str, client: httpx.AsyncClient, tokens: TokenFactory, project: dict[str, Any]
) -> None:
    response = await add_member(client, tokens, project["id"], OWNER, added)
    assert response.status_code == 201, response.text
    assert response.json()["email"] == "dan@example.test"
    assert await members(client, tokens, project["id"]) == {OWNER: "owner", "dan@example.test": "contributor"}
    for spelling in VARIANTS:
        got = await client.get(url(project["id"]), headers=tokens.headers(spelling))
        assert got.status_code == 200, (added, spelling, got.text)
    listed = await client.get(f"{API}/projects", headers=tokens.headers(MIXED))
    assert [p["id"] for p in listed.json()["items"]] == [project["id"]]


async def test_duplicate_detection_ignores_case_and_whitespace(
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    project: dict[str, Any],
    sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    assert (await add_member(client, tokens, project["id"], OWNER, MIXED)).status_code == 201
    for spelling in VARIANTS:
        again = await add_member(client, tokens, project["id"], OWNER, spelling)
        assert (again.status_code, again.json()["type"]) == (409, "/problems/already-member"), spelling
    # The owner's own address, in any spelling, is a duplicate too.
    assert (await add_member(client, tokens, project["id"], OWNER, " ALICE@Example.Test ")).status_code == 409
    async with sessionmaker() as session:
        count = await session.scalar(select(func.count()).select_from(ProjectMember))
    assert count == 2


@pytest.mark.parametrize("spelling", VARIANTS)
async def test_path_email_is_normalised_for_role_change_and_removal(
    spelling: str, client: httpx.AsyncClient, tokens: TokenFactory, project: dict[str, Any]
) -> None:
    pid = project["id"]
    assert (await add_member(client, tokens, pid, OWNER, "dan@example.test")).status_code == 201
    promoted = await client.patch(member_url(pid, spelling), json={"role": "owner"}, headers=tokens.headers(OWNER))
    assert promoted.status_code == 200, promoted.text
    assert (promoted.json()["email"], promoted.json()["role"]) == ("dan@example.test", "owner")
    removed = await client.delete(member_url(pid, spelling), headers=tokens.headers(OWNER))
    assert removed.status_code == 204, removed.text
    assert await members(client, tokens, pid) == {OWNER: "owner"}
    assert (await client.get(url(pid), headers=tokens.headers(spelling))).status_code == 404


async def test_a_member_can_leave_with_any_spelling_of_their_own_address(
    client: httpx.AsyncClient, tokens: TokenFactory, project: dict[str, Any]
) -> None:
    pid = project["id"]
    assert (await add_member(client, tokens, pid, OWNER, "dan@example.test")).status_code == 201
    left = await client.delete(member_url(pid, "DAN@Example.Test"), headers=tokens.headers(MIXED))
    assert left.status_code == 204, left.text
    assert (await client.get(url(pid), headers=tokens.headers("dan@example.test"))).status_code == 404


async def test_access_is_immediate_and_a_member_can_be_added_before_their_first_login(
    client: httpx.AsyncClient, tokens: TokenFactory, project: dict[str, Any]
) -> None:
    pid = project["id"]
    assert (await client.get(url(pid), headers=tokens.headers(MEMBER))).status_code == 404
    added = await add_member(client, tokens, pid, OWNER, MEMBER, "owner")
    assert added.status_code == 201
    assert added.json()["role"] == "owner"
    assert (await client.get(url(pid), headers=tokens.headers(MEMBER))).status_code == 200
    created = await client.post(
        url(pid, "/items"), json={"type": "feature", "title": "Mine"}, headers=tokens.headers(MEMBER)
    )
    assert created.status_code == 201, created.text
    assert created.json()["createdBy"] == MEMBER


async def test_an_unverified_email_never_matches_a_membership(
    client: httpx.AsyncClient, tokens: TokenFactory, project: dict[str, Any]
) -> None:
    pid = project["id"]
    assert (await add_member(client, tokens, pid, OWNER, MEMBER)).status_code == 201
    headers = tokens.headers("CAROL@example.test", email_verified=False)
    assert (await client.get(url(pid), headers=headers)).status_code == 403
    assert (await client.get(f"{API}/projects", headers=headers)).status_code == 403


@pytest.mark.parametrize("bad", ["nobody", "a b@example.test", "@example.test", "x@y", ""])
async def test_invalid_addresses_are_rejected(
    bad: str, client: httpx.AsyncClient, tokens: TokenFactory, project: dict[str, Any]
) -> None:
    response = await add_member(client, tokens, project["id"], OWNER, bad)
    assert response.status_code == 422, response.text


# --- removal revokes every channel ----------------------------------------------------------------------------------


async def test_removal_revokes_rest_and_mcp(
    app: FastAPI, client: httpx.AsyncClient, tokens: TokenFactory, project: dict[str, Any]
) -> None:
    pid = project["id"]
    assert (await add_member(client, tokens, pid, OWNER, MEMBER)).status_code == 201
    item = (
        await client.post(url(pid, "/items"), json={"type": "feature", "title": "T"}, headers=tokens.headers(OWNER))
    ).json()

    async def mcp_status(email: str) -> tuple[bool, int | None]:
        async with mcp_client(app, tokens.headers(email)) as mcp:
            result = await mcp.call_tool("get_item_context", {"projectId": pid, "itemId": item["id"]})
        return result.is_error, (result.structured_content or {}).get("status")

    assert await mcp_status(MEMBER) == (False, None)
    removed = await client.delete(member_url(pid, MEMBER), headers=tokens.headers(OWNER))
    assert removed.status_code == 204
    assert await mcp_status(MEMBER) == (True, 404)
    for method, suffix in (("GET", ""), ("GET", "/items"), ("GET", f"/items/{item['id']}"), ("GET", "/sources")):
        response = await client.request(method, url(pid, suffix), headers=tokens.headers(MEMBER))
        assert response.status_code == 404, (method, suffix)
    assert (await client.get(f"{API}/projects", headers=tokens.headers(MEMBER))).json()["items"] == []
    assert (
        await client.post(url(pid, "/items"), json={"type": "feature"}, headers=tokens.headers(MEMBER))
    ).status_code == 404
    assert (await mcp_status(OWNER)) == (False, None)


async def test_removal_closes_an_open_stream_on_another_replica(
    settings: Settings, tokens: TokenFactory, database_url: str
) -> None:
    await truncate_all(database_url)
    live = settings.model_copy(update={"events_heartbeat_seconds": 0.3, "events_recheck_seconds": 0.4})
    async with running_replica(live, tokens) as a, running_replica(live, tokens) as b:
        project_id = (await create_project(a.http, tokens, OWNER, "Streams"))["id"]
        assert (await add_member(a.http, tokens, project_id, OWNER, MEMBER)).status_code == 201
        async with b.stream(url(project_id, "/events"), tokens.headers(MEMBER)) as stream:
            await stream.until("presence")
            removed = await a.http.delete(member_url(project_id, MEMBER), headers=tokens.headers(OWNER))
            assert removed.status_code == 204
            assert (await stream.until("member.removed")).data["data"]["email"] == MEMBER
            assert (await stream.until("closed")).data["data"]["reason"] == "member-removed"
            assert await stream.next() is None
        # A new connection by the removed member is refused as well.
        refused = await b.http.get(url(project_id, "/events"), headers=tokens.headers(MEMBER))
        assert refused.status_code == 404


# --- last-owner rules under concurrency -----------------------------------------------------------------------------


async def _two_owners(client: httpx.AsyncClient, tokens: TokenFactory) -> str:
    project_id = (await create_project(client, tokens, OWNER, "Owners"))["id"]
    assert (await add_member(client, tokens, project_id, OWNER, SECOND_OWNER, "owner")).status_code == 201
    return project_id


def _demote(client: httpx.AsyncClient, tokens: TokenFactory, project_id: str, actor: str, target: str) -> Any:
    return client.patch(member_url(project_id, target), json={"role": "contributor"}, headers=tokens.headers(actor))


def _remove(client: httpx.AsyncClient, tokens: TokenFactory, project_id: str, actor: str, target: str) -> Any:
    return client.delete(member_url(project_id, target), headers=tokens.headers(actor))


async def _owners(sessionmaker: async_sessionmaker[AsyncSession], project_id: str) -> set[str]:
    async with sessionmaker() as session:
        rows = await session.scalars(
            select(ProjectMember.email).where(
                ProjectMember.project_id == uuid.UUID(project_id), ProjectMember.role == "owner"
            )
        )
        return set(rows.all())


ACTIONS = {"demote": _demote, "remove": _remove}


@pytest.mark.parametrize(("first", "second"), list(itertools.product(ACTIONS, ACTIONS)))
async def test_two_owners_acting_on_each_other_leave_exactly_one_owner(
    first: str,
    second: str,
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    for _ in range(3):  # the interleaving is timing dependent: repeat
        project_id = await _two_owners(client, tokens)
        a, b = await asyncio.gather(
            ACTIONS[first](client, tokens, project_id, OWNER, SECOND_OWNER),
            ACTIONS[second](client, tokens, project_id, SECOND_OWNER, OWNER),
        )
        statuses = sorted((a.status_code, b.status_code))
        # The loser either sees the project row lock release and is no longer an owner (403/404 on a removed
        # member) or is the last owner (409). Exactly one request succeeds.
        successes = [s for s in statuses if s < 300]
        assert len(successes) == 1, (first, second, a.text, b.text)
        assert len(await _owners(sessionmaker, project_id)) == 1


async def test_many_concurrent_demotions_keep_at_least_one_owner(
    client: httpx.AsyncClient, tokens: TokenFactory, sessionmaker: async_sessionmaker[AsyncSession]
) -> None:
    project_id = await _two_owners(client, tokens)
    third = "erin@example.test"
    assert (await add_member(client, tokens, project_id, OWNER, third, "owner")).status_code == 201
    owners = [OWNER, SECOND_OWNER, third]
    results = await asyncio.gather(
        *(_demote(client, tokens, project_id, actor, target) for actor in owners for target in owners)
    )
    assert any(r.status_code == 200 for r in results)
    assert len(await _owners(sessionmaker, project_id)) >= 1
    for response in results:
        assert response.status_code in (200, 403, 409), response.text


async def test_the_last_owner_can_neither_be_demoted_nor_leave(
    client: httpx.AsyncClient, tokens: TokenFactory, project: dict[str, Any]
) -> None:
    demote = await _demote(client, tokens, project["id"], OWNER, OWNER.upper())
    assert (demote.status_code, demote.json()["type"]) == (409, "/problems/last-owner")
    leave = await _remove(client, tokens, project["id"], OWNER, f" {OWNER.title()} ")
    assert (leave.status_code, leave.json()["type"]) == (409, "/problems/last-owner")
    assert await members(client, tokens, project["id"]) == {OWNER: "owner"}


async def test_concurrent_adds_of_the_same_address_create_one_membership(
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    project: dict[str, Any],
    sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    results = await asyncio.gather(
        *(add_member(client, tokens, project["id"], OWNER, spelling) for spelling in VARIANTS * 2)
    )
    assert sorted(r.status_code for r in results) == [201] + [409] * (len(results) - 1)
    async with sessionmaker() as session:
        assert await session.scalar(select(func.count()).select_from(ProjectMember)) == 2


async def test_failed_tool_call_payload_is_not_found_for_removed_members(
    app: FastAPI, client: httpx.AsyncClient, tokens: TokenFactory, project: dict[str, Any]
) -> None:
    assert (await add_member(client, tokens, project["id"], OWNER, MEMBER)).status_code == 201
    await _remove(client, tokens, project["id"], OWNER, MEMBER)
    async with mcp_client(app, tokens.headers(MEMBER)) as mcp:
        result = await mcp.call_tool("get_project_guidance", {"projectId": project["id"]})
    assert result.is_error
    assert (result.structured_content or {})["type"] == "not-found"
