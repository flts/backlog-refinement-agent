"""Optimistic concurrency: resources carry an integer ``version``, exposed as ``ETag: "<version>"``.

Writes send ``If-Match: <version>`` (a quoted ETag, a weak ETag or the bare number are accepted). A missing header is
**428** ``precondition-required``; a stale version is **409** ``version-conflict`` with ``currentVersion``.
"""

from __future__ import annotations

import re
from typing import Any

from backlog_api.problems import ProblemError

IF_MATCH_HEADER = "If-Match"
_IF_MATCH_PATTERN = re.compile(r'^(?:W/)?"?(\d{1,10})"?$')


def etag(version: int) -> str:
    return f'"{version}"'


def parse_if_match(value: str | None) -> int:
    if value is None or not value.strip():
        raise ProblemError(
            428,
            "precondition-required",
            detail=f"Send the {IF_MATCH_HEADER} header with the version you based this change on.",
        )
    match = _IF_MATCH_PATTERN.fullmatch(value.strip())
    if match is None:
        raise ProblemError(400, "invalid-if-match", detail=f"{IF_MATCH_HEADER} must contain a single resource version.")
    return int(match.group(1))


def version_conflict(current_version: int, **extensions: Any) -> ProblemError:
    return ProblemError(
        409,
        "version-conflict",
        detail="The resource was changed by someone else. Reload it and try again.",
        headers={"ETag": etag(current_version)},
        currentVersion=current_version,
        **extensions,
    )
