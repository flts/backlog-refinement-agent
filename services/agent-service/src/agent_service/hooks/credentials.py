"""Credentials agent-service presents to backlog-api's internal endpoints.

* :class:`ClientCredentialsProvider`: a Keycloak client-credentials access token (cached until shortly before expiry).
* :class:`StaticTokenProvider`: the development-only ``X-Internal-Token`` shared secret.
Tokens and secrets are never logged.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from typing import Protocol

import httpx

logger = logging.getLogger(__name__)

INTERNAL_TOKEN_HEADER = "X-Internal-Token"  # noqa: S105 (a header name)
EXPIRY_MARGIN_SECONDS = 30.0


class CredentialError(Exception):
    """The credential could not be obtained (identity provider unreachable or refusing the client)."""


class CredentialProvider(Protocol):
    async def headers(self) -> dict[str, str]: ...

    async def invalidate(self) -> None:
        """Drop any cached token so the next call obtains a fresh one."""


class StaticTokenProvider:
    def __init__(self, token: str) -> None:
        self._token = token

    async def headers(self) -> dict[str, str]:
        return {INTERNAL_TOKEN_HEADER: self._token}

    async def invalidate(self) -> None:
        return None


class ClientCredentialsProvider:
    def __init__(
        self,
        *,
        token_url: str,
        client_id: str,
        client_secret: str,
        client: httpx.AsyncClient,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._token_url = token_url
        self._client_id = client_id
        self._client_secret = client_secret
        self._client = client
        self._clock = clock
        self._token: str | None = None
        self._expires_at = 0.0
        self._lock = asyncio.Lock()

    async def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {await self._access_token()}"}

    async def invalidate(self) -> None:
        self._token = None

    async def _access_token(self) -> str:
        async with self._lock:
            if self._token is not None and self._clock() < self._expires_at:
                return self._token
            self._token = None
            token, lifetime = await self._fetch()
            self._token = token
            self._expires_at = self._clock() + max(lifetime - EXPIRY_MARGIN_SECONDS, 0.0)
            return token

    async def _fetch(self) -> tuple[str, float]:
        try:
            response = await self._client.post(
                self._token_url,
                data={
                    "grant_type": "client_credentials",
                    "client_id": self._client_id,
                    "client_secret": self._client_secret,
                },
                headers={"Accept": "application/json"},
            )
        except httpx.HTTPError as exc:
            raise CredentialError(f"token endpoint not reachable ({type(exc).__name__})") from exc
        if response.status_code != 200:
            raise CredentialError(f"token endpoint answered HTTP {response.status_code}")
        try:
            body = response.json()
            token = body["access_token"]
            lifetime = float(body.get("expires_in", 60))
        except (ValueError, KeyError, TypeError) as exc:
            raise CredentialError("token endpoint returned an unexpected body") from exc
        if not isinstance(token, str) or not token:
            raise CredentialError("token endpoint returned an unexpected body")
        return token, lifetime
