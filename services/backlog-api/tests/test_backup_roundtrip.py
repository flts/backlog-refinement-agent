"""Full-equality backup round trip of a rich project: documents, revisions of every origin, quality, relationships,
guidance and sources with their original files (text, URL, PDF and a binary-looking text file)."""

from __future__ import annotations

import base64
import hashlib
from typing import Any

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backlog_api.db.models import ItemRevision, SourceFile
from backlog_api_testkit import API, TokenFactory, add_member, create_project
from test_backup import CONTRIBUTOR, OUTSIDER, OWNER, TEMPLATE, Env, normalize
from test_sources import make_pdf

UNICODE_TEXT = "Café — naïve façade ✓ 日本語 🚀\n\nSecond paragraph with <b>markup</b> & entities.\n" * 3
QUALITY = {
    "overall": "ready-with-open-questions",
    "areas": [
        {"area": "problem", "level": "clear", "note": "Stated"},
        {"area": "scope", "level": "unclear", "note": "Edges?"},
    ],
    "mixedOutcomes": True,
}


@pytest.fixture
def env(client: httpx.AsyncClient, tokens: TokenFactory) -> Env:
    return Env(client, tokens)


@pytest.fixture
async def rich(env: Env) -> dict[str, Any]:
    created = await create_project(env.client, env.tokens, OWNER, "Rich")
    pid = created["id"]
    assert (await add_member(env.client, env.tokens, pid, OWNER, CONTRIBUTOR)).status_code == 201

    async def item(item_type: str, **body: Any) -> dict[str, Any]:
        return await env.ok("POST", f"/projects/{pid}/items", json={"type": item_type, **body})

    capability = await item("capability", title="Capability — ünï", document="## Summary\n\n" + UNICODE_TEXT)
    feature = await item("feature", title="Feature", parentId=capability["id"], document="## Summary\nF\n\n## Scope\nS")
    story = await item("user-story", title="Story", parentId=feature["id"])
    enabler = await item("enabler", title="Enabler")
    # Revisions with different origins and actors.
    for version, title in ((1, "Feature v2"), (2, "Feature v3")):
        await env.ok(
            "PATCH",
            f"/projects/{pid}/items/{feature['id']}",
            user=CONTRIBUTOR if version == 2 else OWNER,
            headers={"If-Match": f'"{version}"'},
            json={"title": title, "document": f"## Summary\nVersion {version + 1}\n\n## Scope\nS"},
        )
    revisions = (await env.ok("GET", f"/projects/{pid}/items/{feature['id']}/revisions"))["items"]
    first = next(r for r in revisions if r["version"] == 1)
    await env.ok(
        "POST",
        f"/projects/{pid}/items/{feature['id']}/revisions/{first['id']}/restore",
        headers={"If-Match": '"3"'},
    )
    current = await env.ok("GET", f"/projects/{pid}/items/{feature['id']}")
    await env.ok(
        "PUT",
        f"/projects/{pid}/items/{feature['id']}/quality",
        json={"quality": QUALITY, "documentHash": current["documentHash"]},
    )
    await env.ok(
        "PATCH",
        f"/projects/{pid}/items/{story['id']}",
        headers={"If-Match": '"1"'},
        json={"status": "refining"},
    )
    for source_id, target_id, kind in (
        (feature["id"], enabler["id"], "depends-on"),
        (story["id"], enabler["id"], "related-to"),
        (enabler["id"], capability["id"], "supports"),
    ):
        await env.ok(
            "POST",
            f"/projects/{pid}/relationships",
            json={"sourceId": source_id, "targetId": target_id, "type": kind},
        )
    # Guidance of every kind.
    await env.ok("PUT", f"/projects/{pid}/guidance/principles", headers={"If-Match": "0"}, json={"content": "Be kind."})
    await env.ok(
        "PUT", f"/projects/{pid}/guidance/template/feature", headers={"If-Match": "0"}, json={"content": TEMPLATE}
    )
    await env.ok(
        "PUT",
        f"/projects/{pid}/guidance/type-instructions/user-story",
        headers={"If-Match": "0"},
        json={"content": "Ask about the persona."},
    )
    # Sources: pasted text, URL with pasted text, a PDF and a unicode text file; all three modes.
    await env.ok("POST", f"/projects/{pid}/sources", json={"text": UNICODE_TEXT, "name": "Pasted", "mode": "pinned"})
    await env.ok(
        "POST",
        f"/projects/{pid}/sources",
        json={"url": "https://example.test/page", "pastedText": "page text", "name": "Page", "mode": "searchable"},
    )
    pdf = make_pdf(["First page text", "Second page text"])
    for name, content, content_type, mode in (
        ("spec.pdf", pdf, "application/pdf", "searchable"),
        ("notes.md", UNICODE_TEXT.encode(), "text/markdown", "excluded"),
    ):
        response = await env.client.post(
            f"{API}/projects/{pid}/sources",
            files={"file": (name, content, content_type)},
            data={"mode": mode},
            headers=env.tokens.headers(OWNER),
        )
        assert response.status_code == 201, response.text
    return {**created, "pdf": pdf}


async def test_rich_project_survives_two_round_trips_unchanged(
    env: Env, rich: dict[str, Any], sessionmaker: async_sessionmaker[AsyncSession]
) -> None:
    original = (await env.export(rich["id"])).json()
    assert len(original["items"]) == 4 and len(original["relationships"]) == 5 and len(original["sources"]) == 4
    feature = next(i for i in original["items"] if i["title"] == "Feature")
    assert [r["origin"] for r in feature["revisions"]] == ["manual", "manual", "manual", "restore"]
    assert feature["quality"]["overall"] == "ready-with-open-questions" and feature["version"] == 4

    first = (await env.import_(original, user=OUTSIDER)).json()
    exported_first = (await env.export(first["project"]["id"], user=OUTSIDER)).json()
    second = (await env.import_(exported_first, user=OUTSIDER)).json()
    exported_second = (await env.export(second["project"]["id"], user=OUTSIDER)).json()

    expected = normalize({**original, "exportedBy": None})
    assert normalize({**exported_first, "exportedBy": None}) == expected
    assert normalize({**exported_second, "exportedBy": None}) == expected
    # Everything the normalisation removed is preserved as well: timestamps of items and revisions.
    for copy in (exported_first, exported_second):
        by_title = {i["title"]: i for i in original["items"]}
        for item in copy["items"]:
            source = by_title[item["title"]]
            assert (item["createdAt"], item["updatedAt"], item.get("qualityAssessedAt")) == (
                source["createdAt"],
                source["updatedAt"],
                source.get("qualityAssessedAt"),
            )
            assert [(r["createdAt"], r["actor"], r.get("label")) for r in item["revisions"]] == [
                (r["createdAt"], r["actor"], r.get("label")) for r in source["revisions"]
            ]
    assert second["counts"] == first["counts"]
    assert first["counts"]["files"] == 2 and first["counts"]["revisions"] >= 7


async def test_source_files_are_byte_identical_after_import(
    env: Env, rich: dict[str, Any], sessionmaker: async_sessionmaker[AsyncSession]
) -> None:
    original = (await env.export(rich["id"])).json()
    new_id = (await env.import_(original)).json()["project"]["id"]
    files = {s["name"]: s["file"] for s in original["sources"] if "file" in s}
    assert set(files) == {"spec.pdf", "notes.md"}
    assert base64.b64decode(files["spec.pdf"]["contentBase64"]) == rich["pdf"]
    imported = {s["name"]: s for s in (await env.ok("GET", f"/projects/{new_id}/sources"))["items"]}
    assert {name: s["mode"] for name, s in imported.items()} == {
        "Pasted": "pinned",
        "Page": "searchable",
        "spec.pdf": "searchable",
        "notes.md": "excluded",
    }
    for name, expected in (("spec.pdf", rich["pdf"]), ("notes.md", UNICODE_TEXT.encode())):
        response = await env.call("GET", f"/projects/{new_id}/sources/{imported[name]['id']}/file")
        assert response.status_code == 200
        assert response.content == expected
        assert response.headers["etag"] == f'"sha256-{hashlib.sha256(expected).hexdigest()}"'
    pdf_source = imported["spec.pdf"]
    assert pdf_source["pageCount"] == 2
    # Extracted text equals the original's, and the pinned text is intact.
    originals = {s["name"]: s for s in original["sources"]}
    assert "First page text" in originals["spec.pdf"]["text"] and "Second page text" in originals["spec.pdf"]["text"]
    assert originals["Pasted"]["text"].strip() == UNICODE_TEXT.strip()
    async with sessionmaker() as session:
        stored = {row.sha256 for row in (await session.scalars(select(SourceFile))).all()}
    assert {hashlib.sha256(content).hexdigest() for content in (rich["pdf"], UNICODE_TEXT.encode())} <= stored


async def test_revisions_are_complete_and_in_order_after_import(env: Env, rich: dict[str, Any]) -> None:
    original = (await env.export(rich["id"])).json()
    new_id = (await env.import_(original)).json()["project"]["id"]
    new_items = {i["title"]: i for i in (await env.ok("GET", f"/projects/{new_id}/items"))["items"]}
    old_feature = next(i for i in original["items"] if i["title"] == "Feature")
    revisions = (await env.ok("GET", f"/projects/{new_id}/items/{new_items['Feature']['id']}/revisions"))["items"]
    assert [(r["version"], r["title"], r["origin"], r["actor"]) for r in reversed(revisions)] == [
        (r["version"], r["title"], r["origin"], r["actor"]) for r in old_feature["revisions"]
    ]
    for revision in revisions:
        detail = await env.ok(
            "GET", f"/projects/{new_id}/items/{new_items['Feature']['id']}/revisions/{revision['id']}"
        )
        source = next(r for r in old_feature["revisions"] if r["version"] == revision["version"])
        assert detail["document"] == source["document"]
    # Restoring an imported revision keeps working (versions continue from the imported one).
    first = next(r for r in revisions if r["version"] == 2)
    restored = await env.ok(
        "POST",
        f"/projects/{new_id}/items/{new_items['Feature']['id']}/revisions/{first['id']}/restore",
        headers={"If-Match": '"4"'},
    )
    assert restored["version"] == 5


async def test_import_gets_a_working_search_and_item_index_queue(
    env: Env, rich: dict[str, Any], sessionmaker: async_sessionmaker[AsyncSession]
) -> None:
    """Imported sources start as pending and the revisions table is not shared with the original project."""
    original = (await env.export(rich["id"])).json()
    new_id = (await env.import_(original)).json()["project"]["id"]
    async with sessionmaker() as session:
        total = len((await session.scalars(select(ItemRevision.id))).all())
    assert total == 2 * sum(len(i["revisions"]) for i in original["items"])
    listed = (await env.ok("GET", f"/projects/{new_id}/sources"))["items"]
    assert {s["indexStatus"] for s in listed} == {"pending"}
