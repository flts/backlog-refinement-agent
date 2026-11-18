from __future__ import annotations

import io
import uuid
from typing import Any

import httpx
import pytest
from pypdf import PdfWriter
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backlog_api import jobs
from backlog_api.db.models import AuditEvent, Job, Source, SourceFile
from backlog_api.events import DomainEvent
from backlog_api.settings import Settings
from backlog_api_testkit import API, TokenFactory, add_member, create_project

OWNER = "alice@example.test"
CONTRIBUTOR = "bob@example.test"
OUTSIDER = "carol@example.test"
PUBLIC_IP = "93.184.216.34"


def make_pdf(pages: list[str], *, encrypt: bool = False) -> bytes:
    writer = PdfWriter()
    for text in pages:
        page = writer.add_blank_page(width=300, height=300)
        if text:
            from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

            font = DictionaryObject(
                {
                    NameObject("/Type"): NameObject("/Font"),
                    NameObject("/Subtype"): NameObject("/Type1"),
                    NameObject("/BaseFont"): NameObject("/Helvetica"),
                }
            )
            page[NameObject("/Resources")] = DictionaryObject(
                {NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)})}
            )
            stream = DecodedStreamObject()
            stream.set_data(f"BT /F1 12 Tf 20 150 Td ({text}) Tj ET".encode())
            page[NameObject("/Contents")] = writer._add_object(stream)
    if encrypt:
        writer.encrypt("secret")
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


@pytest.fixture
async def project(client: httpx.AsyncClient, tokens: TokenFactory) -> dict[str, Any]:
    created = await create_project(client, tokens, OWNER, "Sources")
    assert (await add_member(client, tokens, created["id"], OWNER, CONTRIBUTOR)).status_code == 201
    return created


def url(project: dict[str, Any], suffix: str = "") -> str:
    return f"{API}/projects/{project['id']}/sources{suffix}"


async def upload(
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    project: dict[str, Any],
    filename: str,
    content: bytes,
    content_type: str = "application/octet-stream",
    *,
    email: str = OWNER,
    **fields: str,
) -> httpx.Response:
    return await client.post(
        url(project), files={"file": (filename, content, content_type)}, data=fields, headers=tokens.headers(email)
    )


async def test_upload_text_markdown_and_download(
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    project: dict[str, Any],
    published_events: list[DomainEvent],
    sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    body = b"# Notes\r\n\r\nHello world\n\n\n\nBye\n"
    response = await upload(client, tokens, project, "notes.md", body, "text/markdown", email=CONTRIBUTOR)
    assert response.status_code == 201, response.text
    created = response.json()
    assert created["name"] == "notes.md"
    assert created["kind"] == "file"
    assert created["mode"] == "searchable"
    assert created["indexStatus"] == "pending"
    assert created["addedBy"] == CONTRIBUTOR
    assert created["mediaType"] == "text/markdown"
    assert created["pageCount"] is None
    assert created["hasFile"] is True
    assert response.headers["etag"] == '"1"'
    assert response.headers["location"].endswith(f"/sources/{created['id']}")

    detail = (await client.get(url(project, f"/{created['id']}"), headers=tokens.headers(OWNER))).json()
    assert detail["text"] == "# Notes\n\nHello world\n\nBye"
    assert detail["charCount"] == len(detail["text"])
    no_text = (
        await client.get(url(project, f"/{created['id']}?includeText=false"), headers=tokens.headers(OWNER))
    ).json()
    assert no_text["text"] is None

    download = await client.get(url(project, f"/{created['id']}/file"), headers=tokens.headers(CONTRIBUTOR))
    assert download.status_code == 200
    assert download.content == body  # original bytes, untouched
    assert download.headers["content-type"].startswith("text/markdown")
    assert download.headers["content-disposition"].startswith('attachment; filename="notes.md"')
    assert download.headers["x-content-type-options"] == "nosniff"

    assert [e.type for e in published_events][-1:] == ["source.created"]
    assert published_events[-1].data["sourceId"] == created["id"]
    async with sessionmaker() as session:
        job = (await session.scalars(select(Job))).one()
        assert (job.kind, job.status) == ("index_source", "queued")
        assert job.payload["sourceId"] == created["id"]
        audit = (await session.scalars(select(AuditEvent).where(AuditEvent.action == "source.created"))).one()
        assert audit.actor == CONTRIBUTOR
        assert "Hello" not in str(audit.details)
        stored = (await session.scalars(select(SourceFile))).one()
        assert stored.size == len(body)
        assert len(stored.sha256) == 64


async def test_upload_pdf_extracts_pages(
    client: httpx.AsyncClient, tokens: TokenFactory, project: dict[str, Any]
) -> None:
    pdf = make_pdf(["First page text", "", "Third page"])
    response = await upload(client, tokens, project, "spec.pdf", pdf, "application/pdf", mode="pinned")
    assert response.status_code == 201, response.text
    created = response.json()
    assert created["pageCount"] == 3
    assert created["mediaType"] == "application/pdf"
    assert created["mode"] == "pinned"
    detail = (await client.get(url(project, f"/{created['id']}"), headers=tokens.headers(OWNER))).json()
    assert detail["text"].split("\f") == ["First page text", "", "Third page"]
    download = await client.get(url(project, f"/{created['id']}/file"), headers=tokens.headers(OWNER))
    assert download.content == pdf
    assert download.headers["content-type"] == "application/pdf"


async def test_pdf_detected_by_content_not_name(
    client: httpx.AsyncClient, tokens: TokenFactory, project: dict[str, Any]
) -> None:
    response = await upload(client, tokens, project, "data.bin", make_pdf(["Hidden pdf"]))
    assert response.status_code == 201, response.text
    assert response.json()["pageCount"] == 1


async def test_rejects_pdf_problems(client: httpx.AsyncClient, tokens: TokenFactory, project: dict[str, Any]) -> None:
    encrypted = await upload(client, tokens, project, "x.pdf", make_pdf(["secret"], encrypt=True), "application/pdf")
    assert encrypted.status_code == 422
    assert encrypted.json()["type"] == "/problems/encrypted-pdf"
    broken = await upload(client, tokens, project, "x.pdf", b"%PDF-1.7\nthis is not a pdf", "application/pdf")
    assert broken.status_code == 422
    assert broken.json()["type"] == "/problems/invalid-pdf"
    fake = await upload(client, tokens, project, "x.pdf", b"just text", "application/pdf")
    assert fake.status_code == 415
    blank = await upload(client, tokens, project, "blank.pdf", make_pdf(["", ""]), "application/pdf")
    assert blank.status_code == 422
    assert blank.json()["type"] == "/problems/no-text"


async def test_rejects_too_many_pages(
    app: Any, client: httpx.AsyncClient, tokens: TokenFactory, project: dict[str, Any]
) -> None:
    app.state.settings.source_max_pdf_pages = 3
    response = await upload(client, tokens, project, "long.pdf", make_pdf(["a", "b", "c", "d"]), "application/pdf")
    assert response.status_code == 422
    body = response.json()
    assert body["type"] == "/problems/too-many-pages"
    assert (body["pages"], body["limit"]) == (4, 3)


@pytest.mark.parametrize(
    ("filename", "content", "content_type"),
    [
        ("a.zip", b"PK\x03\x04" + b"\x00" * 50, "application/zip"),
        (
            "a.docx",
            b"PK\x03\x04" + b"\x00" * 50,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ),
        ("a.png", b"\x89PNG\r\n\x1a\n" + b"\x00" * 50, "image/png"),
        ("a.exe", b"MZ\x90\x00" + b"\x01\x02" * 50, "application/octet-stream"),
        ("a.txt", b"\xff\xfe\x00\x01 not utf8 \xc3\x28", "text/plain"),
        ("a.txt", b"text with a \x00 nul byte", "text/plain"),
    ],
)
async def test_rejects_binary_files(
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    project: dict[str, Any],
    filename: str,
    content: bytes,
    content_type: str,
) -> None:
    response = await upload(client, tokens, project, filename, content, content_type)
    assert response.status_code == 415, response.text
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["type"] == "/problems/unsupported-media-type"


async def test_rejects_too_large_upload(
    app: Any, client: httpx.AsyncClient, tokens: TokenFactory, project: dict[str, Any], settings: Settings
) -> None:
    app.state.settings.source_max_bytes = 2048
    response = await upload(client, tokens, project, "a.txt", b"a" * 3000, "text/plain")
    assert response.status_code == 413
    assert response.json()["type"] == "/problems/source-too-large"


async def test_upload_route_has_larger_body_limit_than_default(
    client: httpx.AsyncClient, tokens: TokenFactory, project: dict[str, Any], settings: Settings
) -> None:
    # The fixture's global limit is 64 KiB; uploads of 200 KiB are fine on the sources route only.
    assert settings.max_body_bytes == 64 * 1024
    response = await upload(client, tokens, project, "big.txt", b"line of text\n" * 15_000, "text/plain")
    assert response.status_code == 201, response.text
    other = await client.post(
        f"{API}/projects", content=b"x" * 100_000, headers={**tokens.headers(OWNER), "content-type": "text/plain"}
    )
    assert other.status_code == 413


async def test_default_upload_limit_is_ten_mib(settings: Settings) -> None:
    assert Settings(_env_file=None).source_max_bytes == 10 * 1024 * 1024  # pyright: ignore[reportCallIssue]


async def test_multipart_validation(client: httpx.AsyncClient, tokens: TokenFactory, project: dict[str, Any]) -> None:
    missing = await client.post(
        url(project), data={"name": "x"}, files={"other": ("a.txt", b"x")}, headers=tokens.headers(OWNER)
    )
    assert missing.status_code == 422
    bad_mode = await upload(client, tokens, project, "a.txt", b"hello", "text/plain", mode="bogus")
    assert bad_mode.status_code == 422
    empty = await upload(client, tokens, project, "a.txt", b"", "text/plain")
    assert empty.status_code == 422
    wrong_type = await client.post(
        url(project), content=b"x", headers={**tokens.headers(OWNER), "content-type": "text/plain"}
    )
    assert wrong_type.status_code == 415


async def test_text_source_and_validation(
    client: httpx.AsyncClient, tokens: TokenFactory, project: dict[str, Any]
) -> None:
    response = await client.post(
        url(project),
        json={"name": "Meeting notes", "text": "We decided X.", "mode": "pinned"},
        headers=tokens.headers(OWNER),
    )
    assert response.status_code == 201, response.text
    created = response.json()
    assert (created["kind"], created["mode"], created["hasFile"], created["charCount"]) == ("text", "pinned", False, 13)
    no_file = await client.get(url(project, f"/{created['id']}/file"), headers=tokens.headers(OWNER))
    assert no_file.status_code == 404
    assert no_file.json()["type"] == "/problems/no-original-file"
    for body in (
        {"text": "no name"},
        {"name": "n"},
        {"url": "https://a.test", "text": "t", "name": "n"},
        {"name": "n", "text": "t", "extra": 1},
        {"pastedText": "p", "name": "n", "text": "t"},
    ):
        invalid = await client.post(url(project), json=body, headers=tokens.headers(OWNER))
        assert invalid.status_code == 422, body
        assert invalid.json()["type"] == "/problems/validation-error"
    blank = await client.post(url(project), json={"name": "n", "text": "  \n "}, headers=tokens.headers(OWNER))
    assert blank.status_code == 422


async def test_url_source_pasted_text_fallback(
    client: httpx.AsyncClient, tokens: TokenFactory, project: dict[str, Any]
) -> None:
    response = await client.post(
        url(project),
        json={"url": "https://intranet.example/spec", "pastedText": "Copied text\r\nfrom page", "name": "Spec page"},
        headers=tokens.headers(OWNER),
    )
    assert response.status_code == 201, response.text
    created = response.json()
    assert (created["kind"], created["url"], created["name"]) == ("url", "https://intranet.example/spec", "Spec page")
    detail = (await client.get(url(project, f"/{created['id']}"), headers=tokens.headers(OWNER))).json()
    assert detail["text"] == "Copied text\nfrom page"
    bad = await client.post(
        url(project), json={"url": "javascript:alert(1)", "pastedText": "x"}, headers=tokens.headers(OWNER)
    )
    assert bad.status_code == 422


@pytest.mark.parametrize(
    "target",
    [
        "https://localhost/",
        "https://127.0.0.1/",
        "https://10.0.0.1/",
        "https://169.254.169.254/latest/meta-data/",
        "https://[::1]/",
        "http://example.com/",
        "ftp://example.com/",
    ],
)
async def test_url_source_ssrf_blocked(
    client: httpx.AsyncClient, tokens: TokenFactory, project: dict[str, Any], target: str
) -> None:
    response = await client.post(url(project), json={"url": target}, headers=tokens.headers(OWNER))
    assert response.status_code == 422, response.text
    problem = response.json()
    assert problem["type"] == "/problems/url-fetch-failed"
    assert "paste" in problem["detail"]


async def test_url_source_fetched_with_mocked_network(
    app: Any, client: httpx.AsyncClient, tokens: TokenFactory, project: dict[str, Any]
) -> None:
    async def resolve(host: str, port: int) -> list[str]:
        return [PUBLIC_IP]

    app.state.fetch_resolver = resolve
    app.state.fetch_transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200,
            content=(
                b"<html><head><title>Docs page</title></head><body><nav>menu</nav>"
                b"<main><p>Real content</p></main></body></html>"
            ),
            headers={"content-type": "text/html"},
        )
    )
    response = await client.post(url(project), json={"url": "https://docs.example/page"}, headers=tokens.headers(OWNER))
    assert response.status_code == 201, response.text
    created = response.json()
    assert (created["name"], created["kind"], created["url"], created["mediaType"]) == (
        "Docs page",
        "url",
        "https://docs.example/page",
        "text/html",
    )
    detail = (await client.get(url(project, f"/{created['id']}"), headers=tokens.headers(OWNER))).json()
    assert detail["text"] == "Real content"


async def test_pinned_budget(
    app: Any, client: httpx.AsyncClient, tokens: TokenFactory, project: dict[str, Any]
) -> None:
    app.state.settings.source_pinned_budget_chars = 100
    headers = tokens.headers(OWNER)
    first = await client.post(url(project), json={"name": "a", "text": "x" * 60, "mode": "pinned"}, headers=headers)
    assert first.status_code == 201
    over = await client.post(url(project), json={"name": "b", "text": "y" * 50, "mode": "pinned"}, headers=headers)
    assert over.status_code == 422
    problem = over.json()
    assert problem["type"] == "/problems/pinned-budget-exceeded"
    assert (problem["used"], problem["limit"], problem["required"]) == (60, 100, 50)

    second = (await client.post(url(project), json={"name": "b", "text": "y" * 50}, headers=headers)).json()
    assert second["mode"] == "searchable"
    listing = (await client.get(url(project), headers=headers)).json()
    assert listing["pinnedBudget"] == {"used": 60, "limit": 100}
    assert [item["name"] for item in listing["items"]] == ["a", "b"]
    assert "text" not in listing["items"][0]

    patch = await client.patch(
        url(project, f"/{second['id']}"), json={"mode": "pinned"}, headers={**headers, "If-Match": '"1"'}
    )
    assert patch.status_code == 422
    assert patch.json()["type"] == "/problems/pinned-budget-exceeded"
    # unpin the first one, then pinning the second works
    first_id = first.json()["id"]
    assert (
        await client.patch(
            url(project, f"/{first_id}"), json={"mode": "excluded"}, headers={**headers, "If-Match": '"1"'}
        )
    ).status_code == 200
    ok = await client.patch(
        url(project, f"/{second['id']}"), json={"mode": "pinned"}, headers={**headers, "If-Match": '"1"'}
    )
    assert ok.status_code == 200
    assert (await client.get(url(project), headers=headers)).json()["pinnedBudget"]["used"] == 50


async def test_patch_rename_mode_concurrency_and_events(
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    project: dict[str, Any],
    published_events: list[DomainEvent],
    sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    headers = tokens.headers(CONTRIBUTOR)
    created = (await client.post(url(project), json={"name": "doc", "text": "content"}, headers=headers)).json()
    target = url(project, f"/{created['id']}")
    assert (await client.patch(target, json={"name": "x"}, headers=headers)).status_code == 428
    assert (await client.patch(target, json={}, headers={**headers, "If-Match": "1"})).status_code == 422
    patched = await client.patch(
        target, json={"name": "Renamed", "mode": "excluded"}, headers={**headers, "If-Match": '"1"'}
    )
    assert patched.status_code == 200, patched.text
    assert patched.headers["etag"] == '"2"'
    assert patched.json()["name"] == "Renamed"
    assert patched.json()["mode"] == "excluded"
    stale = await client.patch(target, json={"name": "Again"}, headers={**headers, "If-Match": '"1"'})
    assert stale.status_code == 409
    assert stale.json()["currentVersion"] == 2
    noop = await client.patch(target, json={"name": "Renamed"}, headers={**headers, "If-Match": '"2"'})
    assert noop.status_code == 200
    assert noop.json()["version"] == 2
    assert [e.type for e in published_events if e.type.startswith("source.")] == ["source.created", "source.updated"]
    async with sessionmaker() as session:
        queued = (await session.scalars(select(Job).order_by(Job.id))).all()
        assert [j.payload["reason"] for j in queued] == ["created", "mode-changed"]
        actions = (await session.scalars(select(AuditEvent.action).where(AuditEvent.action.like("source.%")))).all()
        assert sorted(actions) == ["source.created", "source.updated"]


async def test_rename_does_not_enqueue_indexing(
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    project: dict[str, Any],
    sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    headers = tokens.headers(OWNER)
    created = (await client.post(url(project), json={"name": "doc", "text": "content"}, headers=headers)).json()
    await client.patch(url(project, f"/{created['id']}"), json={"name": "new"}, headers={**headers, "If-Match": '"1"'})
    async with sessionmaker() as session:
        assert await session.scalar(select(func.count()).select_from(Job)) == 1


async def test_delete_source(
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    project: dict[str, Any],
    published_events: list[DomainEvent],
    sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    headers = tokens.headers(CONTRIBUTOR)
    created = (await upload(client, tokens, project, "a.txt", b"hello there", "text/plain", email=CONTRIBUTOR)).json()
    target = url(project, f"/{created['id']}")
    assert (await client.delete(target, headers={**headers, "If-Match": '"9"'})).status_code == 409
    assert (await client.delete(target, headers=headers)).status_code == 204
    assert (await client.get(target, headers=headers)).status_code == 404
    assert (await client.delete(target, headers=headers)).status_code == 404
    assert published_events[-1].type == "source.deleted"
    async with sessionmaker() as session:
        assert await session.scalar(select(func.count()).select_from(Source)) == 0
        assert await session.scalar(select(func.count()).select_from(SourceFile)) == 0


async def test_project_delete_cascades_to_sources(
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    project: dict[str, Any],
    sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    await upload(client, tokens, project, "a.txt", b"hello there", "text/plain")
    assert (await client.delete(f"{API}/projects/{project['id']}", headers=tokens.headers(OWNER))).status_code == 204
    async with sessionmaker() as session:
        assert await session.scalar(select(func.count()).select_from(Source)) == 0
        assert await session.scalar(select(func.count()).select_from(SourceFile)) == 0


async def test_permissions_and_project_scoping(
    client: httpx.AsyncClient, tokens: TokenFactory, project: dict[str, Any]
) -> None:
    created = (
        await client.post(url(project), json={"name": "doc", "text": "content"}, headers=tokens.headers(OWNER))
    ).json()
    item = url(project, f"/{created['id']}")
    outsider = tokens.headers(OUTSIDER)
    for method, target, kwargs in [
        ("GET", url(project), {}),
        ("POST", url(project), {"json": {"name": "n", "text": "t"}}),
        ("POST", url(project), {"files": {"file": ("a.txt", b"hello", "text/plain")}}),
        ("GET", item, {}),
        ("GET", item + "/file", {}),
        ("PATCH", item, {"json": {"name": "n"}, "headers": {"If-Match": '"1"'}}),
        ("DELETE", item, {}),
    ]:
        extra = kwargs.pop("headers", {}) if "headers" in kwargs else {}
        response = await client.request(method, target, headers={**outsider, **extra}, **kwargs)
        assert response.status_code == 404, (method, target, response.text)
    unauthenticated = await client.get(url(project))
    assert unauthenticated.status_code == 401
    # a contributor can do everything on sources (permission matrix §5.2)
    contributor = tokens.headers(CONTRIBUTOR)
    assert (await client.get(url(project), headers=contributor)).status_code == 200
    assert (
        await client.patch(item, json={"mode": "excluded"}, headers={**contributor, "If-Match": '"1"'})
    ).status_code == 200
    assert (await client.delete(item, headers=contributor)).status_code == 204

    other = await create_project(client, tokens, OUTSIDER, "Other")
    other_source = (await client.post(url(other), json={"name": "n", "text": "t"}, headers=outsider)).json()
    cross = await client.get(url(project, f"/{other_source['id']}"), headers=tokens.headers(OWNER))
    assert cross.status_code == 404
    assert (await client.get(url(project, f"/{uuid.uuid4()}"), headers=tokens.headers(OWNER))).status_code == 404


async def test_jobs_claim_skip_locked(sessionmaker: async_sessionmaker[AsyncSession], app: Any) -> None:
    async with sessionmaker() as session:
        for index in range(3):
            await jobs.enqueue(session, jobs.INDEX_SOURCE, {"n": index})
        await jobs.enqueue(session, "other", {})
        await session.commit()
    async with sessionmaker() as first, sessionmaker() as second:
        claimed_first = await jobs.claim(first, [jobs.INDEX_SOURCE], limit=2)
        claimed_second = await jobs.claim(second, [jobs.INDEX_SOURCE], limit=2)  # skips rows locked by `first`
        assert [j.payload["n"] for j in claimed_first] == [0, 1]
        assert [j.payload["n"] for j in claimed_second] == [2]
        assert all(j.status == "running" and j.attempts == 1 for j in claimed_first)
        await first.commit()
        await second.commit()
    async with sessionmaker() as session:
        assert await jobs.claim(session, [jobs.INDEX_SOURCE], limit=5) == []
        await jobs.complete(session, claimed_first[0].id)
        await jobs.fail(session, claimed_first[1].id, "boom")
        await session.commit()
        statuses = {j.id: j.status for j in (await session.scalars(select(Job))).all()}
        assert statuses[claimed_first[0].id] == "done"
        assert statuses[claimed_first[1].id] == "failed"
