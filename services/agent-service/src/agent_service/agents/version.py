"""The build version reported by the agent catalogue: ``AGENT_BUILD_SHA``, else the git short sha, else ``dev``."""

from __future__ import annotations

import subprocess  # noqa: S404 - fixed git invocation, no user input
from pathlib import Path

from agent_service.settings import SERVICE_ROOT, Settings


def resolve_build_version(settings: Settings, *, cwd: Path = SERVICE_ROOT) -> str:
    if settings.build_sha and settings.build_sha.strip():
        return settings.build_sha.strip()
    try:
        completed = subprocess.run(  # noqa: S603
            ["git", "rev-parse", "--short", "HEAD"],  # noqa: S607
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=5,
            check=True,
        )
    except (OSError, subprocess.SubprocessError):
        return "dev"
    return completed.stdout.strip() or "dev"
