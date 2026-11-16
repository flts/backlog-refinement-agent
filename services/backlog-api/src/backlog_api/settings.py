"""Runtime configuration from environment variables (prefix ``BACKLOG_``) plus Aspire-injected references.

Values are read from the process environment and, for local development, from ``services/backlog-api/.env``.
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import AliasChoices, Field, PrivateAttr, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.engine import URL

from backlog_api.db.connection_strings import to_async_database_url

Environment = Literal["development", "test", "production"]
AuthMode = Literal["jwt", "dev"]

SERVICE_ROOT = Path(__file__).resolve().parents[2]
API_PREFIX = "/api/backlog"

MiB = 1024 * 1024


class Settings(BaseSettings):
    """backlog-api settings.

    Database: ``BACKLOG_DATABASE_URL`` wins, then Aspire's ``ConnectionStrings__backlogdb`` (ADO.NET key-value string or
    URI), then ``BACKLOGDB_URI``. Every form is converted to a ``postgresql+asyncpg`` URL.

    OIDC issuer: ``BACKLOG_OIDC_ISSUER`` wins; otherwise it is derived from a Keycloak base URL
    (``BACKLOG_KEYCLOAK_URL`` or the Aspire reference ``services__keycloak__http(s)__0`` / ``KEYCLOAK_HTTP(S)``) as
    ``<url>/realms/<BACKLOG_OIDC_REALM>``.
    """

    model_config = SettingsConfigDict(
        env_prefix="BACKLOG_",
        env_file=SERVICE_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
        validate_by_name=True,
        validate_by_alias=True,
    )

    env: Environment = "production"
    log_level: str = "INFO"

    database_url: str | None = Field(
        default=None,
        validation_alias=AliasChoices("BACKLOG_DATABASE_URL", "ConnectionStrings__backlogdb", "BACKLOGDB_URI"),
        repr=False,
        description="Database URL or Aspire connection string.",
    )
    auto_migrate: bool | None = Field(
        default=None, description="Run alembic migrations on startup; defaults to true in development."
    )
    alembic_ini: Path = SERVICE_ROOT / "alembic.ini"
    db_pool_size: int = Field(default=10, ge=1)
    db_max_overflow: int = Field(default=10, ge=0)

    auth_mode: AuthMode = "jwt"
    oidc_issuer: str | None = None
    oidc_realm: str = "backlog"
    keycloak_url: str | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "BACKLOG_KEYCLOAK_URL",
            "services__keycloak__https__0",
            "services__keycloak__http__0",
            "KEYCLOAK_HTTPS",
            "KEYCLOAK_HTTP",
        ),
    )
    oidc_audience: str = "backlog-api"
    oidc_jwks_url: str | None = None
    oidc_leeway_seconds: int = Field(default=60, ge=0, le=300)
    oidc_http_timeout_seconds: float = Field(default=5.0, gt=0)

    max_body_bytes: int = Field(default=1 * MiB, ge=1024)
    revisions_keep: int = Field(default=50, ge=1, description="Item revisions kept per item (oldest are pruned).")
    user_directory_refresh_seconds: int = Field(default=300, ge=0)

    skills_dir: Path | None = Field(
        default=None,
        description="Directory with the default guidance skills (BACKLOG_SKILLS_DIR); default: repo skills/",
    )
    guidance_max_chars: int = Field(
        default=50_000, ge=1_000, description="Maximum length of one guidance override in characters."
    )
    source_max_bytes: int = Field(default=10 * MiB, ge=1024, description="Maximum size of an uploaded source file.")
    source_max_pdf_pages: int = Field(default=200, ge=1, description="Maximum number of pages of a PDF source.")
    source_max_text_chars: int = Field(default=1_000_000, ge=1000, description="Maximum extracted text per source.")
    source_pinned_budget_chars: int = Field(
        default=100_000, ge=1, description="Maximum total characters of pinned sources per project."
    )
    url_fetch_allow_http: bool = Field(
        default=False, description="Also allow plain http:// source URLs. Only honoured when BACKLOG_ENV=development."
    )
    url_fetch_timeout_seconds: float = Field(default=10.0, gt=0, description="Total time budget of a URL fetch.")
    url_fetch_max_bytes: int = Field(default=2 * MiB, ge=1024, description="Maximum response size of a URL fetch.")
    url_fetch_max_redirects: int = Field(default=3, ge=0, le=10, description="Maximum redirects followed per fetch.")

    # --- indexing ---
    worker_enabled: bool = Field(
        default=True, description="Run the indexing worker inside the API process (BACKLOG_WORKER_ENABLED)."
    )
    worker_poll_seconds: float = Field(default=2.0, gt=0, description="Idle poll interval of the job worker.")
    worker_batch_size: int = Field(default=5, ge=1, description="Jobs claimed per worker poll.")
    job_max_attempts: int = Field(default=5, ge=1, description="Attempts of a job before it is marked failed.")
    job_retry_backoff_seconds: float = Field(
        default=5.0, ge=0, description="Base of the exponential retry backoff of failed jobs."
    )
    item_index_debounce_seconds: float = Field(
        default=10.0, ge=0, description="Delay before a changed item is (re-)embedded; edits within it are coalesced."
    )
    llm_base_url: str | None = Field(
        default=None, description="OpenAI-compatible gateway base URL (BACKLOG_LLM_BASE_URL); fallback for embeddings."
    )
    llm_api_key: SecretStr | None = Field(default=None, description="Gateway API key (BACKLOG_LLM_API_KEY).")
    embedding_base_url: str | None = Field(
        default=None, description="Embedding endpoint base URL; falls back to BACKLOG_LLM_BASE_URL."
    )
    embedding_api_key: SecretStr | None = Field(
        default=None, description="Embedding API key; falls back to BACKLOG_LLM_API_KEY."
    )
    embedding_model: str = Field(default="text-embedding", description="Embedding model name sent to the gateway.")
    embedding_dim: int = Field(
        default=1536,
        ge=1,
        le=2000,
        description=(
            "Dimension of the stored vectors. Fixed in the database column when migration 0006 runs; changing it "
            "needs a new migration and a reindex."
        ),
    )
    embedding_send_dimensions: bool = Field(
        default=False, description="Send `dimensions` in embedding requests (for models that support truncation)."
    )
    embedding_batch_size: int = Field(default=32, ge=1, le=2048, description="Texts per embedding request.")
    embedding_timeout_seconds: float = Field(default=30.0, gt=0)
    embedding_max_retries: int = Field(default=2, ge=0, le=10, description="Retries of one embedding request.")
    embedding_retry_backoff_seconds: float = Field(default=0.5, ge=0)
    chunk_target_chars: int = Field(
        default=3200, ge=200, description="Target characters per source chunk (~800 tokens)."
    )
    chunk_overlap_ratio: float = Field(default=0.15, ge=0, lt=0.5, description="Overlap between consecutive chunks.")
    item_embedding_max_chars: int = Field(default=12_000, ge=200, description="Document characters embedded per item.")

    # --- mcp ---
    mcp_max_output_chars: int = Field(
        default=120_000,
        ge=1_000,
        description="Maximum size (JSON characters) of one MCP tool result; longer texts are truncated and marked.",
    )
    mcp_similar_min_score: float = Field(
        default=0.5, ge=-1, le=1, description="Minimum cosine similarity of items returned by find_similar_items."
    )

    _database_url: URL | None = PrivateAttr(default=None)

    @model_validator(mode="after")
    def _check_auth_mode(self) -> Settings:
        if self.auth_mode == "dev" and self.env != "development":
            raise ValueError(
                "BACKLOG_AUTH_MODE=dev trusts the X-Dev-User-Email header and is only allowed when "
                "BACKLOG_ENV=development."
            )
        return self

    @property
    def async_database_url(self) -> URL | None:
        """The ``postgresql+asyncpg`` URL, or ``None`` when no database is configured."""
        if self._database_url is None and self.database_url:
            self._database_url = to_async_database_url(self.database_url)
        return self._database_url

    @property
    def fetch_allows_http(self) -> bool:
        return self.url_fetch_allow_http and self.env == "development"

    @property
    def should_auto_migrate(self) -> bool:
        if self.auto_migrate is not None:
            return self.auto_migrate
        return self.env == "development"

    @property
    def effective_embedding_base_url(self) -> str | None:
        return (self.embedding_base_url or self.llm_base_url or "").strip().rstrip("/") or None

    @property
    def effective_embedding_api_key(self) -> str | None:
        key = self.embedding_api_key or self.llm_api_key
        return key.get_secret_value() if key else None

    @property
    def issuer(self) -> str | None:
        if self.oidc_issuer:
            return self.oidc_issuer.rstrip("/")
        if self.keycloak_url:
            return f"{self.keycloak_url.rstrip('/')}/realms/{self.oidc_realm}"
        return None

    def require_runtime_config(self) -> URL:
        """Fail fast at startup when required configuration is missing; returns the database URL."""
        problems: list[str] = []
        url = self.async_database_url
        if url is None:
            problems.append("a database (BACKLOG_DATABASE_URL or ConnectionStrings__backlogdb)")
        if self.auth_mode == "jwt" and not self.issuer:
            problems.append("an OIDC issuer (BACKLOG_OIDC_ISSUER or an Aspire Keycloak reference)")
        if problems or url is None:
            raise RuntimeError("backlog-api is missing configuration: " + "; ".join(problems) + ".")
        return url
