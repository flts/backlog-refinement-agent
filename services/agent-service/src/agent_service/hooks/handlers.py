"""Event handlers: backlog-api domain events -> purge of the matching private threads."""

from __future__ import annotations

import logging
import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from agent_service.threads.repository import purge_threads

logger = logging.getLogger(__name__)

PROJECT_DELETED = "project.deleted"
MEMBER_REMOVED = "member.removed"
ITEM_DELETED = "item.deleted"
HANDLED_TYPES = (PROJECT_DELETED, MEMBER_REMOVED, ITEM_DELETED)


class InvalidEventError(ValueError):
    """The event payload is not usable (it is skipped, not retried)."""


def _uuid(value: object, what: str) -> uuid.UUID:
    try:
        return uuid.UUID(str(value))
    except ValueError as exc:
        raise InvalidEventError(f"invalid {what}") from exc


async def apply_event(session: AsyncSession, event_type: str, payload: dict[str, Any]) -> int:
    """Purge the private threads affected by one event. The caller owns the transaction. Returns deleted threads.

    Purging is idempotent, so replays after a reconnect or a ``reset`` are harmless.
    """
    if event_type not in HANDLED_TYPES:
        return 0
    project_id = _uuid(payload.get("projectId"), "projectId")
    data = payload.get("data")
    data = data if isinstance(data, dict) else {}
    if event_type == PROJECT_DELETED:
        return await purge_threads(session, project_id=project_id)
    if event_type == MEMBER_REMOVED:
        email = data.get("email")
        if not isinstance(email, str) or not email.strip():
            raise InvalidEventError("member.removed without an email")
        return await purge_threads(session, project_id=project_id, owner_email=email)
    return await purge_threads(session, project_id=project_id, item_id=_uuid(data.get("id"), "item id"))
