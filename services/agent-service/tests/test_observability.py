"""Log redaction, correlation, content logging off, OpenTelemetry on/off and the metrics."""

from __future__ import annotations

import io
import json
import logging
from collections.abc import Iterator

import httpx
import pytest
from opentelemetry.sdk._logs.export import InMemoryLogRecordExporter
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from agent_service.limits import ThreadRunLocks
from agent_service.observability import (
    JsonFormatter,
    RedactionFilter,
    configure_logging,
    redact,
    redact_url,
    request_id_var,
)
from agent_service.telemetry import Telemetry, otlp_endpoint_configured, setup_telemetry
from agent_service_testkit import TokenFactory, create_thread, run_agui
from conftest import AppFactory

JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.c2lnbmF0dXJl"
USER = {"id": "m1", "role": "user", "content": "my secret prompt text"}


@pytest.fixture
def log_stream() -> Iterator[io.StringIO]:
    stream = io.StringIO()
    root = logging.getLogger()
    saved = (root.handlers[:], root.level)
    configure_logging("DEBUG", stream=stream)
    yield stream
    root.handlers[:], root.level = saved[0], saved[1]


def lines(stream: io.StringIO) -> list[dict[str, object]]:
    return [json.loads(line) for line in stream.getvalue().splitlines() if line.strip()]


def test_redaction_masks_tokens_and_secret_parameters() -> None:
    assert JWT not in redact(f"token {JWT} seen")
    assert "abc123" not in redact("Authorization: Bearer abc123def456")
    assert "abc123" not in redact('{"access_token": "abc123", "ok": 1}')
    assert "abc123" not in redact("password=abc123&x=1")
    assert redact("plain text") == "plain text"
    url = redact_url("/api/events?ticket=abc123&project=p&access_token=zzz999")
    assert "abc123" not in url and "zzz999" not in url and "project=p" in url


def test_json_logs_redact_fields_messages_and_exceptions_and_carry_correlation(log_stream: io.StringIO) -> None:
    logger = logging.getLogger("agent_service.test")
    token = request_id_var.set("req-1")
    try:
        try:
            raise ValueError(f"bad Bearer {JWT}")
        except ValueError:
            logger.exception("failed for Authorization: Bearer abc123def456", extra={"access_token": "zzz999", "n": 1})
    finally:
        request_id_var.reset(token)
    text = log_stream.getvalue()
    for secret in (JWT, "abc123def456", "zzz999"):
        assert secret not in text
    record = lines(log_stream)[0]
    assert record["request_id"] == "req-1" and record["n"] == 1 and record["exc_type"] == "ValueError"


def test_third_party_records_are_redacted_by_the_handler_filter(log_stream: io.StringIO) -> None:
    logging.getLogger("some.library").warning("GET http://x/stream?ticket=abc123 failed")
    assert "abc123" not in log_stream.getvalue()


def test_formatter_and_filter_work_standalone() -> None:
    record = logging.LogRecord("n", logging.INFO, __file__, 1, "token=%s", ("abc123",), None)
    RedactionFilter().filter(record)
    assert "abc123" not in JsonFormatter().format(record)


async def test_a_run_with_secret_looking_values_does_not_log_them(
    app_factory: AppFactory, tokens: TokenFactory, gateway: httpx.AsyncClient, log_stream: io.StringIO
) -> None:
    secret_token = tokens.issue()
    client = await app_factory()
    thread = await create_thread(client, tokens)
    await gateway.post("/_script", json={"responses": [{"text": "assistant reply content"}]})
    response = await client.post(
        f"/api/agent/agents/backlog-refiner?access_token={secret_token}&ticket=tkt-123456",
        json={
            "threadId": thread["id"],
            "runId": "r1",
            "messages": [USER],
            "tools": [],
            "context": [],
            "state": {},
        },
        headers=tokens.headers(),
    )
    assert response.status_code == 200
    text = log_stream.getvalue()
    assert text, "the run should have produced log lines"
    for forbidden in (secret_token, "tkt-123456", "my secret prompt text", "assistant reply content"):
        assert forbidden not in text
    assert tokens.headers()["Authorization"].split()[-1] not in text


def test_telemetry_is_disabled_without_an_endpoint() -> None:
    assert not otlp_endpoint_configured({})
    assert not otlp_endpoint_configured({"OTEL_EXPORTER_OTLP_ENDPOINT": "http://x", "OTEL_SDK_DISABLED": "true"})
    assert otlp_endpoint_configured({"OTEL_EXPORTER_OTLP_ENDPOINT": "http://x:4317"})
    telemetry = setup_telemetry("agent-service", env={}, set_global=False)
    assert telemetry == Telemetry() and not telemetry.enabled
    telemetry.instrument_app(object())  # no-op
    telemetry.shutdown()


async def test_spans_logs_and_metrics_are_recorded_when_enabled(
    app_factory: AppFactory, tokens: TokenFactory, gateway: httpx.AsyncClient
) -> None:
    spans, logs, reader = InMemorySpanExporter(), InMemoryLogRecordExporter(), InMemoryMetricReader()
    telemetry = setup_telemetry(
        "agent-service",
        version="1",
        span_exporter=spans,
        log_exporter=logs,
        metric_reader=reader,
        set_global=False,
        env={"OTEL_SERVICE_NAME": "custom-name", "OTEL_RESOURCE_ATTRIBUTES": "team=x"},
    )
    assert telemetry.enabled
    client = await app_factory(telemetry=telemetry, rate_limit_runs_per_minute=1, rate_limit_burst=1)
    thread = await create_thread(client, tokens)
    await gateway.post("/_script", json={"responses": [{"text": "hi"}]})
    assert (await run_agui(client, tokens, thread["id"], [USER]))[0] == 200
    assert (await run_agui(client, tokens, thread["id"], [USER]))[0] == 429  # rate limited
    telemetry.shutdown()

    finished = spans.get_finished_spans()
    run_spans = [s for s in finished if "agents" in str((s.attributes or {}).get("http.route"))]
    assert run_spans
    run_span = run_spans[0]
    assert (run_span.attributes or {}).get("agent.id") == "backlog-refiner"
    assert run_span.resource.attributes["service.name"] == "custom-name"
    assert run_span.resource.attributes["team"] == "x"
    assert any(s.name != run_span.name and s.attributes and "db.system" in s.attributes for s in finished)  # SQLAlchemy

    for record in logs.get_finished_logs():
        assert "my secret prompt text" not in str(record.log_record.body)
        assert record.log_record.span_id is not None

    data = reader.get_metrics_data()
    assert data is not None
    points: dict[str, list[tuple[dict[str, object], float]]] = {}
    for resource_metrics in data.resource_metrics:
        for scope in resource_metrics.scope_metrics:
            for metric in scope.metrics:
                for point in metric.data.data_points:
                    value = getattr(point, "value", getattr(point, "count", 0))
                    points.setdefault(metric.name, []).append((dict(point.attributes or {}), value))
    assert points["agent.runs.started"] == [({"agent": "backlog-refiner"}, 1)]
    assert points["agent.runs.completed"] == [({"agent": "backlog-refiner", "outcome": "finished"}, 1)]
    assert points["agent.runs.rejected"] == [({"reason": "rate_limited"}, 1)]
    assert points["agent.run.duration"][0][1] == 1


async def test_failure_and_save_failure_metrics(
    app_factory: AppFactory, tokens: TokenFactory, gateway: httpx.AsyncClient
) -> None:
    reader = InMemoryMetricReader()
    telemetry = setup_telemetry("agent-service", metric_reader=reader, set_global=False, env={})
    client = await app_factory(telemetry=telemetry, run_timeout_seconds=0.2)
    thread = await create_thread(client, tokens)
    await gateway.post("/_script", json={"responses": [{"text": "slow", "delay": 5}]})
    await run_agui(client, tokens, thread["id"], [USER])

    from agent_service.metrics import get_metrics

    get_metrics().snapshot_save_failures.add(1)
    data = reader.get_metrics_data()
    assert data is not None
    names = {m.name: m for rm in data.resource_metrics for sm in rm.scope_metrics for m in sm.metrics}
    failed = names["agent.runs.failed"].data.data_points[0]
    assert dict(failed.attributes or {}) == {"agent": "backlog-refiner", "code": "RUN_TIMEOUT"}
    assert getattr(names["agent.snapshot.save_failures"].data.data_points[0], "value", None) == 1
    telemetry.shutdown()


def test_thread_lock_registry_is_empty_after_use() -> None:
    locks = ThreadRunLocks()
    permit = locks.try_acquire("s", "t")
    assert permit is not None and len(locks) == 1
    permit.release()
    assert len(locks) == 0
