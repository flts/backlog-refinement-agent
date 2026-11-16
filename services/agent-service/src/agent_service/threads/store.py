"""PostgreSQL implementation of the MAF ``AGUIThreadSnapshotStore`` protocol (table ``thread_snapshots``).

MAF logs and swallows exceptions raised by :meth:`save`, so failures are also counted (``save_failures``) and logged
here with IDs only; alert on the ``thread snapshot save failed`` message.
"""

from __future__ import annotations

import logging
from collections.abc import Callable

from agent_framework_ag_ui import AGUIThreadSnapshot
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from agent_service.db.models import ThreadSnapshot

logger = logging.getLogger(__name__)

SessionMakerProvider = Callable[[], async_sessionmaker[AsyncSession]]


class PgThreadSnapshotStore:
    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession] | SessionMakerProvider) -> None:
        # The provider form lets the store exist before the database is created in the app lifespan.
        self._provider: SessionMakerProvider = (
            sessionmaker if not isinstance(sessionmaker, async_sessionmaker) else (lambda: sessionmaker)
        )
        self.save_failures = 0

    async def save(self, *, scope: str, thread_id: str, snapshot: AGUIThreadSnapshot) -> None:
        values = {
            "messages": snapshot.messages,
            "state": snapshot.state,
            "interrupt": snapshot.interrupt,
            "session_state": snapshot.session_state,
        }
        statement = insert(ThreadSnapshot).values(scope=scope, thread_id=thread_id, **values)
        statement = statement.on_conflict_do_update(
            index_elements=[ThreadSnapshot.scope, ThreadSnapshot.thread_id],
            set_={**values, "updated_at": func.now()},
        )
        try:
            async with self._provider()() as session:
                await session.execute(statement)
                await session.commit()
        except Exception as exc:
            self.save_failures += 1
            logger.error(
                "thread snapshot save failed",
                extra={"thread_id": thread_id, "error_type": type(exc).__name__, "save_failures": self.save_failures},
            )
            raise

    async def get(self, *, scope: str, thread_id: str) -> AGUIThreadSnapshot | None:
        async with self._provider()() as session:
            row = await session.get(ThreadSnapshot, (scope, thread_id))
            if row is None:
                return None
            return AGUIThreadSnapshot(
                messages=list(row.messages or []),
                state=row.state,
                interrupt=row.interrupt,
                session_state=row.session_state,
            )

    async def delete(self, *, scope: str, thread_id: str) -> bool:
        async with self._provider()() as session:
            result = await session.execute(
                delete(ThreadSnapshot).where(ThreadSnapshot.scope == scope, ThreadSnapshot.thread_id == thread_id)
            )
            await session.commit()
            return (result.rowcount or 0) > 0  # pyright: ignore[reportAttributeAccessIssue]

    async def clear(self, *, scope: str | None = None) -> None:
        statement = delete(ThreadSnapshot)
        if scope is not None:
            statement = statement.where(ThreadSnapshot.scope == scope)
        async with self._provider()() as session:
            await session.execute(statement)
            await session.commit()

    async def count(self, *, scope: str | None = None) -> int:
        statement = select(func.count()).select_from(ThreadSnapshot)
        if scope is not None:
            statement = statement.where(ThreadSnapshot.scope == scope)
        async with self._provider()() as session:
            return int((await session.execute(statement)).scalar_one())
