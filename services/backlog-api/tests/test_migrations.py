from __future__ import annotations

from typing import Any

from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import text
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from backlog_api.db.connection_strings import to_async_database_url
from backlog_api.db.models import Base


def _diff(connection: Connection) -> list[Any]:
    context = MigrationContext.configure(connection, opts={"compare_type": True})
    return compare_metadata(context, Base.metadata)


async def test_models_match_migrations(database_url: str) -> None:
    """Every model change needs a migration (``alembic revision --autogenerate``)."""
    engine = create_async_engine(to_async_database_url(database_url), poolclass=NullPool)
    try:
        async with engine.connect() as connection:
            diff = await connection.run_sync(_diff)
            extensions = set((await connection.execute(text("SELECT extname FROM pg_extension"))).scalars().all())
    finally:
        await engine.dispose()
    assert diff == []
    assert {"vector", "citext"} <= extensions
