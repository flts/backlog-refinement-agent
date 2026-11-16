"""Regression tests for super-linear parsing: every text parser must stay fast on adversarial input.

Each case used to take seconds to minutes (cubic or quadratic regular expressions or scans). The bound is generous
(CI machines are slow) but orders of magnitude below the former run times.
"""

from __future__ import annotations

import time
from collections.abc import Callable

import pytest

from backlog_api.chunking import chunk_text
from backlog_api.document import (
    changed_sections,
    conform_to_template,
    diff_documents,
    normalize_document,
    parse_checklist_sections,
    split_sections,
)
from backlog_api.extraction import ExtractionLimits, extract_text_document, normalize_text
from backlog_api.fetch import html_to_text

BUDGET_SECONDS = 2.0
LIMITS = ExtractionLimits(max_bytes=10_000_000, max_pages=200, max_text_chars=50_000_000)

CASES: dict[str, str] = {
    "heading followed by long whitespace": "## a" + " " * 200_000 + "x",
    "many headings with trailing whitespace": ("## a" + " " * 500 + "x\n") * 400,
    "hash run": "## " + "#" * 200_000,
    "markdown heading whitespace": "# a" + " " * 200_000 + "x",
    "markdown heading tabs": "### a" + "\t " * 100_000 + "x",
    "unclosed hint comments": "<!--" * 50_000,
    "hint comments without end": "## S\n" + "<!-- x " * 30_000,
    "long space run before newline": " " * 300_000 + "x\n",
    "alternating space newline": " \n" * 150_000,
    "many unmatched end tags": "</b>" * 100_000,
    "deeply repeated unclosed tags": "<div>" * 50_000,
    "unclosed attribute": "<a " + 'href="' * 20_000,
    "checklist lines": "## Open questions\n" + "- [ ] " + " " * 100_000 + "x\n",
}


def timed(function: Callable[[str], object], text: str) -> float:
    started = time.perf_counter()
    function(text)
    return time.perf_counter() - started


PARSERS: dict[str, Callable[[str], object]] = {
    "split_sections": split_sections,
    "parse_checklist_sections": parse_checklist_sections,
    "normalize_document": normalize_document,
    "changed_sections": lambda text: changed_sections("## a\nx", text),
    "diff_documents": lambda text: diff_documents("## a\nx", text),
    "conform_to_template": lambda text: conform_to_template("## Summary\n\n## Scope\n", text),
    "chunk_text": chunk_text,
    "normalize_text": normalize_text,
    "extract_text_document": lambda text: extract_text_document(text + "\nend", limits=LIMITS),
    "html_to_text": html_to_text,
}


@pytest.mark.parametrize("parser", PARSERS)
@pytest.mark.parametrize("case", CASES)
def test_parser_stays_fast_on_adversarial_input(parser: str, case: str) -> None:
    elapsed = timed(PARSERS[parser], CASES[case])
    assert elapsed < BUDGET_SECONDS, f"{parser} took {elapsed:.1f}s on {case!r}"


def test_results_on_whitespace_heavy_headings_are_still_correct() -> None:
    padded = "## Title" + " " * 5000 + "\nbody"
    sections = split_sections(padded)
    assert [section.heading for section in sections.sections] == ["Title"]
    assert [chunk.text for chunk in chunk_text("# H" + " " * 5000 + "\n\ntext here")][0].startswith("# H")
    assert normalize_text("a" + " " * 100_000 + "\nb") == "a\nb"
    assert normalize_text("a  \n b\t\n") == "a\n b"
    assert html_to_text("<p>a</p></b></b><p>b</p>")[1] == "a\n\nb"
