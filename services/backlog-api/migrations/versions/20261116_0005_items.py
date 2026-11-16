"""Items, item revisions and relationships.

Revision ID: 0005_items
Revises: 0004_sources
Create Date: 2026-11-16
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0005_items"
down_revision: str | Sequence[str] | None = "0004_sources"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "items",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("type", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("document", sa.Text(), server_default="", nullable=False),
        sa.Column("document_hash", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), server_default="draft", nullable=False),
        sa.Column("version", sa.Integer(), server_default="1", nullable=False),
        sa.Column("quality", postgresql.JSONB(), nullable=True),
        sa.Column("quality_assessed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("quality_document_hash", sa.Text(), nullable=True),
        sa.Column("created_by", postgresql.CITEXT(), nullable=False),
        sa.Column("updated_by", postgresql.CITEXT(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("type IN ('capability', 'feature', 'user-story', 'enabler')", name="ck_items_type"),
        sa.CheckConstraint(
            "status IN ('draft', 'refining', 'ready', 'ready-with-open-questions', 'complete')",
            name="ck_items_status",
        ),
        sa.ForeignKeyConstraint(
            ["project_id"], ["projects.id"], name="fk_items_project_id_projects", ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_items"),
    )
    op.create_index("ix_items_project_id_created_at", "items", ["project_id", "created_at"])

    op.create_table(
        "item_revisions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("item_id", sa.Uuid(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("document", sa.Text(), nullable=False),
        sa.Column("origin", sa.Text(), nullable=False),
        sa.Column("label", sa.Text(), nullable=True),
        sa.Column("actor", postgresql.CITEXT(), nullable=False),
        sa.Column("run_id", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("origin IN ('manual', 'agent', 'restore')", name="ck_item_revisions_origin"),
        sa.ForeignKeyConstraint(["item_id"], ["items.id"], name="fk_item_revisions_item_id_items", ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name="pk_item_revisions"),
        sa.UniqueConstraint("item_id", "version", name="uq_item_revisions_item_id"),
    )
    op.create_index("ix_item_revisions_item_id_created_at", "item_revisions", ["item_id", "created_at"])

    op.create_table(
        "relationships",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("source_id", sa.Uuid(), nullable=False),
        sa.Column("target_id", sa.Uuid(), nullable=False),
        sa.Column("type", sa.Text(), nullable=False),
        sa.CheckConstraint(
            "type IN ('parent-child', 'supports', 'depends-on', 'related-to')", name="ck_relationships_type"
        ),
        sa.CheckConstraint("source_id <> target_id", name="ck_relationships_no_self_link"),
        sa.ForeignKeyConstraint(
            ["project_id"], ["projects.id"], name="fk_relationships_project_id_projects", ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["source_id"], ["items.id"], name="fk_relationships_source_id_items", ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["target_id"], ["items.id"], name="fk_relationships_target_id_items", ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_relationships"),
        sa.UniqueConstraint("source_id", "target_id", "type", name="uq_relationships_source_id"),
    )
    op.create_index("ix_relationships_project_id", "relationships", ["project_id"])
    op.create_index("ix_relationships_target_id", "relationships", ["target_id"])
    op.create_index(
        "uq_relationships_single_parent",
        "relationships",
        ["target_id"],
        unique=True,
        postgresql_where=sa.text("type = 'parent-child'"),
    )


def downgrade() -> None:
    op.drop_index("uq_relationships_single_parent", table_name="relationships")
    op.drop_index("ix_relationships_target_id", table_name="relationships")
    op.drop_index("ix_relationships_project_id", table_name="relationships")
    op.drop_table("relationships")
    op.drop_index("ix_item_revisions_item_id_created_at", table_name="item_revisions")
    op.drop_table("item_revisions")
    op.drop_index("ix_items_project_id_created_at", table_name="items")
    op.drop_table("items")
