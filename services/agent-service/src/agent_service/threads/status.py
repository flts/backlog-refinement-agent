"""Thread status derivation (``idle | running | awaiting_input | awaiting_review``).

* ``awaiting_review``: the snapshot has a pending interrupt (an approval of a proposal).
* ``awaiting_input``: an ``ask_user`` call has no answer yet and no later user message - the client tool ends the run
  successfully and waits for the user's answer (spike Q1). A proposal whose interrupt is gone (for example after a
  restart) is not pending input.
* ``idle`` otherwise.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from typing import Any

from agent_framework_ag_ui import AGUIThreadSnapshot, AGUIThreadSnapshotStore
from sqlalchemy import func, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from agent_service.db.models import THREAD_AWAITING_INPUT, THREAD_AWAITING_REVIEW, THREAD_IDLE, THREAD_RUNNING, Thread

logger = logging.getLogger(__name__)


def _tool_calls(message: Mapping[str, Any]) -> Sequence[Mapping[str, Any]]:
    calls = message.get("toolCalls") or message.get("tool_calls") or []
    return [call for call in calls if isinstance(call, Mapping)] if isinstance(calls, list) else []


CLIENT_TOOL_NAMES = frozenset({"ask_user"})
"""Tools answered by the client; only their unanswered calls make a thread ``awaiting_input``."""


def pending_tool_call_ids(
    messages: Sequence[Mapping[str, Any]], *, tool_names: frozenset[str] | None = CLIENT_TOOL_NAMES
) -> list[str]:
    """Ids of tool calls (of ``tool_names``; all when ``None``) still waiting for the client's answer.

    Walks the transcript in order like the SPA does: a ``tool`` message answers its call, and a ``user`` message after
    an unanswered call dismisses it (MAF answers it with a synthetic result that the stored transcript does not keep).
    """
    pending: dict[str, None] = {}
    for message in messages:
        role = message.get("role")
        if role == "assistant":
            for call in _tool_calls(message):
                call_id = call.get("id")
                function = call.get("function")
                name = function.get("name") if isinstance(function, Mapping) else call.get("name")
                if isinstance(call_id, str) and (tool_names is None or name in tool_names):
                    pending[call_id] = None
        elif role == "tool":
            pending.pop(str(message.get("toolCallId") or message.get("tool_call_id")), None)
        elif role == "user":
            pending.clear()
    return list(pending)


def derive_status(snapshot: AGUIThreadSnapshot | None) -> str:
    if snapshot is None:
        return THREAD_IDLE
    if snapshot.interrupt:
        return THREAD_AWAITING_REVIEW
    if pending_tool_call_ids(snapshot.messages):
        return THREAD_AWAITING_INPUT
    return THREAD_IDLE


async def mark_running(sessionmaker: async_sessionmaker[AsyncSession], *, thread_id: str) -> None:
    async with sessionmaker() as session:
        await session.execute(
            update(Thread)
            .where(Thread.id == thread_id)
            .values(status=THREAD_RUNNING, last_run_at=func.now(), updated_at=func.now())
        )
        await session.commit()


async def refresh_thread_status(
    sessionmaker: async_sessionmaker[AsyncSession],
    store: AGUIThreadSnapshotStore,
    *,
    scope: str,
    thread_id: str,
) -> str:
    """Recompute the status from the stored snapshot and persist it (after a run and on hydrate)."""
    status = derive_status(await store.get(scope=scope, thread_id=thread_id))
    async with sessionmaker() as session:
        await session.execute(update(Thread).where(Thread.id == thread_id).values(status=status, updated_at=func.now()))
        await session.commit()
    return status
