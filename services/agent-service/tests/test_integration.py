"""Cross-cutting integration checks through the AG-UI endpoint: hidden write tools, thread privacy, token forwarding on
resume, the retry cap on the write path, restarts (a new app instance on the same database) and thread status.

Per-scenario event streams are in ``test_golden.py``; single tools in ``test_agent_tools.py``.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

import httpx
import pytest
from agent_framework_ag_ui import AGUIThreadSnapshot
from asgi_lifespan import LifespanManager

from agent_service.auth.tokens import StaticKeySource
from agent_service.main import create_app
from agent_service.settings import Settings
from agent_service.threads import derive_status
from agent_service_testkit import API, TokenFactory, create_thread, event_types, parse_sse, run_agui
from conftest import BacklogMock
from golden_harness import ASK_USER_TOOL, HIDDEN_WRITE_TOOLS, SPA_STATE
from test_agent_tools import PROPOSAL, STATE, call, decision, propose, resume, script, tool_result_of
from test_refiner_agent import ASK_USER, BOB, USER, llm_requests, mcp_calls, tool_names, tool_results

ALICE = "alice@example.test"
QUESTIONS = {"questions": [{"id": "q1", "header": "Scope", "question": "Which?", "options": [{"label": "A"}]}]}
ANSWER = {"id": "m2", "role": "tool", "toolCallId": "call_ask", "content": '{"status":"answered","answers":[]}'}
WRITES = HIDDEN_WRITE_TOOLS


def writes(calls: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [c for c in calls if c["tool"] in WRITES]


def bearer(tokens: TokenFactory, email: str) -> str:
    """A fresh access token of the user; the ``jti`` makes it differ from every other token of the same second."""
    return tokens.issue(email, extra={"jti": uuid.uuid4().hex})


async def post_run(
    client: httpx.AsyncClient,
    token: str,
    thread_id: str,
    *,
    messages: list[dict[str, Any]] | None = None,
    resume_with: list[dict[str, Any]] | None = None,
    state: dict[str, Any] | None = None,
) -> tuple[int, list[dict[str, Any]]]:
    body: dict[str, Any] = {
        "threadId": thread_id,
        "runId": "run-integration",
        "messages": messages or [],
        "tools": [],
        "context": [],
        "forwardedProps": {},
        "state": dict(STATE) if state is None else state,
    }
    if resume_with is not None:
        body["resume"] = resume_with
    response = await client.post(
        f"{API}/agents/backlog-refiner", json=body, headers={"Authorization": f"Bearer {token}"}
    )
    events = parse_sse(response.text) if response.headers["content-type"].startswith("text/event-stream") else []
    return response.status_code, events


# --- hidden write tools ---------------------------------------------------------------------------------------------


async def test_a_model_cannot_call_the_hidden_write_tools_by_name(
    rclient: httpx.AsyncClient, tokens: TokenFactory, gateway: httpx.AsyncClient, mcp: httpx.AsyncClient
) -> None:
    arguments = {"projectId": "p", "itemId": "i", "baseVersion": 1, "sections": [], "children": [], "quality": {}}
    await script(
        gateway,
        {
            "tool_calls": [
                {"id": f"hidden_{name}", "name": name, "arguments": arguments} for name in sorted(HIDDEN_WRITE_TOOLS)
            ]
        },
        {"text": "Could not do that."},
    )
    thread = await create_thread(rclient, tokens)
    status, events = await run_agui(rclient, tokens, thread["id"], [USER], tools=[ASK_USER])
    assert status == 200
    requests = await llm_requests(gateway)
    assert all(not tool_names(r) & WRITES for r in requests)
    assert tool_results(requests[-1]) == [f'Error: Requested function "{n}" not found.' for n in sorted(WRITES)]
    assert not writes(await mcp_calls(mcp))
    assert event_types(events)[-1] == "RUN_FINISHED"


async def test_a_client_declared_tool_named_like_a_write_tool_never_reaches_the_backlog(
    rclient: httpx.AsyncClient, tokens: TokenFactory, gateway: httpx.AsyncClient, mcp: httpx.AsyncClient
) -> None:
    """``tools[]`` is client-owned: a declared tool is only ever handed back to the client, never executed here."""
    declared = {
        "name": "apply_document_changes",
        "description": "x",
        "parameters": {"type": "object", "properties": {}},
    }
    arguments = {"projectId": "p", "itemId": "i", "baseVersion": 1, "sections": []}
    await script(gateway, call("apply_document_changes", arguments, "client_call"))
    thread = await create_thread(rclient, tokens)
    status, events = await run_agui(rclient, tokens, thread["id"], [USER], tools=[declared])
    assert status == 200
    assert not writes(await mcp_calls(mcp))
    assert not [e for e in events if e["type"] == "TOOL_CALL_RESULT"]  # left for the client to answer


# --- thread privacy -------------------------------------------------------------------------------------------------


async def test_another_user_cannot_hydrate_resume_or_run_a_thread_and_the_owner_is_unaffected(
    rclient: httpx.AsyncClient, tokens: TokenFactory, gateway: httpx.AsyncClient, mcp: httpx.AsyncClient
) -> None:
    thread_id, _, interrupt = await propose(rclient, tokens, gateway, "propose_document_changes", PROPOSAL)
    model_requests = len(await llm_requests(gateway))
    mcp_before = len(await mcp_calls(mcp))
    attempts: dict[str, dict[str, Any]] = {
        "hydrate": {"messages": []},
        "resume": {"messages": [], "resume": decision(interrupt, True, PROPOSAL)},
        "cancel": {"messages": [], "resume": [{"interruptId": interrupt["id"], "status": "cancelled"}]},
        "run": {"messages": [USER]},
    }
    for label, extra in attempts.items():
        status, events = await run_agui(
            rclient, tokens, thread_id, extra["messages"], email=BOB, state=dict(STATE), resume=extra.get("resume")
        )
        assert (status, events) == (404, []), label
    assert len(await llm_requests(gateway)) == model_requests
    assert len(await mcp_calls(mcp)) == mcp_before  # MAF never ran: not even the per-run context reads

    # Bob's attempts changed nothing: alice still sees her pending review and can apply it.
    listed = await rclient.get(f"{API}/threads", headers=tokens.headers())
    assert [t["status"] for t in listed.json()["items"]] == ["awaiting_review"]
    _, hydrated = await run_agui(rclient, tokens, thread_id, [], state=dict(STATE))
    assert hydrated[-1]["outcome"]["interrupts"][0]["id"] == interrupt["id"]
    events = await resume(rclient, tokens, thread_id, interrupt, True, PROPOSAL)
    assert json.loads(tool_result_of(events))["applied"] == ["s1", "s2", "s3"]


# --- token forwarding -----------------------------------------------------------------------------------------------


async def test_the_resume_after_an_approval_uses_the_current_request_token(
    rclient: httpx.AsyncClient, tokens: TokenFactory, gateway: httpx.AsyncClient, mcp: httpx.AsyncClient
) -> None:
    first, refreshed = bearer(tokens, ALICE), bearer(tokens, ALICE)
    assert first != refreshed
    await script(gateway, call("propose_document_changes", PROPOSAL), {"text": "Done."})
    thread = await create_thread(rclient, tokens)
    status, events = await post_run(rclient, first, thread["id"], messages=[USER])
    assert status == 200
    interrupt = events[-1]["outcome"]["interrupts"][0]
    assert {c["authorization"] for c in await mcp_calls(mcp)} == {f"Bearer {first}"}

    status, _ = await post_run(rclient, refreshed, thread["id"], resume_with=decision(interrupt, True, PROPOSAL))
    assert status == 200
    (apply,) = writes(await mcp_calls(mcp))
    assert apply["authorization"] == f"Bearer {refreshed}"
    # Every MCP request of the resume run (context reads and the write) carries the refreshed token only.
    resumed = [c for c in await mcp_calls(mcp) if c["authorization"] == f"Bearer {refreshed}"]
    assert apply in resumed and len(resumed) >= 2
    assert all(
        entry["authorization"] in (f"Bearer {first}", f"Bearer {refreshed}")
        for entry in (await mcp.get("/_http_log")).json()
    )


async def test_concurrent_approvals_apply_with_their_own_users_tokens(
    rclient: httpx.AsyncClient, tokens: TokenFactory, gateway: httpx.AsyncClient, mcp: httpx.AsyncClient
) -> None:
    users = {ALICE: bearer(tokens, ALICE), BOB: bearer(tokens, BOB)}
    threads: dict[str, tuple[str, dict[str, Any]]] = {}
    for email, token in users.items():
        await script(gateway, call("propose_document_changes", PROPOSAL, f"call_{email[:3]}"))
        thread = await create_thread(rclient, tokens, email)
        status, events = await post_run(rclient, token, thread["id"], messages=[USER])
        assert status == 200
        threads[email] = (thread["id"], events[-1]["outcome"]["interrupts"][0])
    await mcp.post("/_config", json={"delay": 0.15})  # make the two applies overlap
    await gateway.post("/_script", json={"rules": [{"turn": {"text": "Done."}}]})
    results = await asyncio.gather(
        *(
            post_run(rclient, users[email], thread_id, resume_with=decision(interrupt, True, PROPOSAL))
            for email, (thread_id, interrupt) in threads.items()
        )
    )
    assert [status for status, _ in results] == [200, 200]
    applies = writes(await mcp_calls(mcp))
    assert sorted(a["authorization"] for a in applies) == sorted(f"Bearer {t}" for t in users.values())


# --- retry cap on the write path -----------------------------------------------------------------------------------


async def test_the_retry_cap_stops_a_tool_that_writes_to_the_backlog(
    rclient: httpx.AsyncClient, tokens: TokenFactory, gateway: httpx.AsyncClient, mcp: httpx.AsyncClient
) -> None:
    invalid = {"overall": "bogus", "areas": [], "summary": "x"}
    valid = {
        "overall": "ready",
        "areas": [{"area": "problem", "level": "clear"}],
        "summary": "Fine",
        "documentHash": "h",
    }
    await script(
        gateway,
        call("record_quality_assessment", invalid, "q1"),
        call("record_quality_assessment", invalid, "q2"),
        call("record_quality_assessment", valid, "q3"),
        {"text": "I could not store the assessment."},
    )
    thread = await create_thread(rclient, tokens)
    status, _ = await run_agui(rclient, tokens, thread["id"], [USER], state=dict(STATE))
    assert status == 200
    requests = await llm_requests(gateway)
    first, second, third = (tool_results(requests[i])[-1] for i in (1, 2, 3))
    assert "Fix the arguments and call record_quality_assessment again" in first
    assert "Do not call record_quality_assessment again" in second
    assert "Do not call record_quality_assessment again" in third  # the valid third call is not executed
    assert not writes(await mcp_calls(mcp))
    assert len(requests) == 4


# --- restarts: a new app instance on the same database --------------------------------------------------------------

AppBuilder = Callable[[], Awaitable[httpx.AsyncClient]]


@pytest.fixture
async def new_instance(
    settings: Settings, tokens: TokenFactory, backlog: BacklogMock, mcp_url: str, mcp: httpx.AsyncClient, rclient: Any
) -> AsyncIterator[AppBuilder]:
    """Builds another app on the database of ``rclient``'s app (not truncated), like a restarted process."""
    from contextlib import AsyncExitStack

    del rclient  # the first instance (and the truncated database); this fixture adds more
    stack = AsyncExitStack()

    async def build() -> httpx.AsyncClient:
        application = create_app(
            settings.model_copy(update={"backlog_api_url": mcp_url}),
            key_source=StaticKeySource(tokens.jwks),
            backlog_transport=httpx.MockTransport(backlog.handler),
            configure_logs=False,
        )
        await stack.enter_async_context(LifespanManager(application, startup_timeout=30))
        return await stack.enter_async_context(
            httpx.AsyncClient(transport=httpx.ASGITransport(app=application), base_url="http://agent-service.test")
        )

    try:
        yield build
    finally:
        await stack.aclose()


async def test_approval_after_a_restart_is_reported_as_expired_and_nothing_is_applied(
    rclient: httpx.AsyncClient,
    new_instance: AppBuilder,
    tokens: TokenFactory,
    gateway: httpx.AsyncClient,
    mcp: httpx.AsyncClient,
) -> None:
    thread_id, _, interrupt = await propose(rclient, tokens, gateway, "propose_document_changes", PROPOSAL)
    restarted = await new_instance()
    await gateway.post("/_reset")  # drops the unused final answer that propose() queued
    await gateway.post("/_script", json={"rules": [{"turn": {"text": "Back again."}}]})
    model_requests = 0

    for resume_entries in (
        decision(interrupt, True, PROPOSAL),
        [{"interruptId": interrupt["id"], "status": "cancelled"}],
    ):
        status, events = await run_agui(restarted, tokens, thread_id, [], state=dict(STATE), resume=resume_entries)
        assert status == 200
        assert event_types(events)[-1] == "RUN_ERROR"
        error = events[-1]
        assert error["code"] == "APPROVAL_RESUME_NOT_FOUND"
        assert error["message"] == "This proposal is no longer available. Ask the assistant to propose it again."
    assert not writes(await mcp_calls(mcp))
    assert len(await llm_requests(gateway)) == model_requests

    # The conversation is usable again: the stale review is gone and a new message runs.
    status, hydrated = await run_agui(restarted, tokens, thread_id, [], state=dict(STATE))
    assert status == 200 and "outcome" not in hydrated[-1]
    listed = await restarted.get(f"{API}/threads", headers=tokens.headers())
    assert [t["status"] for t in listed.json()["items"]] == ["idle"]
    status, events = await run_agui(restarted, tokens, thread_id, [USER], state=dict(STATE))
    assert status == 200
    assert event_types(events)[-1] == "RUN_FINISHED"
    assert "Back again." in "".join(e.get("delta", "") for e in events if e["type"] == "TEXT_MESSAGE_CONTENT")


async def test_a_new_instance_restores_the_transcript_and_the_pending_question_and_continues_it(
    rclient: httpx.AsyncClient,
    new_instance: AppBuilder,
    tokens: TokenFactory,
    gateway: httpx.AsyncClient,
) -> None:
    await script(gateway, {"text": "Let me ask.", **call("ask_user", QUESTIONS, "call_ask")}, {"text": "Thanks!"})
    thread = await create_thread(rclient, tokens)
    status, _ = await run_agui(rclient, tokens, thread["id"], [USER], state=dict(SPA_STATE), tools=[ASK_USER_TOOL])
    assert status == 200

    restarted = await new_instance()
    requests_before = len(await llm_requests(gateway))
    status, events = await run_agui(restarted, tokens, thread["id"], [], state=dict(STATE))
    assert status == 200
    messages = next(e for e in events if e["type"] == "MESSAGES_SNAPSHOT")["messages"]
    assert [m["role"] for m in messages] == ["user", "assistant", "assistant"]
    (pending,) = messages[-1]["toolCalls"]
    assert (pending["id"], pending["function"]["name"]) == ("call_ask", "ask_user")
    listed = await restarted.get(f"{API}/threads", headers=tokens.headers())
    assert [t["status"] for t in listed.json()["items"]] == ["awaiting_input"]
    assert len(await llm_requests(gateway)) == requests_before

    status, events = await run_agui(
        restarted, tokens, thread["id"], [ANSWER], state=dict(SPA_STATE), tools=[ASK_USER_TOOL]
    )
    assert status == 200
    sent = (await llm_requests(gateway))[-1]["messages"]
    assert [m["role"] for m in sent if m["role"] != "system"] == ["user", "assistant", "assistant", "tool"]
    assert sent[-1]["tool_call_id"] == "call_ask"
    listed = await restarted.get(f"{API}/threads", headers=tokens.headers())
    assert [t["status"] for t in listed.json()["items"]] == ["idle"]


# --- thread status --------------------------------------------------------------------------------------------------


def _call(call_id: str, name: str) -> dict[str, Any]:
    return {"id": call_id, "type": "function", "function": {"name": name, "arguments": "{}"}}


@pytest.mark.parametrize(
    ("messages", "expected"),
    [
        ([{"role": "assistant", "toolCalls": [_call("a", "ask_user")]}], "awaiting_input"),
        (
            [{"role": "assistant", "toolCalls": [_call("a", "ask_user")]}, {"role": "tool", "toolCallId": "a"}],
            "idle",
        ),
        # a user message after the question dismisses it (the stored transcript has no synthetic result)
        (
            [{"role": "assistant", "toolCalls": [_call("a", "ask_user")]}, {"role": "user", "content": "[dismissed]"}],
            "idle",
        ),
        # a proposal without an interrupt (for example after a restart) is not pending input
        ([{"role": "assistant", "toolCalls": [_call("p", "propose_document_changes")]}], "idle"),
        ([{"role": "assistant", "toolCalls": [_call("p", "propose_document_changes")]}, {"role": "user"}], "idle"),
        (
            [
                {"role": "assistant", "toolCalls": [_call("a", "ask_user")]},
                {"role": "user", "content": "dismissed"},
                {"role": "assistant", "toolCalls": [_call("b", "ask_user")]},
            ],
            "awaiting_input",
        ),
    ],
)
def test_thread_status_is_derived_from_the_transcript(messages: list[dict[str, Any]], expected: str) -> None:
    assert derive_status(AGUIThreadSnapshot(messages=messages)) == expected


def test_a_pending_interrupt_wins_over_everything() -> None:
    snapshot = AGUIThreadSnapshot(messages=[], interrupt=[{"id": "af-call-1", "reason": "tool_call"}])
    assert derive_status(snapshot) == "awaiting_review"
