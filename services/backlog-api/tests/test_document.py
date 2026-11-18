"""Port of ``apps/web/src/domain/document.test.ts`` plus the shared golden fixtures and server-side helpers."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from backlog_api.document import (
    PREAMBLE_SECTION,
    SectionUpdate,
    SplitDocument,
    apply_section_updates,
    changed_sections,
    conform_to_template,
    diff_documents,
    document_hash,
    join_sections,
    normalize_heading,
    parse_checklist_sections,
    split_sections,
    template_headings,
    update_checklist_line,
)

DOC = "## Summary\nOld\n\n## Assumptions\n- [x] Kept\n- [ ] Maybe\n\n## Open questions\n- [ ] Who?"
FIXTURES = Path(__file__).resolve().parents[3] / "contracts" / "fixtures" / "document"


def test_only_changes_mentioned_sections_and_keeps_confirmed_items() -> None:
    result = apply_section_updates(
        DOC, [SectionUpdate("summary", "New"), SectionUpdate("Assumptions", "- [ ] Other", "replace")]
    )
    assert "## Summary\nNew" in result.document
    assert "- [x] Kept" in result.document
    assert "Maybe" not in result.document
    assert "## Open questions\n- [ ] Who?" in result.document
    assert len(result.warnings) == 1


def test_append_does_not_duplicate_lines_and_adds_new_sections() -> None:
    result = apply_section_updates(
        DOC, [SectionUpdate("Open questions", "- [ ] Who?\n- [ ] When?", "append"), SectionUpdate("Risks", "None")]
    )
    assert result.document.count("Who?") == 1
    assert "- [ ] When?" in result.document
    assert "## Risks\nNone" in result.document


def test_parses_and_updates_checklist_items() -> None:
    entries = parse_checklist_sections(DOC)
    assert [(e.kind, e.text, e.checked) for e in entries] == [
        ("assumption", "Kept", True),
        ("assumption", "Maybe", False),
        ("question", "Who?", False),
    ]
    assert "- [x] Maybe" in update_checklist_line(DOC, entries[1].line, "check")
    assert "Maybe" not in update_checklist_line(DOC, entries[1].line, "remove")


def test_diffs_documents_by_line() -> None:
    diff = diff_documents("a\nb", "a\nc")
    assert (diff.added, diff.removed) == (["c"], ["b"])


def test_conforms_a_document_to_the_template_headings() -> None:
    template = "# T\n\n## Summary\n<!-- hint -->\n\n## Scope\n<!-- hint -->\n\n## Assumptions\n- [ ] "
    result = conform_to_template(template, "## assumptions\n- [ ] A\n\n## Summary\nS\n\n## My own\nExtra")
    assert result.document == (
        "## Summary\nS\n\n## Scope\n\n## Assumptions\n- [ ] A\n\n## Additional notes\n### My own\nExtra"
    )
    assert result.extra_headings == ["My own"]
    assert "<!--" not in result.document


def test_matches_renamed_question_and_assumption_sections() -> None:
    template = "## Summary\n\n## Assumptions\n- [ ] \n\n## Open questions\n- [ ] "
    result = conform_to_template(
        template, "## Summary\nS\n\n## Open questions (new)\n- [ ] Q1\n\n## Open Vragen\n- [ ] Q2\n\n## Notes\nN"
    )
    assert "## Open questions\n- [ ] Q1\n- [ ] Q2" in result.document
    assert "## Additional notes\n### Notes\nN" in result.document
    assert result.extra_headings == ["Notes"]


def test_template_headings_ignore_hints() -> None:
    assert template_headings("# T\n## A\n<!-- ## no -->\n## B") == ["A", "B"]


def test_split_and_join_roundtrip() -> None:
    split = split_sections("# T\n\n## A\n a \n\n### Sub\nx\n\n## B\n")
    assert split.preamble == "# T"
    assert [(s.heading, s.body) for s in split.sections] == [("A", "a \n\n### Sub\nx"), ("B", "")]
    assert join_sections(SplitDocument("", [])) == ""
    assert normalize_heading("## Open   Questions ") == "open questions"


def test_document_hash_normalises_line_endings_and_outer_whitespace() -> None:
    assert document_hash("## A\r\nx\r\n\r\n") == document_hash("## A\nx")
    assert document_hash("## A\nx") != document_hash("## A\ny")
    assert len(document_hash("")) == 64


def test_changed_sections_reports_modified_added_and_removed_headings() -> None:
    base = "Intro\n\n## Summary\nOld\n\n## Scope\nS\n\n## Gone\nx"
    current = "Intro\n\n## Summary\nNew\n\n## Scope\nS\n\n## Added\ny"
    assert changed_sections(base, current) == ["Summary", "Added", "Gone"]
    assert changed_sections(base, base) == []
    assert changed_sections(base, base.replace("Intro", "Other")) == [PREAMBLE_SECTION]
    assert changed_sections("## summary\nx", "## Summary\nx") == []
    assert changed_sections("", "## A\nx") == ["A"]


# --- shared golden fixtures (contracts/fixtures/document) ------------------------------------------


def _fixtures() -> list[Path]:
    return sorted(FIXTURES.glob("*.json")) if FIXTURES.is_dir() else []


def _run(function: str, data: dict[str, Any]) -> Any:
    match function:
        case "normalizeHeading":
            return normalize_heading(data["heading"])
        case "splitSections":
            split = split_sections(data["document"])
            return {
                "preamble": split.preamble,
                "sections": [{"heading": s.heading, "body": s.body} for s in split.sections],
            }
        case "joinSections":
            from backlog_api.document import DocumentSection

            return join_sections(
                SplitDocument(data["preamble"], [DocumentSection(s["heading"], s["body"]) for s in data["sections"]])
            )
        case "applySectionUpdates":
            updates = [SectionUpdate(u["heading"], u["markdown"], u.get("mode", "replace")) for u in data["updates"]]
            result = apply_section_updates(data["document"], updates)
            return {"document": result.document, "warnings": result.warnings}
        case "diffDocuments":
            diff = diff_documents(data["before"], data["after"])
            return {"added": diff.added, "removed": diff.removed}
        case "parseChecklistSections":
            return [
                {"kind": e.kind, "text": e.text, "checked": e.checked, "line": e.line}
                for e in parse_checklist_sections(data["document"])
            ]
        case "updateChecklistLine":
            return update_checklist_line(data["document"], data["line"], data["action"])
        case "templateHeadings":
            return template_headings(data["template"])
        case "conformToTemplate":
            result = conform_to_template(data["template"], data["markdown"])
            return {"document": result.document, "extraHeadings": result.extra_headings}
    raise AssertionError(f"Unknown fixture function {function!r}")


GOLDEN_FUNCTIONS = {
    "applySectionUpdates",
    "conformToTemplate",
    "diffDocuments",
    "joinSections",
    "normalizeHeading",
    "parseChecklistSections",
    "splitSections",
    "templateHeadings",
    "updateChecklistLine",
}


def test_golden_fixture_set_is_complete() -> None:
    """No skips: the shared fixtures must exist, and every function they cover must be ported."""
    assert FIXTURES.is_dir(), f"missing shared fixtures: {FIXTURES}"
    files = _fixtures()
    assert len(files) >= 48, f"expected at least 48 golden fixtures, found {len(files)}"
    used: set[str] = set()
    for path in files:
        fixture = json.loads(path.read_text(encoding="utf-8"))
        assert {"name", "fn", "input", "expected"} <= fixture.keys(), path.name
        assert fixture["name"] == path.stem, path.name
        used.add(fixture["fn"])
    assert used == GOLDEN_FUNCTIONS


@pytest.mark.parametrize("path", _fixtures(), ids=lambda path: path.stem)
def test_golden_fixtures(path: Path) -> None:
    fixture = json.loads(path.read_text(encoding="utf-8"))
    assert _run(fixture["fn"], fixture["input"]) == fixture["expected"], fixture.get("description", "")
