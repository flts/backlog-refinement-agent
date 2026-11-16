"""Domain events emitted after state changes (for the project SSE stream and internal hooks).

Routes publish events *after* the transaction commits via the :data:`EventPublisherDep` dependency. The default
:class:`InProcessEventPublisher` fans events out to in-process subscribers; the ``api-events`` work replaces or wraps it
with a ``LISTEN/NOTIFY`` publisher for cross-replica fan-out without changing callers.
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
