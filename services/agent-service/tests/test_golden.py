"""Golden AG-UI event streams of the refiner through the real endpoint (fake gateway + fake backlog MCP server).

Each scenario drives the endpoint like the SPA does and compares the normalised stream with ``tests/golden/<name>.json``
(see ``golden_harness.py``; regenerate with ``UPDATE_GOLDEN=1``). Maintained Agent Framework releases change event
order and payloads, so these files are the early warning. Scenarios that the SPA also records as fixtures
(``apps/web/src/agent/__fixtures__``) are checked against them structurally in ``test_spa_fixtures.py``.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

import spa_fixtures
from agent_service_testkit import PROJECT_ID, TokenFactory
from golden_harness import (
    GoldenScenario,
    call,
    decision,
    interrupt_of,
)

PROPOSAL: dict[str, Any] = {
    "summary": "Tighten the item",
    "suggestedTitle": "Checkout redesign",
    "baseVersion": 7,
    "sections": [
        {"id": "s1", "heading": "Summary", "mode": "replace", "markdown": "New summary", "rationale": "clarity"},
        {"id": "s2", "heading": "Acceptance criteria", "mode": "append", "markdown": "- [ ] AC1"},
        {"id": "s3", "heading": "Open questions", "mode": "append", "markdown": "- [ ] Who approves?"},
    ],
}
PROPOSAL_INTRO = "Here is my proposal."
QUESTIONS: dict[str, Any] = {
    "questions": [
        {
            "id": "q1",
            "header": "Scope",
            "question": "Which users?",
            "options": [{"label": "Admins"}, {"label": "All"}],
        }
    ]
}
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
    ],
}
ASSESSMENT: dict[str, Any] = {
    "overall": "ready-with-open-questions",
    "areas": [{"area": "problem", "level": "clear"}, {"area": "scope", "level": "unclear", "note": "Too broad"}],
    "summary": "Mostly fine",
    "documentHash": "model-made-up",
}
ANSWERED = json.dumps(
    {"status": "answered", "answers": [{"questionId": "q1", "selected": ["Admins"], "skipped": False}]}
)


@pytest.fixture
def scenario(
    rclient: httpx.AsyncClient, tokens: TokenFactory, gateway: httpx.AsyncClient, mcp: httpx.AsyncClient
) -> Any:
    def create(name: str) -> GoldenScenario:
        return GoldenScenario(name, rclient, tokens, gateway, mcp)

    return create


def proposal_turn(name: str, arguments: dict[str, Any], text: str = PROPOSAL_INTRO) -> dict[str, Any]:
    return {"text": text, **call(name, arguments)}


def ask_turn() -> dict[str, Any]:
    return {"text": "Let me ask.", **call("ask_user", QUESTIONS, "call_ask_1")}


async def propose_and_resume(
    run: GoldenScenario, arguments: dict[str, Any], *, approved: bool = True, edited: dict[str, Any] | None = None
) -> list[dict[str, Any]]:
    events = await run.run("propose", [{"id": "m1", "role": "user", "content": "improve"}])
    return await run.run(
        "resume", resume=decision(interrupt_of(events), approved, edited if edited is not None else arguments)
    )


async def test_refine_streams_text_title_and_next_actions(scenario: Any) -> None:
    actions = [
        {"id": "a1", "label": "Break it down", "intent": "breakdown"},
        {"id": "a2", "label": "Ask about scope", "intent": "message", "prompt": "What is out of scope?"},
    ]
    run: GoldenScenario = scenario("refine")
    await run.start(
        call("search_sources", {"projectId": PROJECT_ID, "query": "checkout"}, "call_search"),
        {
            "text": "I read the handbook.",
            "tool_calls": [
                {"id": "call_title", "name": "set_session_title", "arguments": {"title": "Checkout redesign"}},
                {"id": "call_actions", "name": "suggest_next_actions", "arguments": {"actions": actions}},
            ],
        },
        {"text": "The item is in good shape."},
    )
    await run.run(
        "refine",
        [{"id": "m1", "role": "user", "content": "Refine this item."}],
        forwarded_props={"intent": "refine"},
    )
    run.verify()


async def test_ask_user_round_trip(scenario: Any) -> None:
    run: GoldenScenario = scenario("ask-user")
    await run.start(ask_turn(), {"text": "Thanks, scoping to admins."})
    await run.run("ask", [{"id": "m1", "role": "user", "content": "Refine this feature"}])
    await run.run("hydrate", hydrate=True)
    # Only the tool message: the agent continues with the stored history (spike #10).
    await run.run("answer", [{"id": "m2", "role": "tool", "toolCallId": "call_ask_1", "content": ANSWERED}])
    run.verify()
    spa_fixtures.assert_compatible(run.events["ask"], "ask-user.run")
    spa_fixtures.assert_compatible(run.events["hydrate"], "ask-user.hydrate")
    spa_fixtures.assert_compatible(run.events["answer"], "ask-user.answer")


async def test_dismissed_question_with_a_user_message(scenario: Any) -> None:
    run: GoldenScenario = scenario("ask-user-dismissed")
    await run.start(ask_turn(), {"text": "Understood, focusing on performance."})
    await run.run("ask", [{"id": "m1", "role": "user", "content": "Refine this feature"}])
    await run.run(
        "dismiss", [{"id": "m2", "role": "user", "content": "[dismissed question q1] Actually, focus on performance"}]
    )
    await run.run("hydrate", hydrate=True)
    run.verify()
    # The question was answered by the dismissal: it is not pending after a reload.
    assert [e["type"] for e in run.events["hydrate"]][-1] == "RUN_FINISHED"
    assert run.runs[-1]["threadStatus"] == "idle"


async def test_proposal_approved_and_applied(scenario: Any) -> None:
    run: GoldenScenario = scenario("approval-apply")
    await run.start(proposal_turn("propose_document_changes", PROPOSAL), {"text": "Applied everything."})
    await propose_and_resume(run, PROPOSAL)
    await run.run("hydrate", hydrate=True)
    run.verify()
    spa_fixtures.assert_compatible(run.events["propose"], "approval.propose")
    spa_fixtures.assert_compatible(run.events["resume"], "approval.resume")
    result = next(e for e in run.events["resume"] if e["type"] == "TOOL_CALL_RESULT")
    assert json.loads(result["content"])["applied"] == ["s1", "s2", "s3"]


async def test_proposal_partially_accepted_with_edits(scenario: Any) -> None:
    edited = {
        **PROPOSAL,
        "sections": [PROPOSAL["sections"][0], {**PROPOSAL["sections"][1], "markdown": "- [ ] AC1 (edited)"}],
    }
    run: GoldenScenario = scenario("approval-partial")
    await run.start(proposal_turn("propose_document_changes", PROPOSAL), {"text": "Applied your selection."})
    await propose_and_resume(run, PROPOSAL, edited=edited)
    run.verify()


async def test_conflicts_are_reported(scenario: Any, mcp: httpx.AsyncClient) -> None:
    await mcp.post("/_config", json={"conflicts": ["s2"]})
    run: GoldenScenario = scenario("approval-conflict")
    await run.start(proposal_turn("propose_document_changes", PROPOSAL), {"text": "One section conflicted."})
    await propose_and_resume(run, PROPOSAL)
    run.verify()


async def test_rejection_clears_the_preview(scenario: Any) -> None:
    run: GoldenScenario = scenario("approval-reject")
    await run.start(proposal_turn("propose_document_changes", PROPOSAL), {"text": "No problem, I will not apply it."})
    await propose_and_resume(run, PROPOSAL, approved=False)
    await run.run("hydrate", hydrate=True)
    run.verify()


async def test_cancelled_review_ends_the_run_without_calling_the_model(scenario: Any) -> None:
    run: GoldenScenario = scenario("approval-cancel")
    await run.start(proposal_turn("propose_document_changes", PROPOSAL))
    events = await run.run("propose", [{"id": "m1", "role": "user", "content": "improve"}])
    await run.run("cancel", resume=[{"interruptId": interrupt_of(events)["id"], "status": "cancelled"}])
    run.verify()
    spa_fixtures.assert_compatible(run.events["cancel"], "approval.cancel")


async def test_breakdown_partially_accepted(scenario: Any) -> None:
    edited = {
        **CHILDREN,
        "children": [CHILDREN["children"][0], {**CHILDREN["children"][1], "title": "Story two (renamed)"}],
        "relationships": [CHILDREN["relationships"][0]],
    }
    run: GoldenScenario = scenario("breakdown")
    await run.start(
        proposal_turn("propose_child_items", CHILDREN, "Here is a breakdown."), {"text": "Created two stories."}
    )
    events = await run.run(
        "propose",
        [{"id": "m1", "role": "user", "content": "Break this item down into child items."}],
        forwarded_props={"intent": "breakdown", "childType": "user-story"},
    )
    await run.run("resume", resume=decision(interrupt_of(events), True, edited))
    run.verify()


async def test_assessment_is_stored_and_mirrored_into_the_state(scenario: Any) -> None:
    run: GoldenScenario = scenario("assess")
    await run.start(call("record_quality_assessment", ASSESSMENT), {"text": "Assessed: ready with open questions."})
    await run.run(
        "assess",
        [{"id": "m1", "role": "user", "content": "Assess the quality of this item."}],
        forwarded_props={"intent": "assess"},
    )
    run.verify()


async def test_hydrate_restores_a_pending_interrupt_and_a_pending_question_without_the_model(
    scenario: Any, gateway: httpx.AsyncClient
) -> None:
    review: GoldenScenario = scenario("hydrate-pending-interrupt")
    await review.start(proposal_turn("propose_document_changes", PROPOSAL))
    await review.run("propose", [{"id": "m1", "role": "user", "content": "improve"}])
    requests_before = len((await gateway.get("/_requests")).json())
    await review.run("hydrate", hydrate=True)
    review.verify()
    spa_fixtures.assert_compatible(review.events["hydrate"], "approval.hydrate")

    question: GoldenScenario = scenario("hydrate-pending-ask-user")
    await question.start(ask_turn())
    await question.run("ask", [{"id": "m1", "role": "user", "content": "Refine this feature"}])
    await question.run("hydrate", hydrate=True)
    question.verify()
    spa_fixtures.assert_compatible(question.events["hydrate"], "ask-user.hydrate")

    # Hydrating never calls the model (the only requests are those of the two proposing / asking runs).
    assert len((await gateway.get("/_requests")).json()) == requests_before + 1
    assert [r["modelRequests"] for r in review.runs] == [1, 0]
    assert [r["modelRequests"] for r in question.runs] == [1, 0]
    assert [r["threadStatus"] for r in review.runs] == ["awaiting_review", "awaiting_review"]
    assert [r["threadStatus"] for r in question.runs] == ["awaiting_input", "awaiting_input"]
