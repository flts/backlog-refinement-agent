"""Private threads (``/api/agent/threads``) and message feedback (``/api/agent/feedback``).

A thread belongs to one user (normalized verified email); other users get 404. Creating a thread checks with the user's
own token that the project and item exist and that the user is a member.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Path, Query, Request, Response, status
from pydantic import StringConstraints
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from agent_service.api.schemas import ApiModel, ApiRequest
from agent_service.auth.dependencies import AccessTokenDep, PrincipalDep
from agent_service.backlog import BacklogClient
from agent_service.db.models import Feedback, Thread, ThreadSnapshot
from agent_service.db.session import SessionDep
from agent_service.identity import user_scope
from agent_service.problems import ProblemError, problem_responses
from agent_service.settings import API_PREFIX
from agent_service.threads.repository import get_owned_thread

router = APIRouter(tags=["threads"])

ThreadTitle = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
ThreadIdParam = Annotated[str, Path(max_length=64, description="Thread id (the AG-UI threadId).")]


class ThreadOut(ApiModel):
    id: str
    title: str | None
    status: Literal["idle", "running", "awaiting_input", "awaiting_review"]
    project_id: uuid.UUID
    item_id: uuid.UUID
    created_at: datetime
    updated_at: datetime


class ThreadList(ApiModel):
    items: list[ThreadOut]


class ThreadCreate(ApiRequest):
    project_id: uuid.UUID
    item_id: uuid.UUID
    title: ThreadTitle | None = None


class ThreadUpdate(ApiRequest):
    title: ThreadTitle


class FeedbackIn(ApiRequest):
    thread_id: ThreadIdParam
    message_id: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    rating: Literal["up", "down"]
    comment: Annotated[str, StringConstraints(max_length=2000)] | None = None


class FeedbackOut(ApiModel):
    thread_id: str
    message_id: str
    rating: Literal["up", "down"]
    comment: str | None


def _out(thread: Thread) -> ThreadOut:
    return ThreadOut(
        id=thread.id,
        title=thread.title,
        status=thread.status,  # pyright: ignore[reportArgumentType]
        project_id=thread.project_id,
        item_id=thread.item_id,
        created_at=thread.created_at,
        updated_at=thread.updated_at,
    )


async def _owned(session: AsyncSession, thread_id: str, email: str) -> Thread:
    thread = await get_owned_thread(session, thread_id, email)
    if thread is None:
        raise ProblemError(404, "thread-not-found", detail="The thread was not found.")
    return thread


@router.get("/threads", summary="Your threads", responses=problem_responses(401, 403))
async def list_threads(
    principal: PrincipalDep,
    session: SessionDep,
    project_id: Annotated[uuid.UUID | None, Query(alias="projectId")] = None,
    item_id: Annotated[uuid.UUID | None, Query(alias="itemId")] = None,
) -> ThreadList:
    statement = select(Thread).where(Thread.owner_email == principal.email)
    if project_id is not None:
        statement = statement.where(Thread.project_id == project_id)
    if item_id is not None:
        statement = statement.where(Thread.item_id == item_id)
    rows = (await session.execute(statement.order_by(Thread.updated_at.desc(), Thread.id))).scalars().all()
    return ThreadList(items=[_out(thread) for thread in rows])


@router.post(
    "/threads",
    status_code=status.HTTP_201_CREATED,
    summary="Create a thread for an item",
    responses=problem_responses(401, 403, 404, 422, 503),
)
async def create_thread(
    body: ThreadCreate,
    request: Request,
    response: Response,
    principal: PrincipalDep,
    token: AccessTokenDep,
    session: SessionDep,
) -> ThreadOut:
    backlog: BacklogClient = request.app.state.backlog
    await backlog.ensure_project_member(body.project_id, token=token)
    await backlog.ensure_item(body.project_id, body.item_id, token=token)
    thread = Thread(
        id=str(uuid.uuid4()),
        owner_email=principal.email,
        project_id=body.project_id,
        item_id=body.item_id,
        title=body.title,
    )
    session.add(thread)
    await session.commit()
    await session.refresh(thread)
    response.headers["Location"] = f"{API_PREFIX}/threads/{thread.id}"
    return _out(thread)


@router.patch("/threads/{thread_id}", summary="Rename a thread", responses=problem_responses(401, 403, 404, 422))
async def update_thread(
    thread_id: ThreadIdParam, body: ThreadUpdate, principal: PrincipalDep, session: SessionDep
) -> ThreadOut:
    thread = await _owned(session, thread_id, principal.email)
    thread.title = body.title
    await session.commit()
    await session.refresh(thread)
    return _out(thread)


@router.delete(
    "/threads/{thread_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a thread with its snapshot and feedback",
    responses=problem_responses(401, 403, 404),
)
async def delete_thread(thread_id: ThreadIdParam, principal: PrincipalDep, session: SessionDep) -> Response:
    thread = await _owned(session, thread_id, principal.email)
    snapshot = await session.get(ThreadSnapshot, (user_scope(principal.email), thread.id))
    if snapshot is not None:
        await session.delete(snapshot)
    await session.delete(thread)  # feedback rows cascade
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/feedback", summary="Rate an assistant message", responses=problem_responses(401, 403, 404, 422))
async def submit_feedback(body: FeedbackIn, principal: PrincipalDep, session: SessionDep) -> FeedbackOut:
    thread = await _owned(session, body.thread_id, principal.email)
    values = {"rating": body.rating, "comment": body.comment}
    statement = insert(Feedback).values(
        id=uuid.uuid4(), thread_id=thread.id, message_id=body.message_id, owner_email=principal.email, **values
    )
    await session.execute(statement.on_conflict_do_update(constraint="uq_feedback_thread_message_owner", set_=values))
    await session.commit()
    return FeedbackOut(thread_id=thread.id, message_id=body.message_id, rating=body.rating, comment=body.comment)
