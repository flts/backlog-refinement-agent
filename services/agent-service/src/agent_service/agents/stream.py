"""The guarded event stream of a run: run timeout, sanitized ``RUN_ERROR`` events and the run outcome.

Everything the endpoint streams passes through :func:`guarded_stream`:

* the run deadline (``AGENT_RUN_TIMEOUT_SECONDS``) ends the stream with ``RUN_ERROR`` ``RUN_TIMEOUT``;
* an exception (also from our own wrappers) becomes ``RUN_ERROR`` with a mapped code (``LLM_UNAVAILABLE``,
  ``BACKLOG_UNAVAILABLE``, ``FORBIDDEN``, ...) or ``INTERNAL`` plus a reference; the exception itself is only logged;
* a ``RUN_ERROR`` from MAF keeps its code when it is one of :class:`~backlog_contracts.RunErrorCode` (``APPROVAL_*``),
  everything else (exception class names, ``APPROVAL_TOOL_UNAVAILABLE``, ...) becomes ``INTERNAL``; the message is
  always the fixed text of the code.

Timeline steps that are still open are finished before the ``RUN_ERROR`` (the ``@ag-ui/client`` verifier requires it).
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncGenerator, AsyncIterator
from dataclasses import dataclass

from ag_ui.core import BaseEvent, EventType, StepFinishedEvent
from backlog_contracts import RunErrorCode

from agent_service.run_errors import build_run_error, classify_exception, new_reference, sanitize_run_error

logger = logging.getLogger(__name__)

OUTCOME_FINISHED = "finished"
OUTCOME_INTERRUPTED = "interrupted"
OUTCOME_CANCELLED = "cancelled"


@dataclass(slots=True)
class StreamResult:
    """How a run ended; read by the dispatcher for metrics and the run span."""

    outcome: str = OUTCOME_CANCELLED
    error_code: RunErrorCode | None = None
    reference: str | None = None


async def guarded_stream(
    source: AsyncIterator[BaseEvent], *, run_id: str | None, timeout_seconds: float, result: StreamResult
) -> AsyncGenerator[BaseEvent, None]:
    deadline = asyncio.get_running_loop().time() + timeout_seconds
    open_steps: set[str] = set()

    def fail(code: RunErrorCode, reference: str | None = None) -> list[BaseEvent]:
        result.error_code, result.reference = code, reference
        events: list[BaseEvent] = [StepFinishedEvent(step_name=name) for name in sorted(open_steps)]
        open_steps.clear()
        events.append(build_run_error(code, run_id=run_id, reference=reference, timeout_seconds=timeout_seconds))
        return events

    try:
        while True:
            guard = asyncio.timeout_at(deadline)
            try:
                async with guard:
                    event = await anext(source)
            except StopAsyncIteration:
                if result.error_code is None and result.outcome == OUTCOME_CANCELLED:
                    result.outcome = OUTCOME_FINISHED
                return
            except TimeoutError as exc:
                if guard.expired():
                    logger.warning("Run timed out", extra={"timeout_seconds": timeout_seconds})
                    for item in fail(RunErrorCode.RUN_TIMEOUT):
                        yield item
                    return
                for item in _internal_failure(exc, fail):
                    yield item
                return
            except Exception as exc:
                for item in _internal_failure(exc, fail):
                    yield item
                return
            kind = event.type
            if kind == EventType.STEP_STARTED:
                open_steps.add(getattr(event, "step_name", ""))
            elif kind == EventType.STEP_FINISHED:
                open_steps.discard(getattr(event, "step_name", ""))
            elif kind == EventType.RUN_FINISHED:
                interrupted = getattr(getattr(event, "outcome", None), "type", None) == "interrupt"
                result.outcome = OUTCOME_INTERRUPTED if interrupted else OUTCOME_FINISHED
            elif kind == EventType.RUN_ERROR:
                reference = new_reference()
                sanitized, code = sanitize_run_error(event, run_id=run_id, reference=reference)  # pyright: ignore[reportArgumentType]
                logger.warning(
                    "Run ended with RUN_ERROR",
                    extra={
                        "code": code.value,
                        "source_code": str(getattr(event, "code", ""))[:64],
                        "reference": reference,
                    },
                )
                result.error_code, result.reference = code, reference
                for step in sorted(open_steps):
                    yield StepFinishedEvent(step_name=step)
                open_steps.clear()
                yield sanitized
                return
            yield event
    finally:
        aclose = getattr(source, "aclose", None)
        if aclose is not None:
            await aclose()


def _internal_failure(exc: BaseException, fail) -> list[BaseEvent]:  # type: ignore[no-untyped-def]
    code = classify_exception(exc)
    reference = new_reference()
    logger.error(
        "Run failed",
        extra={"code": code.value, "error_type": type(exc).__name__, "reference": reference},
        exc_info=exc,
    )
    return fail(code, reference)
