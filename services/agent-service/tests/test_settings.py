from __future__ import annotations

import os

import pytest
from pydantic import ValidationError

from agent_service.settings import Settings


@pytest.fixture(autouse=True)
def _clean_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in list(os.environ):
        if name.upper().startswith(("AGENT_", "AGENTDB", "CONNECTIONSTRINGS__", "SERVICES__", "KEYCLOAK_")):
            monkeypatch.delenv(name)


def settings(**values: object) -> Settings:
    return Settings(_env_file=None, **values)  # type: ignore[call-arg, arg-type]  # pyright: ignore[reportCallIssue]


def test_settings_read_aspire_connection_string(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ConnectionStrings__agentdb", "Host=pg;Port=5432;Username=u;Password=p;Database=agentdb")
    url = settings().async_database_url
    assert url is not None
    assert url.render_as_string(hide_password=False) == "postgresql+asyncpg://u:p@pg:5432/agentdb"


def test_agent_database_url_wins_over_aspire(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ConnectionStrings__agentdb", "Host=aspire;Database=agentdb")
    monkeypatch.setenv("AGENT_DATABASE_URL", "postgresql://u:p@explicit/agentdb")
    url = settings().async_database_url
    assert url is not None
    assert url.host == "explicit"


def test_backlog_url_from_aspire_reference(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("services__backlog-api__http__0", "http://localhost:8001")
    assert settings().backlog_api_url == "http://localhost:8001"
    monkeypatch.setenv("AGENT_BACKLOG_API_URL", "http://backlog-api:8001")
    assert settings().backlog_api_url == "http://backlog-api:8001"


def test_issuer_from_aspire_keycloak_reference(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("services__keycloak__http__0", "http://localhost:8080/")
    assert settings().issuer == "http://localhost:8080/realms/backlog"
    monkeypatch.setenv("AGENT_OIDC_ISSUER", "http://kc/realms/other/")
    assert settings().issuer == "http://kc/realms/other"


def test_defaults_and_aspire_apphost_names(monkeypatch: pytest.MonkeyPatch) -> None:
    for name, value in {
        "AGENT_ENV": "development",
        "AGENT_OIDC_AUDIENCE": "agent-service",
        "AGENT_LLM_BASE_URL": "http://localhost:8090",
        "AGENT_LLM_API_KEY": "key",
        "AGENT_LLM_MODEL": "refiner-default",
        "AGENT_SKILLS_DIR": "/skills",
        "AGENT_AUTO_MIGRATE": "true",
    }.items():
        monkeypatch.setenv(name, value)
    loaded = settings()
    assert loaded.should_auto_migrate is True
    assert loaded.llm_api == "chat"
    assert loaded.llm_api_key is not None
    assert loaded.llm_api_key.get_secret_value() == "key"
    assert str(loaded.skills_dir) == "/skills"
    assert loaded.oidc_audience == "agent-service"
    assert loaded.agui_max_body_bytes == 2 * 1024 * 1024
    assert loaded.cors_allow_origins == []


def test_cors_origins_are_comma_separated(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AGENT_CORS_ALLOW_ORIGINS", "http://localhost:5173, https://app.example/")
    assert settings().cors_allow_origins == ["http://localhost:5173", "https://app.example"]


def test_dev_auth_mode_requires_development() -> None:
    with pytest.raises(ValidationError, match="only allowed"):
        settings(env="production", auth_mode="dev")
    assert settings(env="development", auth_mode="dev").auth_mode == "dev"


def test_auto_migrate_defaults_to_development_only() -> None:
    assert settings(env="development").should_auto_migrate is True
    assert settings(env="production").should_auto_migrate is False
    assert settings(env="production", auto_migrate=True).should_auto_migrate is True


def test_runtime_config_is_required() -> None:
    with pytest.raises(RuntimeError, match="missing configuration"):
        settings(env="production").require_runtime_config()
