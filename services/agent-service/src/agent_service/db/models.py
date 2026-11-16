"""SQLAlchemy ORM models for agentdb. Schema changes go through alembic migrations in ``migrations/``."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, MetaData, Text, UniqueConstraint, func, text
from sqlalchemy.dialects.postgresql import CITEXT, JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}

THREAD_IDLE = "idle"
THREAD_RUNNING = "running"
THREAD_AWAITING_INPUT = "awaiting_input"
THREAD_AWAITING_REVIEW = "awaiting_review"
THREAD_STATUSES = (THREAD_IDLE, THREAD_RUNNING, THREAD_AWAITING_INPUT, THREAD_AWAITING_REVIEW)

RATING_UP = "up"
RATING_DOWN = "down"
RATINGS = (RATING_UP, RATING_DOWN)


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)


class ThreadSnapshot(Base):
    """Latest AG-UI thread snapshot, keyed by the MAF snapshot scope (``user:<email>``) and the thread id."""

    __tablename__ = "thread_snapshots"

    scope: Mapped[str] = mapped_column(Text, primary_key=True)
    thread_id: Mapped[str] = mapped_column(Text, primary_key=True)
    messages: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, server_default=text("'[]'::jsonb"))
    state: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True), nullable=True)
    interrupt: Mapped[list[dict[str, Any]] | None] = mapped_column(JSONB(none_as_null=True), nullable=True)
    session_state: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Thread(Base):
    """Private thread metadata. ``id`` is the AG-UI ``threadId``; ``owner_email`` is the normalized verified email."""

    __tablename__ = "threads"
    __table_args__ = (
        CheckConstraint("status IN ('idle', 'running', 'awaiting_input', 'awaiting_review')", name="status"),
        Index("ix_threads_owner_email_project_id_item_id", "owner_email", "project_id", "item_id"),
        Index("ix_threads_project_id_item_id", "project_id", "item_id"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    owner_email: Mapped[str] = mapped_column(CITEXT)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    item_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    title: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(Text, default=THREAD_IDLE, server_default=THREAD_IDLE)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Feedback(Base):
    """Thumbs up/down on an assistant message, one per (thread, message, user)."""

    __tablename__ = "feedback"
    __table_args__ = (
        CheckConstraint("rating IN ('up', 'down')", name="rating"),
        UniqueConstraint("thread_id", "message_id", "owner_email", name="uq_feedback_thread_message_owner"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    thread_id: Mapped[str] = mapped_column(Text, ForeignKey("threads.id", ondelete="CASCADE"))
    message_id: Mapped[str] = mapped_column(Text)
    owner_email: Mapped[str] = mapped_column(CITEXT)
    rating: Mapped[str] = mapped_column(Text)
    comment: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
