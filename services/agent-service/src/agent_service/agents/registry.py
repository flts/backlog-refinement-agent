"""Agent registry: the seam between the AG-UI endpoint and the agent definitions.

``AgentRegistry.get(agent_id)`` returns the MAF AG-UI runner (``AgentFrameworkAgent``) for an id, or ``None`` for an
unknown id (the endpoint answers 404). :func:`agent_service.agents.loader.build_registry` builds the registry from the
git-managed definitions; :func:`build_placeholder_registry` (a single echo agent) is only used by tests.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field

from agent_framework import Agent
from agent_framework_ag_ui import AgentFrameworkAgent, AGUIThreadSnapshotStore

from agent_service.llm import create_chat_client
from agent_service.settings import Settings


@dataclass(frozen=True, slots=True)
class AgentInfo:
    """What the catalogue (``GET /api/agent/agents``) reports about an agent."""

    id: str
    name: str
    description: str
    version: str
    model: str | None = None
    skills: tuple[str, ...] = field(default_factory=tuple)
    tools: tuple[str, ...] = field(default_factory=tuple)
    mcp: tuple[str, ...] = field(default_factory=tuple)
    client_tools: tuple[str, ...] = field(default_factory=tuple)


class AgentRegistry:
    def __init__(
        self,
        runners: dict[str, AgentFrameworkAgent] | None = None,
        *,
        infos: dict[str, AgentInfo] | None = None,
        version: str = "dev",
    ) -> None:
        self._runners: dict[str, AgentFrameworkAgent] = dict(runners or {})
        self._infos: dict[str, AgentInfo] = dict(infos or {})
        self.version = version

    def register(self, agent_id: str, runner: AgentFrameworkAgent, info: AgentInfo | None = None) -> None:
        self._runners[agent_id] = runner
        if info is not None:
            self._infos[agent_id] = info

    def get(self, agent_id: str) -> AgentFrameworkAgent | None:
        return self._runners.get(agent_id)

    def ids(self) -> Iterable[str]:
        return tuple(self._runners)

    def info(self, agent_id: str) -> AgentInfo | None:
        known = self._infos.get(agent_id)
        runner = self._runners.get(agent_id)
        if known is not None or runner is None:
            return known
        return AgentInfo(id=agent_id, name=runner.name, description=runner.description, version=self.version)

    def catalogue(self) -> list[AgentInfo]:
        """All agents, ordered by id."""
        return [info for agent_id in sorted(self.ids()) if (info := self.info(agent_id)) is not None]


def make_runner(
    agent: Agent,
    *,
    snapshot_store: AGUIThreadSnapshotStore,
    runner_class: type[AgentFrameworkAgent] = AgentFrameworkAgent,
    **options: object,
) -> AgentFrameworkAgent:
    """Wrap a MAF agent for AG-UI with the service-wide settings (no synthetic ``confirm_changes`` tool call)."""
    return runner_class(
        agent=agent,
        name=agent.name,
        require_confirmation=False,
        snapshot_store=snapshot_store,
        **options,  # type: ignore[arg-type]
    )


def build_placeholder_registry(settings: Settings, snapshot_store: AGUIThreadSnapshotStore) -> AgentRegistry:
    """A single echo agent for tests, built from the LLM client factory."""
    agent = Agent(
        client=create_chat_client(settings),
        name=settings.default_agent_id,
        instructions="You are a placeholder agent. Repeat the user's last message back, prefixed with 'Echo: '.",
    )
    return AgentRegistry({settings.default_agent_id: make_runner(agent, snapshot_store=snapshot_store)})
