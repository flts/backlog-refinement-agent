"""The signed-in user."""

from __future__ import annotations

from fastapi import APIRouter

from backlog_api.api.schemas import ApiModel
from backlog_api.auth.dependencies import PrincipalDep
from backlog_api.problems import problem_responses

router = APIRouter(tags=["me"])


class Me(ApiModel):
    email: str
    name: str | None
    sub: str | None


@router.get("/me", summary="The signed-in user", responses=problem_responses(401, 403))
async def get_me(principal: PrincipalDep) -> Me:
    return Me(email=principal.email, name=principal.name, sub=principal.sub)
