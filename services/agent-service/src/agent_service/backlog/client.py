"""Access to backlog-api with the caller's own bearer token (the agent never exceeds the user's rights).

``ensure_project_member`` / ``ensure_item`` are used for thread access checks; the MCP connection itself is created by
the MCP context provider (a later todo) with :func:`agent_service.auth.current_token`.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

import httpx

from agent_service.auth.context import current_principal, current_token
from agent_service.problems import ProblemError

logger = logging.getLogger(__name__)

BACKLOG_API_PREFIX = "/api/backlog"
DEV_USER_EMAIL_HEADER = "X-Dev-User-Email"


class BacklogClient:
    def __init__(
        self,
        base_url: str,
        *,
        timeout: float = 10.0,
        dev_headers: bool = False,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._dev_headers = dev_headers
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/"), timeout=timeout, transport=transport, follow_redirects=False
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    def _headers(self, token: str | None) -> dict[str, str]:
        token = token if token is not None else current_token()
        if token:
            return {"Authorization": f"Bearer {token}"}
        principal = current_principal()
        if self._dev_headers and principal is not None:  # dev auth mode only: backlog-api trusts this header too
            return {DEV_USER_EMAIL_HEADER: principal.email}
        raise ProblemError(401, "unauthorized", detail="No access token is available for backlog-api.")

    async def _get(self, path: str, token: str | None, what: str) -> dict[str, Any]:
        try:
            response = await self._client.get(f"{BACKLOG_API_PREFIX}{path}", headers=self._headers(token))
        except httpx.HTTPError as exc:
            logger.warning("backlog-api is not reachable", extra={"error_type": type(exc).__name__})
            raise _unavailable() from exc
        if response.status_code == 200:
            body = response.json()
            return body if isinstance(body, dict) else {}
        if response.status_code == 404:
            raise ProblemError(404, "not-found", detail=f"The {what} was not found or you have no access to it.")
        if response.status_code in (401, 403):
            raise ProblemError(response.status_code, "backlog-denied", detail="backlog-api denied the request.")
        logger.warning("Unexpected backlog-api response", extra={"status": response.status_code})
        raise _unavailable()

    async def ensure_project_member(self, project_id: uuid.UUID | str, *, token: str | None = None) -> dict[str, Any]:
        """The project (404 problem when it does not exist or the user is not a member)."""
        return await self._get(f"/projects/{project_id}", token, "project")

    async def ensure_item(
        self, project_id: uuid.UUID | str, item_id: uuid.UUID | str, *, token: str | None = None
    ) -> dict[str, Any]:
        """The item (404 problem when it does not exist in the project or the user is not a member)."""
        return await self._get(f"/projects/{project_id}/items/{item_id}", token, "item")


def _unavailable() -> ProblemError:
    return ProblemError(503, "backlog-unavailable", detail="backlog-api is unavailable.", headers={"Retry-After": "5"})
