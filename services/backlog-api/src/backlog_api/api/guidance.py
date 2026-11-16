"""Project guidance: effective guidance (override ?? skill default), overrides, compare with default, export/import.

Reading is allowed for every member; changing is owner-only. Overrides use optimistic concurrency per override: the
``ETag`` of an override is its ``version`` (``"0"`` while the skill default applies); ``PUT`` requires ``If-Match``
(``0`` to create the first override), ``DELETE`` accepts an optional ``If-Match``. Import replaces all overrides.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any, Literal, cast

from backlog_skills import ITEM_TYPES, DefaultGuidance, ItemType, SkillCatalog
from fastapi import APIRouter, Depends, Header, Path, Query, Request, Response
from pydantic import Field
from sqlalchemy.ext.asyncio import AsyncSession

from backlog_api import audit, events
from backlog_api.api.deps import MemberAccessDep, ProjectId
from backlog_api.api.schemas import ApiModel, ApiRequest
from backlog_api.auth.dependencies import PrincipalDep
from backlog_api.authz import ProjectAccess, require_owner
from backlog_api.concurrency import etag, parse_if_match, version_conflict
from backlog_api.db.models import (
    GUIDANCE_PRINCIPLES,
    GUIDANCE_TEMPLATE,
    GUIDANCE_TYPE_INSTRUCTIONS,
    Project,
    ProjectGuidance,
)
from backlog_api.db.session import SessionDep
from backlog_api.events import DomainEvent, EventPublisher, EventPublisherDep
from backlog_api.guidance import EffectiveGuidance as EffectiveGuidanceModel
from backlog_api.guidance import (
    GuidanceEntry,
    GuidanceKey,
    GuidanceKind,
    OverrideValue,
    SkillsDep,
    build_entry,
    content_issues,
    default_content,
    default_guidance,
    effective_guidance,
    load_overrides,
    reset_all,
    set_override,
    skill_name,
)
from backlog_api.problems import ProblemError, not_found, problem_responses
from backlog_api.settings import Settings

router = APIRouter(tags=["guidance"])

EXPORT_FORMAT = "backlog-guidance"
EXPORT_FORMAT_VERSION = 5
LEGACY_SPA_VERSION = 4
MAX_SKILL_VERSION_LENGTH = 64

TypedKind = Literal["type-instructions", "template"]
TypedKindPath = Annotated[TypedKind, Path(description="Guidance kind: type-instructions or template.")]
ItemTypePath = Annotated[ItemType, Path(description="Backlog item type.")]
IfMatch = Annotated[
    str | None,
    Header(alias="If-Match", description="Version (ETag) of the override this change is based on; 0 for the default."),
]


# --- schemas -------------------------------------------------------------------------------------------------------


class GuidanceEntryOut(ApiModel):
    kind: GuidanceKind
    item_type: ItemType | None = Field(description="Backlog item type; null for the agent principles.")
    content: str = Field(description="The effective text.")
    source: Literal["default", "project"] = Field(
        description="Whether the skill default or a project override applies."
    )
    default_skill: str = Field(description="Name of the skill that provides the default.")
    default_version: str = Field(description="Current version of that skill.")
    base_skill_version: str | None = Field(description="Skill version the override was edited from.")
    differs_from_default: bool = Field(description="The override's text differs from the current skill default.")
    outdated: bool = Field(description="The override is based on an older skill version than the current default.")
    version: int = Field(description="Override version, the ETag for writes; 0 while the default applies.")
    updated_by: str | None
    updated_at: datetime | None


class EffectiveGuidanceOut(ApiModel):
    principles: GuidanceEntryOut
    type_instructions: dict[str, GuidanceEntryOut] = Field(description="Keyed by item type.")
    templates: dict[str, GuidanceEntryOut] = Field(description="Keyed by item type.")
    document_format: str = Field(description="Read-only document format rules of the core skill.")
    skills: dict[str, str] = Field(description="Skill name to current version.")


class DefaultEntryOut(ApiModel):
    content: str
    skill: str
    version: str


class DefaultGuidanceOut(ApiModel):
    principles: DefaultEntryOut
    type_instructions: dict[str, DefaultEntryOut]
    templates: dict[str, DefaultEntryOut]
    document_format: str
    skills: dict[str, str]


class GuidanceWrite(ApiRequest):
    content: str = Field(max_length=200_000, description="The new text; templates must be placeholder-free Markdown.")
    base_skill_version: str | None = Field(
        default=None,
        max_length=MAX_SKILL_VERSION_LENGTH,
        description="Skill version this text was edited from; defaults to the existing base or the current version.",
    )


class ExportEntry(ApiModel):
    content: str
    base_skill_version: str | None = None


class ExportGuidance(ApiModel):
    principles: ExportEntry | None = None
    type_instructions: dict[str, ExportEntry] = Field(default_factory=dict)
    templates: dict[str, ExportEntry] = Field(default_factory=dict)


class ExportProject(ApiModel):
    id: str
    name: str


class GuidanceExport(ApiModel):
    format: Literal["backlog-guidance"] = EXPORT_FORMAT
    format_version: Literal[5] = EXPORT_FORMAT_VERSION
    exported_at: datetime
    project: ExportProject
    skills: dict[str, str] = Field(description="Skill name to its current version at export time.")
    guidance: ExportGuidance


# --- helpers -------------------------------------------------------------------------------------------------------


def _entry_out(entry: GuidanceEntry) -> GuidanceEntryOut:
    return GuidanceEntryOut(
        kind=entry.kind,
        item_type=entry.item_type,
        content=entry.content,
        source=entry.source,
        default_skill=entry.default_skill,
        default_version=entry.default_version,
        base_skill_version=entry.base_skill_version,
        differs_from_default=entry.differs_from_default,
        outdated=entry.outdated,
        version=entry.version,
        updated_by=entry.updated_by,
        updated_at=entry.updated_at,
    )


def _effective_out(effective: EffectiveGuidanceModel) -> EffectiveGuidanceOut:
    return EffectiveGuidanceOut(
        principles=_entry_out(effective.principles),
        type_instructions={t: _entry_out(e) for t, e in effective.type_instructions.items()},
        templates={t: _entry_out(e) for t, e in effective.templates.items()},
        document_format=effective.document_format,
        skills=effective.skills,
    )


def _invalid(issues: list[str]) -> ProblemError:
    return ProblemError(422, "invalid-guidance", title="Invalid guidance", detail=" ".join(issues), issues=issues)


def _settings(request: Request) -> Settings:
    return cast(Settings, request.app.state.settings)


SettingsDep = Annotated[Settings, Depends(_settings)]


def _entry_for(defaults: DefaultGuidance, key: GuidanceKey, row: ProjectGuidance | None) -> GuidanceEntry:
    return build_entry(defaults, key, row)


async def _write_one(
    key: GuidanceKey,
    body: GuidanceWrite,
    if_match: str | None,
    access: ProjectAccess,
    session: AsyncSession,
    publisher: EventPublisher,
    settings: Settings,
    skills: SkillCatalog,
    response: Response,
) -> GuidanceEntryOut:
    kind, item_type = key
    expected = parse_if_match(if_match)
    issues = content_issues(kind, body.content, settings.guidance_max_chars)
    if issues:
        raise _invalid(issues)
    defaults = default_guidance(skills)
    overrides = await load_overrides(session, access.project_id)
    existing = overrides.get(key)
    current = existing.version if existing else 0
    if expected != current:
        raise version_conflict(current)
    row = await set_override(
        session,
        access.project_id,
        key,
        OverrideValue(body.content, body.base_skill_version),
        actor=access.principal.email,
        current_skill_version=defaults.versions[skill_name(kind, item_type)],
        existing=existing,
    )
    audit.record(
        session,
        actor=access.principal.email,
        action=audit.GUIDANCE_UPDATED,
        project_id=access.project_id,
        details={"kind": kind, "itemType": item_type, "version": row.version},
    )
    await session.commit()
    await _publish(publisher, access, kind, item_type)
    entry = _entry_for(defaults, key, row)
    response.headers["ETag"] = etag(entry.version)
    return _entry_out(entry)


async def _delete_one(
    key: GuidanceKey,
    if_match: str | None,
    access: ProjectAccess,
    session: AsyncSession,
    publisher: EventPublisher,
    skills: SkillCatalog,
    response: Response,
) -> GuidanceEntryOut:
    kind, item_type = key
    existing = (await load_overrides(session, access.project_id)).get(key)
    if if_match is not None and parse_if_match(if_match) != (existing.version if existing else 0):
        raise version_conflict(existing.version if existing else 0)
    if existing is not None:
        await session.delete(existing)
        audit.record(
            session,
            actor=access.principal.email,
            action=audit.GUIDANCE_RESET,
            project_id=access.project_id,
            details={"kind": kind, "itemType": item_type},
        )
        await session.commit()
        await _publish(publisher, access, kind, item_type)
    response.headers["ETag"] = etag(0)
    return _entry_out(_entry_for(default_guidance(skills), key, None))


async def _publish(publisher: EventPublisher, access: ProjectAccess, kind: str, item_type: str | None) -> None:
    await publisher.publish(
        DomainEvent(
            events.GUIDANCE_UPDATED,
            access.project_id,
            access.principal.email,
            {"kind": kind, "itemType": item_type},
        )
    )


# --- read ----------------------------------------------------------------------------------------------------------


@router.get(
    "/projects/{project_id}/guidance",
    summary="Effective guidance of a project (members)",
    responses=problem_responses(401, 403, 404),
)
async def get_guidance(access: MemberAccessDep, session: SessionDep, skills: SkillsDep) -> EffectiveGuidanceOut:
    return _effective_out(await effective_guidance(session, access.project_id, skills))


@router.get(
    "/projects/{project_id}/guidance/defaults",
    summary="Skill defaults to compare an override with (members)",
    responses=problem_responses(401, 403, 404),
)
async def get_guidance_defaults(access: MemberAccessDep, skills: SkillsDep) -> DefaultGuidanceOut:
    defaults = default_guidance(skills)

    def entry(kind: GuidanceKind, item_type: ItemType | None) -> DefaultEntryOut:
        name = skill_name(kind, item_type)
        return DefaultEntryOut(
            content=default_content(defaults, kind, item_type), skill=name, version=defaults.versions[name]
        )

    return DefaultGuidanceOut(
        principles=entry(GUIDANCE_PRINCIPLES, None),
        type_instructions={t: entry(GUIDANCE_TYPE_INSTRUCTIONS, t) for t in ITEM_TYPES},
        templates={t: entry(GUIDANCE_TEMPLATE, t) for t in ITEM_TYPES},
        document_format=defaults.document_format,
        skills=dict(defaults.versions),
    )


# --- write ---------------------------------------------------------------------------------------------------------


@router.put(
    "/projects/{project_id}/guidance/principles",
    summary="Override the agent principles (owners)",
    responses=problem_responses(401, 403, 404, 409, 422, 428),
)
async def put_principles(
    project_id: ProjectId,
    body: GuidanceWrite,
    principal: PrincipalDep,
    session: SessionDep,
    publisher: EventPublisherDep,
    settings: SettingsDep,
    skills: SkillsDep,
    response: Response,
    if_match: IfMatch = None,
) -> GuidanceEntryOut:
    access = await require_owner(session, project_id, principal, lock=True)
    key: GuidanceKey = (GUIDANCE_PRINCIPLES, None)
    return await _write_one(key, body, if_match, access, session, publisher, settings, skills, response)


@router.put(
    "/projects/{project_id}/guidance/{kind}/{item_type}",
    summary="Override type instructions or a template (owners)",
    responses=problem_responses(401, 403, 404, 409, 422, 428),
)
async def put_type_guidance(
    project_id: ProjectId,
    kind: TypedKindPath,
    item_type: ItemTypePath,
    body: GuidanceWrite,
    principal: PrincipalDep,
    session: SessionDep,
    publisher: EventPublisherDep,
    settings: SettingsDep,
    skills: SkillsDep,
    response: Response,
    if_match: IfMatch = None,
) -> GuidanceEntryOut:
    access = await require_owner(session, project_id, principal, lock=True)
    key: GuidanceKey = (kind, item_type)
    return await _write_one(key, body, if_match, access, session, publisher, settings, skills, response)


@router.delete(
    "/projects/{project_id}/guidance/principles",
    summary="Restore the default agent principles (owners)",
    responses=problem_responses(401, 403, 404, 409, 428),
)
async def delete_principles(
    project_id: ProjectId,
    principal: PrincipalDep,
    session: SessionDep,
    publisher: EventPublisherDep,
    skills: SkillsDep,
    response: Response,
    if_match: IfMatch = None,
) -> GuidanceEntryOut:
    access = await require_owner(session, project_id, principal, lock=True)
    return await _delete_one((GUIDANCE_PRINCIPLES, None), if_match, access, session, publisher, skills, response)


@router.delete(
    "/projects/{project_id}/guidance/{kind}/{item_type}",
    summary="Restore the default type instructions or template (owners)",
    responses=problem_responses(401, 403, 404, 409),
)
async def delete_type_guidance(
    project_id: ProjectId,
    kind: TypedKindPath,
    item_type: ItemTypePath,
    principal: PrincipalDep,
    session: SessionDep,
    publisher: EventPublisherDep,
    skills: SkillsDep,
    response: Response,
    if_match: IfMatch = None,
) -> GuidanceEntryOut:
    access = await require_owner(session, project_id, principal, lock=True)
    return await _delete_one((kind, item_type), if_match, access, session, publisher, skills, response)


# --- export / import -----------------------------------------------------------------------------------------------


@router.get(
    "/projects/{project_id}/guidance/export",
    summary="Export the project's guidance as format v5 (members)",
    description=(
        "Contains only the project's overrides with their base skill versions. With `includeDefaults=true` the "
        "effective text of every entry is included (defaults carry the current skill version)."
    ),
    responses=problem_responses(401, 403, 404),
)
async def export_guidance(
    access: MemberAccessDep,
    session: SessionDep,
    skills: SkillsDep,
    include_defaults: Annotated[bool, Query(alias="includeDefaults")] = False,
) -> GuidanceExport:
    effective = await effective_guidance(session, access.project_id, skills)
    project = await session.get(Project, access.project_id)
    if project is None:
        raise not_found()

    def pick(entry: GuidanceEntry) -> ExportEntry | None:
        if entry.source == "default" and not include_defaults:
            return None
        return ExportEntry(content=entry.content, base_skill_version=entry.base_skill_version or entry.default_version)

    def pick_all(entries: dict[ItemType, GuidanceEntry]) -> dict[str, ExportEntry]:
        picked = {t: pick(e) for t, e in entries.items()}
        return {t: e for t, e in picked.items() if e is not None}

    return GuidanceExport(
        exported_at=datetime.now(UTC),
        project=ExportProject(id=str(project.id), name=project.name),
        skills=effective.skills,
        guidance=ExportGuidance(
            principles=pick(effective.principles),
            type_instructions=pick_all(effective.type_instructions),
            templates=pick_all(effective.templates),
        ),
    )


def _parse_import(
    document: dict[str, Any], defaults: DefaultGuidance, max_chars: int
) -> dict[GuidanceKey, OverrideValue]:
    """Validate an import document (v5, or a v4 SPA export) into overrides; raises 422 listing every problem."""
    issues: list[str] = []
    values: dict[GuidanceKey, OverrideValue] = {}
    version = document.get("formatVersion", document.get("version"))
    if version == LEGACY_SPA_VERSION and "settings" in document:
        raw = _legacy_to_v5(document["settings"], issues)
    elif document.get("format") == EXPORT_FORMAT and version == EXPORT_FORMAT_VERSION:
        raw = document.get("guidance")
        if not isinstance(raw, dict):
            raise _invalid(["'guidance' must be an object."])
        raw = cast(dict[str, Any], raw)
    else:
        raise ProblemError(
            422,
            "unsupported-format",
            title="Unsupported guidance format",
            detail=(
                f"Expected format '{EXPORT_FORMAT}' version {EXPORT_FORMAT_VERSION} "
                f"(or a version {LEGACY_SPA_VERSION} configuration export of the single-user app); "
                f"got version {version!r}."
            ),
        )
    unknown = sorted(set(raw) - {"principles", "typeInstructions", "templates"})
    if unknown:
        issues.append(f"Unknown guidance field(s): {', '.join(unknown)}.")

    def add(key: GuidanceKey, entry: object, label: str) -> None:
        if entry is None:
            return
        if not isinstance(entry, dict) or not isinstance(cast(dict[str, Any], entry).get("content"), str):
            issues.append(f"{label}: expected an object with a 'content' string.")
            return
        data = cast(dict[str, Any], entry)
        base = data.get("baseSkillVersion")
        if base is not None and (not isinstance(base, str) or len(base) > MAX_SKILL_VERSION_LENGTH):
            issues.append(f"{label}: 'baseSkillVersion' must be a short string.")
            return
        problems = content_issues(key[0], data["content"], max_chars)
        if problems:
            issues.extend(f"{label}: {problem}" for problem in problems)
            return
        values[key] = OverrideValue(data["content"], base)

    add((GUIDANCE_PRINCIPLES, None), raw.get("principles"), "principles")
    sections: tuple[tuple[str, GuidanceKind], ...] = (
        ("typeInstructions", GUIDANCE_TYPE_INSTRUCTIONS),
        ("templates", GUIDANCE_TEMPLATE),
    )
    for field, kind in sections:
        section = raw.get(field, {})
        if section is None:
            continue
        if not isinstance(section, dict):
            issues.append(f"'{field}' must be an object keyed by item type.")
            continue
        for item_type, entry in cast(dict[str, Any], section).items():
            if item_type not in ITEM_TYPES:
                issues.append(f"{field}: unknown item type '{item_type}'.")
                continue
            add((kind, cast(ItemType, item_type)), entry, f"{field}.{item_type}")
    if issues:
        raise _invalid(issues)
    return values


def _legacy_to_v5(settings: object, issues: list[str]) -> dict[str, Any]:
    """Map the single-user app's v4 settings export (plain strings) to the v5 guidance shape."""
    if not isinstance(settings, dict):
        issues.append("'settings' must be an object.")
        return {}
    data = cast(dict[str, Any], settings)

    def wrap(value: object) -> dict[str, Any] | None:
        return {"content": value} if isinstance(value, str) and value.strip() else None

    def wrap_map(value: object) -> dict[str, Any]:
        if not isinstance(value, dict):
            return {}
        mapped = {k: wrap(v) for k, v in cast(dict[str, Any], value).items()}
        return {k: v for k, v in mapped.items() if v is not None}

    return {
        "principles": wrap(data.get("principles")),
        "typeInstructions": wrap_map(data.get("typeInstructions")),
        "templates": wrap_map(data.get("templates")),
    }


@router.post(
    "/projects/{project_id}/guidance/import",
    summary="Replace the project's guidance overrides from an export (owners)",
    description=(
        "Accepts format `backlog-guidance` version 5, or a version 4 configuration export of the single-user app "
        "(principles, type instructions and templates; the free-text `instructions` field is ignored). Everything is "
        "validated first; all overrides are then replaced in one transaction. Entries identical to the current skill "
        "default are not stored, and entries missing from the document fall back to the default."
    ),
    responses=problem_responses(401, 403, 404, 413, 422),
)
async def import_guidance(
    project_id: ProjectId,
    body: dict[str, Any],
    principal: PrincipalDep,
    session: SessionDep,
    publisher: EventPublisherDep,
    settings: SettingsDep,
    skills: SkillsDep,
) -> EffectiveGuidanceOut:
    access = await require_owner(session, project_id, principal, lock=True)
    defaults = default_guidance(skills)
    values = _parse_import(body, defaults, settings.guidance_max_chars)
    await reset_all(session, project_id)
    session.expire_all()
    stored = 0
    for key, value in values.items():
        kind, item_type = key
        if value.content.strip() == default_content(defaults, kind, item_type).strip():
            continue
        await set_override(
            session,
            project_id,
            key,
            value,
            actor=principal.email,
            current_skill_version=defaults.versions[skill_name(kind, item_type)],
            existing=None,
        )
        stored += 1
    audit.record(
        session,
        actor=principal.email,
        action=audit.GUIDANCE_IMPORTED,
        project_id=project_id,
        details={"overrides": stored},
    )
    await session.commit()
    await publisher.publish(
        DomainEvent(events.GUIDANCE_UPDATED, project_id, access.principal.email, {"kind": "all", "itemType": None})
    )
    return _effective_out(await effective_guidance(session, project_id, skills))
