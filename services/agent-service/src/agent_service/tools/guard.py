"""Argument guard for the agent tools: concise validation errors and the retry cap.

Model-facing argument schemas come from ``contracts/schemas`` (rich descriptions); MAF only checks them shallowly. This
function middleware validates the arguments with the strict Pydantic contract model of the tool before the tool runs
and turns every failure into a *concise* tool error for the model (MAF's own message carries no detail). A tool body
signals bad input (for example an edited proposal that is not a subset of the original) with :class:`ToolInputError`,
which the tool wrapper turns into the same counted error with :func:`guarded`.

Both kinds of failure count per tool and per run (:func:`reject`). The first ``MAX_INVALID_ATTEMPTS - 1`` failures ask
the model to fix the arguments; the last one (and every later call in the same run, which is not executed at all) is a
final error that tells the model to stop retrying and explain the problem to the user. A failure may also push AG-UI
state (the tool's ``error_state``), for example ``{"preview": null}`` so a rejected review does not stay on screen.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from agent_framework import Content, FunctionInvocationContext, FunctionMiddleware
from agent_framework_ag_ui import state_update
from pydantic import BaseModel, ValidationError

from agent_service.mcp_client import current_run_scope
from agent_service.tools import ToolSpec

logger = logging.getLogger(__name__)

MAX_INVALID_ATTEMPTS = 2
FAILURES_CACHE_KEY = "tool_argument_failures"
"""``RunMcpScope.cache`` key of the per-run failure counters (tool name -> failed attempts)."""

_MAX_ERRORS_SHOWN = 5
_MAX_DETAIL_CHARS = 600


class ToolInputError(Exception):
    """The (possibly user-edited) arguments are unusable; the message goes to the model verbatim."""


def describe_validation_error(error: ValidationError) -> str:
    """``path: message`` for the first few problems; never echoes the input values."""
    parts = [
        f"{'.'.join(str(step) for step in item['loc']) or 'arguments'}: {item['msg']}"
        for item in error.errors(include_url=False, include_input=False, include_context=False)[:_MAX_ERRORS_SHOWN]
    ]
    more = error.error_count() - len(parts)
    text = "; ".join(parts) + (f"; and {more} more problems" if more > 0 else "")
    return text[:_MAX_DETAIL_CHARS]


def validate_arguments[ModelT: BaseModel](model: type[ModelT], arguments: Mapping[str, Any]) -> ModelT:
    """Validate with the contract model; raises :class:`ToolInputError` with a concise message."""
    try:
        return model.model_validate(dict(arguments))
    except ValidationError as exc:
        raise ToolInputError(describe_validation_error(exc)) from exc


def _failures() -> dict[str, int] | None:
    scope = current_run_scope()
    return scope.cache.setdefault(FAILURES_CACHE_KEY, {}) if scope is not None else None


def _outcome(text: str, spec: ToolSpec) -> Content | str:
    return state_update(text=text, state=dict(spec.error_state)) if spec.error_state else text


async def guarded(name: str, error_state: Mapping[str, Any] | None, work: Awaitable[Any]) -> Any:
    """Run a tool body; :class:`ToolInputError` becomes the counted, concise tool error (and the ``error_state``)."""
    try:
        return await work
    except ToolInputError as exc:
        return reject(name, str(exc), error_state)


def reject(name: str, detail: str, error_state: Mapping[str, Any] | None) -> Content | str:
    """The tool result for invalid arguments; counts the failure against the run's cap."""
    failures = _failures()
    attempts = 1
    if failures is not None:
        attempts = failures[name] = failures.get(name, 0) + 1
    logger.info("Invalid tool arguments", extra={"tool": name, "attempt": attempts})
    if attempts >= MAX_INVALID_ATTEMPTS:
        text = _final(name, detail)
    else:
        text = f"Error: invalid arguments for {name}: {detail}. Fix the arguments and call {name} again."
    return state_update(text=text, state=dict(error_state)) if error_state else text


def _final(name: str, detail: str) -> str:
    return (
        f"Error: {name} failed because of invalid arguments ({detail}). Do not call {name} again in this turn; "
        "explain the problem to the user in your reply instead."
    )


class ToolInputGuard(FunctionMiddleware):
    """Validates the arguments before the tool runs and refuses calls once the retry cap is reached."""

    def __init__(self, specs: Mapping[str, ToolSpec]) -> None:
        self._specs = specs

    async def process(self, context: FunctionInvocationContext, call_next: Callable[[], Awaitable[None]]) -> None:
        name = context.function.name
        spec = self._specs.get(name)
        if spec is None:
            await call_next()
            return
        failures = _failures()
        if failures is not None and failures.get(name, 0) >= MAX_INVALID_ATTEMPTS:
            text = _final(name, "it was called with invalid arguments repeatedly")
            context.result = state_update(text=text, state=dict(spec.error_state)) if spec.error_state else text
            return
        if spec.arguments is not None:
            try:
                validate_arguments(spec.arguments, _as_mapping(context.arguments))
            except ToolInputError as exc:
                context.result = reject(name, str(exc), spec.error_state)
                return
        await call_next()


def _as_mapping(arguments: Any) -> Mapping[str, Any]:
    if isinstance(arguments, BaseModel):
        return arguments.model_dump(by_alias=True)
    return arguments if isinstance(arguments, Mapping) else {}
