"""``tools/tools.yaml``: MCP server bindings for the agents.

```yaml
version: 1
mcp:
  backlog:
    url: ${AGENT_BACKLOG_API_URL}/api/backlog/mcp   # ${VAR} and ${VAR:-default} are interpolated
    transport: streamable_http
    auth: user_token            # forward the caller's bearer token (default) | none
    allowed_tools: [...]        # offered to the model
    hidden_tools: [...]         # exist on the server, never offered to the model; only our own tools call them
```
"""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Annotated, Any, Literal, Self

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

_VAR_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}")


class ToolsConfigError(Exception):
    """tools.yaml is missing or invalid."""


class McpServerConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    name: str = ""
    url: Annotated[str, Field(min_length=1)]
    transport: Literal["streamable_http"] = "streamable_http"
    auth: Literal["user_token", "none"] = "user_token"
    allowed_tools: tuple[str, ...] = ()
    hidden_tools: tuple[str, ...] = ()
    request_timeout_seconds: Annotated[int, Field(ge=1, le=600)] = 60

    @model_validator(mode="after")
    def _disjoint(self) -> Self:
        overlap = sorted(set(self.allowed_tools) & set(self.hidden_tools))
        if overlap:
            raise ValueError(f"tools cannot be both allowed and hidden: {', '.join(overlap)}")
        return self

    @property
    def known_tools(self) -> frozenset[str]:
        return frozenset((*self.allowed_tools, *self.hidden_tools))


class ToolsConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    version: Literal[1] = 1
    mcp: dict[str, McpServerConfig] = Field(default_factory=dict)

    def server(self, name: str) -> McpServerConfig:
        try:
            return self.mcp[name]
        except KeyError:
            raise ToolsConfigError(f"MCP server '{name}' is not defined in tools.yaml.") from None


def interpolate(value: str, env: Mapping[str, str], *, where: str = "tools.yaml") -> str:
    """Replace ``${VAR}`` / ``${VAR:-default}``; an unset or empty variable without a default is an error."""

    def replace(match: re.Match[str]) -> str:
        name, default = match.group(1), match.group(2)
        resolved = env.get(name)
        if resolved:
            return resolved
        if default is not None:
            return default
        raise ToolsConfigError(f"{where}: environment variable '{name}' is not set (referenced as ${{{name}}}).")

    return _VAR_RE.sub(replace, value)


def _interpolate_tree(value: Any, env: Mapping[str, str], where: str) -> Any:
    if isinstance(value, str):
        return interpolate(value, env, where=where)
    if isinstance(value, list):
        return [_interpolate_tree(item, env, where) for item in value]
    if isinstance(value, dict):
        return {key: _interpolate_tree(item, env, f"{where}.{key}") for key, item in value.items()}
    return value


def parse_tools_config(text: str, env: Mapping[str, str] | None = None, *, source: str = "tools.yaml") -> ToolsConfig:
    try:
        raw: Any = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise ToolsConfigError(f"{source}: not valid YAML: {exc}") from exc
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise ToolsConfigError(f"{source}: the top level must be a mapping.")
    resolved: dict[str, Any] = _interpolate_tree(raw, os.environ if env is None else env, source)
    servers = resolved.get("mcp") or {}
    if not isinstance(servers, dict):
        raise ToolsConfigError(f"{source}: 'mcp' must be a mapping of server name to binding.")
    for name, binding in servers.items():
        if isinstance(binding, dict):
            binding["name"] = str(name)
    resolved["mcp"] = servers
    try:
        return ToolsConfig.model_validate(resolved)
    except ValidationError as exc:
        details = "; ".join(
            f"{'.'.join(str(part) for part in item['loc'])}: {item['msg']}"
            for item in exc.errors(include_url=False, include_input=False)
        )
        raise ToolsConfigError(f"{source}: {details}") from exc


def load_tools_config(path: Path, env: Mapping[str, str] | None = None) -> ToolsConfig:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise ToolsConfigError(f"{path}: cannot be read: {exc}") from exc
    return parse_tools_config(text, env, source=str(path))
