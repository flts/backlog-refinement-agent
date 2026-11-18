"""Thread metadata queries. Callers pass the normalized principal email; another user's thread is simply not found."""

from __future__ import annotations

import uuid

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from agent_service.db.models import Thread, ThreadSnapshot
from agent_service.identity import normalize_email, user_scope


async def get_owned_thread(session: AsyncSession, thread_id: str, owner_email: str) -> Thread | None:
    thread = await session.get(Thread, thread_id)
    if thread is None or normalize_email(thread.owner_email) != normalize_email(owner_email):
        return None
    return thread


async def purge_threads(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    item_id: uuid.UUID | None = None,
    owner_email: str | None = None,
) -> int:
    """Delete thread metadata (feedback cascades) and the snapshots (scope ``user:<email>``) of matching threads.

    Used by the event hooks (member removed, item deleted, project deleted). The caller owns the transaction and
    commits. Returns the number of deleted threads.
    """
    statement = select(Thread.id, Thread.owner_email).where(Thread.project_id == project_id)
    if item_id is not None:
        statement = statement.where(Thread.item_id == item_id)
    if owner_email is not None:
        statement = statement.where(Thread.owner_email == normalize_email(owner_email))
    rows = (await session.execute(statement)).all()
    if not rows:
        return 0
    for thread_id, email in rows:
        await session.execute(
            delete(ThreadSnapshot).where(
                ThreadSnapshot.scope == user_scope(email), ThreadSnapshot.thread_id == thread_id
            )
        )
    await session.execute(delete(Thread).where(Thread.id.in_([thread_id for thread_id, _ in rows])))
    return len(rows)
