"""Event log, LISTEN/NOTIFY fan-out, project SSE stream, tickets, presence and the internal stream.

The stream tests run the app on a real local socket (uvicorn) because ``httpx.ASGITransport`` buffers responses.
"""

from __future__ import annotations

import asyncio
import contextlib
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import httpx
import pytest
import uvicorn
from pydantic import SecretStr
from sqlalchemy import delete, select

from backlog_api import events
from backlog_api.auth.tokens import StaticKeySource
from backlog_api.db.models import ProjectEvent
from backlog_api.db.session import Database
from backlog_api.event_bus import PostgresEventPublisher
from backlog_api.events import DomainEvent
from backlog_api.main import create_app
from backlog_api.settings import Settings
from backlog_api.stream_tickets import StreamTicket, TicketSigner
from backlog_api_testkit import API, TokenFactory, add_member, create_project
from conftest import truncate_all
from live_testkit import SseReader, free_port

ALICE = "alice@example.test"
BOB = "bob@example.test"
SERVICE_CLIENT = "agent-service"
INTERNAL_SECRET = "dev-internal-secret"  # noqa: S105


@dataclass
class Live:
    base: str
    http: httpx.AsyncClient
    tokens: TokenFactory
    app: Any

    def headers(self, email: str = ALICE) -> dict[str, str]:
        return self.tokens.headers(email)

    async def project(self, owner: str = ALICE, *members: str) -> str:
        created = await create_project(self.http, self.tokens, owner)
        for member in members:
            response = await add_member(self.http, self.tokens, created["id"], owner, member)
            assert response.status_code == 201, response.text
        return created["id"]

    @contextlib.asynccontextmanager
    async def stream(
        self, path: str, headers: dict[str, str] | None = None, params: dict[str, str] | None = None
    ) -> AsyncIterator[SseReader]:
        async with self.http.stream("GET", path, headers=headers or self.headers(), params=params) as response:
            assert response.status_code == 200, await response.aread()
            yield SseReader(response)

    async def rename(self, project_id: str, name: str, email: str = ALICE) -> None:
        current = await self.http.get(f"{API}/projects/{project_id}", headers=self.headers(email))
        response = await self.http.patch(
            f"{API}/projects/{project_id}",
            json={"name": name},
            headers={**self.headers(email), "If-Match": f'"{current.json()["version"]}"'},
        )
        assert response.status_code == 200, response.text


@pytest.fixture
def live_settings(settings: Settings) -> Settings:
    return settings.model_copy(
        update={
            "events_heartbeat_seconds": 0.3,
            "events_recheck_seconds": 0.4,
            "presence_ttl_seconds": 1.0,
            "presence_sweep_seconds": 0.2,
            "events_ticket_secret": None,
            "internal_client_ids": [SERVICE_CLIENT],
            "internal_token": SecretStr(INTERNAL_SECRET),
        }
    )


@pytest.fixture
async def live(live_settings: Settings, tokens: TokenFactory, database_url: str) -> AsyncIterator[Live]:
    await truncate_all(database_url)
    app = create_app(live_settings, key_source=StaticKeySource(tokens.jwks), configure_logs=False)
    port = free_port()
    server = uvicorn.Server(
        uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", lifespan="on", access_log=False)
    )
    task = asyncio.create_task(server.serve())
    for _ in range(300):
        if server.started:
            break
        await asyncio.sleep(0.05)
    assert server.started, "the test server did not start"
    await asyncio.wait_for(app.state.event_bus.wait_ready(), 10)
    base = f"http://127.0.0.1:{port}"
    async with httpx.AsyncClient(base_url=base, timeout=10) as http:
        yield Live(base, http, tokens, app)
    server.should_exit = True
    await asyncio.wait_for(task, 15)


def _service_headers(tokens: TokenFactory, client: str = SERVICE_CLIENT) -> dict[str, str]:
    # Client-credentials style token: no email claim.
    return tokens.headers(None, email_verified=None, extra={"azp": client}, omit=("email", "email_verified", "name"))


@contextlib.asynccontextmanager
async def replica(settings: Settings) -> AsyncIterator[PostgresEventPublisher]:
    """A second publisher with its own listener connection: another backlog-api replica."""
    url = settings.async_database_url
    assert url is not None
    database = Database(url, pool_size=2, max_overflow=2)
    bus = PostgresEventPublisher(settings)
    await bus.start(database)
    await asyncio.wait_for(bus.wait_ready(), 10)
    try:
        yield bus
    finally:
        await bus.stop()
        await database.dispose()


# --- publisher ------------------------------------------------------------------------------------------------------


async def test_publish_is_logged_and_reaches_subscribers_of_other_replicas(live: Live, live_settings: Settings) -> None:
    project_id = uuid.uuid4()
    async with replica(live_settings) as other:
        remote = other.subscribe(project_id=project_id)
        elsewhere = other.subscribe(project_id=uuid.uuid4())
        await live.app.state.events.publish(DomainEvent(events.ITEM_CREATED, project_id, ALICE, {"id": "x"}))
        received = await asyncio.wait_for(remote.get(), 5)
        assert received is not None
        assert (received.type, received.actor, received.data) == (events.ITEM_CREATED, ALICE, {"id": "x"})
        assert received.id is not None
        assert elsewhere.queue.empty()
        remote.close()
        elsewhere.close()
    async with live.app.state.db.sessionmaker() as session:
        rows = (await session.scalars(select(ProjectEvent))).all()
    assert [(row.type, row.project_id) for row in rows] == [(events.ITEM_CREATED, project_id)]


async def test_slow_subscriber_is_dropped(live: Live, live_settings: Settings) -> None:
    bus: PostgresEventPublisher = live.app.state.events
    bus.settings = live_settings.model_copy(update={"events_subscriber_queue_size": 2})
    subscription = bus.subscribe()
    project_id = uuid.uuid4()
    for number in range(5):
        await bus.publish(DomainEvent(events.ITEM_UPDATED, project_id, ALICE, {"n": number}))
    for _ in range(100):
        if subscription.dropped:
            break
        await asyncio.sleep(0.05)
    assert subscription.dropped
    assert await asyncio.wait_for(subscription.get(), 1) is None
    assert bus.subscriber_count == 0
    bus.settings = live_settings


async def test_prune_removes_old_and_excess_events(live: Live, live_settings: Settings) -> None:
    bus: PostgresEventPublisher = live.app.state.events
    project_id = uuid.uuid4()
    for number in range(15):
        await bus.publish(DomainEvent(events.ITEM_UPDATED, project_id, ALICE, {"n": number}))
    bus.settings = live_settings.model_copy(update={"events_max_per_project": 10})
    assert await bus.prune() == 5
    bus.settings = live_settings.model_copy(update={"events_retention_seconds": 1})
    await asyncio.sleep(1.2)
    assert await bus.prune() == 10
    bus.settings = live_settings


# --- project stream -------------------------------------------------------------------------------------------------


async def test_stream_delivers_published_events_with_wire_format(live: Live) -> None:
    project_id = await live.project(ALICE)
    async with live.stream(f"{API}/projects/{project_id}/events") as stream:
        assert stream.response.headers["content-type"].startswith("text/event-stream")
        assert stream.response.headers["cache-control"].startswith("no-cache")
        assert stream.response.headers["x-accel-buffering"] == "no"
        initial = await stream.next()
        assert initial is not None and initial.event == "presence" and initial.id is None
        assert initial.data["data"] == {"users": []}
        await live.rename(project_id, "Renamed")
        event = await stream.until("project.updated")
    assert event.id is not None
    assert event.data["id"] == event.id
    assert event.data["type"] == "project.updated"
    assert event.data["projectId"] == project_id
    assert event.data["actor"] == ALICE
    assert event.data["actorName"] == "Alice"
    assert event.data["data"]["name"] == "Renamed"
    assert event.data["at"]


async def test_stream_requires_authentication_and_membership(live: Live) -> None:
    project_id = await live.project(ALICE)
    url = f"{API}/projects/{project_id}/events"
    assert (await live.http.get(url)).status_code == 401
    assert (await live.http.get(url, headers=live.headers(BOB))).status_code == 404


async def test_stream_only_carries_events_of_its_project(live: Live) -> None:
    first = await live.project(ALICE)
    second = await live.project(ALICE)
    async with live.stream(f"{API}/projects/{first}/events") as stream:
        await live.rename(second, "Other")
        await live.rename(first, "Mine")
        event = await stream.until("project.updated")
    assert event.data["projectId"] == first


@pytest.mark.parametrize("via", ["header", "query"])
async def test_last_event_id_replays_missed_events(live: Live, via: str) -> None:
    project_id = await live.project(ALICE)
    async with live.stream(f"{API}/projects/{project_id}/events") as stream:
        await live.rename(project_id, "One")
        first = await stream.until("project.updated")
    await live.rename(project_id, "Two")
    await live.rename(project_id, "Three")
    headers, params = live.headers(), {}
    if via == "header":
        headers["Last-Event-ID"] = str(first.id)
    else:
        params["lastEventId"] = str(first.id)
    async with live.stream(f"{API}/projects/{project_id}/events", headers, params) as stream:
        names = []
        while len(names) < 2:
            item = await stream.next()
            assert item is not None
            if item.event == "project.updated":
                names.append(item.data["data"]["name"])
    assert names == ["Two", "Three"]


async def test_resume_from_an_unretained_id_sends_reset(live: Live) -> None:
    project_id = await live.project(ALICE)
    await live.rename(project_id, "One")
    async with live.app.state.db.sessionmaker() as session:
        newest = await session.scalar(select(ProjectEvent.id).order_by(ProjectEvent.id.desc()))
        await session.execute(delete(ProjectEvent))
        await session.commit()
    await live.rename(project_id, "Two")  # the log is not empty, but the old id is gone
    # The id right before the oldest retained event is still resumable; anything older is not.
    for stale in (str(newest - 1), "99999999", "garbage"):
        async with live.stream(
            f"{API}/projects/{project_id}/events", live.headers() | {"Last-Event-ID": stale}
        ) as stream:
            reset = await stream.until("reset")
        assert reset.id is not None and reset.data["data"]["latestEventId"] == reset.id


async def test_heartbeat_comments_keep_the_stream_alive(live: Live) -> None:
    project_id = await live.project(ALICE)
    async with live.stream(f"{API}/projects/{project_id}/events") as stream:
        assert (await stream.next()) is not None  # initial presence
        deadline = asyncio.get_running_loop().time() + 3
        while stream.keepalives < 2 and asyncio.get_running_loop().time() < deadline:
            with contextlib.suppress(TimeoutError):
                await stream.next(wait=0.5)
    assert stream.keepalives >= 2


async def test_removed_member_stream_gets_a_final_event_and_closes(live: Live) -> None:
    project_id = await live.project(ALICE, BOB)
    async with live.stream(f"{API}/projects/{project_id}/events", live.headers(BOB)) as stream:
        await stream.until("presence")
        response = await live.http.delete(f"{API}/projects/{project_id}/members/{BOB}", headers=live.headers())
        assert response.status_code == 204
        removed = await stream.until("member.removed")
        closed = await stream.until("closed")
        assert removed.data["data"]["email"] == BOB
        assert closed.data["data"]["reason"] == "member-removed"
        assert await stream.next() is None


async def test_project_deletion_closes_streams(live: Live) -> None:
    project_id = await live.project(ALICE, BOB)
    async with live.stream(f"{API}/projects/{project_id}/events", live.headers(BOB)) as stream:
        await stream.until("presence")
        response = await live.http.delete(f"{API}/projects/{project_id}", headers=live.headers())
        assert response.status_code == 204
        await stream.until("project.deleted")
        assert (await stream.until("closed")).data["data"]["reason"] == "project-deleted"


async def test_periodic_recheck_closes_streams_of_users_who_lost_access(live: Live, live_settings: Settings) -> None:
    project_id = await live.project(ALICE, BOB)
    async with live.stream(f"{API}/projects/{project_id}/events", live.headers(BOB)) as stream:
        await stream.until("presence")
        async with live.app.state.db.sessionmaker() as session:
            from sqlalchemy import text

            await session.execute(text("DELETE FROM project_members WHERE email = :email"), {"email": BOB})
            await session.commit()
        assert (await stream.until("closed")).data["data"]["reason"] == "not-a-member"


# --- tickets --------------------------------------------------------------------------------------------------------


async def test_ticket_opens_the_stream_without_an_authorization_header(live: Live) -> None:
    project_id = await live.project(ALICE)
    response = await live.http.post(f"{API}/projects/{project_id}/events/ticket", headers=live.headers())
    assert response.status_code == 201
    ticket = response.json()["ticket"]
    assert response.json()["expiresAt"]
    async with live.stream(f"{API}/projects/{project_id}/events", headers={}, params={"ticket": ticket}) as stream:
        await live.rename(project_id, "Via ticket")
        event = await stream.until("project.updated")
    assert event.data["actor"] == ALICE


async def test_ticket_is_rejected_when_expired_forged_or_for_another_project(live: Live) -> None:
    project_id = await live.project(ALICE)
    other_id = await live.project(ALICE)
    signer: TicketSigner = live.app.state.ticket_signer
    url = f"{API}/projects/{project_id}/events"

    expired = signer.encode(signer.issue(ALICE, uuid.UUID(project_id), now=0))
    assert (await live.http.get(url, params={"ticket": expired})).status_code == 401

    forged = TicketSigner(b"another secret").encode(signer.issue(ALICE, uuid.UUID(project_id)))
    assert (await live.http.get(url, params={"ticket": forged})).status_code == 401
    assert (await live.http.get(url, params={"ticket": "garbage"})).status_code == 401

    wrong_project = signer.encode(signer.issue(ALICE, uuid.UUID(other_id)))
    assert (await live.http.get(url, params={"ticket": wrong_project})).status_code == 403

    outsider = signer.encode(StreamTicket(BOB, uuid.UUID(project_id), 2**40))
    assert (await live.http.get(url, params={"ticket": outsider})).status_code == 404

    assert (await live.http.post(f"{url}/ticket", headers=live.headers(BOB))).status_code == 404
    assert (await live.http.post(f"{url}/ticket")).status_code == 401


# --- presence -------------------------------------------------------------------------------------------------------


async def test_presence_join_item_change_leave_and_expiry(live: Live) -> None:
    project_id = await live.project(ALICE, BOB)
    presence_url = f"{API}/projects/{project_id}/presence"
    item_id = str(uuid.uuid4())

    async with live.stream(f"{API}/projects/{project_id}/events") as stream:
        assert (await stream.until("presence")).data["data"] == {"users": []}

        joined = await live.http.post(presence_url, json={}, headers=live.headers(BOB))
        assert joined.status_code == 200
        users = (await stream.until("presence")).data["data"]["users"]
        assert users == [{"email": BOB, "name": "Bob", "itemId": None, "state": "viewing"}]

        # A repeated heartbeat with the same content is not a change.
        await live.http.post(presence_url, json={}, headers=live.headers(BOB))
        await live.http.post(presence_url, json={"itemId": item_id, "state": "editing"}, headers=live.headers(BOB))
        users = (await stream.until("presence")).data["data"]["users"]
        assert users[0]["itemId"] == item_id and users[0]["state"] == "editing"

        current = await live.http.get(presence_url, headers=live.headers())
        assert [user["email"] for user in current.json()["users"]] == [BOB]

        left = await live.http.delete(presence_url, headers=live.headers(BOB))
        assert left.status_code == 204
        assert (await stream.until("presence")).data["data"] == {"users": []}

        await live.http.post(presence_url, json={}, headers=live.headers(BOB))
        assert len((await stream.until("presence")).data["data"]["users"]) == 1
        # No more heartbeats: the entry expires after the TTL and the sweeper announces it.
        assert (await stream.until("presence", wait=5)).data["data"] == {"users": []}


async def test_presence_validates_input_and_membership(live: Live) -> None:
    project_id = await live.project(ALICE)
    url = f"{API}/projects/{project_id}/presence"
    assert (await live.http.post(url, json={"state": "dancing"}, headers=live.headers())).status_code == 422
    assert (await live.http.post(url, json={"itemId": "nope"}, headers=live.headers())).status_code == 422
    assert (await live.http.post(url, json={}, headers=live.headers(BOB))).status_code == 404
    assert (await live.http.get(url, headers=live.headers(BOB))).status_code == 404


# --- internal stream ------------------------------------------------------------------------------------------------


async def test_internal_stream_carries_cleanup_events_for_service_credentials(live: Live) -> None:
    project_id = await live.project(ALICE, BOB)
    async with live.stream(f"{API}/internal/events", _service_headers(live.tokens)) as stream:
        await live.rename(project_id, "ignored")
        await live.http.delete(f"{API}/projects/{project_id}/members/{BOB}", headers=live.headers())
        await live.http.delete(f"{API}/projects/{project_id}", headers=live.headers())
        removed = await stream.next()
        deleted = await stream.next()
    assert removed is not None and deleted is not None
    assert (removed.event, removed.data["data"]["email"], removed.data["projectId"]) == (
        "member.removed",
        BOB,
        project_id,
    )
    assert (deleted.event, deleted.data["projectId"]) == ("project.deleted", project_id)


async def test_internal_stream_resumes_with_last_event_id(live: Live) -> None:
    project_id = await live.project(ALICE, BOB)
    await live.http.delete(f"{API}/projects/{project_id}/members/{BOB}", headers=live.headers())
    async with live.app.state.db.sessionmaker() as session:
        first = await session.scalar(select(ProjectEvent.id).order_by(ProjectEvent.id).limit(1))
    headers = _service_headers(live.tokens) | {"Last-Event-ID": str(first)}
    async with live.stream(f"{API}/internal/events", headers) as stream:
        event = await stream.next()
    assert event is not None and event.event == "member.removed"


async def test_internal_stream_authentication(live: Live) -> None:
    url = f"{API}/internal/events"
    assert (await live.http.get(url)).status_code == 401
    assert (await live.http.get(url, headers=live.headers())).status_code == 403  # a user token (azp=backlog-web)
    assert (await live.http.get(url, headers=_service_headers(live.tokens, "someone-else"))).status_code == 403
    assert (await live.http.get(url, headers={"X-Internal-Token": "wrong"})).status_code == 403
    async with live.stream(url, {"X-Internal-Token": INTERNAL_SECRET}) as stream:
        assert stream.response.status_code == 200


async def test_internal_endpoint_is_not_in_the_openapi_schema(live: Live) -> None:
    schema = (await live.http.get(f"{API}/openapi.json")).json()
    assert not [path for path in schema["paths"] if "/internal" in path]
    assert f"{API}/projects/{{project_id}}/events" in schema["paths"]


def test_canonical_event_types_are_listed() -> None:
    assert {"item.created", "relationship.deleted", "source.updated", "member.removed", "guidance.updated"} <= set(
        events.PROJECT_EVENT_TYPES
    )
    assert events.INTERNAL_EVENT_TYPES == {"project.deleted", "member.removed", "item.deleted"}
