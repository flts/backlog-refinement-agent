"""LLM gateway readiness: ``GET {base}/v1/models`` with a short timeout, cached for a few seconds."""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Literal

import httpx

from agent_service.llm.client import api_key_value, normalize_base_url
from agent_service.settings import Settings

logger = logging.getLogger(__name__)

LlmStatus = Literal["ok", "unavailable"]


class LlmReadiness:
    def __init__(self, settings: Settings, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._url = f"{normalize_base_url(settings.llm_base_url)}/models" if settings.llm_base_url else None
        self._headers = {"Authorization": f"Bearer {api_key_value(settings)}"}
        self._timeout = settings.llm_ready_timeout_seconds
        self._cache_seconds = settings.llm_ready_cache_seconds
        self._transport = transport
        self._lock = asyncio.Lock()
        self._checked_at: float | None = None
        self._status: LlmStatus = "unavailable"

    async def check(self) -> LlmStatus:
        async with self._lock:
            now = time.monotonic()
            if self._checked_at is not None and now - self._checked_at < self._cache_seconds:
                return self._status
            self._status = await self._probe()
            self._checked_at = time.monotonic()
            return self._status

    async def _probe(self) -> LlmStatus:
        if self._url is None:
            return "unavailable"
        try:
            async with httpx.AsyncClient(timeout=self._timeout, transport=self._transport) as client:
                response = await client.get(self._url, headers=self._headers)
        except httpx.HTTPError as exc:
            logger.warning("LLM gateway is not reachable", extra={"error_type": type(exc).__name__})
            return "unavailable"
        if response.status_code >= 400:
            logger.warning("LLM gateway readiness probe failed", extra={"status": response.status_code})
            return "unavailable"
        return "ok"
