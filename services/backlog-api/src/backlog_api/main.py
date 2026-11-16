"""FastAPI application factory. Run with ``uvicorn backlog_api.main:app``."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from backlog_skills import load_skills
from fastapi import FastAPI
from fastapi.openapi.utils import get_openapi
from fastapi.routing import APIRoute

from backlog_api import __version__
from backlog_api.api import backup as backup_api
from backlog_api.api import guidance, health, items, me, projects
from backlog_api.api import sources as sources_api
from backlog_api.auth.dependencies import Authenticator, DevHeaderAuthenticator, JwtAuthenticator
from backlog_api.auth.directory import UserDirectory
from backlog_api.auth.tokens import JwksKeySource, KeySource, TokenVerifier
from backlog_api.db.migrate import upgrade_database
from backlog_api.db.session import Database
from backlog_api.events import EventPublisher, InProcessEventPublisher
from backlog_api.middleware import (
    BACKUP_IMPORT_PATH,
    MULTIPART_OVERHEAD_BYTES,
    SOURCES_PATH,
    BodySizeLimitMiddleware,
    RequestContextMiddleware,
)
from backlog_api.observability import configure_logging
from backlog_api.problems import PROBLEM_CONTENT_TYPE, Problem, install_problem_handlers
from backlog_api.settings import API_PREFIX, Settings

logger = logging.getLogger(__name__)


def _build_authenticator(settings: Settings, key_source: KeySource | None) -> Authenticator:
    if settings.auth_mode == "dev":
        if settings.env != "development":  # also enforced by Settings validation
            raise RuntimeError("BACKLOG_AUTH_MODE=dev is only allowed when BACKLOG_ENV=development.")
        logger.warning("Dev auth mode: trusting the X-Dev-User-Email header. Never use this outside development.")
        return DevHeaderAuthenticator()
    issuer = settings.issuer
    if not issuer:
        raise RuntimeError("No OIDC issuer configured (BACKLOG_OIDC_ISSUER).")
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
    event_publisher: EventPublisher | None = None,
    configure_logs: bool = True,
) -> FastAPI:
    """Build the app. ``key_source`` and ``event_publisher`` can be injected (tests, later fan-out publishers)."""
    settings = settings or Settings()
    if configure_logs:
        configure_logging(settings.log_level)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        database_url = settings.require_runtime_config()
        database = Database(database_url, pool_size=settings.db_pool_size, max_overflow=settings.db_max_overflow)
        authenticator: Authenticator | None = None
        skills = load_skills(settings.skills_dir)
        skills.default_guidance()  # fail fast when a required skill, version or template is missing or invalid
        try:
            if settings.should_auto_migrate:
                logger.info("Applying database migrations")
                await upgrade_database(database.engine, settings.alembic_ini)
            authenticator = _build_authenticator(settings, key_source)
            app.state.db = database
            app.state.skills = skills
            app.state.authenticator = authenticator
            app.state.user_directory = UserDirectory(database.sessionmaker, settings.user_directory_refresh_seconds)
            logger.info("backlog-api started", extra={"auth_mode": settings.auth_mode, "env": settings.env})
            yield
        finally:
            if authenticator is not None:
                await authenticator.aclose()
            await database.dispose()

    app = FastAPI(
        title="Backlog API",
        version=__version__,
        description=(
            "Projects, members, backlog items and sources. Errors use RFC 9457 problem details "
            f"(`{PROBLEM_CONTENT_TYPE}`). Authenticate with a Keycloak access token (audience `backlog-api`)."
        ),
        lifespan=lifespan,
        generate_unique_id_function=_operation_id,
        openapi_url=f"{API_PREFIX}/openapi.json",
        docs_url=f"{API_PREFIX}/docs",
        redoc_url=None,
    )
    app.state.settings = settings
    app.state.events = event_publisher or InProcessEventPublisher()

    install_problem_handlers(app)
    # Starlette runs the last added middleware first: request context wraps the body limit.
    app.add_middleware(
        BodySizeLimitMiddleware,
        max_body_bytes=settings.max_body_bytes,
        route_limits=[
            ("POST", SOURCES_PATH, settings.source_max_bytes + MULTIPART_OVERHEAD_BYTES),
            ("POST", BACKUP_IMPORT_PATH, settings.backup_max_bytes),
        ],
    )
    app.add_middleware(RequestContextMiddleware)

    app.include_router(health.router, include_in_schema=False)
    app.include_router(health.router, prefix=API_PREFIX)
    app.include_router(me.router, prefix=API_PREFIX)
    app.include_router(projects.router, prefix=API_PREFIX)
    app.include_router(guidance.router, prefix=API_PREFIX)
    app.include_router(sources_api.router, prefix=API_PREFIX)
    app.include_router(items.router, prefix=API_PREFIX)
    app.include_router(backup_api.router, prefix=API_PREFIX)

    def openapi() -> dict[str, Any]:
        if app.openapi_schema is None:
            app.openapi_schema = _build_openapi(app)
        return app.openapi_schema

    app.openapi = openapi  # type: ignore[method-assign]
    return app


def _operation_id(route: APIRoute) -> str:
    # Stable, readable operation ids (route function names) for generated clients.
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
                if not code.startswith(("4", "5")):
                    continue
                response["content"] = problem_content
    for unused in ("HTTPValidationError", "ValidationError"):
        components.pop(unused, None)
    return schema


_app: FastAPI | None = None


def __getattr__(name: str) -> Any:
    # ``backlog_api.main:app`` for uvicorn, created on first access so importing this module has no side effects
    # (configuration is read and validated, and logging configured, only when the app is actually served).
    global _app
    if name == "app":
        if _app is None:
            _app = create_app()
        return _app
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
