"""Minimal Postgres job queue (``jobs`` table), claimed with ``FOR UPDATE SKIP LOCKED``.

Producers call :func:`enqueue` inside their transaction, so a job exists exactly when the change that caused it was
committed. Workers call :func:`claim` in a transaction and commit it to mark the jobs ``running`` (stale ``running``
jobs whose lease expired are claimed again), then :func:`complete` or :func:`fail` them. Handlers must be idempotent.
"""

from __future__ import annotations

from collections.abc import Collection
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backlog_api.db.models import Job

INDEX_SOURCE = "index_source"
INDEX_ITEM = "index_item"
REINDEX_PROJECT = "reindex_project"
DEFAULT_LEASE = timedelta(minutes=10)


async def enqueue(
    session: AsyncSession, kind: str, payload: dict[str, Any] | None = None, *, run_after: datetime | None = None
) -> Job:
    """Add a queued job to the current transaction (written when the caller commits)."""
    job = Job(kind=kind, payload=payload or {}, status="queued", attempts=0)
    if run_after is not None:
        job.run_after = run_after
    session.add(job)
    await session.flush()
    return job


async def claim(
    session: AsyncSession, kinds: Collection[str], limit: int = 1, *, lease: timedelta = DEFAULT_LEASE
) -> list[Job]:
    """Claim up to ``limit`` due jobs of the given kinds (oldest first) and mark them ``running``.

    Concurrent workers skip rows locked by each other. The caller must commit to publish the claim.
    """
    now = func.now()
    due = select(Job.id).where(
        Job.kind.in_(list(kinds)),
        or_(
            (Job.status == "queued") & (Job.run_after <= now),
            (Job.status == "running") & (Job.locked_at < now - lease),
        ),
    )
    ids = (await session.scalars(due.order_by(Job.id).limit(limit).with_for_update(skip_locked=True))).all()
    if not ids:
        return []
    rows = await session.scalars(
        update(Job)
        .where(Job.id.in_(ids))
        .values(status="running", locked_at=now, attempts=Job.attempts + 1)
        .returning(Job)
        .execution_options(populate_existing=True)
    )
    return sorted(rows.all(), key=lambda job: job.id)


async def complete(session: AsyncSession, job_id: int) -> None:
    await session.execute(update(Job).where(Job.id == job_id).values(status="done", locked_at=None, last_error=None))


async def fail(session: AsyncSession, job_id: int, error: str, *, retry_in: timedelta | None = None) -> None:
    """Record a failure; with ``retry_in`` the job is queued again after that delay, otherwise it is ``failed``."""
    values: dict[str, Any] = {"last_error": error[:2000], "locked_at": None}
    if retry_in is None:
        values["status"] = "failed"
    else:
        values.update(status="queued", run_after=func.now() + retry_in)
    await session.execute(update(Job).where(Job.id == job_id).values(**values))
