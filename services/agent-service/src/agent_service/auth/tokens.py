"""Bearer JWT validation against the OIDC provider's JWKS (Keycloak in dev and in the cluster)."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Mapping, Sequence
from typing import Any, Protocol

import httpx
import jwt
from jwt import PyJWK, PyJWKClient, PyJWKSet
from starlette.concurrency import run_in_threadpool

logger = logging.getLogger(__name__)

ALLOWED_ALGORITHMS: tuple[str, ...] = ("RS256", "ES256")
JWKS_CACHE_SECONDS = 300


class InvalidTokenError(Exception):
    """The token is missing, malformed, expired, or not issued for this service. Maps to 401."""


class KeysUnavailableError(Exception):
    """The signing keys could not be fetched (identity provider unreachable). Maps to 503."""


class KeySource(Protocol):
    """Resolves the signing key for a ``kid``. Implementations cache keys and refresh on unknown ``kid``."""

    async def get_signing_key(self, kid: str) -> PyJWK: ...

    async def aclose(self) -> None: ...


class JwksKeySource:
    """Fetches keys from the JWKS endpoint, discovered from ``{issuer}/.well-known/openid-configuration`` unless
    ``jwks_url`` is given. Keys are cached by :class:`jwt.PyJWKClient` (JWK set cached for 5 minutes, refreshed once on
    an unknown ``kid``)."""

    def __init__(
        self,
        issuer: str,
        *,
        jwks_url: str | None = None,
        timeout: float = 5.0,
        http_transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._issuer = issuer.rstrip("/")
        self._jwks_url = jwks_url
        self._timeout = timeout
        self._http_transport = http_transport
        self._client: PyJWKClient | None = None
        self._lock = asyncio.Lock()

    async def _discover_jwks_url(self) -> str:
        url = f"{self._issuer}/.well-known/openid-configuration"
        try:
            async with httpx.AsyncClient(
                timeout=self._timeout, follow_redirects=False, transport=self._http_transport
            ) as client:
                response = await client.get(url)
                response.raise_for_status()
                document = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            # Not cached: the next request retries discovery.
            raise KeysUnavailableError("OIDC discovery failed.") from exc
        jwks_uri = document.get("jwks_uri") if isinstance(document, dict) else None
        if not isinstance(jwks_uri, str) or not jwks_uri:
            raise KeysUnavailableError("The OIDC discovery document has no jwks_uri.")
        discovered_issuer = str(document.get("issuer", "")).rstrip("/")
        if discovered_issuer != self._issuer:
            logger.warning(
                "OIDC discovery issuer differs from the configured issuer",
                extra={"configured_issuer": self._issuer, "discovered_issuer": discovered_issuer},
            )
        return jwks_uri

    async def _jwk_client(self) -> PyJWKClient:
        if self._client is not None:
            return self._client
        async with self._lock:
            if self._client is None:
                jwks_url = self._jwks_url or await self._discover_jwks_url()
                self._client = PyJWKClient(
                    jwks_url, cache_jwk_set=True, lifespan=JWKS_CACHE_SECONDS, timeout=self._timeout
                )
            return self._client

    async def get_signing_key(self, kid: str) -> PyJWK:
        client = await self._jwk_client()
        try:
            return await run_in_threadpool(client.get_signing_key, kid)
        except jwt.PyJWKClientConnectionError as exc:
            raise KeysUnavailableError("The JWKS endpoint is unreachable.") from exc
        except jwt.PyJWKClientError as exc:
            raise InvalidTokenError("Unknown signing key.") from exc
        except jwt.PyJWTError as exc:
            raise KeysUnavailableError("The JWKS document is invalid.") from exc

    async def aclose(self) -> None:
        return None


class StaticKeySource:
    """Keys from an in-memory JWKS document (tests and offline setups)."""

    def __init__(self, jwks: Mapping[str, Any]) -> None:
        self._keys = {key.key_id: key for key in PyJWKSet.from_dict(dict(jwks)).keys if key.key_id}

    async def get_signing_key(self, kid: str) -> PyJWK:
        key = self._keys.get(kid)
        if key is None:
            raise InvalidTokenError("Unknown signing key.")
        return key

    async def aclose(self) -> None:
        return None


class TokenVerifier:
    """Validates signature (RS256/ES256 only), ``iss``, ``aud`` (must contain the configured audience) and
    ``exp``/``nbf``/``iat`` with leeway. Returns the verified claims."""

    def __init__(
        self,
        *,
        issuer: str,
        audience: str,
        key_source: KeySource,
        leeway_seconds: int = 60,
        algorithms: Sequence[str] = ALLOWED_ALGORITHMS,
    ) -> None:
        self.issuer = issuer.rstrip("/")
        self.audience = audience
        self.leeway_seconds = leeway_seconds
        self.algorithms = [algorithm for algorithm in algorithms if algorithm in ALLOWED_ALGORITHMS]
        self._key_source = key_source

    async def verify(self, token: str) -> Mapping[str, Any]:
        try:
            header = jwt.get_unverified_header(token)
        except jwt.PyJWTError as exc:
            raise InvalidTokenError("Malformed token.") from exc
        algorithm = header.get("alg")
        if algorithm not in self.algorithms:
            raise InvalidTokenError("Unsupported token algorithm.")
        kid = header.get("kid")
        if not isinstance(kid, str) or not kid:
            raise InvalidTokenError("The token has no key id.")
        key = await self._key_source.get_signing_key(kid)
        try:
            claims = jwt.decode(
                token,
                key,
                algorithms=self.algorithms,
                audience=self.audience,
                issuer=self.issuer,
                leeway=self.leeway_seconds,
                options={"require": ["exp", "iss", "aud"]},
            )
        except jwt.PyJWTError as exc:
            raise InvalidTokenError(_reason(exc)) from exc
        return claims

    async def aclose(self) -> None:
        await self._key_source.aclose()


def _reason(exc: jwt.PyJWTError) -> str:
    if isinstance(exc, jwt.ExpiredSignatureError):
        return "The token has expired."
    if isinstance(exc, jwt.InvalidAudienceError):
        return "The token is not issued for this service."
    if isinstance(exc, jwt.InvalidIssuerError):
        return "The token issuer is not trusted."
    if isinstance(exc, jwt.ImmatureSignatureError):
        return "The token is not yet valid."
    if isinstance(exc, jwt.MissingRequiredClaimError):
        return "The token lacks a required claim."
    return "The token is invalid."
