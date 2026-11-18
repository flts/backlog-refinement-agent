"""Write the backlog-api OpenAPI document to ``contracts/openapi/backlog-api.json``.

Usage (from the repository root):
    uv run --package backlog-api python services/backlog-api/scripts/export_openapi.py          # write
    uv run --package backlog-api python services/backlog-api/scripts/export_openapi.py --check  # fail if outdated
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from backlog_api.main import create_app
from backlog_api.settings import Settings

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_OUTPUT = REPO_ROOT / "contracts" / "openapi" / "backlog-api.json"


def render() -> str:
    # Explicit, environment-independent settings: the schema must not depend on local configuration.
    settings = Settings(
        _env_file=None,  # pyright: ignore[reportCallIssue]
        env="test",
        auth_mode="jwt",
        oidc_issuer="https://issuer.invalid/realms/backlog",
    )
    app = create_app(settings, configure_logs=False)
    return json.dumps(app.openapi(), indent=2, ensure_ascii=False) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Export the backlog-api OpenAPI document.")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--check", action="store_true", help="exit with 1 when the snapshot is missing or outdated")
    args = parser.parse_args()
    document = render()
    output: Path = args.output
    if args.check:
        current = output.read_text(encoding="utf-8") if output.exists() else None
        if current != document:
            print(f"{output} is outdated; run services/backlog-api/scripts/export_openapi.py", file=sys.stderr)
            return 1
        print(f"{output} is up to date")
        return 0
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(document, encoding="utf-8")
    print(f"Wrote {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
