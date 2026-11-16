"""Initial schema: thread snapshots, thread metadata and feedback.

Revision ID: 0001_initial
Revises:
Create Date: 2026-11-16
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0001_initial"
down_revision: str | Sequence[str] | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS citext")

    op.create_table(
        "thread_snapshots",
        sa.Column("scope", sa.Text(), nullable=False),
        sa.Column("thread_id", sa.Text(), nullable=False),
        sa.Column("messages", postgresql.JSONB(), server_default=sa.text("'[]'::jsonb"), nullable=False),
        sa.Column("state", postgresql.JSONB(none_as_null=True), nullable=True),
        sa.Column("interrupt", postgresql.JSONB(none_as_null=True), nullable=True),
        sa.Column("session_state", postgresql.JSONB(none_as_null=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("scope", "thread_id", name="pk_thread_snapshots"),
    )

    op.create_table(
        "threads",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("owner_email", postgresql.CITEXT(), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("item_id", sa.Uuid(), nullable=False),
        sa.Column("title", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), server_default="idle", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("last_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "status IN ('idle', 'running', 'awaiting_input', 'awaiting_review')", name="ck_threads_status"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_threads"),
    )
    op.create_index("ix_threads_owner_email_project_id_item_id", "threads", ["owner_email", "project_id", "item_id"])
    op.create_index("ix_threads_project_id_item_id", "threads", ["project_id", "item_id"])

    op.create_table(
        "feedback",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("thread_id", sa.Text(), nullable=False),
        sa.Column("message_id", sa.Text(), nullable=False),
        sa.Column("owner_email", postgresql.CITEXT(), nullable=False),
        sa.Column("rating", sa.Text(), nullable=False),
        sa.Column("comment", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("rating IN ('up', 'down')", name="ck_feedback_rating"),
        sa.ForeignKeyConstraint(
            ["thread_id"], ["threads.id"], name="fk_feedback_thread_id_threads", ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_feedback"),
        sa.UniqueConstraint("thread_id", "message_id", "owner_email", name="uq_feedback_thread_message_owner"),
    )


def downgrade() -> None:
    op.drop_table("feedback")
    op.drop_table("threads")
    op.drop_table("thread_snapshots")
