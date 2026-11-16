"""Per-run caller identity for code that cannot take the FastAPI request (tools, context providers).

The AG-UI ``authorization_scope_resolver`` binds the verified principal and the raw access token for the duration of the
request. The SSE generator, MAF tools and context providers run in that request's context, so they can read the values
back with :func:`current_token` / :func:`current_principal`. Never log or persist the token.
"""

from __future__ import annotations

from contextvars import ContextVar

from agent_service.auth.principal import Principal

_TOKEN: ContextVar[str | None] = ContextVar("agent_service_access_token", default=None)
_PRINCIPAL: ContextVar[Principal | None] = ContextVar("agent_service_principal", default=None)
_AGENT_ID: ContextVar[str | None] = ContextVar("agent_service_agent_id", default=None)


def bind_identity(principal: Principal, token: str | None) -> None:
    """Bind the caller for the current request context (called by the AG-UI scope resolver)."""
    _PRINCIPAL.set(principal)
    _TOKEN.set(token)


def current_token() -> str | None:
    """The caller's raw bearer access token (``None`` in dev auth mode or outside a request)."""
    return _TOKEN.get()


def current_principal() -> Principal | None:
    """The authenticated caller (normalized verified email), ``None`` outside an authenticated request."""
    return _PRINCIPAL.get()


def bind_agent_id(agent_id: str) -> None:
    _AGENT_ID.set(agent_id)


def current_agent_id() -> str | None:
    return _AGENT_ID.get()
