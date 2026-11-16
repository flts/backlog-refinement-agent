"""The fixed dimension of stored embeddings (``vector(N)`` columns).

It is read from ``BACKLOG_EMBEDDING_DIM`` (default 1536) when the models are imported and when migration
``0006_indexing`` runs. A database keeps the dimension it was migrated with: changing the setting later requires a new
migration that alters the columns, followed by a reindex.
"""

from __future__ import annotations

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from backlog_api.settings import SERVICE_ROOT

DEFAULT_EMBEDDING_DIM = 1536


class _DimensionSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="BACKLOG_", env_file=SERVICE_ROOT / ".env", env_file_encoding="utf-8", extra="ignore"
    )

    embedding_dim: int = Field(default=DEFAULT_EMBEDDING_DIM, ge=1, le=2000)


def embedding_dimension() -> int:
    return _DimensionSettings().embedding_dim
