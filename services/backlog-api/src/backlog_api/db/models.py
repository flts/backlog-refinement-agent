"""SQLAlchemy ORM models for backlogdb. Schema changes go through alembic migrations in ``migrations/``."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Computed,
    DateTime,
    ForeignKey,
    Identity,
    Index,
    Integer,
    LargeBinary,
    MetaData,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy import text as sql_text
from sqlalchemy.dialects.postgresql import CITEXT, JSONB, TSVECTOR, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from backlog_api.db.embedding_dim import embedding_dimension

NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}

ROLE_OWNER = "owner"
ROLE_CONTRIBUTOR = "contributor"
ROLES = (ROLE_OWNER, ROLE_CONTRIBUTOR)


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)


class User(Base):
    """Display-name directory, upserted from token claims. Never used for access decisions."""

    __tablename__ = "users"

    email: Mapped[str] = mapped_column(CITEXT, primary_key=True)
    sub: Mapped[str | None] = mapped_column(Text)
    name: Mapped[str | None] = mapped_column(Text)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(Text)
    version: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    created_by: Mapped[str] = mapped_column(CITEXT)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    members: Mapped[list[ProjectMember]] = relationship(
        back_populates="project", cascade="all, delete-orphan", passive_deletes=True
    )


class ProjectMember(Base):
    __tablename__ = "project_members"
    __table_args__ = (
        CheckConstraint("role IN ('owner', 'contributor')", name="role"),
        Index("ix_project_members_email", "email"),
    )

    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True
    )
    email: Mapped[str] = mapped_column(CITEXT, primary_key=True)
    role: Mapped[str] = mapped_column(Text)
    added_by: Mapped[str] = mapped_column(CITEXT)
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    project: Mapped[Project] = relationship(back_populates="members")


class AuditEvent(Base):
    __tablename__ = "audit_events"
    __table_args__ = (Index("ix_audit_events_project_id_at", "project_id", "at"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="SET NULL"), nullable=True
    )
    actor: Mapped[str] = mapped_column(CITEXT)
    action: Mapped[str] = mapped_column(Text)
    details: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, server_default="{}")
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


# --- guidance ---

GUIDANCE_PRINCIPLES = "principles"
GUIDANCE_TYPE_INSTRUCTIONS = "type-instructions"
GUIDANCE_TEMPLATE = "template"
GUIDANCE_KINDS = (GUIDANCE_PRINCIPLES, GUIDANCE_TYPE_INSTRUCTIONS, GUIDANCE_TEMPLATE)
GUIDANCE_ITEM_TYPES = ("capability", "feature", "user-story", "enabler")


class ProjectGuidance(Base):
    """A project's override of one default guidance text (agent principles, type instructions or a template).

    Principles use ``item_type = ''``; the other kinds are keyed by backlog item type. A missing row means the skill
    default applies. ``version`` counts changes to the row and is the ETag of the override.
    """

    __tablename__ = "project_guidance"
    __table_args__ = (
        CheckConstraint(
            "(kind = 'principles' AND item_type = '') OR "
            "(kind IN ('type-instructions', 'template') "
            "AND item_type IN ('capability', 'feature', 'user-story', 'enabler'))",
            name="kind_item_type",
        ),
    )

    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True
    )
    kind: Mapped[str] = mapped_column(Text, primary_key=True)
    item_type: Mapped[str] = mapped_column(Text, primary_key=True, default="", server_default="")
    content: Mapped[str] = mapped_column(Text)
    base_skill_version: Mapped[str | None] = mapped_column(Text)
    version: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    updated_by: Mapped[str] = mapped_column(CITEXT)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


# --- sources ---

SOURCE_KINDS = ("file", "url", "text")
SOURCE_MODES = ("pinned", "searchable", "excluded")
INDEX_STATUSES = ("pending", "indexing", "indexed", "failed", "skipped")
JOB_STATUSES = ("queued", "running", "done", "failed")


class Source(Base):
    """A reference document of a project. ``text`` is the extracted text (pages separated by a form feed)."""

    __tablename__ = "sources"
    __table_args__ = (
        CheckConstraint("kind IN ('file', 'url', 'text')", name="kind"),
        CheckConstraint("mode IN ('pinned', 'searchable', 'excluded')", name="mode"),
        CheckConstraint("index_status IN ('pending', 'indexing', 'indexed', 'failed', 'skipped')", name="index_status"),
        Index("ix_sources_project_id_created_at", "project_id", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(Text)
    kind: Mapped[str] = mapped_column(Text)
    mode: Mapped[str] = mapped_column(Text, default="searchable", server_default="searchable")
    url: Mapped[str | None] = mapped_column(Text)
    text: Mapped[str] = mapped_column(Text)
    char_count: Mapped[int] = mapped_column(Integer)
    page_count: Mapped[int | None] = mapped_column(Integer)
    media_type: Mapped[str | None] = mapped_column(Text)
    index_status: Mapped[str] = mapped_column(Text, default="pending", server_default="pending")
    index_error: Mapped[str | None] = mapped_column(Text)
    version: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    added_by: Mapped[str] = mapped_column(CITEXT)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class SourceFile(Base):
    """The original uploaded bytes of a file source (``PostgresFileStore``)."""

    __tablename__ = "source_files"

    source_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("sources.id", ondelete="CASCADE"), primary_key=True
    )
    content: Mapped[bytes] = mapped_column(LargeBinary)
    media_type: Mapped[str] = mapped_column(Text)
    size: Mapped[int] = mapped_column(BigInteger)
    sha256: Mapped[str] = mapped_column(Text)


class Job(Base):
    """Background job queue, claimed with ``FOR UPDATE SKIP LOCKED`` (see :mod:`backlog_api.jobs`)."""

    __tablename__ = "jobs"
    __table_args__ = (
        CheckConstraint("status IN ('queued', 'running', 'done', 'failed')", name="status"),
        Index("ix_jobs_claim", "run_after", "id", postgresql_where=sql_text("status = 'queued'")),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    kind: Mapped[str] = mapped_column(Text)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, server_default="{}")
    status: Mapped[str] = mapped_column(Text, default="queued", server_default="queued")
    attempts: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    run_after: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    locked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


# --- items ---

ITEM_TYPES = ("capability", "feature", "user-story", "enabler")
ITEM_STATUSES = ("draft", "refining", "ready", "ready-with-open-questions", "complete")
REVISION_ORIGINS = ("manual", "agent", "restore")
RELATIONSHIP_TYPES = ("parent-child", "supports", "depends-on", "related-to")


def _in_list(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(value) for value in values)})"


class Item(Base):
    """A backlog item. The parent is the (single) ``parent-child`` relationship that targets it."""

    __tablename__ = "items"
    __table_args__ = (
        CheckConstraint(_in_list("type", ITEM_TYPES), name="type"),
        CheckConstraint(_in_list("status", ITEM_STATUSES), name="status"),
        Index("ix_items_project_id_created_at", "project_id", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"))
    type: Mapped[str] = mapped_column(Text)
    title: Mapped[str] = mapped_column(Text)
    document: Mapped[str] = mapped_column(Text, default="", server_default="")
    document_hash: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, default="draft", server_default="draft")
    version: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    quality: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    quality_assessed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    quality_document_hash: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[str] = mapped_column(CITEXT)
    updated_by: Mapped[str] = mapped_column(CITEXT)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ItemRevision(Base):
    """Snapshot of an item's title and document as of ``version`` (written on every title/document change)."""

    __tablename__ = "item_revisions"
    __table_args__ = (
        CheckConstraint(_in_list("origin", REVISION_ORIGINS), name="origin"),
        UniqueConstraint("item_id", "version"),
        Index("ix_item_revisions_item_id_created_at", "item_id", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    item_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("items.id", ondelete="CASCADE"))
    version: Mapped[int] = mapped_column(Integer)
    title: Mapped[str] = mapped_column(Text)
    document: Mapped[str] = mapped_column(Text)
    origin: Mapped[str] = mapped_column(Text)
    label: Mapped[str | None] = mapped_column(Text, nullable=True)
    actor: Mapped[str] = mapped_column(CITEXT)
    run_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Relationship(Base):
    __tablename__ = "relationships"
    __table_args__ = (
        CheckConstraint(_in_list("type", RELATIONSHIP_TYPES), name="type"),
        CheckConstraint("source_id <> target_id", name="no_self_link"),
        UniqueConstraint("source_id", "target_id", "type"),
        Index("ix_relationships_project_id", "project_id"),
        Index("ix_relationships_target_id", "target_id"),
        Index(
            "uq_relationships_single_parent",
            "target_id",
            unique=True,
            postgresql_where=sql_text("type = 'parent-child'"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"))
    source_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("items.id", ondelete="CASCADE"))
    target_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("items.id", ondelete="CASCADE"))
    type: Mapped[str] = mapped_column(Text)


# --- indexing ---

SEARCH_CONFIG = "simple"
EMBEDDING_DIM = embedding_dimension()


class SourceChunk(Base):
    """A heading/page-aware slice of a source's text for retrieval (full-text always, vector when embedded)."""

    __tablename__ = "source_chunks"
    __table_args__ = (
        UniqueConstraint("source_id", "ordinal"),
        Index("ix_source_chunks_project_id", "project_id"),
        Index("ix_source_chunks_tsv", "tsv", postgresql_using="gin"),
        Index(
            "ix_source_chunks_embedding",
            "embedding",
            postgresql_using="hnsw",
            postgresql_ops={"embedding": "vector_cosine_ops"},
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    source_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("sources.id", ondelete="CASCADE"))
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"))
    ordinal: Mapped[int] = mapped_column(Integer)
    text: Mapped[str] = mapped_column(Text)
    heading_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    page: Mapped[int | None] = mapped_column(Integer, nullable=True)
    char_start: Mapped[int] = mapped_column(Integer)
    char_end: Mapped[int] = mapped_column(Integer)
    tsv: Mapped[Any] = mapped_column(
        TSVECTOR, Computed(f"to_tsvector('{SEARCH_CONFIG}', text)", persisted=True), nullable=False
    )
    embedding: Mapped[Any] = mapped_column(Vector(EMBEDDING_DIM), nullable=True)


class ItemEmbedding(Base):
    """The embedding of an item's title and document as of ``document_hash``."""

    __tablename__ = "item_embeddings"
    __table_args__ = (
        Index("ix_item_embeddings_project_id", "project_id"),
        Index(
            "ix_item_embeddings_embedding",
            "embedding",
            postgresql_using="hnsw",
            postgresql_ops={"embedding": "vector_cosine_ops"},
        ),
    )

    item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("items.id", ondelete="CASCADE"), primary_key=True
    )
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"))
    embedding: Mapped[Any] = mapped_column(Vector(EMBEDDING_DIM))
    document_hash: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
