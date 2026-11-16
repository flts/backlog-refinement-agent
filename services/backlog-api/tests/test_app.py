from __future__ import annotations

import httpx
import pytest
from asgi_lifespan import LifespanManager

from backlog_api.main import create_app
from backlog_api.settings import Settings
from backlog_api_testkit import API, TokenFactory


@pytest.mark.parametrize("path", ["/healthz", "/readyz", f"{API}/healthz", f"{API}/readyz"])
async def test_health_endpoints(client: httpx.AsyncClient, path: str) -> None:
    response = await client.get(path)
    assert response.status_code == 200


async def test_request_id_is_propagated_or_generated(client: httpx.AsyncClient) -> None:
    response = await client.get("/healthz", headers={"X-Request-ID": "abc-123"})
    assert response.headers["x-request-id"] == "abc-123"
    generated = await client.get("/healthz", headers={"X-Request-ID": "bad id with spaces"})
    assert generated.headers["x-request-id"] not in ("", "bad id with spaces")


async def test_unknown_route_is_problem_json(client: httpx.AsyncClient) -> None:
    response = await client.get(f"{API}/does-not-exist")
    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["status"] == 404


async def test_validation_error_is_problem_json(client: httpx.AsyncClient, tokens: TokenFactory) -> None:
    response = await client.post(f"{API}/projects", json={"name": ""}, headers=tokens.headers())
    assert response.status_code == 422
    body = response.json()
    assert body["type"] == "/problems/validation-error"
    assert body["errors"]


async def test_body_size_limit(client: httpx.AsyncClient, tokens: TokenFactory) -> None:
    payload = b'{"name": "' + b"x" * (70 * 1024) + b'"}'
    response = await client.post(
        f"{API}/projects", content=payload, headers={**tokens.headers(), "Content-Type": "application/json"}
    )
    assert response.status_code == 413
    assert response.json()["type"] == "/problems/payload-too-large"


async def test_streamed_body_size_limit(client: httpx.AsyncClient, tokens: TokenFactory) -> None:
    async def chunks():  # no Content-Length: the limit is enforced while reading
        for _ in range(80):
            yield b"x" * 1024

    response = await client.post(
        f"{API}/projects", content=chunks(), headers={**tokens.headers(), "Content-Type": "application/json"}
    )
    assert response.status_code == 413


async def test_readyz_reports_unavailable_database(settings: Settings, tokens: TokenFactory) -> None:
    broken = settings.model_copy(update={"database_url": "postgresql://nobody:x@127.0.0.1:1/none"})
    application = create_app(broken, configure_logs=False)
    async with LifespanManager(application):
        transport = httpx.ASGITransport(app=application)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/readyz")
    assert response.status_code == 503
    assert response.json()["type"] == "/problems/not-ready"


async def test_dev_auth_mode_trusts_header_in_development(settings: Settings) -> None:
    dev = settings.model_copy(update={"env": "development", "auth_mode": "dev", "auto_migrate": False})
    application = create_app(dev, configure_logs=False)
    async with LifespanManager(application):
        transport = httpx.ASGITransport(app=application)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(f"{API}/me", headers={"X-Dev-User-Email": " Bob@Example.test "})
            missing = await client.get(f"{API}/me")
    assert response.status_code == 200
    assert response.json()["email"] == "bob@example.test"
    assert missing.status_code == 401


async def test_dev_auth_mode_refuses_to_start_outside_development(settings: Settings) -> None:
    # model_copy skips validation, so this exercises the guard in the app factory's lifespan.
    unsafe = settings.model_copy(update={"env": "production", "auth_mode": "dev"})
    application = create_app(unsafe, configure_logs=False)
    with pytest.raises(RuntimeError, match="only allowed"):
        async with LifespanManager(application):
            pass


def test_openapi_lists_routes_under_prefix(settings: Settings) -> None:
    schema = create_app(settings, configure_logs=False).openapi()
    paths = set(schema["paths"])
    assert f"{API}/projects" in paths
    assert f"{API}/projects/{{project_id}}/members/{{email}}" in paths
    assert all(path.startswith(API) for path in paths)
    assert "Problem" in schema["components"]["schemas"]
