"""Items, revisions, relationships and quality metadata of a project (members of any role may read and write)."""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Header, Path, Request, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backlog_api import items_service
from backlog_api.api.deps import MemberAccessDep, ProjectId
from backlog_api.auth.dependencies import PrincipalDep
from backlog_api.concurrency import etag, parse_if_match
from backlog_api.db.models import Item, ItemRevision, Relationship
from backlog_api.db.session import SessionDep
from backlog_api.events import DomainEvent, EventPublisherDep
from backlog_api.items_schemas import (
    ItemCreate,
    ItemList,
    ItemOut,
    ItemSummary,
    ItemUpdate,
    QualitySummary,
    QualityUpdate,
    RelationshipCreate,
    RelationshipList,
    RelationshipOut,
    RevisionList,
    RevisionOut,
    RevisionSummary,
)
from backlog_api.problems import not_found, problem_responses
from backlog_api.settings import API_PREFIX, Settings

router = APIRouter(tags=["items"])

ItemId = Annotated[uuid.UUID, Path(description="Item id.")]
RevisionId = Annotated[uuid.UUID, Path(description="Revision id.")]
RelationshipId = Annotated[uuid.UUID, Path(description="Relationship id.")]
IfMatch = Annotated[
    str | None, Header(alias="If-Match", description="The item version (ETag) this change is based on.")
]


def _revisions_keep(request: Request) -> int:
    settings: Settings = request.app.state.settings
    return settings.revisions_keep


KeepDep = Annotated[int, Depends(_revisions_keep)]


async def _publish(publisher: EventPublisherDep, events: list[DomainEvent]) -> None:
    for event in events:
        await publisher.publish(event)


def _summary(item: Item, parent_id: uuid.UUID | None) -> ItemSummary:
    quality = (
        QualitySummary(
            overall=(item.quality or {}).get("overall"),
            assessed_at=item.quality_assessed_at,
            stale=items_service.is_quality_stale(item),
        )
        if item.quality is not None
        else None
    )
    return ItemSummary(
        id=item.id,
        parent_id=parent_id,
        type=item.type,  # pyright: ignore[reportArgumentType]
        title=item.title,
        status=item.status,  # pyright: ignore[reportArgumentType]
        version=item.version,
        quality=quality,
        updated_at=item.updated_at,
        updated_by=item.updated_by,
    )


def _revision_summary(revision: ItemRevision) -> RevisionSummary:
    return RevisionSummary(
        id=revision.id,
        item_id=revision.item_id,
        version=revision.version,
        title=revision.title,
        origin=revision.origin,  # pyright: ignore[reportArgumentType]
        label=revision.label,
        actor=revision.actor,
        run_id=revision.run_id,
        created_at=revision.created_at,
    )


def _revision_out(revision: ItemRevision) -> RevisionOut:
    return RevisionOut(**_revision_summary(revision).model_dump(), document=revision.document)


def _item_location(project_id: uuid.UUID, item_id: uuid.UUID) -> str:
    return f"{API_PREFIX}/projects/{project_id}/items/{item_id}"


async def _load_revision(
    session: AsyncSession, project_id: uuid.UUID, item_id: uuid.UUID, revision_id: uuid.UUID
) -> ItemRevision:
    await items_service.get_item(session, project_id, item_id)
    revision = await session.scalar(
        select(ItemRevision).where(ItemRevision.id == revision_id, ItemRevision.item_id == item_id)
    )
    if revision is None:
        raise not_found("The revision does not exist.")
    return revision


# --- items ----------------------------------------------------------------------------------------------------------


@router.get(
    "/projects/{project_id}/items",
    summary="List the items of a project (flat, tree-friendly)",
    responses=problem_responses(401, 403, 404, 422),
)
async def list_items(project_id: ProjectId, access: MemberAccessDep, session: SessionDep) -> ItemList:
    items = (
        await session.scalars(select(Item).where(Item.project_id == project_id).order_by(Item.created_at, Item.id))
    ).all()
    parents = await items_service.parent_ids(session, project_id)
    return ItemList(items=[_summary(item, parents.get(item.id)) for item in items])


@router.post(
    "/projects/{project_id}/items",
    status_code=status.HTTP_201_CREATED,
    summary="Create an item from the project's template",
    responses=problem_responses(401, 403, 404, 422),
)
async def create_item(
    project_id: ProjectId,
    body: ItemCreate,
    access: MemberAccessDep,
    principal: PrincipalDep,
    session: SessionDep,
    publisher: EventPublisherDep,
    keep: KeepDep,
    response: Response,
) -> ItemOut:
    result = await items_service.create_item(
        session,
        project_id,
        body.type,
        title=body.title,
        document=body.document,
        parent_id=body.parent_id,
        actor=principal.email,
        keep=keep,
    )
    out = await items_service.item_out(session, result.item)
    await session.commit()
    response.headers["Location"] = _item_location(project_id, result.item.id)
    response.headers["ETag"] = etag(result.item.version)
    await _publish(publisher, result.events)
    return out


@router.get(
    "/projects/{project_id}/items/{item_id}",
    summary="Get an item with its document (ETag = version)",
    responses=problem_responses(401, 403, 404, 422),
)
async def get_item(
    project_id: ProjectId, item_id: ItemId, access: MemberAccessDep, session: SessionDep, response: Response
) -> ItemOut:
    item = await items_service.get_item(session, project_id, item_id)
    response.headers["ETag"] = etag(item.version)
    return await items_service.item_out(session, item)


@router.patch(
    "/projects/{project_id}/items/{item_id}",
    summary="Change title, document and/or status (requires If-Match)",
    description=(
        "Send `If-Match: <version>`. A stale version returns 409 `version-conflict` with `currentVersion`, "
        "`changedSections` (sections changed since the version you based the edit on) and the current `item`. "
        "Status changes are validated against the allowed transitions (422 `invalid-status-transition`)."
    ),
    responses=problem_responses(400, 401, 403, 404, 409, 422, 428),
)
async def update_item(
    project_id: ProjectId,
    item_id: ItemId,
    body: ItemUpdate,
    access: MemberAccessDep,
    principal: PrincipalDep,
    session: SessionDep,
    publisher: EventPublisherDep,
    keep: KeepDep,
    response: Response,
    if_match: IfMatch = None,
) -> ItemOut:
    expected = parse_if_match(if_match)
    result = await items_service.update_item(
        session,
        project_id,
        item_id,
        expected_version=expected,
        title=body.title,
        document=body.document,
        status=body.status,
        actor=principal.email,
        keep=keep,
    )
    out = await items_service.item_out(session, result.item)
    await session.commit()
    response.headers["ETag"] = etag(result.item.version)
    await _publish(publisher, result.events)
    return out


@router.delete(
    "/projects/{project_id}/items/{item_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete an item (its relationships go with it; related items are kept)",
    responses=problem_responses(400, 401, 403, 404, 409, 422),
)
async def delete_item(
    project_id: ProjectId,
    item_id: ItemId,
    access: MemberAccessDep,
    principal: PrincipalDep,
    session: SessionDep,
    publisher: EventPublisherDep,
    if_match: IfMatch = None,
) -> Response:
    expected = parse_if_match(if_match) if if_match is not None else None
    events = await items_service.delete_item(
        session, project_id, item_id, expected_version=expected, actor=principal.email
    )
    await session.commit()
    await _publish(publisher, events)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put(
    "/projects/{project_id}/items/{item_id}/quality",
    summary="Store a quality assessment for the current document",
    description="`documentHash` must equal the item's current `documentHash`, otherwise 409 `stale-assessment`.",
    responses=problem_responses(401, 403, 404, 409, 422),
)
async def set_item_quality(
    project_id: ProjectId,
    item_id: ItemId,
    body: QualityUpdate,
    access: MemberAccessDep,
    principal: PrincipalDep,
    session: SessionDep,
    publisher: EventPublisherDep,
) -> ItemOut:
    result = await items_service.set_quality(
        session, project_id, item_id, body.quality, body.document_hash, actor=principal.email
    )
    out = await items_service.item_out(session, result.item)
    await session.commit()
    await _publish(publisher, result.events)
    return out


# --- revisions ------------------------------------------------------------------------------------------------------


@router.get(
    "/projects/{project_id}/items/{item_id}/revisions",
    summary="Revision history of an item (newest first, without documents)",
    responses=problem_responses(401, 403, 404, 422),
)
async def list_item_revisions(
    project_id: ProjectId, item_id: ItemId, access: MemberAccessDep, session: SessionDep
) -> RevisionList:
    await items_service.get_item(session, project_id, item_id)
    revisions = await session.scalars(
        select(ItemRevision)
        .where(ItemRevision.item_id == item_id)
        .order_by(ItemRevision.created_at.desc(), ItemRevision.version.desc())
    )
    return RevisionList(items=[_revision_summary(revision) for revision in revisions])


@router.get(
    "/projects/{project_id}/items/{item_id}/revisions/{revision_id}",
    summary="A revision with its document",
    responses=problem_responses(401, 403, 404, 422),
)
async def get_item_revision(
    project_id: ProjectId, item_id: ItemId, revision_id: RevisionId, access: MemberAccessDep, session: SessionDep
) -> RevisionOut:
    return _revision_out(await _load_revision(session, project_id, item_id, revision_id))


@router.post(
    "/projects/{project_id}/items/{item_id}/revisions/{revision_id}/restore",
    summary="Restore a revision as a new version (origin restore)",
    description="Optionally send `If-Match: <version>` to fail with 409 when the item changed in the meantime.",
    responses=problem_responses(400, 401, 403, 404, 409, 422),
)
async def restore_item_revision(
    project_id: ProjectId,
    item_id: ItemId,
    revision_id: RevisionId,
    access: MemberAccessDep,
    principal: PrincipalDep,
    session: SessionDep,
    publisher: EventPublisherDep,
    keep: KeepDep,
    response: Response,
    if_match: IfMatch = None,
) -> ItemOut:
    expected = parse_if_match(if_match) if if_match is not None else None
    result = await items_service.restore_revision(
        session,
        project_id,
        item_id,
        revision_id,
        expected_version=expected,
        actor=principal.email,
        keep=keep,
    )
    out = await items_service.item_out(session, result.item)
    await session.commit()
    response.headers["ETag"] = etag(result.item.version)
    await _publish(publisher, result.events)
    return out


# --- relationships --------------------------------------------------------------------------------------------------


def _relationship_out(relationship: Relationship) -> RelationshipOut:
    return RelationshipOut(
        id=relationship.id,
        project_id=relationship.project_id,
        source_id=relationship.source_id,
        target_id=relationship.target_id,
        type=relationship.type,  # pyright: ignore[reportArgumentType]
    )


@router.get(
    "/projects/{project_id}/relationships",
    summary="All relationships of a project",
    tags=["relationships"],
    responses=problem_responses(401, 403, 404, 422),
)
async def list_relationships(project_id: ProjectId, access: MemberAccessDep, session: SessionDep) -> RelationshipList:
    relationships = await items_service.list_relationships(session, project_id)
    return RelationshipList(items=[_relationship_out(relationship) for relationship in relationships])


@router.post(
    "/projects/{project_id}/relationships",
    status_code=status.HTTP_201_CREATED,
    summary="Link two items",
    description=(
        "Rules: no self-links (422), both items in the project (404), no duplicates (409; `related-to` is "
        "symmetric), one parent per item (409), no parent cycles (409) and only capability → feature/enabler and "
        "feature → user-story/enabler as `parent-child` (422)."
    ),
    tags=["relationships"],
    responses=problem_responses(401, 403, 404, 409, 422),
)
async def create_relationship(
    project_id: ProjectId,
    body: RelationshipCreate,
    access: MemberAccessDep,
    principal: PrincipalDep,
    session: SessionDep,
    publisher: EventPublisherDep,
) -> RelationshipOut:
    relationship, events = await items_service.add_relationship(
        session, project_id, body.source_id, body.target_id, body.type, actor=principal.email
    )
    out = _relationship_out(relationship)
    await session.commit()
    await _publish(publisher, events)
    return out


@router.delete(
    "/projects/{project_id}/relationships/{relationship_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Remove a relationship",
    tags=["relationships"],
    responses=problem_responses(401, 403, 404, 422),
)
async def delete_relationship(
    project_id: ProjectId,
    relationship_id: RelationshipId,
    access: MemberAccessDep,
    principal: PrincipalDep,
    session: SessionDep,
    publisher: EventPublisherDep,
) -> Response:
    events = await items_service.delete_relationship(session, project_id, relationship_id, actor=principal.email)
    await session.commit()
    await _publish(publisher, events)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
