"""Project sources: files, URLs and pasted text used as reference material for refinement.

The original file (for uploads) goes to the :class:`~backlog_api.files.FileStore`; the extracted text lives in
``sources.text`` (see :mod:`backlog_api.extraction` for the page format). Indexing (chunks, embeddings) is done later by
a worker that claims ``index_source`` jobs enqueued here.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Any, Literal
from urllib.parse import quote, urlsplit

from fastapi import APIRouter, Header, Query, Request, Response, status
from pydantic import Field, StringConstraints, ValidationError, model_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import defer
from starlette.datastructures import UploadFile

from backlog_api import audit, sources
from backlog_api.api.deps import MemberAccessDep, ProjectId
from backlog_api.api.schemas import ApiModel, ApiRequest
from backlog_api.auth.dependencies import PrincipalDep
from backlog_api.authz import lock_project, require_member
from backlog_api.concurrency import etag, parse_if_match, version_conflict
from backlog_api.db.models import Source
from backlog_api.db.session import SessionDep
from backlog_api.events import DomainEvent, EventPublisherDep
from backlog_api.extraction import ExtractedText, ExtractionLimits, extract_file_async, extract_text_document
from backlog_api.fetch import FetchPolicy, fetch_source, system_resolver
from backlog_api.files import FileStoreDep
from backlog_api.problems import ProblemError, not_found, problem_responses
from backlog_api.settings import API_PREFIX, Settings

router = APIRouter(tags=["sources"])

SourceMode = Literal["pinned", "searchable", "excluded"]
SourceName = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=sources.MAX_SOURCE_NAME_LENGTH),
    Field(description="Display name of the source."),
]
IfMatch = Annotated[
    str | None, Header(alias="If-Match", description="The source version (ETag) this change is based on.")
]
SOURCE_NOT_FOUND = "The source does not exist in this project."
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_NOT_FILENAME_SAFE = re.compile(r'[\\/:*?"<>|\x00-\x1f\x7f]')


class PinnedBudgetOut(ApiModel):
    used: int = Field(description="Characters of all pinned sources.")
    limit: int = Field(description="Maximum characters of pinned sources per project.")


class SourceOut(ApiModel):
    id: uuid.UUID
    project_id: uuid.UUID
    name: str
    kind: Literal["file", "url", "text"]
    mode: SourceMode
    url: str | None
    char_count: int
    page_count: int | None = Field(description="Number of PDF pages; null for other sources.")
    media_type: str | None
    has_file: bool = Field(description="Whether the original can be downloaded from `/file`.")
    index_status: Literal["pending", "indexing", "indexed", "failed", "skipped"]
    index_error: str | None
    version: int
    added_by: str
    created_at: datetime
    updated_at: datetime


class SourceDetail(SourceOut):
    text: str | None = Field(description="Extracted text; PDF pages are separated by a form feed (U+000C).")


class SourceList(ApiModel):
    items: list[SourceOut]
    pinned_budget: PinnedBudgetOut


class SourceCreateJson(ApiRequest):
    name: SourceName | None = None
    url: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2048)] | None = Field(
        default=None, description="Page to fetch on the server (https only)."
    )
    pasted_text: str | None = Field(
        default=None, description="Text to store instead of fetching the URL (fallback after `url-fetch-failed`)."
    )
    text: str | None = Field(default=None, description="Plain text source (requires `name`).")
    mode: SourceMode = "searchable"

    @model_validator(mode="after")
    def _shape(self) -> SourceCreateJson:
        if (self.url is None) == (self.text is None):
            raise ValueError("Send either `url` (optionally with `pastedText`) or `text`.")
        if self.pasted_text is not None and self.url is None:
            raise ValueError("`pastedText` can only be combined with `url`.")
        if self.text is not None and self.name is None:
            raise ValueError("`name` is required for a text source.")
        return self


class SourceUpdate(ApiRequest):
    name: SourceName | None = None
    mode: SourceMode | None = None

    @model_validator(mode="after")
    def _not_empty(self) -> SourceUpdate:
        if self.name is None and self.mode is None:
            raise ValueError("Send `name` and/or `mode`.")
        return self


def _settings(request: Request) -> Settings:
    return request.app.state.settings


def _limits(settings: Settings) -> ExtractionLimits:
    return ExtractionLimits(
        max_bytes=settings.source_max_bytes,
        max_pages=settings.source_max_pdf_pages,
        max_text_chars=settings.source_max_text_chars,
    )


def _out(source: Source) -> SourceOut:
    return SourceOut(
        id=source.id,
        project_id=source.project_id,
        name=source.name,
        kind=source.kind,  # pyright: ignore[reportArgumentType]
        mode=source.mode,  # pyright: ignore[reportArgumentType]
        url=source.url,
        char_count=source.char_count,
        page_count=source.page_count,
        media_type=source.media_type,
        has_file=source.kind == "file",
        index_status=source.index_status,  # pyright: ignore[reportArgumentType]
        index_error=source.index_error,
        version=source.version,
        added_by=source.added_by,
        created_at=source.created_at,
        updated_at=source.updated_at,
    )


def _event_data(source: Source) -> dict[str, Any]:
    return {
        "sourceId": str(source.id),
        "name": source.name,
        "kind": source.kind,
        "mode": source.mode,
        "charCount": source.char_count,
        "indexStatus": source.index_status,
        "version": source.version,
    }


def _location(project_id: uuid.UUID, source_id: uuid.UUID) -> str:
    return f"{API_PREFIX}/projects/{project_id}/sources/{source_id}"


async def _load(session: AsyncSession, project_id: uuid.UUID, source_id: uuid.UUID, *, lock: bool = False) -> Source:
    query = select(Source).where(Source.id == source_id, Source.project_id == project_id)
    if lock:
        query = query.with_for_update()
    source = await session.scalar(query.execution_options(populate_existing=True))
    if source is None:
        raise not_found(SOURCE_NOT_FOUND)
    return source


def _clean_name(value: str | None, fallback: str) -> str:
    name = " ".join(_CONTROL.sub(" ", value or "").split())
    name = (name or fallback)[: sources.MAX_SOURCE_NAME_LENGTH].strip()
    return name or fallback


def _validated_name(raw: str | None) -> str | None:
    if raw is None or not raw.strip():
        return None
    try:
        return SourceCreateJson(url="https://x.invalid", name=raw).name  # reuse the name constraints
    except ValidationError:
        raise ProblemError(
            422, "validation-error", title="Request validation failed", detail="`name` is invalid."
        ) from None


def _reference_url(raw: str) -> str:
    """URL stored with a pasted-text source: never fetched, so only well-formedness is checked."""
    try:
        parts = urlsplit(raw)
        parts.port  # noqa: B018 - raises ValueError for an invalid port
    except ValueError:
        raise ProblemError(422, "validation-error", detail="`url` is not a valid URL.") from None
    if parts.scheme.lower() not in ("http", "https") or not parts.hostname or parts.username or parts.password:
        raise ProblemError(422, "validation-error", detail="`url` must be an absolute http(s) URL without credentials.")
    return raw


def _default_url_name(url: str) -> str:
    parts = urlsplit(url)
    path = parts.path.rstrip("/")
    return f"{parts.hostname or 'url'}{path}"[: sources.MAX_SOURCE_NAME_LENGTH]


def _download_name(source: Source) -> str:
    name = _NOT_FILENAME_SAFE.sub("_", source.name).strip(" .") or "source"
    if source.media_type == "application/pdf" and not name.lower().endswith(".pdf"):
        name += ".pdf"
    return name


def _content_disposition(filename: str) -> str:
    ascii_name = filename.encode("ascii", "replace").decode().replace("?", "_")
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename, safe='')}"


@dataclass(frozen=True, slots=True)
class UploadedFile:
    content: bytes
    filename: str | None
    content_type: str | None
    name: str | None
    mode: str


async def _read_upload(upload: UploadFile, limit: int) -> bytes:
    content = await upload.read(limit + 1)
    if len(content) > limit:
        raise ProblemError(413, "source-too-large", detail=f"The file exceeds the limit of {limit} bytes.", limit=limit)
    return content


def _validation_problem(detail: str, errors: list[dict[str, Any]] | None = None) -> ProblemError:
    extensions: dict[str, Any] = {"errors": errors} if errors else {}
    return ProblemError(422, "validation-error", title="Request validation failed", detail=detail, **extensions)


async def _parse_create(request: Request, settings: Settings) -> SourceCreateJson | UploadedFile:
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type == "multipart/form-data":
        async with request.form(max_files=1, max_fields=8) as form:
            upload = form.get("file")
            if not isinstance(upload, UploadFile):
                raise _validation_problem("Send the document as the multipart field `file`.")
            name, mode = form.get("name"), form.get("mode")
            if (name is not None and not isinstance(name, str)) or (mode is not None and not isinstance(mode, str)):
                raise _validation_problem("`name` and `mode` must be text fields.")
            clean_mode = (mode or "searchable").strip()
            if clean_mode not in ("pinned", "searchable", "excluded"):
                raise _validation_problem("`mode` must be pinned, searchable or excluded.")
            content = await _read_upload(upload, settings.source_max_bytes)
            return UploadedFile(content, upload.filename, upload.content_type, _validated_name(name), clean_mode)
    if content_type == "application/json":
        body = await request.body()
        if len(body) > settings.source_max_text_chars * 4 + 65536:
            raise ProblemError(413, "payload-too-large", detail="The request body is too large.")
        try:
            return SourceCreateJson.model_validate_json(body)
        except ValidationError as exc:
            errors = [{"loc": list(e["loc"]), "msg": e["msg"], "type": e["type"]} for e in exc.errors()]
            raise _validation_problem("The request is invalid.", errors) from None
    raise ProblemError(
        415,
        "unsupported-media-type",
        detail="Send multipart/form-data with a `file` field or application/json with `url` or `text`.",
    )


@router.get(
    "/projects/{project_id}/sources",
    summary="List the sources of a project",
    responses=problem_responses(401, 403, 404, 422),
)
async def list_sources(
    project_id: ProjectId, access: MemberAccessDep, session: SessionDep, request: Request
) -> SourceList:
    rows = await session.scalars(
        select(Source)
        .options(defer(Source.text))
        .where(Source.project_id == project_id)
        .order_by(Source.created_at, Source.id)
    )
    items = list(rows.all())
    used = sum(source.char_count for source in items if source.mode == "pinned")
    return SourceList(
        items=[_out(source) for source in items],
        pinned_budget=PinnedBudgetOut(used=used, limit=_settings(request).source_pinned_budget_chars),
    )


@router.post(
    "/projects/{project_id}/sources",
    status_code=status.HTTP_201_CREATED,
    summary="Add a source (file upload, URL or pasted text)",
    description=(
        "Multipart (`file`, optional `name`, `mode`) or JSON (`{url, pastedText?, name?, mode?}` or "
        "`{text, name, mode?}`). Files: PDF (page and size limits from settings) or UTF-8 text, checked by "
        "content. A URL is fetched by the server (https, public addresses only); if that fails the response is 422 "
        "`url-fetch-failed` and the client can resend the URL with `pastedText`."
    ),
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {
                "multipart/form-data": {
                    "schema": {
                        "type": "object",
                        "required": ["file"],
                        "properties": {
                            "file": {"type": "string", "format": "binary"},
                            "name": {"type": "string", "maxLength": sources.MAX_SOURCE_NAME_LENGTH},
                            "mode": {"type": "string", "enum": ["pinned", "searchable", "excluded"]},
                        },
                    }
                },
                "application/json": {"schema": {"$ref": "#/components/schemas/SourceCreateJson"}},
            },
        }
    },
    responses=problem_responses(401, 403, 404, 413, 415, 422),
)
async def create_source(
    project_id: ProjectId,
    principal: PrincipalDep,
    session: SessionDep,
    publisher: EventPublisherDep,
    files: FileStoreDep,
    request: Request,
    response: Response,
) -> SourceOut:
    settings = _settings(request)
    await require_member(session, project_id, principal)
    limits = _limits(settings)
    parsed = await _parse_create(request, settings)
    original: tuple[bytes, str] | None = None
    url: str | None = None
    if isinstance(parsed, UploadedFile):
        extracted = await extract_file_async(
            parsed.content, filename=parsed.filename, declared_type=parsed.content_type, limits=limits
        )
        kind, mode = "file", parsed.mode
        original = (parsed.content, extracted.media_type)
        base_name = parsed.filename.replace("\\", "/").rsplit("/", 1)[-1] if parsed.filename else None
        source_name = parsed.name or _clean_name(base_name, "Untitled file")
    elif parsed.text is not None:
        kind, mode = "text", parsed.mode
        extracted = extract_text_document(parsed.text, limits=limits)
        source_name = parsed.name or "Text"
    else:
        assert parsed.url is not None
        kind, mode = "url", parsed.mode
        title: str | None = None
        if parsed.pasted_text is not None:
            url = _reference_url(parsed.url)
            extracted = extract_text_document(parsed.pasted_text, limits=limits)
        else:
            policy = FetchPolicy(
                allow_http=settings.fetch_allows_http,
                timeout_seconds=settings.url_fetch_timeout_seconds,
                max_bytes=settings.url_fetch_max_bytes,
                max_redirects=settings.url_fetch_max_redirects,
            )
            fetched = await fetch_source(
                parsed.url,
                policy,
                limits,
                resolver=getattr(request.app.state, "fetch_resolver", system_resolver),
                transport=getattr(request.app.state, "fetch_transport", None),
            )
            extracted, title, url = fetched.extracted, fetched.title, parsed.url
        source_name = parsed.name or _clean_name(title, _default_url_name(url))
    return await _store_new_source(
        request, response, session, publisher, files, principal.email, project_id,
        name=source_name, kind=kind, mode=mode, url=url, extracted=extracted, original=original,
    )  # fmt: skip


async def _store_new_source(
    request: Request,
    response: Response,
    session: AsyncSession,
    publisher: Any,
    files: Any,
    actor: str,
    project_id: uuid.UUID,
    *,
    name: str,
    kind: str,
    mode: str,
    url: str | None,
    extracted: ExtractedText,
    original: tuple[bytes, str] | None,
) -> SourceOut:
    settings = _settings(request)
    # Serialise source writes per project so the pinned budget check cannot race.
    await lock_project(session, project_id)
    if mode == "pinned":
        await sources.ensure_pinned_budget(
            session, project_id, required=len(extracted.text), limit=settings.source_pinned_budget_chars
        )
    source = Source(
        id=uuid.uuid4(),
        project_id=project_id,
        name=name,
        kind=kind,
        mode=mode,
        url=url,
        text=extracted.text,
        char_count=len(extracted.text),
        page_count=extracted.page_count,
        media_type=extracted.media_type,
        index_status="pending",
        version=1,
        added_by=actor,
    )
    session.add(source)
    await session.flush()
    if original is not None:
        await files.put(source.id, original[0], original[1])
    await sources.enqueue_indexing(session, source, "created")
    audit.record(
        session,
        actor=actor,
        action=sources.AUDIT_SOURCE_CREATED,
        project_id=project_id,
        details={"sourceId": str(source.id), "name": name, "kind": kind, "mode": mode, "charCount": source.char_count},
    )
    await session.commit()
    await session.refresh(source)
    await publisher.publish(DomainEvent(sources.SOURCE_CREATED, project_id, actor, _event_data(source)))
    response.headers["Location"] = _location(project_id, source.id)
    response.headers["ETag"] = etag(source.version)
    return _out(source)


@router.get(
    "/projects/{project_id}/sources/{source_id}",
    summary="Get a source (metadata and extracted text)",
    responses=problem_responses(401, 403, 404, 422),
)
async def get_source(
    project_id: ProjectId,
    source_id: uuid.UUID,
    access: MemberAccessDep,
    session: SessionDep,
    response: Response,
    include_text: Annotated[bool, Query(alias="includeText", description="Include the extracted text.")] = True,
) -> SourceDetail:
    source = await _load(session, project_id, source_id)
    response.headers["ETag"] = etag(source.version)
    return SourceDetail(**_out(source).model_dump(), text=source.text if include_text else None)


@router.get(
    "/projects/{project_id}/sources/{source_id}/file",
    summary="Download the original file of a source",
    response_class=Response,
    responses={
        200: {"description": "The original bytes.", "content": {"application/octet-stream": {}}},
        **problem_responses(401, 403, 404, 422),
    },
)
async def download_source_file(
    project_id: ProjectId, source_id: uuid.UUID, access: MemberAccessDep, session: SessionDep, files: FileStoreDep
) -> Response:
    source = await _load(session, project_id, source_id)
    stored = await files.get(source.id) if source.kind == "file" else None
    if stored is None:
        raise ProblemError(404, "no-original-file", detail="This source has no stored original file.")
    return Response(
        content=stored.content,
        media_type=stored.media_type,
        headers={
            "Content-Disposition": _content_disposition(_download_name(source)),
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "Cache-Control": "private, no-store",
            "ETag": f'"sha256-{stored.sha256}"',
        },
    )


@router.patch(
    "/projects/{project_id}/sources/{source_id}",
    summary="Rename a source or change its mode (requires If-Match)",
    responses=problem_responses(400, 401, 403, 404, 409, 422, 428),
)
async def update_source(
    project_id: ProjectId,
    source_id: uuid.UUID,
    body: SourceUpdate,
    principal: PrincipalDep,
    session: SessionDep,
    publisher: EventPublisherDep,
    request: Request,
    response: Response,
    if_match: IfMatch = None,
) -> SourceOut:
    await require_member(session, project_id, principal, lock=True)
    expected = parse_if_match(if_match)
    source = await _load(session, project_id, source_id, lock=True)
    if source.version != expected:
        raise version_conflict(source.version)
    changed: dict[str, Any] = {}
    if body.name is not None and body.name != source.name:
        changed["name"] = {"from": source.name, "to": body.name}
    mode_changed = body.mode is not None and body.mode != source.mode
    if body.mode is not None and mode_changed:
        changed["mode"] = {"from": source.mode, "to": body.mode}
        if body.mode == "pinned":
            await sources.ensure_pinned_budget(
                session,
                project_id,
                required=source.char_count,
                limit=_settings(request).source_pinned_budget_chars,
                exclude=source.id,
            )
    if changed:
        if body.name is not None:
            source.name = body.name
        if body.mode is not None:
            source.mode = body.mode
        source.version += 1
        source.updated_at = datetime.now(UTC)
        if mode_changed:
            await sources.enqueue_indexing(session, source, "mode-changed")
        audit.record(
            session,
            actor=principal.email,
            action=sources.AUDIT_SOURCE_UPDATED,
            project_id=project_id,
            details={"sourceId": str(source.id), "changes": changed},
        )
        await session.commit()
        await session.refresh(source)
        await publisher.publish(DomainEvent(sources.SOURCE_UPDATED, project_id, principal.email, _event_data(source)))
    response.headers["ETag"] = etag(source.version)
    return _out(source)


@router.delete(
    "/projects/{project_id}/sources/{source_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a source",
    responses=problem_responses(400, 401, 403, 404, 409, 422),
)
async def delete_source(
    project_id: ProjectId,
    source_id: uuid.UUID,
    principal: PrincipalDep,
    session: SessionDep,
    publisher: EventPublisherDep,
    files: FileStoreDep,
    if_match: IfMatch = None,
) -> Response:
    await require_member(session, project_id, principal, lock=True)
    source = await _load(session, project_id, source_id, lock=True)
    if if_match is not None and parse_if_match(if_match) != source.version:
        raise version_conflict(source.version)
    data = _event_data(source)
    await files.delete(source.id)
    await session.delete(source)
    audit.record(
        session,
        actor=principal.email,
        action=sources.AUDIT_SOURCE_DELETED,
        project_id=project_id,
        details={"sourceId": str(source_id), "name": source.name, "kind": source.kind},
    )
    await session.commit()
    await publisher.publish(DomainEvent(sources.SOURCE_DELETED, project_id, principal.email, data))
    return Response(status_code=status.HTTP_204_NO_CONTENT)
