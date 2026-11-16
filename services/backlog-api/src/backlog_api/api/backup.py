"""Project backup: owner-only export and import as a new project (format v2, see :mod:`backlog_api.backup`)."""

from __future__ import annotations

import re
import unicodedata
from datetime import UTC, datetime
from typing import Annotated, cast

import anyio.to_thread
from fastapi import APIRouter, Depends, Request, Response, status
from fastapi.responses import StreamingResponse
from pydantic import Field
from sqlalchemy.ext.asyncio import AsyncSession

from backlog_api import audit, backup
from backlog_api.api.deps import OwnerAccessDep, ProjectId
from backlog_api.api.projects import ProjectOut, _project_location, _project_out
from backlog_api.api.schemas import ApiModel
from backlog_api.auth.dependencies import PrincipalDep
from backlog_api.concurrency import etag
from backlog_api.db.models import ROLE_OWNER, Project
from backlog_api.db.session import SessionDep
from backlog_api.events import EventPublisherDep
from backlog_api.files import FileStoreDep
from backlog_api.guidance import SkillsDep, default_guidance
from backlog_api.problems import ProblemError, problem_responses
from backlog_api.settings import Settings

router = APIRouter(tags=["backup"])

_SLUG_UNSAFE = re.compile(r"[^a-z0-9]+")


class ImportCountsOut(ApiModel):
    items: int
    revisions: int
    relationships: int
    sources: int
    files: int
    guidance_overrides: int


class ProjectImportOut(ApiModel):
    project: ProjectOut
    counts: ImportCountsOut = Field(description="What was created in the new project.")


def _settings(request: Request) -> Settings:
    return cast(Settings, request.app.state.settings)


SettingsDep = Annotated[Settings, Depends(_settings)]


def _slug(name: str) -> str:
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return _SLUG_UNSAFE.sub("-", ascii_name.lower()).strip("-")[:60] or "project"


@router.get(
    "/projects/{project_id}/backup",
    summary="Export the project as a backup file, format v2 (owners)",
    description=(
        "A JSON document (`format: backlog-project-backup`, `formatVersion: 2`) with the project name, guidance "
        "overrides, items with their revisions, relationships and sources with their original files (base64). "
        "Members, conversations, the audit log and search indexes are not included. Answers 413 `backup-too-large` "
        "when the document would exceed the configured limit (default 50 MiB)."
    ),
    response_class=Response,
    responses={
        200: {"description": "The backup document.", "content": {"application/json": {}}},
        **problem_responses(401, 403, 404, 413, 422),
    },
)
async def export_project_backup(
    project_id: ProjectId,
    access: OwnerAccessDep,
    principal: PrincipalDep,
    session: SessionDep,
    files: FileStoreDep,
    settings: SettingsDep,
) -> Response:
    project = await session.get(Project, project_id)
    if project is None:  # pragma: no cover - ownership was just verified in the same transaction
        raise ProblemError(404, "not-found", detail="The project does not exist.")
    name = project.name
    chunks = await backup.export_project(
        session, files, project, exported_by=principal.email, limit=settings.backup_max_bytes
    )
    audit.record(
        session,
        actor=principal.email,
        action=backup.AUDIT_PROJECT_EXPORTED,
        project_id=project_id,
        details={"bytes": sum(len(chunk) for chunk in chunks)},
    )
    await session.commit()
    filename = f"{_slug(name)}-backup-{datetime.now(UTC):%Y-%m-%d}.json"
    return StreamingResponse(
        iter(chunks),
        media_type="application/json",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Length": str(sum(len(chunk) for chunk in chunks)),
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


async def _commit_import(session: AsyncSession, project: Project, counts: backup.ImportCounts) -> ProjectImportOut:
    await session.commit()
    await session.refresh(project)
    return ProjectImportOut(
        project=_project_out(project, ROLE_OWNER),
        counts=ImportCountsOut(
            items=counts.items,
            revisions=counts.revisions,
            relationships=counts.relationships,
            sources=counts.sources,
            files=counts.files,
            guidance_overrides=counts.guidance_overrides,
        ),
    )


@router.post(
    "/projects/import",
    status_code=status.HTTP_201_CREATED,
    summary="Create a new project from a backup file (you become its owner)",
    description=(
        "The request body is the backup JSON (`application/json`, up to the backup limit, default 50 MiB). Accepts "
        "format `backlog-project-backup` version 2 and, mapped to it, the single-user app's version 1 export "
        "(`backlog-refinement-project`; conversations are dropped and v1 revisions become manual revisions). The "
        "whole document is validated first (422 `invalid-backup` lists the problems, 422 `unsupported-format` for "
        "other formats); then one new project is created in a single transaction. Members are never imported. "
        "Source and item indexing is queued."
    ),
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {"application/json": {"schema": {"$ref": "#/components/schemas/BackupDocument"}}},
        }
    },
    responses=problem_responses(401, 403, 413, 415, 422),
)
async def import_project_backup(
    request: Request,
    principal: PrincipalDep,
    session: SessionDep,
    publisher: EventPublisherDep,
    files: FileStoreDep,
    settings: SettingsDep,
    skills: SkillsDep,
    response: Response,
) -> ProjectImportOut:
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type != "application/json":
        raise ProblemError(415, "unsupported-media-type", detail="Send the backup file as application/json.")
    body = await request.body()
    defaults = default_guidance(skills)
    prepared = await anyio.to_thread.run_sync(
        lambda: backup.prepare_backup(body, settings=settings, defaults=defaults, importer=principal.email)
    )
    project, counts, events = await backup.create_project(
        session, files, prepared, importer=principal.email, defaults=defaults
    )
    result = await _commit_import(session, project, counts)
    response.headers["Location"] = _project_location(project.id)
    response.headers["ETag"] = etag(project.version)
    for event in events:
        await publisher.publish(event)
    return result
