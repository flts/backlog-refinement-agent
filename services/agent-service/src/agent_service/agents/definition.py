"""Agent definitions: ``agents/<id>.agent.md`` (YAML frontmatter + Markdown body = base instructions).

```markdown
---
id: backlog-refiner              # lowercase-hyphen, equal to the file name (<id>.agent.md)
name: Backlog refiner
description: What the agent does (shown in the catalogue).
model: refiner-default           # optional gateway alias, default AGENT_LLM_MODEL
temperature: 0.2                 # optional
max_turns: 12                    # optional: LLM round trips per run (MAF max_iterations)
max_tool_calls: 30               # optional: tool calls per run (MAF max_function_calls)
skills: [backlog-refinement]     # Agent Skills (skills/<name>/SKILL.md) offered through load_skill
tools: [suggest_next_actions]    # agent-side tools, resolved by name in agent_service.tools
mcp: [backlog]                   # MCP servers from tools/tools.yaml
client_tools: [ask_user]         # tools the SPA declares in RunAgentInput.tools (never defined here)
context_providers: [item_context, intent]   # run-start context providers, see agents/providers.py
predict_state:                   # optional AG-UI predictive state: state key -> tool argument
  preview: {tool: propose_document_changes, argument: "*"}
---
Base instructions (Markdown) ...
```
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Annotated, Any

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

AGENT_FILE_SUFFIX = ".agent.md"

_FRONTMATTER_RE = re.compile(r"\A\ufeff?---[ \t]*\r?\n(.*?)^---[ \t]*\r?$\n?", re.MULTILINE | re.DOTALL)
_ID_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
_NAME_PATTERN = r"^[A-Za-z0-9_][A-Za-z0-9_.-]*$"

Identifier = Annotated[str, Field(min_length=1, max_length=64, pattern=_NAME_PATTERN)]


class AgentDefinitionError(Exception):
    """A definition file is missing, malformed or invalid; the message names the file and the problem."""


class PredictState(BaseModel):
    """AG-UI predictive state: the (streaming) arguments of ``tool`` are mirrored into a shared state key."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    tool: Identifier
    argument: Annotated[str, Field(min_length=1, max_length=64)] = "*"


class AgentDefinition(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    id: Annotated[str, Field(min_length=1, max_length=64)]
    name: Annotated[str, Field(min_length=1, max_length=100)]
    description: Annotated[str, Field(min_length=1, max_length=500)]
    model: Annotated[str, Field(min_length=1, max_length=200)] | None = None
    temperature: Annotated[float, Field(ge=0, le=2)] | None = None
    max_turns: Annotated[int, Field(ge=1, le=200)] | None = None
    max_tool_calls: Annotated[int, Field(ge=1, le=1000)] | None = None
    skills: tuple[Identifier, ...] = ()
    tools: tuple[Identifier, ...] = ()
    mcp: tuple[Identifier, ...] = ()
    client_tools: tuple[Identifier, ...] = ()
    context_providers: tuple[Identifier, ...] = ()
    predict_state: dict[Identifier, PredictState] = Field(default_factory=dict)
    instructions: Annotated[str, Field(min_length=1)]
    path: Path | None = None

    @field_validator("id")
    @classmethod
    def _check_id(cls, value: str) -> str:
        if not _ID_RE.fullmatch(value):
            raise ValueError("must be lowercase letters, digits and single hyphens (for example 'backlog-refiner')")
        return value

    @field_validator("skills", "tools", "mcp", "client_tools", "context_providers")
    @classmethod
    def _unique(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        duplicates = sorted({entry for entry in value if value.count(entry) > 1})
        if duplicates:
            raise ValueError(f"must not repeat entries: {', '.join(duplicates)}")
        return value


def parse_agent_definition(text: str, *, source: str = "<string>", expected_id: str | None = None) -> AgentDefinition:
    """Parse and validate one definition; raises :class:`AgentDefinitionError` naming ``source``."""
    match = _FRONTMATTER_RE.match(text)
    if not match:
        raise AgentDefinitionError(f"{source}: missing YAML frontmatter delimited by '---' lines.")
    try:
        raw: Any = yaml.safe_load(match.group(1))
    except yaml.YAMLError as exc:
        raise AgentDefinitionError(f"{source}: the frontmatter is not valid YAML: {exc}") from exc
    if not isinstance(raw, dict):
        raise AgentDefinitionError(f"{source}: the frontmatter must be a YAML mapping.")
    data = {str(key): value for key, value in raw.items()}
    data["instructions"] = text[match.end() :].strip()
    try:
        definition = AgentDefinition.model_validate(data)
    except ValidationError as exc:
        raise AgentDefinitionError(f"{source}: {_format_errors(exc)}") from exc
    if expected_id is not None and definition.id != expected_id:
        raise AgentDefinitionError(
            f"{source}: id '{definition.id}' must equal the file name ('{expected_id}{AGENT_FILE_SUFFIX}')."
        )
    return definition


def _format_errors(error: ValidationError) -> str:
    parts: list[str] = []
    for item in error.errors(include_url=False, include_input=False):
        location = ".".join(str(part) for part in item["loc"]) or "definition"
        message = item["msg"]
        if item["type"] == "missing":
            message = "is required"
        elif item["type"] == "extra_forbidden":
            message = "is not a known field"
        elif item["type"] == "string_too_short" and location == "instructions":
            message = "the Markdown body (the base instructions) must not be empty"
        parts.append(f"{location}: {message}")
    return "; ".join(parts)


def definition_files(directory: Path) -> list[Path]:
    return sorted(directory.glob(f"*{AGENT_FILE_SUFFIX}"))


def load_agent_definitions(directory: Path) -> dict[str, AgentDefinition]:
    """Parse every ``*.agent.md`` in ``directory`` (sorted); ids must be unique and equal to the file name."""
    if not directory.is_dir():
        raise AgentDefinitionError(f"The agents directory '{directory}' does not exist.")
    definitions: dict[str, AgentDefinition] = {}
    for path in definition_files(directory):
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            raise AgentDefinitionError(f"{path}: cannot be read: {exc}") from exc
        definition = parse_agent_definition(
            text, source=str(path), expected_id=path.name.removesuffix(AGENT_FILE_SUFFIX)
        ).model_copy(update={"path": path})
        if definition.id in definitions:
            raise AgentDefinitionError(f"{path}: duplicate agent id '{definition.id}'.")
        definitions[definition.id] = definition
    if not definitions:
        raise AgentDefinitionError(f"No agent definitions (*{AGENT_FILE_SUFFIX}) found in '{directory}'.")
    return definitions
