"""Scripted, deterministic OpenAI-compatible LLM gateway for local development and end-to-end tests.

Endpoints (served with and without the ``/v1`` prefix, so clients may include it in the base URL or not):

* ``GET /v1/models`` lists ``FAKE_GATEWAY_MODELS`` (comma separated).
* ``POST /v1/embeddings`` returns deterministic feature-hashing vectors (L2-normalised, ``FAKE_EMBEDDING_DIM``
  dimensions, overridable per request with ``dimensions``); texts that share words get similar vectors.
  ``encoding_format: "base64"`` (the OpenAI SDK default) is supported.
* ``POST /v1/chat/completions`` answers non-streaming and SSE streaming requests. Without a script it echoes the last
  user message. With ``FAKE_GATEWAY_SCRIPT`` (path to a JSON file) it replays the scripted responses in order,
  cycling when the end is reached.
* ``POST /fake/reset`` rewinds the script to the first response (test helper).
* ``FAKE_GATEWAY_CONTROL=true`` enables runtime scripting for end-to-end tests: ``POST /fake/script`` registers a
  script ``{"responses": [...], "match"?: "marker"}``. A script with ``match`` is served to requests whose message
  text contains the marker (so parallel tests with unique markers stay independent; registering the same marker again
  replaces it and rewinds its cursor). A script without ``match`` replaces the global script. Keyed scripts win over
  the global script; a keyed script that is exhausted falls back to the echo reply instead of cycling.
  ``DELETE /fake/script`` removes all runtime scripts and ``POST /fake/reset`` also rewinds them.
* ``GET /healthz`` is the liveness probe.

Script format: a JSON list (or ``{"responses": [...]}``) of objects with ``content`` (string) and/or ``tool_calls``
(list of ``{"name": str, "arguments": object | str, "id"?: str}``) and an optional ``finish_reason``.

``FAKE_GATEWAY_API_KEY``: when set, requests must send ``Authorization: Bearer <key>``.
"""

from __future__ import annotations

import base64
import hashlib
import json
import math
import os
import re
import struct
import threading
import time
import uuid
from collections.abc import Iterator, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

DEFAULT_MODELS = ("reasoning-large", "text-embedding")
DEFAULT_EMBEDDING_DIM = 1536
ECHO_PREFIX = "Fake gateway reply: "
ECHO_MAX_CHARS = 200
_TOKEN = re.compile(r"\w+", re.UNICODE)


@dataclass(frozen=True)
class ScriptedToolCall:
    name: str
    arguments: str
    id: str | None = None


@dataclass(frozen=True)
class ScriptedResponse:
    content: str | None = None
    tool_calls: tuple[ScriptedToolCall, ...] = ()
    finish_reason: str | None = None


@dataclass
class GatewaySettings:
    models: tuple[str, ...] = DEFAULT_MODELS
    embedding_dim: int = DEFAULT_EMBEDDING_DIM
    api_key: str | None = None
    script: tuple[ScriptedResponse, ...] = ()
    control: bool = False

    @classmethod
    def from_env(cls) -> GatewaySettings:
        models = tuple(m.strip() for m in os.environ.get("FAKE_GATEWAY_MODELS", "").split(",") if m.strip())
        script_path = os.environ.get("FAKE_GATEWAY_SCRIPT", "").strip()
        return cls(
            models=models or DEFAULT_MODELS,
            embedding_dim=_positive_int(os.environ.get("FAKE_EMBEDDING_DIM"), DEFAULT_EMBEDDING_DIM),
            api_key=os.environ.get("FAKE_GATEWAY_API_KEY", "").strip() or None,
            script=load_script(Path(script_path)) if script_path else (),
            control=os.environ.get("FAKE_GATEWAY_CONTROL", "").strip().lower() in ("1", "true", "yes"),
        )


@dataclass
class ScriptCursor:
    responses: tuple[ScriptedResponse, ...]
    _position: int = 0
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def next(self) -> ScriptedResponse | None:
        if not self.responses:
            return None
        with self._lock:
            response = self.responses[self._position % len(self.responses)]
            self._position += 1
            return response

    def next_once(self) -> ScriptedResponse | None:
        """Like :meth:`next`, but returns ``None`` once the script is exhausted instead of cycling."""
        with self._lock:
            if self._position >= len(self.responses):
                return None
            response = self.responses[self._position]
            self._position += 1
            return response

    def reset(self) -> None:
        with self._lock:
            self._position = 0


def _request_text(messages: Sequence[dict[str, Any]]) -> str:
    return "\n".join(_message_text(message.get("content")) for message in messages)


def _positive_int(raw: str | None, default: int) -> int:
    if raw is None or not raw.strip():
        return default
    value = int(raw)
    if value <= 0:
        raise ValueError(f"Expected a positive integer, got {raw!r}.")
    return value


def load_script(path: Path) -> tuple[ScriptedResponse, ...]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return parse_script(data)


def parse_script(data: Any) -> tuple[ScriptedResponse, ...]:
    items = data.get("responses") if isinstance(data, dict) else data
    if not isinstance(items, list) or not items:
        raise ValueError("A fake gateway script must be a non-empty list of responses (or {'responses': [...]}).")
    responses: list[ScriptedResponse] = []
    for index, item in enumerate(items):
        if isinstance(item, str):
            item = {"content": item}
        if not isinstance(item, dict):
            raise ValueError(f"Script response {index} must be an object or a string.")
        content = item.get("content")
        if content is not None and not isinstance(content, str):
            raise ValueError(f"Script response {index}: 'content' must be a string.")
        tool_calls: list[ScriptedToolCall] = []
        for call in item.get("tool_calls") or []:
            if not isinstance(call, dict) or not isinstance(call.get("name"), str):
                raise ValueError(f"Script response {index}: every tool call needs a 'name'.")
            arguments = call.get("arguments", {})
            tool_calls.append(
                ScriptedToolCall(
                    name=call["name"],
                    arguments=arguments if isinstance(arguments, str) else json.dumps(arguments),
                    id=call.get("id"),
                )
            )
        if content is None and not tool_calls:
            raise ValueError(f"Script response {index} needs 'content' and/or 'tool_calls'.")
        responses.append(ScriptedResponse(content, tuple(tool_calls), item.get("finish_reason")))
    return tuple(responses)


def embed(text: str, dim: int) -> list[float]:
    """Deterministic, L2-normalised feature-hashing embedding: shared words give a higher cosine similarity."""
    vector = [0.0] * dim
    for token in _TOKEN.findall(text.lower()):
        digest = hashlib.sha256(token.encode("utf-8")).digest()
        for offset in (0, 8):
            slot = int.from_bytes(digest[offset : offset + 4], "big") % dim
            sign = 1.0 if digest[offset + 4] & 1 else -1.0
            vector[slot] += sign
    if not any(vector):
        # No word tokens (empty or punctuation-only input): fall back to a hash of the raw text.
        seed = text.encode("utf-8")
        for slot in range(dim):
            digest = hashlib.sha256(seed + slot.to_bytes(4, "big")).digest()
            vector[slot] = int.from_bytes(digest[:4], "big") / 0xFFFFFFFF * 2 - 1
    norm = math.sqrt(sum(value * value for value in vector))
    return [value / norm for value in vector]


def _count_tokens(text: str) -> int:
    return len(_TOKEN.findall(text))


def _message_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(part.get("text", "") for part in content if isinstance(part, dict))
    return ""


def _echo(messages: Sequence[dict[str, Any]]) -> ScriptedResponse:
    for message in reversed(messages):
        if message.get("role") == "user":
            text = " ".join(_message_text(message.get("content")).split())
            if len(text) > ECHO_MAX_CHARS:
                text = text[: ECHO_MAX_CHARS - 1] + "…"
            return ScriptedResponse(content=ECHO_PREFIX + (text or "(empty message)"))
    return ScriptedResponse(content=ECHO_PREFIX + "(no user message)")


def _usage(messages: Sequence[dict[str, Any]], response: ScriptedResponse) -> dict[str, int]:
    prompt = sum(_count_tokens(_message_text(m.get("content"))) for m in messages)
    completion = _count_tokens(response.content or "") + sum(
        _count_tokens(c.arguments) + 1 for c in response.tool_calls
    )
    return {"prompt_tokens": prompt, "completion_tokens": completion, "total_tokens": prompt + completion}


def _tool_call_ids(response: ScriptedResponse) -> list[str]:
    return [call.id or f"call_{uuid.uuid4().hex[:24]}" for call in response.tool_calls]


def _finish_reason(response: ScriptedResponse) -> str:
    return response.finish_reason or ("tool_calls" if response.tool_calls else "stop")


def _completion(model: str, messages: Sequence[dict[str, Any]], response: ScriptedResponse) -> dict[str, Any]:
    message: dict[str, Any] = {"role": "assistant", "content": response.content}
    if response.tool_calls:
        message["tool_calls"] = [
            {"id": call_id, "type": "function", "function": {"name": call.name, "arguments": call.arguments}}
            for call_id, call in zip(_tool_call_ids(response), response.tool_calls, strict=True)
        ]
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "message": message, "finish_reason": _finish_reason(response), "logprobs": None}],
        "usage": _usage(messages, response),
    }


def _chunks(text: str, size: int = 16) -> Iterator[str]:
    for start in range(0, len(text), size):
        yield text[start : start + size]


def _stream(
    model: str, messages: Sequence[dict[str, Any]], response: ScriptedResponse, include_usage: bool
) -> Iterator[str]:
    completion_id = f"chatcmpl-{uuid.uuid4().hex}"
    created = int(time.time())

    def event(delta: dict[str, Any], finish_reason: str | None = None) -> str:
        chunk = {
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason, "logprobs": None}],
        }
        return f"data: {json.dumps(chunk)}\n\n"

    yield event({"role": "assistant", "content": ""})
    for piece in _chunks(response.content or ""):
        yield event({"content": piece})
    for index, (call_id, call) in enumerate(zip(_tool_call_ids(response), response.tool_calls, strict=True)):
        yield event(
            {
                "tool_calls": [
                    {
                        "index": index,
                        "id": call_id,
                        "type": "function",
                        "function": {"name": call.name, "arguments": ""},
                    }
                ]
            }
        )
        for piece in _chunks(call.arguments):
            yield event({"tool_calls": [{"index": index, "function": {"arguments": piece}}]})
    yield event({}, _finish_reason(response))
    if include_usage:
        usage_chunk = {
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [],
            "usage": _usage(messages, response),
        }
        yield f"data: {json.dumps(usage_chunk)}\n\n"
    yield "data: [DONE]\n\n"


def _error(status: int, message: str, error_type: str = "invalid_request_error") -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"message": message, "type": error_type}})


def create_app(settings: GatewaySettings | None = None) -> FastAPI:
    settings = settings or GatewaySettings.from_env()
    cursor = ScriptCursor(settings.script)
    keyed: dict[str, ScriptCursor] = {}
    keyed_lock = threading.Lock()

    def next_response(messages: Sequence[dict[str, Any]]) -> ScriptedResponse:
        if keyed:
            text = _request_text(messages)
            with keyed_lock:
                candidates = [cursor_ for marker, cursor_ in keyed.items() if marker in text]
            for candidate in candidates:
                response = candidate.next_once()
                if response is not None:
                    return response
            if candidates:
                return _echo(messages)
        return cursor.next() or _echo(messages)

    async def authorize(request: Request) -> None:
        if settings.api_key is None:
            return
        if request.headers.get("authorization", "") != f"Bearer {settings.api_key}":
            raise HTTPException(status_code=401, detail="Invalid or missing API key.")

    app = FastAPI(title="fake-gateway", docs_url=None, redoc_url=None)
    api = APIRouter(dependencies=[Depends(authorize)])

    @app.exception_handler(HTTPException)
    async def _http_error(_request: Request, exc: HTTPException) -> JSONResponse:
        return _error(exc.status_code, str(exc.detail), "authentication_error" if exc.status_code == 401 else "error")

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/fake/reset")
    async def reset() -> dict[str, int]:
        cursor.reset()
        with keyed_lock:
            for candidate in keyed.values():
                candidate.reset()
        return {"responses": len(settings.script)}

    if settings.control:

        @app.post("/fake/script")
        async def set_script(request: Request) -> dict[str, Any]:
            nonlocal cursor
            body = await request.json()
            try:
                responses = parse_script(body)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            marker = body.get("match") if isinstance(body, dict) else None
            if marker is None:
                cursor = ScriptCursor(responses)
            elif isinstance(marker, str) and marker:
                with keyed_lock:
                    keyed[marker] = ScriptCursor(responses)
            else:
                raise HTTPException(status_code=400, detail="'match' must be a non-empty string.")
            return {"responses": len(responses), "match": marker}

        @app.delete("/fake/script")
        async def clear_scripts() -> dict[str, int]:
            nonlocal cursor
            cursor = ScriptCursor(settings.script)
            with keyed_lock:
                keyed.clear()
            return {"responses": len(settings.script)}

    @api.get("/models")
    async def list_models() -> dict[str, Any]:
        return {
            "object": "list",
            "data": [{"id": m, "object": "model", "created": 0, "owned_by": "fake-gateway"} for m in settings.models],
        }

    @api.post("/embeddings")
    async def embeddings(request: Request) -> JSONResponse:
        body = await request.json()
        raw_input = body.get("input")
        if isinstance(raw_input, str):
            inputs = [raw_input]
        elif isinstance(raw_input, list) and raw_input and all(isinstance(i, int) for i in raw_input):
            inputs = [" ".join(map(str, raw_input))]
        elif isinstance(raw_input, list) and raw_input:
            inputs = [i if isinstance(i, str) else " ".join(map(str, i)) for i in raw_input]
        else:
            return _error(400, "'input' must be a non-empty string or list.")
        dim = body.get("dimensions") or settings.embedding_dim
        if not isinstance(dim, int) or dim <= 0:
            return _error(400, "'dimensions' must be a positive integer.")
        as_base64 = body.get("encoding_format") == "base64"
        data = []
        for index, text in enumerate(inputs):
            vector = embed(text, dim)
            encoded: Any = base64.b64encode(struct.pack(f"<{dim}f", *vector)).decode("ascii") if as_base64 else vector
            data.append({"object": "embedding", "index": index, "embedding": encoded})
        tokens = sum(_count_tokens(text) for text in inputs)
        return JSONResponse(
            {
                "object": "list",
                "data": data,
                "model": body.get("model") or settings.models[-1],
                "usage": {"prompt_tokens": tokens, "total_tokens": tokens},
            }
        )

    @api.post("/chat/completions", response_model=None)
    async def chat_completions(request: Request) -> JSONResponse | StreamingResponse:
        body = await request.json()
        messages = body.get("messages")
        if not isinstance(messages, list) or not messages:
            return _error(400, "'messages' must be a non-empty list.")
        model = body.get("model") or settings.models[0]
        response = next_response(messages)
        if body.get("stream"):
            include_usage = bool((body.get("stream_options") or {}).get("include_usage"))
            return StreamingResponse(
                _stream(model, messages, response, include_usage),
                media_type="text/event-stream",
                headers={"Cache-Control": "no-cache"},
            )
        return JSONResponse(_completion(model, messages, response))

    app.include_router(api, prefix="/v1")
    app.include_router(api)
    return app


app = create_app()
