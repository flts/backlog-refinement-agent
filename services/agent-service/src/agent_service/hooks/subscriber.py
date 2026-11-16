"""Background subscriber for backlog-api's internal event stream (``/api/backlog/internal/events``).

``project.deleted``, ``member.removed`` and ``item.deleted`` purge the affected private threads (privacy rule: a
user's private threads must not outlive their access to the project or item). The id of the last processed event is
stored in ``hook_cursor`` (same transaction as the purge), so a restart resumes with ``Last-Event-ID``. When the id is
outside the server's retention window the server sends ``reset`` with the current end of the log; the subscriber just
continues from there (purges are idempotent).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import random
from collections.abc import Awaitable, Callable
from typing import Any, Literal

import httpx
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from agent_service.db.models import HookCursor
from agent_service.hooks.credentials import (
    ClientCredentialsProvider,
    CredentialError,
    CredentialProvider,
    StaticTokenProvider,
)
from agent_service.hooks.handlers import HANDLED_TYPES, InvalidEventError, apply_event
from agent_service.hooks.sse import SseEvent, SseParser
from agent_service.settings import Settings

logger = logging.getLogger(__name__)

CURSOR_NAME = "backlog-internal-events"
EVENTS_PATH = "/api/backlog/internal/events"
RESET = "reset"

HookState = Literal["connected", "disconnected", "disabled"]


class _AuthRejected(Exception):
    def __init__(self, status: int) -> None:
        super().__init__(f"backlog-api answered HTTP {status}")
        self.status = status


class _BadStatus(Exception):
    pass


async def load_cursor(session: AsyncSession) -> int | None:
    return await session.scalar(select(HookCursor.last_event_id).where(HookCursor.name == CURSOR_NAME))


async def save_cursor(session: AsyncSession, event_id: int) -> None:
    statement = insert(HookCursor).values(name=CURSOR_NAME, last_event_id=event_id)
    await session.execute(
        statement.on_conflict_do_update(
            index_elements=[HookCursor.name],
            set_={"last_event_id": statement.excluded.last_event_id, "updated_at": func.now()},
        )
    )


class DisabledHookSubscriber:
    """Placeholder when hooks are off (configuration or missing credential)."""

    state: HookState = "disabled"
    reason: str

    def __init__(self, reason: str) -> None:
        self.reason = reason

    async def start(self) -> None:
        return None

    async def stop(self) -> None:
        return None


class HookSubscriber:
    def __init__(
        self,
        *,
        events_url: str,
        credentials: CredentialProvider,
        client: httpx.AsyncClient,
        sessionmaker: async_sessionmaker[AsyncSession],
        reconnect_min_seconds: float = 1.0,
        reconnect_max_seconds: float = 30.0,
        read_timeout_seconds: float = 75.0,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        jitter: Callable[[], float] = random.random,
        extra_clients: tuple[httpx.AsyncClient, ...] = (),
    ) -> None:
        self._extra_clients = extra_clients
        self._events_url = events_url
        self._credentials = credentials
        self._client = client
        self._sessionmaker = sessionmaker
        self._min = reconnect_min_seconds
        self._max = reconnect_max_seconds
        self._read_timeout = read_timeout_seconds
        self._sleep = sleep
        self._jitter = jitter
        self._task: asyncio.Task[None] | None = None
        self._state: HookState = "disconnected"
        self._cursor: int | None = None
        self.reason = ""

    @property
    def state(self) -> HookState:
        return self._state if self._task is not None and not self._task.done() else "disconnected"

    @property
    def cursor(self) -> int | None:
        return self._cursor

    async def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self.run(), name="event-hooks")

    async def stop(self) -> None:
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        self._state = "disconnected"
        for client in (self._client, *self._extra_clients):
            await client.aclose()

    async def run(self) -> None:
        """Connect, process events and reconnect with exponential backoff and jitter until cancelled."""
        attempt = 0
        auth_retried = False
        while True:
            try:
                await self._load_cursor_once()
                await self._stream(on_connected=self._connected)
                attempt, auth_retried = 0, False  # a clean end (server closed or max-lifetime): reconnect soon
            except asyncio.CancelledError:
                raise
            except _AuthRejected as exc:
                self._state = "disconnected"
                await self._credentials.invalidate()
                if not auth_retried:
                    auth_retried = True
                    logger.warning(
                        "backlog-api rejected the service credential; refreshing it", extra={"status": exc.status}
                    )
                    continue
                logger.warning("backlog-api rejected the refreshed service credential", extra={"status": exc.status})
                attempt += 1
            except (CredentialError, httpx.HTTPError, _BadStatus, SQLAlchemyError, OSError) as exc:
                logger.warning(
                    "Event hook stream failed", extra={"error_type": type(exc).__name__, "error": str(exc)[:200]}
                )
                attempt += 1
            self._state = "disconnected"
            await self._sleep(self._backoff(attempt))

    def _backoff(self, attempt: int) -> float:
        ceiling = min(self._max, self._min * (2 ** max(attempt - 1, 0)))
        return ceiling * (0.5 + 0.5 * self._jitter())

    def _connected(self) -> None:
        self._state = "connected"
        logger.info("Event hook stream connected", extra={"cursor": self._cursor})

    async def _load_cursor_once(self) -> None:
        if self._cursor is None:
            async with self._sessionmaker() as session:
                self._cursor = await load_cursor(session)

    async def _stream(self, *, on_connected: Callable[[], None]) -> None:
        headers = {"Accept": "text/event-stream", "Cache-Control": "no-cache", **await self._credentials.headers()}
        if self._cursor is not None:
            headers["Last-Event-ID"] = str(self._cursor)
        timeout = httpx.Timeout(10.0, read=self._read_timeout)
        async with self._client.stream("GET", self._events_url, headers=headers, timeout=timeout) as response:
            if response.status_code in (401, 403):
                raise _AuthRejected(response.status_code)
            if response.status_code != 200:
                raise _BadStatus(f"backlog-api answered HTTP {response.status_code}")
            on_connected()
            parser = SseParser()
            async for line in response.aiter_lines():
                event = parser.feed(line)
                if event is not None:
                    await self._handle(event)

    async def _handle(self, event: SseEvent) -> None:
        event_id = _parse_id(event.id)
        if event.event == RESET:
            # The server sends the current end of the log; everything before it is lost to us. Purges are idempotent.
            if event_id is not None:
                logger.warning("Event stream was reset by backlog-api; continuing from its current end")
                await self._persist(event_id)
            return
        if event.event not in HANDLED_TYPES:
            return
        if event_id is not None and self._cursor is not None and event_id <= self._cursor:
            return  # already processed (replay overlap)
        try:
            payload = json.loads(event.data)
            if not isinstance(payload, dict):
                raise InvalidEventError("payload is not an object")
            await self._apply(event.event, payload, event_id)
        except (InvalidEventError, ValueError) as exc:
            logger.warning("Skipping an invalid hook event", extra={"event_type": event.event, "reason": str(exc)})
            if event_id is not None:
                await self._persist(event_id)

    async def _apply(self, event_type: str, payload: dict[str, Any], event_id: int | None) -> None:
        async with self._sessionmaker() as session, session.begin():
            deleted = await apply_event(session, event_type, payload)
            if event_id is not None:
                await save_cursor(session, event_id)
        if event_id is not None:
            self._cursor = event_id
        logger.info(
            "Processed hook event", extra={"event_type": event_type, "event_id": event_id, "threads_purged": deleted}
        )

    async def _persist(self, event_id: int) -> None:
        async with self._sessionmaker() as session, session.begin():
            await save_cursor(session, event_id)
        self._cursor = event_id


def _parse_id(value: str | None) -> int | None:
    try:
        return int(value) if value is not None else None
    except ValueError:
        return None


def create_subscriber(
    settings: Settings,
    sessionmaker: async_sessionmaker[AsyncSession],
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> HookSubscriber | DisabledHookSubscriber:
    """The subscriber for the configured credential, or a disabled placeholder (the reason is logged once)."""
    if not settings.event_hooks_enabled:
        logger.info("Event hooks are disabled (AGENT_EVENT_HOOKS_ENABLED=false)")
        return DisabledHookSubscriber("disabled by configuration")
    if not settings.backlog_api_url:
        return DisabledHookSubscriber("no backlog-api URL")
    client = httpx.AsyncClient(transport=transport, follow_redirects=False)
    credentials: CredentialProvider
    extra: tuple[httpx.AsyncClient, ...] = ()
    mode = settings.hooks_credential_mode
    if mode == "static-token":
        assert settings.internal_token is not None
        logger.warning("Event hooks use the static X-Internal-Token (development only)")
        credentials = StaticTokenProvider(settings.internal_token.get_secret_value())
    elif mode == "client-credentials":
        assert settings.service_client_secret is not None and settings.hooks_token_url
        token_client = httpx.AsyncClient(transport=transport, timeout=settings.oidc_http_timeout_seconds)
        credentials = ClientCredentialsProvider(
            token_url=settings.hooks_token_url,
            client_id=settings.service_client_id,
            client_secret=settings.service_client_secret.get_secret_value(),
            client=token_client,
        )
        extra = (token_client,)
    else:
        logger.warning(
            "Event hooks are disabled: no service credential (set AGENT_SERVICE_CLIENT_SECRET or, in development, "
            "AGENT_INTERNAL_TOKEN). Private threads will not be purged when projects, items or members are removed."
        )
        return DisabledHookSubscriber("no service credential configured")
    return HookSubscriber(
        events_url=f"{settings.backlog_api_url.rstrip('/')}{EVENTS_PATH}",
        credentials=credentials,
        client=client,
        sessionmaker=sessionmaker,
        reconnect_min_seconds=settings.hooks_reconnect_min_seconds,
        reconnect_max_seconds=settings.hooks_reconnect_max_seconds,
        read_timeout_seconds=settings.hooks_stream_read_timeout_seconds,
        extra_clients=extra,
    )
