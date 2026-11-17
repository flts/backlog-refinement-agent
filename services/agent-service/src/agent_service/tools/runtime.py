"""Helpers shared by the agent tools: schemas of the contracts, the run's identifiers, the original proposal."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from typing import Any

from agent_framework import FunctionInvocationContext
from backlog_contracts import load_schema

from agent_service.auth import current_principal
from agent_service.identity import user_scope
from agent_service.tools.guard import ToolInputError
from agent_service.tools.services import current_tool_services

_SCHEMA_ONLY_KEYS = frozenset({"$schema", "$id", "title", "description", "x-tool"})
_DESCRIPTION_PREFIX = re.compile(r"^Arguments of the agent-service tool `[a-z_]+`:?\s*")
MAX_RUN_ID_CHARS = 200


def tool_schema(schema: str) -> tuple[str, dict[str, Any]]:
    """``(description, parameters)`` of a tool from ``contracts/schemas/<schema>.args.schema.json``."""
    raw = load_schema(f"{schema}.args")
    description = _DESCRIPTION_PREFIX.sub("", str(raw.get("description", "")), count=1).strip()
    parameters = {key: value for key, value in raw.items() if key not in _SCHEMA_ONLY_KEYS}
    return description[:1].upper() + description[1:], parameters


def session_state(ctx: FunctionInvocationContext) -> Mapping[str, Any]:
    state = getattr(ctx.session, "state", None)
    return state if isinstance(state, Mapping) else {}


def item_ids(ctx: FunctionInvocationContext) -> tuple[str, str]:
    """``(projectId, itemId)`` of the thread's item (AG-UI state, guarded against the thread by the endpoint)."""
    state = session_state(ctx)
    project_id, item_id = state.get("projectId"), state.get("itemId")
    if not isinstance(project_id, str) or not isinstance(item_id, str):
        raise ToolInputError("the conversation has no item (state.projectId / state.itemId is missing)")
    return project_id, item_id


def thread_id(ctx: FunctionInvocationContext) -> str | None:
    metadata = getattr(ctx.session, "metadata", None) or {}
    value = metadata.get("ag_ui_thread_id")
    return value if isinstance(value, str) and value else None


def run_id(ctx: FunctionInvocationContext) -> str | None:
    metadata = getattr(ctx.session, "metadata", None) or {}
    value = metadata.get("ag_ui_run_id")
    return value[:MAX_RUN_ID_CHARS] if isinstance(value, str) and value else None


async def original_arguments(ctx: FunctionInvocationContext) -> dict[str, Any]:
    """The model's ORIGINAL arguments of the approved call.

    After an approval MAF hands the tool the arguments the user *returned* (``editedArgs``), never the proposal. The
    original arguments are in the stored thread snapshot (the assistant message's ``toolCalls``; the snapshot is saved
    when the interrupt is raised and is still untouched while the resumed run executes the tool). They are read with
    the caller's own scope, so one user can never see another user's proposal.
    """
    principal = current_principal()
    thread = thread_id(ctx)
    call_id = ctx.metadata.get("call_id")
    if principal is None or thread is None or not isinstance(call_id, str):
        raise ToolInputError("the original proposal cannot be identified")
    snapshot = await current_tool_services().snapshot_store.get(scope=user_scope(principal.email), thread_id=thread)
    for message in reversed(snapshot.messages if snapshot is not None else []):
        for call in message.get("toolCalls") or message.get("tool_calls") or []:
            if call.get("id") != call_id:
                continue
            try:
                original = json.loads(call["function"]["arguments"])
            except (KeyError, TypeError, ValueError):
                break
            if isinstance(original, dict):
                return original
    raise ToolInputError("the original proposal was not found, so the edits cannot be checked; nothing was applied")
