"""Agent loader: validation errors at build time and development hot reload (no database needed)."""

from __future__ import annotations

import os
import shutil
from pathlib import Path

import pytest
from agent_framework_ag_ui import InMemoryAGUIThreadSnapshotStore

from agent_service.agents.loader import AgentLoadError, ReloadingRegistry, build_registry, registry_factory
from agent_service.settings import SERVICE_ROOT, Settings

DEFINITION = """\
---
id: {id}
name: {name}
description: Test agent.
mcp: [backlog]
tools: [suggest_next_actions]
context_providers: [item_context]
---
Test instructions.
"""


@pytest.fixture
def workdir(tmp_path: Path) -> Path:
    (tmp_path / "agents").mkdir()
    (tmp_path / "agents" / "one.agent.md").write_text(DEFINITION.format(id="one", name="One"), encoding="utf-8")
    shutil.copy(SERVICE_ROOT / "tools" / "tools.yaml", tmp_path / "tools.yaml")
    return tmp_path


def make_settings(workdir: Path, *, env: str = "development") -> Settings:
    return Settings(
        _env_file=None,  # pyright: ignore[reportCallIssue]
        env=env,  # pyright: ignore[reportArgumentType]
        auth_mode="dev" if env == "development" else "jwt",
        oidc_issuer="https://keycloak.test/realms/backlog",
        database_url="postgresql://x:y@localhost/z",
        backlog_api_url="http://backlog.test",
        llm_base_url="http://llm.test",
        agents_dir=workdir / "agents",
        tools_file=workdir / "tools.yaml",
        build_sha="sha1",
    )


def touch(path: Path) -> None:
    stat = path.stat()
    os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 5_000_000_000))


def test_registry_is_built_from_the_directory(workdir: Path) -> None:
    registry = build_registry(make_settings(workdir), InMemoryAGUIThreadSnapshotStore())
    assert list(registry.ids()) == ["one"]
    info = registry.info("one")
    assert info is not None
    assert (info.name, info.version) == ("One", "sha1")


def test_shipped_agents_load_with_the_default_registry_factory() -> None:
    settings = Settings(
        _env_file=None,  # pyright: ignore[reportCallIssue]
        env="test",
        oidc_issuer="https://keycloak.test/realms/backlog",
        database_url="postgresql://x:y@localhost/z",
        backlog_api_url="http://backlog.test",
        llm_base_url="http://llm.test",
        build_sha="sha1",
    )
    registry = registry_factory(settings, InMemoryAGUIThreadSnapshotStore())
    assert list(registry.ids()) == ["backlog-refiner"]
    assert not isinstance(registry, ReloadingRegistry)


@pytest.mark.parametrize(
    ("body", "message"),
    [
        ("mcp: [jira]", "'jira' is not defined"),
        ("skills: [nope]", "unknown skills: nope"),
        ("tools: [nope]", "Unknown agent tool 'nope'"),
        ("context_providers: [nope]", "unknown context provider 'nope'"),
        ("context_providers: [item_context]", r"needs 'mcp: \[backlog\]'"),
    ],
)
def test_inconsistent_definitions_fail_with_a_clear_message(workdir: Path, body: str, message: str) -> None:
    text = f"---\nid: one\nname: One\ndescription: D\n{body}\n---\nBody\n"
    (workdir / "agents" / "one.agent.md").write_text(text, encoding="utf-8")
    with pytest.raises(AgentLoadError, match=message):
        build_registry(make_settings(workdir), InMemoryAGUIThreadSnapshotStore())


def test_unset_environment_variable_in_tools_yaml_fails(workdir: Path) -> None:
    (workdir / "tools.yaml").write_text("mcp:\n  backlog:\n    url: ${MISSING_VAR_FOR_TEST}/mcp\n", encoding="utf-8")
    with pytest.raises(AgentLoadError, match="MISSING_VAR_FOR_TEST"):
        build_registry(make_settings(workdir), InMemoryAGUIThreadSnapshotStore())


def test_development_registry_reloads_changed_definitions(workdir: Path) -> None:
    registry = registry_factory(make_settings(workdir), InMemoryAGUIThreadSnapshotStore())
    assert isinstance(registry, ReloadingRegistry)
    assert registry.info("one") is not None
    assert registry.get("two") is None

    (workdir / "agents" / "two.agent.md").write_text(DEFINITION.format(id="two", name="Two"), encoding="utf-8")
    assert registry.get("two") is not None
    assert sorted(registry.ids()) == ["one", "two"]

    renamed = DEFINITION.format(id="one", name="Renamed")
    (workdir / "agents" / "one.agent.md").write_text(renamed, encoding="utf-8")
    touch(workdir / "agents" / "one.agent.md")
    info = registry.info("one")
    assert info is not None
    assert info.name == "Renamed"

    (workdir / "agents" / "two.agent.md").unlink()
    assert registry.get("two") is None


def test_development_registry_reloads_tools_yaml(workdir: Path) -> None:
    registry = registry_factory(make_settings(workdir), InMemoryAGUIThreadSnapshotStore())
    assert isinstance(registry, ReloadingRegistry)
    before = registry.get("one")
    (workdir / "tools.yaml").write_text(
        (workdir / "tools.yaml").read_text(encoding="utf-8") + "\n# changed\n", encoding="utf-8"
    )
    touch(workdir / "tools.yaml")
    after = registry.get("one")
    assert after is not None
    assert after is not before


def test_a_broken_edit_keeps_the_previous_agents(workdir: Path) -> None:
    registry = registry_factory(make_settings(workdir), InMemoryAGUIThreadSnapshotStore())
    assert isinstance(registry, ReloadingRegistry)
    (workdir / "agents" / "one.agent.md").write_text("broken", encoding="utf-8")
    touch(workdir / "agents" / "one.agent.md")
    assert registry.get("one") is not None  # previous agent kept
    (workdir / "agents" / "one.agent.md").write_text(DEFINITION.format(id="one", name="Fixed"), encoding="utf-8")
    touch(workdir / "agents" / "one.agent.md")
    info = registry.info("one")
    assert info is not None
    assert info.name == "Fixed"
