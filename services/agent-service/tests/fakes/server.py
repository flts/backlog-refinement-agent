"""Runs the scripted fake gateway on an ephemeral local port in a background thread (test-local)."""

from __future__ import annotations

import socket
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import uvicorn

from fakes.fake_gateway import app as gateway_app
from fakes.fake_mcp import app as mcp_app


@contextmanager
def running_fake_gateway() -> Iterator[str]:
    with _serve(gateway_app, "gateway") as url:
        yield url


@contextmanager
def running_fake_mcp() -> Iterator[str]:
    """The fake backlog MCP server; yields its base URL (the MCP endpoint is ``<url>/api/backlog/mcp``)."""
    with _serve(mcp_app, "MCP server") as url:
        yield url


@contextmanager
def _serve(app: Any, label: str) -> Iterator[str]:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not server.started:
        if time.monotonic() > deadline:
            raise RuntimeError(f"The fake {label} did not start.")
        time.sleep(0.02)
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        thread.join(timeout=5)
