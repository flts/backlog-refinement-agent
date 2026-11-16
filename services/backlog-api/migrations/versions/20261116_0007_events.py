"""Project event log (SSE resume window) and presence.

Revision ID: 0007_events
Revises: 0005_items
Create Date: 2026-11-16
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0007_events"
down_revision: str | Sequence[str] | None = "0005_items"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "project_events",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("type", sa.Text(), nullable=False),
        sa.Column("actor", postgresql.CITEXT(), nullable=False),
        sa.Column("data", postgresql.JSONB(), server_default=sa.text("'{}'::jsonb"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_project_events"),
    )
    op.create_index("ix_project_events_project_id_id", "project_events", ["project_id", "id"])
    op.create_index("ix_project_events_created_at", "project_events", ["created_at"])

    op.create_table(
        "presence",
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("email", postgresql.CITEXT(), nullable=False),
        sa.Column("item_id", sa.Uuid(), nullable=True),
        sa.Column("state", sa.Text(), server_default="viewing", nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("state IN ('viewing', 'editing')", name="ck_presence_state"),
        sa.ForeignKeyConstraint(
            ["project_id"], ["projects.id"], name="fk_presence_project_id_projects", ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("project_id", "email", name="pk_presence"),
        prefixes=["UNLOGGED"],
    )
    op.create_index("ix_presence_expires_at", "presence", ["expires_at"])


def downgrade() -> None:
    op.drop_index("ix_presence_expires_at", table_name="presence")
    op.drop_table("presence")
    op.drop_index("ix_project_events_created_at", table_name="project_events")
    op.drop_index("ix_project_events_project_id_id", table_name="project_events")
    op.drop_table("project_events")
