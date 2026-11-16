from __future__ import annotations

import uuid
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backlog_api.db.models import AuditEvent, ProjectGuidance
from backlog_api.events import DomainEvent
from backlog_api.guidance import effective_guidance, effective_template, is_outdated
from backlog_api_testkit import API, TokenFactory, add_member, create_project

OWNER = "alice@example.test"
CONTRIBUTOR = "bob@example.test"
OUTSIDER = "carol@example.test"
TEMPLATE = "## Summary\n\nCustom template.\n"


@pytest.fixture
async def project(client: httpx.AsyncClient, tokens: TokenFactory) -> dict[str, Any]:
    created = await create_project(client, tokens, OWNER, "Guided")
    response = await add_member(client, tokens, created["id"], OWNER, CONTRIBUTOR)
    assert response.status_code == 201, response.text
    return created


def _url(project: dict[str, Any], suffix: str = "") -> str:
    return f"{API}/projects/{project['id']}/guidance{suffix}"


async def _put(
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    project: dict[str, Any],
    suffix: str,
    body: dict[str, Any],
    *,
    user: str = OWNER,
    if_match: str | None = "0",
) -> httpx.Response:
    headers = tokens.headers(user)
    if if_match is not None:
        headers["If-Match"] = if_match
    return await client.put(_url(project, suffix), json=body, headers=headers)


async def test_defaults_when_no_override(client: httpx.AsyncClient, tokens: TokenFactory, project: dict[str, Any]):
    response = await client.get(_url(project), headers=tokens.headers(CONTRIBUTOR))
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["principles"]["source"] == "default"
    assert body["principles"]["version"] == 0
    assert not body["principles"]["differsFromDefault"]
    assert not body["principles"]["outdated"]
    assert body["principles"]["content"]
    assert set(body["templates"]) == {"capability", "feature", "user-story", "enabler"}
    assert body["templates"]["feature"]["defaultSkill"] == "backlog-feature"
    assert body["skills"]["backlog-refinement"] == body["principles"]["defaultVersion"]
    assert "{{" not in body["templates"]["feature"]["content"]


async def test_defaults_endpoint(client: httpx.AsyncClient, tokens: TokenFactory, project: dict[str, Any]):
    response = await client.get(_url(project, "/defaults"), headers=tokens.headers(CONTRIBUTOR))
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["typeInstructions"]["enabler"]["skill"] == "backlog-enabler"
    assert body["templates"]["capability"]["content"]
    assert body["principles"]["version"] == body["skills"]["backlog-refinement"]


async def test_override_wins_and_delete_restores(
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    project: dict[str, Any],
    published_events: list[DomainEvent],
    sessionmaker: async_sessionmaker[AsyncSession],
):
    defaults = (await client.get(_url(project, "/defaults"), headers=tokens.headers(OWNER))).json()
    response = await _put(client, tokens, project, "/template/feature", {"content": TEMPLATE})
    assert response.status_code == 200, response.text
    entry = response.json()
    assert entry["source"] == "project"
    assert entry["differsFromDefault"] is True
    assert entry["outdated"] is False
    assert entry["baseSkillVersion"] == defaults["templates"]["feature"]["version"]
    assert entry["version"] == 1
    assert response.headers["ETag"] == '"1"'
    assert [e.type for e in published_events] == ["guidance.updated"]
    assert published_events[0].data == {"kind": "template", "itemType": "feature"}

    effective = (await client.get(_url(project), headers=tokens.headers(CONTRIBUTOR))).json()
    assert effective["templates"]["feature"]["content"] == TEMPLATE.strip()
    assert effective["templates"]["feature"]["updatedBy"] == OWNER
    assert effective["templates"]["user-story"]["source"] == "default"

    async with sessionmaker() as session:
        project_id = project["id"]
        assert (await effective_template(session, uuid.UUID(project_id), "feature")) == TEMPLATE.strip()
        assert (await effective_template(session, uuid.UUID(project_id), "enabler")) == defaults["templates"][
            "enabler"
        ]["content"]
        assert (await effective_guidance(session, uuid.UUID(project_id))).templates["feature"].source == "project"

    deleted = await client.delete(_url(project, "/template/feature"), headers=tokens.headers(OWNER))
    assert deleted.status_code == 200, deleted.text
    assert deleted.json()["source"] == "default"
    assert deleted.json()["content"] == defaults["templates"]["feature"]["content"]
    assert published_events[-1].type == "guidance.updated"
    again = await client.delete(_url(project, "/template/feature"), headers=tokens.headers(OWNER))
    assert again.status_code == 200

    async with sessionmaker() as session:
        actions = (await session.scalars(select(AuditEvent.action).order_by(AuditEvent.id))).all()
    assert [a for a in actions if a.startswith("guidance.")] == ["guidance.updated", "guidance.reset"]


async def test_principles_and_instructions_roundtrip(
    client: httpx.AsyncClient, tokens: TokenFactory, project: dict[str, Any]
):
    first = await _put(client, tokens, project, "/principles", {"content": "Be brief."})
    assert first.status_code == 200, first.text
    second = await _put(client, tokens, project, "/type-instructions/user-story", {"content": "Write small stories."})
    assert second.status_code == 200, second.text
    effective = (await client.get(_url(project), headers=tokens.headers(OWNER))).json()
    assert effective["principles"]["content"] == "Be brief."
    assert effective["typeInstructions"]["user-story"]["content"] == "Write small stories."
    deleted = await client.delete(_url(project, "/principles"), headers=tokens.headers(OWNER))
    assert deleted.json()["source"] == "default"


async def test_concurrency(client: httpx.AsyncClient, tokens: TokenFactory, project: dict[str, Any]):
    missing = await _put(client, tokens, project, "/principles", {"content": "A"}, if_match=None)
    assert missing.status_code == 428
    assert (await _put(client, tokens, project, "/principles", {"content": "A"})).status_code == 200
    stale = await _put(client, tokens, project, "/principles", {"content": "B"}, if_match="0")
    assert stale.status_code == 409
    assert stale.json()["currentVersion"] == 1
    ok = await _put(client, tokens, project, "/principles", {"content": "B"}, if_match='"1"')
    assert ok.status_code == 200
    assert ok.json()["version"] == 2
    stale_delete = await client.delete(_url(project, "/principles"), headers={**tokens.headers(OWNER), "If-Match": "1"})
    assert stale_delete.status_code == 409


async def test_contributor_cannot_write(client: httpx.AsyncClient, tokens: TokenFactory, project: dict[str, Any]):
    put = await _put(client, tokens, project, "/principles", {"content": "x"}, user=CONTRIBUTOR)
    assert put.status_code == 403
    delete = await client.delete(_url(project, "/template/feature"), headers=tokens.headers(CONTRIBUTOR))
    assert delete.status_code == 403
    imported = await client.post(
        _url(project, "/import"), json={"format": "backlog-guidance"}, headers=tokens.headers(CONTRIBUTOR)
    )
    assert imported.status_code == 403
    export = await client.get(_url(project, "/export"), headers=tokens.headers(CONTRIBUTOR))
    assert export.status_code == 200


async def test_non_member_gets_404(client: httpx.AsyncClient, tokens: TokenFactory, project: dict[str, Any]):
    headers = tokens.headers(OUTSIDER)
    assert (await client.get(_url(project), headers=headers)).status_code == 404
    assert (await client.get(_url(project, "/defaults"), headers=headers)).status_code == 404
    assert (await client.get(_url(project, "/export"), headers=headers)).status_code == 404
    assert (await _put(client, tokens, project, "/principles", {"content": "x"}, user=OUTSIDER)).status_code == 404
    assert (await client.delete(_url(project, "/principles"), headers=headers)).status_code == 404
    assert (await client.post(_url(project, "/import"), json={}, headers=headers)).status_code == 404


async def test_template_validation(client: httpx.AsyncClient, tokens: TokenFactory, project: dict[str, Any]):
    response = await _put(client, tokens, project, "/template/feature", {"content": "## A\n\n{{ title }}\n"})
    assert response.status_code == 422
    problem = response.json()
    assert problem["type"] == "/problems/invalid-guidance"
    assert "placeholder" in problem["issues"][0]
    empty = await _put(client, tokens, project, "/principles", {"content": "   "})
    assert empty.status_code == 422
    too_long = await _put(client, tokens, project, "/principles", {"content": "x" * 50_001})
    assert too_long.status_code == 422
    unknown_type = await _put(client, tokens, project, "/template/epic", {"content": "x"})
    assert unknown_type.status_code == 422
    unknown_kind = await _put(client, tokens, project, "/extra/feature", {"content": "x"})
    assert unknown_kind.status_code == 422
    # {{ in instructions is only forbidden in templates
    allowed = await _put(client, tokens, project, "/type-instructions/feature", {"content": "Mention {{x}}."})
    assert allowed.status_code == 200


async def test_outdated_when_base_version_is_older(
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    project: dict[str, Any],
    app: FastAPI,
    sessionmaker: async_sessionmaker[AsyncSession],
):
    response = await _put(
        client, tokens, project, "/principles", {"content": "Old rules.", "baseSkillVersion": "0.0.1"}
    )
    assert response.status_code == 200, response.text
    entry = response.json()
    assert entry["baseSkillVersion"] == "0.0.1"
    assert entry["outdated"] is True
    assert entry["differsFromDefault"] is True
    # Re-saving without a base keeps the existing one.
    again = await _put(client, tokens, project, "/principles", {"content": "Older rules."}, if_match="1")
    assert again.json()["baseSkillVersion"] == "0.0.1"
    async with sessionmaker() as session:
        await session.execute(update(ProjectGuidance).values(base_skill_version=entry["defaultVersion"]))
        await session.commit()
    current = (await client.get(_url(project), headers=tokens.headers(OWNER))).json()["principles"]
    assert current["outdated"] is False


def test_is_outdated():
    assert is_outdated("1.0.0", "1.1.0")
    assert not is_outdated("1.1.0", "1.1.0")
    assert not is_outdated("2.0.0", "1.1.0")
    assert not is_outdated(None, "1.1.0")
    assert is_outdated("1.0.0", "1.0.0-rc1") is False


async def test_export_import_round_trip(client: httpx.AsyncClient, tokens: TokenFactory, project: dict[str, Any]):
    empty = (await client.get(_url(project, "/export"), headers=tokens.headers(OWNER))).json()
    assert empty["format"] == "backlog-guidance"
    assert empty["formatVersion"] == 5
    assert empty["project"] == {"id": project["id"], "name": "Guided"}
    assert empty["guidance"]["typeInstructions"] == {}
    assert empty["guidance"]["templates"] == {}
    assert empty["guidance"]["principles"] is None
    assert "backlog-refinement" in empty["skills"]

    assert (await _put(client, tokens, project, "/principles", {"content": "Rules"})).status_code == 200
    assert (await _put(client, tokens, project, "/template/feature", {"content": TEMPLATE})).status_code == 200
    exported = (await client.get(_url(project, "/export"), headers=tokens.headers(CONTRIBUTOR))).json()
    assert list(exported["guidance"]["templates"]) == ["feature"]
    assert exported["guidance"]["principles"]["content"] == "Rules"
    assert exported["guidance"]["principles"]["baseSkillVersion"] == exported["skills"]["backlog-refinement"]

    full = (await client.get(_url(project, "/export?includeDefaults=true"), headers=tokens.headers(OWNER))).json()
    assert set(full["guidance"]["templates"]) == {"capability", "feature", "user-story", "enabler"}

    other = await create_project(client, tokens, OWNER, "Other")
    imported = await client.post(_url(other, "/import"), json=exported, headers=tokens.headers(OWNER))
    assert imported.status_code == 200, imported.text
    effective = imported.json()
    assert effective["principles"]["content"] == "Rules"
    assert effective["templates"]["feature"]["content"] == TEMPLATE.strip()
    assert effective["templates"]["enabler"]["source"] == "default"

    # Import replaces overrides; importing the defaults-inclusive export stores nothing for unchanged defaults.
    replaced = await client.post(_url(other, "/import"), json=full, headers=tokens.headers(OWNER))
    assert replaced.status_code == 200, replaced.text
    sources = {t: e["source"] for t, e in replaced.json()["templates"].items()}
    assert sources == {"capability": "default", "feature": "project", "user-story": "default", "enabler": "default"}

    cleared = await client.post(
        _url(other, "/import"),
        json={**empty, "project": {"id": "x", "name": "y"}},
        headers=tokens.headers(OWNER),
    )
    assert cleared.status_code == 200
    assert cleared.json()["principles"]["source"] == "default"


async def test_import_accepts_v4_spa_export(client: httpx.AsyncClient, tokens: TokenFactory, project: dict[str, Any]):
    defaults = (await client.get(_url(project, "/defaults"), headers=tokens.headers(OWNER))).json()
    document = {
        "version": 4,
        "settings": {
            "instructions": "ignored",
            "principles": "Legacy principles",
            "typeInstructions": {t: e["content"] for t, e in defaults["typeInstructions"].items()},
            "templates": {t: e["content"] for t, e in defaults["templates"].items()} | {"feature": TEMPLATE},
        },
    }
    response = await client.post(_url(project, "/import"), json=document, headers=tokens.headers(OWNER))
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["principles"]["content"] == "Legacy principles"
    assert body["templates"]["feature"]["source"] == "project"
    assert body["templates"]["capability"]["source"] == "default"
    assert body["typeInstructions"]["feature"]["source"] == "default"


@pytest.mark.parametrize(
    ("document", "slug"),
    [
        ({}, "unsupported-format"),
        ({"format": "backlog-guidance", "formatVersion": 4, "guidance": {}}, "unsupported-format"),
        ({"format": "backlog-guidance", "formatVersion": 6, "guidance": {}}, "unsupported-format"),
        ({"format": "other", "formatVersion": 5, "guidance": {}}, "unsupported-format"),
        ({"format": "backlog-guidance", "formatVersion": 5, "guidance": []}, "invalid-guidance"),
        (
            {"format": "backlog-guidance", "formatVersion": 5, "guidance": {"templates": {"epic": {"content": "x"}}}},
            "invalid-guidance",
        ),
        (
            {
                "format": "backlog-guidance",
                "formatVersion": 5,
                "guidance": {"templates": {"feature": {"content": "{{ a }}"}}, "principles": {"content": ""}},
            },
            "invalid-guidance",
        ),
        (
            {"format": "backlog-guidance", "formatVersion": 5, "guidance": {"extra": {}, "principles": "plain"}},
            "invalid-guidance",
        ),
    ],
)
async def test_invalid_import(
    client: httpx.AsyncClient, tokens: TokenFactory, project: dict[str, Any], document: dict[str, Any], slug: str
):
    await _put(client, tokens, project, "/principles", {"content": "Keep me"})
    response = await client.post(_url(project, "/import"), json=document, headers=tokens.headers(OWNER))
    assert response.status_code == 422, response.text
    assert response.json()["type"] == f"/problems/{slug}"
    kept = (await client.get(_url(project), headers=tokens.headers(OWNER))).json()
    assert kept["principles"]["content"] == "Keep me"
