"""Structured JSON logging: IDs and metadata only, with redaction and trace correlation.

Content logging is off by default (``AGENT_LOG_CONTENT=false``): prompts, messages, tool arguments and tokens are never
logged by this service, and the chatty libraries (agent framework, openai, mcp, sse-starlette, httpx) are capped at
INFO so they do not log payloads at DEBUG. :class:`RedactionFilter` additionally masks bearer tokens, ``Authorization``
headers, JWTs,
``access_token`` / ``ticket`` / secret query parameters and secret-named fields in every record, whatever its origin.

Every JSON line carries ``request_id``, ``run_id``, ``thread_id``, ``agent_id`` (when bound) and the OpenTelemetry
``trace_id`` / ``span_id`` of the active span.
"""

from __future__ import annotations

import json
import logging
import re
import sys
from collections.abc import Mapping
from contextvars import ContextVar
from datetime import UTC, datetime
from typing import IO, Any

from opentelemetry import trace

request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)
run_id_var: ContextVar[str | None] = ContextVar("run_id", default=None)
thread_id_var: ContextVar[str | None] = ContextVar("thread_id", default=None)
agent_id_var: ContextVar[str | None] = ContextVar("agent_id", default=None)

REDACTED = "[redacted]"
_SENSITIVE_NAMES = (
    "access_token|id_token|refresh_token|token|ticket|api[_-]?key|client_secret|secret|password|passwd|signature|"
    "authorization|cookie|set-cookie"
)
_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}"), rf"\1 {REDACTED}"),
    (
        re.compile(rf"(?i)(\"?\b(?:{_SENSITIVE_NAMES})\"?\s*[:=]\s*)(\"[^\"]*\"|'[^']*'|[^\s&,;}}\]\"']+)"),
        rf"\1{REDACTED}",
    ),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*"), REDACTED),
)
_SENSITIVE_KEY = re.compile(rf"(?i)^(?:{_SENSITIVE_NAMES})$")
_QUERY_SECRET = re.compile(rf"(?i)([?&](?:{_SENSITIVE_NAMES})=)[^&#\s]*")


def redact(text: str) -> str:
    """Mask secrets in free text (bearer tokens, JWTs, ``token=...`` pairs, JSON secret fields)."""
    for pattern, replacement in _PATTERNS:
        text = pattern.sub(replacement, text)
    return text


def redact_url(url: str) -> str:
    """Mask the value of secret query parameters (``access_token``, ``ticket``, ...) in a URL or request target."""
    return _QUERY_SECRET.sub(rf"\1{REDACTED}", url)


def redact_field(key: str, value: Any) -> Any:
    if _SENSITIVE_KEY.match(key):
        return REDACTED
    if isinstance(value, str):
        return redact(value)
    return value


_RESERVED = frozenset(vars(logging.makeLogRecord({})).keys()) | {"message", "asctime", "taskName"}


class RedactionFilter(logging.Filter):
    """Masks secrets in the message and in string ``extra`` fields of every record."""

    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        redacted = redact(message)
        if redacted != message or record.args:
            record.msg, record.args = redacted, None
        for key, value in list(record.__dict__.items()):
            if key not in _RESERVED and not key.startswith("_"):
                record.__dict__[key] = redact_field(key, value)
        return True


def context_fields(*, include_trace: bool = True) -> dict[str, str]:
    """Correlation fields of the current context (only those that are set)."""
    fields: dict[str, str] = {}
    for name, var in (
        ("request_id", request_id_var),
        ("run_id", run_id_var),
        ("thread_id", thread_id_var),
        ("agent_id", agent_id_var),
    ):
        value = var.get()
        if value:
            fields[name] = value
    if include_trace:
        context = trace.get_current_span().get_span_context()
        if context.is_valid:
            fields["trace_id"] = f"{context.trace_id:032x}"
            fields["span_id"] = f"{context.span_id:016x}"
    return fields


class ContextFilter(logging.Filter):
    """Copies the correlation fields onto the record (for handlers that export ``extra`` fields as attributes)."""

    def __init__(self, *, include_trace: bool = False) -> None:
        super().__init__()
        self._include_trace = include_trace

    def filter(self, record: logging.LogRecord) -> bool:
        for key, value in context_fields(include_trace=self._include_trace).items():
            record.__dict__.setdefault(key, value)
        return True


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, tz=UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg": redact(record.getMessage()),
        }
        payload.update(context_fields())
        for key, value in record.__dict__.items():
            if key not in _RESERVED and not key.startswith("_"):
                payload[key] = redact_field(key, value)
        if record.exc_info:
            payload["exc_type"] = record.exc_info[0].__name__ if record.exc_info[0] else None
            payload["exc"] = redact(self.formatException(record.exc_info))
        return json.dumps(payload, default=str, ensure_ascii=False)


_QUIET_LIBRARIES = ("agent_framework", "agent_framework_ag_ui", "openai", "mcp", "sse_starlette")


def configure_logging(level: str = "INFO", *, log_content: bool = False, stream: IO[str] | None = None) -> None:
    handler = logging.StreamHandler(stream or sys.stdout)
    handler.setFormatter(JsonFormatter())
    handler.addFilter(RedactionFilter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level.upper())
    for name in ("uvicorn", "uvicorn.error"):
        logger = logging.getLogger(name)
        logger.handlers[:] = []
        logger.propagate = True
    # Request logging is done by RequestContextMiddleware without query strings.
    logging.getLogger("uvicorn.access").disabled = True
    # httpx logs full request URLs at INFO and the agent libraries may log content at DEBUG: keep them quiet unless
    # content logging was explicitly enabled.
    for name in ("httpx", "httpx2", "httpcore", "httpcore2"):
        logging.getLogger(name).setLevel(logging.WARNING)
    for name in _QUIET_LIBRARIES:
        logging.getLogger(name).setLevel(root.level if log_content else max(root.level, logging.INFO))


def log_extra(values: Mapping[str, Any]) -> dict[str, Any]:
    """``extra=`` helper that drops ``None`` values."""
    return {key: value for key, value in values.items() if value is not None}
