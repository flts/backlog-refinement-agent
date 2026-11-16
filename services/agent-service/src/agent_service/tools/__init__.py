"""Agent-side tools, resolved by name from the agent definitions (``tools: [...]``).

The seam for ``svc-tools``: register a factory per tool name with :meth:`ToolRegistry.register`. A factory returns a
MAF ``FunctionTool``; it runs once when the agent is built, so a tool must read per-run data (the caller, the MCP
connection, the thread state) at call time:

* the MCP connection of the run: ``agent_service.mcp_client.current_mcp()``; ``await current_mcp().call(
  "apply_document_changes", ...)`` also reaches the *hidden* write tools of ``tools/tools.yaml``,
* the caller: ``agent_service.auth.current_token()`` / ``current_principal()``,
* AG-UI state (``preview``, ``nextActions``, ``quality``, ``lastApply``): return
  ``agent_framework_ag_ui.state_update(...)`` from the tool; predictive state for streaming arguments is declared in
  the agent definition (``predict_state``).

:func:`default_tool_registry` returns the registry used by the loader. ``tools/placeholders.py`` registers marked
placeholders for every tool the refiner definition names, so the definition loads before ``svc-tools`` exists;
``svc-tools`` replaces them by registering its real tools first (or deleting the placeholder module).
"""

from __future__ import annotations

from collections.abc import Callable, Iterable

from agent_framework import FunctionTool


class UnknownToolError(KeyError):
    """An agent definition names a tool that no module registered."""


ToolFactory = Callable[[], FunctionTool]


class ToolRegistry:
    def __init__(self) -> None:
        self._factories: dict[str, ToolFactory] = {}

    def register(self, name: str, factory: ToolFactory, *, replace: bool = False) -> None:
        if name in self._factories and not replace:
            raise ValueError(f"Tool '{name}' is already registered.")
        self._factories[name] = factory

    def names(self) -> Iterable[str]:
        return tuple(self._factories)

    def __contains__(self, name: object) -> bool:
        return name in self._factories

    def create(self, name: str) -> FunctionTool:
        try:
            factory = self._factories[name]
        except KeyError:
            raise UnknownToolError(
                f"Unknown agent tool '{name}'. Known tools: {', '.join(sorted(self._factories)) or '(none)'}."
            ) from None
        return factory()


def default_tool_registry() -> ToolRegistry:
    """The tools available to agent definitions (real tools first, then the marked placeholders)."""
    from agent_service.tools import placeholders

    registry = ToolRegistry()
    placeholders.register(registry)
    return registry


__all__ = ["ToolFactory", "ToolRegistry", "UnknownToolError", "default_tool_registry"]
