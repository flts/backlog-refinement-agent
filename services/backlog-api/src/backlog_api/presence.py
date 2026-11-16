"""Project presence: who is looking at (or editing) which item.

Rows live in the ``presence`` table (unlogged), so every replica sees the same state. A heartbeat refreshes the
row's expiry; expired rows are ignored by reads and removed by the sweeper
(:meth:`PostgresEventPublisher.sweep_presence`).
Any change is announced with ``NOTIFY backlog_presence '<project id>'`` in the same transaction; each replica then
loads the project's current list and pushes a ``presence`` event to its SSE subscribers.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from sqlalchemy import delete, func, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from backlog_api.db.models import Presence, User
from backlog_api.events import PRESENCE_CHANNEL


@dataclass(frozen=True, slots=True)
class PresenceUser:
    email: str
    name: str | None
    item_id: uuid.UUID | None
    state: str

    def to_json(self) -> dict[str, Any]:
        return {
            "email": self.email,
            "name": self.name,
            "itemId": str(self.item_id) if self.item_id else None,
            "state": self.state,
        }


async def notify_changed(session: AsyncSession, project_id: uuid.UUID) -> None:
    """Announce a presence change; delivered when the surrounding transaction commits."""
    await session.execute(
        text("SELECT pg_notify(:channel, :payload)"), {"channel": PRESENCE_CHANNEL, "payload": str(project_id)}
    )


async def list_active(session: AsyncSession, project_id: uuid.UUID) -> list[PresenceUser]:
    rows = await session.execute(
        select(Presence.email, User.name, Presence.item_id, Presence.state)
        .outerjoin(User, User.email == Presence.email)
        .where(Presence.project_id == project_id, Presence.expires_at > func.now())
        .order_by(Presence.email)
    )
    return [PresenceUser(email=email, name=name, item_id=item_id, state=state) for email, name, item_id, state in rows]


async def heartbeat(
    session: AsyncSession,
    project_id: uuid.UUID,
    email: str,
    *,
    item_id: uuid.UUID | None,
    state: str,
    ttl_seconds: float,
) -> bool:
    """Record or refresh the caller's presence; returns ``True`` when the visible presence changed (join, item or
    state change, or a lapsed entry coming back). The caller commits."""
    current = (
        await session.execute(
            select(Presence.item_id, Presence.state, Presence.expires_at > func.now())
            .where(Presence.project_id == project_id, Presence.email == email)
            .with_for_update()
        )
    ).first()
    changed = current is None or not current[2] or current[0] != item_id or current[1] != state
    expires_at = func.now() + timedelta(seconds=ttl_seconds)
    statement = insert(Presence).values(
        project_id=project_id, email=email, item_id=item_id, state=state, expires_at=expires_at
    )
    await session.execute(
        statement.on_conflict_do_update(
            index_elements=[Presence.project_id, Presence.email],
            set_={"item_id": item_id, "state": state, "expires_at": expires_at},
        )
    )
    if changed:
        await notify_changed(session, project_id)
    return changed


async def leave(session: AsyncSession, project_id: uuid.UUID, email: str) -> bool:
    """Remove the caller's presence; returns ``True`` when there was a live entry. The caller commits."""
    result = await session.execute(
        delete(Presence)
        .where(Presence.project_id == project_id, Presence.email == email)
        .returning(Presence.expires_at > func.now())
    )
    was_live = any(row[0] for row in result)
    if was_live:
        await notify_changed(session, project_id)
    return was_live


async def sweep_expired(session: AsyncSession) -> list[uuid.UUID]:
    """Delete expired entries and announce the affected projects. The caller commits."""
    rows = await session.execute(
        delete(Presence).where(Presence.expires_at <= func.now()).returning(Presence.project_id)
    )
    projects = sorted({project_id for (project_id,) in rows}, key=str)
    for project_id in projects:
        await notify_changed(session, project_id)
    return projects
