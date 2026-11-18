"""Projects and project members (membership by email, no invitations)."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, cast
from urllib.parse import quote

from fastapi import APIRouter, Header, Path, Response, status
from pydantic import AfterValidator, Field, StringConstraints
from sqlalchemy import case, delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backlog_api import audit, events
from backlog_api.api.deps import MemberAccessDep, ProjectId
from backlog_api.api.schemas import ApiModel, ApiRequest
from backlog_api.auth.dependencies import PrincipalDep
from backlog_api.authz import Role, count_owners, require_member, require_owner
from backlog_api.concurrency import etag, parse_if_match, version_conflict
from backlog_api.db.models import ROLE_CONTRIBUTOR, ROLE_OWNER, Project, ProjectMember, User
from backlog_api.db.session import SessionDep
from backlog_api.events import DomainEvent, EventPublisherDep
from backlog_api.identity import MAX_EMAIL_LENGTH, is_valid_email, normalize_email
from backlog_api.problems import ProblemError, conflict, problem_responses
from backlog_api.settings import API_PREFIX

router = APIRouter(tags=["projects"])

MAX_PROJECT_NAME_LENGTH = 200

ProjectName = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_PROJECT_NAME_LENGTH),
    Field(description="Display name of the project."),
]
MemberEmail = Annotated[str, Path(description="Member email address (case-insensitive).", max_length=320)]
IfMatch = Annotated[
    str | None, Header(alias="If-Match", description="The project version (ETag) this change is based on.")
]


def _email(value: str) -> str:
    email = normalize_email(value)
    if not is_valid_email(email):
        raise ValueError("Enter a valid email address.")
    return email


EmailAddress = Annotated[str, Field(max_length=MAX_EMAIL_LENGTH + 64), AfterValidator(_email)]


class ProjectOut(ApiModel):
    id: uuid.UUID
    name: str
    version: int
    role: Role = Field(description="The caller's role in this project.")
    created_by: str
    created_at: datetime
    updated_at: datetime


class ProjectList(ApiModel):
    items: list[ProjectOut]


class ProjectCreate(ApiRequest):
    name: ProjectName


class ProjectUpdate(ApiRequest):
    name: ProjectName


class MemberOut(ApiModel):
    email: str
    role: Role
    name: str | None = Field(description="Display name once the member has signed in; otherwise null.")
    signed_in: bool = Field(description="Whether this email address has signed in at least once.")
    added_by: str
    added_at: datetime


class MemberList(ApiModel):
    items: list[MemberOut]


class MemberAdd(ApiRequest):
    email: EmailAddress
    role: Role = ROLE_CONTRIBUTOR


class MemberUpdate(ApiRequest):
    role: Role


def _project_out(project: Project, role: str) -> ProjectOut:
    return ProjectOut(
        id=project.id,
        name=project.name,
        version=project.version,
        role=cast(Role, role),
        created_by=project.created_by,
        created_at=project.created_at,
        updated_at=project.updated_at,
    )


def _project_location(project_id: uuid.UUID) -> str:
    return f"{API_PREFIX}/projects/{project_id}"


def _last_owner() -> ProblemError:
    return conflict(
        "last-owner",
        "A project needs at least one owner. Make someone else an owner first.",
    )


def _member_not_found() -> ProblemError:
    return ProblemError(404, "member-not-found", detail="This email address is not a member of the project.")


async def _load_project(session: AsyncSession, project_id: uuid.UUID) -> Project:
    project = await session.get(Project, project_id, populate_existing=True)
    if project is None:  # pragma: no cover - membership was just verified in the same transaction
        raise ProblemError(404, "not-found", detail="The project does not exist.")
    return project


@router.get("/projects", summary="Projects you are a member of", responses=problem_responses(401, 403))
async def list_projects(principal: PrincipalDep, session: SessionDep) -> ProjectList:
    rows = await session.execute(
        select(Project, ProjectMember.role)
        .join(ProjectMember, ProjectMember.project_id == Project.id)
        .where(ProjectMember.email == principal.email)
        .order_by(func.lower(Project.name), Project.created_at)
    )
    return ProjectList(items=[_project_out(project, role) for project, role in rows.all()])


@router.post(
    "/projects",
    status_code=status.HTTP_201_CREATED,
    summary="Create a project (you become its owner)",
    responses=problem_responses(401, 403, 422),
)
async def create_project(
    body: ProjectCreate,
    principal: PrincipalDep,
    session: SessionDep,
    publisher: EventPublisherDep,
    response: Response,
) -> ProjectOut:
    project = Project(id=uuid.uuid4(), name=body.name, version=1, created_by=principal.email)
    session.add(project)
    await session.flush()
    session.add(ProjectMember(project_id=project.id, email=principal.email, role=ROLE_OWNER, added_by=principal.email))
    audit.record(
        session, actor=principal.email, action=audit.PROJECT_CREATED, project_id=project.id, details={"name": body.name}
    )
    await session.commit()
    await session.refresh(project)
    response.headers["Location"] = _project_location(project.id)
    response.headers["ETag"] = etag(project.version)
    await publisher.publish(DomainEvent(events.PROJECT_CREATED, project.id, principal.email, {"name": project.name}))
    return _project_out(project, ROLE_OWNER)


@router.get("/projects/{project_id}", summary="Get a project", responses=problem_responses(401, 403, 404, 422))
async def get_project(
    project_id: ProjectId, access: MemberAccessDep, session: SessionDep, response: Response
) -> ProjectOut:
    project = await _load_project(session, project_id)
    response.headers["ETag"] = etag(project.version)
    return _project_out(project, access.role)


@router.patch(
    "/projects/{project_id}",
    summary="Rename a project (owners; requires If-Match)",
    responses=problem_responses(400, 401, 403, 404, 409, 422, 428),
)
async def update_project(
    project_id: ProjectId,
    body: ProjectUpdate,
    principal: PrincipalDep,
    session: SessionDep,
    publisher: EventPublisherDep,
    response: Response,
    if_match: IfMatch = None,
) -> ProjectOut:
    access = await require_owner(session, project_id, principal, lock=True)
    expected_version = parse_if_match(if_match)
    project = await _load_project(session, project_id)
    if project.version != expected_version:
        raise version_conflict(project.version)
    previous_name = project.name
    if body.name != previous_name:
        await session.execute(
            update(Project)
            .where(Project.id == project_id)
            .values(name=body.name, version=Project.version + 1, updated_at=func.now())
        )
        audit.record(
            session,
            actor=principal.email,
            action=audit.PROJECT_RENAMED,
            project_id=project_id,
            details={"from": previous_name, "to": body.name},
        )
        await session.commit()
        project = await _load_project(session, project_id)
        await publisher.publish(
            DomainEvent(
                events.PROJECT_UPDATED,
                project_id,
                principal.email,
                {"name": project.name, "version": project.version},
            )
        )
    response.headers["ETag"] = etag(project.version)
    return _project_out(project, access.role)


@router.delete(
    "/projects/{project_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a project and everything in it (owners)",
    responses=problem_responses(400, 401, 403, 404, 409, 422),
)
async def delete_project(
    project_id: ProjectId,
    principal: PrincipalDep,
    session: SessionDep,
    publisher: EventPublisherDep,
    if_match: IfMatch = None,
) -> Response:
    await require_owner(session, project_id, principal, lock=True)
    project = await _load_project(session, project_id)
    if if_match is not None and parse_if_match(if_match) != project.version:
        raise version_conflict(project.version)
    audit.record(
        session,
        actor=principal.email,
        action=audit.PROJECT_DELETED,
        project_id=project_id,
        details={"projectId": str(project_id), "name": project.name},
    )
    await session.execute(delete(Project).where(Project.id == project_id))
    await session.commit()
    await publisher.publish(DomainEvent(events.PROJECT_DELETED, project_id, principal.email, {}))
    return Response(status_code=status.HTTP_204_NO_CONTENT)


async def _member_out(session: AsyncSession, project_id: uuid.UUID, email: str) -> MemberOut:
    row = (
        await session.execute(
            select(ProjectMember, User.name, User.email)
            .outerjoin(User, User.email == ProjectMember.email)
            .where(ProjectMember.project_id == project_id, ProjectMember.email == email)
        )
    ).first()
    if row is None:
        raise _member_not_found()
    member, name, user_email = row
    return _to_member_out(member, name, user_email)


def _to_member_out(member: ProjectMember, name: str | None, user_email: str | None) -> MemberOut:
    return MemberOut(
        email=member.email,
        role=cast(Role, member.role),
        name=name,
        signed_in=user_email is not None,
        added_by=member.added_by,
        added_at=member.added_at,
    )


@router.get(
    "/projects/{project_id}/members",
    summary="Members of a project",
    tags=["members"],
    responses=problem_responses(401, 403, 404, 422),
)
async def list_members(project_id: ProjectId, access: MemberAccessDep, session: SessionDep) -> MemberList:
    rows = await session.execute(
        select(ProjectMember, User.name, User.email)
        .outerjoin(User, User.email == ProjectMember.email)
        .where(ProjectMember.project_id == project_id)
        .order_by(case((ProjectMember.role == ROLE_OWNER, 0), else_=1), ProjectMember.email)
    )
    return MemberList(items=[_to_member_out(member, name, email) for member, name, email in rows.all()])


@router.post(
    "/projects/{project_id}/members",
    status_code=status.HTTP_201_CREATED,
    summary="Add a member by email address (owners; access is immediate)",
    tags=["members"],
    responses=problem_responses(401, 403, 404, 409, 422),
)
async def add_member(
    project_id: ProjectId,
    body: MemberAdd,
    principal: PrincipalDep,
    session: SessionDep,
    publisher: EventPublisherDep,
    response: Response,
) -> MemberOut:
    await require_owner(session, project_id, principal, lock=True)
    existing = await session.get(ProjectMember, (project_id, body.email))
    if existing is not None:
        raise conflict("already-member", "This email address is already a member of the project.", email=body.email)
    session.add(ProjectMember(project_id=project_id, email=body.email, role=body.role, added_by=principal.email))
    audit.record(
        session,
        actor=principal.email,
        action=audit.MEMBER_ADDED,
        project_id=project_id,
        details={"email": body.email, "role": body.role},
    )
    await session.commit()
    member = await _member_out(session, project_id, body.email)
    response.headers["Location"] = f"{_project_location(project_id)}/members/{quote(body.email, safe='@')}"
    await publisher.publish(
        DomainEvent(events.MEMBER_ADDED, project_id, principal.email, {"email": body.email, "role": body.role})
    )
    return member


@router.patch(
    "/projects/{project_id}/members/{email}",
    summary="Change a member's role (owners)",
    tags=["members"],
    responses=problem_responses(401, 403, 404, 409, 422),
)
async def update_member(
    project_id: ProjectId,
    email: MemberEmail,
    body: MemberUpdate,
    principal: PrincipalDep,
    session: SessionDep,
    publisher: EventPublisherDep,
) -> MemberOut:
    await require_owner(session, project_id, principal, lock=True)
    target = normalize_email(email)
    member = await session.get(ProjectMember, (project_id, target))
    if member is None:
        raise _member_not_found()
    previous_role = member.role
    if body.role != previous_role:
        if previous_role == ROLE_OWNER and await count_owners(session, project_id) <= 1:
            raise _last_owner()
        member.role = body.role
        audit.record(
            session,
            actor=principal.email,
            action=audit.MEMBER_ROLE_CHANGED,
            project_id=project_id,
            details={"email": member.email, "from": previous_role, "to": body.role},
        )
        await session.commit()
        await publisher.publish(
            DomainEvent(
                events.MEMBER_UPDATED,
                project_id,
                principal.email,
                {"email": target, "role": body.role, "previousRole": previous_role},
            )
        )
    return await _member_out(session, project_id, target)


@router.delete(
    "/projects/{project_id}/members/{email}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Remove a member (owners) or leave the project (yourself)",
    tags=["members"],
    responses=problem_responses(401, 403, 404, 409, 422),
)
async def remove_member(
    project_id: ProjectId,
    email: MemberEmail,
    principal: PrincipalDep,
    session: SessionDep,
    publisher: EventPublisherDep,
) -> Response:
    access = await require_member(session, project_id, principal, lock=True)
    target = normalize_email(email)
    leaving = target == principal.email
    if not leaving and not access.is_owner:
        raise ProblemError(403, "owner-required", detail="Only project owners can remove other members.")
    member = await session.get(ProjectMember, (project_id, target))
    if member is None:
        raise _member_not_found()
    if member.role == ROLE_OWNER and await count_owners(session, project_id) <= 1:
        raise _last_owner()
    removed_role = member.role
    await session.delete(member)
    audit.record(
        session,
        actor=principal.email,
        action=audit.MEMBER_REMOVED,
        project_id=project_id,
        details={"email": target, "role": removed_role, "left": leaving},
    )
    await session.commit()
    await publisher.publish(
        DomainEvent(events.MEMBER_REMOVED, project_id, principal.email, {"email": target, "left": leaving})
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
