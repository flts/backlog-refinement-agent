"""AG-UI endpoint: thread access checks, identity binding, snapshot round trip and thread status."""

from __future__ import annotations

import asyncio
from typing import Any

import httpx
import pytest
from agent_framework import Agent, tool
from agent_framework_ag_ui import AGUIThreadSnapshotStore
from asgi_lifespan import LifespanManager
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from agent_service.agents import AgentRegistry, make_runner
from agent_service.auth import current_principal, current_token
from agent_service.auth.tokens import StaticKeySource
from agent_service.db.models import Thread, ThreadSnapshot
from agent_service.llm import create_chat_client
from agent_service.main import create_app
from agent_service.settings import Settings
from agent_service_testkit import (
    API,
    ITEM_ID,
    OTHER_ITEM_ID,
    PROJECT_ID,
    TokenFactory,
    create_thread,
    event_types,
    run_agui,
)
from conftest import BACKLOG_URL, BacklogMock, truncate_all

BOB = "bob@example.test"
USER_MESSAGE = {"id": "m1", "role": "user", "content": "hello"}
ASK_USER_TOOL = {
    "name": "ask_user",
    "description": "Ask the user a question.",
    "parameters": {"type": "object", "properties": {"questions": {"type": "array"}}},
}

seen: list[dict[str, Any]] = []


def probe_registry(settings: Settings, store: AGUIThreadSnapshotStore) -> AgentRegistry:
    @tool(approval_mode="never_require")
    async def whoami(label: str) -> str:
        """Record who the run acts for."""
        await asyncio.sleep(0.05)  # let concurrent runs interleave
        seen.append({"label": label, "token": current_token(), "email": getattr(current_principal(), "email", None)})
        await asyncio.sleep(0.05)
        seen.append({"label": label, "token_after": current_token()})
        return "ok"

    @tool(approval_mode="always_require")
    async def propose(summary: str) -> str:
        """Propose a change (needs approval)."""
        return "applied"

    agent = Agent(
        client=create_chat_client(settings),
        name="backlog-refiner",
        instructions="test",
        tools=[whoami, propose],
    )
    return AgentRegistry({"backlog-refiner": make_runner(agent, snapshot_store=store)})


@pytest.fixture
async def probe_app(settings: Settings, tokens: TokenFactory, database_url: str, backlog: BacklogMock) -> Any:
    await truncate_all(database_url)
    seen.clear()
    application = create_app(
        settings,
        key_source=StaticKeySource(tokens.jwks),
        registry_factory=probe_registry,
        backlog_transport=httpx.MockTransport(backlog.handler),
        configure_logs=False,
    )
    async with LifespanManager(application, startup_timeout=30):
        yield application


@pytest.fixture
async def probe_client(probe_app: FastAPI) -> Any:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=probe_app), base_url="http://agent-service.test", timeout=30
    ) as http:
        yield http


async def script_tool_then_text(gateway: httpx.AsyncClient, name: str, arguments: dict[str, Any], text: str) -> None:
    await gateway.post(
        "/_script",
        json={
            "rules": [
                {"last_role": "user", "turn": {"tool_calls": [{"name": name, "arguments": arguments}]}},
                {"last_role": "tool", "turn": {"text": text}},
            ]
        },
    )


async def status_of(client: httpx.AsyncClient, tokens: TokenFactory, thread_id: str) -> str:
    listed = await client.get(f"{API}/threads", headers=tokens.headers())
    return next(item["status"] for item in listed.json()["items"] if item["id"] == thread_id)


# --- access checks ---------------------------------------------------------------------------------------------------


async def test_echo_agent_run(client: httpx.AsyncClient, tokens: TokenFactory, gateway: httpx.AsyncClient) -> None:
    await gateway.post("/_script", json={"responses": [{"text": "Echo: hello"}]})
    thread = await create_thread(client, tokens)
    status, events = await run_agui(client, tokens, thread["id"], [USER_MESSAGE])
    assert status == 200
    types = event_types(events)
    assert types[0] == "RUN_STARTED"
    assert types[-1] == "RUN_FINISHED"
    assert "Echo: hello" in "".join(e.get("delta", "") for e in events if e["type"] == "TEXT_MESSAGE_CONTENT")


async def test_unknown_agent_is_404_problem(client: httpx.AsyncClient, tokens: TokenFactory) -> None:
    thread = await create_thread(client, tokens)
    response = await client.post(
        f"{API}/agents/nope", json={"threadId": thread["id"], "messages": []}, headers=tokens.headers()
    )
    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["type"] == "/problems/agent-not-found"


async def test_unknown_thread_is_404(client: httpx.AsyncClient, tokens: TokenFactory) -> None:
    status, _ = await run_agui(client, tokens, "00000000-0000-4000-8000-000000000000", [USER_MESSAGE])
    assert status == 404


async def test_other_users_thread_is_404_and_runs_nothing(
    client: httpx.AsyncClient, tokens: TokenFactory, gateway: httpx.AsyncClient
) -> None:
    thread = await create_thread(client, tokens)
    status, _ = await run_agui(client, tokens, thread["id"], [USER_MESSAGE], email=BOB)
    assert status == 404
    assert (await gateway.get("/_requests")).json() == []


async def test_missing_thread_id_is_400(client: httpx.AsyncClient, tokens: TokenFactory) -> None:
    response = await client.post(f"{API}/agents/backlog-refiner", json={"messages": []}, headers=tokens.headers())
    assert response.status_code == 400


@pytest.mark.parametrize("key", ["itemId", "projectId"])
async def test_mismatched_state_is_400(
    client: httpx.AsyncClient, tokens: TokenFactory, gateway: httpx.AsyncClient, key: str
) -> None:
    thread = await create_thread(client, tokens)
    state = {"schemaVersion": 1, "projectId": PROJECT_ID, "itemId": ITEM_ID, key: OTHER_ITEM_ID}
    status, _ = await run_agui(client, tokens, thread["id"], [USER_MESSAGE], state=state)
    assert status == 400
    assert (await gateway.get("/_requests")).json() == []
    response = await client.post(
        f"{API}/agents/backlog-refiner",
        json={"threadId": thread["id"], "messages": [], "state": state},
        headers=tokens.headers(),
    )
    assert response.json()["type"] == "/problems/thread-mismatch"


async def test_body_over_agui_limit_is_413(client: httpx.AsyncClient, tokens: TokenFactory) -> None:
    thread = await create_thread(client, tokens)
    big = {"id": "m", "role": "user", "content": "x" * (300 * 1024)}
    response = await client.post(
        f"{API}/agents/backlog-refiner",
        json={"threadId": thread["id"], "messages": [big]},
        headers=tokens.headers(),
    )
    assert response.status_code == 413


# --- identity binding ------------------------------------------------------------------------------------------------


async def test_scope_resolver_is_user_email(
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    gateway: httpx.AsyncClient,
    sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    await gateway.post("/_script", json={"responses": [{"text": "hi"}]})
    thread = await create_thread(client, tokens, "  Alice@Example.test")
    await run_agui(client, tokens, thread["id"], [USER_MESSAGE], email="  Alice@Example.test")
    async with sessionmaker() as session:
        scopes = (await session.execute(select(ThreadSnapshot.scope, ThreadSnapshot.thread_id))).all()
    assert [tuple(row) for row in scopes] == [("user:alice@example.test", thread["id"])]


async def test_token_and_principal_are_bound_per_run_without_leaking(
    probe_client: httpx.AsyncClient, tokens: TokenFactory, gateway: httpx.AsyncClient
) -> None:
    await script_tool_then_text(gateway, "whoami", {"label": "x"}, "done")
    people = ["alice@example.test", "bob@example.test", "carol@example.test"]
    issued = {email: tokens.issue(email) for email in people}
    threads = {email: await create_thread(probe_client, tokens, email) for email in people}

    async def one(email: str) -> int:
        response = await probe_client.post(
            f"{API}/agents/backlog-refiner",
            json={
                "threadId": threads[email]["id"],
                "runId": f"r-{email}",
                "messages": [{"id": f"m-{email}", "role": "user", "content": "go"}],
                "state": {"schemaVersion": 1, "projectId": PROJECT_ID, "itemId": ITEM_ID},
            },
            headers={"Authorization": f"Bearer {issued[email]}"},
        )
        return response.status_code

    assert await asyncio.gather(*(one(email) for email in people)) == [200, 200, 200]
    bound = [entry for entry in seen if "email" in entry]
    assert sorted(entry["email"] for entry in bound) == sorted(people)
    for entry in bound:
        assert entry["token"] == issued[entry["email"]]
    assert all(entry["token_after"] is not None for entry in seen if "token_after" in entry)
    assert current_token() is None
    assert current_principal() is None


# --- snapshot store round trip and thread status ---------------------------------------------------------------------


async def test_snapshot_round_trip_and_hydrate(
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    gateway: httpx.AsyncClient,
    sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    await gateway.post("/_script", json={"responses": [{"text": "Echo: hello"}]})
    thread = await create_thread(client, tokens)
    await run_agui(client, tokens, thread["id"], [USER_MESSAGE])
    async with sessionmaker() as session:
        row = await session.get(ThreadSnapshot, ("user:alice@example.test", thread["id"]))
        assert row is not None
        assert [m["role"] for m in row.messages] == ["user", "assistant"]
        stored = await session.get(Thread, thread["id"])
        assert stored is not None
        assert stored.status == "idle"
        assert stored.last_run_at is not None

    calls_before = len((await gateway.get("/_requests")).json())
    status, events = await run_agui(client, tokens, thread["id"], [])
    assert status == 200
    types = event_types(events)
    assert "MESSAGES_SNAPSHOT" in types
    assert types[-1] == "RUN_FINISHED"
    snapshot = next(e for e in events if e["type"] == "MESSAGES_SNAPSHOT")
    assert [m["role"] for m in snapshot["messages"]] == ["user", "assistant"]
    assert len((await gateway.get("/_requests")).json()) == calls_before  # hydrate never calls the model


async def test_ask_user_sets_awaiting_input_then_idle(
    probe_client: httpx.AsyncClient, tokens: TokenFactory, gateway: httpx.AsyncClient
) -> None:
    questions = {"questions": [{"id": "q1", "header": "Scope", "question": "Which?", "options": [{"label": "A"}]}]}
    await gateway.post(
        "/_script",
        json={
            "responses": [
                {"text": "Let me ask.", "tool_calls": [{"id": "call_ask", "name": "ask_user", "arguments": questions}]}
            ]
        },
    )
    thread = await create_thread(probe_client, tokens)
    status, events = await run_agui(probe_client, tokens, thread["id"], [USER_MESSAGE], tools=[ASK_USER_TOOL])
    assert status == 200
    assert events[-1]["type"] == "RUN_FINISHED"
    assert await status_of(probe_client, tokens, thread["id"]) == "awaiting_input"

    # Hydrating keeps the status (the pending client tool call is restored from the snapshot).
    await run_agui(probe_client, tokens, thread["id"], [])
    assert await status_of(probe_client, tokens, thread["id"]) == "awaiting_input"

    await gateway.post("/_script", json={"responses": [{"text": "Thanks!"}]})
    answer = {"id": "m2", "role": "tool", "toolCallId": "call_ask", "content": '{"status":"answered","answers":[]}'}
    status, _ = await run_agui(probe_client, tokens, thread["id"], [answer], tools=[ASK_USER_TOOL])
    assert status == 200
    assert await status_of(probe_client, tokens, thread["id"]) == "idle"


async def test_pending_approval_sets_awaiting_review(
    probe_client: httpx.AsyncClient, tokens: TokenFactory, gateway: httpx.AsyncClient
) -> None:
    await script_tool_then_text(gateway, "propose", {"summary": "s"}, "done")
    thread = await create_thread(probe_client, tokens)
    status, events = await run_agui(probe_client, tokens, thread["id"], [USER_MESSAGE])
    assert status == 200
    finished = events[-1]
    assert finished["type"] == "RUN_FINISHED"
    interrupts = finished["outcome"]["interrupts"]
    assert await status_of(probe_client, tokens, thread["id"]) == "awaiting_review"

    resume = [{"interruptId": interrupts[0]["id"], "status": "resolved", "payload": {"approved": True}}]
    status, _ = await run_agui(probe_client, tokens, thread["id"], [], resume=resume)
    assert status == 200
    assert await status_of(probe_client, tokens, thread["id"]) == "idle"


async def test_agui_membership_is_not_rechecked_with_backlog_per_run(
    client: httpx.AsyncClient, tokens: TokenFactory, gateway: httpx.AsyncClient, backlog: BacklogMock
) -> None:
    await gateway.post("/_script", json={"responses": [{"text": "ok"}]})
    thread = await create_thread(client, tokens)
    before = len(backlog.requests)
    await run_agui(client, tokens, thread["id"], [USER_MESSAGE])
    assert len(backlog.requests) == before
    assert BACKLOG_URL
