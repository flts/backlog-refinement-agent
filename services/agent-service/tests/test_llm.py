from __future__ import annotations

from typing import Any, cast

import httpx
import pytest
from agent_framework.openai import OpenAIChatClient, OpenAIChatCompletionClient
from asgi_lifespan import LifespanManager

from agent_service.auth.tokens import StaticKeySource
from agent_service.llm import LlmReadiness, create_chat_client, normalize_base_url
from agent_service.main import create_app
from agent_service.settings import Settings
from agent_service_testkit import TEST_AUDIENCE, TEST_ISSUER, TokenFactory
from conftest import BACKLOG_URL


def make_settings(database_url: str, **overrides: object) -> Settings:
    values: dict[str, object] = {
        "env": "test",
        "database_url": database_url,
        "auto_migrate": False,
        "oidc_issuer": TEST_ISSUER,
        "oidc_audience": TEST_AUDIENCE,
        "backlog_api_url": BACKLOG_URL,
        "llm_base_url": "http://gateway.test",
        "llm_ready_cache_seconds": 0,
    }
    values.update(overrides)
    return Settings(_env_file=None, **values)  # type: ignore[call-arg, arg-type]  # pyright: ignore[reportCallIssue]


@pytest.mark.parametrize(
    ("base", "expected"),
    [
        ("http://gw", "http://gw/v1"),
        ("http://gw/", "http://gw/v1"),
        ("https://gw/v1", "https://gw/v1"),
        ("https://gw/v1/", "https://gw/v1"),
        ("https://gw/openai", "https://gw/openai/v1"),
    ],
)
def test_normalize_base_url(base: str, expected: str) -> None:
    assert normalize_base_url(base) == expected


def test_client_factory_selects_the_wire_api(database_url: str) -> None:
    chat = create_chat_client(make_settings(database_url, llm_api_key="secret"))
    assert isinstance(chat, OpenAIChatCompletionClient)
    assert cast(Any, chat).model == "refiner-default"
    responses = create_chat_client(make_settings(database_url, llm_api="responses", llm_model="other"))
    assert isinstance(responses, OpenAIChatClient)
    assert cast(Any, create_chat_client(make_settings(database_url), model="override")).model == "override"


def test_api_key_is_not_in_repr(database_url: str) -> None:
    assert "secret" not in repr(make_settings(database_url, llm_api_key="secret"))


async def test_readiness_probe_requests_v1_models_with_the_key(database_url: str) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"data": []})

    readiness = LlmReadiness(make_settings(database_url, llm_api_key="k1"), transport=httpx.MockTransport(handler))
    assert await readiness.check() == "ok"
    assert str(seen[0].url) == "http://gateway.test/v1/models"
    assert seen[0].headers["authorization"] == "Bearer k1"


async def test_readiness_unavailable_and_cached(database_url: str) -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        raise httpx.ConnectError("down")

    readiness = LlmReadiness(
        make_settings(database_url, llm_ready_cache_seconds=60), transport=httpx.MockTransport(handler)
    )
    assert await readiness.check() == "unavailable"
    assert await readiness.check() == "unavailable"
    assert calls == 1
    error = LlmReadiness(make_settings(database_url), transport=httpx.MockTransport(lambda r: httpx.Response(401)))
    assert await error.check() == "unavailable"


@pytest.mark.parametrize(("required", "status"), [(False, 200), (True, 503)])
async def test_readyz_reports_llm(database_url: str, tokens: TokenFactory, required: bool, status: int) -> None:
    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down")

    app = create_app(
        make_settings(database_url, llm_required_for_readiness=required),
        key_source=StaticKeySource(tokens.jwks),
        llm_transport=httpx.MockTransport(down),
        configure_logs=False,
    )
    async with LifespanManager(app, startup_timeout=30):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as client:
            response = await client.get("/readyz")
            assert response.status_code == status
            if not required:
                assert response.json() == {"status": "ready", "llm": "unavailable", "hooks": "disabled"}
            assert (await client.get("/healthz")).status_code == 200


async def test_readyz_llm_ok(client: httpx.AsyncClient) -> None:
    response = await client.get("/readyz")
    assert response.json() == {"status": "ready", "llm": "ok", "hooks": "disabled"}
    assert (await client.get("/api/agent/readyz")).status_code == 200
