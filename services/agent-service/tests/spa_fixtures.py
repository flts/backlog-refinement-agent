"""Structural comparison of server event streams with the SPA's recorded fixtures (``apps/web/src/agent/__fixtures__``).

The SPA reduces these streams with ``RunEventMapper``; if the server's order of events or the fields the SPA reads
drift away from the fixtures, the client tests would still pass against stale recordings. Hence the server streams
are checked against them here: same sequence of event kinds (without the timeline ``STEP_*`` rows the runner injects
and without ``usage`` bookkeeping), and every field the fixture event carries is present in the server's event.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

FIXTURES = Path(__file__).resolve().parents[3] / "apps" / "web" / "src" / "agent" / "__fixtures__"
_REPEATED = frozenset({"TEXT_MESSAGE_CONTENT", "TOOL_CALL_ARGS"})
_IGNORED = frozenset({"STEP_STARTED", "STEP_FINISHED"})


def load(name: str) -> list[dict[str, Any]]:
    if not FIXTURES.is_dir():
        pytest.skip("The SPA fixtures (apps/web) are not part of this checkout.")
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


def kind(event: dict[str, Any]) -> str:
    """``TYPE`` plus what the SPA keys on: custom event name, tool name, state paths, outcome, error code."""
    name = event["type"]
    if name == "CUSTOM":
        return f"CUSTOM:{event['name']}"
    if name == "TOOL_CALL_START":
        return f"{name}:{event['toolCallName']}"
    if name == "STATE_DELTA":
        return f"{name}:{','.join(op['path'] for op in event['delta'])}"
    if name == "RUN_FINISHED":
        return f"{name}:{(event.get('outcome') or {}).get('type', 'success')}"
    if name == "RUN_ERROR":
        return f"{name}:{event['code']}"
    return name


def sequence(events: list[dict[str, Any]]) -> list[str]:
    out: list[str] = []
    for event in events:
        label = kind(event)
        if event["type"] in _IGNORED or label == "CUSTOM:usage":
            continue
        if event["type"] in _REPEATED and out and out[-1] == label:
            continue
        out.append(label)
    return out


def _interrupt_keys(event: dict[str, Any]) -> set[str]:
    keys: set[str] = set()
    for interrupt in (event.get("outcome") or {}).get("interrupts") or []:
        keys |= {f"interrupt.{key}" for key in interrupt}
        call = ((interrupt.get("metadata") or {}).get("agent_framework") or {}).get("function_call") or {}
        keys |= {f"interrupt.function_call.{key}" for key in call}
        keys |= {
            f"interrupt.responseSchema.{key}" for key in (interrupt.get("responseSchema") or {}).get("properties", {})
        }
    return keys


def fields(event: dict[str, Any]) -> set[str]:
    keys = set(event) | _interrupt_keys(event)
    if event["type"] == "MESSAGES_SNAPSHOT":
        for message in event["messages"]:
            keys |= {f"message.{key}" for key in message}
            keys |= {f"toolCall.{key}" for call in message.get("toolCalls") or [] for key in call}
            keys |= {f"toolCall.function.{key}" for call in message.get("toolCalls") or [] for key in call["function"]}
    return keys


def assert_compatible(server: list[dict[str, Any]], fixture_name: str) -> None:
    fixture = load(fixture_name)
    assert sequence(server) == sequence(fixture), f"The event order differs from the SPA fixture {fixture_name}."
    server_fields: dict[str, set[str]] = {}
    for event in server:
        server_fields.setdefault(kind(event), set()).update(fields(event))
    for event in fixture:
        label = kind(event)
        if event["type"] in _IGNORED or label == "CUSTOM:usage":
            continue
        missing = fields(event) - server_fields.get(label, set())
        assert not missing, f"{label} lacks the fields {sorted(missing)} that the SPA fixture {fixture_name} has."
