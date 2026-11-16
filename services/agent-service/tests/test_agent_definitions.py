"""Agent definition parser, tools.yaml parsing and the shipped definition files (no database needed)."""

from __future__ import annotations

from pathlib import Path

import pytest

from agent_service.agents.definition import (
    AgentDefinitionError,
    load_agent_definitions,
    parse_agent_definition,
)
from agent_service.mcp_client import ToolsConfigError, parse_tools_config
from agent_service.settings import SERVICE_ROOT

VALID = """\
---
id: demo-agent
name: Demo
description: A demo agent.
model: gpt-alias
temperature: 0.3
max_turns: 5
max_tool_calls: 9
skills: [backlog-refinement]
tools: [suggest_next_actions]
mcp: [backlog]
client_tools: [ask_user]
context_providers: [item_context]
predict_state:
  preview: {tool: propose_document_changes, argument: sections}
---
Be helpful.
"""


def test_valid_definition() -> None:
    definition = parse_agent_definition(VALID, source="demo-agent.agent.md", expected_id="demo-agent")
    assert definition.id == "demo-agent"
    assert definition.model == "gpt-alias"
    assert definition.temperature == 0.3
    assert (definition.max_turns, definition.max_tool_calls) == (5, 9)
    assert definition.skills == ("backlog-refinement",)
    assert definition.client_tools == ("ask_user",)
    assert definition.predict_state["preview"].argument == "sections"
    assert definition.instructions == "Be helpful."


def test_minimal_definition_has_optional_fields_empty() -> None:
    definition = parse_agent_definition("---\nid: a\nname: A\ndescription: D\n---\nBody")
    assert definition.model is None
    assert definition.skills == definition.tools == definition.mcp == ()


@pytest.mark.parametrize(
    ("text", "message"),
    [
        ("no frontmatter", "missing YAML frontmatter"),
        ("---\nid: [\n---\nbody", "not valid YAML"),
        ("---\n- a\n---\nbody", "must be a YAML mapping"),
        ("---\nname: A\ndescription: D\n---\nbody", "id: is required"),
        ("---\nid: Bad_Id\nname: A\ndescription: D\n---\nbody", "id: "),
        ("---\nid: a\nname: A\ndescription: D\nunknown: 1\n---\nbody", "unknown: is not a known field"),
        ("---\nid: a\nname: A\ndescription: D\n---\n", "base instructions"),
        ("---\nid: a\nname: A\ndescription: D\ntemperature: 5\n---\nbody", "temperature"),
        ("---\nid: a\nname: A\ndescription: D\nskills: [x, x]\n---\nbody", "must not repeat"),
    ],
)
def test_invalid_definitions_name_file_and_problem(text: str, message: str) -> None:
    with pytest.raises(AgentDefinitionError, match="broken.agent.md") as error:
        parse_agent_definition(text, source="broken.agent.md")
    assert message in str(error.value)


def test_id_must_match_file_name() -> None:
    with pytest.raises(AgentDefinitionError, match="must equal the file name"):
        parse_agent_definition(VALID, source="other.agent.md", expected_id="other")


def test_directory_loading_and_duplicate_detection(tmp_path: Path) -> None:
    (tmp_path / "demo-agent.agent.md").write_text(VALID, encoding="utf-8")
    assert list(load_agent_definitions(tmp_path)) == ["demo-agent"]
    (tmp_path / "broken.agent.md").write_text("nope", encoding="utf-8")
    with pytest.raises(AgentDefinitionError, match="broken.agent.md"):
        load_agent_definitions(tmp_path)
    with pytest.raises(AgentDefinitionError, match="does not exist"):
        load_agent_definitions(tmp_path / "missing")


def test_shipped_definitions_are_valid() -> None:
    definitions = load_agent_definitions(SERVICE_ROOT / "agents")
    refiner = definitions["backlog-refiner"]
    assert refiner.mcp == ("backlog",)
    assert refiner.client_tools == ("ask_user",)
    assert refiner.predict_state["preview"].tool == "propose_document_changes"


TOOLS_YAML = """\
version: 1
mcp:
  backlog:
    url: ${AGENT_BACKLOG_API_URL}/api/backlog/mcp
    allowed_tools: [get_item_context]
    hidden_tools: [apply_document_changes]
  other:
    url: ${OTHER_URL:-http://other.test/mcp}
    auth: none
"""


def test_tools_yaml_parsing_and_env_interpolation() -> None:
    config = parse_tools_config(TOOLS_YAML, {"AGENT_BACKLOG_API_URL": "http://backlog.test"})
    backlog = config.server("backlog")
    assert backlog.name == "backlog"
    assert backlog.url == "http://backlog.test/api/backlog/mcp"
    assert backlog.transport == "streamable_http"
    assert backlog.auth == "user_token"
    assert backlog.allowed_tools == ("get_item_context",)
    assert backlog.hidden_tools == ("apply_document_changes",)
    other = config.server("other")
    assert other.url == "http://other.test/mcp"
    assert other.auth == "none"


def test_tools_yaml_unset_variable_is_an_error() -> None:
    with pytest.raises(ToolsConfigError, match="AGENT_BACKLOG_API_URL"):
        parse_tools_config(TOOLS_YAML, {})


@pytest.mark.parametrize(
    ("text", "message"),
    [
        ("mcp: [", "not valid YAML"),
        ("- a", "top level"),
        ("mcp:\n  a:\n    url: http://x\n    transport: stdio\n", "transport"),
        ("mcp:\n  a:\n    url: http://x\n    allowed_tools: [t]\n    hidden_tools: [t]\n", "both allowed and hidden"),
        ("mcp:\n  a:\n    allowed_tools: [t]\n", "url"),
    ],
)
def test_tools_yaml_errors(text: str, message: str) -> None:
    with pytest.raises(ToolsConfigError, match=message):
        parse_tools_config(text, {})


def test_unknown_server_is_an_error() -> None:
    with pytest.raises(ToolsConfigError, match="'nope' is not defined"):
        parse_tools_config(TOOLS_YAML, {"AGENT_BACKLOG_API_URL": "http://b"}).server("nope")


def test_shipped_tools_yaml_matches_the_mcp_contract() -> None:
    config = parse_tools_config(
        (SERVICE_ROOT / "tools" / "tools.yaml").read_text(encoding="utf-8"), {"AGENT_BACKLOG_API_URL": "http://b"}
    )
    backlog = config.server("backlog")
    assert backlog.url == "http://b/api/backlog/mcp"
    assert set(backlog.allowed_tools) == {
        "get_item_context",
        "get_project_guidance",
        "get_pinned_sources",
        "search_sources",
        "find_similar_items",
    }
    assert set(backlog.hidden_tools) == {"apply_document_changes", "create_child_items", "set_item_quality"}
