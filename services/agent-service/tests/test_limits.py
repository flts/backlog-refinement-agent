"""Run admission (429 rate limit, 409 thread busy), run timeout and sanitized run errors."""

from __future__ import annotations

import asyncio
import logging

import httpx
import pytest
from agent_framework import Agent, tool
from agent_framework_ag_ui import AGUIThreadSnapshotStore

from agent_service.agents import AgentRegistry, make_runner
from agent_service.limits import ThreadRunLocks, TokenBucketLimiter, retry_after_header
from agent_service.llm import create_chat_client
from agent_service.settings import Settings
from agent_service_testkit import API, TokenFactory, create_thread, run_agui
from conftest import AppFactory

USER = {"id": "m1", "role": "user", "content": "hello"}
SECRET = "s3cr3t-tool-failure-detail"


def error_event(events: list[dict[str, object]]) -> dict[str, object]:
    errors = [e for e in events if e["type"] == "RUN_ERROR"]
    assert len(errors) == 1, [e["type"] for e in events]
    assert events[-1] is errors[0], "nothing may follow RUN_ERROR"
    return errors[0]


async def slow_turn(gateway: httpx.AsyncClient, seconds: float) -> None:
    await gateway.post("/_script", json={"responses": [{"text": "slow", "delay": seconds}]})


def test_token_bucket_refills_and_reports_retry_after() -> None:
    now = [0.0]
    limiter = TokenBucketLimiter(per_minute=60, burst=2, clock=lambda: now[0])
    assert limiter.try_acquire("a") is None
    assert limiter.try_acquire("a") is None
    wait = limiter.try_acquire("a")
    assert wait is not None and wait == pytest.approx(1.0)
    assert limiter.try_acquire("b") is None  # per key
    now[0] += 1.0
    assert limiter.try_acquire("a") is None
    assert retry_after_header(0.2) == "1"
    assert retry_after_header(2.1) == "3"


def test_disabled_limiter_admits_everything() -> None:
    limiter = TokenBucketLimiter(per_minute=0, burst=1)
    assert all(limiter.try_acquire("a") is None for _ in range(100))


def test_thread_locks_are_exclusive_and_release_is_idempotent() -> None:
    locks = ThreadRunLocks()
    permit = locks.try_acquire("user:a", "t1")
    assert permit is not None
    assert locks.try_acquire("user:a", "t1") is None
    assert locks.try_acquire("user:a", "t2") is not None
    permit.release()
    permit.release()
    assert locks.try_acquire("user:a", "t1") is not None


async def test_rate_limit_returns_429_with_retry_after_before_streaming(
    app_factory: AppFactory, tokens: TokenFactory, gateway: httpx.AsyncClient
) -> None:
    client = await app_factory(rate_limit_runs_per_minute=1, rate_limit_burst=1)
    first = await create_thread(client, tokens)
    second = await create_thread(client, tokens, item_id="22222222-2222-4222-8222-222222222222")
    status, events = await run_agui(client, tokens, first["id"], [USER])
    assert status == 200 and events[-1]["type"] == "RUN_FINISHED"

    response = await client.post(
        f"{API}/agents/backlog-refiner",
        json={"threadId": second["id"], "runId": "r2", "messages": [USER], "tools": [], "context": [], "state": {}},
        headers=tokens.headers(),
    )
    assert response.status_code == 429
    assert response.headers["content-type"].startswith("application/problem+json")
    assert 1 <= int(response.headers["retry-after"]) <= 60
    body = response.json()
    assert body["type"].endswith("/rate-limited")
    assert body["retryAfter"] == int(response.headers["retry-after"])

    # another user has their own bucket, and hydrate requests are not limited
    other = await create_thread(client, tokens, "bob@example.test")
    assert (await run_agui(client, tokens, other["id"], [USER], email="bob@example.test"))[0] == 200
    assert (await run_agui(client, tokens, first["id"], []))[0] == 200


async def test_second_run_of_a_busy_thread_is_409_and_the_lock_is_released_afterwards(
    app_factory: AppFactory, tokens: TokenFactory, gateway: httpx.AsyncClient
) -> None:
    client = await app_factory()
    thread = await create_thread(client, tokens)
    await slow_turn(gateway, 0.6)
    first = asyncio.create_task(run_agui(client, tokens, thread["id"], [USER]))
    await asyncio.sleep(0.3)

    status, events = await run_agui(client, tokens, thread["id"], [USER])
    assert status == 409 and events == []
    response = await client.post(
        f"{API}/agents/backlog-refiner",
        json={"threadId": thread["id"], "runId": "r", "messages": [USER], "tools": [], "context": [], "state": {}},
        headers=tokens.headers(),
    )
    assert response.json()["type"].endswith("/thread-busy")
    # hydrate is allowed while a run is active
    assert (await run_agui(client, tokens, thread["id"], []))[0] == 200

    first_status, first_events = await first
    assert first_status == 200 and first_events[-1]["type"] == "RUN_FINISHED"
    assert (await run_agui(client, tokens, thread["id"], [USER]))[0] == 200


async def test_the_run_timeout_ends_the_stream_with_run_timeout_and_releases_the_lock(
    app_factory: AppFactory, tokens: TokenFactory, gateway: httpx.AsyncClient
) -> None:
    client = await app_factory(run_timeout_seconds=0.3)
    thread = await create_thread(client, tokens)
    await slow_turn(gateway, 5)
    status, events = await run_agui(client, tokens, thread["id"], [USER])
    assert status == 200
    error = error_event(events)
    assert error["code"] == "RUN_TIMEOUT"
    assert error["runId"]
    assert "0.3 seconds" in str(error["message"])

    status, events = await run_agui(client, tokens, thread["id"], [USER])  # lock released, thread usable again
    assert status == 200 and events[-1]["type"] in {"RUN_FINISHED", "RUN_ERROR"}


def failing_registry(settings: Settings, store: AGUIThreadSnapshotStore) -> AgentRegistry:
    @tool(approval_mode="never_require")
    async def explode() -> str:
        """Fails."""
        raise RuntimeError(SECRET)

    agent = Agent(client=create_chat_client(settings), name="backlog-refiner", instructions="t", tools=[explode])
    return AgentRegistry({"backlog-refiner": make_runner(agent, snapshot_store=store)})


async def test_unexpected_gateway_failure_is_llm_unavailable(
    app_factory: AppFactory, tokens: TokenFactory, gateway: httpx.AsyncClient
) -> None:
    client = await app_factory(llm_base_url="http://127.0.0.1:9")  # nothing listens there
    thread = await create_thread(client, tokens)
    status, events = await run_agui(client, tokens, thread["id"], [USER])
    assert status == 200
    error = error_event(events)
    assert error["code"] == "LLM_UNAVAILABLE"
    assert "127.0.0.1" not in str(error["message"])


class _ExplodingRunner:
    """Registry entry whose run raises while streaming (what MAF turns into ``code: <ExceptionClassName>``)."""

    name = "backlog-refiner"
    description = ""

    async def run(self, input_data: dict[str, object], **_: object):  # noqa: ANN202
        yield_nothing = False
        if yield_nothing:  # pragma: no cover - makes this an async generator
            yield None
        raise RuntimeError(f"boom {SECRET}")


async def test_internal_errors_are_sanitised_and_logged_server_side(
    app_factory: AppFactory, tokens: TokenFactory, caplog: pytest.LogCaptureFixture
) -> None:
    def registry(settings: Settings, store: AGUIThreadSnapshotStore) -> AgentRegistry:
        return AgentRegistry({"backlog-refiner": _ExplodingRunner()})  # type: ignore[dict-item]

    client = await app_factory(registry_factory=registry)
    thread = await create_thread(client, tokens)
    with caplog.at_level(logging.INFO):
        status, events = await run_agui(client, tokens, thread["id"], [USER])
    assert status == 200
    error = error_event(events)
    assert error["code"] == "INTERNAL"
    assert SECRET not in str(error) and "RuntimeError" not in str(error)
    assert "Reference: " in str(error["message"])
    reference = str(error["message"]).split("Reference: ")[1].rstrip(".")
    failure = next(r for r in caplog.records if r.getMessage() == "Run failed")
    assert failure.__dict__["reference"] == reference
    assert failure.exc_info is not None  # the details stay in the server log
    assert (await run_agui(client, tokens, thread["id"], [USER]))[0] == 200  # lock released after the failure
