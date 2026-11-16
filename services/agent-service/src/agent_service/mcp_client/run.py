"""The per-run, per-user MCP connection (spike pattern C).

:class:`McpProvider` (a MAF ``ContextProvider``) opens one MCP connection per configured server at the start of every
run, authenticated with the caller's own bearer token as a *static* header, and closes it when the run ends. Only the
server's ``allowed_tools`` are offered to the model. Tools listed under ``hidden_tools`` (the write tools) are still
loaded by the connection, so our own Python tools can call them with :func:`current_mcp` after the user approved.

Never use ``header_provider`` on a shared MCP tool: one tool instance would serve concurrent users. The connection
here is created per run and never shared between runs.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Sequence
from contextvars import ContextVar
from typing import Any

from agent_framework import ContextProvider, MCPStreamableHTTPTool
from agent_framework.exceptions import ToolExecutionException

from agent_service.auth.context import current_principal, current_token
from agent_service.mcp_client.config import McpServerConfig

logger = logging.getLogger(__name__)

BACKLOG_SERVER = "backlog"
DEV_USER_EMAIL_HEADER = "X-Dev-User-Email"


class McpToolError(Exception):
    """An MCP tool answered with ``isError``: ``{status, type, detail}`` of the contract (for example 404 not-found)."""

    def __init__(self, tool: str, status: int, type_: str, detail: str) -> None:
        super().__init__(f"{tool}: {status} {type_}: {detail}")
        self.tool = tool
        self.status = status
        self.type = type_
        self.detail = detail


def _parse_error(tool: str, message: str) -> McpToolError:
    try:
        payload = json.loads(message)
    except ValueError:
        payload = None
    if isinstance(payload, dict) and isinstance(payload.get("status"), int):
        return McpToolError(
            tool, payload["status"], str(payload.get("type") or "error"), str(payload.get("detail", ""))
        )
    return McpToolError(tool, 502, "mcp-error", message[:500])


class McpConnection:
    """One open connection to an MCP server for the duration of a run."""

    def __init__(self, config: McpServerConfig, tool: MCPStreamableHTTPTool) -> None:
        self.config = config
        self._tool = tool

    @property
    def name(self) -> str:
        return self.config.name

    @property
    def model_tools(self) -> list[Any]:
        """The ``allowed_tools`` as MAF function tools (what the model is offered)."""
        return list(self._tool.functions)

    async def call(self, tool: str, **arguments: Any) -> dict[str, Any]:
        """Call any tool of the server (also the hidden write tools) and return its JSON object result.

        Raises :class:`McpToolError` for tool errors. Arguments use the camelCase names of the contract.
        """
        try:
            contents = await self._tool.call_tool(tool, **{k: v for k, v in arguments.items() if v is not None})
        except ToolExecutionException as exc:
            raise _parse_error(tool, str(exc)) from exc
        text = (
            contents
            if isinstance(contents, str)
            else "\n".join(str(content.text) for content in contents if getattr(content, "text", None))
        )
        try:
            result = json.loads(text)
        except ValueError as exc:
            raise McpToolError(tool, 502, "mcp-invalid-result", "The MCP tool returned no JSON object.") from exc
        if not isinstance(result, dict):
            raise McpToolError(tool, 502, "mcp-invalid-result", "The MCP tool returned no JSON object.")
        return result

    async def aclose(self) -> None:
        try:
            await self._tool.close()
        except Exception:  # best effort: the connection may be closed from another task after a cancellation
            logger.warning("Could not close the MCP connection cleanly", extra={"server": self.name}, exc_info=True)


class RunMcpScope:
    """The MCP connections of the current run (closed exactly once, also when the run is cancelled)."""

    def __init__(self) -> None:
        self._connections: dict[str, McpConnection] = {}
        self.cache: dict[str, Any] = {}
        """Per-run memo for providers that share a result (for example the project guidance)."""

    def add(self, connection: McpConnection) -> None:
        self._connections[connection.name] = connection

    def get(self, name: str) -> McpConnection | None:
        return self._connections.get(name)

    def __bool__(self) -> bool:
        return bool(self._connections)

    async def aclose(self) -> None:
        connections, self._connections = list(self._connections.values()), {}
        for connection in connections:
            await connection.aclose()


_SCOPE: ContextVar[RunMcpScope | None] = ContextVar("agent_service_run_mcp", default=None)


def bind_run_scope(scope: RunMcpScope | None) -> None:
    _SCOPE.set(scope)


def current_run_scope() -> RunMcpScope | None:
    return _SCOPE.get()


def current_mcp(server: str = BACKLOG_SERVER) -> McpConnection:
    """The current run's connection to ``server`` (for agent tools, e.g. calling a hidden write tool after approval).

    Only valid while a run of an agent with that MCP server is active.
    """
    scope = _SCOPE.get()
    connection = scope.get(server) if scope else None
    if connection is None:
        raise RuntimeError(f"No MCP connection '{server}' is open for this run.")
    return connection


class McpProvider(ContextProvider):
    """Opens the per-run MCP connections (user token) and offers the ``allowed_tools`` to the model.

    Must be the first provider of an agent: the other providers use :func:`current_mcp` in ``before_run``.
    """

    def __init__(self, servers: Sequence[McpServerConfig], *, dev_headers: bool = False) -> None:
        super().__init__("mcp")
        self._servers = tuple(servers)
        self._dev_headers = dev_headers

    def _headers(self, config: McpServerConfig) -> dict[str, str]:
        if config.auth == "none":
            return {}
        token = current_token()
        if token:
            return {"Authorization": f"Bearer {token}"}
        principal = current_principal()
        if self._dev_headers and principal is not None:  # dev auth mode only: backlog-api trusts this header too
            return {DEV_USER_EMAIL_HEADER: principal.email}
        raise RuntimeError("No access token is available for the MCP connection.")

    async def before_run(self, *, agent: Any, session: Any, context: Any, state: Any) -> None:
        scope = current_run_scope()
        if scope is None:  # not started by the runner wrapper (for example in unit tests)
            scope = RunMcpScope()
            bind_run_scope(scope)
        for config in self._servers:
            tool = MCPStreamableHTTPTool(
                name=config.name,
                url=config.url,
                allowed_tools=list(config.allowed_tools),
                static_headers=self._headers(config),
                load_prompts=False,
                approval_mode="never_require",
                request_timeout=config.request_timeout_seconds,
            )
            await tool.connect()
            connection = McpConnection(config, tool)
            scope.add(connection)
            context.extend_tools(self.source_id, connection.model_tools)

    async def after_run(self, *, agent: Any, session: Any, context: Any, state: Any) -> None:
        scope = current_run_scope()
        if scope is not None:
            await scope.aclose()
