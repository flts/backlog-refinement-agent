"""Per-project authorization. Every REST route and MCP tool resolves access through these functions.

Membership is keyed by the principal's normalized email. Callers that are not members get **404** (the project's
existence is not revealed); members whose role is insufficient get **403**.

Use ``lock=True`` inside a transaction that changes membership or deletes the project: it takes a row lock on the
project (``SELECT … FOR UPDATE``) first, so concurrent changes such as two owners demoting each other are serialized
and the last-owner invariant holds.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Literal, cast

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backlog_api.auth.principal import Principal
from backlog_api.db.models import ROLE_OWNER, Project, ProjectMember
from backlog_api.problems import ProblemError, not_found

Role = Literal["owner", "contributor"]

PROJECT_NOT_FOUND_DETAIL = "The project does not exist or you are not a member."


@dataclass(frozen=True, slots=True)
class ProjectAccess:
    project_id: uuid.UUID
    principal: Principal
    role: Role

    @property
    def is_owner(self) -> bool:
        return self.role == ROLE_OWNER


async def get_role(session: AsyncSession, project_id: uuid.UUID, email: str) -> Role | None:
    role = await session.scalar(
        select(ProjectMember.role).where(ProjectMember.project_id == project_id, ProjectMember.email == email)
    )
    return cast(Role | None, role)


async def lock_project(session: AsyncSession, project_id: uuid.UUID) -> bool:
    """Lock the project row for the rest of the transaction. Returns ``False`` when the project does not exist."""
    locked = await session.scalar(select(Project.id).where(Project.id == project_id).with_for_update())
    return locked is not None


async def require_member(
    session: AsyncSession, project_id: uuid.UUID, principal: Principal, *, lock: bool = False
) -> ProjectAccess:
    """Return the caller's access to the project; 404 when the project does not exist or the caller is no member."""
    if lock and not await lock_project(session, project_id):
        raise not_found(PROJECT_NOT_FOUND_DETAIL)
    role = await get_role(session, project_id, principal.email)
    if role is None:
        raise not_found(PROJECT_NOT_FOUND_DETAIL)
    return ProjectAccess(project_id=project_id, principal=principal, role=role)


async def require_owner(
    session: AsyncSession, project_id: uuid.UUID, principal: Principal, *, lock: bool = False
) -> ProjectAccess:
    """Like :func:`require_member`, but contributors get 403 ``owner-required``."""
    access = await require_member(session, project_id, principal, lock=lock)
    if not access.is_owner:
        raise ProblemError(403, "owner-required", detail="Only project owners can do this.")
    return access


async def count_owners(session: AsyncSession, project_id: uuid.UUID) -> int:
    count = await session.scalar(
        select(func.count())
        .select_from(ProjectMember)
        .where(ProjectMember.project_id == project_id, ProjectMember.role == ROLE_OWNER)
    )
    return int(count or 0)
