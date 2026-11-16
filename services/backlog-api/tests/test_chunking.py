from __future__ import annotations

import re

from backlog_api.chunking import chunk_text

LONG = " ".join(f"word{i}" for i in range(2000))


def test_blank_text_has_no_chunks() -> None:
    assert chunk_text("") == []
    assert chunk_text(" \n\n ") == []


def test_short_text_is_one_chunk_with_offsets() -> None:
    text = "  Hello world.\n"
    [chunk] = chunk_text(text)
    assert chunk.text == "Hello world."
    assert text[chunk.char_start : chunk.char_end] == chunk.text
    assert chunk.page is None and chunk.heading_path is None and chunk.ordinal == 0


def test_headings_build_a_path_and_start_new_chunks() -> None:
    text = "# Intro\n" + "a " * 80 + "\n## Scope\n" + "b " * 80 + "\n## Out of scope\n" + "c " * 80 + "\n# Next\nd\n"
    chunks = chunk_text(text, target_chars=200)
    paths = [chunk.heading_path for chunk in chunks]
    assert "Intro" in paths
    assert "Intro > Scope" in paths
    assert "Intro > Out of scope" in paths
    assert paths[-1] == "Next"
    assert [chunk.ordinal for chunk in chunks] == list(range(len(chunks)))


def test_fenced_code_comments_are_not_headings() -> None:
    chunks = chunk_text("# Title\n```\n# not a heading\n```\nbody\n")
    assert [chunk.heading_path for chunk in chunks] == ["Title"]


def test_pages_are_tracked_and_never_merged() -> None:
    text = "first page text\fsecond page text\f\fcarry on"
    chunks = chunk_text(text)
    assert [(c.page, c.text) for c in chunks] == [(1, "first page text"), (2, "second page text"), (4, "carry on")]
    for chunk in chunks:
        assert text[chunk.char_start : chunk.char_end] == chunk.text


def test_long_text_is_split_without_breaking_words_and_overlaps() -> None:
    chunks = chunk_text(LONG, target_chars=1000, overlap_ratio=0.15)
    assert len(chunks) > 5
    for chunk in chunks:
        assert len(chunk.text) <= 1000 + 20
        assert LONG[chunk.char_start : chunk.char_end] == chunk.text
        assert all(re.fullmatch(r"word\d+", word) for word in chunk.text.split())
    for previous, current in zip(chunks, chunks[1:], strict=False):
        assert current.char_start < previous.char_end  # overlap
        assert current.char_start > previous.char_start  # progress
    assert chunks[-1].char_end == len(LONG)


def test_word_longer_than_target_is_kept_whole() -> None:
    chunks = chunk_text("x" * 900 + " tail", target_chars=200)
    assert chunks[0].text.startswith("x" * 900)


def test_chunking_is_deterministic() -> None:
    assert chunk_text(LONG, target_chars=800) == chunk_text(LONG, target_chars=800)
