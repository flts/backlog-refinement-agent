"""Liveness and readiness probes (mounted at the root and under ``/api/agent``)."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from sqlalchemy.exc import SQLAlchemyError

from agent_service.db.session import Database
from agent_service.llm import LlmReadiness
from agent_service.problems import ProblemError, problem_response, problem_responses
from agent_service.settings import Settings

logger = logging.getLogger(__name__)

router = APIRouter(tags=["health"])


@router.get("/healthz", summary="Liveness probe")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@router.get(
    "/readyz",
    summary="Readiness probe (database reachable; LLM gateway reported, optionally required)",
    responses=problem_responses(503),
)
async def readyz(request: Request) -> JSONResponse:
    settings: Settings = request.app.state.settings
    database: Database | None = getattr(request.app.state, "db", None)
    try:
        if database is None:
            raise RuntimeError("database not initialised")
        await database.ping()
    except (SQLAlchemyError, OSError, RuntimeError) as exc:
        logger.warning("Readiness check failed", extra={"error_type": type(exc).__name__})
        problem = ProblemError(503, "not-ready", detail="The database is not reachable.")
        return problem_response(503, problem.to_problem(request.url.path), {"Retry-After": "5"})
    readiness: LlmReadiness | None = getattr(request.app.state, "llm_readiness", None)
    llm = await readiness.check() if readiness is not None else "unavailable"
    if llm != "ok" and settings.llm_required_for_readiness:
        problem = ProblemError(503, "not-ready", detail="The LLM gateway is not reachable.", llm=llm)
        return problem_response(503, problem.to_problem(request.url.path), {"Retry-After": "5"})
    body: dict[str, Any] = {"status": "ready", "llm": llm}
    return JSONResponse(body)
