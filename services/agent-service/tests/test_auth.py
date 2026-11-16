from __future__ import annotations

import httpx
import pytest

from agent_service_testkit import API, ITEM_ID, PROJECT_ID, TokenFactory


@pytest.mark.parametrize(
    ("options", "status", "expected_type"),
    [
        ({}, 200, None),
        ({"email_verified": False}, 403, "/problems/email-not-verified"),
        ({"email_verified": "true"}, 403, "/problems/email-not-verified"),
        ({"email": None}, 403, "/problems/email-required"),
        ({"audience": "backlog-api"}, 401, "/problems/unauthorized"),
        ({"expires_in": -600}, 401, "/problems/unauthorized"),
        ({"issuer": "https://evil.test/realms/backlog"}, 401, "/problems/unauthorized"),
    ],
)
async def test_jwt_matrix(
    client: httpx.AsyncClient, tokens: TokenFactory, options: dict[str, object], status: int, expected_type: str | None
) -> None:
    response = await client.get(f"{API}/threads", headers=tokens.headers(**options))  # type: ignore[arg-type]
    assert response.status_code == status, response.text
    if expected_type:
        assert response.json()["type"] == expected_type
    if status == 401:
        assert response.headers["www-authenticate"].startswith("Bearer")


async def test_missing_token_and_bad_signature(client: httpx.AsyncClient, tokens: TokenFactory) -> None:
    missing = await client.get(f"{API}/threads")
    assert missing.status_code == 401
    assert missing.headers["www-authenticate"].startswith("Bearer")
    forged = tokens.issue(signing_key=tokens.untrusted_rsa_key)
    response = await client.get(f"{API}/threads", headers={"Authorization": f"Bearer {forged}"})
    assert response.status_code == 401


async def test_email_is_normalized(client: httpx.AsyncClient, tokens: TokenFactory) -> None:
    created = await client.post(
        f"{API}/threads",
        json={"projectId": PROJECT_ID, "itemId": ITEM_ID},
        headers=tokens.headers("  Alice@Example.TEST "),
    )
    assert created.status_code == 201
    listed = await client.get(f"{API}/threads", headers=tokens.headers("alice@example.test"))
    assert [thread["id"] for thread in listed.json()["items"]] == [created.json()["id"]]


async def test_agui_endpoint_requires_authentication(client: httpx.AsyncClient) -> None:
    response = await client.post(f"{API}/agents/backlog-refiner", json={"threadId": "t", "messages": []})
    assert response.status_code == 401
