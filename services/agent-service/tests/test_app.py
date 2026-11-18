from __future__ import annotations

import httpx
import pytest
from asgi_lifespan import LifespanManager

from agent_service.auth.tokens import StaticKeySource
from agent_service.main import create_app
from agent_service.settings import Settings
from agent_service_testkit import API, TokenFactory


@pytest.mark.parametrize("path", ["/healthz", "/readyz", f"{API}/healthz", f"{API}/readyz"])
async def test_health_endpoints(client: httpx.AsyncClient, path: str) -> None:
    assert (await client.get(path)).status_code == 200


async def test_request_id_is_propagated_or_generated(client: httpx.AsyncClient) -> None:
    assert (await client.get("/healthz", headers={"X-Request-ID": "abc-123"})).headers["x-request-id"] == "abc-123"
    generated = await client.get("/healthz", headers={"X-Request-ID": "bad id with spaces"})
    assert generated.headers["x-request-id"] not in ("", "bad id with spaces")


async def test_unknown_route_and_validation_are_problem_json(client: httpx.AsyncClient, tokens: TokenFactory) -> None:
    missing = await client.get(f"{API}/does-not-exist")
    assert missing.status_code == 404
    assert missing.headers["content-type"].startswith("application/problem+json")
    invalid = await client.post(f"{API}/threads", json={}, headers=tokens.headers())
    assert invalid.status_code == 422
    assert invalid.json()["type"] == "/problems/validation-error"


async def test_default_body_limit(client: httpx.AsyncClient, tokens: TokenFactory) -> None:
    payload = b'{"title": "' + b"x" * (70 * 1024) + b'"}'
    response = await client.post(
        f"{API}/threads", content=payload, headers={**tokens.headers(), "Content-Type": "application/json"}
    )
    assert response.status_code == 413


async def test_no_cors_by_default_and_allow_list(settings: Settings, tokens: TokenFactory) -> None:
    for origins, expected in (([], None), (["http://localhost:5173"], "http://localhost:5173")):
        app = create_app(
            settings.model_copy(update={"cors_allow_origins": origins}),
            key_source=__import__("agent_service.auth.tokens", fromlist=["StaticKeySource"]).StaticKeySource(
                tokens.jwks
            ),
            configure_logs=False,
        )
        async with LifespanManager(app, startup_timeout=30):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as client:
                response = await client.get("/healthz", headers={"Origin": "http://localhost:5173"})
                assert response.headers.get("access-control-allow-origin") == expected


async def test_readyz_reports_unavailable_database(settings: Settings, tokens: TokenFactory) -> None:
    broken = settings.model_copy(update={"database_url": "postgresql://u:p@127.0.0.1:1/agentdb"})
    app = create_app(broken, key_source=StaticKeySource(tokens.jwks), configure_logs=False)
    async with LifespanManager(app, startup_timeout=30):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as client:
            response = await client.get("/readyz")
            assert response.status_code == 503
            assert response.headers["retry-after"]
