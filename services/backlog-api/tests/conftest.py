"""Shared fixtures.

* ``database_url`` (session): a migrated PostgreSQL + pgvector database. Starts ``pgvector/pgvector:pg17`` with
  testcontainers, or uses ``BACKLOG_TEST_DATABASE_URL`` when set (the database must be disposable).
* ``tokens`` (session): :class:`TokenFactory` signing test access tokens; the app trusts its JWKS.
* ``settings`` / ``app`` / ``client``: an app with its lifespan running and an ``httpx.AsyncClient`` against it.
  All tables are truncated before each test that uses ``app``.
* ``published_events``: domain events published during the test.
* ``sessionmaker``: the app's async session factory for direct database assertions.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator, Iterator

import httpx
import pytest
from asgi_lifespan import LifespanManager
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from backlog_api.auth.tokens import StaticKeySource
from backlog_api.db.connection_strings import to_async_database_url
from backlog_api.db.migrate import upgrade_database
from backlog_api.events import DomainEvent, InProcessEventPublisher
from backlog_api.main import create_app
from backlog_api.settings import Settings
from backlog_api_testkit import TEST_AUDIENCE, TEST_ISSUER, TokenFactory

POSTGRES_IMAGE = "pgvector/pgvector:pg17"


@pytest.fixture(scope="session")
def tokens() -> TokenFactory:
    return TokenFactory()


async def _migrate(url: str) -> None:
    engine = create_async_engine(to_async_database_url(url), poolclass=NullPool)
    try:
        await upgrade_database(engine, Settings(_env_file=None).alembic_ini)  # pyright: ignore[reportCallIssue]
    finally:
        await engine.dispose()


@pytest.fixture(scope="session")
def database_url() -> Iterator[str]:
    external = os.environ.get("BACKLOG_TEST_DATABASE_URL")
    if external:
        asyncio.run(_migrate(external))
        yield external
        return
    from testcontainers.postgres import PostgresContainer

    with PostgresContainer(POSTGRES_IMAGE, username="backlog", password="backlog", dbname="backlogdb") as container:
        url = container.get_connection_url(driver="asyncpg")
        asyncio.run(_migrate(url))
        yield url


async def truncate_all(url: str) -> None:
    engine = create_async_engine(to_async_database_url(url), poolclass=NullPool)
    try:
        async with engine.begin() as connection:
            tables = (
                await connection.execute(
                    text(
                        "SELECT quote_ident(tablename) FROM pg_tables "
                        "WHERE schemaname = current_schema() AND tablename <> 'alembic_version'"
                    )
                )
            ).scalars()
            names = ", ".join(tables)
            if names:
                await connection.execute(text(f"TRUNCATE {names} RESTART IDENTITY CASCADE"))
    finally:
        await engine.dispose()


@pytest.fixture
def settings(database_url: str) -> Settings:
    return Settings(
        _env_file=None,  # pyright: ignore[reportCallIssue]
        env="test",
        database_url=database_url,
        auto_migrate=False,
        worker_enabled=False,
        auth_mode="jwt",
        oidc_issuer=TEST_ISSUER,
        oidc_audience=TEST_AUDIENCE,
        max_body_bytes=64 * 1024,
        db_pool_size=2,
        db_max_overflow=2,
    )


@pytest.fixture
def event_publisher() -> InProcessEventPublisher:
    return InProcessEventPublisher()


@pytest.fixture
def published_events(event_publisher: InProcessEventPublisher) -> list[DomainEvent]:
    received: list[DomainEvent] = []

    async def collect(event: DomainEvent) -> None:
        received.append(event)

    event_publisher.subscribe(collect)
    return received


@pytest.fixture
async def app(
    settings: Settings, tokens: TokenFactory, database_url: str, event_publisher: InProcessEventPublisher
) -> AsyncIterator[FastAPI]:
    await truncate_all(database_url)
    application = create_app(
        settings, key_source=StaticKeySource(tokens.jwks), event_publisher=event_publisher, configure_logs=False
    )
    async with LifespanManager(application, startup_timeout=30):
        yield application


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://backlog-api.test") as http:
        yield http


@pytest.fixture
def sessionmaker(app: FastAPI) -> async_sessionmaker[AsyncSession]:
    return app.state.db.sessionmaker
