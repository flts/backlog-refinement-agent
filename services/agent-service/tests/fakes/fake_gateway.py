"""Scripted fake OpenAI-compatible gateway.

Endpoints:
  POST /v1/chat/completions   streaming (SSE) and non-streaming, incl. streamed tool_calls
  POST /v1/responses          minimal non-streaming/streaming text-only (to probe Responses client)
  GET  /v1/models
  POST /v1/embeddings
Control:
  POST /_script   body: {"responses": [<turn>, ...]}   (appends to queue)
  POST /_reset    clears queue + request log
  GET  /_requests returns the received chat-completion request bodies

A <turn> is {"text": "...", "tool_calls": [{"id": "...", "name": "...", "arguments": {...}|"..."}],
             "chunk_size": 12}
If the queue is empty, the gateway answers with a plain text "(fake) ok".
"""

from __future__ import annotations

import json
import time
import uuid
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

app = FastAPI()
QUEUE: list[dict[str, Any]] = []
REQUESTS: list[dict[str, Any]] = []
# Fallback rules used when QUEUE is empty: first rule whose "last_role" matches the last request message wins.
RULES: list[dict[str, Any]] = []


@app.post("/_script")
async def script(body: dict[str, Any]) -> dict[str, Any]:
    QUEUE.extend(body.get("responses", []))
    if "rules" in body:
        RULES[:] = body["rules"]
    return {"queued": len(QUEUE)}


@app.post("/_reset")
async def reset() -> dict[str, Any]:
    QUEUE.clear()
    REQUESTS.clear()
    RULES.clear()
    return {"ok": True}


@app.get("/_requests")
async def requests_log() -> list[dict[str, Any]]:
    return REQUESTS


@app.get("/v1/models")
async def models() -> dict[str, Any]:
    return {
        "object": "list",
        "data": [
            {"id": "refiner-default", "object": "model", "created": 0, "owned_by": "fake"},
            {"id": "embed-default", "object": "model", "created": 0, "owned_by": "fake"},
        ],
    }


@app.post("/v1/embeddings")
async def embeddings(body: dict[str, Any]) -> dict[str, Any]:
    inputs = body.get("input")
    if isinstance(inputs, str):
        inputs = [inputs]
    dim = int(body.get("dimensions") or 8)
    data = []
    for i, text in enumerate(inputs or []):
        seed = sum(ord(c) for c in str(text))
        data.append(
            {"object": "embedding", "index": i, "embedding": [((seed * (k + 1)) % 97) / 97 for k in range(dim)]}
        )
    return {
        "object": "list",
        "data": data,
        "model": body.get("model"),
        "usage": {"prompt_tokens": 1, "total_tokens": 1},
    }


def _next_turn(body: dict[str, Any] | None = None) -> dict[str, Any]:
    if QUEUE:
        return QUEUE.pop(0)
    msgs = (body or {}).get("messages") or []
    last_role = msgs[-1].get("role") if msgs else None
    for rule in RULES:
        if rule.get("last_role") in (None, last_role):
            return rule["turn"]
    return {"text": "(fake) ok"}


def _norm_tool_calls(turn: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for tc in turn.get("tool_calls", []) or []:
        args = tc.get("arguments", {})
        out.append(
            {
                "id": tc.get("id") or f"call_{uuid.uuid4().hex[:8]}",
                "name": tc["name"],
                "arguments": args if isinstance(args, str) else json.dumps(args),
            }
        )
    return out


@app.post("/v1/chat/completions")
async def chat(request: Request):
    body = await request.json()
    REQUESTS.append({"headers": {"authorization": request.headers.get("authorization")}, "body": body})
    turn = _next_turn(body)
    model = body.get("model", "fake")
    tool_calls = _norm_tool_calls(turn)
    text = turn.get("text")
    cid = f"chatcmpl-{uuid.uuid4().hex[:10]}"
    created = int(time.time())

    if not body.get("stream"):
        message: dict[str, Any] = {"role": "assistant", "content": text}
        if tool_calls:
            message["tool_calls"] = [
                {"id": t["id"], "type": "function", "function": {"name": t["name"], "arguments": t["arguments"]}}
                for t in tool_calls
            ]
        return JSONResponse(
            {
                "id": cid,
                "object": "chat.completion",
                "created": created,
                "model": model,
                "choices": [{"index": 0, "message": message, "finish_reason": "tool_calls" if tool_calls else "stop"}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20},
            }
        )

    chunk_size = int(turn.get("chunk_size", 16))

    def chunk(delta: dict[str, Any], finish: str | None = None) -> str:
        payload = {
            "id": cid,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
        }
        return f"data: {json.dumps(payload)}\n\n"

    async def gen():
        if turn.get("delay"):
            import asyncio

            await asyncio.sleep(float(turn["delay"]))
        yield chunk({"role": "assistant", "content": ""})
        if text:
            for i in range(0, len(text), chunk_size):
                yield chunk({"content": text[i : i + chunk_size]})
        for idx, t in enumerate(tool_calls):
            yield chunk(
                {
                    "tool_calls": [
                        {
                            "index": idx,
                            "id": t["id"],
                            "type": "function",
                            "function": {"name": t["name"], "arguments": ""},
                        }
                    ]
                }
            )
            args = t["arguments"]
            for i in range(0, len(args), chunk_size):
                yield chunk({"tool_calls": [{"index": idx, "function": {"arguments": args[i : i + chunk_size]}}]})
        yield chunk({}, "tool_calls" if tool_calls else "stop")
        usage = {
            "id": cid,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [],
            "usage": {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20},
        }
        yield f"data: {json.dumps(usage)}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.post("/v1/responses")
async def responses(request: Request):
    """Minimal Responses API (text only) to check the Responses client can talk to a gateway."""
    body = await request.json()
    REQUESTS.append(
        {"headers": {"authorization": request.headers.get("authorization")}, "body": body, "api": "responses"}
    )
    turn = _next_turn()
    text = turn.get("text") or "(fake responses) ok"
    rid = f"resp_{uuid.uuid4().hex[:10]}"
    mid = f"msg_{uuid.uuid4().hex[:10]}"
    created = int(time.time())
    final = {
        "id": rid,
        "object": "response",
        "created_at": created,
        "status": "completed",
        "model": body.get("model"),
        "output": [
            {
                "type": "message",
                "id": mid,
                "status": "completed",
                "role": "assistant",
                "content": [{"type": "output_text", "text": text, "annotations": []}],
            }
        ],
        "parallel_tool_calls": True,
        "tool_choice": "auto",
        "tools": [],
        "usage": {
            "input_tokens": 1,
            "output_tokens": 1,
            "total_tokens": 2,
            "input_tokens_details": {"cached_tokens": 0},
            "output_tokens_details": {"reasoning_tokens": 0},
        },
    }
    if not body.get("stream"):
        return JSONResponse(final)

    async def gen():
        seq = 0

        def ev(kind: str, data: dict[str, Any]) -> str:
            nonlocal seq
            seq += 1
            data = {"type": kind, "sequence_number": seq, **data}
            return f"event: {kind}\ndata: {json.dumps(data)}\n\n"

        inprog = {**final, "status": "in_progress", "output": []}
        yield ev("response.created", {"response": inprog})
        item = {"type": "message", "id": mid, "status": "in_progress", "role": "assistant", "content": []}
        yield ev("response.output_item.added", {"output_index": 0, "item": item})
        yield ev(
            "response.content_part.added",
            {
                "item_id": mid,
                "output_index": 0,
                "content_index": 0,
                "part": {"type": "output_text", "text": "", "annotations": []},
            },
        )
        yield ev(
            "response.output_text.delta",
            {"item_id": mid, "output_index": 0, "content_index": 0, "delta": text, "logprobs": []},
        )
        yield ev(
            "response.output_text.done",
            {"item_id": mid, "output_index": 0, "content_index": 0, "text": text, "logprobs": []},
        )
        yield ev("response.output_item.done", {"output_index": 0, "item": final["output"][0]})
        yield ev("response.completed", {"response": final})

    return StreamingResponse(gen(), media_type="text/event-stream")
