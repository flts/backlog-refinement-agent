"""Producer side of indexing: enqueue (debounced, de-duplicated) item embedding jobs.

Kept free of heavy imports so the item domain logic can call :func:`enqueue_item_indexing` inside its transaction.
The jobs are processed by :mod:`backlog_api.worker`.
"""

from __future__ import annotations

import hashlib
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backlog_api import jobs
from backlog_api.db.models import Item, Job

DEFAULT_ITEM_DEBOUNCE = timedelta(seconds=10)
_item_debounce = DEFAULT_ITEM_DEBOUNCE


def configure_item_debounce(seconds: float) -> None:
    """Set the process-wide delay before a changed item is embedded (from ``BACKLOG_ITEM_INDEX_DEBOUNCE_SECONDS``)."""
    global _item_debounce
    _item_debounce = timedelta(seconds=max(seconds, 0))


def item_embedding_stamp(item: Item) -> str:
    """Identifies the embedded content: the title and the document (by its hash)."""
    return hashlib.sha256(f"{item.title}\n{item.document_hash}".encode()).hexdigest()


async def enqueue_item_indexing(
    session: AsyncSession,
    item_id: uuid.UUID,
    project_id: uuid.UUID,
    *,
    delay: timedelta | None = None,
    force: bool = False,
) -> bool:
    """Queue an ``index_item`` job ``delay`` (default: the debounce) from now unless one is already queued.

    A queued job picks up the latest content when it runs, so edits within the delay are coalesced. A *running* job
    does not suppress a new one (it may have read older content). Returns whether a job was created.
    """
    existing = await session.scalar(
        select(Job.id)
        .where(Job.kind == jobs.INDEX_ITEM, Job.status == "queued", Job.payload["itemId"].astext == str(item_id))
        .limit(1)
    )
    if existing is not None:
        return False
    run_after = datetime.now(UTC) + (_item_debounce if delay is None else delay)
    payload: dict[str, object] = {"itemId": str(item_id), "projectId": str(project_id)}
    if force:
        payload["force"] = True
    await jobs.enqueue(session, jobs.INDEX_ITEM, payload, run_after=run_after)
    return True


async def enqueue_source_indexing(
    session: AsyncSession, source_id: uuid.UUID, project_id: uuid.UUID, reason: str
) -> bool:
    """Queue an ``index_source`` job unless one is already waiting (it will read the latest source anyway)."""
    existing = await session.scalar(
        select(Job.id)
        .where(Job.kind == jobs.INDEX_SOURCE, Job.status == "queued", Job.payload["sourceId"].astext == str(source_id))
        .limit(1)
    )
    if existing is not None:
        return False
    await jobs.enqueue(
        session, jobs.INDEX_SOURCE, {"sourceId": str(source_id), "projectId": str(project_id), "reason": reason}
    )
    return True
