"""OpenTelemetry setup (traces, metrics, logs) from the standard ``OTEL_*`` environment variables.

Telemetry is enabled only when an OTLP endpoint is configured (``OTEL_EXPORTER_OTLP_ENDPOINT`` or a per-signal
``OTEL_EXPORTER_OTLP_{TRACES,METRICS,LOGS}_ENDPOINT``) and ``OTEL_SDK_DISABLED`` is not true. Aspire injects the
endpoint, protocol, service name and resource attributes into the process, so nothing else needs configuring locally.
Exporters pick up their own settings (headers, timeout, certificates, compression) from the standard variables.

Privacy: spans, metrics and log records carry IDs and metadata only. The log bridge redacts secrets and never exports
exception text. Kept in step with ``agent_service.telemetry``.
"""

from __future__ import annotations

import copy
import logging
import os
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any
from urllib.parse import unquote

from opentelemetry import metrics as otel_metrics
from opentelemetry import trace
from opentelemetry._logs import set_logger_provider
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor, LogRecordExporter, SimpleLogRecordProcessor
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import MetricExporter, MetricReader, PeriodicExportingMetricReader
from opentelemetry.sdk.resources import SERVICE_NAME, SERVICE_VERSION, Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, SimpleSpanProcessor, SpanExporter

from backlog_api.observability import (
    REDACTED,
    ContextFilter,
    RedactionFilter,
    redact,
    redact_field,
    redact_url,
)

logger = logging.getLogger(__name__)

_ENDPOINT_VARIABLES = (
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
    "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
)
EXCLUDED_URLS = "healthz,readyz"
_URL_ATTRIBUTES = ("http.url", "http.target", "url.full", "url.path")
_QUERY_ATTRIBUTES = ("url.query",)


def otlp_endpoint_configured(env: Mapping[str, str] | None = None) -> bool:
    env = os.environ if env is None else env
    if env.get("OTEL_SDK_DISABLED", "").strip().lower() == "true":
        return False
    return any(env.get(name, "").strip() for name in _ENDPOINT_VARIABLES)


def _protocol(signal: str, env: Mapping[str, str]) -> str:
    value = env.get(f"OTEL_EXPORTER_OTLP_{signal}_PROTOCOL") or env.get("OTEL_EXPORTER_OTLP_PROTOCOL") or "grpc"
    value = value.strip().lower()
    if value == "http/json":
        logger.warning("OTLP http/json is not supported, using http/protobuf")
        return "http/protobuf"
    return value if value in ("grpc", "http/protobuf") else "grpc"


def _span_exporter(env: Mapping[str, str]) -> SpanExporter:
    if _protocol("TRACES", env) == "grpc":
        from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter as Grpc

        return Grpc()
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter as Http

    return Http()


def _metric_exporter(env: Mapping[str, str]) -> MetricExporter:
    if _protocol("METRICS", env) == "grpc":
        from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import OTLPMetricExporter as Grpc

        return Grpc()
    from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter as Http

    return Http()


def _log_exporter(env: Mapping[str, str]) -> LogRecordExporter:
    if _protocol("LOGS", env) == "grpc":
        from opentelemetry.exporter.otlp.proto.grpc._log_exporter import OTLPLogExporter as Grpc

        return Grpc()
    from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter as Http

    return Http()


def _resource(service_name: str, version: str | None, environment: str | None, env: Mapping[str, str]) -> Resource:
    attributes: dict[str, Any] = {}
    if version:
        attributes[SERVICE_VERSION] = version
    if environment:
        attributes["deployment.environment.name"] = environment
    for pair in env.get("OTEL_RESOURCE_ATTRIBUTES", "").split(","):
        key, separator, value = pair.partition("=")
        if separator and key.strip():
            attributes[key.strip()] = unquote(value.strip())
    # OTEL_SERVICE_NAME / service.name in OTEL_RESOURCE_ATTRIBUTES win over the code default.
    if env.get("OTEL_SERVICE_NAME"):
        attributes[SERVICE_NAME] = env["OTEL_SERVICE_NAME"]
    attributes.setdefault(SERVICE_NAME, service_name)
    return Resource.create(attributes)


class SafeLoggingHandler(LoggingHandler):
    """OpenTelemetry log bridge that exports redacted messages, redacted ``extra`` fields and no exception text."""

    def emit(self, record: logging.LogRecord) -> None:
        safe = copy.copy(record)
        safe.msg, safe.args = redact(record.getMessage()), None
        if record.exc_info and record.exc_info[0] is not None:
            safe.__dict__["exc_type"] = record.exc_info[0].__name__
        safe.exc_info, safe.exc_text, safe.stack_info = None, None, None
        for key, value in list(safe.__dict__.items()):
            if key not in _STANDARD_FIELDS and not key.startswith("_"):
                safe.__dict__[key] = redact_field(key, value)
        super().emit(safe)


_STANDARD_FIELDS = frozenset(vars(logging.makeLogRecord({})).keys()) | {"message", "asctime", "taskName"}


def redact_server_span(span: Any, scope: Mapping[str, Any]) -> None:
    """``server_request_hook``: mask ``access_token`` / ``ticket`` / secret query parameters on the server span."""
    attributes = getattr(span, "attributes", None) or {}
    for key in _URL_ATTRIBUTES:
        value = attributes.get(key)
        if isinstance(value, str) and "?" in value:
            span.set_attribute(key, redact_url(value))
    for key in _QUERY_ATTRIBUTES:
        value = attributes.get(key)
        if isinstance(value, str):
            span.set_attribute(key, redact_url(f"?{value}")[1:] or REDACTED)


@dataclass
class Telemetry:
    """The configured providers; :attr:`enabled` is false when no OTLP endpoint (or test exporter) was given."""

    enabled: bool = False
    tracer_provider: TracerProvider | None = None
    meter_provider: MeterProvider | None = None
    logger_provider: LoggerProvider | None = None
    log_handler: logging.Handler | None = None
    instrumented_libraries: bool = False

    def instrument_app(self, app: Any) -> None:
        if not self.enabled:
            return
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

        FastAPIInstrumentor.instrument_app(
            app,
            tracer_provider=self.tracer_provider,
            meter_provider=self.meter_provider,
            excluded_urls=EXCLUDED_URLS,
            server_request_hook=redact_server_span,
            exclude_spans=["receive", "send"],
        )

    def shutdown(self) -> None:
        if not self.enabled:
            return
        if self.log_handler is not None:
            logging.getLogger().removeHandler(self.log_handler)
        if self.instrumented_libraries:
            from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
            from opentelemetry.instrumentation.sqlalchemy import SQLAlchemyInstrumentor

            HTTPXClientInstrumentor().uninstrument()
            SQLAlchemyInstrumentor().uninstrument()
            self.instrumented_libraries = False
        for provider in (self.tracer_provider, self.meter_provider, self.logger_provider):
            if provider is not None:
                try:
                    provider.shutdown()
                except Exception:  # best effort: the exporter may be unreachable
                    logger.warning("Could not flush telemetry on shutdown", exc_info=True)
        self.enabled = False


def setup_telemetry(
    service_name: str,
    *,
    version: str | None = None,
    environment: str | None = None,
    span_exporter: SpanExporter | None = None,
    metric_reader: MetricReader | None = None,
    log_exporter: LogRecordExporter | None = None,
    set_global: bool = True,
    env: Mapping[str, str] | None = None,
) -> Telemetry:
    """Create the providers and instrument httpx and SQLAlchemy.

    Returns a disabled :class:`Telemetry` without an OTLP endpoint. ``span_exporter`` / ``metric_reader`` /
    ``log_exporter`` replace the OTLP exporters (tests). ``set_global=False`` keeps the process-wide
    OpenTelemetry providers untouched (tests).
    """
    env = os.environ if env is None else env
    injected = span_exporter is not None or metric_reader is not None or log_exporter is not None
    if not injected and not otlp_endpoint_configured(env):
        return Telemetry()

    resource = _resource(service_name, version, environment, env)
    tracer_provider = TracerProvider(resource=resource)
    if span_exporter is not None:
        tracer_provider.add_span_processor(SimpleSpanProcessor(span_exporter))
    elif not injected:
        tracer_provider.add_span_processor(BatchSpanProcessor(_span_exporter(env)))

    readers: list[MetricReader] = []
    if metric_reader is not None:
        readers.append(metric_reader)
    elif not injected:
        readers.append(PeriodicExportingMetricReader(_metric_exporter(env)))
    meter_provider = MeterProvider(resource=resource, metric_readers=readers)

    logger_provider = LoggerProvider(resource=resource)
    if log_exporter is not None:
        logger_provider.add_log_record_processor(SimpleLogRecordProcessor(log_exporter))
    elif not injected:
        logger_provider.add_log_record_processor(BatchLogRecordProcessor(_log_exporter(env)))
    handler = SafeLoggingHandler(level=logging.NOTSET, logger_provider=logger_provider)
    handler.addFilter(RedactionFilter())
    handler.addFilter(ContextFilter())
    logging.getLogger().addHandler(handler)

    if set_global:
        trace.set_tracer_provider(tracer_provider)
        otel_metrics.set_meter_provider(meter_provider)
        set_logger_provider(logger_provider)

    from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
    from opentelemetry.instrumentation.sqlalchemy import SQLAlchemyInstrumentor

    # SQLAlchemy is patched at engine creation: set up telemetry before the database is created (create_app does).
    HTTPXClientInstrumentor().instrument(tracer_provider=tracer_provider, meter_provider=meter_provider)
    # skip_dep_check: the instrumentor's declared range stops below SQLAlchemy 2.1, whose engine events are unchanged.
    SQLAlchemyInstrumentor().instrument(
        tracer_provider=tracer_provider, meter_provider=meter_provider, skip_dep_check=True
    )
    logger.info("OpenTelemetry enabled", extra={"service_name": service_name})
    return Telemetry(
        enabled=True,
        tracer_provider=tracer_provider,
        meter_provider=meter_provider,
        logger_provider=logger_provider,
        log_handler=handler,
        instrumented_libraries=True,
    )
