"""The AG-UI runner of a loaded agent: per-run MCP scope plus the STEP_* timeline rows."""

from __future__ import annotations

import logging
from collections.abc import AsyncGenerator, Mapping
from typing import Any

from ag_ui.core import BaseEvent
from agent_framework_ag_ui import AgentFrameworkAgent

from agent_service.agents.steps import StepTracker
from agent_service.mcp_client import RunMcpScope, bind_run_scope

logger = logging.getLogger(__name__)


class StepEmittingRunner(AgentFrameworkAgent):
    """Wraps an :class:`AgentFrameworkAgent`: opens the run's :class:`RunMcpScope` and injects ``STEP_*`` events.

    The MCP connections themselves are opened by the agent's ``McpProvider`` (first context provider); the scope makes
    sure they are closed when the stream ends, also after a client disconnect or an error (spike Q3 lifecycle).
    """

    def __init__(self, inner: AgentFrameworkAgent) -> None:
        # Share the inner runner's state instead of building a second one (same config, snapshot store, approvals).
        self.inner = inner
        self.agent = inner.agent
        self.name = inner.name
        self.description = inner.description
        self.config = inner.config

    async def run(
        self, input_data: dict[str, Any], *, function_invocation_kwargs: Mapping[str, Any] | None = None
    ) -> AsyncGenerator[BaseEvent, None]:
        scope = RunMcpScope()
        bind_run_scope(scope)
        hydrate = not input_data.get("messages") and not input_data.get("resume")
        tracker = StepTracker(run_start_step=None if hydrate else "Reading item")
        try:
            async for event in self.inner.run(input_data, function_invocation_kwargs=function_invocation_kwargs):
                for out in tracker.process(event):
                    yield out
        finally:
            bind_run_scope(None)
            await scope.aclose()
