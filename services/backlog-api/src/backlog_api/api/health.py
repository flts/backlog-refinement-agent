"""Liveness and readiness probes (mounted at the root and under ``/api/backlog``)."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from sqlalchemy.exc import SQLAlchemyError

from backlog_api.db.session import Database
from backlog_api.problems import ProblemError, problem_response, problem_responses

logger = logging.getLogger(__name__)

router = APIRouter(tags=["health"])


@router.get("/healthz", summary="Liveness probe")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/readyz", summary="Readiness probe (database reachable)", responses=problem_responses(503))
async def readyz(request: Request) -> JSONResponse:
    database: Database | None = getattr(request.app.state, "db", None)
    try:
        if database is None:
            raise RuntimeError("database not initialised")
        await database.ping()
    except (SQLAlchemyError, OSError, RuntimeError) as exc:
        logger.warning("Readiness check failed", extra={"error_type": type(exc).__name__})
        problem = ProblemError(503, "not-ready", detail="The database is not reachable.")
        return problem_response(503, problem.to_problem(request.url.path), {"Retry-After": "5"})
    return JSONResponse({"status": "ready"})
