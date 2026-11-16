"""Authoritative Python port of ``apps/web/src/domain/document.ts`` (section-based Markdown documents).

Semantics are identical to the TypeScript implementation; the shared golden fixtures in
``contracts/fixtures/document/`` keep both in sync. On top of the port this module provides what the server needs for
optimistic concurrency: :func:`document_hash` and :func:`changed_sections`.

Level-2 headings (``## …``) split a document into sections; deeper headings stay inside the section body.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Literal

# JavaScript's ``\s`` / ``String.prototype.trim`` whitespace set (differs from Python's in a few code points).
_JS_WHITESPACE = (
    "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000\ufeff"
)
_WS = f"[{_JS_WHITESPACE}]"
# JavaScript's ``.`` does not match line terminators.
_ANY = "[^\n\r\u2028\u2029]"

_HEADING_RE = re.compile(rf"^##{_WS}+({_ANY}+?){_WS}*#*{_WS}*$")
_TASK_RE = re.compile(rf"^({_WS}*[-*]{_WS}+)\[( |x|X)\]{_WS}?({_ANY}*)$")
_FENCE_RE = re.compile(rf"^{_WS}*```")
_ASSUMPTION_RE = re.compile(r"assumption|aanname", re.IGNORECASE)
_QUESTION_RE = re.compile(rf"open{_WS}+question|open{_WS}+vra|openstaande{_WS}+vra", re.IGNORECASE)
_HINT_RE = re.compile(r"<!--[\s\S]*?-->")
_LEADING_HASHES_RE = re.compile(rf"^#+{_WS}*")
_WS_RUN_RE = re.compile(f"{_WS}+")

PREAMBLE_SECTION = "(preamble)"
"""Pseudo heading used by :func:`changed_sections` when the text before the first ``##`` heading changed."""

UpdateMode = Literal["replace", "append"]
ChecklistKind = Literal["assumption", "question"]


@dataclass(slots=True)
class DocumentSection:
    heading: str
    body: str


@dataclass(slots=True)
class SplitDocument:
    preamble: str
    sections: list[DocumentSection] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class SectionUpdate:
    heading: str
    markdown: str
    mode: UpdateMode = "replace"


@dataclass(frozen=True, slots=True)
class ApplyResult:
    document: str
    warnings: list[str]


@dataclass(frozen=True, slots=True)
class DocumentDiff:
    added: list[str]
    removed: list[str]


@dataclass(frozen=True, slots=True)
class ChecklistEntry:
    kind: ChecklistKind
    text: str
    checked: bool
    line: int


@dataclass(frozen=True, slots=True)
class ConformResult:
    document: str
    extra_headings: list[str]


def _trim(value: str) -> str:
    return value.strip(_JS_WHITESPACE)


def _lines(document: str) -> list[str]:
    return document.replace("\r\n", "\n").split("\n")


def _js_length(value: str) -> int:
    """String length in UTF-16 code units, as ``String.prototype.length``."""
    return len(value.encode("utf-16-le")) // 2


def normalize_heading(heading: str) -> str:
    stripped = _LEADING_HASHES_RE.sub("", _trim(heading), count=1)
    return _WS_RUN_RE.sub(" ", stripped).lower()


def split_sections(document: str) -> SplitDocument:
    """Level-2 headings split the document; deeper headings stay inside the section body."""
    preamble: list[str] = []
    sections: list[tuple[str, list[str]]] = []
    in_fence = False
    for line in _lines(document):
        if _FENCE_RE.match(line):
            in_fence = not in_fence
        match = None if in_fence else _HEADING_RE.match(line)
        if match:
            sections.append((_trim(match.group(1)), []))
        else:
            (sections[-1][1] if sections else preamble).append(line)
    return SplitDocument(
        preamble=_trim("\n".join(preamble)),
        sections=[DocumentSection(heading, _trim("\n".join(body))) for heading, body in sections],
    )


def join_sections(document: SplitDocument) -> str:
    parts = [document.preamble] if document.preamble else []
    for section in document.sections:
        parts.append(f"## {section.heading}\n{section.body}" if section.body else f"## {section.heading}")
    return _trim("\n\n".join(parts))


def _is_checked(line: str) -> bool:
    match = _TASK_RE.match(line)
    return match is not None and match.group(2).lower() == "x"


def apply_section_updates(document: str, updates: Sequence[SectionUpdate]) -> ApplyResult:
    """Merge section-level updates into a document.

    Sections that are not mentioned are untouched and confirmed (``[x]``) lines are never dropped by a replacement.
    """
    split = split_sections(document)
    sections = [DocumentSection(section.heading, section.body) for section in split.sections]
    warnings: list[str] = []
    for update in updates:
        key = normalize_heading(update.heading)
        incoming = _trim(update.markdown)
        existing = next((section for section in sections if normalize_heading(section.heading) == key), None)
        if existing is None:
            sections.append(DocumentSection(_trim(update.heading), incoming))
            continue
        if update.mode == "append":
            known = {_trim(line) for line in existing.body.split("\n")}
            fresh = [line for line in incoming.split("\n") if not _trim(line) or _trim(line) not in known]
            addition = _trim("\n".join(fresh))
            if addition:
                existing.body = f"{existing.body}\n{addition}" if existing.body else addition
            continue
        incoming_lines = {_trim(line) for line in incoming.split("\n")}
        kept = [line for line in existing.body.split("\n") if _is_checked(line) and _trim(line) not in incoming_lines]
        if kept:
            warnings.append(f'"{existing.heading}": {len(kept)} confirmed item(s) were kept instead of removed.')
            existing.body = _trim(f"{incoming}\n" + "\n".join(kept))
        else:
            existing.body = incoming
    return ApplyResult(join_sections(SplitDocument(split.preamble, sections)), warnings)


def diff_documents(before: str, after: str) -> DocumentDiff:
    """Line-based diff (longest common subsequence); documents are small."""
    a = [line for line in (_trim(x) for x in before.split("\n")) if line]
    b = [line for line in (_trim(x) for x in after.split("\n")) if line]
    table = [[0] * (len(b) + 1) for _ in range(len(a) + 1)]
    for i in range(len(a) - 1, -1, -1):
        for j in range(len(b) - 1, -1, -1):
            table[i][j] = table[i + 1][j + 1] + 1 if a[i] == b[j] else max(table[i + 1][j], table[i][j + 1])
    added: list[str] = []
    removed: list[str] = []
    i = j = 0
    while i < len(a) and j < len(b):
        if a[i] == b[j]:
            i += 1
            j += 1
        elif table[i + 1][j] >= table[i][j + 1]:
            removed.append(a[i])
            i += 1
        else:
            added.append(b[j])
            j += 1
    removed.extend(a[i:])
    added.extend(b[j:])
    return DocumentDiff(added, removed)


def parse_checklist_sections(document: str) -> list[ChecklistEntry]:
    entries: list[ChecklistEntry] = []
    kind: ChecklistKind | None = None
    for index, line in enumerate(_lines(document)):
        heading = _HEADING_RE.match(line)
        if heading:
            title = heading.group(1)
            kind = "question" if _QUESTION_RE.search(title) else "assumption" if _ASSUMPTION_RE.search(title) else None
            continue
        task = _TASK_RE.match(line) if kind else None
        if kind and task and _trim(task.group(3)):
            entries.append(ChecklistEntry(kind, _trim(task.group(3)), task.group(2).lower() == "x", index))
    return entries


def update_checklist_line(document: str, line: int, action: Literal["check", "remove"]) -> str:
    """Confirm/resolve a checklist line or remove it; returns the document unchanged for a stale line."""
    lines = _lines(document)
    task = _TASK_RE.match(lines[line]) if 0 <= line < len(lines) else None
    if task is None:
        return document
    if action == "remove":
        del lines[line]
    else:
        lines[line] = f"{task.group(1)}[x] {task.group(3)}"
    return "\n".join(lines)


def _strip_hints(markdown: str) -> str:
    return _HINT_RE.sub("", markdown)


def template_headings(template: str) -> list[str]:
    return [section.heading for section in split_sections(_strip_hints(template)).sections]


def _heading_kind(heading: str) -> ChecklistKind | None:
    if _ASSUMPTION_RE.search(heading):
        return "assumption"
    if _QUESTION_RE.search(heading):
        return "question"
    return None


def conform_to_template(template: str, markdown: str) -> ConformResult:
    """Rebuild a document on the headings of a template.

    Filled sections are kept, missing ones stay empty, hints are removed and sections the template does not know are
    kept under "Additional notes".
    """
    wanted = split_sections(_strip_hints(template))
    if not wanted.sections:
        return ConformResult(_trim(markdown), [])
    given = split_sections(markdown)
    used: set[int] = set()

    def find(match: Callable[[str], bool]) -> int:
        for index, section in enumerate(given.sections):
            if index not in used and match(section.heading):
                return index
        return -1

    def prefix_match(heading: str, norm: str) -> bool:
        candidate = normalize_heading(heading)
        return _js_length(candidate) > 3 and (norm.startswith(candidate) or candidate.startswith(norm))

    sections: list[DocumentSection] = []
    for wanted_section in wanted.sections:
        heading = wanted_section.heading
        wanted_kind = _heading_kind(heading)
        norm = normalize_heading(heading)
        index = find(lambda h, norm=norm: normalize_heading(h) == norm)
        if index < 0 and wanted_kind:
            index = find(lambda h, wanted_kind=wanted_kind: _heading_kind(h) == wanted_kind)
        if index < 0:
            index = find(lambda h, norm=norm: prefix_match(h, norm))
        if index < 0:
            sections.append(DocumentSection(heading, ""))
            continue
        used.add(index)
        sections.append(DocumentSection(heading, given.sections[index].body))
    # Leftover assumption/question sections are merged into the template's own list instead of becoming notes.
    leftovers: list[DocumentSection] = []
    for index, section in enumerate(given.sections):
        if index in used:
            continue
        kind = _heading_kind(section.heading)
        target = next((entry for entry in sections if _heading_kind(entry.heading) == kind), None) if kind else None
        if target is not None:
            target.body = "\n".join(part for part in (_trim(target.body), _trim(section.body)) if part)
        else:
            leftovers.append(section)
    notes = "\n\n".join(
        part for part in (given.preamble, *(_trim(f"### {s.heading}\n{s.body}") for s in leftovers)) if _trim(part)
    )
    if notes:
        sections.append(DocumentSection("Additional notes", notes))
    return ConformResult(join_sections(SplitDocument("", sections)), [s.heading for s in leftovers])


# --- server-side helpers ----------------------------------------------------------------------------------------------


def normalize_document(document: str) -> str:
    """Canonical form used for hashing and storage comparisons: LF line endings, no leading/trailing whitespace."""
    return _trim(document.replace("\r\n", "\n"))


def document_hash(document: str) -> str:
    """SHA-256 (hex) of the normalised document; identifies the exact content a quality assessment refers to."""
    return hashlib.sha256(normalize_document(document).encode("utf-8")).hexdigest()


def changed_sections(base_document: str, current_document: str) -> list[str]:
    """Headings whose content differs between two documents (added, removed or modified sections).

    Headings are matched by :func:`normalize_heading` and reported with the text used in the *current* document (or the
    base document for removed sections), in current-document order followed by removed sections. A change to the text
    before the first ``##`` heading is reported as :data:`PREAMBLE_SECTION`.
    """
    base = split_sections(base_document)
    current = split_sections(current_document)
    base_bodies: dict[str, list[str]] = {}
    for section in base.sections:
        base_bodies.setdefault(normalize_heading(section.heading), []).append(section.body)
    changed: list[str] = []
    seen: set[str] = set()
    current_seen: dict[str, int] = {}
    if base.preamble != current.preamble:
        changed.append(PREAMBLE_SECTION)
    for section in current.sections:
        key = normalize_heading(section.heading)
        occurrence = current_seen.get(key, 0)
        current_seen[key] = occurrence + 1
        previous = base_bodies.get(key, [])
        if occurrence >= len(previous) or previous[occurrence] != section.body:
            changed.append(section.heading)
        seen.add(key)
    for section in base.sections:
        if normalize_heading(section.heading) not in seen:
            changed.append(section.heading)
            seen.add(normalize_heading(section.heading))
    return changed
