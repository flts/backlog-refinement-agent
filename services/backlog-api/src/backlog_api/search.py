"""Retrieval queries over indexed sources and items (REST palette search, MCP source search and similar items).

Source passages use hybrid retrieval: pgvector cosine similarity (when an embedding client is given) and Postgres
full-text (``websearch_to_tsquery``) are combined with Reciprocal Rank Fusion (k = 60). Without embeddings the search
degrades to full-text only. Sources in mode ``excluded`` are never returned.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Sequence
from dataclasses import dataclass

from sqlalchemy import Float, cast, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backlog_api.db.models import SEARCH_CONFIG, Item, ItemEmbedding, Relationship, Source, SourceChunk
from backlog_api.embeddings import EmbeddingClient, EmbeddingError

logger = logging.getLogger(__name__)

RRF_K = 60
CANDIDATES = 40
DEFAULT_SIMILAR_MIN_SCORE = 0.5
DEFAULT_MODES: tuple[str, ...] = ("searchable", "pinned")


@dataclass(frozen=True, slots=True)
class Passage:
    source_id: uuid.UUID
    source_name: str
    chunk_id: uuid.UUID
    ordinal: int
    page: int | None
    heading_path: str | None
    text: str
    score: float
    citation_id: str


@dataclass(frozen=True, slots=True)
class SimilarItem:
    item_id: uuid.UUID
    title: str
    type: str
    status: str
    score: float


@dataclass(frozen=True, slots=True)
class ItemHit:
    item_id: uuid.UUID
    title: str
    type: str
    status: str
    score: float
    snippet: str | None


def citation_id(source_id: uuid.UUID, ordinal: int) -> str:
    """Stable citation identifier of a passage: ``src:<sourceId>#<ordinal>``."""
    return f"src:{source_id}#{ordinal}"


def parse_citation_id(value: str) -> tuple[uuid.UUID, int] | None:
    if not value.startswith("src:") or "#" not in value:
        return None
    raw_source, _, raw_ordinal = value[4:].partition("#")
    try:
        return uuid.UUID(raw_source), int(raw_ordinal)
    except ValueError:
        return None


def _rrf(rankings: Sequence[Sequence[uuid.UUID]]) -> dict[uuid.UUID, float]:
    scores: dict[uuid.UUID, float] = {}
    for ranking in rankings:
        for rank, key in enumerate(ranking, start=1):
            scores[key] = scores.get(key, 0.0) + 1.0 / (RRF_K + rank)
    return scores


async def _embed_query(embedder: EmbeddingClient | None, text: str) -> list[float] | None:
    if embedder is None:
        return None
    try:
        return await embedder.embed_one(text)
    except EmbeddingError:
        logger.warning("Query embedding failed; falling back to full-text search")
        return None


# --- source passages -----------------------------------------------------------------------------------------------


async def search_sources(
    session: AsyncSession,
    project_id: uuid.UUID,
    query: str,
    *,
    limit: int = 8,
    modes: Sequence[str] = DEFAULT_MODES,
    embedder: EmbeddingClient | None = None,
) -> list[Passage]:
    """The best passages of the project's sources for ``query`` (hybrid vector + full-text, RRF-ranked)."""
    query = query.strip()
    modes = [mode for mode in modes if mode != "excluded"]
    if not query or limit < 1 or not modes:
        return []
    base = (
        select(SourceChunk.id)
        .join(Source, Source.id == SourceChunk.source_id)
        .where(SourceChunk.project_id == project_id, Source.mode.in_(modes))
    )
    rankings: list[list[uuid.UUID]] = []

    tsquery = func.websearch_to_tsquery(SEARCH_CONFIG, query)
    rank = func.ts_rank_cd(SourceChunk.tsv, tsquery)
    text_ids = (
        await session.scalars(
            base.where(SourceChunk.tsv.op("@@")(tsquery)).order_by(rank.desc(), SourceChunk.id).limit(CANDIDATES)
        )
    ).all()
    rankings.append(list(text_ids))
    if not text_ids:
        # websearch_to_tsquery ANDs the terms; fall back to matching any term.
        terms = [term for term in query.replace('"', " ").split() if term]
        if len(terms) > 1:
            any_query = func.to_tsquery(SEARCH_CONFIG, " | ".join(_tsquery_literal(term) for term in terms[:20]))
            loose = (
                await session.scalars(
                    base.where(SourceChunk.tsv.op("@@")(any_query))
                    .order_by(func.ts_rank_cd(SourceChunk.tsv, any_query).desc(), SourceChunk.id)
                    .limit(CANDIDATES)
                )
            ).all()
            rankings[0] = list(loose)

    vector = await _embed_query(embedder, query)
    if vector is not None:
        distance = SourceChunk.embedding.cosine_distance(vector)
        vector_ids = (
            await session.scalars(
                base.where(SourceChunk.embedding.is_not(None)).order_by(distance, SourceChunk.id).limit(CANDIDATES)
            )
        ).all()
        rankings.append(list(vector_ids))

    scores = _rrf(rankings)
    if not scores:
        return []
    top = sorted(scores, key=lambda key: (-scores[key], str(key)))[:limit]
    rows = (
        await session.execute(
            select(SourceChunk, Source.name)
            .join(Source, Source.id == SourceChunk.source_id)
            .where(SourceChunk.id.in_(top))
        )
    ).all()
    by_id = {chunk.id: (chunk, name) for chunk, name in rows}
    passages: list[Passage] = []
    for chunk_id in top:
        if chunk_id not in by_id:
            continue
        chunk, name = by_id[chunk_id]
        passages.append(
            Passage(
                source_id=chunk.source_id,
                source_name=name,
                chunk_id=chunk.id,
                ordinal=chunk.ordinal,
                page=chunk.page,
                heading_path=chunk.heading_path,
                text=chunk.text,
                score=scores[chunk_id],
                citation_id=citation_id(chunk.source_id, chunk.ordinal),
            )
        )
    return passages


def _tsquery_literal(term: str) -> str:
    cleaned = "".join(char for char in term if char.isalnum() or char in "_-")
    return f"'{cleaned}'" if cleaned else "''"


# --- items ---------------------------------------------------------------------------------------------------------


async def _related_ids(session: AsyncSession, item_id: uuid.UUID) -> set[uuid.UUID]:
    rows = await session.execute(
        select(Relationship.source_id, Relationship.target_id).where(
            Relationship.type == "parent-child",
            or_(Relationship.source_id == item_id, Relationship.target_id == item_id),
        )
    )
    return {other for pair in rows.all() for other in pair if other != item_id}


async def find_similar_items(
    session: AsyncSession,
    project_id: uuid.UUID,
    item_id: uuid.UUID | None = None,
    *,
    text: str | None = None,
    embedder: EmbeddingClient | None = None,
    limit: int = 5,
    min_score: float = DEFAULT_SIMILAR_MIN_SCORE,
    exclude_related: bool = False,
) -> list[SimilarItem]:
    """Items of the project most similar (cosine, ``score`` in [-1, 1]) to an item or to free ``text``.

    ``item_id`` uses the item's stored embedding; ``text`` is embedded with ``embedder`` (returns ``[]`` when no
    embeddings are available). The item itself is always excluded; ``exclude_related`` also drops its parent/children.
    """
    if limit < 1 or (item_id is None) == (text is None):
        return []
    excluded: set[uuid.UUID] = set()
    if item_id is not None:
        excluded.add(item_id)
        if exclude_related:
            excluded |= await _related_ids(session, item_id)
        vector = await session.scalar(
            select(ItemEmbedding.embedding).where(
                ItemEmbedding.item_id == item_id, ItemEmbedding.project_id == project_id
            )
        )
    else:
        vector = await _embed_query(embedder, (text or "").strip()) if (text or "").strip() else None
    if vector is None:
        return []
    similarity = cast(1 - ItemEmbedding.embedding.cosine_distance(vector), Float)
    query = (
        select(Item.id, Item.title, Item.type, Item.status, similarity.label("score"))
        .join(ItemEmbedding, ItemEmbedding.item_id == Item.id)
        .where(Item.project_id == project_id, similarity >= min_score)
        .order_by(ItemEmbedding.embedding.cosine_distance(vector), Item.id)
        .limit(limit + len(excluded))
    )
    if excluded:
        query = query.where(Item.id.not_in(excluded))
    rows = (await session.execute(query)).all()
    return [SimilarItem(row.id, row.title, row.type, row.status, float(row.score)) for row in rows[:limit]]


async def search_items(
    session: AsyncSession,
    project_id: uuid.UUID,
    query: str,
    *,
    limit: int = 8,
    embedder: EmbeddingClient | None = None,
) -> list[ItemHit]:
    """Hybrid search over item titles and documents (item embeddings + full-text), RRF-ranked."""
    query = query.strip()
    if not query or limit < 1:
        return []
    document = func.to_tsvector(SEARCH_CONFIG, Item.title + " " + Item.document)
    title_boost = func.to_tsvector(SEARCH_CONFIG, Item.title)
    tsquery = func.websearch_to_tsquery(SEARCH_CONFIG, query)
    rank = func.ts_rank_cd(document, tsquery) + 2 * func.ts_rank_cd(title_boost, tsquery)
    text_ids = (
        await session.scalars(
            select(Item.id)
            .where(Item.project_id == project_id, document.op("@@")(tsquery))
            .order_by(rank.desc(), Item.id)
            .limit(CANDIDATES)
        )
    ).all()
    rankings: list[list[uuid.UUID]] = [list(text_ids)]
    vector = await _embed_query(embedder, query)
    if vector is not None:
        vector_ids = (
            await session.scalars(
                select(ItemEmbedding.item_id)
                .where(ItemEmbedding.project_id == project_id)
                .order_by(ItemEmbedding.embedding.cosine_distance(vector), ItemEmbedding.item_id)
                .limit(CANDIDATES)
            )
        ).all()
        rankings.append(list(vector_ids))
    scores = _rrf(rankings)
    if not scores:
        return []
    top = sorted(scores, key=lambda key: (-scores[key], str(key)))[:limit]
    headline = func.ts_headline(
        SEARCH_CONFIG, func.left(Item.document, 4000), tsquery, "MaxWords=30, MinWords=10, MaxFragments=1"
    )
    rows = (
        await session.execute(
            select(Item.id, Item.title, Item.type, Item.status, headline.label("snippet")).where(Item.id.in_(top))
        )
    ).all()
    by_id = {row.id: row for row in rows}
    return [
        ItemHit(row.id, row.title, row.type, row.status, scores[key], row.snippet or None)
        for key in top
        if (row := by_id.get(key))
    ]


__all__ = [
    "DEFAULT_MODES",
    "ItemHit",
    "Passage",
    "SimilarItem",
    "citation_id",
    "find_similar_items",
    "parse_citation_id",
    "search_items",
    "search_sources",
]
