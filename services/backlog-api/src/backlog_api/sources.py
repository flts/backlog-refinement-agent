"""Source domain helpers shared by the REST routes (and, later, the indexing worker and MCP tools)."""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backlog_api import jobs
from backlog_api.db.models import Source
from backlog_api.problems import ProblemError

SOURCE_CREATED = "source.created"
SOURCE_UPDATED = "source.updated"
SOURCE_DELETED = "source.deleted"

AUDIT_SOURCE_CREATED = "source.created"
AUDIT_SOURCE_UPDATED = "source.updated"
AUDIT_SOURCE_DELETED = "source.deleted"

MAX_SOURCE_NAME_LENGTH = 200


@dataclass(frozen=True, slots=True)
class PinnedBudget:
    used: int
    limit: int


async def pinned_chars(session: AsyncSession, project_id: uuid.UUID, *, exclude: uuid.UUID | None = None) -> int:
    query = select(func.coalesce(func.sum(Source.char_count), 0)).where(
        Source.project_id == project_id, Source.mode == "pinned"
    )
    if exclude is not None:
        query = query.where(Source.id != exclude)
    return int(await session.scalar(query) or 0)


async def ensure_pinned_budget(
    session: AsyncSession, project_id: uuid.UUID, *, required: int, limit: int, exclude: uuid.UUID | None = None
) -> None:
    """Pinned sources go into the model context in full, so their total size per project is capped (422 otherwise)."""
    used = await pinned_chars(session, project_id, exclude=exclude)
    if used + required > limit:
        raise ProblemError(
            422,
            "pinned-budget-exceeded",
            detail=(
                f"Pinning this source needs {required} characters, but only {max(limit - used, 0)} of the "
                f"{limit}-character pinned budget are left. Unpin another source or use searchable mode."
            ),
            used=used,
            limit=limit,
            required=required,
        )


async def enqueue_indexing(session: AsyncSession, source: Source, reason: str) -> None:
    await jobs.enqueue(
        session,
        jobs.INDEX_SOURCE,
        {"sourceId": str(source.id), "projectId": str(source.project_id), "reason": reason},
    )
