"""Agent-side tools, resolved by name from the agent definitions (``tools: [...]``).

Every tool module registers a factory per tool name with :meth:`ToolRegistry.register`. A factory returns a MAF
``FunctionTool``; it runs once when the agent is built, so a tool reads per-run data at call time:

* the MCP connection of the run: ``agent_service.mcp_client.current_mcp()``; ``await current_mcp().call(
  "apply_document_changes", ...)`` also reaches the *hidden* write tools of ``tools/tools.yaml``,
* the caller: ``agent_service.auth.current_token()`` / ``current_principal()``,
* the snapshot store and the database: :func:`agent_service.tools.services.current_tool_services`,
* AG-UI state (``preview``, ``childPreview``, ``lastApply``, ``quality``, ``nextActions``): return
  ``agent_framework_ag_ui.state_update(...)`` from the tool; predictive state for streaming arguments is declared in
  the agent definition (``predict_state``).

The real tools: ``propose_document_changes`` / ``propose_child_items`` (:mod:`~agent_service.tools.proposals`),
``record_quality_assessment`` (:mod:`~agent_service.tools.assessment`), ``suggest_next_actions`` and
``set_session_title`` (:mod:`~agent_service.tools.session`). :func:`default_tool_registry` returns the registry used by
the loader, including the function middleware (:mod:`~agent_service.tools.guard`) that caps invalid-argument retries.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from typing import Any

from agent_framework import FunctionMiddleware, FunctionTool
from pydantic import BaseModel


class UnknownToolError(KeyError):
    """An agent definition names a tool that no module registered."""


ToolFactory = Callable[[], FunctionTool]


@dataclass(frozen=True, slots=True)
class ToolSpec:
    """What the argument guard needs to know about a tool."""

    arguments: type[BaseModel] | None = None
    """Pydantic model that validates the arguments (strictly, with concise errors)."""
    error_state: Mapping[str, Any] | None = None
    """AG-UI state to push when the call fails validation (for example clearing a preview)."""


class ToolRegistry:
    def __init__(self) -> None:
        self._factories: dict[str, ToolFactory] = {}
        self._specs: dict[str, ToolSpec] = {}
        self._middleware: list[FunctionMiddleware] = []

    def register(
        self,
        name: str,
        factory: ToolFactory,
        *,
        arguments: type[BaseModel] | None = None,
        error_state: Mapping[str, Any] | None = None,
        replace: bool = False,
    ) -> None:
        if name in self._factories and not replace:
            raise ValueError(f"Tool '{name}' is already registered.")
        self._factories[name] = factory
        self._specs[name] = ToolSpec(arguments=arguments, error_state=error_state)

    def spec(self, name: str) -> ToolSpec | None:
        return self._specs.get(name)

    def specs(self) -> Mapping[str, ToolSpec]:
        return self._specs

    def add_middleware(self, middleware: FunctionMiddleware) -> None:
        self._middleware.append(middleware)

    def middleware(self) -> list[FunctionMiddleware]:
        """Function middleware for every agent built with this registry (passed to ``Agent(middleware=...)``)."""
        return list(self._middleware)

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
    """The tools available to agent definitions, with the argument guard middleware."""
    from agent_service.tools import assessment, guard, proposals, session

    registry = ToolRegistry()
    proposals.register(registry)
    assessment.register(registry)
    session.register(registry)
    registry.add_middleware(guard.ToolMetrics())
    registry.add_middleware(guard.ToolInputGuard(registry.specs()))
    return registry


__all__ = ["ToolFactory", "ToolRegistry", "ToolSpec", "UnknownToolError", "default_tool_registry"]
