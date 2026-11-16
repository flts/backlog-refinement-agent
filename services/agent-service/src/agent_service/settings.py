"""Runtime configuration from environment variables (prefix ``AGENT_``) plus Aspire-injected references.

Values are read from the process environment and, for local development, from ``services/agent-service/.env``.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated, Literal

from pydantic import AliasChoices, Field, PrivateAttr, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict
from sqlalchemy.engine import URL

from agent_service.db.connection_strings import to_async_database_url

Environment = Literal["development", "test", "production"]
AuthMode = Literal["jwt", "dev"]
LlmApi = Literal["chat", "responses"]

SERVICE_ROOT = Path(__file__).resolve().parents[2]
API_PREFIX = "/api/agent"
AGENTS_PATH_PREFIX = f"{API_PREFIX}/agents/"

MiB = 1024 * 1024


class Settings(BaseSettings):
    """agent-service settings.

    Database: ``AGENT_DATABASE_URL`` wins, then Aspire's ``ConnectionStrings__agentdb`` (ADO.NET key-value string or
    URI), then ``AGENTDB_URI``. Every form is converted to a ``postgresql+asyncpg`` URL.

    OIDC issuer: ``AGENT_OIDC_ISSUER`` wins; otherwise it is derived from a Keycloak base URL (``AGENT_KEYCLOAK_URL``
    or the Aspire reference ``services__keycloak__http(s)__0`` / ``KEYCLOAK_HTTP(S)``) as
    ``<url>/realms/<AGENT_OIDC_REALM>``.

    backlog-api: ``AGENT_BACKLOG_API_URL`` wins, then the Aspire reference ``services__backlog-api__http(s)__0``.
    """

    model_config = SettingsConfigDict(
        env_prefix="AGENT_",
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
        validation_alias=AliasChoices("AGENT_DATABASE_URL", "ConnectionStrings__agentdb", "AGENTDB_URI"),
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
            "AGENT_KEYCLOAK_URL",
            "services__keycloak__https__0",
            "services__keycloak__http__0",
            "KEYCLOAK_HTTPS",
            "KEYCLOAK_HTTP",
        ),
    )
    oidc_audience: str = "agent-service"
    oidc_jwks_url: str | None = None
    oidc_leeway_seconds: int = Field(default=60, ge=0, le=300)
    oidc_http_timeout_seconds: float = Field(default=5.0, gt=0)

    backlog_api_url: str | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "AGENT_BACKLOG_API_URL", "services__backlog-api__https__0", "services__backlog-api__http__0"
        ),
        description="Base URL of backlog-api (without /api/backlog).",
    )
    backlog_http_timeout_seconds: float = Field(default=10.0, gt=0)

    llm_base_url: str | None = Field(
        default=None, description="OpenAI-compatible gateway base URL; '/v1' is appended when missing."
    )
    llm_api: LlmApi = Field(default="chat", description="chat = /v1/chat/completions, responses = /v1/responses.")
    llm_model: str = Field(default="refiner-default", description="Default model alias (agents may override).")
    llm_api_key: SecretStr | None = Field(default=None, repr=False)
    llm_ready_timeout_seconds: float = Field(default=2.0, gt=0)
    llm_ready_cache_seconds: float = Field(default=10.0, ge=0)
    llm_required_for_readiness: bool = Field(
        default=False, description="When true, /readyz returns 503 while the LLM gateway is unreachable."
    )

    skills_dir: Path | None = Field(
        default=None, description="Directory with the default Agent Skills (used by the agent loader)."
    )
    default_agent_id: str = Field(default="backlog-refiner", description="Id of the placeholder agent.")

    max_body_bytes: int = Field(default=1 * MiB, ge=1024)
    agui_max_body_bytes: int = Field(default=2 * MiB, ge=1024, description="Body limit for AG-UI run requests.")
    agui_keepalive_seconds: float = Field(default=15.0, gt=0)
    cors_allow_origins: Annotated[list[str], NoDecode] = Field(
        default_factory=list,
        description="Comma-separated browser origins allowed by CORS. Empty (default) = same-origin via the proxy.",
    )

    # Event hooks: subscription to backlog-api's internal event stream (purges private threads).
    event_hooks_enabled: bool = Field(
        default=True, description="Subscribe to backlog-api's internal events (needs a service credential)."
    )
    service_client_id: str = Field(default="agent-service", description="Keycloak client id for client credentials.")
    service_client_secret: SecretStr | None = Field(default=None, repr=False)
    service_token_url: str | None = Field(
        default=None, description="Token endpoint override; default is <issuer>/protocol/openid-connect/token."
    )
    internal_token: SecretStr | None = Field(
        default=None,
        repr=False,
        description="Static X-Internal-Token for backlog-api's internal stream (development only).",
    )
    hooks_reconnect_min_seconds: float = Field(default=1.0, gt=0)
    hooks_reconnect_max_seconds: float = Field(default=30.0, gt=0)
    hooks_stream_read_timeout_seconds: float = Field(
        default=75.0, gt=0, description="The stream is considered dead when nothing (not even a keepalive) arrives."
    )

    _database_url: URL | None = PrivateAttr(default=None)

    @field_validator("cors_allow_origins", mode="before")
    @classmethod
    def _split_origins(cls, value: object) -> object:
        if isinstance(value, str):
            return [origin.strip().rstrip("/") for origin in value.split(",") if origin.strip()]
        return value

    @model_validator(mode="after")
    def _check_auth_mode(self) -> Settings:
        if self.auth_mode == "dev" and self.env != "development":
            raise ValueError(
                "AGENT_AUTH_MODE=dev trusts the X-Dev-User-Email header and is only allowed when AGENT_ENV=development."
            )
        return self

    @model_validator(mode="after")
    def _check_internal_token(self) -> Settings:
        if self.internal_token is not None and self.env == "production":
            raise ValueError(
                "AGENT_INTERNAL_TOKEN is a development shortcut and not allowed when AGENT_ENV=production."
            )
        return self

    @property
    def hooks_token_url(self) -> str | None:
        if self.service_token_url:
            return self.service_token_url
        return f"{self.issuer}/protocol/openid-connect/token" if self.issuer else None

    @property
    def hooks_credential_mode(self) -> Literal["static-token", "client-credentials"] | None:
        """Which credential the hook subscriber uses, or ``None`` when none is configured."""
        if self.internal_token is not None:
            return "static-token"
        if self.service_client_secret is not None and self.hooks_token_url:
            return "client-credentials"
        return None

    @property
    def async_database_url(self) -> URL | None:
        """The ``postgresql+asyncpg`` URL, or ``None`` when no database is configured."""
        if self._database_url is None and self.database_url:
            self._database_url = to_async_database_url(self.database_url)
        return self._database_url

    @property
    def should_auto_migrate(self) -> bool:
        if self.auto_migrate is not None:
            return self.auto_migrate
        return self.env == "development"

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
            problems.append("a database (AGENT_DATABASE_URL or ConnectionStrings__agentdb)")
        if self.auth_mode == "jwt" and not self.issuer:
            problems.append("an OIDC issuer (AGENT_OIDC_ISSUER or an Aspire Keycloak reference)")
        if not self.backlog_api_url:
            problems.append("the backlog-api URL (AGENT_BACKLOG_API_URL or services__backlog-api__http__0)")
        if not self.llm_base_url:
            problems.append("the LLM gateway base URL (AGENT_LLM_BASE_URL)")
        if problems or url is None:
            raise RuntimeError("agent-service is missing configuration: " + "; ".join(problems) + ".")
        return url
