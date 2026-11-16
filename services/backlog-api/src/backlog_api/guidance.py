"""Project guidance: skill defaults (``libs/py-skills``) overlaid with per-project overrides.

*Effective guidance* = ``project override ?? skill default`` for the agent principles, the instructions of each item
type and the template of each item type. Overrides live in ``project_guidance`` (one row per kind and item type); a
missing row means the default applies. The skill catalog is loaded once at startup into ``app.state.skills``
(:data:`SkillsDep`); every function takes an optional ``skills`` catalog and falls back to a process-wide catalog loaded
from ``BACKLOG_SKILLS_DIR`` (or the repository's ``skills/``).

Public service API (used by the REST routes, ``api-items`` and the MCP ``get_project_guidance`` tool):

* :func:`effective_guidance` — all effective guidance of a project with default/override metadata.
* :func:`effective_template` — the effective template of one item type, to create items from.
* :func:`default_guidance` — the skill defaults with their versions.

Concurrency: each override row has an integer ``version`` (ETag); a default (no row) has version ``0``. Writers hold the
project row lock (``require_owner(..., lock=True)``), so ``If-Match: 0`` safely means "create the override".
"""

from __future__ import annotations

import functools
import re
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Literal, cast

from backlog_skills import (
    CORE_SKILL,
    ITEM_TYPES,
    DefaultGuidance,
    ItemType,
    SkillCatalog,
    load_skills,
    type_skill_name,
    validate_template,
)
from fastapi import Depends, Request
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backlog_api.db.models import (
    GUIDANCE_PRINCIPLES,
    GUIDANCE_TEMPLATE,
    GUIDANCE_TYPE_INSTRUCTIONS,
    ProjectGuidance,
)

GuidanceKind = Literal["principles", "type-instructions", "template"]
GuidanceSource = Literal["default", "project"]
GuidanceKey = tuple[GuidanceKind, ItemType | None]

ALL_KEYS: tuple[GuidanceKey, ...] = (
    (GUIDANCE_PRINCIPLES, None),
    *((GUIDANCE_TYPE_INSTRUCTIONS, t) for t in ITEM_TYPES),
    *((GUIDANCE_TEMPLATE, t) for t in ITEM_TYPES),
)  # pyright: ignore[reportAssignmentType]

_VERSION_PREFIX = re.compile(r"^(\d+)\.(\d+)\.(\d+)")


@functools.cache
def _fallback_catalog() -> SkillCatalog:
    return load_skills()


def get_skills(request: Request) -> SkillCatalog:
    catalog: SkillCatalog | None = getattr(request.app.state, "skills", None)
    if catalog is None:
        raise RuntimeError("The skill catalog is not initialised.")
    return catalog


SkillsDep = Annotated[SkillCatalog, Depends(get_skills)]


@dataclass(frozen=True, slots=True)
class GuidanceEntry:
    """One guidance text for a project: the effective ``content`` plus where it comes from."""

    kind: GuidanceKind
    item_type: ItemType | None
    content: str
    source: GuidanceSource
    default_skill: str
    default_version: str
    """Current version of the skill that provides the default."""
    base_skill_version: str | None
    """Skill version the override was edited from (``None`` for defaults)."""
    differs_from_default: bool
    outdated: bool
    """The override is based on an older skill version than the current default."""
    version: int
    """Override row version (ETag); ``0`` while the default applies."""
    updated_by: str | None
    updated_at: datetime | None


@dataclass(frozen=True, slots=True)
class EffectiveGuidance:
    principles: GuidanceEntry
    type_instructions: dict[ItemType, GuidanceEntry]
    templates: dict[ItemType, GuidanceEntry]
    document_format: str
    """Read-only section-update rules from the core skill (not overridable)."""
    skills: dict[str, str]
    """Skill name → current version."""

    def entries(self) -> list[GuidanceEntry]:
        return [self.principles, *self.type_instructions.values(), *self.templates.values()]


def skill_name(kind: GuidanceKind, item_type: ItemType | None) -> str:
    return CORE_SKILL if kind == GUIDANCE_PRINCIPLES or item_type is None else type_skill_name(item_type)


def default_guidance(skills: SkillCatalog | None = None) -> DefaultGuidance:
    return (skills or _fallback_catalog()).default_guidance()


def default_content(defaults: DefaultGuidance, kind: GuidanceKind, item_type: ItemType | None) -> str:
    if kind == GUIDANCE_PRINCIPLES or item_type is None:
        return defaults.principles
    if kind == GUIDANCE_TYPE_INSTRUCTIONS:
        return defaults.type_instructions[item_type]
    return defaults.templates[item_type]


def is_outdated(base_version: str | None, current_version: str) -> bool:
    """``True`` when ``base_version`` is older than ``current_version`` (unparsable versions: any difference)."""
    if base_version is None or base_version == current_version:
        return False
    base, current = _VERSION_PREFIX.match(base_version), _VERSION_PREFIX.match(current_version)
    if base is None or current is None:
        return True
    return tuple(map(int, base.groups())) < tuple(map(int, current.groups()))


def _row_key(row: ProjectGuidance) -> GuidanceKey:
    return cast(GuidanceKind, row.kind), (cast(ItemType, row.item_type) if row.item_type else None)


def build_entry(defaults: DefaultGuidance, key: GuidanceKey, row: ProjectGuidance | None) -> GuidanceEntry:
    kind, item_type = key
    name = skill_name(kind, item_type)
    default_text = default_content(defaults, kind, item_type)
    current = defaults.versions[name]
    if row is None:
        return GuidanceEntry(kind, item_type, default_text, "default", name, current, None, False, False, 0, None, None)
    return GuidanceEntry(
        kind,
        item_type,
        row.content,
        "project",
        name,
        current,
        row.base_skill_version,
        row.content.strip() != default_text.strip(),
        is_outdated(row.base_skill_version, current),
        row.version,
        row.updated_by,
        row.updated_at,
    )


async def load_overrides(session: AsyncSession, project_id: uuid.UUID) -> dict[GuidanceKey, ProjectGuidance]:
    rows = (await session.scalars(select(ProjectGuidance).where(ProjectGuidance.project_id == project_id))).all()
    return {_row_key(row): row for row in rows}


def build_effective(defaults: DefaultGuidance, overrides: Mapping[GuidanceKey, ProjectGuidance]) -> EffectiveGuidance:
    def entry(key: GuidanceKey) -> GuidanceEntry:
        return build_entry(defaults, key, overrides.get(key))

    return EffectiveGuidance(
        principles=entry((GUIDANCE_PRINCIPLES, None)),
        type_instructions={t: entry((GUIDANCE_TYPE_INSTRUCTIONS, t)) for t in ITEM_TYPES},
        templates={t: entry((GUIDANCE_TEMPLATE, t)) for t in ITEM_TYPES},
        document_format=defaults.document_format,
        skills=dict(defaults.versions),
    )


async def effective_guidance(
    session: AsyncSession, project_id: uuid.UUID, skills: SkillCatalog | None = None
) -> EffectiveGuidance:
    """The project's effective guidance (``override ?? default``) for principles and every item type.

    Authorization is the caller's job (members may read). ``skills`` is ``app.state.skills``.
    """
    return build_effective(default_guidance(skills), await load_overrides(session, project_id))


async def effective_template(
    session: AsyncSession, project_id: uuid.UUID, item_type: ItemType, skills: SkillCatalog | None = None
) -> str:
    """The Markdown template new items of ``item_type`` are created from: the project override or the skill default."""
    content = await session.scalar(
        select(ProjectGuidance.content).where(
            ProjectGuidance.project_id == project_id,
            ProjectGuidance.kind == GUIDANCE_TEMPLATE,
            ProjectGuidance.item_type == item_type,
        )
    )
    if content is not None:
        return content
    return (skills or _fallback_catalog()).template(item_type)


def content_issues(kind: GuidanceKind, content: str, max_chars: int) -> list[str]:
    """Validation errors for override text: non-empty, bounded, and placeholder-free for templates."""
    text = content.strip()
    if not text:
        return ["Content must not be empty."]
    if len(text) > max_chars:
        return [f"Content is {len(text)} characters; the maximum is {max_chars}."]
    return validate_template(text) if kind == GUIDANCE_TEMPLATE else []


@dataclass(frozen=True, slots=True)
class OverrideValue:
    content: str
    base_skill_version: str | None = None


async def set_override(
    session: AsyncSession,
    project_id: uuid.UUID,
    key: GuidanceKey,
    value: OverrideValue,
    *,
    actor: str,
    current_skill_version: str,
    existing: ProjectGuidance | None,
) -> ProjectGuidance:
    """Create or update an override (caller holds the project lock). Unchanged content is a no-op.

    A missing ``base_skill_version`` keeps the existing base version, or is the current skill version for new overrides.
    """
    kind, item_type = key
    content = value.content.strip()
    base = value.base_skill_version or (existing.base_skill_version if existing else None) or current_skill_version
    if existing is None:
        row = ProjectGuidance(
            project_id=project_id,
            kind=kind,
            item_type=item_type or "",
            content=content,
            base_skill_version=base,
            version=1,
            updated_by=actor,
        )
        session.add(row)
        await session.flush()
        await session.refresh(row)
        return row
    if existing.content == content and existing.base_skill_version == base:
        return existing
    existing.content = content
    existing.base_skill_version = base
    existing.version += 1
    existing.updated_by = actor
    existing.updated_at = func.now()
    await session.flush()
    await session.refresh(existing)
    return existing


async def reset_all(session: AsyncSession, project_id: uuid.UUID) -> None:
    await session.execute(delete(ProjectGuidance).where(ProjectGuidance.project_id == project_id))
