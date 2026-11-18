"""``POST /api/agent/agents/{agentId}``: the MAF AG-UI endpoint behind our access checks.

MAF's ``add_agent_framework_fastapi_endpoint`` registers one fixed path for one runner. We register it once with the
path template ``/api/agent/agents/{agent_id}`` and a runner (:class:`AgentDispatcher`) that delegates to the agent
chosen through the :class:`~agent_service.agents.registry.AgentRegistry`. Before MAF runs, the
:func:`guard_agent_request` dependency checks the agent id, the thread's existence and ownership, and that
``state.projectId`` and ``state.itemId`` match the thread (MAF itself trusts any ``threadId`` within the scope).
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncGenerator, AsyncIterator, Mapping
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Annotated, Any, cast

from ag_ui.core import BaseEvent
from agent_framework_ag_ui import (
    AgentFrameworkAgent,
    AGUIThreadSnapshotStore,
    add_agent_framework_fastapi_endpoint,
)
from fastapi import Depends, FastAPI, Request
from opentelemetry import trace
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from agent_service.agents.registry import AgentRegistry
from agent_service.agents.stream import StreamResult, guarded_stream
from agent_service.auth.context import bind_agent_id, bind_identity, current_agent_id, current_principal
from agent_service.auth.dependencies import AccessTokenDep, PrincipalDep
from agent_service.db.models import Thread
from agent_service.db.session import SessionDep
from agent_service.identity import user_scope
from agent_service.limits import RunLimits, RunPermit, retry_after_header
from agent_service.metrics import get_metrics
from agent_service.observability import agent_id_var, run_id_var, thread_id_var
from agent_service.problems import ProblemError
from agent_service.settings import API_PREFIX, Settings
from agent_service.threads.repository import get_owned_thread
from agent_service.threads.status import mark_running, refresh_thread_status
from agent_service.tools.services import ToolServices, bind_tool_services

logger = logging.getLogger(__name__)

AGENT_ENDPOINT_PATH = f"{API_PREFIX}/agents/{{agent_id}}"


async def agui_scope_resolver(principal: PrincipalDep, token: AccessTokenDep) -> str:
    """MAF ``authorization_scope_resolver``: ``user:<normalized email>``.

    Scopes snapshots, agent sessions and approval state. Binds the principal and the raw access token to context
    variables (:mod:`agent_service.auth.context`) for the duration of the run: the SSE generator, tools and the MCP
    context provider run in this request's context (spike #1).
    """
    bind_identity(principal, token)
    return user_scope(principal.email)


_RUN_PERMIT: ContextVar[RunPermit | None] = ContextVar("agent_service_run_permit", default=None)


def _is_hydrate(body: Mapping[str, Any]) -> bool:
    """A request without messages and without a resume only reads the snapshot; it is neither limited nor locked."""
    return not body.get("messages") and not body.get("resume")


def _admit_run(request: Request, principal_email: str, thread_id: str) -> RunPermit:
    """Rate limit (429) and one-active-run-per-thread lock (409); raised before the stream starts."""
    limits: RunLimits = request.app.state.run_limits
    scope = user_scope(principal_email)
    retry_after = limits.rate.try_acquire(scope)
    if retry_after is not None:
        get_metrics().runs_rejected.add(1, {"reason": "rate_limited"})
        header = retry_after_header(retry_after)
        raise ProblemError(
            429,
            "rate-limited",
            detail="Too many runs. Try again shortly.",
            headers={"Retry-After": header},
            retryAfter=int(header),
        )
    permit = limits.threads.try_acquire(scope, thread_id)
    if permit is None:
        get_metrics().runs_rejected.add(1, {"reason": "thread_busy"})
        raise ProblemError(409, "thread-busy", detail="This thread already has a run in progress.")
    return permit


@dataclass(frozen=True, slots=True)
class AgentRequestContext:
    agent_id: str
    thread: Thread


def _same_id(left: object, right: object) -> bool:
    return str(left).strip().lower() == str(right).strip().lower()


async def guard_agent_request(
    agent_id: str, request: Request, principal: PrincipalDep, session: SessionDep
) -> AsyncIterator[AgentRequestContext]:
    registry: AgentRegistry = request.app.state.agents
    if registry.get(agent_id) is None:
        raise ProblemError(404, "agent-not-found", detail="Unknown agent.")
    try:
        body = await request.json()
    except ValueError as exc:
        raise ProblemError(400, "invalid-request", detail="The request body is not valid JSON.") from exc
    if not isinstance(body, dict):
        raise ProblemError(400, "invalid-request", detail="The request body must be a JSON object.")
    thread_id = body.get("threadId", body.get("thread_id"))
    if not isinstance(thread_id, str) or not thread_id:
        raise ProblemError(400, "invalid-request", detail="threadId is required.")
    thread = await get_owned_thread(session, thread_id, principal.email)
    if thread is None:
        raise ProblemError(404, "thread-not-found", detail="The thread was not found.")
    state = body.get("state")
    if isinstance(state, Mapping):
        for key, expected in (("projectId", thread.project_id), ("itemId", thread.item_id)):
            if key in state and not _same_id(state[key], expected):
                raise ProblemError(400, "thread-mismatch", detail=f"state.{key} does not match the thread.")
    await session.rollback()  # end the read transaction before the long-running stream
    bind_agent_id(agent_id)
    agent_id_var.set(agent_id)
    thread_id_var.set(thread_id)
    permit = None if _is_hydrate(body) else _admit_run(request, principal.email, thread_id)
    _RUN_PERMIT.set(permit)
    try:
        yield AgentRequestContext(agent_id=agent_id, thread=thread)
    finally:  # safety net: the run releases the permit itself when the stream ends
        if permit is not None:
            permit.release()


AgentRequestDep = Annotated[AgentRequestContext, Depends(guard_agent_request)]


class _NullAgent:
    name = "agent-dispatcher"
    description = ""


class AgentDispatcher(AgentFrameworkAgent):
    """AG-UI runner that delegates to the registry's agent and keeps ``threads.status`` current.

    The status becomes ``running`` when a run starts and is derived from the stored snapshot when the stream ends
    (``awaiting_review`` for pending interrupts, ``awaiting_input`` for an unanswered client tool call such as
    ``ask_user``, otherwise ``idle``). Hydrate requests (no messages, no resume) only refresh the status.
    """

    def __init__(
        self,
        registry: AgentRegistry,
        *,
        snapshot_store: AGUIThreadSnapshotStore,
        sessionmaker: Any,
        timeout_seconds: float = 180.0,
    ) -> None:
        super().__init__(
            agent=cast(Any, _NullAgent()),
            name="agent-dispatcher",
            require_confirmation=False,
            snapshot_store=snapshot_store,
        )
        self._registry = registry
        self._store = snapshot_store
        self._sessionmaker = sessionmaker
        self._timeout_seconds = timeout_seconds

    async def run(
        self, input_data: dict[str, Any], *, function_invocation_kwargs: Mapping[str, Any] | None = None
    ) -> AsyncGenerator[BaseEvent, None]:
        agent_id = current_agent_id()
        runner = self._registry.get(agent_id) if agent_id else None
        principal = current_principal()
        thread_id = input_data.get("thread_id")
        if runner is None or principal is None or not isinstance(thread_id, str):
            raise RuntimeError("The AG-UI run has no agent, caller or thread bound.")  # guarded by the dependency
        scope = user_scope(principal.email)
        sessionmaker: async_sessionmaker[AsyncSession] = self._sessionmaker()
        hydrate = not input_data.get("messages") and not input_data.get("resume")
        run_id = input_data.get("run_id")
        run_id = run_id if isinstance(run_id, str) else None
        run_id_var.set(run_id)
        thread_id_var.set(thread_id)
        agent_id_var.set(agent_id)
        permit = _RUN_PERMIT.get()
        timeout = self._timeout_seconds
        bind_tool_services(ToolServices(self._store, sessionmaker))
        metrics = get_metrics()
        result = StreamResult()
        span = trace.get_current_span()
        span.set_attribute("agent.id", agent_id)
        started = time.perf_counter()
        if not hydrate:
            metrics.runs_started.add(1, {"agent": agent_id})
        try:
            if not hydrate:
                await mark_running(sessionmaker, thread_id=thread_id)
            events = runner.run(input_data, function_invocation_kwargs=function_invocation_kwargs)
            async for event in guarded_stream(events, run_id=run_id, timeout_seconds=timeout, result=result):
                yield event
        finally:
            if permit is not None:
                permit.release()
            if not hydrate:
                self._record_outcome(agent_id or "unknown", result, time.perf_counter() - started)
            # Also on client disconnect / cancellation: shield so the status write completes.
            task = asyncio.ensure_future(self._finish(sessionmaker, scope, thread_id))
            try:
                await asyncio.shield(task)
            except Exception:  # pragma: no cover - status is best effort, the next hydrate recomputes it
                logger.warning("Could not update the thread status", extra={"thread_id": thread_id})

    @staticmethod
    def _record_outcome(agent_id: str, result: StreamResult, seconds: float) -> None:
        metrics = get_metrics()
        span = trace.get_current_span()
        if result.error_code is not None:
            metrics.runs_failed.add(1, {"agent": agent_id, "code": result.error_code.value})
            outcome = "error"
            span.set_attribute("agent.run.error_code", result.error_code.value)
        else:
            metrics.runs_completed.add(1, {"agent": agent_id, "outcome": result.outcome})
            outcome = result.outcome
        span.set_attribute("agent.run.outcome", outcome)
        metrics.run_duration.record(seconds, {"agent": agent_id, "outcome": outcome})

    async def _finish(self, sessionmaker: async_sessionmaker[AsyncSession], scope: str, thread_id: str) -> None:
        await refresh_thread_status(sessionmaker, self._store, scope=scope, thread_id=thread_id)


def mount_agent_endpoint(
    app: FastAPI, registry: AgentRegistry, *, snapshot_store: AGUIThreadSnapshotStore, settings: Settings
) -> AgentDispatcher:
    dispatcher = AgentDispatcher(
        registry,
        snapshot_store=snapshot_store,
        sessionmaker=lambda: app.state.db.sessionmaker,
        timeout_seconds=settings.run_timeout_seconds,
    )
    add_agent_framework_fastapi_endpoint(
        app,
        dispatcher,
        AGENT_ENDPOINT_PATH,
        authorization_scope_resolver=agui_scope_resolver,
        dependencies=[Depends(guard_agent_request)],
        keepalive_seconds=settings.agui_keepalive_seconds,
        tags=["agents"],
    )
    return dispatcher
