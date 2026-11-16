"""Agent registry and the AG-UI endpoint wiring."""

from agent_service.agents.registry import AgentRegistry, build_placeholder_registry, make_runner

__all__ = ["AgentRegistry", "build_placeholder_registry", "make_runner"]
