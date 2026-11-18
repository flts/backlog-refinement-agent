"""Async engine and session management.

The engine and session factory live on ``app.state.db`` (a :class:`Database`), created in the app lifespan.
Route handlers use the :func:`get_session` dependency (alias :data:`SessionDep`): one session per request. Handlers
commit explicitly (``await session.commit()``) before returning, so the commit happens before the response is sent and
commit errors surface as error responses; anything left uncommitted is rolled back when the session closes.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy import text
from sqlalchemy.engine import URL
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine


class Database:
    def __init__(self, url: URL, *, pool_size: int = 10, max_overflow: int = 10) -> None:
        self.engine: AsyncEngine = create_async_engine(
            url, pool_size=pool_size, max_overflow=max_overflow, pool_pre_ping=True
        )
        self.sessionmaker: async_sessionmaker[AsyncSession] = async_sessionmaker(self.engine, expire_on_commit=False)

    async def ping(self) -> None:
        async with self.engine.connect() as connection:
            await connection.execute(text("SELECT 1"))

    async def dispose(self) -> None:
        await self.engine.dispose()


def get_database(request: Request) -> Database:
    database: Database | None = getattr(request.app.state, "db", None)
    if database is None:
        raise RuntimeError("The database is not initialised.")
    return database


async def get_session(request: Request) -> AsyncIterator[AsyncSession]:
    async with get_database(request).sessionmaker() as session:
        yield session


SessionDep = Annotated[AsyncSession, Depends(get_session)]
DatabaseDep = Annotated[Database, Depends(get_database)]
