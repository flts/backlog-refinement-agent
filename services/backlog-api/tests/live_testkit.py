"""Helpers for tests that run the app on a real socket (``httpx.ASGITransport`` buffers streaming responses)."""

from __future__ import annotations

import asyncio
import json
import socket
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

import httpx
import uvicorn
from fastapi import FastAPI

from backlog_api.auth.tokens import StaticKeySource
from backlog_api.main import create_app
from backlog_api.settings import Settings
from backlog_api_testkit import TokenFactory


@dataclass
class Sse:
    event: str
    id: int | None
    data: dict[str, Any]


class SseReader:
    """Reads SSE blocks (and counts keepalive comments) from a streaming httpx response."""

    def __init__(self, response: httpx.Response) -> None:
        self.response = response
        self._lines = response.aiter_lines()
        self.keepalives = 0
        self.ended = False

    async def next(self, wait: float = 5.0) -> Sse | None:
        """The next event, or ``None`` when the stream ended. Fails when none arrives within ``wait`` seconds."""
        async with asyncio.timeout(wait):
            return await self._next()

    async def _next(self) -> Sse | None:
        event, event_id, data = "message", None, ""
        while True:
            try:
                line = await self._lines.__anext__()
            except StopAsyncIteration:
                self.ended = True
                return None
            if line == "":
                if data:
                    return Sse(event, event_id, json.loads(data))
                continue
            if line.startswith(": keepalive"):
                self.keepalives += 1
            elif line.startswith("id:"):
                event_id = int(line[3:])
            elif line.startswith("event:"):
                event = line[6:].strip()
            elif line.startswith("data:"):
                data = line[5:].strip()

    async def until(self, event_type: str, wait: float = 5.0) -> Sse:
        while True:
            item = await self.next(wait)
            assert item is not None, f"stream ended before {event_type}"
            if item.event == event_type:
                return item


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


@asynccontextmanager
async def serve(app: FastAPI) -> AsyncIterator[str]:
    """Run ``app`` (lifespan included) with uvicorn on a free local port; yields its base URL."""
    port = free_port()
    server = uvicorn.Server(
        uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", lifespan="on", access_log=False)
    )
    task = asyncio.create_task(server.serve())
    try:
        for _ in range(300):
            if server.started:
                break
            await asyncio.sleep(0.05)
        assert server.started, "the test server did not start"
        yield f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        await asyncio.wait_for(task, 15)


@dataclass
class Replica:
    """One running backlog-api instance (its own app, event bus and database pool) on a real local socket."""

    app: FastAPI
    base: str
    http: httpx.AsyncClient

    @asynccontextmanager
    async def stream(
        self, path: str, headers: dict[str, str], params: dict[str, str] | None = None
    ) -> AsyncIterator[SseReader]:
        async with self.http.stream("GET", path, headers=headers, params=params) as response:
            assert response.status_code == 200, await response.aread()
            yield SseReader(response)


@asynccontextmanager
async def running_replica(settings: Settings, tokens: TokenFactory) -> AsyncIterator[Replica]:
    """Start another replica sharing the database of the other replicas started from ``settings``."""
    app = create_app(settings, key_source=StaticKeySource(tokens.jwks), configure_logs=False)
    async with serve(app) as base:
        await asyncio.wait_for(app.state.event_bus.wait_ready(), 10)
        async with httpx.AsyncClient(base_url=base, timeout=15) as http:
            yield Replica(app, base, http)
