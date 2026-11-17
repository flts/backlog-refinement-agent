"""Service metrics (OpenTelemetry instruments; no-ops until a meter provider is configured).

Attributes are low-cardinality only: agent id, outcome / error code, tool name, MCP server.
Never user, thread or content.
"""

from __future__ import annotations

from opentelemetry import metrics as otel_metrics
from opentelemetry.metrics import Counter, Histogram, MeterProvider

METER_NAME = "agent_service"


class AgentMetrics:
    def __init__(self, provider: MeterProvider | None = None) -> None:
        meter = provider.get_meter(METER_NAME) if provider is not None else otel_metrics.get_meter(METER_NAME)
        self.runs_started: Counter = meter.create_counter(
            "agent.runs.started", unit="{run}", description="AG-UI agent runs started (hydrate requests excluded)."
        )
        self.runs_completed: Counter = meter.create_counter(
            "agent.runs.completed",
            unit="{run}",
            description="Runs that ended without RUN_ERROR; outcome = finished | interrupted | cancelled.",
        )
        self.runs_failed: Counter = meter.create_counter(
            "agent.runs.failed", unit="{run}", description="Runs that ended with a RUN_ERROR; code = RunErrorCode."
        )
        self.run_duration: Histogram = meter.create_histogram(
            "agent.run.duration", unit="s", description="Wall-clock duration of a run."
        )
        self.runs_rejected: Counter = meter.create_counter(
            "agent.runs.rejected",
            unit="{run}",
            description="Runs refused before streaming; reason = rate_limited | thread_busy.",
        )
        self.tool_calls: Counter = meter.create_counter(
            "agent.tool.calls", unit="{call}", description="Tool invocations by tool and outcome (ok | error)."
        )
        self.tool_duration: Histogram = meter.create_histogram(
            "agent.tool.duration", unit="s", description="Tool invocation duration."
        )
        self.mcp_call_duration: Histogram = meter.create_histogram(
            "agent.mcp.call.duration",
            unit="s",
            description="MCP call latency (also tool=connect for the per-run connect).",
        )
        self.snapshot_save_failures: Counter = meter.create_counter(
            "agent.snapshot.save_failures",
            unit="{failure}",
            description="Thread snapshot saves that failed (Agent Framework swallows them).",
        )


_instance: AgentMetrics | None = None


def bind_metrics(provider: MeterProvider | None = None) -> AgentMetrics:
    """(Re)create the instruments on ``provider`` (default: the global meter provider)."""
    global _instance
    _instance = AgentMetrics(provider)
    return _instance


def get_metrics() -> AgentMetrics:
    return _instance if _instance is not None else bind_metrics()
