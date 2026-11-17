"""Log redaction and OpenTelemetry on/off (spans recorded with an in-memory exporter)."""

from __future__ import annotations

import io
import json
import logging
from collections.abc import Iterator

import httpx
import pytest
from asgi_lifespan import LifespanManager
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from backlog_api.main import create_app
from backlog_api.observability import configure_logging, redact, redact_url, request_id_var
from backlog_api.settings import Settings
from backlog_api.telemetry import Telemetry, otlp_endpoint_configured, setup_telemetry
from backlog_api_testkit import API, TokenFactory

JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.c2lnbmF0dXJl"


@pytest.fixture
def log_stream() -> Iterator[io.StringIO]:
    stream = io.StringIO()
    root = logging.getLogger()
    saved = (root.handlers[:], root.level)
    configure_logging("DEBUG")
    handler = root.handlers[0]
    assert isinstance(handler, logging.StreamHandler)
    handler.setStream(stream)
    yield stream
    root.handlers[:], root.level = saved[0], saved[1]


def test_redaction_masks_tokens_and_ticket_parameters() -> None:
    assert JWT not in redact(f"token {JWT}")
    assert "abc123" not in redact("Authorization: Bearer abc123def456")
    url = redact_url("/api/backlog/events?ticket=abc123&access_token=zzz999&project=p")
    assert "abc123" not in url and "zzz999" not in url and "project=p" in url


def test_logs_are_redacted_and_carry_the_request_id(log_stream: io.StringIO) -> None:
    token = request_id_var.set("req-9")
    try:
        logging.getLogger("backlog_api.test").warning(
            "GET /events?ticket=abc123 Bearer abc123def456", extra={"token": "zzz"}
        )
    finally:
        request_id_var.reset(token)
    text = log_stream.getvalue()
    assert "abc123" not in text and "zzz" not in text
    assert json.loads(text)["request_id"] == "req-9"


def test_telemetry_is_disabled_without_an_endpoint() -> None:
    assert not otlp_endpoint_configured({})
    assert otlp_endpoint_configured({"OTEL_EXPORTER_OTLP_ENDPOINT": "http://localhost:4317"})
    assert setup_telemetry("backlog-api", env={}, set_global=False) == Telemetry()


async def test_server_spans_are_recorded_with_a_redacted_ticket(
    settings: Settings, tokens: TokenFactory, database_url: str
) -> None:
    from backlog_api.auth.tokens import StaticKeySource

    spans = InMemorySpanExporter()
    telemetry = setup_telemetry("backlog-api", span_exporter=spans, set_global=False, env={})
    assert telemetry.enabled
    application = create_app(
        settings, key_source=StaticKeySource(tokens.jwks), configure_logs=False, telemetry=telemetry
    )
    async with LifespanManager(application, startup_timeout=30):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application), base_url="http://backlog-api.test"
        ) as client:
            await client.get(f"{API}/projects", headers=tokens.headers())
            await client.get(f"{API}/events?ticket=abc123secret")
    telemetry.shutdown()

    finished = spans.get_finished_spans()
    assert any(s.attributes and s.attributes.get("http.route") == f"{API}/projects" for s in finished)
    assert any(s.attributes and "db.system" in s.attributes for s in finished)
    assert "abc123secret" not in json.dumps([dict(s.attributes or {}) for s in finished], default=str)
