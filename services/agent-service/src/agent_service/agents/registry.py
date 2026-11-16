"""Agent registry: the seam between the AG-UI endpoint and the agent definitions.

``AgentRegistry.get(agent_id)`` returns the MAF AG-UI runner (``AgentFrameworkAgent``) for an id, or ``None`` for an
unknown id (the endpoint answers 404). The agent loader (``svc-agent-loader``) replaces
:func:`build_placeholder_registry` with agents built from the git-managed definitions; nothing else in the endpoint
wiring has to change.
"""

from __future__ import annotations

from collections.abc import Iterable

from agent_framework import Agent
from agent_framework_ag_ui import AgentFrameworkAgent, AGUIThreadSnapshotStore

from agent_service.llm import create_chat_client
from agent_service.settings import Settings


class AgentRegistry:
    def __init__(self, runners: dict[str, AgentFrameworkAgent] | None = None) -> None:
        self._runners: dict[str, AgentFrameworkAgent] = dict(runners or {})

    def register(self, agent_id: str, runner: AgentFrameworkAgent) -> None:
        self._runners[agent_id] = runner

    def get(self, agent_id: str) -> AgentFrameworkAgent | None:
        return self._runners.get(agent_id)

    def ids(self) -> Iterable[str]:
        return tuple(self._runners)


def make_runner(agent: Agent, *, snapshot_store: AGUIThreadSnapshotStore, **options: object) -> AgentFrameworkAgent:
    """Wrap a MAF agent for AG-UI with the service-wide settings (no synthetic ``confirm_changes`` tool call)."""
    return AgentFrameworkAgent(
        agent=agent,
        name=agent.name,
        require_confirmation=False,
        snapshot_store=snapshot_store,
        **options,  # type: ignore[arg-type]
    )


def build_placeholder_registry(settings: Settings, snapshot_store: AGUIThreadSnapshotStore) -> AgentRegistry:
    """A single echo agent (until the agent loader exists), built from the LLM client factory."""
    agent = Agent(
        client=create_chat_client(settings),
        name=settings.default_agent_id,
        instructions="You are a placeholder agent. Repeat the user's last message back, prefixed with 'Echo: '.",
    )
    return AgentRegistry({settings.default_agent_id: make_runner(agent, snapshot_store=snapshot_store)})
