"""Domain events emitted after state changes (for the project SSE stream and internal hooks).

Routes publish events *after* the transaction commits via the :data:`EventPublisherDep` dependency. The app uses
:class:`backlog_api.event_bus.PostgresEventPublisher` (event log table + ``LISTEN/NOTIFY``, so every replica can serve
the SSE streams); :class:`InProcessEventPublisher` is the lightweight stand-in that tests can inject.

The canonical event types are listed below (:data:`PROJECT_EVENT_TYPES`, :data:`INTERNAL_EVENT_TYPES`).
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Annotated, Any, Protocol

from fastapi import Depends, Request

logger = logging.getLogger(__name__)

PROJECT_CREATED = "project.created"
PROJECT_UPDATED = "project.updated"
PROJECT_DELETED = "project.deleted"
MEMBER_ADDED = "member.added"
MEMBER_UPDATED = "member.updated"
MEMBER_REMOVED = "member.removed"
GUIDANCE_UPDATED = "guidance.updated"
ITEM_CREATED = "item.created"
ITEM_UPDATED = "item.updated"
ITEM_DELETED = "item.deleted"
RELATIONSHIP_CREATED = "relationship.created"
RELATIONSHIP_DELETED = "relationship.deleted"
SOURCE_CREATED = "source.created"
SOURCE_UPDATED = "source.updated"
SOURCE_DELETED = "source.deleted"

# Transient stream events: never stored in the event log and without an SSE id.
PRESENCE = "presence"
RESET = "reset"
CLOSED = "closed"

# Everything routes publish (stored in ``project_events``, delivered on the project stream with an SSE id).
PROJECT_EVENT_TYPES: tuple[str, ...] = (
    PROJECT_CREATED,
    PROJECT_UPDATED,
    PROJECT_DELETED,
    MEMBER_ADDED,
    MEMBER_UPDATED,
    MEMBER_REMOVED,
    GUIDANCE_UPDATED,
    ITEM_CREATED,
    ITEM_UPDATED,
    ITEM_DELETED,
    RELATIONSHIP_CREATED,
    RELATIONSHIP_DELETED,
    SOURCE_CREATED,
    SOURCE_UPDATED,
    SOURCE_DELETED,
)
# The cross-project stream for agent-service (thread cleanup).
INTERNAL_EVENT_TYPES: frozenset[str] = frozenset({PROJECT_DELETED, MEMBER_REMOVED, ITEM_DELETED})
# Types a project stream can carry: stored events plus the transient ones.
STREAM_EVENT_TYPES: tuple[str, ...] = (*PROJECT_EVENT_TYPES, PRESENCE, RESET, CLOSED)

EVENTS_CHANNEL = "backlog_events"
PRESENCE_CHANNEL = "backlog_presence"

# --- indexing ---
SOURCE_INDEXED = "source.indexed"


@dataclass(frozen=True, slots=True)
class DomainEvent:
    type: str
    project_id: uuid.UUID
    actor: str
    data: dict[str, Any] = field(default_factory=dict)
    id: uuid.UUID = field(default_factory=uuid.uuid4)
    at: datetime = field(default_factory=lambda: datetime.now(UTC))

    def to_json(self) -> dict[str, Any]:
        return {
            "id": str(self.id),
            "type": self.type,
            "projectId": str(self.project_id),
            "actor": self.actor,
            "at": self.at.isoformat(),
            "data": self.data,
        }


class EventPublisher(Protocol):
    async def publish(self, event: DomainEvent) -> None: ...


Subscriber = Callable[[DomainEvent], Awaitable[None]]


class InProcessEventPublisher:
    """Delivers events to in-process subscribers; subscriber errors are logged and never fail the request."""

    def __init__(self) -> None:
        self._subscribers: list[Subscriber] = []

    def subscribe(self, subscriber: Subscriber) -> Callable[[], None]:
        self._subscribers.append(subscriber)

        def unsubscribe() -> None:
            if subscriber in self._subscribers:
                self._subscribers.remove(subscriber)

        return unsubscribe

    async def publish(self, event: DomainEvent) -> None:
        for subscriber in list(self._subscribers):
            try:
                await subscriber(event)
            except Exception:
                logger.exception("Event subscriber failed", extra={"event_type": event.type})


def get_event_publisher(request: Request) -> EventPublisher:
    return request.app.state.events


EventPublisherDep = Annotated[EventPublisher, Depends(get_event_publisher)]
