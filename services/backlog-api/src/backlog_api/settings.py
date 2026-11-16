"""Runtime configuration from environment variables (prefix ``BACKLOG_``) plus Aspire-injected references.

Values are read from the process environment and, for local development, from ``services/backlog-api/.env``.
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import AliasChoices, Field, PrivateAttr, model_validator
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
    user_directory_refresh_seconds: int = Field(default=300, ge=0)

    skills_dir: Path | None = Field(
        default=None,
        description="Directory with the default guidance skills (BACKLOG_SKILLS_DIR); default: repo skills/",
    )
    guidance_max_chars: int = Field(
        default=50_000, ge=1_000, description="Maximum length of one guidance override in characters."
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
            problems.append("a database (BACKLOG_DATABASE_URL or ConnectionStrings__backlogdb)")
        if self.auth_mode == "jwt" and not self.issuer:
            problems.append("an OIDC issuer (BACKLOG_OIDC_ISSUER or an Aspire Keycloak reference)")
        if problems or url is None:
            raise RuntimeError("backlog-api is missing configuration: " + "; ".join(problems) + ".")
        return url
