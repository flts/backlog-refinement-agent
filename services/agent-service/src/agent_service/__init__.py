"""agent-service: AG-UI endpoint on Microsoft Agent Framework, private agent threads and feedback."""

from importlib.metadata import PackageNotFoundError, version

try:
    __version__ = version("agent-service")
except PackageNotFoundError:  # pragma: no cover - running from a source tree without installation
    __version__ = "0.0.0"
