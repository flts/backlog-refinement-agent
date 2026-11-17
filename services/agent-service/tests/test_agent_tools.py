"""The refiner's agent tools through the AG-UI endpoint (fake LLM gateway scripting tool calls, fake backlog MCP)."""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from typing import Any

import httpx
from backlog_contracts import AgentState, ChildLastApply
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from agent_service.db.models import Thread
from agent_service_testkit import PROJECT_ID, TokenFactory, create_thread, event_types, run_agui
from test_refiner_agent import USER, llm_requests, mcp_calls, tool_results

SECTIONS = [
    {"id": "s1", "heading": "Summary", "mode": "replace", "markdown": "New summary", "rationale": "clarity"},
    {"id": "s2", "heading": "Acceptance criteria", "mode": "append", "markdown": "- [ ] AC1"},
    {"id": "s3", "heading": "Open questions", "mode": "append", "markdown": "- [ ] Who approves?"},
]
PROPOSAL: dict[str, Any] = {"summary": "Tighten the item", "baseVersion": 7, "sections": SECTIONS}
STATE = {"schemaVersion": 1, "projectId": PROJECT_ID, "itemId": "22222222-2222-4222-8222-222222222222", "preview": None}


async def script(gateway: httpx.AsyncClient, *responses: dict[str, Any]) -> None:
    await gateway.post("/_script", json={"responses": list(responses)})


def call(name: str, arguments: dict[str, Any], call_id: str = "call_1") -> dict[str, Any]:
    return {"tool_calls": [{"id": call_id, "name": name, "arguments": arguments}]}


def last_state(events: list[dict[str, Any]]) -> dict[str, Any]:
    return [e for e in events if e["type"] == "STATE_SNAPSHOT"][-1]["snapshot"]


def finished(events: list[dict[str, Any]]) -> dict[str, Any]:
    return [e for e in events if e["type"] == "RUN_FINISHED"][-1]


def decision(interrupt: dict[str, Any], approved: bool, edited: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    payload: dict[str, Any] = {"approved": approved}
    if edited is not None:
        payload["editedArgs"] = edited
    return [{"interruptId": interrupt["id"], "status": "resolved", "payload": payload}]


async def propose(
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    gateway: httpx.AsyncClient,
    name: str,
    arguments: dict[str, Any],
    *,
    final: str = "Done.",
    more: tuple[dict[str, Any], ...] = (),
) -> tuple[str, list[dict[str, Any]], dict[str, Any]]:
    """Runs until the interrupt; returns ``(thread id, events, interrupt)``."""
    await script(gateway, call(name, arguments), *more, {"text": final})
    thread = await create_thread(client, tokens)
    status, events = await run_agui(client, tokens, thread["id"], [USER], state=dict(STATE))
    assert status == 200
    outcome = finished(events)["outcome"]
    assert outcome["type"] == "interrupt", event_types(events)
    return thread["id"], events, outcome["interrupts"][0]


async def resume(
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    thread_id: str,
    interrupt: dict[str, Any],
    approved: bool,
    edited: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    status, events = await run_agui(
        client, tokens, thread_id, [], state=dict(STATE), resume=decision(interrupt, approved, edited)
    )
    assert status == 200
    return events


def tool_result_of(events: list[dict[str, Any]]) -> str:
    content: str = next(e for e in events if e["type"] == "TOOL_CALL_RESULT")["content"]
    return json.loads(content) if content.startswith('"') else content


# --- propose_document_changes ---------------------------------------------------------------------------------------


async def test_approve_all_applies_with_the_users_token_and_clears_the_preview(
    rclient: httpx.AsyncClient, tokens: TokenFactory, gateway: httpx.AsyncClient, mcp: httpx.AsyncClient
) -> None:
    thread_id, events, interrupt = await propose(rclient, tokens, gateway, "propose_document_changes", PROPOSAL)
    types = event_types(events)
    assert types[0] == "RUN_STARTED"
    deltas = [e for e in events if e["type"] == "STATE_DELTA"]
    assert deltas[0]["delta"] == [{"op": "replace", "path": "/preview", "value": PROPOSAL}]
    assert types.index("STATE_DELTA") < types.index("TOOL_CALL_END") < types.index("RUN_FINISHED")
    assert interrupt["toolCallId"] == "call_1"
    assert not [c for c in await mcp_calls(mcp) if c["tool"] == "apply_document_changes"]

    events = await resume(rclient, tokens, thread_id, interrupt, True, PROPOSAL)
    (apply,) = [c for c in await mcp_calls(mcp) if c["tool"] == "apply_document_changes"]
    assert apply["authorization"].startswith("Bearer ")
    assert apply["arguments"]["baseVersion"] == 7
    assert [s["id"] for s in apply["arguments"]["sections"]] == ["s1", "s2", "s3"]
    assert apply["arguments"]["runId"]
    result = json.loads(tool_result_of(events))
    assert result == {
        "applied": ["s1", "s2", "s3"],
        "edited": [],
        "rejected": [],
        "conflicted": [],
        "newVersion": 8,
        "warnings": [],
        "titleApplied": False,
        "statusApplied": False,
    }
    state = last_state(events)
    assert state["preview"] is None
    last_apply = state["lastApply"]
    assert last_apply["toolCallId"] == "call_1"
    assert datetime.fromisoformat(last_apply["at"]).utcoffset() == timedelta(0)
    assert {k: v for k, v in last_apply.items() if k not in ("toolCallId", "at")} == result
    assert AgentState.model_validate({**STATE, "preview": None, "lastApply": last_apply}).last_apply is not None
    types = event_types(events)
    assert types.index("TOOL_CALL_RESULT") < max(i for i, t in enumerate(types) if t == "STATE_SNAPSHOT")
    assert finished(events).get("outcome", {}).get("type") != "interrupt"
    assert json.loads(tool_results((await llm_requests(gateway))[-1])[-1]) == result


async def test_partial_accept_with_edits_classifies_applied_edited_rejected(
    rclient: httpx.AsyncClient, tokens: TokenFactory, gateway: httpx.AsyncClient, mcp: httpx.AsyncClient
) -> None:
    proposal = {**PROPOSAL, "suggestedTitle": "Better title", "suggestedStatus": "ready"}
    thread_id, _, interrupt = await propose(rclient, tokens, gateway, "propose_document_changes", proposal)
    edited_section = {**SECTIONS[1], "markdown": "- [ ] AC1 (edited by the user)"}
    edited = {**proposal, "sections": [SECTIONS[0], edited_section]}  # s3 left out, title/status kept
    events = await resume(rclient, tokens, thread_id, interrupt, True, edited)
    (apply,) = [c for c in await mcp_calls(mcp) if c["tool"] == "apply_document_changes"]
    assert [s["id"] for s in apply["arguments"]["sections"]] == ["s1", "s2"]
    assert apply["arguments"]["sections"][1]["markdown"] == "- [ ] AC1 (edited by the user)"
    assert apply["arguments"]["suggestedTitle"] == "Better title"
    assert apply["arguments"]["suggestedStatus"] == "ready"
    result = json.loads(tool_result_of(events))
    assert result["applied"] == ["s1"]
    assert result["edited"] == ["s2"]
    assert result["rejected"] == ["s3"]
    assert result["titleApplied"] is True and result["statusApplied"] is True
    assert {k: v for k, v in last_state(events)["lastApply"].items() if k not in ("toolCallId", "at")} == result


async def test_conflicts_are_reported_to_the_model_and_the_ui(
    rclient: httpx.AsyncClient, tokens: TokenFactory, gateway: httpx.AsyncClient, mcp: httpx.AsyncClient
) -> None:
    await mcp.post("/_config", json={"conflicts": ["s2"]})
    thread_id, _, interrupt = await propose(rclient, tokens, gateway, "propose_document_changes", PROPOSAL)
    events = await resume(rclient, tokens, thread_id, interrupt, True, PROPOSAL)
    result = json.loads(tool_result_of(events))
    assert result["applied"] == ["s1", "s3"]
    assert [c["sectionId"] for c in result["conflicted"]] == ["s2"]
    assert result["conflicted"][0]["currentMarkdown"] == "Changed by someone else."
    assert last_state(events)["lastApply"]["conflicted"] == result["conflicted"]
    assert json.loads(tool_results((await llm_requests(gateway))[-1])[-1])["conflicted"][0]["sectionId"] == "s2"


async def test_reject_clears_the_preview_and_the_model_sees_the_rejection(
    rclient: httpx.AsyncClient, tokens: TokenFactory, gateway: httpx.AsyncClient, mcp: httpx.AsyncClient
) -> None:
    thread_id, events, interrupt = await propose(rclient, tokens, gateway, "propose_document_changes", PROPOSAL)
    assert last_state(events)["preview"] == PROPOSAL
    # The SPA resends the state it holds (still the preview); the service clears it for a rejection.
    status, events = await run_agui(
        rclient, tokens, thread_id, [], state={**STATE, "preview": PROPOSAL}, resume=decision(interrupt, False)
    )
    assert status == 200
    assert not [c for c in await mcp_calls(mcp) if c["tool"] == "apply_document_changes"]
    assert tool_results((await llm_requests(gateway))[-1])[-1] == "Error: Tool call invocation was rejected by user."
    assert finished(events).get("outcome", {}).get("type") != "interrupt"
    # The cleared preview is what the thread keeps: a hydrate of the stored thread shows no preview.
    _, hydrated = await run_agui(rclient, tokens, thread_id, [], state={"schemaVersion": 1})
    assert last_state(hydrated).get("preview") is None


async def test_edited_args_that_are_not_a_subset_are_rejected_and_nothing_is_applied(
    rclient: httpx.AsyncClient, tokens: TokenFactory, gateway: httpx.AsyncClient, mcp: httpx.AsyncClient
) -> None:
    thread_id, _, interrupt = await propose(rclient, tokens, gateway, "propose_document_changes", PROPOSAL)
    unknown = {**PROPOSAL, "sections": [{"id": "zzz", "heading": "Summary", "mode": "replace", "markdown": "x"}]}
    events = await resume(rclient, tokens, thread_id, interrupt, True, unknown)
    text = tool_result_of(events)
    assert text.startswith("Error: invalid arguments for propose_document_changes")
    assert "section 'zzz' is not part of the proposal" in text
    assert last_state(events)["preview"] is None
    assert not [c for c in await mcp_calls(mcp) if c["tool"] == "apply_document_changes"]


async def test_changing_heading_mode_or_base_version_is_rejected(
    rclient: httpx.AsyncClient, tokens: TokenFactory, gateway: httpx.AsyncClient, mcp: httpx.AsyncClient
) -> None:
    thread_id, _, interrupt = await propose(rclient, tokens, gateway, "propose_document_changes", PROPOSAL)
    renamed = {**PROPOSAL, "sections": [{**SECTIONS[0], "heading": "Something else"}]}
    events = await resume(rclient, tokens, thread_id, interrupt, True, renamed)
    assert "only the Markdown of section 's1' may be edited" in tool_result_of(events)
    assert "Fix the arguments" in tool_result_of(events)
    assert not [c for c in await mcp_calls(mcp) if c["tool"] == "apply_document_changes"]


async def test_invalid_edited_args_fail_validation_before_anything_is_applied(
    rclient: httpx.AsyncClient, tokens: TokenFactory, gateway: httpx.AsyncClient, mcp: httpx.AsyncClient
) -> None:
    thread_id, _, interrupt = await propose(rclient, tokens, gateway, "propose_document_changes", PROPOSAL)
    empty = {**PROPOSAL, "sections": []}
    events = await resume(rclient, tokens, thread_id, interrupt, True, empty)
    assert tool_result_of(events).startswith("Error: invalid arguments for propose_document_changes: sections:")
    assert not [c for c in await mcp_calls(mcp) if c["tool"] == "apply_document_changes"]


async def test_backlog_failure_is_reported_without_a_stale_preview(
    rclient: httpx.AsyncClient, tokens: TokenFactory, gateway: httpx.AsyncClient, mcp: httpx.AsyncClient
) -> None:
    await mcp.post(
        "/_config", json={"fail": {"apply_document_changes": {"status": 403, "type": "forbidden", "detail": "no"}}}
    )
    thread_id, _, interrupt = await propose(rclient, tokens, gateway, "propose_document_changes", PROPOSAL)
    events = await resume(rclient, tokens, thread_id, interrupt, True, PROPOSAL)
    assert "forbidden" in tool_result_of(events)
    assert last_state(events)["preview"] is None
    assert "lastApply" not in last_state(events)


# --- propose_child_items --------------------------------------------------------------------------------------------

CHILDREN: dict[str, Any] = {
    "rationale": "Split by user outcome",
    "childType": "user-story",
    "children": [
        {"proposalId": "c1", "title": "Story one", "markdown": "## Summary\n\nOne"},
        {"proposalId": "c2", "title": "Story two", "markdown": "## Summary\n\nTwo"},
        {"proposalId": "c3", "title": "Story three", "markdown": "## Summary\n\nThree"},
    ],
    "relationships": [
        {"sourceRef": "c1", "targetRef": "c2", "type": "depends-on"},
        {"sourceRef": "c3", "targetRef": "c1", "type": "related-to"},
        {"sourceRef": "c2", "targetRef": "c3", "type": "supports"},
    ],
}


async def test_breakdown_partial_accept_creates_children_and_skips_relationships(
    rclient: httpx.AsyncClient, tokens: TokenFactory, gateway: httpx.AsyncClient, mcp: httpx.AsyncClient
) -> None:
    thread_id, events, interrupt = await propose(rclient, tokens, gateway, "propose_child_items", CHILDREN)
    assert [e for e in events if e["type"] == "STATE_DELTA"][0]["delta"] == [
        {"op": "replace", "path": "/childPreview", "value": CHILDREN}
    ]
    edited_child = {**CHILDREN["children"][1], "title": "Story two (renamed)"}
    edited = {
        **CHILDREN,
        "children": [CHILDREN["children"][0], edited_child],  # c3 rejected
        "relationships": [CHILDREN["relationships"][0]],  # c1 -> c2 kept; the others dropped
    }
    events = await resume(rclient, tokens, thread_id, interrupt, True, edited)
    (create,) = [c for c in await mcp_calls(mcp) if c["tool"] == "create_child_items"]
    assert create["authorization"].startswith("Bearer ")
    assert create["arguments"]["parentId"] == STATE["itemId"]
    assert create["arguments"]["childType"] == "user-story"
    assert [c["title"] for c in create["arguments"]["children"]] == ["Story one", "Story two (renamed)"]
    assert create["arguments"]["relationships"] == [CHILDREN["relationships"][0]]
    result = json.loads(tool_result_of(events))
    assert [c["proposalId"] for c in result["created"]] == ["c1", "c2"]
    assert result["edited"] == ["c2"]
    assert result["rejected"] == ["c3"]
    assert result["failed"] == []
    assert result["relationshipsCreated"] == 1
    reasons = {(s["sourceRef"], s["targetRef"]): s["reason"] for s in result["relationshipsSkipped"]}
    assert reasons == {
        ("c3", "c1"): "a related child was rejected in the review",
        ("c2", "c3"): "a related child was rejected in the review",
    }
    state = last_state(events)
    assert state["childPreview"] is None
    last_apply = state["lastApply"]
    assert last_apply["toolCallId"] == "call_1"
    assert datetime.fromisoformat(last_apply["at"]).utcoffset() == timedelta(0)
    assert {k: v for k, v in last_apply.items() if k not in ("toolCallId", "at")} == result
    parsed = AgentState.model_validate({**STATE, "preview": None, "lastApply": last_apply}).last_apply
    assert isinstance(parsed, ChildLastApply)


async def test_child_proposal_edits_must_stay_inside_the_proposal(
    rclient: httpx.AsyncClient, tokens: TokenFactory, gateway: httpx.AsyncClient, mcp: httpx.AsyncClient
) -> None:
    thread_id, _, interrupt = await propose(rclient, tokens, gateway, "propose_child_items", CHILDREN)
    invented = {**CHILDREN, "children": [{"proposalId": "c9", "title": "New", "markdown": "x"}]}
    events = await resume(rclient, tokens, thread_id, interrupt, True, invented)
    assert "child 'c9' is not part of the proposal" in tool_result_of(events)
    assert not [c for c in await mcp_calls(mcp) if c["tool"] == "create_child_items"]
    assert last_state(events)["childPreview"] is None


async def test_failed_children_are_reported(
    rclient: httpx.AsyncClient, tokens: TokenFactory, gateway: httpx.AsyncClient, mcp: httpx.AsyncClient
) -> None:
    await mcp.post("/_config", json={"failedChildren": ["c2"]})
    thread_id, _, interrupt = await propose(rclient, tokens, gateway, "propose_child_items", CHILDREN)
    events = await resume(rclient, tokens, thread_id, interrupt, True, CHILDREN)
    result = json.loads(tool_result_of(events))
    assert [c["proposalId"] for c in result["created"]] == ["c1", "c3"]
    assert result["failed"] == [{"proposalId": "c2", "reason": "duplicate title"}]


# --- record_quality_assessment --------------------------------------------------------------------------------------

ASSESSMENT: dict[str, Any] = {
    "overall": "ready-with-open-questions",
    "areas": [{"area": "problem", "level": "clear"}, {"area": "scope", "level": "unclear", "note": "Too broad"}],
    "summary": "Mostly fine",
    "documentHash": "model-made-up",
}


async def test_quality_assessment_uses_the_cached_hash_and_mirrors_into_state(
    rclient: httpx.AsyncClient, tokens: TokenFactory, gateway: httpx.AsyncClient, mcp: httpx.AsyncClient
) -> None:
    await script(gateway, call("record_quality_assessment", ASSESSMENT), {"text": "Assessed."})
    thread = await create_thread(rclient, tokens)
    status, events = await run_agui(rclient, tokens, thread["id"], [USER], state=dict(STATE))
    assert status == 200
    (stored,) = [c for c in await mcp_calls(mcp) if c["tool"] == "set_item_quality"]
    assert stored["arguments"]["documentHash"] == "hash-1"
    assert "documentHash" not in stored["arguments"]["quality"]
    assert stored["arguments"]["quality"]["areas"][1] == ASSESSMENT["areas"][1] | {}
    assert stored["authorization"].startswith("Bearer ")
    quality = last_state(events)["quality"]
    assert quality["overall"] == "ready-with-open-questions"
    assert quality["documentHash"] == "hash-1"
    assert quality["assessedAt"] == "2026-01-01T00:00:00Z"
    assert quality["stale"] is False


async def test_stale_assessment_tells_the_model_to_reread_the_item(
    rclient: httpx.AsyncClient, tokens: TokenFactory, gateway: httpx.AsyncClient, mcp: httpx.AsyncClient
) -> None:
    fail = {"status": 409, "type": "stale-assessment", "detail": "The document changed."}
    await mcp.post("/_config", json={"fail": {"set_item_quality": fail}})
    await script(gateway, call("record_quality_assessment", ASSESSMENT), {"text": "Sorry."})
    thread = await create_thread(rclient, tokens)
    status, events = await run_agui(rclient, tokens, thread["id"], [USER], state=dict(STATE))
    assert status == 200
    message = tool_results((await llm_requests(gateway))[-1])[-1]
    assert message.startswith("Error: the document changed since you read it")
    assert "get_item_context" in message
    assert not [e for e in events if e["type"] == "STATE_SNAPSHOT" and "quality" in e["snapshot"]]


# --- suggest_next_actions / set_session_title -----------------------------------------------------------------------


async def test_next_actions_and_session_title(
    rclient: httpx.AsyncClient,
    tokens: TokenFactory,
    gateway: httpx.AsyncClient,
    sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    actions = [
        {"id": "a1", "label": "Break it down", "intent": "breakdown"},
        {"id": "a2", "label": "Ask about scope", "intent": "message", "prompt": "What is out of scope?"},
    ]
    await script(
        gateway,
        {
            "tool_calls": [
                {"id": "t1", "name": "set_session_title", "arguments": {"title": "Checkout redesign"}},
                {"id": "t2", "name": "suggest_next_actions", "arguments": {"actions": actions}},
            ]
        },
        {"text": "Done."},
    )
    thread = await create_thread(rclient, tokens)
    status, events = await run_agui(rclient, tokens, thread["id"], [USER], state=dict(STATE))
    assert status == 200
    assert last_state(events)["nextActions"] == actions
    async with sessionmaker() as session:
        title = (await session.execute(select(Thread.title).where(Thread.id == thread["id"]))).scalar_one()
    assert title == "Checkout redesign"
    results = tool_results((await llm_requests(gateway))[-1])
    assert results == ["ok", "ok"]


async def test_too_many_actions_or_a_long_title_are_tool_errors(
    rclient: httpx.AsyncClient, tokens: TokenFactory, gateway: httpx.AsyncClient
) -> None:
    many = [{"id": f"a{i}", "label": "x", "intent": "continue"} for i in range(4)]
    await script(
        gateway,
        {
            "tool_calls": [
                {"id": "t1", "name": "set_session_title", "arguments": {"title": "x" * 61}},
                {"id": "t2", "name": "suggest_next_actions", "arguments": {"actions": many}},
            ]
        },
        {"text": "Done."},
    )
    thread = await create_thread(rclient, tokens)
    await run_agui(rclient, tokens, thread["id"], [USER], state=dict(STATE))
    first, second = tool_results((await llm_requests(gateway))[-1])
    assert first.startswith("Error: invalid arguments for set_session_title: title:")
    assert second.startswith("Error: invalid arguments for suggest_next_actions: actions:")


# --- validation retry cap -------------------------------------------------------------------------------------------


async def test_validation_retries_are_capped_at_two_per_tool_and_run(
    rclient: httpx.AsyncClient, tokens: TokenFactory, gateway: httpx.AsyncClient, mcp: httpx.AsyncClient
) -> None:
    bad = {"title": "x" * 61}
    await script(
        gateway,
        call("set_session_title", bad, "t1"),
        call("set_session_title", bad, "t2"),
        call("set_session_title", {"title": "Fine"}, "t3"),
        {"text": "I could not set the title."},
    )
    thread = await create_thread(rclient, tokens)
    status, _ = await run_agui(rclient, tokens, thread["id"], [USER], state=dict(STATE))
    assert status == 200
    requests = await llm_requests(gateway)
    first = tool_results(requests[1])[-1]
    second = tool_results(requests[2])[-1]
    third = tool_results(requests[3])[-1]
    assert "Fix the arguments and call set_session_title again" in first
    assert "Do not call set_session_title again" in second and "explain the problem to the user" in second
    assert "Do not call set_session_title again" in third  # not executed any more, even with valid arguments
