"""Heading- and page-aware chunking of source text for retrieval.

The input is the extracted source text: PDF pages are separated by a form feed (``\\f``, page *n* is the *n*-th part),
Markdown/plain text may contain ``#`` headings. Chunks never span a page break or a section (a heading without body
joins the section below it), are cut at paragraph or word boundaries (never mid-word) and overlap by a fraction of
the target size. Sizes are in characters (about four characters per token). The result is deterministic.
``char_start``/``char_end`` index into the full source text.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

PAGE_BREAK = "\f"
DEFAULT_TARGET_CHARS = 3200
DEFAULT_OVERLAP_RATIO = 0.15
MIN_TARGET_CHARS = 200
_FENCE = re.compile(r"^ {0,3}(```|~~~)")


def _match_heading(line: str) -> tuple[int, str] | None:
    """``(level, title)`` of an ATX heading line: ``^ {0,3}(#{1,6})[ \\t]+(.+?)[ \\t]*#*[ \\t]*$`` without regex.

    Computed in linear time: that regular expression backtracks cubically on long runs of spaces, which a source
    text (up to the extraction limit) can contain.
    """
    length = len(line)
    index = 0
    while index < length and line[index] == " ":
        index += 1
    if index > 3:
        return None
    level_end = index
    while level_end < length and line[level_end] == "#":
        level_end += 1
    level = level_end - index
    if not 1 <= level <= 6 or level_end >= length or line[level_end] not in " \t":
        return None
    lead = level_end
    while lead < length and line[lead] in " \t":
        lead += 1
    tail = length
    while tail > level_end and line[tail - 1] in " \t":
        tail -= 1
    while tail > level_end and line[tail - 1] == "#":
        tail -= 1
    while tail > level_end and line[tail - 1] in " \t":
        tail -= 1
    if lead < length:
        title = line[lead : max(tail, lead + 1)]
        return None if "\n" in title else (level, title)
    return (level, line[length - 1]) if length - level_end >= 2 else None


@dataclass(frozen=True, slots=True)
class Chunk:
    ordinal: int
    text: str
    heading_path: str | None
    page: int | None
    char_start: int
    char_end: int


@dataclass(slots=True)
class _Segment:
    start: int
    end: int
    heading_path: str | None
    page: int | None


def _segments(text: str) -> list[_Segment]:
    """Split into runs that share a page and a heading path (a heading line starts a new run)."""
    paged = PAGE_BREAK in text
    segments: list[_Segment] = []
    stack: list[tuple[int, str]] = []
    in_fence = False
    page_start = 0
    for page_number, page_text in enumerate(text.split(PAGE_BREAK), start=1):
        page = page_number if paged else None
        current = _Segment(page_start, page_start, _path(stack), page)
        offset = page_start
        for line in page_text.splitlines(keepends=True):
            stripped = line.rstrip("\r\n")
            if _FENCE.match(stripped):
                in_fence = not in_fence
            heading = None if in_fence else _match_heading(stripped)
            if heading:
                if current.end > current.start:
                    segments.append(current)
                level, title = heading[0], heading[1].strip()
                while stack and stack[-1][0] >= level:
                    stack.pop()
                stack.append((level, title))
                current = _Segment(offset, offset, _path(stack), page)
            offset += len(line)
            current.end = offset
        if current.end > current.start:
            segments.append(current)
        page_start += len(page_text) + 1
    return segments


def _path(stack: list[tuple[int, str]]) -> str | None:
    return " > ".join(title for _, title in stack) or None


def _merge_heading_only(text: str, segments: list[_Segment]) -> list[_Segment]:
    """Fold a heading that has no body of its own into the section below it (the deeper heading path wins)."""
    merged: list[_Segment] = []
    for segment in segments:
        previous = merged[-1] if merged else None
        if (
            previous is not None
            and previous.page == segment.page
            and previous.end == segment.start
            and _match_heading(text[previous.start : previous.end].strip())
        ):
            previous.end = segment.end
            previous.heading_path = segment.heading_path
        else:
            merged.append(_Segment(segment.start, segment.end, segment.heading_path, segment.page))
    return merged


def _cut(text: str, start: int, limit: int, target: int) -> int:
    """End of the window starting at ``start``: a paragraph, line or word boundary at or before ``limit``."""
    if limit - start <= target:
        return limit
    end = start + target
    for separator in ("\n\n", "\n", " ", "\t"):
        found = text.rfind(separator, start + target // 2, end)
        if found != -1:
            return found + len(separator)
    # No whitespace at all (e.g. a very long token): extend to the next boundary instead of splitting the word.
    match = re.compile(r"\s").search(text, end, limit)
    return match.end() if match else limit


def _next_start(text: str, start: int, end: int, overlap: int, limit: int) -> int:
    candidate = max(end - overlap, start + 1)
    if candidate >= limit:
        return limit
    if text[candidate - 1].isspace():
        return candidate
    match = re.compile(r"\s").search(text, candidate, end)
    return match.end() if match else end


def chunk_text(
    text: str, *, target_chars: int = DEFAULT_TARGET_CHARS, overlap_ratio: float = DEFAULT_OVERLAP_RATIO
) -> list[Chunk]:
    """Chunk ``text``; see the module docstring. Blank input yields no chunks."""
    target = max(target_chars, MIN_TARGET_CHARS)
    overlap = int(target * min(max(overlap_ratio, 0.0), 0.5))
    chunks: list[Chunk] = []
    for segment in _merge_heading_only(text, _segments(text)):
        start = segment.start
        while start < segment.end:
            end = _cut(text, start, segment.end, target)
            body = text[start:end]
            lead = len(body) - len(body.lstrip())
            trimmed = body.strip()
            if trimmed:
                chunks.append(
                    Chunk(
                        len(chunks),
                        trimmed,
                        segment.heading_path,
                        segment.page,
                        start + lead,
                        start + lead + len(trimmed),
                    )
                )
            if end >= segment.end:
                break
            start = _next_start(text, start, end, overlap, segment.end)
    return chunks
