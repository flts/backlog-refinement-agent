"""FastAPI application factory. Run with ``uvicorn agent_service.main:app``."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import Any

import httpx
from agent_framework_ag_ui import AGUIThreadSnapshotStore
from fastapi import FastAPI
from fastapi.openapi.utils import get_openapi
from fastapi.routing import APIRoute
from starlette.middleware.cors import CORSMiddleware

from agent_service import __version__
from agent_service.agents import AgentRegistry
from agent_service.agents.endpoint import mount_agent_endpoint
from agent_service.agents.loader import registry_factory as default_registry_factory
from agent_service.api import agents, health, threads
from agent_service.auth.dependencies import Authenticator, DevHeaderAuthenticator, JwtAuthenticator
from agent_service.auth.tokens import JwksKeySource, KeySource, TokenVerifier
from agent_service.backlog import BacklogClient
from agent_service.db.migrate import upgrade_database
from agent_service.db.session import Database
from agent_service.hooks import DisabledHookSubscriber, HookSubscriber, create_subscriber
from agent_service.llm import LlmReadiness
from agent_service.middleware import BodySizeLimitMiddleware, RequestContextMiddleware
from agent_service.observability import configure_logging
from agent_service.problems import PROBLEM_CONTENT_TYPE, Problem, install_problem_handlers
from agent_service.settings import AGENTS_PATH_PREFIX, API_PREFIX, Settings
from agent_service.threads.store import PgThreadSnapshotStore

logger = logging.getLogger(__name__)

RegistryFactory = Callable[[Settings, AGUIThreadSnapshotStore], AgentRegistry]


def _build_authenticator(settings: Settings, key_source: KeySource | None) -> Authenticator:
    if settings.auth_mode == "dev":
        if settings.env != "development":  # also enforced by Settings validation
            raise RuntimeError("AGENT_AUTH_MODE=dev is only allowed when AGENT_ENV=development.")
        logger.warning("Dev auth mode: trusting the X-Dev-User-Email header. Never use this outside development.")
        return DevHeaderAuthenticator()
    issuer = settings.issuer
    if not issuer:
        raise RuntimeError("No OIDC issuer configured (AGENT_OIDC_ISSUER).")
    source = key_source or JwksKeySource(
        issuer, jwks_url=settings.oidc_jwks_url, timeout=settings.oidc_http_timeout_seconds
    )
    verifier = TokenVerifier(
        issuer=issuer,
        audience=settings.oidc_audience,
        key_source=source,
        leeway_seconds=settings.oidc_leeway_seconds,
    )
    return JwtAuthenticator(verifier)


def create_app(
    settings: Settings | None = None,
    *,
    key_source: KeySource | None = None,
    registry_factory: RegistryFactory | None = None,
    backlog_transport: httpx.AsyncBaseTransport | None = None,
    llm_transport: httpx.AsyncBaseTransport | None = None,
    configure_logs: bool = True,
    hooks_transport: httpx.AsyncBaseTransport | None = None,
) -> FastAPI:
    """Build the app.

    ``hooks_transport`` carries the event-hook traffic (Keycloak token endpoint and backlog-api event stream).
    ``key_source`` (JWKS), ``registry_factory`` (builds the agents from the settings and the snapshot store; default:
    the agent loader, i.e. ``agents/*.agent.md`` + ``tools/tools.yaml``) and the HTTP transports of the backlog-api /
    LLM readiness clients can be injected (tests).
    """
    settings = settings or Settings()
    if configure_logs:
        configure_logging(settings.log_level)
    # The snapshot store resolves the session factory lazily: the database is created in the lifespan.
    state: dict[str, Database] = {}
    snapshot_store = PgThreadSnapshotStore(lambda: state["db"].sessionmaker)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        database_url = settings.require_runtime_config()
        database = Database(database_url, pool_size=settings.db_pool_size, max_overflow=settings.db_max_overflow)
        authenticator: Authenticator | None = None
        backlog: BacklogClient | None = None
        hooks: HookSubscriber | DisabledHookSubscriber | None = None
        try:
            if settings.should_auto_migrate:
                logger.info("Applying database migrations")
                await upgrade_database(database.engine, settings.alembic_ini)
            authenticator = _build_authenticator(settings, key_source)
            assert settings.backlog_api_url
            backlog = BacklogClient(
                settings.backlog_api_url,
                timeout=settings.backlog_http_timeout_seconds,
                dev_headers=settings.auth_mode == "dev",
                transport=backlog_transport,
            )
            state["db"] = database
            app.state.db = database
            app.state.authenticator = authenticator
            app.state.backlog = backlog
            app.state.llm_readiness = LlmReadiness(settings, transport=llm_transport)
            hooks = create_subscriber(settings, database.sessionmaker, transport=hooks_transport)
            app.state.hooks = hooks
            await hooks.start()
            logger.info("agent-service started", extra={"auth_mode": settings.auth_mode, "env": settings.env})
            yield
        finally:
            if hooks is not None:
                await hooks.stop()
            if backlog is not None:
                await backlog.aclose()
            if authenticator is not None:
                await authenticator.aclose()
            await database.dispose()
            state.pop("db", None)

    app = FastAPI(
        title="Agent Service",
        version=__version__,
        description=(
            "AG-UI agent endpoint (Microsoft Agent Framework), private threads and feedback. Errors use RFC 9457 "
            f"problem details (`{PROBLEM_CONTENT_TYPE}`). Authenticate with a Keycloak access token "
            "(audience `agent-service`)."
        ),
        lifespan=lifespan,
        generate_unique_id_function=_operation_id,
        openapi_url=f"{API_PREFIX}/openapi.json",
        docs_url=f"{API_PREFIX}/docs",
        redoc_url=None,
    )
    app.state.settings = settings
    app.state.snapshot_store = snapshot_store
    factory = registry_factory or default_registry_factory
    app.state.agents = factory(settings, snapshot_store) if settings.llm_base_url else AgentRegistry()

    install_problem_handlers(app)
    # Starlette runs the last added middleware first: request context wraps CORS and the body limit.
    app.add_middleware(
        BodySizeLimitMiddleware,
        max_body_bytes=settings.max_body_bytes,
        overrides={AGENTS_PATH_PREFIX: settings.agui_max_body_bytes},
    )
    if settings.cors_allow_origins:  # MAF's allow_origins is a no-op, so CORS is ours; default: same-origin only
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_allow_origins,
            allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
            allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
            expose_headers=["X-Request-ID", "Location"],
            max_age=600,
        )
    app.add_middleware(RequestContextMiddleware)

    app.include_router(health.router, include_in_schema=False)
    app.include_router(health.router, prefix=API_PREFIX)
    app.include_router(threads.router, prefix=API_PREFIX)
    app.include_router(agents.router, prefix=API_PREFIX)
    mount_agent_endpoint(app, app.state.agents, snapshot_store=snapshot_store, settings=settings)

    def openapi() -> dict[str, Any]:
        if app.openapi_schema is None:
            app.openapi_schema = _build_openapi(app)
        return app.openapi_schema

    app.openapi = openapi  # type: ignore[method-assign]
    return app


def _operation_id(route: APIRoute) -> str:
    return route.name


def _build_openapi(app: FastAPI) -> dict[str, Any]:
    schema = get_openapi(
        title=app.title,
        version=app.version,
        description=app.description,
        routes=app.routes,
        servers=[{"url": "/"}],
    )
    components = schema.setdefault("components", {}).setdefault("schemas", {})
    components["Problem"] = Problem.model_json_schema(ref_template="#/components/schemas/{model}")
    problem_content = {PROBLEM_CONTENT_TYPE: {"schema": {"$ref": "#/components/schemas/Problem"}}}
    for path_item in schema.get("paths", {}).values():
        for operation in path_item.values():
            responses = operation.get("responses", {}) if isinstance(operation, dict) else {}
            for code, response in responses.items():
                if code.startswith(("4", "5")):
                    response["content"] = problem_content
    for unused in ("HTTPValidationError", "ValidationError"):
        components.pop(unused, None)
    return schema


_app: FastAPI | None = None


def __getattr__(name: str) -> Any:
    # ``agent_service.main:app`` for uvicorn, created on first access so importing this module has no side effects.
    global _app
    if name == "app":
        if _app is None:
            _app = create_app()
        return _app
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
