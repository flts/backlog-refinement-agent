"""Shared fixtures.

* ``database_url`` (session): a migrated PostgreSQL database. Starts ``pgvector/pgvector:pg17`` with testcontainers, or
  uses ``AGENT_TEST_DATABASE_URL`` when set (the database must be disposable).
* ``tokens`` (session): :class:`TokenFactory` signing test access tokens; the app trusts its JWKS.
* ``gateway_url`` (session) / ``gateway`` (per test): the scripted fake LLM gateway and a control client for it.
* ``backlog`` (per test): a mocked backlog-api (``httpx.MockTransport``) recording the requests it receives.
* ``settings`` / ``app`` / ``client``: an app with its lifespan running and an ``httpx.AsyncClient`` against it.
"""

from __future__ import annotations

import asyncio
import os
import re
from collections.abc import AsyncIterator, Iterator
from contextlib import AsyncExitStack
from dataclasses import dataclass, field
from typing import Protocol

import httpx
import pytest
from asgi_lifespan import LifespanManager
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from agent_service.agents import build_placeholder_registry
from agent_service.auth.tokens import StaticKeySource
from agent_service.db.connection_strings import to_async_database_url
from agent_service.db.migrate import upgrade_database
from agent_service.main import RegistryFactory, create_app
from agent_service.settings import Settings
from agent_service.telemetry import Telemetry
from agent_service_testkit import TEST_AUDIENCE, TEST_ISSUER, TokenFactory
from fakes.server import running_fake_gateway, running_fake_mcp

POSTGRES_IMAGE = "pgvector/pgvector:pg17"
BACKLOG_URL = "http://backlog-api.test"


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
    external = os.environ.get("AGENT_TEST_DATABASE_URL")
    if external:
        asyncio.run(_migrate(external))
        yield external
        return
    from testcontainers.postgres import PostgresContainer

    with PostgresContainer(POSTGRES_IMAGE, username="agent", password="agent", dbname="agentdb") as container:
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


@pytest.fixture(scope="session")
def gateway_url() -> Iterator[str]:
    with running_fake_gateway() as url:
        yield url


@pytest.fixture
async def gateway(gateway_url: str) -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(base_url=gateway_url, timeout=10) as control:
        await control.post("/_reset")
        yield control
        await control.post("/_reset")


@pytest.fixture(scope="session")
def mcp_url() -> Iterator[str]:
    with running_fake_mcp() as url:
        yield url


@pytest.fixture
async def mcp(mcp_url: str) -> AsyncIterator[httpx.AsyncClient]:
    """Control client of the fake backlog MCP server (``/_config``, ``/_calls``, ``/_http_log``)."""
    async with httpx.AsyncClient(base_url=mcp_url, timeout=10) as control:
        await control.post("/_reset")
        yield control
        await control.post("/_reset")


@dataclass
class BacklogMock:
    """Fake backlog-api: every project / item exists unless listed in ``missing``; requests are recorded."""

    requests: list[httpx.Request] = field(default_factory=list)
    missing: set[str] = field(default_factory=set)
    status: int | None = None

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.status is not None:
            return httpx.Response(self.status)
        if request.url.path in self.missing or not re.fullmatch(
            r"/api/backlog/projects/[0-9a-f-]{36}(/items/[0-9a-f-]{36})?", request.url.path
        ):
            return httpx.Response(404, json={"title": "Not Found", "status": 404})
        return httpx.Response(200, json={"id": request.url.path.rsplit("/", 1)[-1]})

    @property
    def authorizations(self) -> list[str | None]:
        return [request.headers.get("authorization") for request in self.requests]


@pytest.fixture
def backlog() -> BacklogMock:
    return BacklogMock()


@pytest.fixture
def settings(database_url: str, gateway_url: str) -> Settings:
    return Settings(
        _env_file=None,  # pyright: ignore[reportCallIssue]
        env="test",
        database_url=database_url,
        auto_migrate=False,
        auth_mode="jwt",
        oidc_issuer=TEST_ISSUER,
        oidc_audience=TEST_AUDIENCE,
        backlog_api_url=BACKLOG_URL,
        llm_base_url=gateway_url,
        llm_model="refiner-default",
        max_body_bytes=64 * 1024,
        agui_max_body_bytes=256 * 1024,
        db_pool_size=2,
        db_max_overflow=4,
        llm_ready_cache_seconds=0,
    )


@pytest.fixture
async def app(
    settings: Settings, tokens: TokenFactory, database_url: str, backlog: BacklogMock
) -> AsyncIterator[FastAPI]:
    await truncate_all(database_url)
    application = create_app(
        settings,
        key_source=StaticKeySource(tokens.jwks),
        registry_factory=build_placeholder_registry,
        backlog_transport=httpx.MockTransport(backlog.handler),
        configure_logs=False,
    )
    async with LifespanManager(application, startup_timeout=30):
        yield application


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://agent-service.test", timeout=30) as http:
        yield http


@pytest.fixture
def sessionmaker(app: FastAPI) -> async_sessionmaker[AsyncSession]:
    return app.state.db.sessionmaker


@pytest.fixture
async def refiner_app(
    settings: Settings,
    tokens: TokenFactory,
    database_url: str,
    backlog: BacklogMock,
    mcp_url: str,
    mcp: httpx.AsyncClient,
) -> AsyncIterator[FastAPI]:
    await truncate_all(database_url)
    configured = settings.model_copy(update={"backlog_api_url": mcp_url})
    application = create_app(
        configured,
        key_source=StaticKeySource(tokens.jwks),
        backlog_transport=httpx.MockTransport(backlog.handler),
        configure_logs=False,
    )
    async with LifespanManager(application, startup_timeout=30):
        yield application


@pytest.fixture
async def rclient(refiner_app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=refiner_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://agent-service.test", timeout=30) as http:
        yield http


class AppFactory(Protocol):
    async def __call__(
        self,
        *,
        registry_factory: RegistryFactory = ...,
        telemetry: Telemetry | None = ...,
        **overrides: object,
    ) -> httpx.AsyncClient: ...


@pytest.fixture
async def app_factory(
    settings: Settings, tokens: TokenFactory, database_url: str, backlog: BacklogMock
) -> AsyncIterator[AppFactory]:
    """``await app_factory(registry_factory=..., telemetry=..., **settings_overrides)`` -> client of a running app."""
    await truncate_all(database_url)
    stack = AsyncExitStack()

    async def build(
        *,
        registry_factory: RegistryFactory = build_placeholder_registry,
        telemetry: Telemetry | None = None,
        **overrides: object,
    ) -> httpx.AsyncClient:
        application = create_app(
            settings.model_copy(update=overrides),
            key_source=StaticKeySource(tokens.jwks),
            registry_factory=registry_factory,
            backlog_transport=httpx.MockTransport(backlog.handler),
            configure_logs=False,
            telemetry=telemetry,
        )
        await stack.enter_async_context(LifespanManager(application, startup_timeout=30))
        return await stack.enter_async_context(
            httpx.AsyncClient(transport=httpx.ASGITransport(app=application), base_url="http://agent-service.test")
        )

    try:
        yield build
    finally:
        await stack.aclose()
