"""RBAC matrix over every route of the app (plan §5.2) and every MCP tool.

The routes are enumerated from the application, so a new route fails :func:`test_every_route_is_classified` until it is
added to :data:`SPECS`. Each route is called as {owner, contributor, non-member, unverified email, no token} and the
status class is compared with what the permission matrix demands. Stream routes run against a live uvicorn server
(``httpx.ASGITransport`` buffers responses).
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from fastapi.routing import iter_route_contexts

from backlog_api.settings import Settings
from backlog_api_testkit import API, TokenFactory, add_member, create_project
from conftest import truncate_all
from live_testkit import running_replica
from test_mcp import READ_TOOLS, WRITE_TOOLS, mcp_client

OWNER = "alice@example.test"
CONTRIBUTOR = "bob@example.test"
OUTSIDER = "carol@example.test"
OTHER_MEMBER = "dan@example.test"
ROLES = ("owner", "contributor", "non_member", "unverified", "no_token")
QUALITY = {"overall": "ready", "areas": [{"area": "problem", "level": "clear", "note": "ok"}], "mixedOutcomes": False}
TEMPLATE = "## Summary\n\nCustom template.\n"
P = API + "/projects/{project_id}"

# access -> role -> expected status ("2xx" is a class, the others are exact). ``None`` means "not applicable".
EXPECTED: dict[str, dict[str, str]] = {
    "member": {"owner": "2xx", "contributor": "2xx", "non_member": "404", "unverified": "403", "no_token": "401"},
    "owner": {"owner": "2xx", "contributor": "403", "non_member": "404", "unverified": "403", "no_token": "401"},
    "user": {"owner": "2xx", "contributor": "2xx", "non_member": "2xx", "unverified": "403", "no_token": "401"},
    "public": dict.fromkeys(ROLES, "2xx"),
    "service": {"owner": "403", "contributor": "403", "non_member": "403", "unverified": "403", "no_token": "401"},
}
PROBLEM_TYPE = {"401": "unauthorized", "404": "not-found"}


@dataclass
class World:
    """A project with two members besides the owner and one item, source, revision and relationship."""

    client: httpx.AsyncClient
    tokens: TokenFactory
    project_id: str = ""
    item_id: str = ""
    item2_id: str = ""
    source_id: str = ""
    revision_id: str = ""
    relationship_id: str = ""

    def headers(self, role: str) -> dict[str, str]:
        match role:
            case "owner":
                return self.tokens.headers(OWNER)
            case "contributor":
                return self.tokens.headers(CONTRIBUTOR)
            case "non_member":
                return self.tokens.headers(OUTSIDER)
            case "unverified":
                return self.tokens.headers(OWNER, email_verified=False)
        return {}

    async def owner(self, method: str, suffix: str, **kwargs: Any) -> Any:
        headers = {**self.tokens.headers(OWNER), **kwargs.pop("headers", {})}
        response = await self.client.request(
            method, f"{API}/projects/{self.project_id}{suffix}", headers=headers, **kwargs
        )
        assert response.status_code < 300, response.text
        return response.json() if response.content else None

    def fill(self, template: str, extra: dict[str, str]) -> str:
        values = {
            "project_id": self.project_id,
            "item_id": self.item_id,
            "source_id": self.source_id,
            "revision_id": self.revision_id,
            "relationship_id": self.relationship_id,
            "email": OTHER_MEMBER,
            **extra,
        }
        return template.format(**values)

    async def item(self) -> dict[str, Any]:
        return await self.owner("GET", f"/items/{self.item_id}")


async def build_world(client: httpx.AsyncClient, tokens: TokenFactory) -> World:
    world = World(client, tokens)
    world.project_id = (await create_project(client, tokens, OWNER, "Matrix"))["id"]
    for email in (CONTRIBUTOR, OTHER_MEMBER):
        assert (await add_member(client, tokens, world.project_id, OWNER, email)).status_code == 201
    first = await world.owner(
        "POST", "/items", json={"type": "feature", "title": "Matrix", "document": "## Summary\nOne"}
    )
    second = await world.owner("POST", "/items", json={"type": "feature", "title": "Second"})
    world.item_id, world.item2_id = first["id"], second["id"]
    await world.owner("PATCH", f"/items/{first['id']}", json={"title": "Matrix v2"}, headers={"If-Match": '"1"'})
    revisions = await world.owner("GET", f"/items/{first['id']}/revisions")
    world.revision_id = next(r["id"] for r in revisions["items"] if r["version"] == 1)
    source = await world.owner("POST", "/sources", files={"file": ("notes.md", b"# Notes\n\nhello", "text/markdown")})
    world.source_id = source["id"]
    relationship = await world.owner(
        "POST", "/relationships", json={"sourceId": first["id"], "targetId": second["id"], "type": "related-to"}
    )
    world.relationship_id = relationship["id"]
    return world


Build = Callable[[World], Awaitable[dict[str, Any]]]


async def _none(_: World) -> dict[str, Any]:
    return {}


def _json(body: dict[str, Any], **headers: str) -> Build:
    async def build(_: World) -> dict[str, Any]:
        return {"json": body, "headers": {k.replace("_", "-"): v for k, v in headers.items()}}

    return build


async def _patch_item(w: World) -> dict[str, Any]:
    item = await w.item()
    return {"json": {"title": "Renamed"}, "headers": {"If-Match": f'"{item["version"]}"'}}


async def _patch_project(w: World) -> dict[str, Any]:
    project = await w.owner("GET", "")
    return {"json": {"name": "Renamed"}, "headers": {"If-Match": f'"{project["version"]}"'}}


async def _quality(w: World) -> dict[str, Any]:
    item = await w.item()
    return {"json": {"quality": QUALITY, "documentHash": item["documentHash"]}}


async def _restore(w: World) -> dict[str, Any]:
    return {"headers": {"If-Match": f'"{(await w.item())["version"]}"'}}


async def _relationship(w: World) -> dict[str, Any]:
    return {"json": {"sourceId": w.item2_id, "targetId": w.item_id, "type": "supports"}}


async def _import(w: World) -> dict[str, Any]:
    backup = await w.client.get(f"{API}/projects/{w.project_id}/backup", headers=w.tokens.headers(OWNER))
    return {"content": backup.content, "headers": {"content-type": "application/json"}}


async def _search(_: World) -> dict[str, Any]:
    return {"params": {"q": "notes"}}


async def _upload(_: World) -> dict[str, Any]:
    return {"files": {"file": ("more.txt", b"more text", "text/plain")}}


@dataclass
class Spec:
    method: str
    path: str  # the route template as in the OpenAPI schema
    access: str  # key of EXPECTED, or "mcp" (see test_mcp_tools_matrix)
    build: Build = _none
    params: dict[str, str] = field(default_factory=dict)
    streams: bool = False  # a successful response never ends: checked against a live server

    @property
    def id(self) -> str:
        extra = "/".join(self.params.values())
        return f"{self.method} {self.path.removeprefix(API)}{' ' + extra if extra else ''}"


SPECS: list[Spec] = [
    # public
    Spec("GET", "/healthz", "public"),
    Spec("GET", "/readyz", "public"),
    Spec("GET", API + "/healthz", "public"),
    Spec("GET", API + "/readyz", "public"),
    Spec("GET", API + "/openapi.json", "public"),
    Spec("GET", API + "/docs", "public"),
    Spec("GET", "/docs/oauth2-redirect", "public"),
    # any verified user
    Spec("GET", API + "/me", "user"),
    Spec("GET", API + "/projects", "user"),
    Spec("POST", API + "/projects", "user", _json({"name": "Fresh"})),
    Spec("POST", API + "/projects/import", "user", _import),
    # project and members
    Spec("GET", P, "member"),
    Spec("PATCH", P, "owner", _patch_project),
    Spec("DELETE", P, "owner"),
    Spec("GET", P + "/members", "member"),
    Spec("POST", P + "/members", "owner", _json({"email": "eve@example.test", "role": "contributor"})),
    Spec("PATCH", P + "/members/{email}", "owner", _json({"role": "owner"})),
    Spec("DELETE", P + "/members/{email}", "owner"),
    # guidance
    Spec("GET", P + "/guidance", "member"),
    Spec("GET", P + "/guidance/defaults", "member"),
    Spec("GET", P + "/guidance/export", "member"),
    Spec(
        "POST",
        P + "/guidance/import",
        "owner",
        _json({"format": "backlog-guidance", "formatVersion": 5, "guidance": {}}),
    ),
    Spec("PUT", P + "/guidance/principles", "owner", _json({"content": "Be brief."}, If_Match="0")),
    Spec("DELETE", P + "/guidance/principles", "owner"),
    Spec(
        "PUT",
        P + "/guidance/{kind}/{item_type}",
        "owner",
        _json({"content": TEMPLATE}, If_Match="0"),
        {"kind": "template", "item_type": "feature"},
    ),
    Spec(
        "PUT",
        P + "/guidance/{kind}/{item_type}",
        "owner",
        _json({"content": "Ask questions."}, If_Match="0"),
        {"kind": "type-instructions", "item_type": "feature"},
    ),
    Spec("DELETE", P + "/guidance/{kind}/{item_type}", "owner", _none, {"kind": "template", "item_type": "feature"}),
    # sources
    Spec("GET", P + "/sources", "member"),
    Spec("POST", P + "/sources", "member", _upload),
    Spec("GET", P + "/sources/{source_id}", "member"),
    Spec("GET", P + "/sources/{source_id}/file", "member"),
    Spec("PATCH", P + "/sources/{source_id}", "member", _json({"mode": "pinned"}, If_Match='"1"')),
    Spec("DELETE", P + "/sources/{source_id}", "member"),
    Spec("POST", P + "/sources/{source_id}/reindex", "member"),
    # items, revisions, relationships
    Spec("GET", P + "/items", "member"),
    Spec("POST", P + "/items", "member", _json({"type": "feature", "title": "New"})),
    Spec("GET", P + "/items/{item_id}", "member"),
    Spec("PATCH", P + "/items/{item_id}", "member", _patch_item),
    Spec("DELETE", P + "/items/{item_id}", "member"),
    Spec("PUT", P + "/items/{item_id}/quality", "member", _quality),
    Spec("GET", P + "/items/{item_id}/revisions", "member"),
    Spec("GET", P + "/items/{item_id}/revisions/{revision_id}", "member"),
    Spec("POST", P + "/items/{item_id}/revisions/{revision_id}/restore", "member", _restore),
    Spec("GET", P + "/relationships", "member"),
    Spec("POST", P + "/relationships", "member", _relationship),
    Spec("DELETE", P + "/relationships/{relationship_id}", "member"),
    # search, backup, events, presence
    Spec("GET", P + "/search", "member", _search),
    Spec("GET", P + "/backup", "owner"),
    Spec("POST", P + "/events/ticket", "member"),
    Spec("GET", P + "/events", "member", streams=True),
    Spec("GET", P + "/presence", "member"),
    Spec("POST", P + "/presence", "member", _json({"state": "viewing"})),
    Spec("DELETE", P + "/presence", "member"),
    # service-to-service and MCP (their own tests below)
    Spec("GET", API + "/internal/events", "service", streams=True),
    Spec("*", API + "/mcp", "mcp"),
    Spec("*", API + "/mcp/", "mcp"),
]


# --- completeness ---------------------------------------------------------------------------------------------------


def _app_routes(app: FastAPI) -> set[tuple[str, str]]:
    found: set[tuple[str, str]] = set()
    for context in iter_route_contexts(app.routes):
        methods = {m for m in (context.methods or ()) if m != "HEAD"} or {"*"}
        found |= {(method, str(context.path)) for method in methods}
    return found


async def test_every_route_is_classified(app: FastAPI) -> None:
    classified = {(spec.method, spec.path) for spec in SPECS}
    routes = _app_routes(app)
    assert not routes - classified, f"routes missing from the RBAC matrix: {sorted(routes - classified)}"
    assert not classified - routes, f"the RBAC matrix lists routes that do not exist: {sorted(classified - routes)}"
    schema = app.openapi()
    documented = {(method.upper(), path) for path, item in schema["paths"].items() for method in item}
    assert not documented - classified, (
        f"documented operations missing from the matrix: {sorted(documented - classified)}"
    )
    assert len(routes) >= 55


# --- the matrix -----------------------------------------------------------------------------------------------------


def _matches(status: int, expected: str) -> bool:
    return status // 100 == 2 if expected == "2xx" else status == int(expected)


async def _call(world: World, spec: Spec, role: str, *, random_project: bool = False) -> httpx.Response:
    kwargs = await spec.build(world)
    headers = {**world.headers(role), **kwargs.pop("headers", {})}
    path = world.fill(spec.path, spec.params)
    if random_project:
        path = path.replace(world.project_id, str(uuid.uuid4()))
    return await world.client.request(spec.method, path, headers=headers, **kwargs)


async def _check(world: World, spec: Spec, role: str) -> None:
    expected = EXPECTED[spec.access][role]
    response = await _call(world, spec, role)
    label = f"{spec.id} as {role}: {response.status_code} {response.text[:200]}"
    assert _matches(response.status_code, expected), label
    if expected == "401":
        assert response.headers["www-authenticate"].startswith("Bearer"), label
    if expected == "403" and role == "unverified" and spec.access != "service":
        assert response.json()["type"].endswith("/email-not-verified"), label
    elif expected == "403" and spec.access == "owner":
        assert response.json()["type"].endswith("/owner-required"), label
    elif expected in PROBLEM_TYPE:
        assert response.json()["type"].endswith("/" + PROBLEM_TYPE[expected]), label
    if role == "non_member" and spec.access in ("member", "owner"):
        # Non-members cannot tell a project they are not in from one that does not exist.
        unknown = await _call(world, spec, role, random_project=True)
        assert (unknown.status_code, unknown.json()["type"]) == (404, response.json()["type"]), label


@pytest.mark.parametrize("spec", [s for s in SPECS if s.access != "mcp" and not s.streams], ids=lambda s: s.id)
async def test_route_matrix(spec: Spec, client: httpx.AsyncClient, tokens: TokenFactory) -> None:
    world = await build_world(client, tokens)
    # Denied roles first (they never change anything), then the contributor, then the owner. Allowed writes by the
    # contributor consume the fixture (DELETE, ...), so the owner then gets a fresh project.
    for role in ("no_token", "unverified", "non_member", "contributor"):
        await _check(world, spec, role)
    consumed = EXPECTED[spec.access]["contributor"] == "2xx" and spec.method != "GET"
    await _check(await build_world(client, tokens) if consumed else world, spec, "owner")


async def test_matrix_covers_the_permission_table_of_the_plan() -> None:
    owner_only = {spec.id for spec in SPECS if spec.access == "owner"}
    assert owner_only >= {
        "PATCH /projects/{project_id}",
        "DELETE /projects/{project_id}",
        "GET /projects/{project_id}/backup",
        "POST /projects/{project_id}/members",
        "PATCH /projects/{project_id}/members/{email}",
        "DELETE /projects/{project_id}/members/{email}",
        "POST /projects/{project_id}/guidance/import",
        "PUT /projects/{project_id}/guidance/principles",
    }
    member_routes = {spec.id for spec in SPECS if spec.access == "member"}
    assert "POST /projects/{project_id}/items" in member_routes
    assert "DELETE /projects/{project_id}/sources/{source_id}" in member_routes


async def test_a_contributor_may_leave_but_not_remove_others(client: httpx.AsyncClient, tokens: TokenFactory) -> None:
    world = await build_world(client, tokens)
    base = f"{API}/projects/{world.project_id}/members"
    other = await client.delete(f"{base}/{OTHER_MEMBER}", headers=world.headers("contributor"))
    assert other.status_code == 403
    leave = await client.delete(f"{base}/{CONTRIBUTOR}", headers=world.headers("contributor"))
    assert leave.status_code == 204
    after = await client.get(f"{API}/projects/{world.project_id}", headers=world.headers("contributor"))
    assert after.status_code == 404


STREAM_SPECS = [s for s in SPECS if s.streams]


@pytest.mark.parametrize("spec", STREAM_SPECS, ids=lambda s: s.id)
async def test_stream_route_matrix(spec: Spec, settings: Settings, tokens: TokenFactory, database_url: str) -> None:
    """Streams need a real socket: denied roles get problems, allowed roles get an open event stream."""
    await truncate_all(database_url)
    live_settings = settings.model_copy(update={"internal_client_ids": ["agent-service"]})
    async with running_replica(live_settings, tokens) as replica:
        world = await build_world(replica.http, tokens)
        for role in ROLES:
            expected = EXPECTED[spec.access][role]
            if expected != "2xx":
                await _check(world, spec, role)
                continue
            async with replica.http.stream(
                spec.method, world.fill(spec.path, spec.params), headers=world.headers(role)
            ) as response:
                assert response.status_code == 200, (spec.id, role)
                assert response.headers["content-type"].startswith("text/event-stream")
        if spec.access == "service":
            service = tokens.headers(
                None, email_verified=None, extra={"azp": "agent-service"}, omit=("email", "email_verified", "name")
            )
            async with replica.http.stream("GET", spec.path, headers=service) as response:
                assert response.status_code == 200


# --- MCP ------------------------------------------------------------------------------------------------------------


def _tool_calls(project_id: str, item: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Arguments that succeed for a member: the item version and hash are the current ones."""
    stamp = uuid.uuid4().hex[:6]
    return {
        "get_item_context": {"projectId": project_id, "itemId": item["id"]},
        "get_project_guidance": {"projectId": project_id},
        "get_pinned_sources": {"projectId": project_id},
        "search_sources": {"projectId": project_id, "query": "notes"},
        "find_similar_items": {"projectId": project_id, "text": "matrix"},
        "apply_document_changes": {
            "projectId": project_id,
            "itemId": item["id"],
            "baseVersion": item["version"],
            "sections": [{"id": "s", "heading": "Summary", "markdown": f"Changed {stamp}"}],
        },
        "create_child_items": {
            "projectId": project_id,
            "parentId": item["id"],
            "childType": "user-story",
            "children": [{"proposalId": stamp, "title": f"Child {stamp}", "markdown": ""}],
        },
        "set_item_quality": {
            "projectId": project_id,
            "itemId": item["id"],
            "quality": {"overall": "ready", "areas": []},
            "documentHash": item["documentHash"],
        },
    }


async def test_mcp_tools_matrix(app: FastAPI, client: httpx.AsyncClient, tokens: TokenFactory) -> None:
    world = await build_world(client, tokens)
    item = await world.item()
    calls = _tool_calls(world.project_id, item)
    assert set(calls) == READ_TOOLS | WRITE_TOOLS, "a new MCP tool needs an entry in the matrix"
    for role, allowed in (("non_member", False), ("contributor", True), ("owner", True)):
        async with mcp_client(app, world.headers(role)) as mcp:
            for name in sorted(calls):
                arguments = calls[name]
                if name in WRITE_TOOLS:  # earlier writes bumped the version and changed the hash
                    current = await world.item()
                    arguments = _tool_calls(world.project_id, current)[name]
                result = await mcp.call_tool(name, arguments)
                payload = result.structured_content or {}
                if allowed:
                    assert not result.is_error, (role, name, payload)
                else:
                    assert result.is_error, (role, name)
                    assert (payload["status"], payload["type"]) == (404, "not-found"), (role, name)


@pytest.mark.parametrize("path", [API + "/mcp", API + "/mcp/"])
async def test_mcp_endpoint_requires_a_verified_user(
    path: str, client: httpx.AsyncClient, tokens: TokenFactory
) -> None:
    body = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": "get_project_guidance", "arguments": {}},
    }
    accept = {"Accept": "application/json, text/event-stream"}
    anonymous = await client.post(
        path, content=json.dumps(body), headers={**accept, "content-type": "application/json"}
    )
    assert anonymous.status_code == 401
    unverified = await client.post(
        path, content=json.dumps(body), headers={**accept, **tokens.headers(OWNER, email_verified=False)}
    )
    assert unverified.status_code == 403
