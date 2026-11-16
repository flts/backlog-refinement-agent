"""FastAPI dependencies for project-scoped routes (``/projects/{project_id}/...``).

They resolve the caller's access through :mod:`backlog_api.authz` using the request's session and principal, so a route
only declares ``access: MemberAccessDep`` (any member) or ``access: OwnerAccessDep`` (owners only). Routes that change
membership or delete the project call ``require_member``/``require_owner`` with ``lock=True`` instead.
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import Depends, Path

from backlog_api.auth.dependencies import PrincipalDep
from backlog_api.authz import ProjectAccess, require_member, require_owner
from backlog_api.db.session import SessionDep

ProjectId = Annotated[uuid.UUID, Path(description="Project id.")]


async def get_member_access(project_id: ProjectId, principal: PrincipalDep, session: SessionDep) -> ProjectAccess:
    return await require_member(session, project_id, principal)


async def get_owner_access(project_id: ProjectId, principal: PrincipalDep, session: SessionDep) -> ProjectAccess:
    return await require_owner(session, project_id, principal)


MemberAccessDep = Annotated[ProjectAccess, Depends(get_member_access)]
OwnerAccessDep = Annotated[ProjectAccess, Depends(get_owner_access)]
