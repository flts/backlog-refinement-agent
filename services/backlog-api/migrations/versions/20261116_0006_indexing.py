"""Source chunks (full-text + vector) and item embeddings.

The vector dimension comes from ``BACKLOG_EMBEDDING_DIM`` (default 1536) at the time this migration runs; changing it
later needs a new migration (alter the columns, clear the embeddings) and a reindex.

Revision ID: 0006_indexing
Revises: 0005_items
Create Date: 2026-11-16
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from pgvector.sqlalchemy import Vector
from sqlalchemy.dialects import postgresql

from backlog_api.db.embedding_dim import embedding_dimension

revision: str = "0006_indexing"
down_revision: str | Sequence[str] | None = "0005_items"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    dim = embedding_dimension()
    op.create_table(
        "source_chunks",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("source_id", sa.Uuid(), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("heading_path", sa.Text(), nullable=True),
        sa.Column("page", sa.Integer(), nullable=True),
        sa.Column("char_start", sa.Integer(), nullable=False),
        sa.Column("char_end", sa.Integer(), nullable=False),
        sa.Column(
            "tsv",
            postgresql.TSVECTOR(),
            sa.Computed("to_tsvector('simple', text)", persisted=True),
            nullable=False,
        ),
        sa.Column("embedding", Vector(dim), nullable=True),
        sa.ForeignKeyConstraint(
            ["source_id"], ["sources.id"], name="fk_source_chunks_source_id_sources", ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["project_id"], ["projects.id"], name="fk_source_chunks_project_id_projects", ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_source_chunks"),
        sa.UniqueConstraint("source_id", "ordinal", name="uq_source_chunks_source_id"),
    )
    op.create_index("ix_source_chunks_project_id", "source_chunks", ["project_id"])
    op.create_index("ix_source_chunks_tsv", "source_chunks", ["tsv"], postgresql_using="gin")
    op.create_index(
        "ix_source_chunks_embedding",
        "source_chunks",
        ["embedding"],
        postgresql_using="hnsw",
        postgresql_ops={"embedding": "vector_cosine_ops"},
    )

    op.create_table(
        "item_embeddings",
        sa.Column("item_id", sa.Uuid(), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("embedding", Vector(dim), nullable=False),
        sa.Column("document_hash", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["item_id"], ["items.id"], name="fk_item_embeddings_item_id_items", ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["project_id"], ["projects.id"], name="fk_item_embeddings_project_id_projects", ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("item_id", name="pk_item_embeddings"),
    )
    op.create_index("ix_item_embeddings_project_id", "item_embeddings", ["project_id"])
    op.create_index(
        "ix_item_embeddings_embedding",
        "item_embeddings",
        ["embedding"],
        postgresql_using="hnsw",
        postgresql_ops={"embedding": "vector_cosine_ops"},
    )


def downgrade() -> None:
    op.drop_table("item_embeddings")
    op.drop_table("source_chunks")
