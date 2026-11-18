"""RFC 9457 problem details (``application/problem+json``).

Raise :class:`ProblemError` (or one of its helpers) from anywhere in a request; the registered handlers render it,
as well as FastAPI validation errors and Starlette HTTP exceptions, as problem documents. ``type`` values are
relative URIs under ``/problems/<slug>`` so clients can switch on the slug.
"""

from __future__ import annotations

from collections.abc import Mapping
from http import HTTPStatus
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.exceptions import HTTPException as StarletteHTTPException

PROBLEM_CONTENT_TYPE = "application/problem+json"
PROBLEM_TYPE_PREFIX = "/problems/"


class Problem(BaseModel):
    """RFC 9457 problem document; extension members are allowed."""

    model_config = ConfigDict(extra="allow")

    type: str = Field(default="about:blank", examples=["/problems/not-found"])
    title: str
    status: int
    detail: str | None = None
    instance: str | None = None


class ProblemError(Exception):
    def __init__(
        self,
        status: int,
        slug: str | None = None,
        *,
        title: str | None = None,
        detail: str | None = None,
        headers: Mapping[str, str] | None = None,
        **extensions: Any,
    ) -> None:
        super().__init__(detail or title or slug or str(status))
        self.status = status
        self.slug = slug
        self.title = title or _status_phrase(status)
        self.detail = detail
        self.headers = dict(headers or {})
        self.extensions = extensions

    def to_problem(self, instance: str | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {
            "type": f"{PROBLEM_TYPE_PREFIX}{self.slug}" if self.slug else "about:blank",
            "title": self.title,
            "status": self.status,
        }
        if self.detail:
            body["detail"] = self.detail
        if instance:
            body["instance"] = instance
        body.update(self.extensions)
        return body


def not_found(detail: str = "The resource was not found.") -> ProblemError:
    return ProblemError(404, "not-found", detail=detail)


def forbidden(detail: str, slug: str = "forbidden") -> ProblemError:
    return ProblemError(403, slug, detail=detail)


def conflict(slug: str, detail: str, **extensions: Any) -> ProblemError:
    return ProblemError(409, slug, detail=detail, **extensions)


def problem_response(
    status: int,
    body: Mapping[str, Any],
    headers: Mapping[str, str] | None = None,
) -> JSONResponse:
    return JSONResponse(dict(body), status_code=status, headers=dict(headers or {}), media_type=PROBLEM_CONTENT_TYPE)


def _status_phrase(status: int) -> str:
    try:
        return HTTPStatus(status).phrase
    except ValueError:
        return "Error"


def _instance(request: Request) -> str:
    return request.url.path


async def _problem_error_handler(request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, ProblemError)
    return problem_response(exc.status, exc.to_problem(_instance(request)), exc.headers)


async def _http_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, StarletteHTTPException)
    slug = {404: "not-found", 405: "method-not-allowed", 401: "unauthorized", 403: "forbidden"}.get(exc.status_code)
    detail = exc.detail if isinstance(exc.detail, str) and exc.detail != _status_phrase(exc.status_code) else None
    problem = ProblemError(exc.status_code, slug, detail=detail)
    return problem_response(exc.status_code, problem.to_problem(_instance(request)), exc.headers)


async def _validation_error_handler(request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, RequestValidationError)
    errors = [
        {"loc": list(error.get("loc", ())), "msg": error.get("msg", ""), "type": error.get("type", "")}
        for error in exc.errors()
    ]
    problem = ProblemError(
        422, "validation-error", title="Request validation failed", detail="The request is invalid.", errors=errors
    )
    return problem_response(422, problem.to_problem(_instance(request)))


def install_problem_handlers(app: FastAPI) -> None:
    app.add_exception_handler(ProblemError, _problem_error_handler)
    app.add_exception_handler(StarletteHTTPException, _http_exception_handler)
    app.add_exception_handler(RequestValidationError, _validation_error_handler)


def problem_responses(*statuses: int) -> dict[int | str, dict[str, Any]]:
    """OpenAPI ``responses`` entries documenting problem+json bodies for the given status codes."""
    return {
        status: {
            "description": _status_phrase(status),
            "content": {PROBLEM_CONTENT_TYPE: {"schema": {"$ref": "#/components/schemas/Problem"}}},
        }
        for status in statuses
    }
