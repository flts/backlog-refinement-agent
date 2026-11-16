"""Helpers for placeholder-free Markdown backlog templates (mirrors ``apps/web/src/domain/document.ts``)."""

from __future__ import annotations

import re

_HEADING_RE = re.compile(r"^##\s+(.+?)\s*#*\s*$")
_FENCE_RE = re.compile(r"^\s*```")
_HINT_RE = re.compile(r"<!--.*?-->", re.DOTALL)


def strip_hints(markdown: str) -> str:
    """Remove HTML comments, which templates use as hints for the agent."""
    return _HINT_RE.sub("", markdown)


def template_headings(template: str) -> list[str]:
    """Return the top-level (``## ``) headings of a template, ignoring hints and fenced code."""
    headings: list[str] = []
    in_fence = False
    for line in strip_hints(template).replace("\r\n", "\n").split("\n"):
        if _FENCE_RE.match(line):
            in_fence = not in_fence
        match = None if in_fence else _HEADING_RE.match(line)
        if match:
            headings.append(match.group(1).strip())
    return headings


def validate_template(template: str) -> list[str]:
    """Return validation errors for a template; an empty list means the template is valid."""
    return [
        f"Line {number} contains a '{{{{…}}}}' placeholder; templates must be placeholder-free Markdown."
        for number, line in enumerate(template.splitlines(), start=1)
        if "{{" in line
    ]
