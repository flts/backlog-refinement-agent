"""Pure ASGI middleware (streaming-safe, so it also works for SSE responses added later)."""

from __future__ import annotations

import json
import logging
import re
import time
import uuid

from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from backlog_api.observability import request_id_var
from backlog_api.problems import PROBLEM_CONTENT_TYPE, ProblemError

REQUEST_ID_HEADER = "x-request-id"
_VALID_REQUEST_ID = re.compile(r"^[A-Za-z0-9._:\-]{1,128}$")

logger = logging.getLogger("backlog_api.request")

# Source uploads (POST .../projects/{id}/sources) may carry a file up to the source size limit plus multipart framing.
SOURCES_PATH = re.compile(r"^/api/backlog/projects/[^/]+/sources/?$")
MULTIPART_OVERHEAD_BYTES = 1024 * 1024
# Project backup import (POST .../projects/import) carries the whole backup document as JSON.
BACKUP_IMPORT_PATH = re.compile(r"^/api/backlog/projects/import/?$")


class RequestContextMiddleware:
    """Propagates or generates ``X-Request-ID``, logs one line per request (method, path, status, duration) and turns
    unhandled errors into a 500 problem response (logged with the request id, without request content)."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        incoming = Headers(scope=scope).get(REQUEST_ID_HEADER)
        request_id = incoming if incoming and _VALID_REQUEST_ID.match(incoming) else uuid.uuid4().hex
        scope.setdefault("state", {})["request_id"] = request_id
        token = request_id_var.set(request_id)
        started = time.perf_counter()
        status = 500
        response_started = False

        async def send_with_id(message: Message) -> None:
            nonlocal status, response_started
            if message["type"] == "http.response.start":
                status = message["status"]
                response_started = True
                MutableHeaders(scope=message)[REQUEST_ID_HEADER] = request_id
            await send(message)

        try:
            await self.app(scope, receive, send_with_id)
        except Exception as exc:
            logger.exception("Unhandled error", extra={"path": scope.get("path", ""), "error_type": type(exc).__name__})
            if response_started:
                raise
            problem = ProblemError(500, "internal-error", detail="An unexpected error occurred.")
            await _send_problem(send_with_id, problem)
        finally:
            path = scope.get("path", "")
            if path not in ("/healthz", "/readyz"):
                logger.info(
                    "request",
                    extra={
                        "method": scope.get("method"),
                        "path": path,
                        "status": status,
                        "duration_ms": round((time.perf_counter() - started) * 1000, 1),
                    },
                )
            request_id_var.reset(token)


class BodySizeLimitError(ProblemError):
    def __init__(self, limit: int) -> None:
        super().__init__(
            413, "payload-too-large", detail=f"The request body exceeds the limit of {limit} bytes.", limit=limit
        )


class BodySizeLimitMiddleware:
    """Rejects request bodies larger than ``max_body_bytes`` (``Content-Length`` and streamed bodies) with 413.

    ``overrides`` maps path prefixes to a different limit; ``route_limits`` lists ``(method, path regex, limit)``
    entries for routes that need more (for example source uploads) and wins over prefix overrides.
    """

    def __init__(
        self,
        app: ASGIApp,
        max_body_bytes: int,
        overrides: dict[str, int] | None = None,
        route_limits: list[tuple[str, re.Pattern[str], int]] | None = None,
    ) -> None:
        self.app = app
        self.max_body_bytes = max_body_bytes
        self.overrides = sorted((overrides or {}).items(), key=lambda item: len(item[0]), reverse=True)
        self.route_limits = route_limits or []

    def _limit_for(self, path: str, method: str = "") -> int:
        for route_method, pattern, limit in self.route_limits:
            if route_method == method and pattern.match(path):
                return limit
        for prefix, limit in self.overrides:
            if path.startswith(prefix):
                return limit
        return self.max_body_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        limit = self._limit_for(scope.get("path", ""), scope.get("method", ""))
        content_length = Headers(scope=scope).get("content-length")
        if content_length is not None:
            try:
                declared = int(content_length)
            except ValueError:
                declared = -1
            if declared < 0 or declared > limit:
                await _send_problem(send, BodySizeLimitError(limit) if declared > limit else _bad_length())
                return

        received = 0
        exceeded = False
        response_started = False

        async def limited_receive() -> Message:
            nonlocal received, exceeded
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    exceeded = True
                    raise BodySizeLimitError(limit)
            return message

        async def guarded_send(message: Message) -> None:
            nonlocal response_started
            if exceeded:
                # The app may have turned the error into its own response (e.g. FastAPI's 400 for body parse
                # errors); replace it with the 413 problem.
                if message["type"] == "http.response.start" and not response_started:
                    response_started = True
                    await _send_problem(send, BodySizeLimitError(limit))
                return
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, guarded_send)
        except BodySizeLimitError:
            if response_started:
                return
            await _send_problem(send, BodySizeLimitError(limit))


def _bad_length() -> ProblemError:
    return ProblemError(400, "invalid-content-length", detail="The Content-Length header is invalid.")


async def _send_problem(send: Send, problem: ProblemError) -> None:
    body = json.dumps(problem.to_problem()).encode()
    await send(
        {
            "type": "http.response.start",
            "status": problem.status,
            "headers": [
                (b"content-type", PROBLEM_CONTENT_TYPE.encode()),
                (b"content-length", str(len(body)).encode()),
                (b"connection", b"close"),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})
