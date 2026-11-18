"""Per-run services for agent tools (the thread snapshot store and the database), bound by the AG-UI dispatcher.

Tool factories run once when the agent is built, so a tool reads these at call time with :func:`current_tool_services`
(same pattern as :func:`agent_service.mcp_client.current_mcp`).
"""

from __future__ import annotations

from contextvars import ContextVar
from dataclasses import dataclass

from agent_framework_ag_ui import AGUIThreadSnapshotStore
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker


@dataclass(frozen=True, slots=True)
class ToolServices:
    snapshot_store: AGUIThreadSnapshotStore
    sessionmaker: async_sessionmaker[AsyncSession]


_SERVICES: ContextVar[ToolServices | None] = ContextVar("agent_service_tool_services", default=None)


def bind_tool_services(services: ToolServices | None) -> None:
    _SERVICES.set(services)


def current_tool_services() -> ToolServices:
    services = _SERVICES.get()
    if services is None:
        raise RuntimeError("No tool services are bound to this run.")
    return services


__all__ = ["ToolServices", "bind_tool_services", "current_tool_services"]
