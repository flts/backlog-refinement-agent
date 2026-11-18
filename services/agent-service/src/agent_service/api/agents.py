"""``GET /api/agent/agents`` (catalogue) and ``GET /api/agent/agents/{agentId}`` (metadata).

The run endpoint ``POST /api/agent/agents/{agentId}`` is the AG-UI endpoint (:mod:`agent_service.agents.endpoint`).
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Path, Request

from agent_service.agents.registry import AgentInfo, AgentRegistry
from agent_service.api.schemas import ApiModel
from agent_service.auth.dependencies import PrincipalDep
from agent_service.problems import ProblemError, problem_responses

router = APIRouter(tags=["agents"])

AgentIdParam = Annotated[str, Path(max_length=64, description="Agent id, for example 'backlog-refiner'.")]


class AgentSummary(ApiModel):
    id: str
    name: str
    description: str
    version: str


class AgentList(ApiModel):
    items: list[AgentSummary]


class AgentDetail(AgentSummary):
    model: str | None
    skills: list[str]
    tools: list[str]
    mcp: list[str]
    client_tools: list[str]


def _summary(info: AgentInfo) -> AgentSummary:
    return AgentSummary(id=info.id, name=info.name, description=info.description, version=info.version)


@router.get("/agents", summary="Available agents", responses=problem_responses(401, 403))
async def list_agents(request: Request, principal: PrincipalDep) -> AgentList:
    registry: AgentRegistry = request.app.state.agents
    return AgentList(items=[_summary(info) for info in registry.catalogue()])


@router.get("/agents/{agent_id}", summary="Agent metadata", responses=problem_responses(401, 403, 404))
async def get_agent(agent_id: AgentIdParam, request: Request, principal: PrincipalDep) -> AgentDetail:
    registry: AgentRegistry = request.app.state.agents
    info = registry.info(agent_id)
    if info is None:
        raise ProblemError(404, "agent-not-found", detail="Unknown agent.")
    return AgentDetail(
        **_summary(info).model_dump(),
        model=info.model,
        skills=list(info.skills),
        tools=list(info.tools),
        mcp=list(info.mcp),
        client_tools=list(info.client_tools),
    )
