from __future__ import annotations

import uuid
from typing import Any

import httpx
import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backlog_api import items_service
from backlog_api.db.models import AuditEvent, Item, ItemRevision, Relationship
from backlog_api.document import SectionUpdate, apply_section_updates, document_hash
from backlog_api.events import DomainEvent
from backlog_api.items_service import ChildSpec, RelationshipSpec, SectionChange
from backlog_api.problems import ProblemError
from backlog_api_testkit import API, TokenFactory, add_member, create_project

OWNER = "alice@example.test"
CONTRIBUTOR = "bob@example.test"
OUTSIDER = "carol@example.test"


@pytest.fixture
async def project(client: httpx.AsyncClient, tokens: TokenFactory) -> dict[str, Any]:
    project = await create_project(client, tokens, OWNER, "Items")
    assert (await add_member(client, tokens, project["id"], OWNER, CONTRIBUTOR)).status_code == 201
    return project


class Api:
    def __init__(self, client: httpx.AsyncClient, tokens: TokenFactory, project_id: str) -> None:
        self.client, self.tokens, self.project_id = client, tokens, project_id

    def url(self, suffix: str = "") -> str:
        return f"{API}/projects/{self.project_id}{suffix}"

    async def call(
        self, method: str, suffix: str, *, user: str = OWNER, version: int | str | None = None, **kwargs: Any
    ) -> httpx.Response:
        headers = self.tokens.headers(user)
        if version is not None:
            headers["If-Match"] = f'"{version}"' if isinstance(version, int) else version
        return await self.client.request(method, self.url(suffix), headers=headers, **kwargs)

    async def create(self, item_type: str = "capability", **body: Any) -> dict[str, Any]:
        response = await self.call("POST", "/items", json={"type": item_type, **body})
        assert response.status_code == 201, response.text
        return response.json()

    async def patch(self, item: dict[str, Any], version: int | None = None, **body: Any) -> httpx.Response:
        return await self.call(
            "PATCH", f"/items/{item['id']}", version=item["version"] if version is None else version, json=body
        )


@pytest.fixture
def api(client: httpx.AsyncClient, tokens: TokenFactory, project: dict[str, Any]) -> Api:
    return Api(client, tokens, project["id"])


# --- CRUD ------------------------------------------------------------------------------------------


async def test_create_uses_the_template_and_defaults(api: Api, published_events: list[DomainEvent]) -> None:
    item = await api.create("feature")
    assert item["title"] == "Untitled Feature"
    assert item["status"] == "draft"
    assert item["version"] == 1
    assert item["parentId"] is None
    assert item["documentHash"] == document_hash(item["document"])
    assert item["document"].startswith("## Summary")
    assert "<!--" not in item["document"]
    assert [e.type for e in published_events] == ["item.created"]
    assert published_events[0].data["id"] == item["id"]


async def test_create_uses_the_project_template_override(api: Api) -> None:
    template = "## Summary\n\nProject specific.\n\n## Context\n"
    response = await api.call("PUT", "/guidance/template/feature", version="0", json={"content": template})
    assert response.status_code == 200, response.text
    item = await api.create("feature")
    assert item["document"] == "## Summary\n\n## Context"


async def test_create_conforms_a_given_document_and_attaches_a_parent(api: Api) -> None:
    capability = await api.create("capability", title=" Search ")
    assert capability["title"] == "Search"
    child = await api.create(
        "feature", title="Facets", parentId=capability["id"], document="## Summary\nFilter results\n\n## Notes\nx"
    )
    assert child["parentId"] == capability["id"]
    assert "## Summary\nFilter results" in child["document"]
    assert "## Additional notes\n### Notes\nx" in child["document"]


async def test_create_rejects_invalid_parent_types_and_missing_parents(api: Api) -> None:
    story = await api.create("user-story")
    response = await api.call("POST", "/items", json={"type": "feature", "parentId": story["id"]})
    assert response.status_code == 422
    assert response.json()["type"] == "/problems/invalid-child-type"
    capability = await api.create("capability")
    response = await api.call("POST", "/items", json={"type": "user-story", "parentId": capability["id"]})
    assert response.status_code == 422
    response = await api.call("POST", "/items", json={"type": "feature", "parentId": str(uuid.uuid4())})
    assert response.status_code == 404
    assert (await api.call("POST", "/items", json={"type": "epic"})).status_code == 422


async def test_get_list_and_etag(api: Api) -> None:
    capability = await api.create("capability", title="Cap")
    feature = await api.create("feature", title="Feat", parentId=capability["id"])
    response = await api.call("GET", f"/items/{feature['id']}")
    assert response.status_code == 200
    assert response.headers["ETag"] == '"1"'
    assert response.json()["document"] == feature["document"]
    listing = (await api.call("GET", "/items")).json()["items"]
    assert [(i["title"], i["parentId"]) for i in listing] == [("Cap", None), ("Feat", capability["id"])]
    assert "document" not in listing[0]
    assert set(listing[0]) >= {
        "id",
        "parentId",
        "type",
        "title",
        "status",
        "version",
        "quality",
        "updatedAt",
        "updatedBy",
    }
    assert (await api.call("GET", f"/items/{uuid.uuid4()}")).status_code == 404


async def test_patch_requires_if_match_and_bumps_version(api: Api, published_events: list[DomainEvent]) -> None:
    item = await api.create()
    missing = await api.call("PATCH", f"/items/{item['id']}", json={"title": "x"})
    assert missing.status_code == 428
    assert (await api.call("PATCH", f"/items/{item['id']}", version="abc", json={"title": "x"})).status_code == 400
    published_events.clear()

    response = await api.patch(item, title="Renamed", document="## Summary\nHello")
    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["title"], body["version"], body["updatedBy"]) == ("Renamed", 2, OWNER)
    assert response.headers["ETag"] == '"2"'
    assert body["documentHash"] == document_hash("## Summary\nHello")
    [event] = published_events
    assert event.type == "item.updated"
    assert event.data["version"] == 2
    assert event.data["changedSections"][0] == "Summary"  # the template's other (now removed) sections follow
    assert event.data["origin"] == "manual"


async def test_noop_patch_keeps_the_version(api: Api) -> None:
    item = await api.create()
    response = await api.patch(item, title=item["title"], document=item["document"])
    assert response.status_code == 200
    assert response.json()["version"] == 1


async def test_stale_patch_returns_409_with_changed_sections_and_current_item(api: Api) -> None:
    def edit(document: str, **sections: str) -> str:
        updates = [SectionUpdate(heading, text) for heading, text in sections.items()]
        return apply_section_updates(document, updates).document

    item = await api.create("feature", document="## Summary\nOne\n\n## Scope\nS")
    first = (await api.patch(item, document=edit(item["document"], Summary="Two"))).json()
    second = (await api.patch(first, document=edit(first["document"], Scope="S2"))).json()
    assert second["version"] == 3

    conflict = await api.patch(item, version=1, title="Mine", document=edit(item["document"], Summary="Mine"))
    assert conflict.status_code == 409
    problem = conflict.json()
    assert problem["type"] == "/problems/version-conflict"
    assert problem["currentVersion"] == 3
    assert problem["changedSections"] == ["Summary", "Scope"]
    assert problem["item"]["version"] == 3
    assert problem["item"]["document"] == second["document"]
    assert conflict.headers["ETag"] == '"3"'
    # base version 2 only saw the Scope change
    assert (await api.patch(first, version=2, title="Mine")).json()["changedSections"] == ["Scope"]


async def test_delete_removes_relationships_and_keeps_related_items(
    api: Api, published_events: list[DomainEvent]
) -> None:
    parent = await api.create("capability")
    child = await api.create("feature", parentId=parent["id"])
    published_events.clear()
    assert (await api.call("DELETE", f"/items/{parent['id']}", version=99)).status_code == 409
    response = await api.call("DELETE", f"/items/{parent['id']}")
    assert response.status_code == 204
    assert (await api.call("GET", f"/items/{parent['id']}")).status_code == 404
    kept = (await api.call("GET", f"/items/{child['id']}")).json()
    assert kept["parentId"] is None
    assert (await api.call("GET", "/relationships")).json()["items"] == []
    assert sorted(e.type for e in published_events) == ["item.deleted", "relationship.deleted"]


# --- status transitions ----------------------------------------------------------------------------


async def test_status_transitions_follow_the_spa_rules(api: Api) -> None:
    item = await api.create()
    invalid = await api.patch(item, status="ready")
    assert invalid.status_code == 422
    assert invalid.json()["type"] == "/problems/invalid-status-transition"
    refining = (await api.patch(item, status="refining")).json()
    assert refining["status"] == "refining"
    ready = (await api.patch(refining, status="ready")).json()
    assert ready["version"] == 3
    assert (await api.patch(ready, status="draft")).status_code == 422
    complete = (await api.patch(ready, status="complete")).json()
    reopened = await api.patch(complete, status="refining")
    assert reopened.json()["status"] == "refining"
    same = await api.patch(reopened.json(), status="refining")
    assert same.json()["version"] == reopened.json()["version"]


# --- revisions -------------------------------------------------------------------------------------


async def test_revisions_are_written_for_title_and_document_changes_only(api: Api) -> None:
    item = await api.create(title="One")
    await api.patch(item, status="refining")  # status only: no revision
    current = (await api.call("GET", f"/items/{item['id']}")).json()
    current = (await api.patch(current, title="Two")).json()
    current = (await api.patch(current, document="## Summary\nB")).json()
    listing = (await api.call("GET", f"/items/{item['id']}/revisions")).json()["items"]
    assert [r["version"] for r in listing] == [4, 3, 1]
    assert [r["origin"] for r in listing] == ["manual", "manual", "manual"]
    assert listing[2]["label"] == "Created"
    assert listing[0]["actor"] == OWNER
    assert "document" not in listing[0]
    detail = (await api.call("GET", f"/items/{item['id']}/revisions/{listing[0]['id']}")).json()
    assert detail["document"] == "## Summary\nB"
    assert (await api.call("GET", f"/items/{item['id']}/revisions/{uuid.uuid4()}")).status_code == 404


async def test_revisions_keep_only_the_newest_n(
    api: Api, sessionmaker: async_sessionmaker[AsyncSession], project: dict[str, Any]
) -> None:
    item = await api.create()
    async with sessionmaker() as session:
        current = item
        for index in range(5):
            await items_service.update_item(
                session,
                uuid.UUID(project["id"]),
                uuid.UUID(item["id"]),
                expected_version=current["version"] + index,
                title=f"T{index}",
                actor=OWNER,
                keep=3,
            )
        await session.commit()
        versions = (
            await session.scalars(
                select(ItemRevision.version)
                .where(ItemRevision.item_id == uuid.UUID(item["id"]))
                .order_by(ItemRevision.version)
            )
        ).all()
    assert list(versions) == [4, 5, 6]


async def test_default_revision_limit_is_configurable(settings: Any) -> None:
    assert settings.revisions_keep == 50


async def test_restore_creates_a_new_version_with_origin_restore(api: Api, published_events: list[DomainEvent]) -> None:
    item = await api.create(title="Original", document="## Summary\nv1")
    current = (await api.patch(item, title="Changed", document="## Summary\nv2")).json()
    revisions = (await api.call("GET", f"/items/{item['id']}/revisions")).json()["items"]
    first = next(r for r in revisions if r["version"] == 1)
    stale = await api.call("POST", f"/items/{item['id']}/revisions/{first['id']}/restore", version=1)
    assert stale.status_code == 409
    published_events.clear()
    response = await api.call(
        "POST", f"/items/{item['id']}/revisions/{first['id']}/restore", version=current["version"]
    )
    assert response.status_code == 200, response.text
    restored = response.json()
    assert (restored["title"], restored["version"]) == ("Original", 3)
    assert "v1" in restored["document"]
    newest = (await api.call("GET", f"/items/{item['id']}/revisions")).json()["items"][0]
    assert (newest["origin"], newest["version"], newest["label"]) == ("restore", 3, "Restored version 1")
    assert published_events[0].data["origin"] == "restore"
    assert (await api.call("POST", f"/items/{item['id']}/revisions/{uuid.uuid4()}/restore")).status_code == 404


# --- relationships ---------------------------------------------------------------------------------


async def _link(api: Api, source: str, target: str, kind: str) -> httpx.Response:
    return await api.call("POST", "/relationships", json={"sourceId": source, "targetId": target, "type": kind})


async def test_relationship_validation(api: Api, published_events: list[DomainEvent]) -> None:
    cap = (await api.create("capability"))["id"]
    feat = (await api.create("feature"))["id"]
    story = (await api.create("user-story"))["id"]
    other_feat = (await api.create("feature"))["id"]

    assert (await _link(api, cap, cap, "supports")).status_code == 422
    assert (await _link(api, cap, str(uuid.uuid4()), "supports")).status_code == 404
    published_events.clear()
    created = await _link(api, cap, feat, "parent-child")
    assert created.status_code == 201, created.text
    assert [e.type for e in published_events] == ["relationship.created"]
    assert (await _link(api, cap, feat, "parent-child")).json()["type"] == "/problems/duplicate-relationship"
    assert (await _link(api, cap, other_feat, "parent-child")).status_code == 201
    assert (await _link(api, other_feat, feat, "parent-child")).status_code == 422  # feature cannot parent feature
    assert (await _link(api, feat, story, "parent-child")).status_code == 201
    assert (await _link(api, other_feat, story, "parent-child")).json()["type"] == "/problems/multiple-parents"
    assert (await _link(api, story, cap, "parent-child")).status_code == 422
    assert (await _link(api, story, feat, "supports")).status_code == 201

    assert (await _link(api, feat, other_feat, "related-to")).status_code == 201
    assert (await _link(api, other_feat, feat, "related-to")).status_code == 409  # symmetric duplicate
    assert (await _link(api, feat, other_feat, "depends-on")).status_code == 201
    assert (await _link(api, other_feat, feat, "depends-on")).status_code == 201  # directional

    listing = (await api.call("GET", "/relationships")).json()["items"]
    assert {(r["type"]) for r in listing} == {"parent-child", "supports", "related-to", "depends-on"}
    rel_id = next(r["id"] for r in listing if r["type"] == "supports")
    published_events.clear()
    assert (await api.call("DELETE", f"/relationships/{rel_id}")).status_code == 204
    assert (await api.call("DELETE", f"/relationships/{rel_id}")).status_code == 404
    assert [e.type for e in published_events] == ["relationship.deleted"]


async def test_parent_cycles_are_rejected(api: Api, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
    # Types forbid cycles through the REST rules, so exercise the rule on the pure function.
    from backlog_api.item_rules import creates_parent_cycle

    assert creates_parent_cycle([("a", "b"), ("b", "c")], "c", "a")
    assert not creates_parent_cycle([("a", "b")], "a", "c")


async def test_relationships_cannot_cross_projects(api: Api, client: httpx.AsyncClient, tokens: TokenFactory) -> None:
    other = await create_project(client, tokens, OWNER, "Other")
    foreign = (
        await client.post(
            f"{API}/projects/{other['id']}/items", json={"type": "feature"}, headers=tokens.headers(OWNER)
        )
    ).json()
    mine = await api.create("capability")
    response = await _link(api, mine["id"], foreign["id"], "supports")
    assert response.status_code == 404
    assert (await api.call("GET", f"/items/{foreign['id']}")).status_code == 404


# --- quality ---------------------------------------------------------------------------------------

QUALITY = {
    "overall": "ready-with-open-questions",
    "areas": [{"area": "problem", "level": "clear", "note": "ok"}],
    "mixedOutcomes": False,
}


async def test_quality_is_stored_and_goes_stale_when_the_document_changes(api: Api) -> None:
    item = await api.create(document="## Summary\nA")
    body = {"quality": QUALITY, "documentHash": item["documentHash"]}
    response = await api.call("PUT", f"/items/{item['id']}/quality", json=body)
    assert response.status_code == 200, response.text
    out = response.json()
    assert out["version"] == 1
    assert out["quality"]["stale"] is False
    assert out["quality"]["documentHash"] == item["documentHash"]
    assert out["quality"]["assessment"]["overall"] == "ready-with-open-questions"
    assert out["quality"]["assessedAt"]

    updated = (await api.patch(out, document="## Summary\nB")).json()
    assert updated["quality"]["stale"] is True
    summary = (await api.call("GET", "/items")).json()["items"][0]["quality"]
    assert summary["overall"] == "ready-with-open-questions"
    assert summary["stale"] is True

    rejected = await api.call("PUT", f"/items/{item['id']}/quality", json=body)
    assert rejected.status_code == 409
    assert rejected.json()["type"] == "/problems/stale-assessment"
    fresh = await api.call(
        "PUT", f"/items/{item['id']}/quality", json={"quality": QUALITY, "documentHash": updated["documentHash"]}
    )
    assert fresh.json()["quality"]["stale"] is False
    bad = await api.call(
        "PUT",
        f"/items/{item['id']}/quality",
        json={"quality": {"overall": "great", "areas": []}, "documentHash": updated["documentHash"]},
    )
    assert bad.status_code == 422


# --- permissions -----------------------------------------------------------------------------------


async def test_non_members_get_404_and_contributors_can_write(api: Api) -> None:
    item = await api.create()
    for method, suffix, kwargs in [
        ("GET", "/items", {}),
        ("POST", "/items", {"json": {"type": "capability"}}),
        ("GET", f"/items/{item['id']}", {}),
        ("PATCH", f"/items/{item['id']}", {"json": {"title": "x"}, "version": 1}),
        ("DELETE", f"/items/{item['id']}", {}),
        ("GET", f"/items/{item['id']}/revisions", {}),
        ("PUT", f"/items/{item['id']}/quality", {"json": {"quality": QUALITY, "documentHash": "0" * 64}}),
        ("GET", "/relationships", {}),
    ]:
        response = await api.call(method, suffix, user=OUTSIDER, **kwargs)
        assert response.status_code == 404, (method, suffix, response.text)

    created = await api.call("POST", "/items", user=CONTRIBUTOR, json={"type": "capability", "title": "Bob's"})
    assert created.status_code == 201
    patched = await api.call("PATCH", f"/items/{item['id']}", user=CONTRIBUTOR, version=1, json={"title": "Bob edit"})
    assert patched.json()["updatedBy"] == CONTRIBUTOR
    assert (await api.call("DELETE", f"/items/{item['id']}", user=CONTRIBUTOR)).status_code == 204


async def test_audit_records_are_written(api: Api, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
    item = await api.create()
    await api.patch(item, title="x")
    async with sessionmaker() as session:
        actions = set((await session.scalars(select(AuditEvent.action))).all())
    assert {"item.created", "item.updated"} <= actions


# --- service level: apply_section_updates and create_children --------------------------------------


async def _service_item(
    sessionmaker: async_sessionmaker[AsyncSession], project_id: str, item_type: str = "feature", document: str = ""
) -> uuid.UUID:
    async with sessionmaker() as session:
        result = await items_service.create_item(
            session, uuid.UUID(project_id), item_type, title="T", document=document, actor=OWNER
        )
        await session.commit()
        return result.item.id


async def test_apply_section_updates_merges_non_conflicting_sections(
    api: Api, sessionmaker: async_sessionmaker[AsyncSession], project: dict[str, Any]
) -> None:
    pid = uuid.UUID(project["id"])
    item_id = await _service_item(sessionmaker, project["id"], document="## Summary\nOne\n\n## Scope\nS")
    # someone else edits Summary (v2)
    async with sessionmaker() as session:
        await items_service.update_item(
            session, pid, item_id, expected_version=1, document="## Summary\nTheirs\n\n## Scope\nS", actor=CONTRIBUTOR
        )
        await session.commit()
    async with sessionmaker() as session:
        outcome = await items_service.apply_section_updates(
            session,
            pid,
            item_id,
            base_version=1,
            sections=[
                SectionChange("Summary", "Mine", id="s1"),
                SectionChange("Scope", "- more", mode="append", id="s2"),
            ],
            actor=OWNER,
            origin="agent",
            run_id="run-1",
            title="New title",
            status="refining",
        )
        await session.commit()
    assert outcome.applied == ["s2"]
    assert [(c.section_id, c.heading, c.current_markdown) for c in outcome.conflicted] == [("s1", "Summary", "Theirs")]
    assert outcome.new_version == 3
    assert outcome.title_applied is True
    assert outcome.status_applied is True
    assert outcome.item.document.startswith("## Summary\nTheirs")
    assert "S\n- more" in outcome.item.document
    assert [e.type for e in outcome.events] == ["item.updated"]
    assert outcome.events[0].data["origin"] == "agent"
    async with sessionmaker() as session:
        newest = await session.scalar(
            select(ItemRevision).where(ItemRevision.item_id == item_id).order_by(ItemRevision.version.desc()).limit(1)
        )
    assert newest is not None
    assert (newest.origin, newest.run_id, newest.actor) == ("agent", "run-1", OWNER)


async def test_apply_section_updates_without_changes_keeps_the_version(
    sessionmaker: async_sessionmaker[AsyncSession], project: dict[str, Any]
) -> None:
    pid = uuid.UUID(project["id"])
    item_id = await _service_item(sessionmaker, project["id"], document="## Summary\nOne")
    async with sessionmaker() as session:
        outcome = await items_service.apply_section_updates(
            session, pid, item_id, base_version=1, sections=[SectionChange("Summary", "One")], actor=OWNER
        )
        assert (outcome.applied, outcome.new_version) == (["Summary"], 1)
        with pytest.raises(ProblemError) as error:
            await items_service.apply_section_updates(session, pid, item_id, base_version=9, sections=[], actor=OWNER)
        assert error.value.slug == "invalid-base-version"


async def test_apply_section_updates_keeps_confirmed_items_and_reports_title_conflicts(
    sessionmaker: async_sessionmaker[AsyncSession], project: dict[str, Any]
) -> None:
    pid = uuid.UUID(project["id"])
    item_id = await _service_item(sessionmaker, project["id"], document="## Assumptions\n- [x] Kept\n- [ ] Maybe")
    async with sessionmaker() as session:
        await items_service.update_item(session, pid, item_id, expected_version=1, title="Theirs", actor=CONTRIBUTOR)
        await session.commit()
    async with sessionmaker() as session:
        outcome = await items_service.apply_section_updates(
            session,
            pid,
            item_id,
            base_version=1,
            sections=[SectionChange("Assumptions", "- [ ] Other")],
            actor=OWNER,
            title="Mine",
        )
        await session.commit()
    assert outcome.title_applied is False
    assert outcome.item.title == "Theirs"
    assert "- [x] Kept" in outcome.item.document
    assert len(outcome.warnings) == 1


async def test_create_children_conforms_documents_links_and_reports_failures(
    sessionmaker: async_sessionmaker[AsyncSession], project: dict[str, Any]
) -> None:
    pid = uuid.UUID(project["id"])
    parent_id = await _service_item(sessionmaker, project["id"], item_type="capability")
    async with sessionmaker() as session:
        outcome = await items_service.create_children(
            session,
            pid,
            parent_id,
            "feature",
            [
                ChildSpec("c1", "Search", sections=[("Summary", "Find things"), ("Mystery", "?")]),
                ChildSpec("c2", "Export", document="## Summary\nCSV"),
                ChildSpec("c3", "search"),  # duplicate title of c1 only after c1 exists: reported as failed
                ChildSpec("c1", "Again"),  # duplicate proposal id
            ],
            [
                RelationshipSpec(str(parent_id), "c1", "parent-child"),
                RelationshipSpec("c1", "c2", "depends-on"),
                RelationshipSpec("c1", "missing", "supports"),
                RelationshipSpec("c2", "c2", "supports"),
            ],
            actor=OWNER,
            origin="agent",
            run_id="r",
        )
        await session.commit()
        children = {pid_: item for pid_, item in outcome.created}
        assert list(children) == ["c1", "c2"]
        assert "## Summary\nFind things" in children["c1"].document
        assert "## Additional notes\n### Mystery\n?" in children["c1"].document
        assert [f[0] for f in outcome.failed] == ["c3", "c1"]
        assert outcome.relationships_created == 3  # two parent links + depends-on
        assert [(s[0], s[1]) for s in outcome.relationships_skipped] == [("c1", "missing"), ("c2", "c2")]
        assert sorted({e.type for e in outcome.events}) == ["item.created", "relationship.created"]
        count = await session.scalar(select(func.count()).select_from(Relationship))
        assert count == 3
        stored = (await session.scalars(select(Item).where(Item.type == "feature"))).all()
        assert len(stored) == 2


async def test_create_children_rejects_invalid_child_types(
    sessionmaker: async_sessionmaker[AsyncSession], project: dict[str, Any]
) -> None:
    pid = uuid.UUID(project["id"])
    parent_id = await _service_item(sessionmaker, project["id"], item_type="capability")
    async with sessionmaker() as session:
        with pytest.raises(ProblemError) as error:
            await items_service.create_children(
                session, pid, parent_id, "user-story", [ChildSpec("c", "x")], actor=OWNER
            )
    assert error.value.status == 422
