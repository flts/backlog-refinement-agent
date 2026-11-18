"""Locate and load the JSON Schema files in ``contracts/schemas``."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Final

CONTRACTS_DIR_ENV: Final = "BACKLOG_CONTRACTS_DIR"
SCHEMA_SUFFIX: Final = ".schema.json"


class ContractsNotFoundError(Exception):
    """The ``contracts`` directory (or a schema in it) could not be located."""


def resolve_contracts_root(root: Path | None = None) -> Path:
    """Locate ``contracts``: explicit ``root``, ``$BACKLOG_CONTRACTS_DIR``, or the repo's ``contracts/``.

    The directory must contain a ``schemas/`` folder. The environment variable points to the ``contracts`` directory.
    """
    if root is not None:
        return _contracts_dir(Path(root), "The contracts directory")
    configured = os.environ.get(CONTRACTS_DIR_ENV, "").strip()
    if configured:
        return _contracts_dir(Path(configured), CONTRACTS_DIR_ENV)
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "contracts"
        if (candidate / "schemas").is_dir():
            return candidate.resolve()
    raise ContractsNotFoundError(
        f"Could not locate the contracts directory. Set {CONTRACTS_DIR_ENV} to the directory that contains schemas/."
    )


def schema_path(name: str, root: Path | None = None) -> Path:
    """Path of the schema ``name`` (for example ``ask-user.args``; the ``.schema.json`` suffix is optional)."""
    stem = name.removesuffix(SCHEMA_SUFFIX)
    if not stem or "/" in stem or "\\" in stem or stem.startswith("."):
        raise ContractsNotFoundError(f"Invalid schema name '{name}'.")
    path = resolve_contracts_root(root) / "schemas" / f"{stem}{SCHEMA_SUFFIX}"
    if not path.is_file():
        raise ContractsNotFoundError(f"Schema '{stem}' was not found at {path}.")
    return path


def schema_names(root: Path | None = None) -> list[str]:
    """Names of all available schemas, sorted."""
    folder = resolve_contracts_root(root) / "schemas"
    return sorted(p.name.removesuffix(SCHEMA_SUFFIX) for p in folder.glob(f"*{SCHEMA_SUFFIX}"))


def load_schema(name: str, root: Path | None = None) -> dict[str, Any]:
    """Load the JSON Schema (draft 2020-12) ``name`` as a dict."""
    data: Any = json.loads(schema_path(name, root).read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ContractsNotFoundError(f"Schema '{name}' is not a JSON object.")
    return data


def _contracts_dir(path: Path, label: str) -> Path:
    resolved = path.expanduser().resolve()
    if not (resolved / "schemas").is_dir():
        raise ContractsNotFoundError(f"{label} '{path}' does not contain a schemas/ directory.")
    return resolved
