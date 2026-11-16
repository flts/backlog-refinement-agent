"""Client for an OpenAI-compatible ``POST {base}/v1/embeddings`` endpoint."""

from __future__ import annotations

import asyncio
import base64
import logging
import math
import struct
from collections.abc import Sequence
from typing import Any

import httpx

from backlog_api.settings import Settings

logger = logging.getLogger(__name__)

RETRYABLE_STATUS = frozenset({408, 409, 425, 429, 500, 502, 503, 504})


class EmbeddingError(Exception):
    """An embedding request failed. The message never contains request content or credentials."""

    def __init__(self, message: str, *, retryable: bool = True) -> None:
        super().__init__(message)
        self.retryable = retryable


class EmbeddingClient:
    def __init__(
        self,
        base_url: str,
        *,
        model: str,
        dimension: int,
        api_key: str | None = None,
        send_dimensions: bool = False,
        batch_size: int = 32,
        timeout: float = 30.0,
        max_retries: int = 2,
        backoff_seconds: float = 0.5,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.model = model
        self.dimension = dimension
        self._send_dimensions = send_dimensions
        self._batch_size = batch_size
        self._max_retries = max_retries
        self._backoff = backoff_seconds
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        self._http = httpx.AsyncClient(
            base_url=base_url.rstrip("/"), headers=headers, timeout=timeout, transport=transport
        )

    @classmethod
    def from_settings(
        cls, settings: Settings, *, transport: httpx.AsyncBaseTransport | None = None
    ) -> EmbeddingClient | None:
        """``None`` when no embedding endpoint is configured (indexing is then full-text only)."""
        base_url = settings.effective_embedding_base_url
        if base_url is None:
            return None
        return cls(
            base_url,
            model=settings.embedding_model,
            dimension=settings.embedding_dim,
            api_key=settings.effective_embedding_api_key,
            send_dimensions=settings.embedding_send_dimensions,
            batch_size=settings.embedding_batch_size,
            timeout=settings.embedding_timeout_seconds,
            max_retries=settings.embedding_max_retries,
            backoff_seconds=settings.embedding_retry_backoff_seconds,
            transport=transport,
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        """Embed ``texts`` (in order), batched; vectors are L2-normalised."""
        vectors: list[list[float]] = []
        for index in range(0, len(texts), self._batch_size):
            vectors.extend(await self._embed_batch(list(texts[index : index + self._batch_size])))
        return vectors

    async def embed_one(self, text: str) -> list[float]:
        return (await self.embed([text]))[0]

    async def _embed_batch(self, batch: list[str]) -> list[list[float]]:
        payload: dict[str, Any] = {"model": self.model, "input": batch}
        if self._send_dimensions:
            payload["dimensions"] = self.dimension
        last: EmbeddingError | None = None
        for attempt in range(self._max_retries + 1):
            if attempt:
                await asyncio.sleep(self._backoff * 2 ** (attempt - 1))
            try:
                response = await self._http.post("/v1/embeddings", json=payload)
            except httpx.HTTPError as error:
                last = EmbeddingError(f"Embedding request failed ({type(error).__name__}).")
                continue
            if response.status_code in RETRYABLE_STATUS:
                last = EmbeddingError(f"Embedding endpoint answered HTTP {response.status_code}.")
                continue
            if response.status_code >= 400:
                raise EmbeddingError(f"Embedding endpoint answered HTTP {response.status_code}.", retryable=False)
            return self._parse(response, len(batch))
        raise last or EmbeddingError("Embedding request failed.")

    def _parse(self, response: httpx.Response, expected: int) -> list[list[float]]:
        try:
            data = sorted(response.json()["data"], key=lambda entry: entry.get("index", 0))
            vectors = [_decode(entry["embedding"]) for entry in data]
        except (ValueError, KeyError, TypeError) as error:
            raise EmbeddingError("The embedding endpoint returned an unexpected response.") from error
        if len(vectors) != expected:
            raise EmbeddingError("The embedding endpoint returned an unexpected number of vectors.")
        for vector in vectors:
            if len(vector) != self.dimension:
                raise EmbeddingError(
                    f"The embedding endpoint returned {len(vector)}-dimensional vectors, expected {self.dimension} "
                    "(BACKLOG_EMBEDDING_DIM).",
                    retryable=False,
                )
        return [_normalize(vector) for vector in vectors]


def _decode(raw: Any) -> list[float]:
    if isinstance(raw, str):
        blob = base64.b64decode(raw)
        return list(struct.unpack(f"<{len(blob) // 4}f", blob))
    return [float(value) for value in raw]


def _normalize(vector: list[float]) -> list[float]:
    norm = math.sqrt(sum(value * value for value in vector))
    return [value / norm for value in vector] if norm else vector
