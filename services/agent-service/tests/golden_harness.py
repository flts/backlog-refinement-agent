"""Golden AG-UI event streams: run a scripted scenario through the real endpoint and compare a normalised stream.

A :class:`GoldenScenario` wraps one thread. Every :meth:`~GoldenScenario.run` posts an AG-UI request (as the SPA builds
it: fresh state with ``preview: null``, ``tools: [ask_user]``, only the new messages) and records the response in a
stable form: ids (threads, messages, interrupts, runs) and timestamps become placeholders, token chunks are coalesced,
bulky payloads are summarised, and the fake gateway / MCP calls made by the run are listed.
:meth:`~GoldenScenario.verify` compares the result with ``tests/golden/<name>.json``; regenerate the files with
``UPDATE_GOLDEN=1``.

Every model request of every scenario is also checked here: the hidden MCP write tools are never offered to the LLM.
"""

from __future__ import annotations

import difflib
import json
import os
import re
from pathlib import Path
from typing import Any

import httpx

from agent_service_testkit import API, ITEM_ID, PROJECT_ID, TokenFactory, create_thread, run_agui

GOLDEN_DIR = Path(__file__).parent / "golden"
UPDATE_GOLDEN = os.environ.get("UPDATE_GOLDEN") == "1"

HIDDEN_WRITE_TOOLS = frozenset({"apply_document_changes", "create_child_items", "set_item_quality"})
PROVIDER_READS = frozenset(
    {"get_project_guidance", "get_item_context", "get_pinned_sources"}
)  # every run, order varies

USER_MESSAGE = {"id": "m1", "role": "user", "content": "Please refine this item."}
ASK_USER_TOOL = {
    "name": "ask_user",
    "description": "Ask the user 1-3 questions.",
    "parameters": {"type": "object", "properties": {"questions": {"type": "array"}}},
}
SPA_STATE: dict[str, Any] = {"schemaVersion": 1, "projectId": PROJECT_ID, "itemId": ITEM_ID, "preview": None}

_PATTERNS = (
    ("interrupt", re.compile(r"af-call-[0-9a-f]{32}")),
    ("id", re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")),
    ("run", re.compile(r"run-[0-9a-f]{8}")),
    ("at", re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)")),
)


class Placeholders:
    """Replaces volatile ids and timestamps by ``<kind-N>`` (numbered by first appearance, stable across runs)."""

    def __init__(self, thread_id: str) -> None:
        self._known: dict[str, str] = {thread_id: "<thread>", PROJECT_ID: "<project>", ITEM_ID: "<item>"}
        self._counts: dict[str, int] = {}

    def text(self, value: str) -> str:
        for kind, pattern in _PATTERNS:
            value = pattern.sub(lambda match, kind=kind: self._name(kind, match.group(0)), value)
        return self._known.get(value, value)

    def _name(self, kind: str, raw: str) -> str:
        if raw not in self._known:
            if kind == "at":
                self._known[raw] = "<at>"
            else:
                self._counts[kind] = self._counts.get(kind, 0) + 1
                self._known[raw] = f"<{kind}-{self._counts[kind]}>"
        return self._known[raw]

    def walk(self, value: Any) -> Any:
        if isinstance(value, str):
            return self.text(value)
        if isinstance(value, list):
            return [self.walk(item) for item in value]
        if isinstance(value, dict):
            return {key: self.walk(item) for key, item in value.items()}
        return value


def _parse_json(text: Any) -> Any:
    if isinstance(text, str):
        try:
            return json.loads(text)
        except ValueError:
            return text
    return text


def _tool_content(text: Any) -> Any:
    """Tool result content as JSON; an MCP result keeps only its structured payload (no SDK version metadata)."""
    parsed = _parse_json(text)
    if isinstance(parsed, dict) and "structuredContent" in parsed:
        return parsed["structuredContent"]
    return parsed


def _interrupt(raw: dict[str, Any]) -> dict[str, Any]:
    call = ((raw.get("metadata") or {}).get("agent_framework") or {}).get("function_call") or {}
    schema = raw.get("responseSchema") or {}
    return {
        "id": raw["id"],
        "reason": raw.get("reason"),
        "message": raw.get("message"),
        "toolCallId": raw.get("toolCallId"),
        "toolName": call.get("name"),
        "argumentKeys": sorted((call.get("arguments") or {}).keys()),
        "responseKeys": sorted((schema.get("properties") or {}).keys()),
    }


def _message(raw: dict[str, Any]) -> dict[str, Any]:
    summary: dict[str, Any] = {"id": raw.get("id"), "role": raw.get("role")}
    if raw.get("content"):
        summary["content"] = _tool_content(raw["content"]) if raw.get("role") == "tool" else raw["content"]
    if raw.get("toolCallId"):
        summary["toolCallId"] = raw["toolCallId"]
    if raw.get("toolCalls"):
        summary["toolCalls"] = [
            {
                "id": call["id"],
                "name": call["function"]["name"],
                "arguments": _parse_json(call["function"]["arguments"]),
            }
            for call in raw["toolCalls"]
        ]
    return summary


def summarise(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Event types, tool names, state paths and key fields; token chunks coalesced, volatile values dropped."""
    out: list[dict[str, Any]] = []
    for event in events:
        kind = event["type"]
        previous = out[-1] if out else None
        if kind == "TEXT_MESSAGE_CONTENT" and previous and previous["type"] == kind:
            previous["text"] += event["delta"]
        elif kind == "TEXT_MESSAGE_CONTENT":
            out.append({"type": kind, "messageId": event["messageId"], "text": event["delta"]})
        elif kind == "TOOL_CALL_ARGS" and previous and previous["type"] == kind:
            previous["argsText"] += event["delta"]
        elif kind == "TOOL_CALL_ARGS":
            out.append({"type": kind, "toolCallId": event["toolCallId"], "argsText": event["delta"]})
        elif kind in ("RUN_STARTED",):
            out.append({"type": kind})
        elif kind == "RUN_FINISHED":
            outcome = event.get("outcome") or {}
            summary: dict[str, Any] = {"type": kind, "outcome": outcome.get("type", "success")}
            if outcome.get("interrupts"):
                summary["interrupts"] = [_interrupt(item) for item in outcome["interrupts"]]
            out.append(summary)
        elif kind == "RUN_ERROR":
            out.append({"type": kind, "code": event.get("code"), "message": event.get("message")})
        elif kind in ("STEP_STARTED", "STEP_FINISHED"):
            out.append({"type": kind, "stepName": event["stepName"]})
        elif kind == "TEXT_MESSAGE_START":
            out.append({"type": kind, "messageId": event["messageId"], "role": event.get("role")})
        elif kind == "TEXT_MESSAGE_END":
            out.append({"type": kind, "messageId": event["messageId"]})
        elif kind == "TOOL_CALL_START":
            out.append(
                {
                    "type": kind,
                    "toolCallId": event["toolCallId"],
                    "toolCallName": event["toolCallName"],
                    "parentMessageId": event.get("parentMessageId"),
                }
            )
        elif kind == "TOOL_CALL_END":
            out.append({"type": kind, "toolCallId": event["toolCallId"]})
        elif kind == "TOOL_CALL_RESULT":
            out.append(
                {
                    "type": kind,
                    "toolCallId": event["toolCallId"],
                    "messageId": event.get("messageId"),
                    "content": _tool_content(event.get("content")),
                }
            )
        elif kind == "STATE_DELTA":
            out.append({"type": kind, "delta": event["delta"]})
        elif kind == "STATE_SNAPSHOT":
            out.append({"type": kind, "snapshot": event["snapshot"]})
        elif kind == "MESSAGES_SNAPSHOT":
            out.append({"type": kind, "messages": [_message(item) for item in event["messages"]]})
        elif kind == "CUSTOM":
            custom: dict[str, Any] = {"type": kind, "name": event["name"]}
            value = event.get("value") or {}
            if event["name"] == "PredictState":
                custom["stateKeys"] = sorted(item["state_key"] for item in value or [])
            elif event["name"] == "function_approval_request":
                call = value.get("function_call") or {}
                custom["toolName"], custom["toolCallId"] = call.get("name"), call.get("call_id")
            out.append(custom)
        else:
            out.append({"type": kind})
    for item in out:
        if item["type"] == "TOOL_CALL_ARGS":
            item["args"] = _parse_json(item.pop("argsText"))
    return out


def _dumps(value: Any) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False)


def render(name: str, runs: list[dict[str, Any]]) -> str:
    """Stable text of a golden file: one event per line so that diffs stay readable."""
    lines = ["{", f'  "scenario": {_dumps(name)},', '  "runs": [']
    for index, run in enumerate(runs):
        lines.append("    {")
        for key in ("run", "request", "status", "threadStatus", "modelRequests", "mcpCalls"):
            lines.append(f'      "{key}": {_dumps(run[key])},')
        lines.append('      "events": [')
        events = run["events"]
        lines.extend(f"        {_dumps(event)}{',' if i < len(events) - 1 else ''}" for i, event in enumerate(events))
        lines.append("      ]")
        lines.append("    }" + ("," if index < len(runs) - 1 else ""))
    lines += ["  ]", "}", ""]
    return "\n".join(lines)


def tool_names(request: dict[str, Any]) -> set[str]:
    return {entry["function"]["name"] for entry in request.get("tools") or []}


def script(*turns: dict[str, Any]) -> dict[str, Any]:
    return {"responses": list(turns)}


def call(name: str, arguments: dict[str, Any], call_id: str = "call_1") -> dict[str, Any]:
    return {"tool_calls": [{"id": call_id, "name": name, "arguments": arguments}]}


def decision(interrupt: dict[str, Any], approved: bool, edited: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    payload: dict[str, Any] = {"approved": approved}
    if edited is not None:
        payload["editedArgs"] = edited
    return [{"interruptId": interrupt["id"], "status": "resolved", "payload": payload}]


def interrupt_of(events: list[dict[str, Any]]) -> dict[str, Any]:
    finished = events[-1]
    assert finished["type"] == "RUN_FINISHED", finished
    return finished["outcome"]["interrupts"][0]


class GoldenScenario:
    def __init__(
        self,
        name: str,
        client: httpx.AsyncClient,
        tokens: TokenFactory,
        gateway: httpx.AsyncClient,
        mcp: httpx.AsyncClient,
    ) -> None:
        self.name = name
        self.client, self.tokens, self.gateway, self.mcp = client, tokens, gateway, mcp
        self.thread_id = ""
        self.runs: list[dict[str, Any]] = []
        self.events: dict[str, list[dict[str, Any]]] = {}
        self._placeholders: Placeholders | None = None

    async def start(self, *queued: dict[str, Any]) -> GoldenScenario:
        """Creates the thread and queues the scripted model turns (a dict per turn)."""
        thread = await create_thread(self.client, self.tokens)
        self.thread_id = thread["id"]
        self._placeholders = Placeholders(self.thread_id)
        if queued:
            await self.gateway.post("/_script", json=script(*queued))
        return self

    async def queue(self, *turns: dict[str, Any]) -> None:
        await self.gateway.post("/_script", json=script(*turns))

    async def _log(self, path: str) -> list[dict[str, Any]]:
        return (await (self.gateway if path == "/_requests" else self.mcp).get(path)).json()

    async def run(
        self,
        label: str,
        messages: list[dict[str, Any]] | None = None,
        *,
        resume: list[dict[str, Any]] | None = None,
        hydrate: bool = False,
        state: dict[str, Any] | None = None,
        tools: list[dict[str, Any]] | None = None,
        forwarded_props: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> list[dict[str, Any]]:
        """One AG-UI run, recorded for the golden file; returns the raw events."""
        assert self._placeholders is not None, "call start() first"
        placeholders = self._placeholders
        model_before = len(await self._log("/_requests"))
        mcp_before = len(await self._log("/_calls"))
        status, events = await run_agui(
            self.client,
            self.tokens,
            self.thread_id,
            messages or [],
            state=dict(SPA_STATE) if state is None else state,
            tools=[] if hydrate else (tools if tools is not None else [ASK_USER_TOOL]),
            resume=resume,
            headers=headers,
            forwarded_props=forwarded_props,
        )
        model_requests = (await self._log("/_requests"))[model_before:]
        for entry in model_requests:
            leaked = tool_names(entry["body"]) & HIDDEN_WRITE_TOOLS
            assert not leaked, f"The hidden write tools {sorted(leaked)} were offered to the model in '{label}'."
        mcp_calls = [c for c in (await self._log("/_calls"))[mcp_before:] if c["tool"] not in PROVIDER_READS]
        listed = (await self.client.get(f"{API}/threads", headers=self.tokens.headers())).json()["items"]
        thread_status = next(item["status"] for item in listed if item["id"] == self.thread_id)
        request: dict[str, Any] = {}
        if messages:
            request["messages"] = [f"{m['role']}: {m.get('content') or ''}" for m in messages]
        if resume:
            request["resume"] = [
                {"status": r["status"], "approved": (r.get("payload") or {}).get("approved")} for r in resume
            ]
        if hydrate:
            request["hydrate"] = True
        if forwarded_props:
            request["forwardedProps"] = forwarded_props
        self.events[label] = events
        self.runs.append(
            placeholders.walk(
                {
                    "run": label,
                    "request": request,
                    "status": status,
                    "threadStatus": thread_status,
                    "modelRequests": len(model_requests),
                    "mcpCalls": [{"tool": c["tool"], "arguments": c["arguments"]} for c in mcp_calls],
                    "events": summarise(events),
                }
            )
        )
        return events

    def verify(self) -> None:
        actual = render(self.name, self.runs)
        path = GOLDEN_DIR / f"{self.name}.json"
        if UPDATE_GOLDEN:
            GOLDEN_DIR.mkdir(exist_ok=True)
            path.write_text(actual, encoding="utf-8")
            return
        assert path.exists(), f"Missing golden file {path.name}. Create it with UPDATE_GOLDEN=1."
        expected = path.read_text(encoding="utf-8")
        if actual != expected:
            diff = "\n".join(
                list(
                    difflib.unified_diff(
                        expected.splitlines(), actual.splitlines(), f"golden/{path.name}", "actual", lineterm="", n=1
                    )
                )[:60]
            )
            raise AssertionError(
                f"The AG-UI event stream of '{self.name}' changed. If that is intended, run UPDATE_GOLDEN=1 and review "
                f"the diff of tests/golden/{path.name}.\n{diff}"
            )
