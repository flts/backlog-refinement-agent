"""Builds the agents from ``agents/*.agent.md`` and ``tools/tools.yaml`` (``svc-agent-loader``).

For every definition the loader creates a MAF ``Agent`` with

* the chat client of the definition's model alias (``AGENT_LLM_MODEL`` when absent) and its run limits,
* the context providers, in this order (``before_run`` runs in declared order):
  1. :class:`~agent_service.mcp_client.McpProvider` - per-run MCP connections with the caller's token (``mcp:``),
  2. the skills provider - defaults from ``skills/`` plus the project's guidance overrides (``skills:``),
  3. the providers named in ``context_providers:`` (``item_context``, ``intent``),
* the agent-side tools resolved by name from :mod:`agent_service.tools` (``tools:``),

and wraps it in an AG-UI runner that adds the per-run MCP scope and the ``STEP_*`` timeline rows. Client tools
(``client_tools:``, for example ``ask_user``) are declared by the SPA in ``RunAgentInput.tools``; nothing is
defined here.

In development (``AGENT_ENV=development``) :class:`ReloadingRegistry` rebuilds everything when a definition, tools.yaml
or a skill file changes on disk.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from agent_framework import Agent, ContextProvider
from agent_framework_ag_ui import AGUIThreadSnapshotStore
from backlog_skills import resolve_skills_root

from agent_service.agents.definition import (
    AgentDefinition,
    AgentDefinitionError,
    definition_files,
    load_agent_definitions,
)
from agent_service.agents.providers import PROVIDER_FACTORIES
from agent_service.agents.registry import AgentInfo, AgentRegistry, make_runner
from agent_service.agents.runner import StepEmittingRunner
from agent_service.agents.skills import build_skills_provider
from agent_service.agents.version import resolve_build_version
from agent_service.llm import create_chat_client
from agent_service.mcp_client import (
    BACKLOG_SERVER,
    McpProvider,
    ToolsConfig,
    ToolsConfigError,
    load_tools_config,
)
from agent_service.settings import Settings
from agent_service.tools import ToolRegistry, UnknownToolError, default_tool_registry

logger = logging.getLogger(__name__)

PROVIDERS_NEEDING_BACKLOG = frozenset({"item_context"})


class AgentLoadError(Exception):
    """The agent definitions, tools.yaml or skills are inconsistent; the message says what to fix."""


def tools_environment(settings: Settings) -> dict[str, str]:
    """Variables available as ``${VAR}`` in tools.yaml: the process environment plus the resolved service URLs."""
    env = dict(os.environ)
    if settings.backlog_api_url:
        env["AGENT_BACKLOG_API_URL"] = settings.backlog_api_url.rstrip("/")
    return env


def load_tools(settings: Settings) -> ToolsConfig:
    try:
        return load_tools_config(settings.tools_file, tools_environment(settings))
    except ToolsConfigError as exc:
        raise AgentLoadError(str(exc)) from exc


def build_agent(
    definition: AgentDefinition,
    settings: Settings,
    *,
    tools_config: ToolsConfig,
    tool_registry: ToolRegistry,
    skills_dir: Path,
) -> Agent:
    where = str(definition.path or definition.id)
    providers: list[ContextProvider] = []
    if definition.mcp:
        try:
            servers = [tools_config.server(name) for name in definition.mcp]
        except ToolsConfigError as exc:
            raise AgentLoadError(f"{where}: {exc}") from exc
        providers.append(McpProvider(servers, dev_headers=settings.auth_mode == "dev"))
    if definition.skills:
        try:
            providers.append(build_skills_provider(skills_dir, definition.skills))
        except Exception as exc:
            raise AgentLoadError(f"{where}: cannot load skills from '{skills_dir}': {exc}") from exc
        _check_skills(definition, skills_dir, where)
    for name in definition.context_providers:
        factory = PROVIDER_FACTORIES.get(name)
        if factory is None:
            raise AgentLoadError(
                f"{where}: unknown context provider '{name}'. Known: {', '.join(sorted(PROVIDER_FACTORIES))}."
            )
        if name in PROVIDERS_NEEDING_BACKLOG and BACKLOG_SERVER not in definition.mcp:
            raise AgentLoadError(f"{where}: context provider '{name}' needs 'mcp: [{BACKLOG_SERVER}]'.")
        providers.append(factory())
    try:
        tools = [tool_registry.create(name) for name in definition.tools]
    except UnknownToolError as exc:
        raise AgentLoadError(f"{where}: {exc.args[0]}") from exc

    client = create_chat_client(settings, model=definition.model)
    limits: Mapping[str, Any] = client.function_invocation_configuration  # type: ignore[attr-defined]
    if definition.max_turns is not None:
        limits["max_iterations"] = definition.max_turns  # type: ignore[index]
    if definition.max_tool_calls is not None:
        limits["max_function_calls"] = definition.max_tool_calls  # type: ignore[index]
    options: dict[str, Any] = {}
    if definition.temperature is not None:
        options["temperature"] = definition.temperature
    return Agent(
        client=client,
        id=definition.id,
        name=definition.id,
        description=definition.description,
        instructions=definition.instructions,
        tools=tools,
        default_options=options or None,  # type: ignore[arg-type]
        context_providers=providers,
    )


def _check_skills(definition: AgentDefinition, skills_dir: Path, where: str) -> None:
    from backlog_skills import load_skills

    catalog = load_skills(skills_dir)
    missing = [name for name in definition.skills if name not in catalog]
    if missing:
        raise AgentLoadError(
            f"{where}: unknown skills: {', '.join(missing)} (available: {', '.join(sorted(catalog))})."
        )


def build_registry(
    settings: Settings,
    snapshot_store: AGUIThreadSnapshotStore,
    *,
    tool_registry: ToolRegistry | None = None,
) -> AgentRegistry:
    """Build every agent of ``settings.agents_dir`` (raises :class:`AgentLoadError` when something is inconsistent)."""
    try:
        definitions = load_agent_definitions(settings.agents_dir)
    except AgentDefinitionError as exc:
        raise AgentLoadError(str(exc)) from exc
    tools_config = load_tools(settings)
    skills_dir = resolve_skills_root(settings.skills_dir)
    registry_tools = tool_registry or default_tool_registry()
    version = resolve_build_version(settings)
    registry = AgentRegistry(version=version)
    for definition in definitions.values():
        agent = build_agent(
            definition, settings, tools_config=tools_config, tool_registry=registry_tools, skills_dir=skills_dir
        )
        runner = make_runner(
            agent,
            snapshot_store=snapshot_store,
            predict_state_config={
                key: {"tool": spec.tool, "tool_argument": spec.argument}
                for key, spec in definition.predict_state.items()
            }
            or None,
        )
        registry.register(
            definition.id,
            StepEmittingRunner(runner),
            AgentInfo(
                id=definition.id,
                name=definition.name,
                description=definition.description,
                version=version,
                model=definition.model or settings.llm_model,
                skills=definition.skills,
                tools=definition.tools,
                mcp=definition.mcp,
                client_tools=definition.client_tools,
            ),
        )
    logger.info("Loaded agents", extra={"agents": sorted(registry.ids()), "version": version})
    return registry


def _signature(settings: Settings) -> tuple[tuple[str, int], ...]:
    paths: list[Path] = [*definition_files(settings.agents_dir), settings.tools_file]
    try:
        skills_dir = resolve_skills_root(settings.skills_dir)
        paths.extend(sorted(skills_dir.rglob("*.md")))
    except Exception:  # skills are validated by build_registry
        logger.debug("Skills directory not resolvable for the change check", exc_info=True)
    stamps: list[tuple[str, int]] = []
    for path in paths:
        try:
            stamps.append((str(path), path.stat().st_mtime_ns))
        except OSError:
            stamps.append((str(path), -1))
    return tuple(stamps)


class ReloadingRegistry(AgentRegistry):
    """Development: rebuilds the agents when a definition, tools.yaml or skill file changed (checked per lookup).

    A failing reload keeps the previous agents and logs the error; the next change is tried again.
    """

    def __init__(self, settings: Settings, snapshot_store: AGUIThreadSnapshotStore) -> None:
        super().__init__()
        self._settings = settings
        self._snapshot_store = snapshot_store
        self._seen: tuple[tuple[str, int], ...] = ()
        self._reload(initial=True)

    def _reload(self, *, initial: bool = False) -> None:
        signature = _signature(self._settings)
        self._seen = signature
        try:
            fresh = build_registry(self._settings, self._snapshot_store)
        except (AgentLoadError, OSError) as exc:
            if initial:
                raise
            logger.error("Reloading the agent definitions failed, keeping the previous agents: %s", exc)
            return
        self._runners = fresh._runners  # noqa: SLF001
        self._infos = fresh._infos  # noqa: SLF001
        self.version = fresh.version
        if not initial:
            logger.info("Reloaded the agent definitions", extra={"agents": sorted(self.ids())})

    def refresh(self) -> None:
        if _signature(self._settings) != self._seen:
            self._reload()

    def get(self, agent_id: str):  # noqa: ANN201
        self.refresh()
        return super().get(agent_id)

    def ids(self):  # noqa: ANN201
        self.refresh()
        return super().ids()

    def info(self, agent_id: str) -> AgentInfo | None:
        self.refresh()
        return super().info(agent_id)


def registry_factory(settings: Settings, snapshot_store: AGUIThreadSnapshotStore) -> AgentRegistry:
    """The default ``registry_factory`` of the app: the agents of the definition files (hot reload in development)."""
    if settings.env == "development":
        return ReloadingRegistry(settings, snapshot_store)
    return build_registry(settings, snapshot_store)
