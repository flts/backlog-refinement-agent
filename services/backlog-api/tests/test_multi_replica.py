"""Two backlog-api replicas (two ``create_app`` instances, two pools, two event buses) sharing one database."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import httpx
import pytest
from pydantic import SecretStr

from backlog_api.settings import Settings
from backlog_api_testkit import API, TokenFactory, add_member, create_project
from conftest import truncate_all
from live_testkit import Replica, running_replica

OWNER = "alice@example.test"
BOB = "bob@example.test"
CAROL = "carol@example.test"
SERVICE = "agent-service"


@dataclass
class Pair:
    a: Replica
    b: Replica
    tokens: TokenFactory

    def headers(self, email: str = OWNER) -> dict[str, str]:
        return self.tokens.headers(email)

    async def project(self, *members: str) -> str:
        project_id = (await create_project(self.a.http, self.tokens, OWNER, "Replicas"))["id"]
        for email in members:
            assert (await add_member(self.a.http, self.tokens, project_id, OWNER, email)).status_code == 201
        return project_id

    async def rename(self, replica: Replica, project_id: str, name: str, email: str = OWNER) -> None:
        current = await replica.http.get(f"{API}/projects/{project_id}", headers=self.headers(email))
        response = await replica.http.patch(
            f"{API}/projects/{project_id}",
            json={"name": name},
            headers={**self.headers(email), "If-Match": f'"{current.json()["version"]}"'},
        )
        assert response.status_code == 200, response.text


@pytest.fixture
async def pair(settings: Settings, tokens: TokenFactory, database_url: str) -> AsyncIterator[Pair]:
    await truncate_all(database_url)
    shared = settings.model_copy(
        update={
            "events_heartbeat_seconds": 0.3,
            "events_recheck_seconds": 0.4,
            "presence_ttl_seconds": 1.0,
            "presence_sweep_seconds": 0.2,
            "events_ticket_secret": SecretStr("shared-ticket-secret-for-two-replicas"),
            "internal_client_ids": [SERVICE],
        }
    )
    async with running_replica(shared, tokens) as a, running_replica(shared, tokens) as b:
        assert a.app is not b.app and a.app.state.db is not b.app.state.db
        assert a.app.state.event_bus is not b.app.state.event_bus
        yield Pair(a, b, tokens)


async def test_an_event_published_on_one_replica_reaches_a_stream_on_the_other(pair: Pair) -> None:
    project_id = await pair.project(BOB)
    async with pair.b.stream(f"{API}/projects/{project_id}/events", pair.headers(BOB)) as stream:
        await stream.until("presence")
        await pair.rename(pair.a, project_id, "From replica A")
        event = await stream.until("project.updated")
        assert event.data["data"]["name"] == "From replica A"
        assert event.data["actor"] == OWNER and event.id is not None
        item = await pair.a.http.post(
            f"{API}/projects/{project_id}/items", json={"type": "feature", "title": "Cross"}, headers=pair.headers()
        )
        assert item.status_code == 201
        created = await stream.until("item.created")
        assert created.data["data"]["title"] == "Cross" and (created.id or 0) > (event.id or 0)


async def test_events_flow_in_both_directions_and_in_order(pair: Pair) -> None:
    project_id = await pair.project(BOB)
    async with (
        pair.a.stream(f"{API}/projects/{project_id}/events", pair.headers()) as on_a,
        pair.b.stream(f"{API}/projects/{project_id}/events", pair.headers(BOB)) as on_b,
    ):
        await on_a.until("presence")
        await on_b.until("presence")
        for index in range(4):
            await pair.rename(pair.a if index % 2 else pair.b, project_id, f"Name {index}")
        for stream in (on_a, on_b):
            names = [(await stream.until("project.updated")).data["data"]["name"] for _ in range(4)]
            assert names == [f"Name {index}" for index in range(4)]


async def test_a_ticket_issued_by_one_replica_opens_the_stream_on_the_other(pair: Pair) -> None:
    project_id = await pair.project()
    response = await pair.a.http.post(f"{API}/projects/{project_id}/events/ticket", headers=pair.headers())
    assert response.status_code == 201, response.text
    ticket = response.json()["ticket"]
    async with pair.b.stream(f"{API}/projects/{project_id}/events", {}, {"ticket": ticket}) as stream:
        await pair.rename(pair.a, project_id, "Ticketed")
        assert (await stream.until("project.updated")).data["data"]["name"] == "Ticketed"


async def test_presence_is_shared_across_replicas(pair: Pair) -> None:
    project_id = await pair.project(BOB, CAROL)
    presence = f"{API}/projects/{project_id}/presence"
    async with pair.b.stream(f"{API}/projects/{project_id}/events", pair.headers()) as stream:
        assert (await stream.until("presence")).data["data"] == {"users": []}
        joined = await pair.a.http.post(presence, json={"state": "viewing"}, headers=pair.headers(BOB))
        assert joined.status_code == 200, joined.text
        users = (await stream.until("presence")).data["data"]["users"]
        assert [u["email"] for u in users] == [BOB]
        await pair.b.http.post(presence, json={}, headers=pair.headers(CAROL))
        users = (await stream.until("presence")).data["data"]["users"]
        assert sorted(u["email"] for u in users) == [BOB, CAROL]
        # Reads on either replica see both users.
        for replica in (pair.a, pair.b):
            current = await replica.http.get(presence, headers=pair.headers())
            assert sorted(u["email"] for u in current.json()["users"]) == [BOB, CAROL]
        # Leaving on one replica is announced on the stream of the other.
        left = await pair.a.http.delete(presence, headers=pair.headers(BOB))
        assert left.status_code == 204
        users = (await stream.until("presence")).data["data"]["users"]
        assert [u["email"] for u in users] == [CAROL]
        # Entries that are not refreshed expire and the sweep (on any replica) announces it.
        assert (await stream.until("presence", wait=8)).data["data"] == {"users": []}


async def test_reconnecting_to_the_other_replica_replays_missed_events(pair: Pair) -> None:
    project_id = await pair.project()
    async with pair.a.stream(f"{API}/projects/{project_id}/events", pair.headers()) as stream:
        await pair.rename(pair.a, project_id, "One")
        first = await stream.until("project.updated")
    await pair.rename(pair.b, project_id, "Two")
    await pair.rename(pair.a, project_id, "Three")
    headers = pair.headers() | {"Last-Event-ID": str(first.id)}
    async with pair.b.stream(f"{API}/projects/{project_id}/events", headers) as stream:
        names = [(await stream.until("project.updated")).data["data"]["name"] for _ in range(2)]
    assert names == ["Two", "Three"]


async def test_project_deletion_on_one_replica_closes_streams_on_the_other(pair: Pair) -> None:
    project_id = await pair.project(BOB)
    async with pair.b.stream(f"{API}/projects/{project_id}/events", pair.headers(BOB)) as stream:
        await stream.until("presence")
        deleted = await pair.a.http.delete(f"{API}/projects/{project_id}", headers=pair.headers())
        assert deleted.status_code == 204
        await stream.until("project.deleted")
        assert (await stream.until("closed")).data["data"]["reason"] == "project-deleted"
        assert await stream.next() is None


async def test_internal_stream_on_one_replica_sees_cleanup_events_from_the_other(pair: Pair) -> None:
    project_id = await pair.project(BOB)
    service: dict[str, Any] = pair.tokens.headers(
        None, email_verified=None, extra={"azp": SERVICE}, omit=("email", "email_verified", "name")
    )
    async with pair.b.stream(f"{API}/internal/events", service) as stream:
        removed = await pair.a.http.delete(f"{API}/projects/{project_id}/members/{BOB}", headers=pair.headers())
        assert removed.status_code == 204
        event = await stream.next()
        assert event is not None and (event.event, event.data["data"]["email"]) == ("member.removed", BOB)


async def test_concurrent_writes_through_both_replicas_conflict_correctly(pair: Pair) -> None:
    """Optimistic locking is enforced by the database, not by process memory: replicas cannot both win."""
    project_id = await pair.project(BOB)
    created = await pair.a.http.post(
        f"{API}/projects/{project_id}/items", json={"type": "feature", "title": "Shared"}, headers=pair.headers()
    )
    item_id = created.json()["id"]

    def patch(replica: Replica, email: str, title: str) -> Any:
        return replica.http.patch(
            f"{API}/projects/{project_id}/items/{item_id}",
            json={"title": title},
            headers={**pair.headers(email), "If-Match": '"1"'},
        )

    results: list[httpx.Response] = await asyncio.gather(
        patch(pair.a, OWNER, "A wins"),
        patch(pair.b, BOB, "B wins"),
        patch(pair.a, OWNER, "A again"),
        patch(pair.b, BOB, "B again"),
    )
    assert sorted(r.status_code for r in results) == [200, 409, 409, 409]
