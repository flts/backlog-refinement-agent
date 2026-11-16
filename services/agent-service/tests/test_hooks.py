"""Event hooks: SSE parsing, credentials, handlers, cursor/resume, reset, reconnect, lifespan and readiness."""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest
from asgi_lifespan import LifespanManager
from pydantic import SecretStr, ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from agent_service.auth.tokens import StaticKeySource
from agent_service.db.models import HookCursor, Thread, ThreadSnapshot
from agent_service.hooks import DisabledHookSubscriber, HookSubscriber, create_subscriber
from agent_service.hooks.credentials import ClientCredentialsProvider, CredentialError, StaticTokenProvider
from agent_service.hooks.sse import SseParser
from agent_service.hooks.subscriber import CURSOR_NAME, save_cursor
from agent_service.main import create_app
from agent_service.settings import Settings
from agent_service_testkit import TokenFactory
from conftest import BACKLOG_URL, truncate_all

ISSUER = "http://keycloak.test/realms/backlog"
TOKEN_URL = f"{ISSUER}/protocol/openid-connect/token"
EVENTS_URL = f"{BACKLOG_URL}/api/backlog/internal/events"

PROJECT = uuid.UUID("11111111-1111-4111-8111-111111111111")
OTHER_PROJECT = uuid.UUID("44444444-4444-4444-8444-444444444444")
ITEM = uuid.UUID("22222222-2222-4222-8222-222222222222")
OTHER_ITEM = uuid.UUID("33333333-3333-4333-8333-333333333333")

Sessionmaker = async_sessionmaker[AsyncSession]


# --- helpers ----------------------------------------------------------------------------------------------------


def frame(event_id: int | None, event_type: str, project_id: uuid.UUID, data: dict[str, object] | None = None) -> bytes:
    payload = {"id": event_id, "type": event_type, "projectId": str(project_id), "actor": "x", "data": data or {}}
    head = f"id: {event_id}\n" if event_id is not None else ""
    return f"{head}event: {event_type}\ndata: {json.dumps(payload)}\n\n".encode()


@dataclass
class Connection:
    """One scripted stream connection: a status and body chunks; the stream then ends (or stays open when ``hang``)."""

    chunks: list[bytes] = field(default_factory=list)
    status: int = 200
    hang: bool = False


@dataclass
class FakeBacklog:
    connections: list[Connection]
    requests: list[httpx.Request] = field(default_factory=list)

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        index = len(self.requests) - 1
        script = self.connections[index] if index < len(self.connections) else Connection(hang=True)
        if script.status != 200:
            return httpx.Response(script.status)

        async def body() -> AsyncIterator[bytes]:
            yield b"retry: 3000\n: connected\n\n"
            for chunk in script.chunks:
                yield chunk
            if script.hang:
                await asyncio.Event().wait()

        return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=body())


async def wait_for(predicate: Callable[[], bool], timeout: float = 10.0) -> None:  # noqa: ASYNC109
    async with asyncio.timeout(timeout):
        while not predicate():  # noqa: ASYNC110
            await asyncio.sleep(0.02)


@dataclass
class Sleeps:
    delays: list[float] = field(default_factory=list)

    async def __call__(self, seconds: float) -> None:
        self.delays.append(seconds)
        await asyncio.sleep(0)


def make_subscriber(
    backlog: FakeBacklog,
    sessionmaker: Sessionmaker,
    credentials: StaticTokenProvider | ClientCredentialsProvider | None = None,
    sleeps: Sleeps | None = None,
) -> HookSubscriber:
    return HookSubscriber(
        events_url=EVENTS_URL,
        credentials=credentials or StaticTokenProvider("dev-token"),
        client=httpx.AsyncClient(transport=httpx.MockTransport(backlog.handler)),
        sessionmaker=sessionmaker,
        sleep=sleeps or Sleeps(),
        jitter=lambda: 1.0,
    )


async def add_thread(sessionmaker: Sessionmaker, project: uuid.UUID, item: uuid.UUID, email: str) -> str:
    thread_id = f"thread-{uuid.uuid4().hex[:8]}"
    async with sessionmaker() as session:
        session.add(Thread(id=thread_id, owner_email=email, project_id=project, item_id=item))
        session.add(ThreadSnapshot(scope=f"user:{email}", thread_id=thread_id, messages=[]))
        await session.commit()
    return thread_id


async def remaining(sessionmaker: Sessionmaker) -> set[str]:
    async with sessionmaker() as session:
        return set((await session.execute(select(Thread.id))).scalars().all())


async def stored_cursor(sessionmaker: Sessionmaker) -> int | None:
    async with sessionmaker() as session:
        return await session.scalar(select(HookCursor.last_event_id).where(HookCursor.name == CURSOR_NAME))


async def run_until_cursor(subscriber: HookSubscriber, sessionmaker: Sessionmaker, cursor: int) -> None:
    await subscriber.start()
    try:
        await wait_for(lambda: subscriber.cursor == cursor)
    finally:
        await subscriber.stop()
    assert await stored_cursor(sessionmaker) == cursor


# --- SSE parser -------------------------------------------------------------------------------------------------


def parse(text: str) -> tuple[list[tuple[str, str, str | None]], SseParser]:
    parser = SseParser()
    events = []
    for line in text.split("\n"):
        event = parser.feed(line)
        if event is not None:
            events.append((event.event, event.data, event.id))
    return events, parser


def test_sse_parser_handles_comments_retry_multiline_and_defaults() -> None:
    text = (
        "retry: 3000\n: connected\n\n"
        'id: 7\nevent: member.removed\ndata: {"a":\n'
        "data: 1}\n\n"
        ": keepalive\n\n"
        "data:no-space\n\n"
        "id: 8\nevent: reset\ndata: {}\n\n"
        "unknown: field\n\n"
    )
    events, parser = parse(text)
    assert events == [
        ("member.removed", '{"a":\n1}', "7"),
        ("message", "no-space", None),
        ("reset", "{}", "8"),
    ]
    assert parser.retry_milliseconds == 3000


def test_sse_parser_does_not_leak_fields_between_events() -> None:
    events, _ = parse("id: 1\nevent: a\ndata: x\n\ndata: y\n\n")
    assert events == [("a", "x", "1"), ("message", "y", None)]


# --- credentials ------------------------------------------------------------------------------------------------


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


async def test_client_credentials_token_is_cached_until_expiry_minus_margin() -> None:
    clock = Clock()
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"access_token": f"token-{len(requests)}", "expires_in": 300})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        provider = ClientCredentialsProvider(
            token_url=TOKEN_URL, client_id="agent-service", client_secret="s3cret", client=http, clock=clock
        )
        assert await provider.headers() == {"Authorization": "Bearer token-1"}
        clock.now += 269  # 300 s lifetime - 30 s margin = 270 s of reuse
        assert await provider.headers() == {"Authorization": "Bearer token-1"}
        assert len(requests) == 1
        clock.now += 2
        assert await provider.headers() == {"Authorization": "Bearer token-2"}
        await provider.invalidate()
        assert await provider.headers() == {"Authorization": "Bearer token-3"}
    assert str(requests[0].url) == TOKEN_URL
    form = dict(item.split("=") for item in requests[0].content.decode().split("&"))
    assert form == {"grant_type": "client_credentials", "client_id": "agent-service", "client_secret": "s3cret"}


@pytest.mark.parametrize(
    "response",
    [httpx.Response(401, json={"error": "unauthorized_client"}), httpx.Response(200, json={"nope": 1})],
)
async def test_client_credentials_errors(response: httpx.Response) -> None:
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: response)) as http:
        provider = ClientCredentialsProvider(token_url=TOKEN_URL, client_id="a", client_secret="b", client=http)
        with pytest.raises(CredentialError):
            await provider.headers()


async def test_client_credentials_unreachable_identity_provider() -> None:
    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down")

    async with httpx.AsyncClient(transport=httpx.MockTransport(down)) as http:
        provider = ClientCredentialsProvider(token_url=TOKEN_URL, client_id="a", client_secret="b", client=http)
        with pytest.raises(CredentialError):
            await provider.headers()


async def test_static_token_provider_sends_internal_token_header() -> None:
    assert await StaticTokenProvider("dev").headers() == {"X-Internal-Token": "dev"}


# --- settings / factory -----------------------------------------------------------------------------------------


def hook_settings(**values: Any) -> Settings:
    base: dict[str, Any] = {
        "env": "development",
        "database_url": "postgresql://u:p@db/agentdb",
        "oidc_issuer": ISSUER,
        "backlog_api_url": BACKLOG_URL,
        "llm_base_url": "http://llm.test",
    }
    return Settings(_env_file=None, **{**base, **values})  # type: ignore[call-arg]  # pyright: ignore[reportCallIssue]


def test_token_url_is_derived_from_issuer_and_overridable() -> None:
    assert hook_settings().hooks_token_url == TOKEN_URL
    assert hook_settings(service_token_url="http://kc/t").hooks_token_url == "http://kc/t"


def test_credential_mode_selection() -> None:
    assert hook_settings().service_client_id == "agent-service"
    assert hook_settings().hooks_credential_mode is None
    assert hook_settings(service_client_secret="s").hooks_credential_mode == "client-credentials"
    assert hook_settings(service_client_secret="s", internal_token="t").hooks_credential_mode == "static-token"


def test_static_internal_token_is_refused_in_production() -> None:
    with pytest.raises(ValidationError, match="AGENT_INTERNAL_TOKEN"):
        hook_settings(env="production", internal_token="dev")
    assert hook_settings(env="test", internal_token="dev").hooks_credential_mode == "static-token"


def test_create_subscriber_disabled_paths(caplog: pytest.LogCaptureFixture) -> None:
    sessionmaker: Any = object()
    with caplog.at_level("WARNING", logger="agent_service.hooks.subscriber"):
        missing = create_subscriber(hook_settings(), sessionmaker)
    assert isinstance(missing, DisabledHookSubscriber)
    assert missing.state == "disabled"
    assert sum("no service credential" in record.getMessage() for record in caplog.records) == 1
    off = create_subscriber(hook_settings(event_hooks_enabled=False, internal_token="t"), sessionmaker)
    assert isinstance(off, DisabledHookSubscriber)
    assert isinstance(create_subscriber(hook_settings(internal_token="t"), sessionmaker), HookSubscriber)


# --- subscriber -------------------------------------------------------------------------------------------------


async def test_handlers_purge_with_the_right_filters_and_resume_from_cursor(
    app: Any, sessionmaker: Sessionmaker
) -> None:
    alice_item = await add_thread(sessionmaker, PROJECT, ITEM, "alice@example.test")
    alice_other = await add_thread(sessionmaker, PROJECT, OTHER_ITEM, "alice@example.test")
    bob_item = await add_thread(sessionmaker, PROJECT, ITEM, "bob@example.test")
    elsewhere = await add_thread(sessionmaker, OTHER_PROJECT, ITEM, "bob@example.test")
    backlog = FakeBacklog(
        [
            Connection(
                [
                    frame(1, "item.deleted", PROJECT, {"id": str(OTHER_ITEM), "type": "story", "title": "x"}),
                    frame(2, "member.removed", PROJECT, {"email": "BOB@example.test", "left": False}),
                    frame(3, "item.updated", PROJECT, {"id": str(ITEM)}),
                ],
                hang=True,
            )
        ]
    )
    await run_until_cursor(make_subscriber(backlog, sessionmaker), sessionmaker, 2)
    assert await remaining(sessionmaker) == {alice_item, elsewhere}
    assert alice_other not in await remaining(sessionmaker)
    assert bob_item not in await remaining(sessionmaker)
    async with sessionmaker() as session:  # snapshots of the purged threads are gone as well
        snapshots = set((await session.execute(select(ThreadSnapshot.thread_id))).scalars().all())
    assert snapshots == {alice_item, elsewhere}
    assert "last-event-id" not in backlog.requests[0].headers
    assert backlog.requests[0].headers["x-internal-token"] == "dev-token"
    assert "authorization" not in backlog.requests[0].headers

    # A new subscriber (a restart) resumes from the persisted cursor.
    backlog = FakeBacklog([Connection([frame(5, "project.deleted", PROJECT)], hang=True)])
    await run_until_cursor(make_subscriber(backlog, sessionmaker), sessionmaker, 5)
    assert await remaining(sessionmaker) == {elsewhere}
    assert backlog.requests[0].headers["last-event-id"] == "2"


async def test_replayed_events_are_skipped(app: Any, sessionmaker: Sessionmaker) -> None:
    thread = await add_thread(sessionmaker, PROJECT, ITEM, "alice@example.test")
    backlog = FakeBacklog(
        [
            Connection(
                [
                    frame(4, "item.deleted", PROJECT, {"id": str(ITEM)}),
                    frame(4, "item.deleted", PROJECT, {"id": str(ITEM)}),
                    frame(3, "project.deleted", PROJECT),
                    frame(5, "item.updated", PROJECT, {"id": str(ITEM)}),
                    frame(6, "member.removed", OTHER_PROJECT, {"email": "alice@example.test"}),
                ],
                hang=True,
            )
        ]
    )
    await run_until_cursor(make_subscriber(backlog, sessionmaker), sessionmaker, 6)
    assert thread not in await remaining(sessionmaker)


async def test_invalid_events_are_skipped_but_advance_the_cursor(app: Any, sessionmaker: Sessionmaker) -> None:
    thread = await add_thread(sessionmaker, PROJECT, ITEM, "alice@example.test")
    no_email = json.dumps({"projectId": str(PROJECT), "data": {}})
    backlog = FakeBacklog(
        [
            Connection(
                [
                    f"id: 1\nevent: member.removed\ndata: {no_email}\n\n".encode(),
                    b"id: 2\nevent: item.deleted\ndata: not json\n\n",
                    b'id: 3\nevent: project.deleted\ndata: {"projectId": "nope"}\n\n',
                ],
                hang=True,
            )
        ]
    )
    await run_until_cursor(make_subscriber(backlog, sessionmaker), sessionmaker, 3)
    assert await remaining(sessionmaker) == {thread}


async def test_reset_continues_from_the_reset_id(app: Any, sessionmaker: Sessionmaker) -> None:
    async with sessionmaker() as session, session.begin():
        await save_cursor(session, 3)
    thread = await add_thread(sessionmaker, PROJECT, ITEM, "alice@example.test")
    reset = b'id: 90\nevent: reset\ndata: {"id": 90, "type": "reset", "data": {"latestEventId": 90}}\n\n'
    backlog = FakeBacklog([Connection([reset]), Connection([frame(91, "project.deleted", PROJECT)], hang=True)])
    await run_until_cursor(make_subscriber(backlog, sessionmaker), sessionmaker, 91)
    assert backlog.requests[0].headers["last-event-id"] == "3"
    assert backlog.requests[1].headers["last-event-id"] == "90"
    assert thread not in await remaining(sessionmaker)


async def test_reconnects_with_backoff_after_errors_and_resumes(app: Any, sessionmaker: Sessionmaker) -> None:
    thread = await add_thread(sessionmaker, PROJECT, ITEM, "alice@example.test")
    sleeps = Sleeps()
    backlog = FakeBacklog(
        [
            Connection(status=503),
            Connection(status=503),
            Connection([frame(1, "item.deleted", PROJECT, {"id": str(OTHER_ITEM)})]),
            Connection([frame(2, "project.deleted", PROJECT)], hang=True),
        ]
    )
    await run_until_cursor(make_subscriber(backlog, sessionmaker, sleeps=sleeps), sessionmaker, 2)
    assert sleeps.delays[:2] == [1.0, 2.0]  # exponential (jitter pinned to its maximum)
    assert [r.headers.get("last-event-id") for r in backlog.requests[2:4]] == [None, "1"]
    assert thread not in await remaining(sessionmaker)


async def test_rejected_credential_is_refreshed_once_then_backs_off(app: Any, sessionmaker: Sessionmaker) -> None:
    thread = await add_thread(sessionmaker, PROJECT, ITEM, "alice@example.test")
    token_requests: list[httpx.Request] = []

    def keycloak(request: httpx.Request) -> httpx.Response:
        token_requests.append(request)
        return httpx.Response(200, json={"access_token": f"kc-{len(token_requests)}", "expires_in": 300})

    sleeps = Sleeps()
    backlog = FakeBacklog(
        [
            Connection(status=401),
            Connection(status=403),
            Connection(status=401),
            Connection([frame(1, "project.deleted", PROJECT)], hang=True),
        ]
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(keycloak)) as http:
        provider = ClientCredentialsProvider(
            token_url=TOKEN_URL, client_id="agent-service", client_secret="s", client=http
        )
        await run_until_cursor(make_subscriber(backlog, sessionmaker, provider, sleeps), sessionmaker, 1)
    authorizations = [r.headers["authorization"] for r in backlog.requests]
    assert authorizations == ["Bearer kc-1", "Bearer kc-2", "Bearer kc-3", "Bearer kc-4"]
    assert len(sleeps.delays) == 2  # the first rejection refreshes immediately; later ones back off
    assert thread not in await remaining(sessionmaker)


async def test_unreachable_token_endpoint_backs_off(app: Any, sessionmaker: Sessionmaker) -> None:
    calls = 0

    def keycloak(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise httpx.ConnectError("down")
        return httpx.Response(200, json={"access_token": "kc", "expires_in": 300})

    sleeps = Sleeps()
    backlog = FakeBacklog([Connection([frame(1, "project.deleted", PROJECT)], hang=True)])
    async with httpx.AsyncClient(transport=httpx.MockTransport(keycloak)) as http:
        provider = ClientCredentialsProvider(token_url=TOKEN_URL, client_id="a", client_secret="s", client=http)
        await run_until_cursor(make_subscriber(backlog, sessionmaker, provider, sleeps), sessionmaker, 1)
    assert calls == 2
    assert len(sleeps.delays) == 1
    assert backlog.requests[0].headers["authorization"] == "Bearer kc"


async def test_cursor_upsert_is_conflict_safe(app: Any, sessionmaker: Sessionmaker) -> None:
    for value in (1, 5, 9):
        async with sessionmaker() as session, session.begin():
            await save_cursor(session, value)
    assert await stored_cursor(sessionmaker) == 9
    async with sessionmaker() as session:
        assert len((await session.execute(select(HookCursor))).scalars().all()) == 1


# --- lifespan and readiness -------------------------------------------------------------------------------------


async def ready_hooks(app: Any) -> Any:
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as client:
        response = await client.get("/readyz")
    assert response.status_code == 200
    return response.json()["hooks"]


async def test_readyz_reports_disabled_without_credential(client: httpx.AsyncClient) -> None:
    assert (await client.get("/readyz")).json()["hooks"] == "disabled"


async def test_lifespan_runs_the_subscriber_with_client_credentials(
    settings: Settings, tokens: TokenFactory, database_url: str
) -> None:
    seen: list[httpx.Request] = []
    backlog = FakeBacklog([Connection(hang=True)])

    def transport_handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path.endswith("/openid-connect/token"):
            return httpx.Response(200, json={"access_token": "kc-token", "expires_in": 300})
        return backlog.handler(request)

    configured = settings.model_copy(update={"service_client_secret": SecretStr("dev-secret"), "oidc_issuer": ISSUER})
    await truncate_all(database_url)
    app = create_app(
        configured,
        key_source=StaticKeySource(tokens.jwks),
        hooks_transport=httpx.MockTransport(transport_handler),
        configure_logs=False,
    )
    async with LifespanManager(app, startup_timeout=30):
        async with asyncio.timeout(10):
            while await ready_hooks(app) != "connected":  # noqa: ASYNC110
                await asyncio.sleep(0.02)
    assert [str(r.url) for r in seen] == [TOKEN_URL, EVENTS_URL]
    assert seen[1].headers["authorization"] == "Bearer kc-token"
    assert seen[0].headers["accept"] == "application/json"


async def test_readyz_reports_disconnected_while_the_stream_is_down(
    settings: Settings, tokens: TokenFactory, database_url: str
) -> None:
    backlog = FakeBacklog([Connection(status=503)] * 50)
    configured = settings.model_copy(
        update={"internal_token": SecretStr("dev"), "env": "test", "hooks_reconnect_min_seconds": 60.0}
    )
    await truncate_all(database_url)
    app = create_app(
        configured,
        key_source=StaticKeySource(tokens.jwks),
        hooks_transport=httpx.MockTransport(backlog.handler),
        configure_logs=False,
    )
    async with LifespanManager(app, startup_timeout=30):
        await wait_for(lambda: len(backlog.requests) >= 1)
        assert await ready_hooks(app) == "disconnected"
