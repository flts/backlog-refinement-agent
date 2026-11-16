"""SQLAlchemy ORM models for backlogdb. Schema changes go through alembic migrations in ``migrations/``."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    MetaData,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import CITEXT, JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

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
            postgresql_where=text("type = 'parent-child'"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"))
    source_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("items.id", ondelete="CASCADE"))
    target_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("items.id", ondelete="CASCADE"))
    type: Mapped[str] = mapped_column(Text)
