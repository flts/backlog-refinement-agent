"""Project backup (format v2): export a project and import a backup as a *new* project.

The document is self-contained JSON: project name, guidance overrides (the structures of the guidance export v5),
items with their revisions, relationships and sources with their original files (base64). Refs are opaque,
export-local ids (the original UUIDs as strings); import assigns new ids. Members, threads, the audit log and the
derived search data (chunks, embeddings) are not part of a backup; indexing rebuilds the latter after an import.

Export builds the document chunk by chunk (never more than one batch of rows in memory besides the output, which is
capped by ``backup_max_bytes``). Import validates the *whole* document first (:func:`prepare_backup`, pure and run in
a worker thread) and only then writes everything in the caller's single transaction (:func:`create_project`).

The single-user SPA's version 1 export (``backlog-refinement-project``) is accepted too and mapped to v2 by
:func:`convert_v1` (see its docstring for the mapping and what is dropped).
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Literal, cast
from urllib.parse import urlsplit

from backlog_skills import DefaultGuidance, ItemType
from pydantic import Field, StringConstraints, ValidationError
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backlog_api import audit, events
from backlog_api import sources as sources_module
from backlog_api.api.guidance import ExportEntry, ExportGuidance, parse_guidance_import
from backlog_api.api.schemas import ApiModel, ApiRequest
from backlog_api.db.models import (
    GUIDANCE_PRINCIPLES,
    GUIDANCE_TEMPLATE,
    GUIDANCE_TYPE_INSTRUCTIONS,
    ROLE_OWNER,
    Item,
    ItemRevision,
    Project,
    ProjectMember,
    Relationship,
    Source,
    SourceFile,
)
from backlog_api.document import document_hash
from backlog_api.events import DomainEvent
from backlog_api.files import FileStore
from backlog_api.guidance import (
    GuidanceKey,
    OverrideValue,
    default_content,
    load_overrides,
    set_override,
    skill_name,
)
from backlog_api.indexing import enqueue_item_indexing
from backlog_api.item_rules import can_be_child, creates_parent_cycle, is_same_relationship
from backlog_api.items_schemas import (
    ItemDocument,
    ItemStatusName,
    ItemTitle,
    ItemTypeName,
    QualityAssessment,
    RelationshipTypeName,
    RevisionOrigin,
)
from backlog_api.problems import ProblemError
from backlog_api.settings import Settings

BACKUP_FORMAT = "backlog-project-backup"
BACKUP_FORMAT_VERSION = 2
LEGACY_FORMAT = "backlog-refinement-project"
LEGACY_VERSION = 1

AUDIT_PROJECT_EXPORTED = "project.exported"
AUDIT_PROJECT_IMPORTED = "project.imported"

MAX_PROJECT_NAME_LENGTH = 200
IMPORT_SUFFIX = " (imported)"
MAX_REF_LENGTH = 200
MAX_ISSUES = 50
EXPORT_BATCH = 50

SourceKind = Literal["file", "url", "text"]
SourceMode = Literal["pinned", "searchable", "excluded"]

# --- document models -----------------------------------------------------------------------------------------------

Ref = Annotated[str, StringConstraints(min_length=1, max_length=MAX_REF_LENGTH)]
SourceName = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=sources_module.MAX_SOURCE_NAME_LENGTH)
]
ProjectName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_PROJECT_NAME_LENGTH)]
Actor = Annotated[str, StringConstraints(min_length=1, max_length=320)]


class BackupProject(ApiRequest):
    name: ProjectName = Field(description="Project name.")


class BackupRevision(ApiRequest):
    version: int = Field(ge=1, description="The item version this snapshot was taken at.")
    title: ItemTitle
    document: ItemDocument
    origin: RevisionOrigin
    label: str | None = Field(default=None, max_length=200)
    actor: Actor
    run_id: str | None = Field(default=None, max_length=200)
    created_at: datetime


class BackupItem(ApiRequest):
    ref: Ref
    type: ItemTypeName
    title: ItemTitle
    document: ItemDocument
    status: ItemStatusName
    version: int | None = Field(
        default=None, ge=1, description="Item version; defaults to the newest revision version (or 1)."
    )
    quality: dict[str, Any] | None = Field(default=None, description="Quality assessment (see the items API).")
    quality_assessed_at: datetime | None = None
    quality_document_hash: str | None = Field(default=None, max_length=64)
    created_at: datetime
    updated_at: datetime
    revisions: list[BackupRevision] = Field(default_factory=list)


class BackupRelationship(ApiRequest):
    source_ref: Ref
    target_ref: Ref
    type: RelationshipTypeName


class BackupFile(ApiRequest):
    media_type: str = Field(min_length=1, max_length=255)
    size: int = Field(ge=0, description="Size of the decoded file in bytes.")
    sha256: str = Field(pattern=r"^[0-9A-Fa-f]{64}$", description="SHA-256 (hex) of the decoded file.")
    content_base64: str


class BackupSource(ApiRequest):
    ref: Ref
    name: SourceName
    kind: SourceKind
    mode: SourceMode
    url: str | None = Field(default=None, max_length=2048)
    text: str
    char_count: int = Field(ge=0)
    page_count: int | None = Field(default=None, ge=1)
    media_type: str | None = Field(default=None, max_length=255)
    file: BackupFile | None = Field(default=None, description="The original file (file sources only).")


class BackupDocument(ApiRequest):
    format: Literal["backlog-project-backup"] = BACKUP_FORMAT
    format_version: Literal[2] = BACKUP_FORMAT_VERSION
    exported_at: datetime
    exported_by: str | None = Field(default=None, description="Email of the owner who exported the project.")
    project: BackupProject
    guidance: ExportGuidance = Field(default_factory=ExportGuidance)
    items: list[BackupItem] = Field(default_factory=list)
    relationships: list[BackupRelationship] = Field(default_factory=list)
    sources: list[BackupSource] = Field(default_factory=list)


# --- errors --------------------------------------------------------------------------------------------------------


def too_large(limit: int) -> ProblemError:
    return ProblemError(
        413,
        "backup-too-large",
        detail=f"The project backup would exceed the limit of {limit} bytes.",
        limit=limit,
    )


def invalid_backup(issues: list[str]) -> ProblemError:
    shown = issues[:MAX_ISSUES]
    more = f" (and {len(issues) - len(shown)} more)" if len(issues) > len(shown) else ""
    return ProblemError(
        422,
        "invalid-backup",
        title="Invalid project backup",
        detail=f"The backup has {len(issues)} problem(s). First: {issues[0]}{more}",
        issues=shown,
    )


def _unsupported(version: object, format_: object) -> ProblemError:
    return ProblemError(
        422,
        "unsupported-format",
        title="Unsupported backup format",
        detail=(
            f"Expected format '{BACKUP_FORMAT}' version {BACKUP_FORMAT_VERSION} (or a version {LEGACY_VERSION} "
            f"'{LEGACY_FORMAT}' export of the single-user app); got format {format_!r} version {version!r}."
        ),
    )


# --- export --------------------------------------------------------------------------------------------------------


class _Sink:
    """Collects the output and aborts as soon as it exceeds the limit."""

    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.size = 0
        self.chunks: list[bytes] = []

    def add(self, data: str) -> None:
        encoded = data.encode()
        self.size += len(encoded)
        if self.size > self.limit:
            raise too_large(self.limit)
        self.chunks.append(encoded)


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _dump(model: ApiModel) -> str:
    return model.model_dump_json(by_alias=True, exclude_none=True)


async def estimate_size(session: AsyncSession, project_id: uuid.UUID) -> int:
    """Cheap lower bound of the export size, to refuse hopeless exports before reading any content."""
    items = await session.scalar(
        select(func.coalesce(func.sum(func.octet_length(Item.document) + func.octet_length(Item.title)), 0)).where(
            Item.project_id == project_id
        )
    )
    revisions = await session.scalar(
        select(func.coalesce(func.sum(func.octet_length(ItemRevision.document)), 0))
        .join(Item, Item.id == ItemRevision.item_id)
        .where(Item.project_id == project_id)
    )
    texts = await session.scalar(
        select(func.coalesce(func.sum(func.octet_length(Source.text)), 0)).where(Source.project_id == project_id)
    )
    files = await session.scalar(
        select(func.coalesce(func.sum(SourceFile.size), 0))
        .join(Source, Source.id == SourceFile.source_id)
        .where(Source.project_id == project_id)
    )
    return int(items or 0) + int(revisions or 0) + int(texts or 0) + int(files or 0) * 4 // 3


async def export_project(
    session: AsyncSession, files: FileStore, project: Project, *, exported_by: str, limit: int
) -> list[bytes]:
    """The backup document as UTF-8 chunks. Raises 413 ``backup-too-large`` once the output exceeds ``limit``.

    Reads in batches and expunges them again; the caller must not have pending (unflushed) objects in the session.
    """
    project_id = project.id
    if await estimate_size(session, project_id) > limit:
        raise too_large(limit)
    sink = _Sink(limit)
    overrides = await load_overrides(session, project_id)
    guidance = ExportGuidance()
    for (kind, item_type), row in overrides.items():
        entry = ExportEntry(content=row.content, base_skill_version=row.base_skill_version)
        if kind == GUIDANCE_PRINCIPLES:
            guidance.principles = entry
        elif kind == GUIDANCE_TYPE_INSTRUCTIONS and item_type is not None:
            guidance.type_instructions[item_type] = entry
        elif kind == GUIDANCE_TEMPLATE and item_type is not None:
            guidance.templates[item_type] = entry
    head = {
        "format": BACKUP_FORMAT,
        "formatVersion": BACKUP_FORMAT_VERSION,
        "exportedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "exportedBy": exported_by,
        "project": {"name": project.name},
        "guidance": json.loads(_dump(guidance)),
    }
    sink.add(_json(head)[:-1])

    sink.add(',"items":[')
    item_ids = list(
        (
            await session.scalars(
                select(Item.id).where(Item.project_id == project_id).order_by(Item.created_at, Item.id)
            )
        ).all()
    )
    session.expunge_all()
    first = True
    for start in range(0, len(item_ids), EXPORT_BATCH):
        batch = item_ids[start : start + EXPORT_BATCH]
        rows = {item.id: item for item in (await session.scalars(select(Item).where(Item.id.in_(batch)))).all()}
        revisions: dict[uuid.UUID, list[ItemRevision]] = {}
        for revision in (
            await session.scalars(
                select(ItemRevision).where(ItemRevision.item_id.in_(batch)).order_by(ItemRevision.version)
            )
        ).all():
            revisions.setdefault(revision.item_id, []).append(revision)
        for item_id in batch:
            item = rows[item_id]
            sink.add(("" if first else ",") + _dump(_item_model(item, revisions.get(item_id, []))))
            first = False
        session.expunge_all()
    sink.add('],"relationships":[')
    relationships = (
        await session.scalars(
            select(Relationship)
            .where(Relationship.project_id == project_id)
            .order_by(Relationship.type, Relationship.source_id, Relationship.target_id)
        )
    ).all()
    exported = {str(item_id) for item_id in item_ids}
    sink.add(
        ",".join(
            _dump(BackupRelationship(source_ref=str(r.source_id), target_ref=str(r.target_id), type=cast(Any, r.type)))
            for r in relationships
            if str(r.source_id) in exported and str(r.target_id) in exported
        )
    )
    session.expunge_all()
    sink.add('],"sources":[')
    source_ids = list(
        (
            await session.scalars(
                select(Source.id).where(Source.project_id == project_id).order_by(Source.created_at, Source.id)
            )
        ).all()
    )
    first = True
    for source_id in source_ids:
        source = await session.scalar(select(Source).where(Source.id == source_id))
        if source is None:  # pragma: no cover - snapshot isolation keeps rows visible
            continue
        stored = await files.get(source_id) if source.kind == "file" else None
        sink.add(("" if first else ",") + _dump(_source_model(source, stored)))
        first = False
        session.expunge_all()
    sink.add("]}")
    return sink.chunks


def _item_model(item: Item, revisions: list[ItemRevision]) -> BackupItem:
    return BackupItem(
        ref=str(item.id),
        type=cast(Any, item.type),
        title=item.title,
        document=item.document,
        status=cast(Any, item.status),
        version=item.version,
        quality=item.quality,
        quality_assessed_at=item.quality_assessed_at,
        quality_document_hash=item.quality_document_hash,
        created_at=item.created_at,
        updated_at=item.updated_at,
        revisions=[
            BackupRevision(
                version=r.version,
                title=r.title,
                document=r.document,
                origin=cast(Any, r.origin),
                label=r.label,
                actor=r.actor,
                run_id=r.run_id,
                created_at=r.created_at,
            )
            for r in revisions
        ],
    )


def _source_model(source: Source, stored: Any) -> BackupSource:
    file = None
    if stored is not None:
        file = BackupFile(
            media_type=stored.media_type,
            size=stored.size,
            sha256=stored.sha256,
            content_base64=base64.b64encode(stored.content).decode("ascii"),
        )
    return BackupSource(
        ref=str(source.id),
        name=source.name,
        kind=cast(Any, source.kind),
        mode=cast(Any, source.mode),
        url=source.url,
        text=source.text,
        char_count=source.char_count,
        page_count=source.page_count,
        media_type=source.media_type,
        file=file,
    )


# --- import: validation --------------------------------------------------------------------------------------------


@dataclass(slots=True)
class PreparedRevision:
    version: int
    title: str
    document: str
    origin: str
    label: str | None
    actor: str
    run_id: str | None
    created_at: datetime


@dataclass(slots=True)
class PreparedItem:
    id: uuid.UUID
    type: str
    title: str
    document: str
    status: str
    version: int
    quality: dict[str, Any] | None
    quality_assessed_at: datetime | None
    quality_document_hash: str | None
    created_at: datetime
    updated_at: datetime
    revisions: list[PreparedRevision]


@dataclass(slots=True)
class PreparedSource:
    id: uuid.UUID
    name: str
    kind: str
    mode: str
    url: str | None
    text: str
    page_count: int | None
    media_type: str | None
    file: tuple[bytes, str] | None


@dataclass(slots=True)
class PreparedBackup:
    name: str
    overrides: dict[GuidanceKey, OverrideValue]
    items: list[PreparedItem]
    relationships: list[tuple[uuid.UUID, uuid.UUID, str]]
    sources: list[PreparedSource]


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def _loc(location: tuple[int | str, ...]) -> str:
    return ".".join(str(part) for part in location) or "document"


def convert_v1(data: Mapping[str, Any], actor: str, issues: list[str]) -> dict[str, Any]:
    """Map the single-user SPA's version 1 export (``backlog-refinement-project``) to the v2 shape.

    * items: ``description`` becomes ``document``; v1 ``revisions`` (oldest first, each the state *before* a change)
      become revisions ``1..n`` with origin ``manual`` and ``actor`` = the importer, followed by a revision ``n + 1``
      holding the current state; the item version is ``n + 1``. A v1 quality assessment is kept but, since v1 did not
      record which document it assessed, it is imported as stale (no document hash) so it gets re-assessed.
    * sources: ``selected`` becomes mode ``searchable`` (``excluded`` when not selected); file sources keep their
      original bytes (``sha256`` is computed here) and ``text`` is taken as is.
    * relationships map ``sourceId``/``targetId`` to refs; ``sessions`` (conversations) are dropped, as are all
      v1 ids of the project itself.
    """

    def listing(key: str) -> list[Any]:
        value = data.get(key)
        if not isinstance(value, list):
            issues.append(f"'{key}' must be an array.")
            return []
        return cast(list[Any], value)

    def mapping(value: object) -> Mapping[str, Any]:
        return cast(Mapping[str, Any], value) if isinstance(value, dict) else {}

    project = mapping(data.get("project"))
    items: list[dict[str, Any]] = []
    for index, raw in enumerate(listing("items")):
        item = mapping(raw)
        revisions: list[dict[str, Any]] = []
        old = item.get("revisions")
        old = cast(list[Any], old) if isinstance(old, list) else []
        for number, raw_revision in enumerate(old, start=1):
            revision = mapping(raw_revision)
            revisions.append(
                {
                    "version": number,
                    "title": revision.get("title"),
                    "document": revision.get("description"),
                    "origin": "manual",
                    "actor": actor,
                    "createdAt": revision.get("savedAt"),
                }
            )
        revisions.append(
            {
                "version": len(old) + 1,
                "title": item.get("title"),
                "document": item.get("description", ""),
                "origin": "manual",
                "actor": actor,
                "createdAt": item.get("updatedAt"),
            }
        )
        items.append(
            {
                "ref": item.get("id"),
                "type": item.get("type"),
                "title": item.get("title"),
                "document": item.get("description", ""),
                "status": item.get("status", "draft"),
                "version": len(old) + 1,
                "quality": item.get("quality"),
                "createdAt": item.get("createdAt"),
                "updatedAt": item.get("updatedAt"),
                "revisions": revisions,
            }
        )
        if not isinstance(raw, dict):
            issues.append(f"items.{index}: expected an object.")
    sources: list[dict[str, Any]] = []
    for index, raw in enumerate(listing("sources")):
        source = mapping(raw)
        converted: dict[str, Any] = {
            "ref": source.get("id"),
            "name": source.get("name"),
            "kind": source.get("kind"),
            "mode": "searchable" if source.get("selected", True) else "excluded",
            "url": source.get("url"),
            "text": source.get("text", ""),
            "charCount": len(source["text"]) if isinstance(source.get("text"), str) else 0,
            "mediaType": source.get("mediaType") or None,
        }
        file = source.get("file")
        if file is not None:
            file_data = mapping(file)
            encoded = file_data.get("data")
            try:
                content = base64.b64decode(encoded if isinstance(encoded, str) else "", validate=True)
            except (binascii.Error, ValueError):
                issues.append(f"sources.{index}.file: the content is not valid base64.")
                content = b""
            converted["file"] = {
                "mediaType": file_data.get("type") or "application/octet-stream",
                "size": len(content),
                "sha256": hashlib.sha256(content).hexdigest(),
                "contentBase64": encoded if isinstance(encoded, str) else "",
            }
        sources.append(converted)
    relationships = [
        {
            "sourceRef": mapping(raw).get("sourceId"),
            "targetRef": mapping(raw).get("targetId"),
            "type": mapping(raw).get("type"),
        }
        for raw in listing("relationships")
    ]
    return {
        "format": BACKUP_FORMAT,
        "formatVersion": BACKUP_FORMAT_VERSION,
        "exportedAt": datetime.now(UTC).isoformat(),
        "project": {"name": project.get("name")},
        "guidance": {},
        "items": items,
        "relationships": relationships,
        "sources": sources,
    }


def prepare_backup(body: bytes, *, settings: Settings, defaults: DefaultGuidance, importer: str) -> PreparedBackup:
    """Parse and validate a whole backup document; raises 422 ``invalid-backup`` listing the problems found.

    Pure (no database access). ``importer`` is only used as the actor of revisions mapped from a v1 export.
    """
    try:
        data = json.loads(body)
    except (ValueError, RecursionError):
        raise ProblemError(
            422, "invalid-backup", title="Invalid project backup", detail="The file is not valid JSON."
        ) from None
    if not isinstance(data, dict):
        raise invalid_backup(["The document must be a JSON object."])
    document = cast(dict[str, Any], data)
    format_, version = document.get("format"), document.get("formatVersion", document.get("version"))
    issues: list[str] = []
    if format_ == LEGACY_FORMAT and type(version) is int and version == LEGACY_VERSION:
        document = convert_v1(document, importer, issues)
        if issues:
            raise invalid_backup(issues)
    elif format_ != BACKUP_FORMAT or type(version) is not int or version != BACKUP_FORMAT_VERSION:
        raise _unsupported(version, format_)
    try:
        parsed = BackupDocument.model_validate(document)
    except ValidationError as error:
        raise invalid_backup([f"{_loc(e['loc'])}: {e['msg']}" for e in error.errors()]) from None

    overrides: dict[GuidanceKey, OverrideValue] = {}
    try:
        overrides = parse_guidance_import(
            {"format": "backlog-guidance", "formatVersion": 5, "guidance": document.get("guidance") or {}},
            defaults,
            settings.guidance_max_chars,
        )
    except ProblemError as error:
        issues.extend(cast(list[str], error.extensions.get("issues") or [error.detail or "Invalid guidance."]))

    item_ids = _prepare_items(parsed, settings, issues)
    relationships = _prepare_relationships(parsed, item_ids, issues)
    sources = _prepare_sources(parsed, settings, issues)
    if issues:
        raise invalid_backup(issues)
    return PreparedBackup(
        name=parsed.project.name,
        overrides=overrides,
        items=[item for _, item in item_ids.values()],
        relationships=relationships,
        sources=sources,
    )


def _prepare_items(
    parsed: BackupDocument, settings: Settings, issues: list[str]
) -> dict[str, tuple[BackupItem, PreparedItem]]:
    prepared: dict[str, tuple[BackupItem, PreparedItem]] = {}
    for index, item in enumerate(parsed.items):
        label = f"items.{index} ({item.ref})"
        if item.ref in prepared:
            issues.append(f"{label}: duplicate ref.")
            continue
        quality: dict[str, Any] | None = None
        if item.quality is not None:
            try:
                quality = QualityAssessment.model_validate(item.quality).model_dump(
                    mode="json", by_alias=True, exclude_none=True
                )
            except ValidationError as error:
                issues.extend(f"{label}.quality.{_loc(e['loc'])}: {e['msg']}" for e in error.errors())
        versions = [r.version for r in item.revisions]
        if len(set(versions)) != len(versions):
            issues.append(f"{label}: duplicate revision versions.")
        newest = max(versions, default=0)
        item_version = item.version if item.version is not None else max(newest, 1)
        if item_version < newest:
            issues.append(f"{label}: version {item_version} is lower than its newest revision ({newest}).")
        revisions = sorted(item.revisions, key=lambda r: r.version)[-settings.revisions_keep :]
        if not revisions:
            revisions = [
                BackupRevision(
                    version=item_version,
                    title=item.title,
                    document=item.document,
                    origin="manual",
                    label="Imported",
                    actor=parsed.exported_by or "import",
                    created_at=item.updated_at,
                )
            ]
        prepared[item.ref] = (
            item,
            PreparedItem(
                id=uuid.uuid4(),
                type=item.type,
                title=item.title,
                document=item.document,
                status=item.status,
                version=item_version,
                quality=quality,
                quality_assessed_at=_aware(item.quality_assessed_at) if quality and item.quality_assessed_at else None,
                quality_document_hash=item.quality_document_hash if quality else None,
                created_at=_aware(item.created_at),
                updated_at=_aware(item.updated_at),
                revisions=[
                    PreparedRevision(
                        r.version, r.title, r.document, r.origin, r.label, r.actor, r.run_id, _aware(r.created_at)
                    )
                    for r in revisions
                ],
            ),
        )
    return prepared


def _prepare_relationships(
    parsed: BackupDocument, items: dict[str, tuple[BackupItem, PreparedItem]], issues: list[str]
) -> list[tuple[uuid.UUID, uuid.UUID, str]]:
    result: list[tuple[uuid.UUID, uuid.UUID, str]] = []
    seen: list[tuple[str, str, str]] = []
    parent_edges: list[tuple[str, str]] = []
    parents: set[str] = set()
    for index, relationship in enumerate(parsed.relationships):
        label = f"relationships.{index}"
        source_ref, target_ref, kind = relationship.source_ref, relationship.target_ref, relationship.type
        if source_ref not in items or target_ref not in items:
            issues.append(f"{label}: sourceRef and targetRef must reference existing items.")
            continue
        if source_ref == target_ref:
            issues.append(f"{label}: an item cannot have a relationship with itself.")
            continue
        candidate = (source_ref, target_ref, kind)
        if any(is_same_relationship(existing, candidate) for existing in seen):
            issues.append(f"{label}: duplicate relationship.")
            continue
        if kind == "parent-child":
            source_type, target_type = items[source_ref][0].type, items[target_ref][0].type
            if not can_be_child(source_type, target_type):
                issues.append(f"{label}: a {target_type} cannot be a child of a {source_type}.")
                continue
            if target_ref in parents:
                issues.append(f"{label}: an item can have only one parent.")
                continue
            if creates_parent_cycle(parent_edges, source_ref, target_ref):
                issues.append(f"{label}: parent-child relationships cannot form a cycle.")
                continue
            parents.add(target_ref)
            parent_edges.append((source_ref, target_ref))
        seen.append(candidate)
        result.append((items[source_ref][1].id, items[target_ref][1].id, kind))
    return result


def _valid_url(raw: str) -> bool:
    try:
        parts = urlsplit(raw)
        parts.port  # noqa: B018 - raises ValueError for an invalid port
    except ValueError:
        return False
    return (
        parts.scheme.lower() in ("http", "https") and bool(parts.hostname) and not parts.username and not parts.password
    )


def _prepare_sources(parsed: BackupDocument, settings: Settings, issues: list[str]) -> list[PreparedSource]:
    result: list[PreparedSource] = []
    refs: set[str] = set()
    pinned = 0
    max_encoded = (settings.source_max_bytes + 2) // 3 * 4 + 4
    for index, source in enumerate(parsed.sources):
        label = f"sources.{index} ({source.ref})"
        if source.ref in refs:
            issues.append(f"{label}: duplicate ref.")
        refs.add(source.ref)
        if source.char_count != len(source.text):
            issues.append(f"{label}: charCount {source.char_count} does not match the text ({len(source.text)}).")
        if len(source.text) > settings.source_max_text_chars:
            issues.append(f"{label}: the text exceeds {settings.source_max_text_chars} characters.")
        if source.page_count is not None and source.page_count > settings.source_max_pdf_pages:
            issues.append(f"{label}: pageCount exceeds {settings.source_max_pdf_pages}.")
        if source.kind == "url" and (source.url is None or not _valid_url(source.url)):
            issues.append(f"{label}: a url source needs an absolute http(s) url without credentials.")
        if source.url is not None and source.kind != "url" and not _valid_url(source.url):
            issues.append(f"{label}: url must be an absolute http(s) url without credentials.")
        if source.mode == "pinned":
            pinned += len(source.text)
        original: tuple[bytes, str] | None = None
        if source.kind == "file" and source.file is None:
            issues.append(f"{label}: a file source needs its original file.")
        elif source.kind != "file" and source.file is not None:
            issues.append(f"{label}: only file sources can carry a file.")
        elif source.file is not None:
            file = source.file
            if len(file.content_base64) > max_encoded or file.size > settings.source_max_bytes:
                issues.append(f"{label}.file: the file exceeds {settings.source_max_bytes} bytes.")
            else:
                try:
                    content = base64.b64decode(file.content_base64, validate=True)
                except (binascii.Error, ValueError):
                    issues.append(f"{label}.file: contentBase64 is not valid base64.")
                else:
                    if len(content) != file.size:
                        issues.append(f"{label}.file: size {file.size} does not match the content ({len(content)}).")
                    elif hashlib.sha256(content).hexdigest() != file.sha256.lower():
                        issues.append(f"{label}.file: sha256 does not match the content.")
                    else:
                        original = (content, file.media_type)
        result.append(
            PreparedSource(
                id=uuid.uuid4(),
                name=source.name,
                kind=source.kind,
                mode=source.mode,
                url=source.url,
                text=source.text,
                page_count=source.page_count,
                media_type=source.media_type or (original[1] if original else None),
                file=original,
            )
        )
    if pinned > settings.source_pinned_budget_chars:
        issues.append(
            f"sources: pinned sources total {pinned} characters; the limit is {settings.source_pinned_budget_chars}."
        )
    return result


# --- import: persistence -------------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ImportCounts:
    items: int
    revisions: int
    relationships: int
    sources: int
    files: int
    guidance_overrides: int


async def unique_import_name(session: AsyncSession, importer: str, name: str) -> str:
    """The backup's project name, or ``"<name> (imported)"`` when the importer already has a project of that name."""
    taken = await session.scalar(
        select(Project.id)
        .join(ProjectMember, ProjectMember.project_id == Project.id)
        .where(ProjectMember.email == importer, func.lower(Project.name) == name.lower())
        .limit(1)
    )
    if taken is None:
        return name
    return name[: MAX_PROJECT_NAME_LENGTH - len(IMPORT_SUFFIX)].rstrip() + IMPORT_SUFFIX


async def create_project(
    session: AsyncSession,
    files: FileStore,
    prepared: PreparedBackup,
    *,
    importer: str,
    defaults: DefaultGuidance,
) -> tuple[Project, ImportCounts, list[DomainEvent]]:
    """Write a prepared backup as a new project owned by ``importer`` (the caller commits and publishes the events)."""
    name = await unique_import_name(session, importer, prepared.name)
    project = Project(id=uuid.uuid4(), name=name, version=1, created_by=importer)
    session.add(project)
    await session.flush()
    session.add(ProjectMember(project_id=project.id, email=importer, role=ROLE_OWNER, added_by=importer))

    stored_overrides = 0
    for key, value in prepared.overrides.items():
        kind, item_type = key
        if value.content.strip() == default_content(defaults, kind, item_type).strip():
            continue
        await set_override(
            session,
            project.id,
            key,
            value,
            actor=importer,
            current_skill_version=defaults.versions[skill_name(kind, cast(ItemType | None, item_type))],
            existing=None,
        )
        stored_overrides += 1

    revision_count = 0
    for item in prepared.items:
        session.add(
            Item(
                id=item.id,
                project_id=project.id,
                type=item.type,
                title=item.title,
                document=item.document,
                document_hash=document_hash(item.document),
                status=item.status,
                version=item.version,
                quality=item.quality,
                quality_assessed_at=item.quality_assessed_at,
                quality_document_hash=item.quality_document_hash,
                created_by=importer,
                updated_by=importer,
                created_at=item.created_at,
                updated_at=item.updated_at,
            )
        )
    await session.flush()
    for item in prepared.items:
        for revision in item.revisions:
            session.add(
                ItemRevision(
                    item_id=item.id,
                    version=revision.version,
                    title=revision.title,
                    document=revision.document,
                    origin=revision.origin,
                    label=revision.label,
                    actor=revision.actor,
                    run_id=revision.run_id,
                    created_at=revision.created_at,
                )
            )
            revision_count += 1
    for source_id, target_id, kind in prepared.relationships:
        session.add(Relationship(project_id=project.id, source_id=source_id, target_id=target_id, type=kind))
    await session.flush()

    file_count = 0
    created = datetime.now(UTC)
    for position, prepared_source in enumerate(prepared.sources):
        source = Source(
            id=prepared_source.id,
            project_id=project.id,
            name=prepared_source.name,
            kind=prepared_source.kind,
            mode=prepared_source.mode,
            url=prepared_source.url,
            text=prepared_source.text,
            char_count=len(prepared_source.text),
            page_count=prepared_source.page_count,
            media_type=prepared_source.media_type,
            index_status="pending",
            version=1,
            added_by=importer,
            created_at=created + timedelta(microseconds=position),  # keeps the backup's source order
            updated_at=created,
        )
        session.add(source)
        await session.flush()
        if prepared_source.file is not None:
            await files.put(source.id, *prepared_source.file)
            file_count += 1
        await sources_module.enqueue_indexing(session, source, "imported")
    for item in prepared.items:
        await enqueue_item_indexing(session, item.id, project.id, delay=timedelta(0))

    counts = ImportCounts(
        items=len(prepared.items),
        revisions=revision_count,
        relationships=len(prepared.relationships),
        sources=len(prepared.sources),
        files=file_count,
        guidance_overrides=stored_overrides,
    )
    audit.record(
        session,
        actor=importer,
        action=AUDIT_PROJECT_IMPORTED,
        project_id=project.id,
        details={
            "name": name,
            "items": counts.items,
            "revisions": counts.revisions,
            "relationships": counts.relationships,
            "sources": counts.sources,
            "files": counts.files,
            "guidanceOverrides": counts.guidance_overrides,
        },
    )
    event = DomainEvent(events.PROJECT_CREATED, project.id, importer, {"name": name, "imported": True})
    return project, counts, [event]
