"""Sanitized ``RUN_ERROR`` events.

MAF sends the exception class name as ``code`` and ``str(exc)`` as ``message`` for some failures. Clients only ever see
a code of :class:`~backlog_contracts.RunErrorCode` (``contracts/schemas/run-error-codes.schema.json``) and a fixed text;
the real exception is logged server side together with the reference that the ``INTERNAL`` message carries.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator

import httpx
import openai
from ag_ui.core import RunErrorEvent
from agent_framework.exceptions import ChatClientException
from backlog_contracts import RunErrorCode
from opentelemetry import trace

from agent_service.mcp_client import McpToolError, McpUnavailableError
from agent_service.problems import ProblemError

RUN_ERROR_MESSAGES: dict[RunErrorCode, str] = {
    RunErrorCode.APPROVAL_RESUME_REQUIRED: "A pending proposal needs your decision before you can continue.",
    RunErrorCode.APPROVAL_RESUME_NOT_FOUND: (
        "This proposal is no longer available. Ask the assistant to propose it again."
    ),
    RunErrorCode.APPROVAL_RESUME_INVALID: "The decision on the proposal could not be processed.",
    RunErrorCode.APPROVAL_RESUME_INVALID_RESPONSE: "The decision on the proposal has an invalid shape.",
    RunErrorCode.UNAUTHENTICATED: "The session has expired. Sign in again.",
    RunErrorCode.FORBIDDEN: "You do not have access to this conversation.",
    RunErrorCode.NOT_FOUND: "The conversation or item was not found.",
    RunErrorCode.THREAD_BUSY: "Another run is already active on this conversation.",
    RunErrorCode.RATE_LIMITED: "Too many requests. Try again shortly.",
    RunErrorCode.RUN_TIMEOUT: "The run took too long and was stopped.",
    RunErrorCode.LLM_UNAVAILABLE: "The language model is currently unavailable.",
    RunErrorCode.BACKLOG_UNAVAILABLE: "The backlog service is currently unavailable.",
    RunErrorCode.TOOL_VALIDATION_FAILED: "The assistant could not produce valid arguments for a tool.",
    RunErrorCode.INVALID_REQUEST: "The request was not accepted.",
    RunErrorCode.INTERNAL: "An unexpected error occurred.",
}


def new_reference() -> str:
    """Correlation id for an ``INTERNAL`` error: the active trace id when there is one, else a random id."""
    context = trace.get_current_span().get_span_context()
    return f"{context.trace_id:032x}" if context.is_valid else uuid.uuid4().hex


def _chain(exc: BaseException) -> Iterator[BaseException]:
    seen: set[int] = set()
    pending: list[BaseException] = [exc]
    while pending:
        current = pending.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        yield current
        if isinstance(current, BaseExceptionGroup):
            pending.extend(current.exceptions)
        for linked in (current.__cause__, current.__context__):
            if linked is not None:
                pending.append(linked)


def classify_exception(exc: BaseException) -> RunErrorCode:
    """Map an exception raised while streaming a run to the sanitized code (``INTERNAL`` when unknown)."""
    chain = list(_chain(exc))
    for item in chain:
        if isinstance(item, McpUnavailableError):
            return RunErrorCode.BACKLOG_UNAVAILABLE
        if isinstance(item, McpToolError) and item.status >= 500:
            return RunErrorCode.BACKLOG_UNAVAILABLE
        if isinstance(item, ProblemError):
            if item.slug == "backlog-unavailable":
                return RunErrorCode.BACKLOG_UNAVAILABLE
            return {401: RunErrorCode.UNAUTHENTICATED, 403: RunErrorCode.FORBIDDEN, 404: RunErrorCode.NOT_FOUND}.get(
                item.status, RunErrorCode.INTERNAL
            )
    for item in chain:
        if isinstance(item, ChatClientException | openai.OpenAIError):
            return RunErrorCode.LLM_UNAVAILABLE
    if any(isinstance(item, httpx.TransportError) for item in chain):
        return RunErrorCode.LLM_UNAVAILABLE
    return RunErrorCode.INTERNAL


def run_error_message(code: RunErrorCode, *, reference: str | None = None, timeout_seconds: float | None = None) -> str:
    message = RUN_ERROR_MESSAGES[code]
    if code is RunErrorCode.RUN_TIMEOUT and timeout_seconds is not None:
        message = f"The run took longer than {timeout_seconds:g} seconds and was stopped."
    if code is RunErrorCode.INTERNAL and reference:
        message = f"{message} Reference: {reference}."
    return message


def build_run_error(
    code: RunErrorCode,
    *,
    run_id: str | None = None,
    reference: str | None = None,
    timeout_seconds: float | None = None,
) -> RunErrorEvent:
    message = run_error_message(code, reference=reference, timeout_seconds=timeout_seconds)
    if run_id:  # ``runId`` is an extra field of RUN_ERROR in this ag-ui version; the SPA shows it for support
        return RunErrorEvent(message=message, code=code.value, runId=run_id)  # pyright: ignore[reportCallIssue]
    return RunErrorEvent(message=message, code=code.value)


def sanitize_run_error(
    event: RunErrorEvent, *, run_id: str | None, reference: str
) -> tuple[RunErrorEvent, RunErrorCode]:
    """Replace the code and message of a RUN_ERROR from MAF: known codes are kept, anything else is ``INTERNAL``."""
    code = RunErrorCode.normalize(event.code)
    return build_run_error(code, run_id=run_id, reference=reference), code
