"""``guarded_stream`` and the error classification, without a database."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

import httpx
import openai
import pytest
from ag_ui.core import (
    BaseEvent,
    EventType,
    RunErrorEvent,
    RunFinishedEvent,
    RunStartedEvent,
    StepFinishedEvent,
    StepStartedEvent,
)
from agent_framework.exceptions import ChatClientException
from backlog_contracts import RunErrorCode

from agent_service.agents.stream import StreamResult, guarded_stream
from agent_service.mcp_client import McpToolError, McpUnavailableError
from agent_service.problems import ProblemError
from agent_service.run_errors import classify_exception


async def collect(source: AsyncIterator[BaseEvent], *, deadline: float = 5, result: StreamResult | None = None):
    result = result or StreamResult()
    events = [event async for event in guarded_stream(source, run_id="run-1", timeout_seconds=deadline, result=result)]
    return events, result


async def emit(*events: BaseEvent, then: BaseException | None = None) -> AsyncIterator[BaseEvent]:
    for event in events:
        yield event
    if then is not None:
        raise then


async def test_normal_stream_passes_through_and_records_the_outcome() -> None:
    events, result = await collect(
        emit(RunStartedEvent(thread_id="t", run_id="r"), RunFinishedEvent(thread_id="t", run_id="r"))
    )
    assert [e.type for e in events] == [EventType.RUN_STARTED, EventType.RUN_FINISHED]
    assert (result.outcome, result.error_code) == ("finished", None)


@pytest.mark.parametrize(
    ("source_code", "expected"),
    [
        ("APPROVAL_RESUME_NOT_FOUND", "APPROVAL_RESUME_NOT_FOUND"),
        ("ValueError", "INTERNAL"),
        ("APPROVAL_TOOL_UNAVAILABLE", "INTERNAL"),
    ],
)
async def test_maf_run_errors_are_normalised_and_the_message_replaced(source_code: str, expected: str) -> None:
    raw = RunErrorEvent(message="leak: s3cr3t exception text", code=source_code)
    events, result = await collect(
        emit(StepStartedEvent(step_name="x"), raw, RunFinishedEvent(thread_id="t", run_id="r"))
    )
    assert [e.type for e in events] == [EventType.STEP_STARTED, EventType.STEP_FINISHED, EventType.RUN_ERROR]
    error = events[-1].model_dump(by_alias=True)
    assert error["code"] == expected and error["runId"] == "run-1"
    assert "s3cr3t" not in error["message"]
    assert result.error_code is RunErrorCode(expected)


async def test_exception_during_the_stream_becomes_a_sanitised_error_and_open_steps_are_finished() -> None:
    source = emit(StepStartedEvent(step_name="a"), then=RuntimeError("s3cr3t"))
    events, result = await collect(source)
    assert [e.type for e in events] == [EventType.STEP_STARTED, EventType.STEP_FINISHED, EventType.RUN_ERROR]
    assert isinstance(events[1], StepFinishedEvent) and events[1].step_name == "a"
    assert "s3cr3t" not in events[-1].model_dump_json()
    assert result.error_code is RunErrorCode.INTERNAL and result.reference


async def test_timeout_emits_run_timeout_and_closes_the_source() -> None:
    closed = asyncio.Event()

    async def slow() -> AsyncIterator[BaseEvent]:
        try:
            yield RunStartedEvent(thread_id="t", run_id="r")
            await asyncio.sleep(30)
        finally:
            closed.set()

    events, result = await collect(slow(), deadline=0.2)
    assert [e.type for e in events] == [EventType.RUN_STARTED, EventType.RUN_ERROR]
    assert events[-1].model_dump(by_alias=True)["code"] == "RUN_TIMEOUT"
    assert result.error_code is RunErrorCode.RUN_TIMEOUT
    assert closed.is_set()


def test_classification() -> None:
    assert classify_exception(RuntimeError("x")) is RunErrorCode.INTERNAL
    assert classify_exception(ChatClientException("x")) is RunErrorCode.LLM_UNAVAILABLE
    assert classify_exception(httpx.ConnectError("x")) is RunErrorCode.LLM_UNAVAILABLE
    api_error = openai.APIConnectionError(request=httpx.Request("POST", "http://x"))  # pyright: ignore[reportArgumentType]
    assert classify_exception(api_error) is RunErrorCode.LLM_UNAVAILABLE
    assert classify_exception(McpUnavailableError("x")) is RunErrorCode.BACKLOG_UNAVAILABLE
    assert classify_exception(McpToolError("x", 503, "unavailable", "down")) is RunErrorCode.BACKLOG_UNAVAILABLE
    assert classify_exception(ProblemError(403, "forbidden")) is RunErrorCode.FORBIDDEN
    assert classify_exception(ProblemError(404, "not-found")) is RunErrorCode.NOT_FOUND
    try:
        try:
            raise httpx.ConnectError("x")
        except httpx.ConnectError as inner:
            raise RuntimeError("wrapped") from inner
    except RuntimeError as wrapped:
        assert classify_exception(wrapped) is RunErrorCode.LLM_UNAVAILABLE
