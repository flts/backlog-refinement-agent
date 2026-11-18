"""Fake backlog MCP server following ``mcp-contract.md`` (read tools + hidden write tools), served at /api/backlog/mcp.

It records every HTTP request (JSON-RPC method + Authorization header) and every tool call, and answers
``get_item_context`` with a title derived from the caller's token (``Item for <email>``) so tests can prove that
concurrent users never see each other's data.

Control (plain HTTP, no auth):
  POST /_config   {"guidance": {...}, "delay": 0.1, "pinned": {...}, "fail": {"<tool>": {status, type, detail}},
                   "conflicts": ["<section id>"], "failedChildren": ["<proposal id>"]}
  POST /_reset    clears the logs and the configuration
  GET  /_calls    tool calls: [{"tool", "arguments", "authorization"}]
  GET  /_http_log HTTP requests: [{"rpc", "authorization"}]
"""

from __future__ import annotations

import asyncio
import base64
import json
from typing import Any

from mcp.server.mcpserver import Context, MCPServer
from mcp.types import CallToolResult, TextContent
from starlette.requests import Request
from starlette.responses import JSONResponse

mcp = MCPServer("fake-backlog")
CALLS: list[dict[str, Any]] = []
HTTP_LOG: list[dict[str, Any]] = []
CONFIG: dict[str, Any] = {}

ITEM_VERSION = 7


def _result(payload: dict[str, Any], *, is_error: bool = False) -> CallToolResult:
    return CallToolResult(
        content=[TextContent(type="text", text=json.dumps(payload))], structured_content=payload, is_error=is_error
    )


def _authorization(ctx: Context) -> str | None:
    return (ctx.headers or {}).get("authorization")


def email_of(authorization: str | None) -> str:
    """The ``email`` claim of a bearer JWT (unverified; test data only)."""
    token = (authorization or "").removeprefix("Bearer ").strip()
    try:
        payload = token.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    except (IndexError, ValueError):
        return "unknown"
    return str(claims.get("email", "unknown"))


async def _begin(tool: str, ctx: Context, arguments: dict[str, Any]) -> CallToolResult | None:
    authorization = _authorization(ctx)
    CALLS.append({"tool": tool, "arguments": arguments, "authorization": authorization})
    if CONFIG.get("delay"):
        await asyncio.sleep(float(CONFIG["delay"]))  # make concurrent calls overlap
    failure = (CONFIG.get("fail") or {}).get(tool)
    return _result(failure, is_error=True) if failure else None


def default_entry(content: str) -> dict[str, Any]:
    return {
        "content": content,
        "source": "default",
        "defaultVersion": "1.0.0",
        "baseSkillVersion": "1.0.0",
        "outdated": False,
    }


def default_guidance() -> dict[str, Any]:
    types = ("capability", "feature", "user-story", "enabler")
    return {
        "principles": default_entry("default principles"),
        "documentFormat": "default format",
        "typeInstructions": {t: default_entry(f"default {t} instructions") for t in types},
        "templates": {t: default_entry(f"## Summary\n\n({t})") for t in types},
        "skills": {"backlog-refinement": "1.0.0"},
    }


@mcp.tool()
async def get_item_context(projectId: str, itemId: str, ctx: Context) -> CallToolResult:
    """Item, parent, children, related items and template of one backlog item."""
    if (failed := await _begin("get_item_context", ctx, {"projectId": projectId, "itemId": itemId})) is not None:
        return failed
    email = email_of(_authorization(ctx))
    item = {
        "id": itemId,
        "type": "feature",
        "title": f"Item for {email}",
        "status": "draft",
        "version": ITEM_VERSION,
        "document": f"## Summary\n\nDocument of {email}.\n",
        "documentHash": "hash-1",
        "quality": None,
        "qualityAssessedAt": None,
        "qualityStale": False,
    }
    return _result(
        {
            "item": item,
            "parent": {"id": "p-1", "type": "capability", "title": "Parent capability", "status": "ready"},
            "children": [{"id": "c-1", "type": "user-story", "title": "Existing child", "status": "draft"}],
            "related": [
                {
                    "id": "r-1",
                    "type": "feature",
                    "title": "Related feature",
                    "status": "draft",
                    "relationship": "depends-on",
                    "direction": "outgoing",
                }
            ],
            "template": {"itemType": "feature", "markdown": "## Summary\n"},
            "childType": "user-story",
        }
    )


@mcp.tool()
async def get_project_guidance(projectId: str, ctx: Context, itemType: str | None = None) -> CallToolResult:
    """Effective guidance (defaults and project overrides)."""
    if (
        failed := await _begin("get_project_guidance", ctx, {"projectId": projectId, "itemType": itemType})
    ) is not None:
        return failed
    guidance = (CONFIG.get("guidance") or {}).get(projectId) or default_guidance()
    return _result(guidance)


@mcp.tool()
async def get_pinned_sources(projectId: str, ctx: Context) -> CallToolResult:
    """Sources pinned to the project's context within the budget."""
    if (failed := await _begin("get_pinned_sources", ctx, {"projectId": projectId})) is not None:
        return failed
    pinned = CONFIG.get("pinned") or {
        "budget": {"used": 21, "limit": 20000},
        "sources": [
            {
                "id": "s-1",
                "name": "Handbook",
                "kind": "text",
                "charCount": 21,
                "pageCount": 1,
                "text": "Pinned handbook text",
            }
        ],
    }
    return _result(pinned)


@mcp.tool()
async def search_sources(projectId: str, query: str, ctx: Context, limit: int | None = None) -> CallToolResult:
    """Search the project's sources."""
    arguments = {"projectId": projectId, "query": query, "limit": limit}
    if (failed := await _begin("search_sources", ctx, arguments)) is not None:
        return failed
    passage = {
        "citationId": "src-1:p1",
        "sourceId": "s-1",
        "sourceName": "Handbook",
        "page": 1,
        "headingPath": ["Intro"],
        "text": f"Passage about {query}",
        "score": 0.9,
    }
    return _result({"semantic": False, "passages": [passage]})


@mcp.tool()
async def find_similar_items(
    projectId: str, ctx: Context, itemId: str | None = None, text: str | None = None, limit: int | None = None
) -> CallToolResult:
    """Items similar to an item or a text."""
    arguments = {"projectId": projectId, "itemId": itemId, "text": text, "limit": limit}
    if (failed := await _begin("find_similar_items", ctx, arguments)) is not None:
        return failed
    return _result(
        {
            "semantic": False,
            "items": [{"id": "r-1", "title": "Related feature", "type": "feature", "status": "draft", "score": 0.5}],
        }
    )


@mcp.tool()
async def apply_document_changes(
    projectId: str,
    itemId: str,
    baseVersion: int,
    sections: list[dict[str, Any]],
    ctx: Context,
    suggestedTitle: str | None = None,
    suggestedStatus: str | None = None,
    runId: str | None = None,
) -> CallToolResult:
    """Apply accepted section changes (hidden write tool). ``CONFIG["conflicts"]`` lists section ids that conflict."""
    arguments = {
        "projectId": projectId,
        "itemId": itemId,
        "baseVersion": baseVersion,
        "sections": sections,
        "suggestedTitle": suggestedTitle,
        "suggestedStatus": suggestedStatus,
        "runId": runId,
    }
    if (failed := await _begin("apply_document_changes", ctx, arguments)) is not None:
        return failed
    conflicting = set(CONFIG.get("conflicts") or [])
    conflicted = [
        {
            "sectionId": s["id"],
            "heading": s["heading"],
            "reason": "changed-since-base-version",
            "currentMarkdown": "Changed by someone else.",
        }
        for s in sections
        if s["id"] in conflicting
    ]
    applied = [s["id"] for s in sections if s["id"] not in conflicting]
    return _result(
        {
            "applied": applied,
            "conflicted": conflicted,
            "newVersion": baseVersion + (1 if applied else 0),
            "warnings": [],
            "titleApplied": bool(suggestedTitle),
            "statusApplied": bool(suggestedStatus),
        }
    )


@mcp.tool()
async def create_child_items(
    projectId: str,
    parentId: str,
    childType: str,
    children: list[dict[str, Any]],
    ctx: Context,
    relationships: list[dict[str, Any]] | None = None,
    runId: str | None = None,
) -> CallToolResult:
    """Create child items (hidden write tool). ``CONFIG["failedChildren"]`` lists proposal ids that fail."""
    arguments = {
        "projectId": projectId,
        "parentId": parentId,
        "childType": childType,
        "children": children,
        "relationships": relationships,
        "runId": runId,
    }
    if (failed := await _begin("create_child_items", ctx, arguments)) is not None:
        return failed
    failing = set(CONFIG.get("failedChildren") or [])
    created = [
        {"proposalId": c["proposalId"], "itemId": f"new-{i}", "title": c["title"]}
        for i, c in enumerate(children)
        if c["proposalId"] not in failing
    ]
    return _result(
        {
            "created": created,
            "failed": [
                {"proposalId": p, "reason": "duplicate title"}
                for p in failing
                if p in {c["proposalId"] for c in children}
            ],
            "relationshipsCreated": len(relationships or []),
            "relationshipsSkipped": [],
        }
    )


@mcp.tool()
async def set_item_quality(
    projectId: str, itemId: str, quality: dict[str, Any], documentHash: str, ctx: Context
) -> CallToolResult:
    """Store the quality assessment (hidden write tool)."""
    arguments = {"projectId": projectId, "itemId": itemId, "quality": quality, "documentHash": documentHash}
    if (failed := await _begin("set_item_quality", ctx, arguments)) is not None:
        return failed
    return _result(
        {"itemId": itemId, "assessedAt": "2026-01-01T00:00:00Z", "documentHash": documentHash, "stale": False}
    )


@mcp.custom_route("/_config", methods=["POST"])
async def configure(request: Request) -> JSONResponse:
    CONFIG.update(await request.json())
    return JSONResponse({"ok": True})


@mcp.custom_route("/_reset", methods=["POST"])
async def reset(request: Request) -> JSONResponse:
    CALLS.clear()
    HTTP_LOG.clear()
    CONFIG.clear()
    return JSONResponse({"ok": True})


@mcp.custom_route("/_calls", methods=["GET"])
async def calls(request: Request) -> JSONResponse:
    return JSONResponse(CALLS)


@mcp.custom_route("/_http_log", methods=["GET"])
async def http_log(request: Request) -> JSONResponse:
    return JSONResponse(HTTP_LOG)


_inner = mcp.streamable_http_app(streamable_http_path="/api/backlog/mcp", stateless_http=True, json_response=True)


async def app(scope: Any, receive: Any, send: Any) -> None:
    """ASGI wrapper that logs the JSON-RPC method and the Authorization header of every MCP request."""
    if scope["type"] != "http" or not scope["path"].startswith("/api/backlog/mcp"):
        return await _inner(scope, receive, send)
    headers = {key.decode().lower(): value.decode() for key, value in scope["headers"]}
    chunks: list[bytes] = []
    more = True
    while more:
        message = await receive()
        chunks.append(message.get("body", b""))
        more = message.get("more_body", False)
    body = b"".join(chunks)
    try:
        rpc = json.loads(body).get("method") if body else None
    except ValueError:
        rpc = "?"
    HTTP_LOG.append({"rpc": rpc, "authorization": headers.get("authorization")})
    sent = False

    async def replay() -> Any:
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        return await receive()

    return await _inner(scope, replay, send)
