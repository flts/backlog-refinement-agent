"""Cross-replica event delivery: an event log table plus ``LISTEN/NOTIFY``.

:class:`PostgresEventPublisher` implements the :class:`~backlog_api.events.EventPublisher` protocol. ``publish`` (called
by routes *after* their transaction committed) inserts the event into ``project_events`` and issues
``NOTIFY backlog_events, '<event id>:<project id>'`` in one short transaction of its own; the table is the resume window
for ``Last-Event-ID``. Publishing never fails the request: errors are logged.

Every process runs one listener task on a dedicated asyncpg connection (reconnecting with backoff and catching up on
what it missed) and fans notifications out to in-process :class:`Subscription` objects, each with a bounded queue.
A subscriber that cannot keep up is dropped; its client reconnects with ``Last-Event-ID`` and replays the gap.
Presence changes travel over a second channel (``backlog_presence``); the current list is loaded and delivered as a
transient ``presence`` event.

Delivery is at-least-once and, around reconnects, may repeat events: clients treat events as cache invalidations.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import uuid
from collections.abc import Collection
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import asyncpg
from sqlalchemy import delete, func, insert, select, text
from sqlalchemy.exc import SQLAlchemyError

from backlog_api import presence
from backlog_api.db.models import Presence, ProjectEvent, User
from backlog_api.db.session import Database
from backlog_api.events import (
    EVENTS_CHANNEL,
    MEMBER_REMOVED,
    PRESENCE,
    PRESENCE_CHANNEL,
    DomainEvent,
)
from backlog_api.settings import Settings

logger = logging.getLogger(__name__)

SYSTEM_ACTOR = "system"
_LOAD_RETRIES = 3


@dataclass(frozen=True, slots=True)
class StreamEvent:
    """An event as delivered to SSE clients. ``id`` is the ``project_events`` id; transient events have none."""

    type: str
    project_id: uuid.UUID
    actor: str
    data: dict[str, Any]
    at: datetime
    id: int | None = None
    actor_name: str | None = None

    def payload(self) -> dict[str, Any]:
        body: dict[str, Any] = {
            "type": self.type,
            "projectId": str(self.project_id),
            "actor": self.actor,
            "data": self.data,
            "at": self.at.isoformat(),
        }
        if self.id is not None:
            body["id"] = self.id
        if self.actor_name:
            body["actorName"] = self.actor_name
        return body

    def to_sse(self, *, event_id: int | None = None) -> str:
        identifier = self.id if event_id is None else event_id
        lines = [] if identifier is None else [f"id: {identifier}"]
        lines += [
            f"event: {self.type}",
            f"data: {json.dumps(self.payload(), separators=(',', ':'), ensure_ascii=False)}",
        ]
        return "\n".join(lines) + "\n\n"


@dataclass(slots=True)
class Replay:
    """Result of resolving ``Last-Event-ID``: the missed events, or ``reset`` when the gap cannot be replayed."""

    events: list[StreamEvent] = field(default_factory=list)
    reset: bool = False
    latest_id: int | None = None


class Subscription:
    """A bounded queue of events for one SSE connection. ``get`` returns ``None`` once the subscription is closed
    (shutdown, or the subscriber was too slow and has been dropped)."""

    def __init__(
        self,
        bus: PostgresEventPublisher,
        project_id: uuid.UUID | None,
        types: Collection[str] | None,
        queue_size: int,
    ) -> None:
        self._bus = bus
        self.project_id = project_id
        self.types = frozenset(types) if types is not None else None
        self.queue: asyncio.Queue[StreamEvent | None] = asyncio.Queue(maxsize=queue_size)
        self.closed = False
        self.dropped = False

    def accepts(self, event: StreamEvent) -> bool:
        if self.project_id is not None and event.project_id != self.project_id:
            return False
        return self.types is None or event.type in self.types

    def offer(self, event: StreamEvent) -> None:
        if self.closed:
            return
        try:
            self.queue.put_nowait(event)
        except asyncio.QueueFull:
            logger.warning("Dropping a slow event subscriber", extra={"project_id": str(self.project_id)})
            self.dropped = True
            self.close()

    async def get(self) -> StreamEvent | None:
        if self.closed and self.queue.empty():
            return None
        return await self.queue.get()

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        self._bus.discard(self)
        while True:  # make room for the end marker
            try:
                self.queue.get_nowait()
            except asyncio.QueueEmpty:
                break
        self.queue.put_nowait(None)


class PostgresEventPublisher:
    """Event log + ``LISTEN/NOTIFY`` fan-out. Construct freely; nothing connects until :meth:`start`."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._database: Database | None = None
        self._subscriptions: set[Subscription] = set()
        self._tasks: list[asyncio.Task[None]] = []
        self._connection: asyncpg.Connection | None = None
        self._ready = asyncio.Event()
        self._wake = asyncio.Event()
        self._pending_ids: list[int] = []
        self._pending_presence: set[uuid.UUID] = set()
        self._last_id = 0
        self._initialised = False
        self._stopping = False

    # -- lifecycle ------------------------------------------------------------------------------------------------

    @property
    def started(self) -> bool:
        return self._database is not None and not self._stopping

    @property
    def database(self) -> Database:
        if self._database is None:
            raise RuntimeError("The event bus is not started.")
        return self._database

    async def start(self, database: Database) -> None:
        self._database = database
        self._stopping = False
        self._initialised = False
        self._last_id = 0
        self._tasks = [
            asyncio.create_task(self._listen_loop(), name="events-listener"),
            asyncio.create_task(self._dispatch_loop(), name="events-dispatcher"),
            asyncio.create_task(self._prune_loop(), name="events-pruner"),
            asyncio.create_task(self._sweep_loop(), name="presence-sweeper"),
        ]

    async def stop(self) -> None:
        self._stopping = True
        for subscription in list(self._subscriptions):
            subscription.close()
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        self._tasks = []
        connection, self._connection = self._connection, None
        if connection is not None:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(connection.close(), timeout=5)
        self._ready.clear()
        self._database = None

    async def wait_ready(self) -> None:
        """Wait until the listener is connected (``start`` does not block: the app also starts without a database)."""
        await self._ready.wait()

    # -- publishing -----------------------------------------------------------------------------------------------

    async def publish(self, event: DomainEvent) -> None:
        """Store the event and notify all replicas. Errors are logged, never raised (the change is committed)."""
        try:
            async with self.database.sessionmaker() as session:
                event_id = await session.scalar(
                    insert(ProjectEvent)
                    .values(
                        project_id=event.project_id,
                        type=event.type,
                        actor=event.actor,
                        data=json.loads(json.dumps(event.data, default=str)),
                    )
                    .returning(ProjectEvent.id)
                )
                await session.execute(
                    text("SELECT pg_notify(:channel, :payload)"),
                    {"channel": EVENTS_CHANNEL, "payload": f"{event_id}:{event.project_id}"},
                )
                if event.type == MEMBER_REMOVED and isinstance(event.data.get("email"), str):
                    removed = await session.execute(
                        delete(Presence)
                        .where(Presence.project_id == event.project_id, Presence.email == event.data["email"].lower())
                        .returning(Presence.email)
                    )
                    if removed.first() is not None:
                        await presence.notify_changed(session, event.project_id)
                await session.commit()
        except (SQLAlchemyError, OSError, TypeError, ValueError, RuntimeError):
            logger.exception("Publishing an event failed", extra={"event_type": event.type})

    # -- subscribing ----------------------------------------------------------------------------------------------

    def subscribe(self, *, project_id: uuid.UUID | None = None, types: Collection[str] | None = None) -> Subscription:
        subscription = Subscription(self, project_id, types, self.settings.events_subscriber_queue_size)
        self._subscriptions.add(subscription)
        return subscription

    def discard(self, subscription: Subscription) -> None:
        self._subscriptions.discard(subscription)

    @property
    def subscriber_count(self) -> int:
        return len(self._subscriptions)

    async def latest_event_id(self) -> int | None:
        async with self.database.sessionmaker() as session:
            return await session.scalar(select(func.max(ProjectEvent.id)))

    async def replay(
        self, last_event_id: int, *, project_id: uuid.UUID | None, types: Collection[str] | None = None
    ) -> Replay:
        """Events after ``last_event_id`` (for one project, or all), or ``reset`` when they cannot be replayed:
        the id is outside the retained window of the log (pruned, or from another database) or more than
        ``events_replay_limit`` events were missed. ``latest_id`` lets the client continue from the current end of
        the log after a reset."""
        async with self.database.sessionmaker() as session:
            oldest, latest = (await session.execute(select(func.min(ProjectEvent.id), func.max(ProjectEvent.id)))).one()
            if oldest is None or not oldest - 1 <= last_event_id <= latest:
                return Replay(reset=True, latest_id=latest)
            query = (
                select(ProjectEvent, User.name)
                .outerjoin(User, User.email == ProjectEvent.actor)
                .where(ProjectEvent.id > last_event_id)
                .order_by(ProjectEvent.id)
                .limit(self.settings.events_replay_limit + 1)
            )
            if project_id is not None:
                query = query.where(ProjectEvent.project_id == project_id)
            if types is not None:
                query = query.where(ProjectEvent.type.in_(list(types)))
            rows = (await session.execute(query)).all()
        if len(rows) > self.settings.events_replay_limit:
            return Replay(reset=True, latest_id=latest)
        return Replay(events=[_to_stream_event(row, name) for row, name in rows], latest_id=latest)

    async def current_presence(self, project_id: uuid.UUID) -> StreamEvent:
        async with self.database.sessionmaker() as session:
            users = await presence.list_active(session, project_id)
        return presence_event(project_id, users)

    # -- listener -------------------------------------------------------------------------------------------------

    def _on_event_notify(self, _connection: Any, _pid: int, _channel: str, payload: str) -> None:
        event_id_text, _, project_text = payload.partition(":")
        try:
            event_id = int(event_id_text)
            project_id = uuid.UUID(project_text)
        except ValueError:
            logger.warning("Ignoring a malformed event notification")
            return
        self._last_id = max(self._last_id, event_id)
        if self._has_interest(project_id):
            self._pending_ids.append(event_id)
            self._wake.set()

    def _on_presence_notify(self, _connection: Any, _pid: int, _channel: str, payload: str) -> None:
        try:
            project_id = uuid.UUID(payload)
        except ValueError:
            return
        if self._has_interest(project_id, presence_only=True):
            self._pending_presence.add(project_id)
            self._wake.set()

    def _has_interest(self, project_id: uuid.UUID, *, presence_only: bool = False) -> bool:
        for subscription in self._subscriptions:
            if subscription.project_id == project_id:
                return True
            if subscription.project_id is None and not presence_only:
                return True
        return False

    async def _connect(self) -> asyncpg.Connection:
        engine = self.database.engine
        _, kwargs = engine.dialect.create_connect_args(engine.url)
        return await asyncpg.connect(**kwargs, timeout=10)

    async def _listen_loop(self) -> None:
        backoff = 1.0
        while not self._stopping:
            connection: asyncpg.Connection | None = None
            try:
                connection = await self._connect()
                closed = asyncio.Event()
                connection.add_termination_listener(lambda _c, event=closed: event.set())
                await connection.add_listener(EVENTS_CHANNEL, self._on_event_notify)
                await connection.add_listener(PRESENCE_CHANNEL, self._on_presence_notify)
                self._connection = connection
                await self._catch_up(initial=not self._initialised)
                self._initialised = True
                self._ready.set()
                backoff = 1.0
                logger.info("Event listener connected")
                while not closed.is_set():
                    with contextlib.suppress(TimeoutError):
                        await asyncio.wait_for(closed.wait(), timeout=30)
                    if not closed.is_set():
                        await asyncio.wait_for(connection.execute("SELECT 1"), timeout=10)
                logger.warning("The event listener connection was closed")
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning("Event listener failed; reconnecting", extra={"error_type": type(exc).__name__})
            finally:
                self._ready.clear()
                self._connection = None
                if connection is not None:
                    with contextlib.suppress(Exception):
                        await asyncio.wait_for(connection.close(), timeout=5)
            if self._stopping:
                return
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30.0)

    async def _catch_up(self, *, initial: bool) -> None:
        """After (re)connecting, deliver what was published while no listener was attached."""
        async with self.database.sessionmaker() as session:
            if initial and self._last_id == 0:
                self._last_id = int(await session.scalar(select(func.max(ProjectEvent.id))) or 0)
                return
            rows = (
                await session.execute(
                    select(ProjectEvent, User.name)
                    .outerjoin(User, User.email == ProjectEvent.actor)
                    .where(ProjectEvent.id > self._last_id)
                    .order_by(ProjectEvent.id)
                    .limit(self.settings.events_replay_limit)
                )
            ).all()
        for row, name in rows:
            self._last_id = max(self._last_id, row.id)
            self._deliver(_to_stream_event(row, name))
        self._pending_presence.update(
            subscription.project_id for subscription in self._subscriptions if subscription.project_id is not None
        )
        if self._pending_presence:
            self._wake.set()

    # -- dispatch -------------------------------------------------------------------------------------------------

    async def _dispatch_loop(self) -> None:
        while True:
            await self._wake.wait()
            self._wake.clear()
            ids, self._pending_ids = self._pending_ids, []
            projects, self._pending_presence = self._pending_presence, set()
            for attempt in range(_LOAD_RETRIES):
                try:
                    if ids:
                        for event in await self._load(ids):
                            self._deliver(event)
                        ids = []
                    while projects:
                        project_id = next(iter(projects))
                        await self._deliver_presence(project_id)
                        projects.discard(project_id)
                    break
                except asyncio.CancelledError:
                    raise
                except Exception:
                    logger.exception("Loading events for delivery failed", extra={"attempt": attempt + 1})
                    await asyncio.sleep(0.5)

    async def _load(self, ids: list[int]) -> list[StreamEvent]:
        async with self.database.sessionmaker() as session:
            rows = (
                await session.execute(
                    select(ProjectEvent, User.name)
                    .outerjoin(User, User.email == ProjectEvent.actor)
                    .where(ProjectEvent.id.in_(ids))
                    .order_by(ProjectEvent.id)
                )
            ).all()
        return [_to_stream_event(row, name) for row, name in rows]

    async def _deliver_presence(self, project_id: uuid.UUID) -> None:
        if not self._has_interest(project_id, presence_only=True):
            return
        self._deliver(await self.current_presence(project_id))

    def _deliver(self, event: StreamEvent) -> None:
        for subscription in list(self._subscriptions):
            if subscription.accepts(event):
                subscription.offer(event)

    # -- maintenance ----------------------------------------------------------------------------------------------

    async def prune(self) -> int:
        """Drop events outside the resume window (older than the retention, or beyond the per-project maximum)."""
        settings = self.settings
        async with self.database.sessionmaker() as session:
            aged = await session.execute(
                delete(ProjectEvent).where(
                    ProjectEvent.created_at < func.now() - timedelta(seconds=settings.events_retention_seconds)
                )
            )
            ranked = select(
                ProjectEvent.id,
                func.row_number()
                .over(partition_by=ProjectEvent.project_id, order_by=ProjectEvent.id.desc())
                .label("rank"),
            ).subquery()
            excess = await session.execute(
                delete(ProjectEvent).where(
                    ProjectEvent.id.in_(select(ranked.c.id).where(ranked.c.rank > settings.events_max_per_project))
                )
            )
            await session.commit()
        return int(aged.rowcount or 0) + int(excess.rowcount or 0)  # pyright: ignore[reportAttributeAccessIssue]

    async def _prune_loop(self) -> None:
        while True:
            await asyncio.sleep(self.settings.events_prune_interval_seconds)
            try:
                removed = await self.prune()
                if removed:
                    logger.info("Pruned old events", extra={"removed": removed})
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Pruning events failed")

    async def sweep_presence(self) -> list[uuid.UUID]:
        async with self.database.sessionmaker() as session:
            projects = await presence.sweep_expired(session)
            await session.commit()
        return projects

    async def _sweep_loop(self) -> None:
        while True:
            await asyncio.sleep(self.settings.presence_sweep_seconds)
            try:
                await self.sweep_presence()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Sweeping presence failed")


def presence_event(project_id: uuid.UUID, users: list[presence.PresenceUser]) -> StreamEvent:
    return StreamEvent(
        type=PRESENCE,
        project_id=project_id,
        actor=SYSTEM_ACTOR,
        data={"users": [user.to_json() for user in users]},
        at=datetime.now(UTC),
    )


def _to_stream_event(row: ProjectEvent, actor_name: str | None) -> StreamEvent:
    return StreamEvent(
        id=row.id,
        type=row.type,
        project_id=row.project_id,
        actor=row.actor,
        actor_name=actor_name,
        data=row.data,
        at=row.created_at,
    )
