from __future__ import annotations

import os

import pytest
from pydantic import ValidationError

from backlog_api.db.connection_strings import to_async_database_url
from backlog_api.settings import Settings


@pytest.fixture(autouse=True)
def _clean_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in list(os.environ):
        if name.upper().startswith(("BACKLOG_", "CONNECTIONSTRINGS__", "SERVICES__KEYCLOAK", "KEYCLOAK_")):
            monkeypatch.delenv(name)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (
            "Host=db.internal;Port=6543;Username=app;Password=pw;Database=backlogdb",
            "postgresql+asyncpg://app:pw@db.internal:6543/backlogdb",
        ),
        (
            "host = localhost ; user id = app ; pwd = pw ; database = backlogdb ; ssl mode = Require",
            "postgresql+asyncpg://app:pw@localhost/backlogdb?ssl=require",
        ),
        ("postgres://app:pw@localhost:5432/backlogdb", "postgresql+asyncpg://app:pw@localhost:5432/backlogdb"),
        (
            "postgresql://app:pw@localhost/backlogdb?sslmode=verify-full&application_name=x",
            "postgresql+asyncpg://app:pw@localhost/backlogdb?ssl=verify-full",
        ),
        (
            "postgresql+psycopg://app:pw@localhost/backlogdb",
            "postgresql+asyncpg://app:pw@localhost/backlogdb",
        ),
    ],
)
def test_connection_string_conversion(raw: str, expected: str) -> None:
    assert to_async_database_url(raw).render_as_string(hide_password=False) == expected


def test_key_value_with_quoted_password_containing_separators() -> None:
    url = to_async_database_url('Host=localhost;Username=postgres;Password="a;b=""c""";Database=backlogdb')
    assert url.password == 'a;b="c"'
    assert url.host == "localhost"
    assert url.database == "backlogdb"


def test_unquoted_semicolon_ends_the_value() -> None:
    url = to_async_database_url("Host=localhost;Port=5432;Username=postgres;Password=s3cr;et=;Database=backlogdb")
    # Npgsql semantics: an unquoted ';' ends the value, so the password is 's3cr'.
    assert url.password == "s3cr"


@pytest.mark.parametrize("raw", ["", "   ", "mysql://u:p@h/db", "Port=5432;Database=x", "not a url"])
def test_invalid_connection_strings(raw: str) -> None:
    with pytest.raises(ValueError):
        to_async_database_url(raw)


def test_settings_read_aspire_connection_string(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ConnectionStrings__backlogdb", "Host=pg;Port=5432;Username=u;Password=p;Database=backlogdb")
    settings = Settings(_env_file=None)  # pyright: ignore[reportCallIssue]
    assert settings.async_database_url is not None
    assert settings.async_database_url.render_as_string(hide_password=False) == (
        "postgresql+asyncpg://u:p@pg:5432/backlogdb"
    )


def test_backlog_database_url_wins_over_aspire(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ConnectionStrings__backlogdb", "Host=aspire;Database=backlogdb")
    monkeypatch.setenv("BACKLOG_DATABASE_URL", "postgresql://u:p@explicit/backlogdb")
    settings = Settings(_env_file=None)  # pyright: ignore[reportCallIssue]
    assert settings.async_database_url is not None
    assert settings.async_database_url.host == "explicit"


def test_issuer_from_aspire_keycloak_reference(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("services__keycloak__http__0", "http://localhost:8080/")
    settings = Settings(_env_file=None)  # pyright: ignore[reportCallIssue]
    assert settings.issuer == "http://localhost:8080/realms/backlog"


def test_dev_auth_mode_requires_development() -> None:
    with pytest.raises(ValidationError, match="only allowed"):
        Settings(_env_file=None, env="production", auth_mode="dev")  # pyright: ignore[reportCallIssue]
    assert Settings(_env_file=None, env="development", auth_mode="dev").auth_mode == "dev"  # pyright: ignore[reportCallIssue]


def test_auto_migrate_defaults_to_development_only() -> None:
    assert Settings(_env_file=None, env="development").should_auto_migrate is True  # pyright: ignore[reportCallIssue]
    assert Settings(_env_file=None, env="production").should_auto_migrate is False  # pyright: ignore[reportCallIssue]
    assert Settings(_env_file=None, env="production", auto_migrate=True).should_auto_migrate is True  # pyright: ignore[reportCallIssue]


def test_runtime_config_is_required() -> None:
    settings = Settings(_env_file=None, env="production")  # pyright: ignore[reportCallIssue]
    with pytest.raises(RuntimeError, match="missing configuration"):
        settings.require_runtime_config()
