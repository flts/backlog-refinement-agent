"""Service-to-service authentication for ``/api/backlog/internal/*`` (used by agent-service).

Two credentials are accepted:

* a Keycloak **client-credentials** access token (a normal bearer token for audience ``backlog-api``) whose ``azp`` or
  ``client_id`` claim is listed in ``BACKLOG_INTERNAL_CLIENT_IDS``; no email claim is required, and user tokens
  (``azp`` = ``backlog-web`` ...) are refused with 403;
* a static shared secret in the ``X-Internal-Token`` header equal to ``BACKLOG_INTERNAL_TOKEN`` (development only; the
  setting is refused in production).
"""

from __future__ import annotations

import hmac
import logging
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, Request

from backlog_api.auth.dependencies import JwtAuthenticator, unauthorized
from backlog_api.auth.tokens import InvalidTokenError, KeysUnavailableError
from backlog_api.problems import ProblemError
from backlog_api.settings import Settings

logger = logging.getLogger(__name__)

INTERNAL_TOKEN_HEADER = "X-Internal-Token"  # noqa: S105 (a header name)


@dataclass(frozen=True, slots=True)
class ServiceCaller:
    client_id: str


def _bearer(request: Request) -> str | None:
    scheme, _, credentials = request.headers.get("authorization", "").partition(" ")
    return credentials.strip() if scheme.lower() == "bearer" and credentials.strip() else None


async def get_service_caller(request: Request) -> ServiceCaller:
    settings: Settings = request.app.state.settings
    static = settings.internal_token.get_secret_value() if settings.internal_token else None
    supplied = request.headers.get(INTERNAL_TOKEN_HEADER)
    if supplied is not None:
        if static and hmac.compare_digest(supplied.encode(), static.encode()):
            return ServiceCaller(client_id="static-token")
        raise ProblemError(403, "forbidden", detail="The internal token is not valid.")

    token = _bearer(request)
    if token is None:
        raise unauthorized("A service access token is required.", error=None)
    authenticator = request.app.state.authenticator
    if not isinstance(authenticator, JwtAuthenticator):
        raise ProblemError(403, "forbidden", detail="Service tokens are not available in this auth mode.")
    try:
        claims = await authenticator.verifier.verify(token)
    except InvalidTokenError as exc:
        raise unauthorized(str(exc)) from exc
    except KeysUnavailableError as exc:
        logger.error("Token signing keys are unavailable", extra={"reason": str(exc)})
        raise ProblemError(
            503, "auth-unavailable", detail="The identity provider is unavailable.", headers={"Retry-After": "5"}
        ) from exc
    client_id = next(
        (value for key in ("azp", "client_id") if isinstance(value := claims.get(key), str) and value), None
    )
    if client_id is None or client_id not in settings.internal_client_ids:
        raise ProblemError(403, "forbidden", detail="This credential may not use internal endpoints.")
    return ServiceCaller(client_id=client_id)


ServiceCallerDep = Annotated[ServiceCaller, Depends(get_service_caller)]
