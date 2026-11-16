"""Timeline rows: ``STEP_STARTED`` / ``STEP_FINISHED`` events injected into the AG-UI stream.

MAF agents emit no ``STEP_*`` events, so :class:`StepTracker` derives them from the stream the runner produces:

* "Reading item" spans the run start (the context providers read the item and the pinned sources) until the model
  produces its first output,
* every tool call of :data:`TOOL_STEPS` becomes a row ("Searching sources", "Drafting proposal", ...), started with
  ``TOOL_CALL_START`` and finished with its ``TOOL_CALL_RESULT`` (``TOOL_CALL_END`` for the proposal tools, whose
  result only arrives after the user's review in a later run).

The ``@ag-ui/client`` verifier rejects a step that starts twice while active and any event after the run ended, so
step names are reference-counted and every open step is finished before ``RUN_FINISHED`` / ``RUN_ERROR``.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

from ag_ui.core import (
    BaseEvent,
    EventType,
    StepFinishedEvent,
    StepStartedEvent,
)

RUN_START_STEP = "Reading item"

TOOL_STEPS: dict[str, str] = {
    "get_item_context": "Reading item",
    "get_pinned_sources": "Reading pinned sources",
    "get_project_guidance": "Loading guidance",
    "load_skill": "Loading guidance",
    "read_skill_resource": "Loading guidance",
    "search_sources": "Searching sources",
    "find_similar_items": "Finding similar items",
    "propose_document_changes": "Drafting proposal",
    "propose_child_items": "Drafting breakdown",
    "record_quality_assessment": "Assessing quality",
}
FINISH_AT_END = frozenset({"propose_document_changes", "propose_child_items"})

_RUN_START_DONE = frozenset(
    {EventType.TEXT_MESSAGE_START, EventType.TOOL_CALL_START, EventType.RUN_FINISHED, EventType.RUN_ERROR}
)


class StepTracker:
    def __init__(self, *, run_start_step: str | None = RUN_START_STEP) -> None:
        self._run_start_step = run_start_step
        self._run_start_open = False
        self._active: dict[str, set[str]] = {}
        self._calls: dict[str, tuple[str, bool]] = {}

    def process(self, event: BaseEvent) -> Iterator[BaseEvent]:
        """Yield the events to send for ``event`` (injected steps around the event itself)."""
        kind = event.type
        if self._run_start_open and kind in _RUN_START_DONE:
            self._run_start_open = False
            yield StepFinishedEvent(step_name=self._run_start_step or "")
        if kind in (EventType.RUN_FINISHED, EventType.RUN_ERROR):
            yield from self._finish_all()
            yield event
            return
        if kind == EventType.TOOL_CALL_START:
            yield event
            yield from self._start_tool(event)
            return
        if kind == EventType.TOOL_CALL_END:
            yield event
            yield from self._finish_call(event, only_at_end=True)
            return
        if kind == EventType.TOOL_CALL_RESULT:
            yield event
            yield from self._finish_call(event, only_at_end=False)
            return
        yield event
        if kind == EventType.RUN_STARTED and self._run_start_step:
            self._run_start_open = True
            yield StepStartedEvent(step_name=self._run_start_step)

    def _start_tool(self, event: Any) -> Iterator[BaseEvent]:
        step = TOOL_STEPS.get(event.tool_call_name)
        if step is None:
            return
        self._calls[event.tool_call_id] = (step, event.tool_call_name in FINISH_AT_END)
        calls = self._active.setdefault(step, set())
        if not calls:
            yield StepStartedEvent(step_name=step)
        calls.add(event.tool_call_id)

    def _finish_call(self, event: Any, *, only_at_end: bool) -> Iterator[BaseEvent]:
        call = self._calls.get(event.tool_call_id)
        if call is None:
            return
        step, at_end = call
        if only_at_end and not at_end:
            return
        del self._calls[event.tool_call_id]
        calls = self._active.get(step)
        if calls is None:
            return
        calls.discard(event.tool_call_id)
        if not calls:
            del self._active[step]
            yield StepFinishedEvent(step_name=step)

    def _finish_all(self) -> Iterator[BaseEvent]:
        for step in list(self._active):
            yield StepFinishedEvent(step_name=step)
        self._active.clear()
        self._calls.clear()
