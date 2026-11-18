"""Source text extraction: content sniffing (magic bytes), PDF (``pypdf``) and UTF-8 text.

Stored text format (see ``sources.text``): the extracted text with whitespace normalised. For PDFs every page is
extracted separately and the pages are joined with a form feed (``\\f``); ``page_count`` is the number of pages, so
page *n* is ``text.split("\\f")[n - 1]`` (empty pages are kept so indexes line up). All other text has no form feeds
(they are turned into newlines) and ``page_count`` is ``None``. ``char_count`` is ``len(text)``.
"""

from __future__ import annotations

import io
import re
from dataclasses import dataclass
from typing import Literal

import anyio.to_thread
from pypdf import PdfReader

from backlog_api.problems import ProblemError

PAGE_SEPARATOR = "\f"
PDF_MEDIA_TYPE = "application/pdf"
Kind = Literal["pdf", "text"]

_BINARY_SIGNATURES: tuple[tuple[bytes, str], ...] = (
    (b"PK\x03\x04", "ZIP archive or Office document"),
    (b"PK\x05\x06", "ZIP archive"),
    (b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1", "legacy Office document"),
    (b"\x89PNG\r\n\x1a\n", "image"),
    (b"\xff\xd8\xff", "image"),
    (b"GIF87a", "image"),
    (b"GIF89a", "image"),
    (b"RIFF", "media file"),
    (b"\x1f\x8b", "compressed file"),
    (b"7z\xbc\xaf\x27\x1c", "archive"),
    (b"Rar!\x1a\x07", "archive"),
    (b"\x7fELF", "executable"),
    (b"MZ", "executable"),
    (b"{\\rtf", "RTF document"),
)
_TEXT_TYPES_BY_EXTENSION = {
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".mdown": "text/markdown",
    ".csv": "text/csv",
    ".tsv": "text/tab-separated-values",
    ".json": "application/json",
}
_DECLARED_TEXT_TYPES = {"text/markdown", "text/x-markdown", "text/csv", "text/plain", "application/json"}
_REJECTED_DECLARED_PREFIXES = ("image/", "audio/", "video/")
_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0e-\x1f\x7f]")
_HORIZONTAL_SPACE = re.compile(r"[^\S\n]+")
_BLANK_RUNS = re.compile(r"\n{3,}")
# The lookbehind keeps the match linear: without it every start inside a long run of spaces rescans the whole run.
_TRAILING_SPACE = re.compile(r"(?<![ \t])[ \t]+\n")


@dataclass(frozen=True, slots=True)
class ExtractionLimits:
    max_bytes: int
    max_pages: int
    max_text_chars: int


@dataclass(frozen=True, slots=True)
class ExtractedText:
    text: str
    page_count: int | None
    media_type: str


def unsupported(detail: str) -> ProblemError:
    return ProblemError(415, "unsupported-media-type", detail=detail)


def too_large(detail: str) -> ProblemError:
    return ProblemError(413, "source-too-large", detail=detail)


def media_type_of(value: str | None) -> str:
    return (value or "").split(";", 1)[0].strip().lower()


def normalize_text(value: str, *, collapse_spaces: bool = False) -> str:
    """Normalise newlines, drop control characters and excess blank lines; PDFs also collapse runs of spaces."""
    value = value.replace("\r\n", "\n").replace("\r", "\n").replace(PAGE_SEPARATOR, "\n")
    value = _CONTROL_CHARS.sub("", value)
    if collapse_spaces:
        value = _HORIZONTAL_SPACE.sub(" ", value)
    value = _TRAILING_SPACE.sub("\n", value)
    return _BLANK_RUNS.sub("\n\n", value).strip()


def sniff(content: bytes, *, declared_type: str | None = None) -> Kind:
    """Decide from the content (not the file name) whether this is a PDF or UTF-8 text; otherwise 415."""
    declared = media_type_of(declared_type)
    if content.startswith(b"%PDF-"):
        return "pdf"
    if declared == PDF_MEDIA_TYPE:
        raise unsupported("The file is declared as a PDF but its content is not a PDF.")
    if declared.startswith(_REJECTED_DECLARED_PREFIXES):
        raise unsupported("Only PDF and UTF-8 text files (txt, md, csv, json) are supported.")
    for signature, label in _BINARY_SIGNATURES:
        if content.startswith(signature):
            raise unsupported(f"Unsupported file type ({label}). Only PDF and UTF-8 text files are supported.")
    return "text"


def decode_text(content: bytes) -> str:
    """Strict UTF-8 decode of text-like content; binary data (NUL bytes, many control characters) gets 415."""
    if b"\x00" in content[:8192]:
        raise unsupported("The file looks binary. Only PDF and UTF-8 text files are supported.")
    try:
        decoded = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise unsupported("The file is not valid UTF-8 text. Only PDF and UTF-8 text files are supported.") from None
    sample = decoded[:8192]
    if sample and len(_CONTROL_CHARS.findall(sample)) > max(8, len(sample) // 100):
        raise unsupported("The file looks binary. Only PDF and UTF-8 text files are supported.")
    return decoded


def _stored_text_type(filename: str | None, declared_type: str | None) -> str:
    name = (filename or "").lower()
    for extension, media_type in _TEXT_TYPES_BY_EXTENSION.items():
        if name.endswith(extension):
            return media_type
    declared = media_type_of(declared_type)
    return declared if declared in _DECLARED_TEXT_TYPES else "text/plain"


def finish_text(text: str, *, limits: ExtractionLimits, page_count: int | None, media_type: str) -> ExtractedText:
    if not text.strip():
        raise ProblemError(
            422,
            "no-text",
            detail="No text could be extracted. Scanned or image-only documents are not supported (no OCR).",
        )
    if len(text) > limits.max_text_chars:
        raise too_large(f"The extracted text exceeds the limit of {limits.max_text_chars} characters.")
    return ExtractedText(text=text, page_count=page_count, media_type=media_type)


def extract_text_document(text: str, *, limits: ExtractionLimits, media_type: str = "text/plain") -> ExtractedText:
    return finish_text(normalize_text(text), limits=limits, page_count=None, media_type=media_type)


def extract_pdf(content: bytes, *, limits: ExtractionLimits) -> ExtractedText:
    try:
        reader = PdfReader(io.BytesIO(content))
        if reader.is_encrypted:
            try:
                decrypted = reader.decrypt("")
            except Exception:
                decrypted = 0
            if not decrypted:
                raise ProblemError(422, "encrypted-pdf", detail="Password-protected PDF files are not supported.")
        page_count = len(reader.pages)
        if page_count > limits.max_pages:
            raise ProblemError(
                422,
                "too-many-pages",
                detail=f"The PDF has {page_count} pages; the limit is {limits.max_pages}.",
                pages=page_count,
                limit=limits.max_pages,
            )
        pages: list[str] = []
        total = 0
        for page in reader.pages:
            text = normalize_text(page.extract_text() or "", collapse_spaces=True)
            total += len(text) + 1
            if total > limits.max_text_chars + page_count:
                raise too_large(f"The extracted text exceeds the limit of {limits.max_text_chars} characters.")
            pages.append(text)
    except ProblemError:
        raise
    except Exception:
        raise ProblemError(
            422, "invalid-pdf", detail="Could not read the PDF; it may be damaged or use an unsupported format."
        ) from None
    return finish_text(PAGE_SEPARATOR.join(pages), limits=limits, page_count=page_count, media_type=PDF_MEDIA_TYPE)


def extract_file(
    content: bytes, *, filename: str | None, declared_type: str | None, limits: ExtractionLimits
) -> ExtractedText:
    """Validate and extract an uploaded file (CPU-bound; call :func:`extract_file_async` from request handlers)."""
    if len(content) > limits.max_bytes:
        raise too_large(f"The file exceeds the limit of {limits.max_bytes} bytes.")
    if not content:
        raise ProblemError(422, "empty-file", detail="The file is empty.")
    if sniff(content, declared_type=declared_type) == "pdf":
        return extract_pdf(content, limits=limits)
    return extract_text_document(
        decode_text(content), limits=limits, media_type=_stored_text_type(filename, declared_type)
    )


async def extract_file_async(
    content: bytes, *, filename: str | None, declared_type: str | None, limits: ExtractionLimits
) -> ExtractedText:
    return await anyio.to_thread.run_sync(
        lambda: extract_file(content, filename=filename, declared_type=declared_type, limits=limits)
    )


async def extract_pdf_async(content: bytes, *, limits: ExtractionLimits) -> ExtractedText:
    return await anyio.to_thread.run_sync(lambda: extract_pdf(content, limits=limits))
