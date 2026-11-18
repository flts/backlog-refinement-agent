"""Pure item rules ported from ``apps/web/src/domain/services.ts`` (status transitions, relationship rules)."""

from __future__ import annotations

from collections.abc import Iterable, Mapping

from backlog_skills import CHILD_TYPES

ITEM_TYPES = ("capability", "feature", "user-story", "enabler")
ITEM_STATUSES = ("draft", "refining", "ready", "ready-with-open-questions", "complete")
RELATIONSHIP_TYPES = ("parent-child", "supports", "depends-on", "related-to")

ALLOWED_TRANSITIONS: Mapping[str, tuple[str, ...]] = {
    "draft": ("refining",),
    "refining": ("draft", "ready", "ready-with-open-questions"),
    "ready": ("refining", "complete"),
    "ready-with-open-questions": ("refining", "ready", "complete"),
    "complete": ("refining",),
}

DEFAULT_TITLES: Mapping[str, str] = {
    "capability": "Untitled Capability",
    "feature": "Untitled Feature",
    "user-story": "Untitled User Story",
    "enabler": "Untitled Enabler",
}


def can_transition(current: str, target: str) -> bool:
    """Whether the status may change; staying in the same status is always allowed (a no-op)."""
    return current == target or target in ALLOWED_TRANSITIONS.get(current, ())


def can_be_child(parent_type: str, child_type: str) -> bool:
    """capability -> feature | enabler; feature -> user-story | enabler; user stories and enablers have no children."""
    return child_type in CHILD_TYPES.get(parent_type, ())  # type: ignore[call-overload]


def is_same_relationship(existing: tuple[object, object, str], candidate: tuple[object, object, str]) -> bool:
    """``related-to`` is symmetric; every other type is directional."""
    (source, target, kind), (c_source, c_target, c_kind) = existing, candidate
    if kind != c_kind:
        return False
    if source == c_source and target == c_target:
        return True
    return kind == "related-to" and source == c_target and target == c_source


def creates_parent_cycle[T](parent_child_edges: Iterable[tuple[T, T]], parent: T, child: T) -> bool:
    """Whether adding ``parent -> child`` would make ``parent`` its own descendant."""
    children: dict[T, list[T]] = {}
    for source, target in parent_child_edges:
        children.setdefault(source, []).append(target)
    pending = [child]
    visited: set[T] = set()
    while pending:
        current = pending.pop()
        if current == parent:
            return True
        if current in visited:
            continue
        visited.add(current)
        pending.extend(children.get(current, ()))
    return False
