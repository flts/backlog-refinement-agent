"""Semantic search of a project's sources and items (command palette) and source reindexing."""

from __future__ import annotations

import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Query, Request, status
from pydantic import Field

from backlog_api import audit, search
from backlog_api.api.deps import MemberAccessDep, ProjectId
from backlog_api.api.schemas import ApiModel
from backlog_api.auth.dependencies import PrincipalDep
from backlog_api.authz import require_member
from backlog_api.db.models import Source
from backlog_api.db.session import SessionDep
from backlog_api.embeddings import EmbeddingClient
from backlog_api.indexing import enqueue_source_indexing
from backlog_api.problems import not_found, problem_responses

router = APIRouter(tags=["search"])


class PassageOut(ApiModel):
    source_id: uuid.UUID
    source_name: str
    chunk_id: uuid.UUID
    ordinal: int
    page: int | None = Field(description="1-based page of a PDF source; null otherwise.")
    heading_path: str | None = Field(description="Markdown heading path, e.g. `Intro > Scope`.")
    text: str
    score: float = Field(description="Reciprocal-rank-fusion score; only meaningful for ordering.")
    citation_id: str = Field(description="Stable citation id `src:<sourceId>#<ordinal>`.")


class ItemHitOut(ApiModel):
    item_id: uuid.UUID
    title: str
    type: str
    status: str
    score: float
    snippet: str | None


class SearchResults(ApiModel):
    kind: Literal["sources", "items"]
    query: str
    semantic: bool = Field(description="Whether vector search contributed (false: full-text only).")
    passages: list[PassageOut] = Field(default_factory=list, description="Set when kind is `sources`.")
    items: list[ItemHitOut] = Field(default_factory=list, description="Set when kind is `items`.")


def _embedder(request: Request) -> EmbeddingClient | None:
    return getattr(request.app.state, "embedder", None)


@router.get(
    "/projects/{project_id}/search",
    summary="Search sources (passages with citations) or items",
    responses=problem_responses(401, 403, 404, 422),
)
async def search_project(
    project_id: ProjectId,
    access: MemberAccessDep,
    session: SessionDep,
    request: Request,
    q: Annotated[str, Query(min_length=1, max_length=500, description="Search text.")],
    kind: Annotated[Literal["sources", "items"], Query(description="What to search.")] = "sources",
    limit: Annotated[int, Query(ge=1, le=50)] = 8,
) -> SearchResults:
    embedder = _embedder(request)
    results = SearchResults(kind=kind, query=q, semantic=embedder is not None)
    if kind == "sources":
        passages = await search.search_sources(session, project_id, q, limit=limit, embedder=embedder)
        results.passages = [
            PassageOut(
                source_id=p.source_id,
                source_name=p.source_name,
                chunk_id=p.chunk_id,
                ordinal=p.ordinal,
                page=p.page,
                heading_path=p.heading_path,
                text=p.text,
                score=p.score,
                citation_id=p.citation_id,
            )
            for p in passages
        ]
    else:
        hits = await search.search_items(session, project_id, q, limit=limit, embedder=embedder)
        results.items = [
            ItemHitOut(item_id=h.item_id, title=h.title, type=h.type, status=h.status, score=h.score, snippet=h.snippet)
            for h in hits
        ]
    return results


@router.post(
    "/projects/{project_id}/sources/{source_id}/reindex",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Queue re-chunking and re-embedding of a source",
    responses=problem_responses(401, 403, 404, 422),
)
async def reindex_source(
    project_id: ProjectId,
    source_id: uuid.UUID,
    principal: PrincipalDep,
    session: SessionDep,
) -> None:
    await require_member(session, project_id, principal)
    source = await session.get(Source, source_id)
    if source is None or source.project_id != project_id:
        raise not_found("The source does not exist in this project.")
    await enqueue_source_indexing(session, source.id, project_id, "reindex")
    audit.record(
        session,
        actor=principal.email,
        action="source.reindex_requested",
        project_id=project_id,
        details={"sourceId": str(source.id)},
    )
    await session.commit()
