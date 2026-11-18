"""Project guidance overrides (agent principles, type instructions, templates).

Revision ID: 0003_guidance
Revises: 0001_initial
Create Date: 2026-11-16
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0003_guidance"
down_revision: str | Sequence[str] | None = "0001_initial"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "project_guidance",
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("item_type", sa.Text(), server_default="", nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("base_skill_version", sa.Text(), nullable=True),
        sa.Column("version", sa.Integer(), server_default="1", nullable=False),
        sa.Column("updated_by", postgresql.CITEXT(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint(
            "(kind = 'principles' AND item_type = '') OR "
            "(kind IN ('type-instructions', 'template') "
            "AND item_type IN ('capability', 'feature', 'user-story', 'enabler'))",
            name="ck_project_guidance_kind_item_type",
        ),
        sa.ForeignKeyConstraint(
            ["project_id"],
            ["projects.id"],
            name="fk_project_guidance_project_id_projects",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("project_id", "kind", "item_type", name="pk_project_guidance"),
    )


def downgrade() -> None:
    op.drop_table("project_guidance")
