"""Sources, source files and the jobs queue.

Revision ID: 0004_sources
Revises: 0003_guidance
Create Date: 2026-11-16
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0004_sources"
down_revision: str | Sequence[str] | None = "0003_guidance"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "sources",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("mode", sa.Text(), server_default="searchable", nullable=False),
        sa.Column("url", sa.Text(), nullable=True),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("char_count", sa.Integer(), nullable=False),
        sa.Column("page_count", sa.Integer(), nullable=True),
        sa.Column("media_type", sa.Text(), nullable=True),
        sa.Column("index_status", sa.Text(), server_default="pending", nullable=False),
        sa.Column("index_error", sa.Text(), nullable=True),
        sa.Column("version", sa.Integer(), server_default="1", nullable=False),
        sa.Column("added_by", postgresql.CITEXT(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("kind IN ('file', 'url', 'text')", name="ck_sources_kind"),
        sa.CheckConstraint("mode IN ('pinned', 'searchable', 'excluded')", name="ck_sources_mode"),
        sa.CheckConstraint(
            "index_status IN ('pending', 'indexing', 'indexed', 'failed', 'skipped')", name="ck_sources_index_status"
        ),
        sa.ForeignKeyConstraint(
            ["project_id"], ["projects.id"], name="fk_sources_project_id_projects", ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_sources"),
    )
    op.create_index("ix_sources_project_id_created_at", "sources", ["project_id", "created_at"])

    op.create_table(
        "source_files",
        sa.Column("source_id", sa.Uuid(), nullable=False),
        sa.Column("content", sa.LargeBinary(), nullable=False),
        sa.Column("media_type", sa.Text(), nullable=False),
        sa.Column("size", sa.BigInteger(), nullable=False),
        sa.Column("sha256", sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(
            ["source_id"], ["sources.id"], name="fk_source_files_source_id_sources", ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("source_id", name="pk_source_files"),
    )

    op.create_table(
        "jobs",
        sa.Column("id", sa.BigInteger(), sa.Identity(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False),
        sa.Column("status", sa.Text(), server_default="queued", nullable=False),
        sa.Column("attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column("run_after", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("locked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("status IN ('queued', 'running', 'done', 'failed')", name="ck_jobs_status"),
        sa.PrimaryKeyConstraint("id", name="pk_jobs"),
    )
    op.create_index("ix_jobs_claim", "jobs", ["run_after", "id"], postgresql_where=sa.text("status = 'queued'"))


def downgrade() -> None:
    op.drop_index("ix_jobs_claim", table_name="jobs")
    op.drop_table("jobs")
    op.drop_table("source_files")
    op.drop_index("ix_sources_project_id_created_at", table_name="sources")
    op.drop_table("sources")
