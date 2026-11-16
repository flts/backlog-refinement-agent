from __future__ import annotations

import base64
import copy
import hashlib
import json
from typing import Any

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backlog_api import jobs
from backlog_api.backup import BACKUP_FORMAT, BACKUP_FORMAT_VERSION
from backlog_api.db.models import AuditEvent, Item, ItemRevision, Job, ProjectMember, Source, SourceFile
from backlog_api.events import DomainEvent
from backlog_api.settings import Settings
from backlog_api_testkit import API, TokenFactory, add_member, create_project

OWNER = "alice@example.test"
CONTRIBUTOR = "bob@example.test"
OUTSIDER = "carol@example.test"
PDFISH = b"%PDF-1.4 not really a pdf \x00\x01\x02\xff" + bytes(range(256))
TEMPLATE = "## Summary\n\nCustom template.\n"


class Env:
    def __init__(self, client: httpx.AsyncClient, tokens: TokenFactory) -> None:
        self.client, self.tokens = client, tokens

    async def call(self, method: str, path: str, user: str = OWNER, **kwargs: Any) -> httpx.Response:
        headers = {**self.tokens.headers(user), **kwargs.pop("headers", {})}
        return await self.client.request(method, f"{API}{path}", headers=headers, **kwargs)

    async def ok(self, method: str, path: str, user: str = OWNER, **kwargs: Any) -> dict[str, Any]:
        response = await self.call(method, path, user, **kwargs)
        assert response.status_code < 300, response.text
        return response.json()

    async def export(self, project_id: str, user: str = OWNER) -> httpx.Response:
        return await self.call("GET", f"/projects/{project_id}/backup", user)

    async def import_(self, document: Any, user: str = OWNER) -> httpx.Response:
        content = document if isinstance(document, bytes) else json.dumps(document).encode()
        return await self.client.post(
            f"{API}/projects/import",
            content=content,
            headers={**self.tokens.headers(user), "content-type": "application/json"},
        )


@pytest.fixture
def env(client: httpx.AsyncClient, tokens: TokenFactory) -> Env:
    return Env(client, tokens)


@pytest.fixture
async def project(env: Env) -> dict[str, Any]:
    """A project with a feature tree, revisions, relationships, sources (incl. a file) and guidance overrides."""
    created = await create_project(env.client, env.tokens, OWNER, "Backup Me")
    assert (await add_member(env.client, env.tokens, created["id"], OWNER, CONTRIBUTOR)).status_code == 201
    pid = created["id"]
    parent = await env.ok("POST", f"/projects/{pid}/items", json={"type": "feature", "title": "Parent"})
    child = await env.ok(
        "POST",
        f"/projects/{pid}/items",
        json={"type": "user-story", "title": "Child", "document": "## Story\n\nAs a user", "parentId": parent["id"]},
    )
    other = await env.ok("POST", f"/projects/{pid}/items", json={"type": "enabler", "title": "Other"})
    await env.ok(
        "PATCH",
        f"/projects/{pid}/items/{child['id']}",
        user=CONTRIBUTOR,
        headers={"If-Match": '"1"'},
        json={"title": "Child v2", "status": "refining"},
    )
    await env.ok(
        "POST",
        f"/projects/{pid}/relationships",
        json={"sourceId": other["id"], "targetId": parent["id"], "type": "supports"},
    )
    await env.ok("PUT", f"/projects/{pid}/guidance/principles", headers={"If-Match": "0"}, json={"content": "Be kind."})
    await env.ok(
        "PUT",
        f"/projects/{pid}/guidance/template/feature",
        headers={"If-Match": "0"},
        json={"content": TEMPLATE, "baseSkillVersion": "0.1.0"},
    )
    await env.ok("POST", f"/projects/{pid}/sources", json={"text": "pinned text", "name": "Notes", "mode": "pinned"})
    await env.ok(
        "POST",
        f"/projects/{pid}/sources",
        json={"url": "https://example.test/page", "pastedText": "page text", "name": "Page"},
    )
    upload = await env.client.post(
        f"{API}/projects/{pid}/sources",
        files={"file": ("data.txt", PDFISH[:0] or b"hello \xc3\xa9 file\n" * 20, "text/plain")},
        data={"mode": "excluded"},
        headers=env.tokens.headers(OWNER),
    )
    assert upload.status_code == 201, upload.text
    return created


def normalize(document: dict[str, Any]) -> dict[str, Any]:
    """Backup content without ids, refs and export timestamps."""
    doc = copy.deepcopy(document)
    refs = {item["ref"]: index for index, item in enumerate(doc["items"])}
    source_refs = {source["ref"]: index for index, source in enumerate(doc["sources"])}
    for item in doc["items"]:
        item["ref"] = refs[item["ref"]]
        for revision in item["revisions"]:
            revision.pop("createdAt")
        item.pop("createdAt")
        item.pop("updatedAt")
        item.pop("qualityAssessedAt", None)
    for source in doc["sources"]:
        source["ref"] = source_refs[source["ref"]]
    for relationship in doc["relationships"]:
        relationship["sourceRef"] = refs[relationship["sourceRef"]]
        relationship["targetRef"] = refs[relationship["targetRef"]]
    doc["relationships"].sort(key=lambda r: (r["type"], r["sourceRef"], r["targetRef"]))
    doc.pop("exportedAt")
    doc["project"].pop("name")
    return doc


async def test_export_shape_and_headers(env: Env, project: dict[str, Any]) -> None:
    response = await env.export(project["id"])
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    assert response.headers["content-disposition"].startswith('attachment; filename="backup-me-backup-')
    assert response.headers["content-disposition"].endswith('.json"')
    document = response.json()
    assert document["format"] == BACKUP_FORMAT
    assert document["formatVersion"] == BACKUP_FORMAT_VERSION == 2
    assert document["exportedBy"] == OWNER
    assert document["project"] == {"name": "Backup Me"}
    assert set(document) == {
        "format",
        "formatVersion",
        "exportedAt",
        "exportedBy",
        "project",
        "guidance",
        "items",
        "relationships",
        "sources",
    }
    assert document["guidance"]["principles"]["content"] == "Be kind."
    assert document["guidance"]["templates"]["feature"]["baseSkillVersion"] == "0.1.0"
    items = {item["title"]: item for item in document["items"]}
    assert set(items) == {"Parent", "Child v2", "Other"}
    child = items["Child v2"]
    assert [(r["version"], r["title"], r["origin"], r["actor"]) for r in child["revisions"]] == [
        (1, "Child", "manual", OWNER),
        (2, "Child v2", "manual", CONTRIBUTOR),
    ]
    assert child["status"] == "refining"
    kinds = {s["kind"]: s for s in document["sources"]}
    assert set(kinds) == {"text", "url", "file"}
    file = kinds["file"]["file"]
    content = base64.b64decode(file["contentBase64"])
    assert file["sha256"] == hashlib.sha256(content).hexdigest() and file["size"] == len(content)
    assert "members" not in document and "threads" not in document


async def test_round_trip_export_import_export(
    env: Env,
    project: dict[str, Any],
    sessionmaker: async_sessionmaker[AsyncSession],
    published_events: list[DomainEvent],
) -> None:
    original = (await env.export(project["id"])).json()
    published_events.clear()
    response = await env.import_(original, user=OUTSIDER)  # any authenticated user may import
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["project"]["name"] == "Backup Me"
    assert body["project"]["role"] == "owner"
    assert response.headers["location"] == f"{API}/projects/{body['project']['id']}"
    assert body["counts"] == {
        "items": 3,
        "revisions": 4,
        "relationships": 2,
        "sources": 3,
        "files": 1,
        "guidanceOverrides": 2,
    }
    assert [e.type for e in published_events] == ["project.created"]
    new_id = body["project"]["id"]
    # The importer is the only member; the original members are not copied.
    members = (await env.ok("GET", f"/projects/{new_id}/members", user=OUTSIDER))["items"]
    assert [(m["email"], m["role"]) for m in members] == [(OUTSIDER, "owner")]
    assert (await env.call("GET", f"/projects/{new_id}", user=OWNER)).status_code == 404
    # The new project is independent: new ids, same content (the backup's owner does not need to be a member).
    again = await env.export(new_id, user=OUTSIDER)
    assert again.status_code == 200
    exported_again = again.json()
    assert exported_again["exportedBy"] == OUTSIDER
    assert exported_again["project"] == original["project"]
    assert {i["ref"] for i in exported_again["items"]}.isdisjoint({i["ref"] for i in original["items"]})
    assert normalize({**exported_again, "exportedBy": None}) == normalize({**original, "exportedBy": None})
    # Timestamps and revision times are kept too.
    by_title = {i["title"]: i for i in original["items"]}
    for item in exported_again["items"]:
        assert item["createdAt"] == by_title[item["title"]]["createdAt"]
        assert [r["createdAt"] for r in item["revisions"]] == [
            r["createdAt"] for r in by_title[item["title"]]["revisions"]
        ]
    async with sessionmaker() as session:
        sources = (await session.scalars(select(Source).where(Source.project_id == new_id))).all()
        assert {s.index_status for s in sources} == {"pending"}
        queued = (await session.scalars(select(Job).where(Job.kind == jobs.INDEX_SOURCE, Job.status == "queued"))).all()
        assert {j.payload["sourceId"] for j in queued if j.payload["projectId"] == new_id} == {
            str(s.id) for s in sources
        }
        item_jobs = (await session.scalars(select(Job).where(Job.kind == "index_item"))).all()
        assert len([j for j in item_jobs if j.payload["projectId"] == new_id]) == 3
        audit = (await session.scalars(select(AuditEvent).where(AuditEvent.project_id == new_id))).all()
        assert "project.imported" in {a.action for a in audit}
        assert (await session.scalars(select(ProjectMember.email).where(ProjectMember.project_id == new_id))).all() == [
            OUTSIDER
        ]


async def test_import_restores_files_byte_for_byte_and_relationships(
    env: Env, project: dict[str, Any], sessionmaker: async_sessionmaker[AsyncSession]
) -> None:
    original = (await env.export(project["id"])).json()
    new_id = (await env.import_(original)).json()["project"]["id"]
    source_ids = [s["id"] for s in (await env.ok("GET", f"/projects/{new_id}/sources"))["items"]]
    assert len(source_ids) == 3
    expected = {s["name"]: base64.b64decode(s["file"]["contentBase64"]) for s in original["sources"] if "file" in s}
    async with sessionmaker() as session:
        rows = (await session.scalars(select(SourceFile))).all()
        stored = {r.sha256: r.content for r in rows}
    for content in expected.values():
        assert stored[hashlib.sha256(content).hexdigest()] == content
    relationships = (await env.ok("GET", f"/projects/{new_id}/relationships"))["items"]
    items = {i["id"]: i for i in (await env.ok("GET", f"/projects/{new_id}/items"))["items"]}
    assert {(items[r["sourceId"]]["title"], items[r["targetId"]]["title"], r["type"]) for r in relationships} == {
        ("Parent", "Child v2", "parent-child"),
        ("Other", "Parent", "supports"),
    }
    guidance = await env.ok("GET", f"/projects/{new_id}/guidance")
    assert guidance["principles"]["content"] == "Be kind."
    assert guidance["templates"]["feature"]["source"] == "project"
    child = next(i for i in items.values() if i["title"] == "Child v2")
    revisions = (await env.ok("GET", f"/projects/{new_id}/items/{child['id']}/revisions"))["items"]
    assert [(r["version"], r["origin"], r["actor"]) for r in revisions][::-1] == [
        (1, "manual", OWNER),
        (2, "manual", CONTRIBUTOR),
    ]
    assert child["version"] == 2 and child["status"] == "refining"


async def test_import_keeps_at_most_revisions_keep(
    env: Env, project: dict[str, Any], app: Any, sessionmaker: async_sessionmaker[AsyncSession]
) -> None:
    original = (await env.export(project["id"])).json()
    app.state.settings.revisions_keep = 1
    new_id = (await env.import_(original)).json()["project"]["id"]
    async with sessionmaker() as session:
        child = await session.scalar(select(Item).where(Item.project_id == new_id, Item.title == "Child v2"))
        assert child is not None
        versions = (await session.scalars(select(ItemRevision.version).where(ItemRevision.item_id == child.id))).all()
        assert list(versions) == [2]


async def test_import_name_suffix_when_name_taken(env: Env, project: dict[str, Any]) -> None:
    original = (await env.export(project["id"])).json()
    first = (await env.import_(original)).json()["project"]
    assert first["name"] == "Backup Me (imported)"  # the owner already has "Backup Me"


async def test_export_authorization(env: Env, project: dict[str, Any]) -> None:
    contributor = await env.export(project["id"], user=CONTRIBUTOR)
    assert contributor.status_code == 403
    assert contributor.json()["type"] == "/problems/owner-required"
    assert (await env.export(project["id"], user=OUTSIDER)).status_code == 404
    unauthenticated = await env.client.get(f"{API}/projects/{project['id']}/backup")
    assert unauthenticated.status_code == 401


async def test_import_requires_verified_email(env: Env, project: dict[str, Any]) -> None:
    response = await env.client.post(
        f"{API}/projects/import",
        content=b"{}",
        headers={**env.tokens.headers("dave@example.test", email_verified=False), "content-type": "application/json"},
    )
    assert response.status_code == 403


async def test_export_too_large_is_413(env: Env, project: dict[str, Any], app: Any) -> None:
    app.state.settings.backup_max_bytes = 2048
    response = await env.export(project["id"])
    assert response.status_code == 413
    assert response.json()["type"] == "/problems/backup-too-large"
    assert response.headers["content-type"].startswith("application/problem+json")


async def test_export_limit_is_enforced_on_the_final_document(env: Env, project: dict[str, Any], app: Any) -> None:
    exported = len((await env.export(project["id"])).content)
    app.state.settings.backup_max_bytes = max(exported - 10, 1024)
    assert (await env.export(project["id"])).status_code == 413
    app.state.settings.backup_max_bytes = exported + 10
    assert (await env.export(project["id"])).status_code == 200


async def test_import_too_large_is_413(env: Env, project: dict[str, Any], app: Any) -> None:
    original = (await env.export(project["id"])).content
    app.state.settings.max_body_bytes = 64 * 1024
    big = original + b" " * (100 * 1024)
    # The import route has its own (larger) limit, the default one applies elsewhere.
    assert (await env.import_(big)).status_code == 201
    assert Settings(_env_file=None).backup_max_bytes == 50 * 1024 * 1024  # pyright: ignore[reportCallIssue]


async def test_import_body_over_backup_limit_is_413(
    client: httpx.AsyncClient, tokens: TokenFactory, settings: Settings
) -> None:
    from backlog_api.main import create_app

    small = settings.model_copy(update={"backup_max_bytes": 2048})
    from asgi_lifespan import LifespanManager

    from backlog_api.auth.tokens import StaticKeySource

    application = create_app(small, key_source=StaticKeySource(tokens.jwks), configure_logs=False)
    async with LifespanManager(application, startup_timeout=30):
        transport = httpx.ASGITransport(app=application)
        async with httpx.AsyncClient(transport=transport, base_url="http://backlog-api.test") as http:
            response = await http.post(
                f"{API}/projects/import",
                content=b" " * 4096,
                headers={**tokens.headers(OWNER), "content-type": "application/json"},
            )
    assert response.status_code == 413
    assert response.json()["type"] == "/problems/payload-too-large"


def minimal(**changes: Any) -> dict[str, Any]:
    document: dict[str, Any] = {
        "format": BACKUP_FORMAT,
        "formatVersion": 2,
        "exportedAt": "2026-01-01T00:00:00Z",
        "project": {"name": "Minimal"},
        "guidance": {},
        "items": [],
        "relationships": [],
        "sources": [],
    }
    document.update(changes)
    return document


def item(ref: str, item_type: str = "feature", **changes: Any) -> dict[str, Any]:
    return {
        "ref": ref,
        "type": item_type,
        "title": ref,
        "document": "## Summary\n\nx",
        "status": "draft",
        "createdAt": "2026-01-01T00:00:00Z",
        "updatedAt": "2026-01-01T00:00:00Z",
        "revisions": [],
        **changes,
    }


def source(ref: str, **changes: Any) -> dict[str, Any]:
    return {"ref": ref, "name": ref, "kind": "text", "mode": "searchable", "text": "abc", "charCount": 3, **changes}


async def test_minimal_backup_imports_with_synthesized_revision(env: Env) -> None:
    response = await env.import_(minimal(items=[item("a")]))
    assert response.status_code == 201, response.text
    new_id = response.json()["project"]["id"]
    items = (await env.ok("GET", f"/projects/{new_id}/items"))["items"]
    revisions = (await env.ok("GET", f"/projects/{new_id}/items/{items[0]['id']}/revisions"))["items"]
    assert [(r["version"], r["label"]) for r in revisions] == [(1, "Imported")]


@pytest.mark.parametrize(
    ("document", "needle"),
    [
        (minimal(items=[item("a"), item("a")]), "duplicate ref"),
        (
            minimal(items=[item("a")], relationships=[{"sourceRef": "a", "targetRef": "zzz", "type": "supports"}]),
            "existing items",
        ),
        (
            minimal(items=[item("a")], relationships=[{"sourceRef": "a", "targetRef": "a", "type": "supports"}]),
            "itself",
        ),
        (
            minimal(
                items=[item("a"), item("b")],
                relationships=[
                    {"sourceRef": "a", "targetRef": "b", "type": "supports"},
                    {"sourceRef": "a", "targetRef": "b", "type": "supports"},
                ],
            ),
            "duplicate relationship",
        ),
        (
            minimal(
                items=[item("a", "user-story"), item("b", "capability")],
                relationships=[{"sourceRef": "a", "targetRef": "b", "type": "parent-child"}],
            ),
            "cannot be a child",
        ),
        (minimal(items=[item("a", "epic")]), "items.0.type"),
        (minimal(items=[item("a", status="done")]), "items.0.status"),
        (minimal(items=[item("a", title="  ")]), "items.0.title"),
        (minimal(items=[item("a", quality={"overall": "bogus"})]), "quality"),
        (minimal(sources=[source("s", charCount=99)]), "charCount"),
        (minimal(sources=[source("s", kind="file")]), "needs its original file"),
        (minimal(sources=[source("s", kind="url", url="ftp://x.test/a")]), "http(s)"),
        (minimal(sources=[source("s"), source("s")]), "duplicate ref"),
        (minimal(guidance={"templates": {"feature": {"content": "## A\n\n{{placeholder}}"}}}), "templates.feature"),
        (minimal(guidance={"templates": {"epic": {"content": "x"}}}), "unknown item type"),
        (minimal(project={"name": ""}), "project.name"),
        (minimal(unexpected=True), "unexpected"),
    ],
)
async def test_invalid_documents_are_422_and_create_nothing(
    env: Env, document: dict[str, Any], needle: str, sessionmaker: async_sessionmaker[AsyncSession]
) -> None:
    response = await env.import_(document)
    assert response.status_code == 422, response.text
    problem = response.json()
    assert problem["type"] == "/problems/invalid-backup"
    assert needle in " ".join(problem["issues"]), problem
    assert (await env.ok("GET", "/projects"))["items"] == []


async def test_sha_and_size_mismatch_are_422(env: Env) -> None:
    content = b"file content"
    good = {
        "mediaType": "text/plain",
        "size": len(content),
        "sha256": hashlib.sha256(content).hexdigest(),
        "contentBase64": base64.b64encode(content).decode(),
    }
    ok = await env.import_(minimal(sources=[source("s", kind="file", mediaType="text/plain", file=good)]))
    assert ok.status_code == 201, ok.text
    bad_sha = {**good, "sha256": "0" * 64}
    response = await env.import_(minimal(sources=[source("s", kind="file", file=bad_sha)]))
    assert response.status_code == 422
    assert "sha256 does not match" in " ".join(response.json()["issues"])
    bad_size = {**good, "size": 3}
    response = await env.import_(minimal(sources=[source("s", kind="file", file=bad_size)]))
    assert "does not match the content" in " ".join(response.json()["issues"])
    bad_b64 = {**good, "contentBase64": "###"}
    response = await env.import_(minimal(sources=[source("s", kind="file", file=bad_b64)]))
    assert "not valid base64" in " ".join(response.json()["issues"])


async def test_file_larger_than_source_limit_is_422(env: Env, app: Any) -> None:
    app.state.settings.source_max_bytes = 1024
    content = b"x" * 2048
    file = {
        "mediaType": "text/plain",
        "size": len(content),
        "sha256": hashlib.sha256(content).hexdigest(),
        "contentBase64": base64.b64encode(content).decode(),
    }
    response = await env.import_(minimal(sources=[source("s", kind="file", file=file)]))
    assert response.status_code == 422
    assert "exceeds 1024 bytes" in " ".join(response.json()["issues"])


async def test_pinned_budget_is_checked(env: Env, app: Any) -> None:
    app.state.settings.source_pinned_budget_chars = 5
    document = minimal(sources=[source("a", mode="pinned"), source("b", mode="pinned")])
    response = await env.import_(document)
    assert response.status_code == 422
    assert "pinned sources total" in " ".join(response.json()["issues"])


@pytest.mark.parametrize(
    "document",
    [
        {"format": "other", "formatVersion": 2},
        {"format": BACKUP_FORMAT, "formatVersion": 3},
        {"format": BACKUP_FORMAT, "formatVersion": 1},
        {"format": "backlog-refinement-project", "version": 2},
        {},
    ],
)
async def test_unsupported_formats(env: Env, document: dict[str, Any]) -> None:
    response = await env.import_(document)
    assert response.status_code == 422
    assert response.json()["type"] == "/problems/unsupported-format"


async def test_not_json_and_wrong_content_type(env: Env, client: httpx.AsyncClient, tokens: TokenFactory) -> None:
    response = await env.import_(b"not json")
    assert response.status_code == 422
    assert response.json()["type"] == "/problems/invalid-backup"
    wrong = await client.post(f"{API}/projects/import", content=b"{}", headers=tokens.headers(OWNER))
    assert wrong.status_code in (415, 422)


V1_DOC: dict[str, Any] = {
    "format": "backlog-refinement-project",
    "version": 1,
    "project": {
        "id": "p1",
        "name": "Legacy",
        "createdAt": "2025-01-01T00:00:00.000Z",
        "updatedAt": "2025-01-02T00:00:00.000Z",
    },
    "sources": [
        {
            "id": "s1",
            "projectId": "p1",
            "name": "spec.txt",
            "kind": "file",
            "mediaType": "text/plain",
            "text": "spec text",
            "selected": True,
            "file": {"type": "text/plain", "data": base64.b64encode(b"spec text").decode()},
            "createdAt": "2025-01-01T00:00:00.000Z",
            "updatedAt": "2025-01-01T00:00:00.000Z",
        },
        {
            "id": "s2",
            "projectId": "p1",
            "name": "page",
            "kind": "url",
            "mediaType": "text/html",
            "text": "page",
            "selected": False,
            "url": "https://example.test/x",
            "createdAt": "2025-01-01T00:00:00.000Z",
            "updatedAt": "2025-01-01T00:00:00.000Z",
        },
    ],
    "items": [
        {
            "id": "i1",
            "projectId": "p1",
            "type": "feature",
            "title": "Feature",
            "description": "## Summary\n\nNew",
            "status": "refining",
            "createdAt": "2025-01-01T00:00:00.000Z",
            "updatedAt": "2025-01-03T00:00:00.000Z",
            "revisions": [
                {"title": "Old title", "description": "## Summary\n\nOld", "savedAt": "2025-01-02T00:00:00.000Z"}
            ],
            "quality": {"areas": [], "overall": "ready"},
        },
        {
            "id": "i2",
            "projectId": "p1",
            "type": "user-story",
            "title": "Story",
            "description": "",
            "status": "draft",
            "createdAt": "2025-01-01T00:00:00.000Z",
            "updatedAt": "2025-01-01T00:00:00.000Z",
            "revisions": [],
        },
    ],
    "relationships": [{"sourceId": "i1", "targetId": "i2", "type": "parent-child"}],
    "sessions": [],
}


async def test_v1_export_is_mapped(env: Env, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
    response = await env.import_(V1_DOC)
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["project"]["name"] == "Legacy"
    assert body["counts"] == {
        "items": 2,
        "revisions": 3,
        "relationships": 1,
        "sources": 2,
        "files": 1,
        "guidanceOverrides": 0,
    }
    new_id = body["project"]["id"]
    exported = (await env.export(new_id)).json()
    feature = next(i for i in exported["items"] if i["title"] == "Feature")
    assert feature["document"] == "## Summary\n\nNew"
    assert [(r["version"], r["title"], r["actor"]) for r in feature["revisions"]] == [
        (1, "Old title", OWNER),
        (2, "Feature", OWNER),
    ]
    assert feature["quality"]["overall"] == "ready"
    assert {s["name"]: s["mode"] for s in exported["sources"]} == {"spec.txt": "searchable", "page": "excluded"}
    listing = (await env.ok("GET", f"/projects/{new_id}/items"))["items"]
    assert next(i for i in listing if i["title"] == "Feature")["quality"]["stale"] is True


async def test_v1_invalid_references_are_422(env: Env) -> None:
    broken = copy.deepcopy(V1_DOC)
    broken["relationships"] = [{"sourceId": "i1", "targetId": "nope", "type": "supports"}]
    response = await env.import_(broken)
    assert response.status_code == 422
    assert response.json()["type"] == "/problems/invalid-backup"
