"""Item domain logic shared by the REST routes and (later) the MCP tools.

Functions take an :class:`AsyncSession`, never commit (the caller commits, then publishes the returned
``events``) and assume the caller already verified project membership. They raise :class:`ProblemError` for domain
failures so both REST and MCP can render them. All lookups are scoped by ``project_id``.

Versioning: ``items.version`` increases on every title, document or status change. ``item_revisions`` holds one
snapshot per version whose title or document changed (kept: the newest ``revisions_keep``), so the document a client
based its edit on can be reconstructed from "the newest revision with ``version <= base_version``".
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backlog_api import audit
from backlog_api.authz import lock_project
from backlog_api.concurrency import version_conflict
from backlog_api.db.models import Item, ItemRevision, Relationship
from backlog_api.document import (
    DocumentSection,
    SectionUpdate,
    SplitDocument,
    changed_sections,
    conform_to_template,
    document_hash,
    join_sections,
    normalize_heading,
    split_sections,
)
from backlog_api.document import (
    apply_section_updates as merge_section_updates,
)
from backlog_api.events import DomainEvent
from backlog_api.item_rules import (
    DEFAULT_TITLES,
    can_be_child,
    can_transition,
    creates_parent_cycle,
    is_same_relationship,
)
from backlog_api.items_schemas import ItemOut, QualityAssessment, QualityOut
from backlog_api.problems import ProblemError, conflict, not_found
from backlog_api.templates import template_for

Origin = Literal["manual", "agent", "restore"]

ITEM_CREATED = "item.created"
ITEM_UPDATED = "item.updated"
ITEM_DELETED = "item.deleted"
RELATIONSHIP_CREATED = "relationship.created"
RELATIONSHIP_DELETED = "relationship.deleted"

AUDIT_ITEM_CREATED = "item.created"
AUDIT_ITEM_UPDATED = "item.updated"
AUDIT_ITEM_DELETED = "item.deleted"
AUDIT_ITEM_RESTORED = "item.restored"
AUDIT_ITEM_QUALITY = "item.quality_set"
AUDIT_ITEM_CHILDREN = "item.children_created"
AUDIT_RELATIONSHIP_CREATED = "relationship.created"
AUDIT_RELATIONSHIP_DELETED = "relationship.deleted"

DEFAULT_REVISIONS_KEEP = 50


def _now() -> datetime:
    return datetime.now(UTC)


def _lf(document: str) -> str:
    return document.replace("\r\n", "\n")


# --- results --------------------------------------------------------------------------------------------------------


@dataclass(slots=True)
class ItemChange:
    item: Item
    changed_sections: list[str] = field(default_factory=list)
    title_changed: bool = False
    status_changed: bool = False
    events: list[DomainEvent] = field(default_factory=list)

    @property
    def changed(self) -> bool:
        return bool(self.changed_sections or self.title_changed or self.status_changed)


@dataclass(slots=True)
class SectionChange:
    """One proposed section change; ``id`` is an optional caller-side identifier echoed back in the outcome."""

    heading: str
    markdown: str
    mode: Literal["replace", "append"] = "replace"
    id: str | None = None

    @property
    def key(self) -> str:
        return self.id or self.heading


@dataclass(slots=True)
class SectionConflict:
    section_id: str
    heading: str
    reason: str
    current_markdown: str | None = None


@dataclass(slots=True)
class ApplyOutcome:
    """Result of :func:`apply_section_updates` (shaped like the ``document-changes.result`` contract)."""

    applied: list[str]
    conflicted: list[SectionConflict]
    new_version: int
    warnings: list[str]
    title_applied: bool
    status_applied: bool
    item: Item
    events: list[DomainEvent] = field(default_factory=list)


@dataclass(slots=True)
class ChildSpec:
    """A child to create: ``document`` (Markdown) or ``sections`` ``[(heading, markdown)]``, template-conformed."""

    proposal_id: str
    title: str
    document: str | None = None
    sections: Sequence[tuple[str, str]] | None = None


@dataclass(slots=True)
class RelationshipSpec:
    """Relationship between refs: the parent item id (string) or a child ``proposal_id``."""

    source_ref: str
    target_ref: str
    type: str


@dataclass(slots=True)
class ChildrenOutcome:
    """Result of :func:`create_children` (shaped like the ``child-items.result`` contract)."""

    created: list[tuple[str, Item]] = field(default_factory=list)  # (proposal_id, item)
    failed: list[tuple[str, str]] = field(default_factory=list)  # (proposal_id, reason)
    relationships_created: int = 0
    relationships_skipped: list[tuple[str, str, str]] = field(default_factory=list)  # (source_ref, target_ref, reason)
    events: list[DomainEvent] = field(default_factory=list)


# --- loading and serialisation --------------------------------------------------------------------------------------


async def get_item(session: AsyncSession, project_id: uuid.UUID, item_id: uuid.UUID, *, lock: bool = False) -> Item:
    statement = select(Item).where(Item.id == item_id, Item.project_id == project_id)
    if lock:
        statement = statement.with_for_update()
    item = (await session.execute(statement.execution_options(populate_existing=True))).scalar_one_or_none()
    if item is None:
        raise not_found("The item does not exist in this project.")
    return item


async def parent_id_of(session: AsyncSession, item_id: uuid.UUID) -> uuid.UUID | None:
    return await session.scalar(
        select(Relationship.source_id).where(Relationship.target_id == item_id, Relationship.type == "parent-child")
    )


async def parent_ids(session: AsyncSession, project_id: uuid.UUID) -> dict[uuid.UUID, uuid.UUID]:
    rows = await session.execute(
        select(Relationship.target_id, Relationship.source_id).where(
            Relationship.project_id == project_id, Relationship.type == "parent-child"
        )
    )
    return {child: parent for child, parent in rows.all()}


def is_quality_stale(item: Item) -> bool:
    return item.quality is not None and item.quality_document_hash != item.document_hash


async def item_out(session: AsyncSession, item: Item) -> ItemOut:
    quality = (
        QualityOut(
            assessment=item.quality,
            assessed_at=item.quality_assessed_at,
            document_hash=item.quality_document_hash,
            stale=is_quality_stale(item),
        )
        if item.quality is not None
        else None
    )
    return ItemOut(
        id=item.id,
        project_id=item.project_id,
        parent_id=await parent_id_of(session, item.id),
        type=item.type,  # pyright: ignore[reportArgumentType]
        title=item.title,
        document=item.document,
        status=item.status,  # pyright: ignore[reportArgumentType]
        version=item.version,
        document_hash=item.document_hash,
        quality=quality,
        created_by=item.created_by,
        updated_by=item.updated_by,
        created_at=item.created_at,
        updated_at=item.updated_at,
    )


async def base_document(session: AsyncSession, item_id: uuid.UUID, version: int) -> tuple[str, str] | None:
    """``(title, document)`` of the item as of ``version`` (newest revision at or below it); ``None`` if pruned."""
    row = (
        await session.execute(
            select(ItemRevision.title, ItemRevision.document)
            .where(ItemRevision.item_id == item_id, ItemRevision.version <= version)
            .order_by(ItemRevision.version.desc())
            .limit(1)
        )
    ).first()
    return None if row is None else (row[0], row[1])


# --- revisions ------------------------------------------------------------------------------------------------------


async def _write_revision(
    session: AsyncSession,
    item: Item,
    *,
    origin: Origin,
    actor: str,
    run_id: str | None,
    label: str | None,
    keep: int,
) -> None:
    session.add(
        ItemRevision(
            item_id=item.id,
            version=item.version,
            title=item.title,
            document=item.document,
            origin=origin,
            label=label,
            actor=actor,
            run_id=run_id,
        )
    )
    await session.flush()
    newest = select(ItemRevision.id).where(ItemRevision.item_id == item.id).order_by(ItemRevision.version.desc())
    await session.execute(
        delete(ItemRevision).where(ItemRevision.item_id == item.id, ItemRevision.id.not_in(newest.limit(max(keep, 1))))
    )


def _item_event(kind: str, item: Item, actor: str, **data: Any) -> DomainEvent:
    return DomainEvent(kind, item.project_id, actor, {"id": str(item.id), **data})


def _updated_event(
    item: Item, actor: str, origin: Origin, sections: list[str], *, title_changed: bool, status_changed: bool
) -> DomainEvent:
    return _item_event(
        ITEM_UPDATED,
        item,
        actor,
        version=item.version,
        changedSections=sections,
        titleChanged=title_changed,
        statusChanged=status_changed,
        status=item.status,
        origin=origin,
    )


# --- create ---------------------------------------------------------------------------------------------------------


async def _check_parent(session: AsyncSession, project_id: uuid.UUID, parent_id: uuid.UUID, child_type: str) -> Item:
    parent = await get_item(session, project_id, parent_id, lock=True)
    if not can_be_child(parent.type, child_type):
        raise ProblemError(
            422,
            "invalid-child-type",
            detail=f"A {child_type} cannot be a child of a {parent.type}.",
        )
    return parent


async def create_item(
    session: AsyncSession,
    project_id: uuid.UUID,
    item_type: str,
    *,
    title: str | None = None,
    document: str | None = None,
    parent_id: uuid.UUID | None = None,
    actor: str,
    origin: Origin = "manual",
    run_id: str | None = None,
    keep: int = DEFAULT_REVISIONS_KEEP,
) -> ItemChange:
    """Create an item whose document follows the project's effective template for ``item_type``."""
    if parent_id is not None:
        await _check_parent(session, project_id, parent_id, item_type)
    template = await template_for(session, project_id, item_type)
    conformed = conform_to_template(template, _lf(document or "")).document
    now = _now()
    item = Item(
        id=uuid.uuid4(),
        project_id=project_id,
        type=item_type,
        title=(title or "").strip() or DEFAULT_TITLES[item_type],
        document=conformed,
        status="draft",
        version=1,
        created_by=actor,
        updated_by=actor,
        created_at=now,
        updated_at=now,
    )
    item.document_hash = document_hash(conformed)
    session.add(item)
    await session.flush()
    events = [_item_event(ITEM_CREATED, item, actor, type=item.type, title=item.title, version=1, origin=origin)]
    if parent_id is not None:
        relationship = Relationship(project_id=project_id, source_id=parent_id, target_id=item.id, type="parent-child")
        session.add(relationship)
        await session.flush()
        events.append(_relationship_event(RELATIONSHIP_CREATED, relationship, actor))
        events[0].data["parentId"] = str(parent_id)
    await _write_revision(session, item, origin=origin, actor=actor, run_id=run_id, label="Created", keep=keep)
    audit.record(
        session,
        actor=actor,
        action=AUDIT_ITEM_CREATED,
        project_id=project_id,
        details={"itemId": str(item.id), "type": item.type, "origin": origin},
    )
    return ItemChange(item, events=events)


# --- update ---------------------------------------------------------------------------------------------------------


async def _conflict_error(session: AsyncSession, item: Item, expected_version: int) -> ProblemError:
    base = await base_document(session, item.id, expected_version) if expected_version < item.version else None
    sections = changed_sections(base[1] if base else "", item.document)
    return version_conflict(
        item.version,
        changedSections=sections,
        item=(await item_out(session, item)).model_dump(mode="json", by_alias=True),
    )


def _transition_error(current: str, target: str) -> ProblemError:
    return ProblemError(
        422,
        "invalid-status-transition",
        detail=f"Cannot transition backlog item from {current} to {target}.",
        currentStatus=current,
        requestedStatus=target,
    )


async def update_item(
    session: AsyncSession,
    project_id: uuid.UUID,
    item_id: uuid.UUID,
    *,
    expected_version: int | None,
    title: str | None = None,
    document: str | None = None,
    status: str | None = None,
    actor: str,
    origin: Origin = "manual",
    run_id: str | None = None,
    label: str | None = None,
    keep: int = DEFAULT_REVISIONS_KEEP,
) -> ItemChange:
    """Change title, document and/or status.

    ``expected_version`` is the version the caller based the change on; a mismatch raises a 409 ``version-conflict``
    carrying ``currentVersion``, ``changedSections`` (sections changed since that version) and the current ``item``.
    A change that alters nothing is a no-op (no new version).
    """
    item = await get_item(session, project_id, item_id, lock=True)
    if expected_version is not None and expected_version != item.version:
        raise await _conflict_error(session, item, expected_version)
    if status is not None and not can_transition(item.status, status):
        raise _transition_error(item.status, status)
    return await _apply_changes(
        session,
        item,
        title=title,
        document=document,
        status=status,
        actor=actor,
        origin=origin,
        run_id=run_id,
        label=label,
        keep=keep,
    )


async def _apply_changes(
    session: AsyncSession,
    item: Item,
    *,
    title: str | None,
    document: str | None,
    status: str | None,
    actor: str,
    origin: Origin,
    run_id: str | None,
    label: str | None,
    keep: int,
) -> ItemChange:
    new_title = title.strip() if title is not None else item.title
    new_document = _lf(document) if document is not None else item.document
    title_changed = new_title != item.title
    document_changed = new_document != item.document
    status_changed = status is not None and status != item.status
    if not (title_changed or document_changed or status_changed):
        return ItemChange(item)
    sections = changed_sections(item.document, new_document) if document_changed else []
    item.title = new_title
    if document_changed:
        item.document = new_document
        item.document_hash = document_hash(new_document)
    if status_changed and status is not None:
        item.status = status
    item.version += 1
    item.updated_by = actor
    item.updated_at = _now()
    await session.flush()
    if title_changed or document_changed:
        await _write_revision(session, item, origin=origin, actor=actor, run_id=run_id, label=label, keep=keep)
    audit.record(
        session,
        actor=actor,
        action=AUDIT_ITEM_UPDATED,
        project_id=item.project_id,
        details={
            "itemId": str(item.id),
            "version": item.version,
            "origin": origin,
            "titleChanged": title_changed,
            "documentChanged": document_changed,
            "statusChanged": status_changed,
        },
    )
    event = _updated_event(item, actor, origin, sections, title_changed=title_changed, status_changed=status_changed)
    return ItemChange(item, sections, title_changed, status_changed, [event])


# --- apply section updates (agent / MCP) ----------------------------------------------------------------------------


async def apply_section_updates(
    session: AsyncSession,
    project_id: uuid.UUID,
    item_id: uuid.UUID,
    *,
    base_version: int,
    sections: Sequence[SectionChange],
    actor: str,
    origin: Origin = "agent",
    run_id: str | None = None,
    title: str | None = None,
    status: str | None = None,
    label: str | None = None,
    keep: int = DEFAULT_REVISIONS_KEEP,
) -> ApplyOutcome:
    """Merge section updates proposed against ``base_version`` into the *current* document.

    A section conflicts (and is skipped) when it changed between ``base_version`` and now; the others are merged with
    :func:`backlog_api.document.apply_section_updates` (confirmed ``[x]`` lines are kept). A suggested ``title`` is only
    applied when the title did not change since the base version; a suggested ``status`` only when the transition is
    valid. Nothing applied means no new version.
    """
    item = await get_item(session, project_id, item_id, lock=True)
    if base_version > item.version or base_version < 1:
        raise ProblemError(422, "invalid-base-version", detail="baseVersion does not exist for this item.")
    base = await base_document(session, item.id, base_version) if base_version < item.version else None
    if base_version == item.version:
        changed: set[str] = set()
        base_title: str | None = item.title
    else:
        # A pruned base revision means we cannot tell what changed: treat every section as changed.
        changed = {normalize_heading(h) for h in changed_sections(base[1] if base else "", item.document)}
        base_title = base[0] if base else None

    applied: list[str] = []
    conflicted: list[SectionConflict] = []
    to_merge: list[SectionChange] = []
    current = {normalize_heading(s.heading): s.body for s in split_sections(item.document).sections}
    for change in sections:
        key = normalize_heading(change.heading)
        if key in changed:
            conflicted.append(
                SectionConflict(
                    change.key,
                    change.heading,
                    "Changed by someone else since the version this proposal was based on.",
                    current.get(key),
                )
            )
        else:
            to_merge.append(change)
            applied.append(change.key)
    merged = merge_section_updates(
        item.document, [SectionUpdate(change.heading, change.markdown, change.mode) for change in to_merge]
    )
    new_document = merged.document if to_merge else item.document
    title_applied = title is not None and title.strip() != item.title and base_title == item.title
    status_applied = status is not None and status != item.status and can_transition(item.status, status)
    change_result = await _apply_changes(
        session,
        item,
        title=title if title_applied else None,
        document=new_document,
        status=status if status_applied else None,
        actor=actor,
        origin=origin,
        run_id=run_id,
        label=label,
        keep=keep,
    )
    return ApplyOutcome(
        applied=applied,
        conflicted=conflicted,
        new_version=item.version,
        warnings=merged.warnings,
        title_applied=title_applied and change_result.title_changed,
        status_applied=status_applied and change_result.status_changed,
        item=item,
        events=change_result.events,
    )


# --- restore --------------------------------------------------------------------------------------------------------


async def restore_revision(
    session: AsyncSession,
    project_id: uuid.UUID,
    item_id: uuid.UUID,
    revision_id: uuid.UUID,
    *,
    expected_version: int | None = None,
    actor: str,
    run_id: str | None = None,
    keep: int = DEFAULT_REVISIONS_KEEP,
) -> ItemChange:
    """Restore the title and document of a revision as a new version (revision origin ``restore``)."""
    item = await get_item(session, project_id, item_id, lock=True)
    if expected_version is not None and expected_version != item.version:
        raise await _conflict_error(session, item, expected_version)
    revision = await session.scalar(
        select(ItemRevision).where(ItemRevision.id == revision_id, ItemRevision.item_id == item.id)
    )
    if revision is None:
        raise not_found("The revision does not exist.")
    result = await _apply_changes(
        session,
        item,
        title=revision.title,
        document=revision.document,
        status=None,
        actor=actor,
        origin="restore",
        run_id=run_id,
        label=f"Restored version {revision.version}",
        keep=keep,
    )
    audit.record(
        session,
        actor=actor,
        action=AUDIT_ITEM_RESTORED,
        project_id=project_id,
        details={"itemId": str(item.id), "revisionId": str(revision.id), "fromVersion": revision.version},
    )
    return result


# --- delete ---------------------------------------------------------------------------------------------------------


async def delete_item(
    session: AsyncSession,
    project_id: uuid.UUID,
    item_id: uuid.UUID,
    *,
    expected_version: int | None = None,
    actor: str,
) -> list[DomainEvent]:
    """Delete an item with its revisions and relationships; related items are kept (the SPA's delete semantics)."""
    item = await get_item(session, project_id, item_id, lock=True)
    if expected_version is not None and expected_version != item.version:
        raise await _conflict_error(session, item, expected_version)
    relationships = (
        await session.scalars(
            select(Relationship).where((Relationship.source_id == item.id) | (Relationship.target_id == item.id))
        )
    ).all()
    events = [_relationship_event(RELATIONSHIP_DELETED, rel, actor) for rel in relationships]
    events.append(_item_event(ITEM_DELETED, item, actor, type=item.type, title=item.title))
    audit.record(
        session,
        actor=actor,
        action=AUDIT_ITEM_DELETED,
        project_id=project_id,
        details={"itemId": str(item.id), "type": item.type, "relationships": len(relationships)},
    )
    await session.delete(item)
    await session.flush()
    return events


# --- quality --------------------------------------------------------------------------------------------------------


async def set_quality(
    session: AsyncSession,
    project_id: uuid.UUID,
    item_id: uuid.UUID,
    quality: QualityAssessment | Mapping[str, Any],
    assessed_document_hash: str,
    *,
    actor: str,
) -> ItemChange:
    """Store a quality assessment. Rejected (409 ``stale-assessment``) when the document changed since it was made.

    Quality metadata does not change the item ``version``.
    """
    item = await get_item(session, project_id, item_id, lock=True)
    if assessed_document_hash != item.document_hash:
        raise conflict(
            "stale-assessment",
            "The document changed since it was assessed. Assess the current document instead.",
            currentDocumentHash=item.document_hash,
            currentVersion=item.version,
        )
    assessment = quality if isinstance(quality, QualityAssessment) else QualityAssessment.model_validate(quality)
    item.quality = assessment.model_dump(mode="json", by_alias=True, exclude_none=True)
    item.quality_assessed_at = _now()
    item.quality_document_hash = assessed_document_hash
    await session.flush()
    audit.record(
        session,
        actor=actor,
        action=AUDIT_ITEM_QUALITY,
        project_id=project_id,
        details={"itemId": str(item.id), "overall": assessment.overall},
    )
    event = _item_event(
        ITEM_UPDATED, item, actor, version=item.version, changedSections=[], quality=assessment.overall, origin="agent"
    )
    return ItemChange(item, events=[event])


# --- relationships --------------------------------------------------------------------------------------------------


def _relationship_event(kind: str, relationship: Relationship, actor: str) -> DomainEvent:
    return DomainEvent(
        kind,
        relationship.project_id,
        actor,
        {
            "id": str(relationship.id),
            "sourceId": str(relationship.source_id),
            "targetId": str(relationship.target_id),
            "type": relationship.type,
        },
    )


async def list_relationships(session: AsyncSession, project_id: uuid.UUID) -> list[Relationship]:
    rows = await session.scalars(
        select(Relationship).where(Relationship.project_id == project_id).order_by(Relationship.id)
    )
    return list(rows)


async def add_relationship(
    session: AsyncSession,
    project_id: uuid.UUID,
    source_id: uuid.UUID,
    target_id: uuid.UUID,
    relationship_type: str,
    *,
    actor: str,
    lock: bool = True,
) -> tuple[Relationship, list[DomainEvent]]:
    """Link two items of the project, enforcing the SPA's rules.

    No self-links, both items in the project, no duplicates (``related-to`` is symmetric), a single parent per item,
    no parent cycles and the capability → feature/enabler, feature → user-story/enabler child type rules.
    """
    if source_id == target_id:
        raise ProblemError(422, "self-relationship", detail="An item cannot have a relationship with itself.")
    if lock and not await lock_project(session, project_id):
        raise not_found("The project does not exist.")
    found = {
        item.id: item
        for item in (
            await session.scalars(
                select(Item).where(Item.project_id == project_id, Item.id.in_([source_id, target_id]))
            )
        ).all()
    }
    if source_id not in found or target_id not in found:
        raise ProblemError(404, "item-not-found", detail="Both relationship endpoints must be items of this project.")
    existing = (
        await session.execute(
            select(Relationship.source_id, Relationship.target_id, Relationship.type).where(
                Relationship.project_id == project_id
            )
        )
    ).all()
    candidate = (source_id, target_id, relationship_type)
    if any(is_same_relationship((s, t, k), candidate) for s, t, k in existing):
        raise conflict("duplicate-relationship", "This relationship already exists.")
    if relationship_type == "parent-child":
        if not can_be_child(found[source_id].type, found[target_id].type):
            raise ProblemError(
                422,
                "invalid-child-type",
                detail=f"A {found[target_id].type} cannot be a child of a {found[source_id].type}.",
            )
        if any(t == target_id and k == "parent-child" for _, t, k in existing):
            raise conflict("multiple-parents", "An item can have only one parent.")
        edges = [(s, t) for s, t, k in existing if k == "parent-child"]
        if creates_parent_cycle(edges, source_id, target_id):
            raise conflict("parent-cycle", "Parent-child relationships cannot form a cycle.")
    relationship = Relationship(project_id=project_id, source_id=source_id, target_id=target_id, type=relationship_type)
    session.add(relationship)
    try:
        await session.flush()
    except IntegrityError as error:  # lost a race with a concurrent writer
        raise conflict("duplicate-relationship", "This relationship already exists.") from error
    audit.record(
        session,
        actor=actor,
        action=AUDIT_RELATIONSHIP_CREATED,
        project_id=project_id,
        details={"sourceId": str(source_id), "targetId": str(target_id), "type": relationship_type},
    )
    return relationship, [_relationship_event(RELATIONSHIP_CREATED, relationship, actor)]


async def delete_relationship(
    session: AsyncSession, project_id: uuid.UUID, relationship_id: uuid.UUID, *, actor: str
) -> list[DomainEvent]:
    relationship = await session.scalar(
        select(Relationship).where(Relationship.id == relationship_id, Relationship.project_id == project_id)
    )
    if relationship is None:
        raise not_found("The relationship does not exist.")
    event = _relationship_event(RELATIONSHIP_DELETED, relationship, actor)
    audit.record(
        session,
        actor=actor,
        action=AUDIT_RELATIONSHIP_DELETED,
        project_id=project_id,
        details={
            "sourceId": str(relationship.source_id),
            "targetId": str(relationship.target_id),
            "type": relationship.type,
        },
    )
    await session.delete(relationship)
    await session.flush()
    return [event]


# --- children -------------------------------------------------------------------------------------------------------


def _normalize_title(title: str) -> str:
    return " ".join(title.split()).lower()


async def create_children(
    session: AsyncSession,
    project_id: uuid.UUID,
    parent_id: uuid.UUID,
    child_type: str,
    children: Sequence[ChildSpec],
    relationships: Sequence[RelationshipSpec] = (),
    *,
    actor: str,
    origin: Origin = "agent",
    run_id: str | None = None,
    keep: int = DEFAULT_REVISIONS_KEEP,
) -> ChildrenOutcome:
    """Create children under ``parent_id`` (each conformed to the child type's template) and link them.

    Every child is linked to the parent; ``relationships`` adds further links between the parent and/or the new
    children, addressed by the parent id or a child's ``proposal_id``. Children that duplicate an existing sibling
    (same type and title) or fail validation are reported in ``failed``; relationships that cannot be created are
    reported in ``relationships_skipped``. One failing child does not roll back the others.
    """
    parent = await _check_parent(session, project_id, parent_id, child_type)
    outcome = ChildrenOutcome()
    sibling_titles = {
        (item.type, _normalize_title(item.title))
        for item in (
            await session.scalars(
                select(Item)
                .join(Relationship, Relationship.target_id == Item.id)
                .where(Relationship.source_id == parent.id, Relationship.type == "parent-child")
            )
        ).all()
    }
    refs: dict[str, uuid.UUID] = {str(parent.id): parent.id}
    for child in children:
        key = (child_type, _normalize_title(child.title))
        if child.proposal_id in refs or child.proposal_id == str(parent.id):
            outcome.failed.append((child.proposal_id, "Duplicate proposal id."))
            continue
        if key in sibling_titles:
            outcome.failed.append((child.proposal_id, "Duplicates an existing or selected item under this parent."))
            continue
        document = child.document
        if document is None and child.sections is not None:
            document = join_sections(
                SplitDocument("", [DocumentSection(heading, body.strip()) for heading, body in child.sections])
            )
        try:
            async with session.begin_nested():
                created = await create_item(
                    session,
                    project_id,
                    child_type,
                    title=child.title,
                    document=document,
                    parent_id=parent.id,
                    actor=actor,
                    origin=origin,
                    run_id=run_id,
                    keep=keep,
                )
        except ProblemError as error:
            outcome.failed.append((child.proposal_id, error.detail or error.title))
            continue
        sibling_titles.add(key)
        refs[child.proposal_id] = created.item.id
        outcome.created.append((child.proposal_id, created.item))
        outcome.events.extend(created.events)

    for spec in relationships:
        source, target = refs.get(spec.source_ref), refs.get(spec.target_ref)
        if source is None or target is None:
            outcome.relationships_skipped.append((spec.source_ref, spec.target_ref, "An endpoint was not created."))
            continue
        if (
            spec.type == "parent-child"
            and source == parent.id
            and any(item.id == target for _, item in outcome.created)
        ):
            continue  # already linked to the parent when the child was created
        try:
            async with session.begin_nested():
                _, events = await add_relationship(
                    session, project_id, source, target, spec.type, actor=actor, lock=False
                )
        except ProblemError as error:
            outcome.relationships_skipped.append((spec.source_ref, spec.target_ref, error.detail or error.title))
            continue
        outcome.relationships_created += 1
        outcome.events.extend(events)
    outcome.relationships_created += len(outcome.created)  # the parent links
    if outcome.created:
        audit.record(
            session,
            actor=actor,
            action=AUDIT_ITEM_CHILDREN,
            project_id=project_id,
            details={
                "parentId": str(parent.id),
                "childType": child_type,
                "created": [str(item.id) for _, item in outcome.created],
                "origin": origin,
            },
        )
    return outcome
