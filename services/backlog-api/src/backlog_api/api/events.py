"""Server-sent events: the project stream, stream tickets, presence and the internal stream for agent-service.

Wire format (``text/event-stream``), one block per event::

    id: 42
    event: item.updated
    data: {"id":42,"type":"item.updated","projectId":"…","actor":"alice@example.test","actorName":"Alice",
           "data":{…},"at":"…"}

* ``id`` is the ``project_events`` id (resume with ``Last-Event-ID`` or ``?lastEventId=``). Transient events
  (``presence``, ``reset``, ``closed``) have no ``id`` unless noted.
* A comment line (``: keepalive``) is sent every ``BACKLOG_EVENTS_HEARTBEAT_SECONDS``; the response is never buffered.
* ``reset``: the requested id is outside the resume window; the client must refetch everything. Its ``id`` is the
  current end of the log so a later reconnect resumes from there.
* ``closed`` (``data.data.reason``): the server ends the stream. ``member-removed``, ``project-deleted`` and
  ``not-a-member`` are final (do not reconnect); ``max-lifetime`` is routine (reconnect with ``Last-Event-ID``).

Authentication of the project stream: ``Authorization: Bearer <access token>`` (fetch-based clients) or ``?ticket=``,
a 60 s HMAC ticket from ``POST /projects/{id}/events/ticket`` for browsers' ``EventSource``, which cannot set headers.
Tickets are bound to one user and one project and are only accepted here. A ticket is only checked when the stream is
opened: after a connection drop, request a new ticket and pass ``lastEventId`` explicitly.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections import deque
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, Query, Request, Response, status
from fastapi.responses import StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import Field

from backlog_api import presence
from backlog_api.api.deps import MemberAccessDep, ProjectId
from backlog_api.api.schemas import ApiModel, ApiRequest
from backlog_api.auth.dependencies import authenticate_request, bearer_scheme, unauthorized
from backlog_api.auth.internal import ServiceCallerDep
from backlog_api.auth.principal import Principal
from backlog_api.authz import get_role
from backlog_api.db.models import PRESENCE_STATES
from backlog_api.db.session import SessionDep, get_database
from backlog_api.event_bus import SYSTEM_ACTOR, PostgresEventPublisher, StreamEvent
from backlog_api.events import (
    CLOSED,
    INTERNAL_EVENT_TYPES,
    MEMBER_REMOVED,
    PROJECT_DELETED,
    RESET,
)
from backlog_api.problems import ProblemError, not_found, problem_responses
from backlog_api.settings import Settings
from backlog_api.stream_tickets import TicketError, TicketSigner

logger = logging.getLogger(__name__)

router = APIRouter(tags=["events"])
internal_router = APIRouter(prefix="/internal", tags=["internal"], include_in_schema=False)

CLOSE_MEMBER_REMOVED = "member-removed"
CLOSE_PROJECT_DELETED = "project-deleted"
CLOSE_NOT_A_MEMBER = "not-a-member"
CLOSE_MAX_LIFETIME = "max-lifetime"
RETRY_MILLISECONDS = 3000
SEEN_IDS = 4096

STREAM_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
    "Connection": "keep-alive",
}

LastEventIdHeader = Annotated[
    str | None, Header(alias="Last-Event-ID", description="Resume after this event id (EventSource sets it).")
]
LastEventIdQuery = Annotated[
    str | None, Query(alias="lastEventId", description="Same as Last-Event-ID, for clients that cannot set headers.")
]

SSE_RESPONSES: dict[int | str, dict[str, Any]] = {
    200: {
        "description": "A `text/event-stream`; see the module documentation for the wire format.",
        "content": {"text/event-stream": {"schema": {"type": "string"}}},
    }
}


def _bus(request: Request) -> PostgresEventPublisher:
    bus: PostgresEventPublisher | None = getattr(request.app.state, "event_bus", None)
    if bus is None or not bus.started:
        raise ProblemError(503, "events-unavailable", detail="The event service is not available.")
    return bus


def _settings(request: Request) -> Settings:
    return request.app.state.settings


def _signer(request: Request) -> TicketSigner:
    signer: TicketSigner | None = getattr(request.app.state, "ticket_signer", None)
    if signer is None:
        raise ProblemError(
            503, "tickets-disabled", detail="Stream tickets are not configured (BACKLOG_EVENTS_TICKET_SECRET)."
        )
    return signer


BusDep = Annotated[PostgresEventPublisher, Depends(_bus)]
SettingsDep = Annotated[Settings, Depends(_settings)]


def _parse_last_event_id(header: str | None, query: str | None) -> tuple[bool, int | None]:
    """Returns ``(supplied, id)``; ``id`` is ``None`` when the value is not a valid event id (-> reset)."""
    raw = (header or query or "").strip()
    if not raw:
        return False, None
    try:
        value = int(raw)
    except ValueError:
        return True, None
    return True, value if value >= 0 else None


def _system_event(
    event_type: str, project_id: uuid.UUID | None, data: dict[str, Any], *, event_id: int | None = None
) -> str:
    event = StreamEvent(
        type=event_type,
        project_id=project_id or uuid.UUID(int=0),
        actor=SYSTEM_ACTOR,
        data=data,
        at=datetime.now(UTC),
    )
    return event.to_sse(event_id=event_id)


async def _event_stream(
    bus: PostgresEventPublisher,
    settings: Settings,
    *,
    project_id: uuid.UUID | None,
    types: frozenset[str] | None,
    last_event_id: tuple[bool, int | None],
    member_email: str | None,
) -> AsyncIterator[str]:
    """The SSE body. Subscribes first and replays second, so no event is lost between them (duplicates are dropped).

    ``member_email`` set: a project stream whose user's membership is re-checked on removal events and periodically.
    """
    loop = asyncio.get_running_loop()
    subscription = bus.subscribe(project_id=project_id, types=types)
    seen: deque[int] = deque(maxlen=SEEN_IDS)
    seen_set: set[int] = set()

    def remember(event_id: int) -> bool:
        if event_id in seen_set:
            return False
        if len(seen) == seen.maxlen:
            seen_set.discard(seen[0])
        seen.append(event_id)
        seen_set.add(event_id)
        return True

    async def still_member() -> bool:
        if member_email is None or project_id is None:
            return True
        async with bus.database.sessionmaker() as session:
            return await get_role(session, project_id, member_email) is not None

    def revokes(event: StreamEvent) -> str | None:
        if member_email is None:
            return None
        if event.type == PROJECT_DELETED:
            return CLOSE_PROJECT_DELETED
        if event.type == MEMBER_REMOVED and str(event.data.get("email", "")).lower() == member_email:
            return CLOSE_MEMBER_REMOVED
        return None

    try:
        yield f"retry: {RETRY_MILLISECONDS}\n: connected\n\n"
        pending: list[StreamEvent] = []
        supplied, last_id = last_event_id
        if supplied:
            replay = await bus.replay(last_id, project_id=project_id, types=types) if last_id is not None else None
            if replay is None or replay.reset:
                latest = replay.latest_id if replay else await bus.latest_event_id()
                yield _system_event(RESET, project_id, {"latestEventId": latest}, event_id=latest)
            else:
                pending = replay.events
        if project_id is not None and (types is None or "presence" in types):
            yield (await bus.current_presence(project_id)).to_sse()

        started = loop.time()
        next_check = started + settings.events_recheck_seconds
        deadline = started + settings.events_max_stream_seconds
        replayed = iter(pending)
        while True:
            event: StreamEvent | None = next(replayed, None)
            if event is None:
                now = loop.time()
                if now >= deadline:
                    yield _system_event(CLOSED, project_id, {"reason": CLOSE_MAX_LIFETIME})
                    return
                if now >= next_check:
                    next_check = now + settings.events_recheck_seconds
                    if not await still_member():
                        yield _system_event(CLOSED, project_id, {"reason": CLOSE_NOT_A_MEMBER})
                        return
                timeout = min(settings.events_heartbeat_seconds, next_check - now, deadline - now)
                try:
                    event = await asyncio.wait_for(subscription.get(), timeout=max(timeout, 0.01))
                except TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                if event is None:
                    return  # shutting down, or dropped as too slow: the client reconnects and resumes
            if event.id is not None and not remember(event.id):
                continue
            yield event.to_sse()
            reason = revokes(event)
            if reason is not None and not await still_member():
                yield _system_event(CLOSED, project_id, {"reason": reason})
                return
    finally:
        subscription.close()


def _streaming_response(body: AsyncIterator[str]) -> StreamingResponse:
    return StreamingResponse(body, media_type="text/event-stream", headers=STREAM_HEADERS)


# --- project stream -------------------------------------------------------------------------------------------------


class StreamTicketOut(ApiModel):
    ticket: str = Field(description="Pass as `?ticket=` to the event stream of the same project.")
    expires_at: datetime = Field(description="The ticket is only accepted until this time (about 60 seconds).")


@router.post(
    "/projects/{project_id}/events/ticket",
    status_code=status.HTTP_201_CREATED,
    summary="Get a short-lived ticket for opening the event stream without an Authorization header",
    responses=problem_responses(401, 403, 404, 503),
)
async def create_stream_ticket(
    project_id: ProjectId, access: MemberAccessDep, signer: Annotated[TicketSigner, Depends(_signer)]
) -> StreamTicketOut:
    ticket = signer.issue(access.principal.email, project_id)
    return StreamTicketOut(ticket=signer.encode(ticket), expires_at=datetime.fromtimestamp(ticket.expires_at, UTC))


async def _stream_principal(
    request: Request, credentials: HTTPAuthorizationCredentials | None, ticket: str | None, project_id: uuid.UUID
) -> Principal:
    if ticket:
        try:
            claims = _signer(request).verify(ticket)
        except TicketError as exc:
            raise unauthorized(str(exc)) from exc
        if claims.project_id != project_id:
            raise ProblemError(403, "ticket-project-mismatch", detail="The stream ticket is for another project.")
        return Principal(email=claims.email)
    return await authenticate_request(request, credentials.credentials if credentials else None)


@router.get(
    "/projects/{project_id}/events",
    summary="Live project events (server-sent events)",
    description=__doc__,
    response_class=StreamingResponse,
    responses={**SSE_RESPONSES, **problem_responses(401, 403, 404, 503)},
)
async def stream_project_events(
    request: Request,
    project_id: ProjectId,
    bus: BusDep,
    settings: SettingsDep,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)] = None,
    ticket: Annotated[str | None, Query(description="Stream ticket (alternative to the Authorization header).")] = None,
    last_event_id_header: LastEventIdHeader = None,
    last_event_id_query: LastEventIdQuery = None,
) -> StreamingResponse:
    principal = await _stream_principal(request, credentials, ticket, project_id)
    # A short-lived session: the stream itself must not hold a database connection.
    async with get_database(request).sessionmaker() as session:
        if await get_role(session, project_id, principal.email) is None:
            raise not_found("The project does not exist or you are not a member.")
    body = _event_stream(
        bus,
        settings,
        project_id=project_id,
        types=None,
        last_event_id=_parse_last_event_id(last_event_id_header, last_event_id_query),
        member_email=principal.email,
    )
    return _streaming_response(body)


# --- presence -------------------------------------------------------------------------------------------------------


class PresenceUserOut(ApiModel):
    email: str
    name: str | None = None
    item_id: uuid.UUID | None = None
    state: str


class PresenceList(ApiModel):
    users: list[PresenceUserOut]


class PresenceHeartbeat(ApiRequest):
    item_id: uuid.UUID | None = Field(default=None, description="The item being looked at, or null for the project.")
    state: str = Field(default="viewing", pattern=f"^({'|'.join(PRESENCE_STATES)})$")


def _presence_out(users: list[presence.PresenceUser]) -> PresenceList:
    return PresenceList(
        users=[PresenceUserOut(email=u.email, name=u.name, item_id=u.item_id, state=u.state) for u in users]
    )


@router.get(
    "/projects/{project_id}/presence",
    summary="Who is currently active in the project",
    responses=problem_responses(401, 404),
)
async def get_presence(project_id: ProjectId, access: MemberAccessDep, session: SessionDep) -> PresenceList:
    return _presence_out(await presence.list_active(session, project_id))


@router.post(
    "/projects/{project_id}/presence",
    summary="Presence heartbeat (send every ~20 s; entries expire after 45 s)",
    responses=problem_responses(401, 404, 422),
)
async def put_presence(
    project_id: ProjectId,
    body: PresenceHeartbeat,
    access: MemberAccessDep,
    session: SessionDep,
    settings: SettingsDep,
) -> PresenceList:
    await presence.heartbeat(
        session,
        project_id,
        access.principal.email,
        item_id=body.item_id,
        state=body.state,
        ttl_seconds=settings.presence_ttl_seconds,
    )
    await session.commit()
    return _presence_out(await presence.list_active(session, project_id))


@router.delete(
    "/projects/{project_id}/presence",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Leave: remove the caller's presence",
    responses=problem_responses(401, 404),
)
async def delete_presence(project_id: ProjectId, access: MemberAccessDep, session: SessionDep) -> Response:
    await presence.leave(session, project_id, access.principal.email)
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --- internal stream (agent-service) --------------------------------------------------------------------------------


@internal_router.get(
    "/events",
    summary="Cross-project stream of project.deleted, member.removed and item.deleted (service credentials)",
    response_class=StreamingResponse,
)
async def stream_internal_events(
    _caller: ServiceCallerDep,
    bus: BusDep,
    settings: SettingsDep,
    last_event_id_header: LastEventIdHeader = None,
    last_event_id_query: LastEventIdQuery = None,
) -> StreamingResponse:
    body = _event_stream(
        bus,
        settings,
        project_id=None,
        types=INTERNAL_EVENT_TYPES,
        last_event_id=_parse_last_event_id(last_event_id_header, last_event_id_query),
        member_email=None,
    )
    return _streaming_response(body)
