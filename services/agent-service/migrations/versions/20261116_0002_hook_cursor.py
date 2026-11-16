"""Cursor of the backlog-api internal event stream consumed by the event hooks.

Revision ID: 0002_hook_cursor
Revises: 0001_initial
Create Date: 2026-11-16
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002_hook_cursor"
down_revision: str | Sequence[str] | None = "0001_initial"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "hook_cursor",
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("last_event_id", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("name", name="pk_hook_cursor"),
    )


def downgrade() -> None:
    op.drop_table("hook_cursor")
