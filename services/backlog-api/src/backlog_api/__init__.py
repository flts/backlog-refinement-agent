"""backlog-api: the backlog domain service (projects, members, items, sources, events and the backlog MCP server)."""

from importlib.metadata import PackageNotFoundError, version

try:
    __version__ = version("backlog-api")
except PackageNotFoundError:  # pragma: no cover - running from a source tree without installation
    __version__ = "0.0.0"
