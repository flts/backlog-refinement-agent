"""``suggest_next_actions`` (``state.nextActions``) and ``set_session_title`` (``threads.title`` in agentdb)."""

from __future__ import annotations

import logging
from typing import Any

from agent_framework import FunctionInvocationContext, tool
from agent_framework_ag_ui import state_update
from backlog_contracts import SetSessionTitleArgs, SuggestNextActionsArgs
from sqlalchemy import func, update

from agent_service.auth import current_principal
from agent_service.db.models import Thread
from agent_service.identity import normalize_email
from agent_service.tools import ToolRegistry
from agent_service.tools.guard import ToolInputError, guarded, validate_arguments
from agent_service.tools.runtime import thread_id, tool_schema
from agent_service.tools.services import current_tool_services

logger = logging.getLogger(__name__)

SUGGEST_NEXT_ACTIONS = "suggest_next_actions"
SET_SESSION_TITLE = "set_session_title"


async def suggest_next_actions_impl(arguments: dict[str, Any]) -> Any:
    args = validate_arguments(SuggestNextActionsArgs, arguments)
    return state_update(text="ok", state={"nextActions": [action.to_wire() for action in args.actions]})


async def set_session_title_impl(ctx: FunctionInvocationContext, arguments: dict[str, Any]) -> str:
    args = validate_arguments(SetSessionTitleArgs, arguments)
    title = args.title.strip()
    principal, thread = current_principal(), thread_id(ctx)
    if not title:
        raise ToolInputError("title: must not be blank")
    if principal is None or thread is None:
        return "Error: the conversation could not be identified; the title was not changed."
    async with current_tool_services().sessionmaker() as session:
        result = await session.execute(
            update(Thread)
            .where(Thread.id == thread, Thread.owner_email == normalize_email(principal.email))
            .values(title=title, updated_at=func.now())
        )
        await session.commit()
    if not result.rowcount:  # pyright: ignore[reportAttributeAccessIssue]
        return "Error: the conversation was not found; the title was not changed."
    return "ok"


def _next_actions_tool() -> Any:
    description, parameters = tool_schema("suggest-next-actions")

    @tool(name=SUGGEST_NEXT_ACTIONS, description=description, schema=parameters, approval_mode="never_require")
    async def suggest_next_actions(**arguments: Any) -> Any:
        return await guarded(SUGGEST_NEXT_ACTIONS, None, suggest_next_actions_impl(arguments))

    return suggest_next_actions


def _title_tool() -> Any:
    description, parameters = tool_schema("set-session-title")

    @tool(name=SET_SESSION_TITLE, description=description, schema=parameters, approval_mode="never_require")
    async def set_session_title(ctx: FunctionInvocationContext, **arguments: Any) -> Any:
        return await guarded(SET_SESSION_TITLE, None, set_session_title_impl(ctx, arguments))

    return set_session_title


def register(registry: ToolRegistry) -> None:
    registry.register(SUGGEST_NEXT_ACTIONS, _next_actions_tool, arguments=SuggestNextActionsArgs)
    registry.register(SET_SESSION_TITLE, _title_tool, arguments=SetSessionTitleArgs)
