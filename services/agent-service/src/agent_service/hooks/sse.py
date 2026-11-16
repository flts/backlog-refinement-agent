"""Minimal Server-Sent Events parser (WHATWG event-stream format) for the hook subscriber."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class SseEvent:
    event: str
    data: str
    id: str | None = None


class SseParser:
    """Feed it one line at a time (without the line terminator); returns an event when a blank line completes one.

    Comment lines (``: keepalive``) are ignored. ``retry:`` updates :attr:`retry_milliseconds`.
    """

    def __init__(self) -> None:
        self.retry_milliseconds: int | None = None
        self._event = ""
        self._data: list[str] = []
        self._id: str | None = None

    def feed(self, line: str) -> SseEvent | None:
        if line == "":
            return self._dispatch()
        if line.startswith(":"):
            return None
        field, _, value = line.partition(":")
        value = value.removeprefix(" ")
        if field == "event":
            self._event = value
        elif field == "data":
            self._data.append(value)
        elif field == "id":
            if "\x00" not in value:
                self._id = value
        elif field == "retry" and value.isascii() and value.isdigit():
            self.retry_milliseconds = int(value)
        return None

    def _dispatch(self) -> SseEvent | None:
        event_id, name, data = self._id, self._event, self._data
        self._event, self._data, self._id = "", [], None
        if not data and not name:
            return None
        return SseEvent(event=name or "message", data="\n".join(data), id=event_id)
