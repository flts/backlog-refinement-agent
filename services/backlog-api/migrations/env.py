"""Alembic environment (async, asyncpg).

URL resolution: a ``connection`` passed via ``config.attributes`` (used by the app on startup and by tests) wins, then an
explicit ``sqlalchemy.url`` main option, then the service settings (``BACKLOG_DATABASE_URL`` /
``ConnectionStrings__backlogdb`` / ``BACKLOGDB_URI``).
"""

from __future__ import annotations

import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool
from sqlalchemy.engine import URL, Connection
from sqlalchemy.ext.asyncio import create_async_engine

from backlog_api.db.connection_strings import to_async_database_url
from backlog_api.db.models import Base
from backlog_api.settings import Settings

config = context.config

if config.config_file_name is not None and config.attributes.get("configure_logger", True):
    fileConfig(config.config_file_name, disable_existing_loggers=False)

target_metadata = Base.metadata


def _database_url() -> URL:
    explicit = config.get_main_option("sqlalchemy.url")
    if explicit:
        return to_async_database_url(explicit)
    url = Settings().async_database_url
    if url is None:
        raise RuntimeError("No database configured: set BACKLOG_DATABASE_URL or ConnectionStrings__backlogdb.")
    return url


def run_migrations_offline() -> None:
    context.configure(
        url=_database_url().render_as_string(hide_password=False),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection: Connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata, compare_type=True)
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations(url: URL) -> None:
    engine = create_async_engine(url, poolclass=pool.NullPool)
    try:
        async with engine.connect() as connection:
            await connection.run_sync(do_run_migrations)
    finally:
        await engine.dispose()


def run_migrations_online() -> None:
    connection: Connection | None = config.attributes.get("connection")
    if connection is not None:
        do_run_migrations(connection)
        return
    asyncio.run(run_async_migrations(_database_url()))


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
