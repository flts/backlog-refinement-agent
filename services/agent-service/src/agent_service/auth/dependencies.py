"""Request authentication.

``get_principal`` (alias :data:`PrincipalDep`) is the FastAPI dependency every protected route uses. It
authenticates the request with the configured :class:`Authenticator` (``app.state.authenticator``) and stores the
principal and the raw access token on ``request.state`` (``principal`` / ``access_token``; never log the token).
Only the AG-UI scope resolver binds them to context variables (:mod:`agent_service.auth.context`).
"""

from __future__ import annotations

import logging
from typing import Annotated, Protocol

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from agent_service.auth.principal import Principal, principal_from_claims
from agent_service.auth.tokens import InvalidTokenError, KeysUnavailableError, TokenVerifier
from agent_service.identity import is_valid_email, normalize_email
from agent_service.problems import ProblemError

logger = logging.getLogger(__name__)

DEV_USER_EMAIL_HEADER = "X-Dev-User-Email"
DEV_USER_NAME_HEADER = "X-Dev-User-Name"
REALM = "agent-service"

bearer_scheme = HTTPBearer(auto_error=False, description="Keycloak access token (audience agent-service).")


def unauthorized(detail: str, *, error: str | None = "invalid_token") -> ProblemError:
    challenge = f'Bearer realm="{REALM}"'
    if error:
        challenge += f', error="{error}"'
    return ProblemError(401, "unauthorized", detail=detail, headers={"WWW-Authenticate": challenge})


class Authenticator(Protocol):
    async def authenticate(self, request: Request, token: str | None) -> Principal: ...

    async def aclose(self) -> None: ...


class JwtAuthenticator:
    """Validates the bearer access token and derives the principal from its verified email claim."""

    def __init__(self, verifier: TokenVerifier) -> None:
        self.verifier = verifier

    async def authenticate(self, request: Request, token: str | None) -> Principal:
        if not token:
            raise unauthorized("A bearer access token is required.", error=None)
        try:
            claims = await self.verifier.verify(token)
        except InvalidTokenError as exc:
            raise unauthorized(str(exc)) from exc
        except KeysUnavailableError as exc:
            logger.error("Token signing keys are unavailable", extra={"reason": str(exc)})
            raise ProblemError(
                503, "auth-unavailable", detail="The identity provider is unavailable.", headers={"Retry-After": "5"}
            ) from exc
        return principal_from_claims(claims)

    async def aclose(self) -> None:
        await self.verifier.aclose()


class DevHeaderAuthenticator:
    """Development only (``AGENT_AUTH_MODE=dev`` with ``AGENT_ENV=development``): trusts ``X-Dev-User-Email``."""

    async def authenticate(self, request: Request, token: str | None) -> Principal:
        raw_email = request.headers.get(DEV_USER_EMAIL_HEADER, "")
        email = normalize_email(raw_email)
        if not email:
            raise unauthorized(f"Dev auth mode: send the {DEV_USER_EMAIL_HEADER} header.", error=None)
        if not is_valid_email(email):
            raise unauthorized(f"Dev auth mode: {DEV_USER_EMAIL_HEADER} is not a valid email address.")
        name = request.headers.get(DEV_USER_NAME_HEADER, "").strip() or None
        return Principal(email=email, sub=f"dev:{email}", name=name)

    async def aclose(self) -> None:
        return None


async def authenticate_request(request: Request, token: str | None = None) -> Principal:
    """Authenticate ``request`` (bearer token from the ``Authorization`` header unless ``token`` is given)."""
    cached: Principal | None = getattr(request.state, "principal", None)
    if cached is not None:
        return cached
    if token is None:
        token = _bearer_token(request)
    authenticator: Authenticator = request.app.state.authenticator
    principal = await authenticator.authenticate(request, token)
    request.state.principal = principal
    request.state.access_token = token
    return principal


def _bearer_token(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    scheme, _, credentials = header.partition(" ")
    if scheme.lower() != "bearer" or not credentials.strip():
        return None
    return credentials.strip()


async def get_principal(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
) -> Principal:
    return await authenticate_request(request, credentials.credentials if credentials else None)


async def get_access_token(request: Request, principal: Annotated[Principal, Depends(get_principal)]) -> str | None:
    """The raw bearer token of the authenticated request (``None`` in dev auth mode)."""
    return getattr(request.state, "access_token", None)


PrincipalDep = Annotated[Principal, Depends(get_principal)]
AccessTokenDep = Annotated[str | None, Depends(get_access_token)]
