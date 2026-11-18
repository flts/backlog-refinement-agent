from __future__ import annotations

import asyncio
import uuid
from typing import Any

import httpx
import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backlog_api.db.models import AuditEvent, Project, ProjectMember
from backlog_api.events import DomainEvent
from backlog_api_testkit import API, TokenFactory, add_member, create_project

OWNER = "alice@example.test"
CONTRIBUTOR = "bob@example.test"
OUTSIDER = "carol@example.test"


@pytest.fixture
async def shared_project(client: httpx.AsyncClient, tokens: TokenFactory) -> dict[str, Any]:
    project = await create_project(client, tokens, OWNER, "Shared")
    response = await add_member(client, tokens, project["id"], OWNER, CONTRIBUTOR)
    assert response.status_code == 201, response.text
    return project


def _project_url(project_id: str, suffix: str = "") -> str:
    return f"{API}/projects/{project_id}{suffix}"


# --- RBAC matrix -------------------------------------------------------------------------------------------------

# (label, method, path suffix, json body, needs If-Match, expected status per role)
MATRIX: list[tuple[str, str, str, dict[str, Any] | None, bool, dict[str, int]]] = [
    ("get project", "GET", "", None, False, {"owner": 200, "contributor": 200, "outsider": 404}),
    ("rename project", "PATCH", "", {"name": "Renamed"}, True, {"owner": 200, "contributor": 403, "outsider": 404}),
    ("list members", "GET", "/members", None, False, {"owner": 200, "contributor": 200, "outsider": 404}),
    (
        "add member",
        "POST",
        "/members",
        {"email": "dan@example.test"},
        False,
        {"owner": 201, "contributor": 403, "outsider": 404},
    ),
    (
        "change role",
        "PATCH",
        f"/members/{CONTRIBUTOR}",
        {"role": "owner"},
        False,
        {"owner": 200, "contributor": 403, "outsider": 404},
    ),
    (
        "remove other member",
        "DELETE",
        f"/members/{OWNER}",
        None,
        False,
        # The owner removing themselves is "leave" and hits the last-owner rule.
        {"owner": 409, "contributor": 403, "outsider": 404},
    ),
    ("delete project", "DELETE", "", None, False, {"owner": 204, "contributor": 403, "outsider": 404}),
]

ROLE_EMAILS = {"owner": OWNER, "contributor": CONTRIBUTOR, "outsider": OUTSIDER}


@pytest.mark.parametrize("role", ["owner", "contributor", "outsider"])
@pytest.mark.parametrize(
    ("label", "method", "suffix", "body", "if_match", "expected"), MATRIX, ids=[row[0] for row in MATRIX]
)
async def test_rbac_matrix(
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    shared_project: dict[str, Any],
    role: str,
    label: str,
    method: str,
    suffix: str,
    body: dict[str, Any] | None,
    if_match: bool,
    expected: dict[str, int],
) -> None:
    headers = tokens.headers(ROLE_EMAILS[role])
    if if_match:
        headers["If-Match"] = str(shared_project["version"])
    response = await client.request(method, _project_url(shared_project["id"], suffix), json=body, headers=headers)
    assert response.status_code == expected[role], f"{label} as {role}: {response.text}"
    if response.status_code >= 400:
        assert response.headers["content-type"].startswith("application/problem+json")


async def test_unknown_project_is_404(client: httpx.AsyncClient, tokens: TokenFactory) -> None:
    response = await client.get(_project_url(str(uuid.uuid4())), headers=tokens.headers(OWNER))
    assert response.status_code == 404


async def test_requests_without_token_are_401(client: httpx.AsyncClient, shared_project: dict[str, Any]) -> None:
    for method, path in [
        ("GET", f"{API}/projects"),
        ("POST", f"{API}/projects"),
        ("GET", _project_url(shared_project["id"], "/members")),
    ]:
        response = await client.request(method, path, json={"name": "x"} if method == "POST" else None)
        assert response.status_code == 401


# --- Projects ----------------------------------------------------------------------------------------------------


async def test_create_and_list_projects_with_role(
    client: httpx.AsyncClient, tokens: TokenFactory, published_events: list[DomainEvent]
) -> None:
    response = await client.post(f"{API}/projects", json={"name": "  Payments  "}, headers=tokens.headers(OWNER))
    assert response.status_code == 201
    project = response.json()
    assert project["name"] == "Payments"
    assert project["role"] == "owner"
    assert project["version"] == 1
    assert project["createdBy"] == OWNER
    assert response.headers["location"] == f"{API}/projects/{project['id']}"
    assert response.headers["etag"] == '"1"'

    await add_member(client, tokens, project["id"], OWNER, CONTRIBUTOR)
    listing = await client.get(f"{API}/projects", headers=tokens.headers(CONTRIBUTOR))
    assert [(item["name"], item["role"]) for item in listing.json()["items"]] == [("Payments", "contributor")]
    assert (await client.get(f"{API}/projects", headers=tokens.headers(OUTSIDER))).json() == {"items": []}
    assert [event.type for event in published_events] == ["project.created", "member.added"]


async def test_create_project_rejects_unknown_fields(client: httpx.AsyncClient, tokens: TokenFactory) -> None:
    response = await client.post(f"{API}/projects", json={"name": "x", "owner": "x"}, headers=tokens.headers(OWNER))
    assert response.status_code == 422


async def test_rename_requires_if_match(
    client: httpx.AsyncClient, tokens: TokenFactory, shared_project: dict[str, Any]
) -> None:
    url = _project_url(shared_project["id"])
    missing = await client.patch(url, json={"name": "New"}, headers=tokens.headers(OWNER))
    assert missing.status_code == 428
    assert missing.json()["type"] == "/problems/precondition-required"

    invalid = await client.patch(url, json={"name": "New"}, headers={**tokens.headers(OWNER), "If-Match": "abc"})
    assert invalid.status_code == 400


async def test_rename_with_optimistic_concurrency(
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    shared_project: dict[str, Any],
    published_events: list[DomainEvent],
) -> None:
    url = _project_url(shared_project["id"])
    first = await client.patch(url, json={"name": "First"}, headers={**tokens.headers(OWNER), "If-Match": '"1"'})
    assert first.status_code == 200
    assert first.json()["version"] == 2
    assert first.headers["etag"] == '"2"'

    stale = await client.patch(url, json={"name": "Second"}, headers={**tokens.headers(OWNER), "If-Match": "1"})
    assert stale.status_code == 409
    assert stale.json()["type"] == "/problems/version-conflict"
    assert stale.json()["currentVersion"] == 2

    weak = await client.patch(url, json={"name": "Second"}, headers={**tokens.headers(OWNER), "If-Match": 'W/"2"'})
    assert weak.status_code == 200
    assert weak.json()["name"] == "Second"

    unchanged = await client.patch(url, json={"name": "Second"}, headers={**tokens.headers(OWNER), "If-Match": "3"})
    assert unchanged.status_code == 200
    assert unchanged.json()["version"] == 3
    assert [event.type for event in published_events].count("project.updated") == 2


async def test_delete_project_cascades(
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    shared_project: dict[str, Any],
    sessionmaker: async_sessionmaker[AsyncSession],
    published_events: list[DomainEvent],
) -> None:
    project_id = uuid.UUID(shared_project["id"])
    stale = await client.delete(_project_url(shared_project["id"]), headers={**tokens.headers(OWNER), "If-Match": "9"})
    assert stale.status_code == 409

    response = await client.delete(_project_url(shared_project["id"]), headers=tokens.headers(OWNER))
    assert response.status_code == 204
    assert (await client.get(_project_url(shared_project["id"]), headers=tokens.headers(OWNER))).status_code == 404
    assert (await client.get(f"{API}/projects", headers=tokens.headers(CONTRIBUTOR))).json() == {"items": []}

    async with sessionmaker() as session:
        assert await session.get(Project, project_id) is None
        members = await session.scalar(
            select(func.count()).select_from(ProjectMember).where(ProjectMember.project_id == project_id)
        )
        assert members == 0
        # Audit events survive the project (project_id set to NULL) and keep the id in their details.
        deleted = await session.scalar(select(AuditEvent).where(AuditEvent.action == "project.deleted"))
        assert deleted is not None
        assert deleted.project_id is None
        assert deleted.details["projectId"] == shared_project["id"]
    assert published_events[-1].type == "project.deleted"


# --- Members -----------------------------------------------------------------------------------------------------


async def test_member_added_before_first_sign_in_has_immediate_access(
    client: httpx.AsyncClient, tokens: TokenFactory
) -> None:
    project = await create_project(client, tokens, OWNER, "Early access")
    added = await add_member(client, tokens, project["id"], OWNER, "  New.Person@Example.TEST ")
    assert added.status_code == 201
    assert added.json() == {
        "email": "new.person@example.test",
        "role": "contributor",
        "name": None,
        "signedIn": False,
        "addedBy": OWNER,
        "addedAt": added.json()["addedAt"],
    }

    # The person signs in for the first time with a differently cased address.
    headers = tokens.headers("NEW.person@example.test", name="New Person")
    listing = await client.get(f"{API}/projects", headers=headers)
    assert [item["id"] for item in listing.json()["items"]] == [project["id"]]
    assert (await client.get(_project_url(project["id"]), headers=headers)).json()["role"] == "contributor"

    members = (await client.get(_project_url(project["id"], "/members"), headers=headers)).json()["items"]
    person = next(member for member in members if member["email"] == "new.person@example.test")
    assert person["signedIn"] is True
    assert person["name"] == "New Person"


async def test_members_list_shows_owners_first_with_display_names(
    client: httpx.AsyncClient, tokens: TokenFactory, shared_project: dict[str, Any]
) -> None:
    await client.get(f"{API}/me", headers=tokens.headers(CONTRIBUTOR, name="Bob Builder"))
    response = await client.get(_project_url(shared_project["id"], "/members"), headers=tokens.headers(OWNER))
    assert response.status_code == 200
    items = response.json()["items"]
    assert [(item["email"], item["role"], item["name"], item["signedIn"]) for item in items] == [
        (OWNER, "owner", "Alice", True),
        (CONTRIBUTOR, "contributor", "Bob Builder", True),
    ]


async def test_add_member_validation_and_duplicates(
    client: httpx.AsyncClient, tokens: TokenFactory, shared_project: dict[str, Any]
) -> None:
    project_id = shared_project["id"]
    duplicate = await add_member(client, tokens, project_id, OWNER, " BOB@example.test")
    assert duplicate.status_code == 409
    assert duplicate.json()["type"] == "/problems/already-member"

    for bad in ["not-an-email", "a b@example.test", "x@y", "", "@example.test"]:
        response = await add_member(client, tokens, project_id, OWNER, bad)
        assert response.status_code == 422, bad

    bad_role = await add_member(client, tokens, project_id, OWNER, "dan@example.test", role="admin")
    assert bad_role.status_code == 422

    as_owner = await add_member(client, tokens, project_id, OWNER, "dan@example.test", role="owner")
    assert as_owner.status_code == 201
    assert as_owner.json()["role"] == "owner"


async def test_role_change_and_path_email_normalization(
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    shared_project: dict[str, Any],
    published_events: list[DomainEvent],
) -> None:
    project_id = shared_project["id"]
    promoted = await client.patch(
        _project_url(project_id, "/members/BOB@Example.Test"), json={"role": "owner"}, headers=tokens.headers(OWNER)
    )
    assert promoted.status_code == 200
    assert promoted.json()["role"] == "owner"
    assert published_events[-1].type == "member.updated"

    # Bob is now an owner and can rename the project.
    renamed = await client.patch(
        _project_url(project_id), json={"name": "Bob's"}, headers={**tokens.headers(CONTRIBUTOR), "If-Match": "1"}
    )
    assert renamed.status_code == 200

    missing = await client.patch(
        _project_url(project_id, "/members/nobody@example.test"), json={"role": "owner"}, headers=tokens.headers(OWNER)
    )
    assert missing.status_code == 404
    assert missing.json()["type"] == "/problems/member-not-found"


async def test_last_owner_rule(client: httpx.AsyncClient, tokens: TokenFactory, shared_project: dict[str, Any]) -> None:
    project_id = shared_project["id"]
    demote = await client.patch(
        _project_url(project_id, f"/members/{OWNER}"), json={"role": "contributor"}, headers=tokens.headers(OWNER)
    )
    assert demote.status_code == 409
    assert demote.json()["type"] == "/problems/last-owner"

    leave = await client.delete(_project_url(project_id, f"/members/{OWNER}"), headers=tokens.headers(OWNER))
    assert leave.status_code == 409
    assert leave.json()["type"] == "/problems/last-owner"

    # With a second owner, the first can step down and then leave.
    await client.patch(
        _project_url(project_id, f"/members/{CONTRIBUTOR}"), json={"role": "owner"}, headers=tokens.headers(OWNER)
    )
    step_down = await client.patch(
        _project_url(project_id, f"/members/{OWNER}"), json={"role": "contributor"}, headers=tokens.headers(OWNER)
    )
    assert step_down.status_code == 200
    left = await client.delete(_project_url(project_id, f"/members/{OWNER}"), headers=tokens.headers(OWNER))
    assert left.status_code == 204
    assert (await client.get(_project_url(project_id), headers=tokens.headers(OWNER))).status_code == 404

    # Bob is now the only owner: he cannot leave or demote himself.
    bob_leave = await client.delete(
        _project_url(project_id, f"/members/{CONTRIBUTOR}"), headers=tokens.headers(CONTRIBUTOR)
    )
    assert bob_leave.status_code == 409


async def test_concurrent_demotions_keep_one_owner(
    client: httpx.AsyncClient, tokens: TokenFactory, shared_project: dict[str, Any]
) -> None:
    project_id = shared_project["id"]
    await client.patch(
        _project_url(project_id, f"/members/{CONTRIBUTOR}"), json={"role": "owner"}, headers=tokens.headers(OWNER)
    )
    responses = await asyncio.gather(
        client.patch(
            _project_url(project_id, f"/members/{CONTRIBUTOR}"),
            json={"role": "contributor"},
            headers=tokens.headers(OWNER),
        ),
        client.patch(
            _project_url(project_id, f"/members/{OWNER}"),
            json={"role": "contributor"},
            headers=tokens.headers(CONTRIBUTOR),
        ),
    )
    # The project row lock serializes the two changes: the second caller is no longer an owner.
    assert sorted(response.status_code for response in responses) == [200, 403]
    members = (await client.get(_project_url(project_id, "/members"), headers=tokens.headers(OWNER))).json()
    assert [member["role"] for member in members["items"]].count("owner") == 1


async def test_contributor_can_leave_but_not_remove_others(
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    shared_project: dict[str, Any],
    published_events: list[DomainEvent],
) -> None:
    project_id = shared_project["id"]
    await add_member(client, tokens, project_id, OWNER, "dan@example.test")
    remove_other = await client.delete(
        _project_url(project_id, "/members/dan@example.test"), headers=tokens.headers(CONTRIBUTOR)
    )
    assert remove_other.status_code == 403

    leave = await client.delete(
        _project_url(project_id, "/members/Bob@Example.test"), headers=tokens.headers(CONTRIBUTOR)
    )
    assert leave.status_code == 204
    assert published_events[-1].type == "member.removed"
    assert published_events[-1].data == {"email": CONTRIBUTOR, "left": True}
    assert (await client.get(_project_url(project_id), headers=tokens.headers(CONTRIBUTOR))).status_code == 404


async def test_owner_removes_member_and_access_ends(
    client: httpx.AsyncClient, tokens: TokenFactory, shared_project: dict[str, Any]
) -> None:
    project_id = shared_project["id"]
    removed = await client.delete(_project_url(project_id, f"/members/{CONTRIBUTOR}"), headers=tokens.headers(OWNER))
    assert removed.status_code == 204
    assert (await client.get(_project_url(project_id), headers=tokens.headers(CONTRIBUTOR))).status_code == 404
    again = await client.delete(_project_url(project_id, f"/members/{CONTRIBUTOR}"), headers=tokens.headers(OWNER))
    assert again.status_code == 404


async def test_email_change_loses_access(
    client: httpx.AsyncClient, tokens: TokenFactory, shared_project: dict[str, Any]
) -> None:
    # Same Keycloak subject, new email address: access follows the email, not the subject.
    old = tokens.headers(CONTRIBUTOR, sub="bob-sub")
    new = tokens.headers("robert@example.test", sub="bob-sub")
    assert (await client.get(_project_url(shared_project["id"]), headers=old)).status_code == 200
    assert (await client.get(_project_url(shared_project["id"]), headers=new)).status_code == 404


async def test_audit_events_are_recorded(
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    shared_project: dict[str, Any],
    sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    project_id = shared_project["id"]
    await client.patch(
        _project_url(project_id), json={"name": "Renamed"}, headers={**tokens.headers(OWNER), "If-Match": "1"}
    )
    await client.patch(
        _project_url(project_id, f"/members/{CONTRIBUTOR}"), json={"role": "owner"}, headers=tokens.headers(OWNER)
    )
    await client.delete(_project_url(project_id, f"/members/{CONTRIBUTOR}"), headers=tokens.headers(OWNER))
    async with sessionmaker() as session:
        rows = (
            await session.execute(
                select(AuditEvent.action, AuditEvent.actor, AuditEvent.details)
                .where(AuditEvent.project_id == uuid.UUID(project_id))
                .order_by(AuditEvent.id)
            )
        ).all()
    assert [(action, actor) for action, actor, _ in rows] == [
        ("project.created", OWNER),
        ("member.added", OWNER),
        ("project.renamed", OWNER),
        ("member.role_changed", OWNER),
        ("member.removed", OWNER),
    ]
    assert rows[1][2] == {"email": CONTRIBUTOR, "role": "contributor"}
    assert rows[2][2] == {"from": "Shared", "to": "Renamed"}
    assert rows[3][2] == {"email": CONTRIBUTOR, "from": "contributor", "to": "owner"}
