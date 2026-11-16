from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any

import httpx
import httpx2
import pytest
from fastapi import FastAPI
from mcp import Client
from mcp.client.streamable_http import streamable_http_client
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backlog_api.db.models import AuditEvent, Item, ItemRevision, Job, Relationship
from backlog_api.embeddings import EmbeddingClient
from backlog_api.events import DomainEvent, InProcessEventPublisher
from backlog_api.mcp_server import fit_output
from backlog_api.settings import Settings
from backlog_api.worker import IndexingWorker
from backlog_api_testkit import API, TokenFactory, add_member, create_project
from test_indexing import FakeGateway

OWNER = "alice@example.test"
CONTRIBUTOR = "bob@example.test"
OUTSIDER = "carol@example.test"
MCP_URL = "http://backlog-api.test/api/backlog/mcp"

READ_TOOLS = {"get_item_context", "get_project_guidance", "get_pinned_sources", "search_sources", "find_similar_items"}
WRITE_TOOLS = {"apply_document_changes", "create_child_items", "set_item_quality"}

Caller = Callable[..., Awaitable[Any]]


class ToolFailure(Exception):
    def __init__(self, payload: dict[str, Any]) -> None:
        super().__init__(payload)
        self.payload = payload


@asynccontextmanager
async def mcp_client(app: FastAPI, headers: dict[str, str]) -> AsyncIterator[Client]:
    http = httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), headers=headers)
    async with http, Client(streamable_http_client(MCP_URL, http_client=http)) as client:
        yield client


async def call_raw(client: Client, name: str, arguments: dict[str, Any]) -> tuple[bool, dict[str, Any]]:
    result = await client.call_tool(name, arguments)
    assert result.content and result.content[0].type == "text"
    structured = result.structured_content
    assert structured is not None
    assert json.loads(result.content[0].text) == structured
    return result.is_error, structured


@pytest.fixture
async def gateway_embedder(app: FastAPI, settings: Settings) -> EmbeddingClient:
    client = EmbeddingClient.from_settings(
        settings.model_copy(update={"llm_base_url": "http://gateway.test", "embedding_max_retries": 0}),
        transport=httpx.MockTransport(FakeGateway()),
    )
    assert client is not None
    app.state.embedder = client
    return client


@pytest.fixture
async def project(client: httpx.AsyncClient, tokens: TokenFactory) -> dict[str, Any]:
    project = await create_project(client, tokens, OWNER, "MCP")
    assert (await add_member(client, tokens, project["id"], OWNER, CONTRIBUTOR)).status_code == 201
    return project


@pytest.fixture
def alice(app: FastAPI, tokens: TokenFactory) -> Caller:
    """Calls a tool as alice (one short-lived MCP connection per call, like agent-service)."""

    async def call(name: str, **arguments: Any) -> dict[str, Any]:
        async with mcp_client(app, tokens.headers(OWNER)) as client:
            is_error, payload = await call_raw(client, name, arguments)
        if is_error:
            raise ToolFailure(payload)
        return payload

    return call


async def create_item(
    client: httpx.AsyncClient, tokens: TokenFactory, project: dict[str, Any], item_type: str = "feature", **body: Any
) -> dict[str, Any]:
    response = await client.post(
        f"{API}/projects/{project['id']}/items", json={"type": item_type, **body}, headers=tokens.headers(OWNER)
    )
    assert response.status_code == 201, response.text
    return response.json()


async def add_source(
    client: httpx.AsyncClient, tokens: TokenFactory, project: dict[str, Any], name: str, text: str, mode: str
) -> dict[str, Any]:
    response = await client.post(
        f"{API}/projects/{project['id']}/sources",
        json={"name": name, "text": text, "mode": mode},
        headers=tokens.headers(OWNER),
    )
    assert response.status_code == 201, response.text
    return response.json()


# --- transport and auth ----------------------------------------------------------------------------------------------


@pytest.mark.parametrize("headers", [{}, {"Authorization": "Bearer not-a-jwt"}, {"Authorization": "Basic abc"}])
async def test_requests_without_a_valid_token_get_401(client: httpx.AsyncClient, headers: dict[str, str]) -> None:
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
    response = await client.post(
        "/api/backlog/mcp", json=body, headers={"Accept": "application/json, text/event-stream", **headers}
    )
    assert response.status_code == 401
    assert response.headers["www-authenticate"].startswith("Bearer")
    assert response.headers["x-request-id"]


async def test_unverified_email_is_rejected(client: httpx.AsyncClient, tokens: TokenFactory) -> None:
    response = await client.post(
        "/api/backlog/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
        headers=tokens.headers("dave@example.test", email_verified=False),
    )
    assert response.status_code == 403


async def test_mcp_mount_is_not_in_the_openapi_schema(client: httpx.AsyncClient) -> None:
    schema = (await client.get(f"{API}/openapi.json")).json()
    assert not [path for path in schema["paths"] if "/mcp" in path]


async def test_lists_all_tools_with_annotations(app: FastAPI, tokens: TokenFactory) -> None:
    async with mcp_client(app, tokens.headers(OWNER)) as client:
        tools = {tool.name: tool for tool in (await client.list_tools()).tools}
    assert set(tools) == READ_TOOLS | WRITE_TOOLS
    for name in READ_TOOLS:
        annotations = tools[name].annotations
        assert annotations is not None and annotations.read_only_hint is True
        assert tools[name].description and len(tools[name].description or "") > 80
    for name in WRITE_TOOLS:
        annotations = tools[name].annotations
        assert annotations is not None
        assert annotations.read_only_hint is False
        assert annotations.destructive_hint is False
        assert annotations.idempotent_hint is False
    assert "projectId" in tools["get_item_context"].input_schema["properties"]
    assert set(tools["apply_document_changes"].input_schema["required"]) >= {"projectId", "itemId", "baseVersion"}


# --- read tools ------------------------------------------------------------------------------------------------------


async def test_get_item_context_shape(
    alice: Caller, client: httpx.AsyncClient, tokens: TokenFactory, project: dict[str, Any]
) -> None:
    capability = await create_item(client, tokens, project, "capability", title="Cap")
    feature = await create_item(client, tokens, project, "feature", title="Feat", parentId=capability["id"])
    story = await create_item(client, tokens, project, "user-story", title="Story", parentId=feature["id"])
    other = await create_item(client, tokens, project, "feature", title="Other")
    pid = project["id"]
    assert (
        await client.post(
            f"{API}/projects/{pid}/relationships",
            json={"sourceId": feature["id"], "targetId": other["id"], "type": "depends-on"},
            headers=tokens.headers(OWNER),
        )
    ).status_code == 201

    context = await alice("get_item_context", projectId=pid, itemId=feature["id"])
    item = context["item"]
    assert item == {
        "id": feature["id"],
        "type": "feature",
        "title": "Feat",
        "status": "draft",
        "version": 1,
        "document": feature["document"],
        "documentHash": feature["documentHash"],
        "quality": None,
        "qualityAssessedAt": None,
        "qualityStale": False,
    }
    assert context["parent"] == {"id": capability["id"], "type": "capability", "title": "Cap", "status": "draft"}
    assert context["children"] == [{"id": story["id"], "type": "user-story", "title": "Story", "status": "draft"}]
    assert context["related"] == [
        {
            "id": other["id"],
            "type": "feature",
            "title": "Other",
            "status": "draft",
            "relationship": "depends-on",
            "direction": "outgoing",
        }
    ]
    assert context["template"]["itemType"] == "feature" and context["template"]["markdown"].strip()
    assert context["childType"] == "user-story"
    incoming = await alice("get_item_context", projectId=pid, itemId=other["id"])
    assert incoming["related"][0]["direction"] == "incoming" and incoming["related"][0]["id"] == feature["id"]
    assert incoming["parent"] is None and incoming["children"] == []
    assert (await alice("get_item_context", projectId=pid, itemId=story["id"]))["childType"] is None


async def test_get_item_context_rejects_items_of_other_projects(
    alice: Caller, client: httpx.AsyncClient, tokens: TokenFactory, project: dict[str, Any]
) -> None:
    second = await create_project(client, tokens, OWNER, "Second")
    foreign = await create_item(client, tokens, second, "feature")
    with pytest.raises(ToolFailure) as error:
        await alice("get_item_context", projectId=project["id"], itemId=foreign["id"])
    assert error.value.payload["status"] == 404
    with pytest.raises(ToolFailure) as unknown:
        await alice("get_item_context", projectId=project["id"], itemId=str(uuid.uuid4()))
    assert unknown.value.payload["status"] == 404


async def test_get_project_guidance_shape_and_filter(
    alice: Caller, client: httpx.AsyncClient, tokens: TokenFactory, project: dict[str, Any]
) -> None:
    full = await alice("get_project_guidance", projectId=project["id"])
    assert set(full) == {"principles", "documentFormat", "typeInstructions", "templates", "skills"}
    assert set(full["typeInstructions"]) == set(full["templates"]) == {"capability", "feature", "user-story", "enabler"}
    assert full["principles"].keys() == {"content", "source", "defaultVersion", "baseSkillVersion", "outdated"}
    assert full["principles"]["source"] == "default" and full["documentFormat"] and full["skills"]

    response = await client.put(
        f"{API}/projects/{project['id']}/guidance/type-instructions/feature",
        json={"content": "Project specific feature rules."},
        headers={**tokens.headers(OWNER), "If-Match": "0"},
    )
    assert response.status_code == 200, response.text
    filtered = await alice("get_project_guidance", projectId=project["id"], itemType="feature")
    assert set(filtered["typeInstructions"]) == set(filtered["templates"]) == {"feature", "user-story"}
    assert filtered["typeInstructions"]["feature"]["source"] == "project"
    assert filtered["typeInstructions"]["feature"]["content"] == "Project specific feature rules."
    assert set((await alice("get_project_guidance", projectId=project["id"], itemType="user-story"))["templates"]) == {
        "user-story"
    }
    with pytest.raises(ToolFailure) as error:
        await alice("get_project_guidance", projectId=project["id"], itemType="epic")
    assert error.value.payload["type"] == "invalid-arguments" and error.value.payload["status"] == 422


async def test_get_pinned_sources_returns_only_pinned_within_budget(
    alice: Caller, client: httpx.AsyncClient, tokens: TokenFactory, project: dict[str, Any]
) -> None:
    pinned = await add_source(client, tokens, project, "Pinned", "Pinned reference text", "pinned")
    await add_source(client, tokens, project, "Searchable", "Searchable text", "searchable")
    await add_source(client, tokens, project, "Hidden", "Excluded text", "excluded")
    result = await alice("get_pinned_sources", projectId=project["id"])
    assert result["budget"] == {"used": len("Pinned reference text"), "limit": 100_000}
    assert result["sources"] == [
        {
            "id": pinned["id"],
            "name": "Pinned",
            "kind": "text",
            "charCount": len("Pinned reference text"),
            "pageCount": None,
            "text": "Pinned reference text",
        }
    ]
    assert "truncated" not in result


async def test_search_sources_returns_citations_and_never_excluded_sources(
    alice: Caller,
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    project: dict[str, Any],
    app: FastAPI,
    gateway_embedder: EmbeddingClient,
    settings: Settings,
    event_publisher: InProcessEventPublisher,
) -> None:
    pets = await add_source(
        client,
        tokens,
        project,
        "Pets",
        "# Cats\n\n## Care\n\nCats need fresh water and a scratching post.",
        "searchable",
    )
    await add_source(client, tokens, project, "Secrets", "Cats scratching post secret plans", "excluded")
    await IndexingWorker(app.state.db.sessionmaker, settings, gateway_embedder, event_publisher).drain()

    result = await alice("search_sources", projectId=project["id"], query="scratching post for cats", limit=5)
    assert result["semantic"] is True
    assert result["passages"], result
    passage = result["passages"][0]
    assert passage.keys() == {"citationId", "sourceId", "sourceName", "page", "headingPath", "text", "score"}
    assert passage["citationId"] == f"src:{pets['id']}#0" and passage["sourceName"] == "Pets"
    assert passage["headingPath"] == "Cats > Care"
    assert all(p["sourceName"] != "Secrets" for p in result["passages"])
    with pytest.raises(ToolFailure) as error:
        await alice("search_sources", projectId=project["id"], query="cats", limit=21)
    assert error.value.payload["type"] == "invalid-arguments"
    with pytest.raises(ToolFailure):
        await alice("search_sources", projectId=project["id"], query="")


async def test_search_sources_is_full_text_without_embeddings(
    alice: Caller,
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    project: dict[str, Any],
    app: FastAPI,
    settings: Settings,
    event_publisher: InProcessEventPublisher,
) -> None:
    app.state.embedder = None
    await add_source(client, tokens, project, "Taxes", "Tax returns are due in April.", "searchable")
    await IndexingWorker(app.state.db.sessionmaker, settings, None, event_publisher).drain()
    result = await alice("search_sources", projectId=project["id"], query="tax returns")
    assert result["semantic"] is False and [p["sourceName"] for p in result["passages"]] == ["Taxes"]


async def test_find_similar_items_by_item_and_text_and_argument_validation(
    alice: Caller,
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    project: dict[str, Any],
    app: FastAPI,
    settings: Settings,
    gateway_embedder: EmbeddingClient,
    event_publisher: InProcessEventPublisher,
    sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    app.state.settings = app.state.settings.model_copy(update={"mcp_similar_min_score": 0.2})
    first = await create_item(client, tokens, project, title="Export monthly invoices as PDF")
    second = await create_item(client, tokens, project, title="Export monthly invoices as PDF files")
    await create_item(client, tokens, project, title="Dark mode for the settings page")
    async with sessionmaker() as session:
        await session.execute(update(Job).where(Job.status == "queued").values(run_after=Job.created_at))
        await session.commit()
    await IndexingWorker(app.state.db.sessionmaker, settings, gateway_embedder, event_publisher).drain()

    by_text = await alice("find_similar_items", projectId=project["id"], text="monthly invoices export pdf", limit=3)
    assert by_text["semantic"] is True
    assert by_text["items"][0].keys() == {"id", "title", "type", "status", "score"}
    assert {by_text["items"][0]["id"]} <= {first["id"], second["id"]}
    by_item = await alice("find_similar_items", projectId=project["id"], itemId=first["id"])
    assert [hit["id"] for hit in by_item["items"]][:1] == [second["id"]]
    assert all(hit["id"] != first["id"] for hit in by_item["items"])

    for arguments in (
        {},
        {"itemId": first["id"], "text": "both"},
        {"text": "x", "limit": 0},
        {"text": "x", "limit": 21},
        {"itemId": "not-a-uuid"},
    ):
        with pytest.raises(ToolFailure) as error:
            await alice("find_similar_items", projectId=project["id"], **arguments)
        assert (error.value.payload["status"], error.value.payload["type"]) == (422, "invalid-arguments")
    with pytest.raises(ToolFailure) as foreign:
        await alice("find_similar_items", projectId=project["id"], itemId=str(uuid.uuid4()))
    assert foreign.value.payload["status"] == 404


# --- membership and identity -----------------------------------------------------------------------------------------


async def test_non_members_get_not_found_tool_errors_for_every_tool(
    app: FastAPI, client: httpx.AsyncClient, tokens: TokenFactory, project: dict[str, Any]
) -> None:
    item = await create_item(client, tokens, project)
    pid, iid = project["id"], item["id"]
    calls: dict[str, dict[str, Any]] = {
        "get_item_context": {"projectId": pid, "itemId": iid},
        "get_project_guidance": {"projectId": pid},
        "get_pinned_sources": {"projectId": pid},
        "search_sources": {"projectId": pid, "query": "x"},
        "find_similar_items": {"projectId": pid, "itemId": iid},
        "apply_document_changes": {
            "projectId": pid,
            "itemId": iid,
            "baseVersion": 1,
            "sections": [{"id": "s", "heading": "Summary", "markdown": "x"}],
        },
        "create_child_items": {
            "projectId": pid,
            "parentId": iid,
            "childType": "user-story",
            "children": [{"proposalId": "c", "title": "T", "markdown": ""}],
        },
        "set_item_quality": {
            "projectId": pid,
            "itemId": iid,
            "quality": {"overall": "ready", "areas": []},
            "documentHash": item["documentHash"],
        },
    }
    assert set(calls) == READ_TOOLS | WRITE_TOOLS
    async with mcp_client(app, tokens.headers(OUTSIDER)) as client_:
        for name, arguments in calls.items():
            is_error, payload = await call_raw(client_, name, arguments)
            assert is_error, name
            assert (payload["status"], payload["type"]) == (404, "not-found"), name
    async with sessionmaker_session(app) as session:
        assert (await session.get(Item, uuid.UUID(iid))).version == 1  # type: ignore[union-attr]


@asynccontextmanager
async def sessionmaker_session(app: FastAPI) -> AsyncIterator[AsyncSession]:
    async with app.state.db.sessionmaker() as session:
        yield session


async def test_concurrent_users_keep_their_own_principal(
    app: FastAPI, client: httpx.AsyncClient, tokens: TokenFactory, project: dict[str, Any]
) -> None:
    item = await create_item(client, tokens, project, document="## Summary\nOne")
    sections = [{"id": "s", "heading": "Summary", "markdown": "Changed"}]

    async def apply(user: str, base_version: int, heading_text: str) -> dict[str, Any]:
        async with mcp_client(app, tokens.headers(user)) as client_:
            is_error, payload = await call_raw(
                client_,
                "apply_document_changes",
                {
                    "projectId": project["id"],
                    "itemId": item["id"],
                    "baseVersion": base_version,
                    "sections": [{**sections[0], "markdown": heading_text}],
                    "suggestedTitle": f"By {user}",
                    "runId": f"run-{user}",
                },
            )
            assert not is_error, payload
            return payload

    async def context(user: str) -> dict[str, Any]:
        async with mcp_client(app, tokens.headers(user)) as client_:
            is_error, payload = await call_raw(
                client_, "get_item_context", {"projectId": project["id"], "itemId": item["id"]}
            )
            return {"error": is_error, **payload}

    outsider_context, _, _ = await asyncio.gather(context(OUTSIDER), apply(OWNER, 1, "Owner text"), asyncio.sleep(0))
    assert outsider_context["error"] is True and outsider_context["status"] == 404
    await apply(CONTRIBUTOR, 2, "Contributor text")
    async with sessionmaker_session(app) as session:
        revisions = (
            await session.scalars(select(ItemRevision).where(ItemRevision.item_id == uuid.UUID(item["id"])))
        ).all()
    assert {(rev.actor, rev.run_id) for rev in revisions if rev.origin == "agent"} == {
        (OWNER, f"run-{OWNER}"),
        (CONTRIBUTOR, f"run-{CONTRIBUTOR}"),
    }


# --- write tools -----------------------------------------------------------------------------------------------------


async def test_apply_document_changes_creates_agent_revision_audits_and_publishes(
    alice: Caller,
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    project: dict[str, Any],
    sessionmaker: async_sessionmaker[AsyncSession],
    published_events: list[DomainEvent],
) -> None:
    item = await create_item(client, tokens, project, document="## Summary\nOne\n\n## Scope\nS")
    published_events.clear()
    result = await alice(
        "apply_document_changes",
        projectId=project["id"],
        itemId=item["id"],
        baseVersion=1,
        sections=[
            {"id": "s1", "heading": "Summary", "mode": "replace", "markdown": "Agent summary"},
            {"id": "s2", "heading": "Scope", "mode": "append", "markdown": "- more"},
        ],
        suggestedTitle="Agent title",
        suggestedStatus="ready",
        runId="run-42",
        label="Refinement",
    )
    assert result == {
        "applied": ["s1", "s2"],
        "conflicted": [],
        "newVersion": 2,
        "warnings": [],
        "titleApplied": True,
        "statusApplied": False,  # draft -> ready is not a valid transition
    }
    async with sessionmaker() as session:
        stored = await session.get(Item, uuid.UUID(item["id"]))
        assert stored is not None
        assert (stored.title, stored.version, stored.updated_by) == ("Agent title", 2, OWNER)
        assert "Agent summary" in stored.document and "- more" in stored.document
        revision = await session.scalar(
            select(ItemRevision).where(ItemRevision.item_id == stored.id, ItemRevision.version == 2)
        )
        assert revision is not None
        assert (revision.origin, revision.actor, revision.run_id, revision.label) == (
            "agent",
            OWNER,
            "run-42",
            "Refinement",
        )
        audit_actions = (await session.scalars(select(AuditEvent.action).where(AuditEvent.actor == OWNER))).all()
    assert "item.agent_applied" in audit_actions
    updated = [event for event in published_events if event.type == "item.updated"]
    assert len(updated) == 1
    assert updated[0].actor == OWNER and updated[0].data["origin"] == "agent" and updated[0].data["version"] == 2


async def test_apply_document_changes_reports_conflicts_since_base_version(
    alice: Caller, client: httpx.AsyncClient, tokens: TokenFactory, project: dict[str, Any]
) -> None:
    item = await create_item(client, tokens, project, document="## Summary\nOne\n\n## Scope\nS")
    edited = await client.patch(
        f"{API}/projects/{project['id']}/items/{item['id']}",
        json={"document": "## Summary\nTheirs\n\n## Scope\nS"},
        headers={**tokens.headers(CONTRIBUTOR), "If-Match": '"1"'},
    )
    assert edited.status_code == 200, edited.text
    result = await alice(
        "apply_document_changes",
        projectId=project["id"],
        itemId=item["id"],
        baseVersion=1,
        sections=[
            {"id": "s1", "heading": "Summary", "markdown": "Mine"},
            {"id": "s2", "heading": "Scope", "markdown": "New scope"},
        ],
    )
    assert result["applied"] == ["s2"]
    assert [(c["sectionId"], c["heading"], c["currentMarkdown"]) for c in result["conflicted"]] == [
        ("s1", "Summary", "Theirs")
    ]
    assert result["conflicted"][0]["reason"]
    assert result["newVersion"] == 3


async def test_apply_document_changes_validates_arguments(
    alice: Caller, client: httpx.AsyncClient, tokens: TokenFactory, project: dict[str, Any]
) -> None:
    item = await create_item(client, tokens, project)
    base = {"projectId": project["id"], "itemId": item["id"]}
    section = {"id": "s", "heading": "Summary", "markdown": "x"}
    bad_calls: list[dict[str, Any]] = [
        {**base, "baseVersion": 1, "sections": []},
        {**base, "baseVersion": 0, "sections": [section]},
        {**base, "baseVersion": 1, "sections": [{**section, "mode": "delete"}]},
        {**base, "baseVersion": 1, "sections": [section, section]},
        {**base, "baseVersion": 1, "sections": [section], "suggestedStatus": "complete"},
        {**base, "baseVersion": 1, "sections": [{"heading": "Summary", "markdown": "x"}]},
    ]
    for arguments in bad_calls:
        with pytest.raises(ToolFailure) as error:
            await alice("apply_document_changes", **arguments)
        assert (error.value.payload["status"], error.value.payload["type"]) == (422, "invalid-arguments")
        assert error.value.payload["detail"]
    with pytest.raises(ToolFailure) as future:
        await alice("apply_document_changes", **base, baseVersion=9, sections=[section])
    assert (future.value.payload["status"], future.value.payload["type"]) == (422, "invalid-base-version")


async def test_create_child_items_creates_children_and_relationships(
    alice: Caller,
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    project: dict[str, Any],
    sessionmaker: async_sessionmaker[AsyncSession],
    published_events: list[DomainEvent],
) -> None:
    parent = await create_item(client, tokens, project, "feature", title="Parent")
    published_events.clear()
    result = await alice(
        "create_child_items",
        projectId=project["id"],
        parentId=parent["id"],
        childType="user-story",
        children=[
            {"proposalId": "a", "title": "Story A", "markdown": "## Story\nAs a user I want A"},
            {"proposalId": "b", "title": "Story B", "markdown": ""},
            {"proposalId": "c", "title": "story  a", "markdown": ""},
        ],
        relationships=[
            {"sourceRef": "b", "targetRef": "a", "type": "depends-on"},
            {"sourceRef": parent["id"].upper(), "targetRef": "a", "type": "parent-child"},
            {"sourceRef": "a", "targetRef": "missing", "type": "related-to"},
        ],
        runId="run-7",
    )
    assert [c["proposalId"] for c in result["created"]] == ["a", "b"]
    assert [c["title"] for c in result["created"]] == ["Story A", "Story B"]
    assert [f["proposalId"] for f in result["failed"]] == ["c"]
    assert result["relationshipsCreated"] == 3  # two parent links + depends-on
    assert [(s["sourceRef"], s["targetRef"]) for s in result["relationshipsSkipped"]] == [("a", "missing")]
    created = {c["proposalId"]: uuid.UUID(c["itemId"]) for c in result["created"]}
    async with sessionmaker() as session:
        links = (await session.execute(select(Relationship.source_id, Relationship.target_id, Relationship.type))).all()
        revision = await session.scalar(select(ItemRevision).where(ItemRevision.item_id == created["a"]))
        stored = await session.get(Item, created["a"])
    assert (uuid.UUID(parent["id"]), created["a"], "parent-child") in links
    assert (created["b"], created["a"], "depends-on") in links
    assert revision is not None and (revision.origin, revision.actor, revision.run_id) == ("agent", OWNER, "run-7")
    assert stored is not None and "As a user I want A" in stored.document
    types = [event.type for event in published_events]
    assert types.count("item.created") == 2 and types.count("relationship.created") == 3


async def test_create_child_items_validates_arguments_and_type_rules(
    alice: Caller, client: httpx.AsyncClient, tokens: TokenFactory, project: dict[str, Any]
) -> None:
    parent = await create_item(client, tokens, project, "feature")
    base = {"projectId": project["id"], "parentId": parent["id"]}
    child = {"proposalId": "a", "title": "A", "markdown": ""}
    for arguments in (
        {"childType": "user-story", "children": []},
        {"childType": "epic", "children": [child]},
        {"childType": "user-story", "children": [child, child]},
        {"childType": "user-story", "children": [{**child, "title": ""}]},
        {
            "childType": "user-story",
            "children": [child],
            "relationships": [{"sourceRef": "a", "targetRef": "a", "type": "x"}],
        },
    ):
        with pytest.raises(ToolFailure) as error:
            await alice("create_child_items", **base, **arguments)
        assert error.value.payload["type"] == "invalid-arguments"
    with pytest.raises(ToolFailure) as wrong_type:
        await alice("create_child_items", **base, childType="capability", children=[child])
    assert (wrong_type.value.payload["status"], wrong_type.value.payload["type"]) == (422, "invalid-child-type")


async def test_set_item_quality_stores_assessment_and_rejects_stale_hash(
    alice: Caller,
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    project: dict[str, Any],
    published_events: list[DomainEvent],
) -> None:
    item = await create_item(client, tokens, project, document="## Summary\nOne")
    quality = {"overall": "ready-with-open-questions", "areas": [{"area": "problem", "level": "clear", "note": "ok"}]}
    published_events.clear()
    result = await alice(
        "set_item_quality",
        projectId=project["id"],
        itemId=item["id"],
        quality=quality,
        documentHash=item["documentHash"],
    )
    assert result["itemId"] == item["id"] and result["documentHash"] == item["documentHash"]
    assert result["stale"] is False and result["assessedAt"]
    assert [event.type for event in published_events] == ["item.updated"]
    context = await alice("get_item_context", projectId=project["id"], itemId=item["id"])
    assert context["item"]["quality"]["overall"] == "ready-with-open-questions"
    assert context["item"]["qualityStale"] is False and context["item"]["qualityAssessedAt"] == result["assessedAt"]

    with pytest.raises(ToolFailure) as stale:
        await alice(
            "set_item_quality", projectId=project["id"], itemId=item["id"], quality=quality, documentHash="0" * 64
        )
    assert (stale.value.payload["status"], stale.value.payload["type"]) == (409, "stale-assessment")
    assert stale.value.payload["currentDocumentHash"] == item["documentHash"]
    with pytest.raises(ToolFailure) as invalid:
        await alice(
            "set_item_quality",
            projectId=project["id"],
            itemId=item["id"],
            quality={"overall": "great", "areas": []},
            documentHash=item["documentHash"],
        )
    assert invalid.value.payload["type"] == "invalid-arguments"


# --- output limits ---------------------------------------------------------------------------------------------------


def test_fit_output_truncates_the_longest_texts_and_marks_it() -> None:
    payload = {"sources": [{"text": "a" * 5000}, {"text": "b" * 500}], "small": "x"}
    fitted = fit_output(payload, 2000)
    assert fitted["truncated"] is True
    assert len(json.dumps(fitted)) <= 2100
    assert fitted["sources"][1]["text"] == "b" * 500  # only the long text is cut
    assert "truncated" in fitted["sources"][0]["text"]
    untouched = {"a": "x" * 10}
    assert fit_output(untouched, 1000) == {"a": "x" * 10}


async def test_oversized_results_are_truncated_and_marked(
    app: FastAPI,
    alice: Caller,
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    project: dict[str, Any],
) -> None:
    await add_source(client, tokens, project, "Big", "word " * 4000, "pinned")
    app.state.settings = app.state.settings.model_copy(update={"mcp_max_output_chars": 5000})
    result = await alice("get_pinned_sources", projectId=project["id"])
    assert result["truncated"] is True
    assert len(json.dumps(result)) <= 5200
    assert result["sources"][0]["charCount"] == len(("word " * 4000).strip())
