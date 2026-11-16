import base64
import json
import math
import struct
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from fake_gateway import ECHO_PREFIX, GatewaySettings, create_app, load_script, parse_script


def client(**overrides) -> TestClient:
    return TestClient(create_app(GatewaySettings(**overrides)))


def sse_events(text: str) -> list[dict | str]:
    events: list[dict | str] = []
    for line in text.splitlines():
        if line.startswith("data: "):
            payload = line.removeprefix("data: ")
            events.append(payload if payload == "[DONE]" else json.loads(payload))
    return events


def cosine(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b, strict=True))


def test_lists_models_with_and_without_v1_prefix() -> None:
    api = client(models=("reasoning-large", "text-embedding"))
    for path in ("/v1/models", "/models"):
        ids = [m["id"] for m in api.get(path).json()["data"]]
        assert ids == ["reasoning-large", "text-embedding"]


def test_embeddings_are_deterministic_normalised_and_similarity_preserving() -> None:
    api = client(embedding_dim=64)
    texts = ["refine the login story", "refine the login story", "login story refinement", "zebra quantum banana"]
    data = api.post("/v1/embeddings", json={"model": "text-embedding", "input": texts}).json()["data"]
    vectors = [item["embedding"] for item in data]

    assert [item["index"] for item in data] == [0, 1, 2, 3]
    assert all(len(v) == 64 for v in vectors)
    assert vectors[0] == vectors[1]
    assert math.isclose(math.sqrt(sum(x * x for x in vectors[0])), 1.0, rel_tol=1e-9)
    assert cosine(vectors[0], vectors[2]) > cosine(vectors[0], vectors[3])


def test_embeddings_support_dimensions_override_and_base64() -> None:
    api = client(embedding_dim=1536)
    body = {"input": "hello world", "dimensions": 8, "encoding_format": "base64"}
    encoded = api.post("/v1/embeddings", json=body).json()["data"][0]["embedding"]
    plain = api.post("/v1/embeddings", json={"input": "hello world", "dimensions": 8}).json()["data"][0]["embedding"]

    decoded = struct.unpack("<8f", base64.b64decode(encoded))
    assert decoded == pytest.approx(plain, rel=1e-6)


def test_chat_without_script_echoes_the_last_user_message() -> None:
    api = client()
    messages = [
        {"role": "system", "content": "You are helpful."},
        {"role": "user", "content": "first"},
        {"role": "assistant", "content": "ok"},
        {"role": "user", "content": [{"type": "text", "text": "Refine   this story"}]},
    ]
    body = api.post("/v1/chat/completions", json={"model": "reasoning-large", "messages": messages}).json()

    choice = body["choices"][0]
    assert body["object"] == "chat.completion"
    assert body["model"] == "reasoning-large"
    assert choice["message"] == {"role": "assistant", "content": f"{ECHO_PREFIX}Refine this story"}
    assert choice["finish_reason"] == "stop"
    assert body["usage"]["total_tokens"] > 0


def test_scripted_responses_are_served_in_order_and_cycle(tmp_path: Path) -> None:
    script = tmp_path / "script.json"
    script.write_text(
        json.dumps(
            [
                {"tool_calls": [{"id": "call_1", "name": "ask_user", "arguments": {"question": "Which persona?"}}]},
                {"content": "Here is the refined story."},
            ]
        ),
        encoding="utf-8",
    )
    api = client(script=load_script(script))
    request = {"model": "m", "messages": [{"role": "user", "content": "go"}]}

    first, second, third = (api.post("/v1/chat/completions", json=request).json()["choices"][0] for _ in range(3))

    assert first["finish_reason"] == "tool_calls"
    assert first["message"]["content"] is None
    call = first["message"]["tool_calls"][0]
    assert call["id"] == "call_1"
    assert call["function"]["name"] == "ask_user"
    assert json.loads(call["function"]["arguments"]) == {"question": "Which persona?"}
    assert second["message"]["content"] == "Here is the refined story."
    assert third["finish_reason"] == "tool_calls"

    assert api.post("/fake/reset").json() == {"responses": 2}
    assert api.post("/v1/chat/completions", json=request).json()["choices"][0]["finish_reason"] == "tool_calls"


def test_streaming_text_and_tool_calls_with_usage() -> None:
    script = (
        {"content": "A fairly long streamed answer that spans several chunks."},
        {"content": "Calling a tool.", "tool_calls": [{"name": "search", "arguments": {"q": "login"}}]},
    )
    api = client(script=parse_script(list(script)))
    request = {
        "model": "m",
        "messages": [{"role": "user", "content": "hi"}],
        "stream": True,
        "stream_options": {"include_usage": True},
    }

    with api.stream("POST", "/v1/chat/completions", json=request) as response:
        assert response.headers["content-type"].startswith("text/event-stream")
        events = sse_events(response.read().decode())
    assert events[-1] == "[DONE]"
    chunks = [e for e in events if isinstance(e, dict)]
    text = "".join(c["choices"][0]["delta"].get("content") or "" for c in chunks if c["choices"])
    assert text == script[0]["content"]
    assert [c["choices"][0]["finish_reason"] for c in chunks if c["choices"]][-1] == "stop"
    assert chunks[-1]["choices"] == [] and chunks[-1]["usage"]["total_tokens"] > 0

    with api.stream("POST", "/v1/chat/completions", json={**request, "stream_options": None}) as response:
        events = sse_events(response.read().decode())
    chunks = [e for e in events if isinstance(e, dict)]
    deltas = [c["choices"][0]["delta"] for c in chunks]
    calls = [tc for d in deltas for tc in d.get("tool_calls", [])]
    assert calls[0]["function"]["name"] == "search" and calls[0]["id"].startswith("call_")
    assert json.loads("".join(tc["function"]["arguments"] for tc in calls)) == {"q": "login"}
    assert chunks[-1]["choices"][0]["finish_reason"] == "tool_calls"
    assert "usage" not in chunks[-1]


def test_api_key_is_enforced_when_configured() -> None:
    api = client(api_key="secret")
    assert api.get("/v1/models").status_code == 401
    assert api.get("/v1/models", headers={"Authorization": "Bearer secret"}).status_code == 200
    assert api.get("/healthz").status_code == 200


def test_invalid_script_is_rejected(tmp_path: Path) -> None:
    script = tmp_path / "bad.json"
    script.write_text(json.dumps([{"finish_reason": "stop"}]), encoding="utf-8")
    with pytest.raises(ValueError, match="content"):
        load_script(script)
