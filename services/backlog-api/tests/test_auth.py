from __future__ import annotations

import time
from datetime import timedelta

import httpx
import jwt
import pytest
from fastapi import FastAPI, Request
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backlog_api.auth.dependencies import PrincipalDep
from backlog_api.auth.tokens import (
    InvalidTokenError,
    JwksKeySource,
    KeysUnavailableError,
    StaticKeySource,
    TokenVerifier,
)
from backlog_api.db.models import User
from backlog_api_testkit import API, TEST_AUDIENCE, TEST_ISSUER, TokenFactory

ME = f"{API}/me"


async def test_valid_token_returns_principal(client: httpx.AsyncClient, tokens: TokenFactory) -> None:
    response = await client.get(ME, headers=tokens.headers("alice@example.test", name="Alice Example", sub="sub-1"))
    assert response.status_code == 200
    assert response.json() == {"email": "alice@example.test", "name": "Alice Example", "sub": "sub-1"}


async def test_es256_token_is_accepted(client: httpx.AsyncClient, tokens: TokenFactory) -> None:
    response = await client.get(ME, headers=tokens.headers("bob@example.test", algorithm="ES256"))
    assert response.status_code == 200
    assert response.json()["email"] == "bob@example.test"


async def test_email_is_normalized(client: httpx.AsyncClient, tokens: TokenFactory) -> None:
    response = await client.get(ME, headers=tokens.headers("  Alice@Example.TEST "))
    assert response.status_code == 200
    assert response.json()["email"] == "alice@example.test"


async def test_missing_token_is_401_with_challenge(client: httpx.AsyncClient) -> None:
    response = await client.get(ME)
    assert response.status_code == 401
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.headers["www-authenticate"].startswith("Bearer")
    assert response.json()["type"] == "/problems/unauthorized"


@pytest.mark.parametrize(
    ("label", "token_options"),
    [
        ("expired", {"expires_in": -120}),
        ("wrong audience", {"audience": "someone-else"}),
        ("wrong issuer", {"issuer": "https://evil.test/realms/backlog"}),
        ("not yet valid", {"not_before": int(time.time()) + 600}),
        ("no exp", {"omit": ["exp"]}),
    ],
)
async def test_invalid_claims_are_401(
    client: httpx.AsyncClient, tokens: TokenFactory, label: str, token_options: dict[str, object]
) -> None:
    response = await client.get(ME, headers=tokens.headers("alice@example.test", **token_options))  # type: ignore[arg-type]
    assert response.status_code == 401, label
    assert 'error="invalid_token"' in response.headers["www-authenticate"]


async def test_expiry_within_leeway_is_accepted(client: httpx.AsyncClient, tokens: TokenFactory) -> None:
    response = await client.get(ME, headers=tokens.headers("alice@example.test", expires_in=-30))
    assert response.status_code == 200


async def test_audience_string_is_accepted(client: httpx.AsyncClient, tokens: TokenFactory) -> None:
    response = await client.get(ME, headers=tokens.headers("alice@example.test", audience=TEST_AUDIENCE))
    assert response.status_code == 200


@pytest.mark.parametrize(
    "build",
    [
        pytest.param(lambda t: t.issue(signing_key=t.untrusted_rsa_key), id="unknown signer"),
        pytest.param(lambda t: t.issue(kid="unknown-kid"), id="unknown kid"),
        pytest.param(lambda t: t.issue(algorithm="HS256", signing_key="x" * 32, kid=t.rsa_kid), id="HS256"),
        pytest.param(lambda t: jwt.encode(t.claims(), key="", algorithm="none"), id="alg none"),
        pytest.param(lambda t: "not-a-jwt", id="garbage"),
    ],
)
async def test_untrusted_tokens_are_401(client: httpx.AsyncClient, tokens: TokenFactory, build: object) -> None:
    token = build(tokens)  # type: ignore[operator]
    response = await client.get(ME, headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 401


async def test_missing_email_is_403(client: httpx.AsyncClient, tokens: TokenFactory) -> None:
    response = await client.get(ME, headers=tokens.headers(None))
    assert response.status_code == 403
    assert response.json()["type"] == "/problems/email-required"


@pytest.mark.parametrize("verified", [False, None, "true"])
async def test_unverified_email_is_403(client: httpx.AsyncClient, tokens: TokenFactory, verified: object) -> None:
    response = await client.get(ME, headers=tokens.headers("dave@example.test", email_verified=verified))
    assert response.status_code == 403
    assert response.json()["type"] == "/problems/email-not-verified"


async def test_raw_token_is_kept_on_request_state(app: FastAPI, tokens: TokenFactory) -> None:
    seen: dict[str, object] = {}

    @app.get("/test-only/token")
    async def token_echo(request: Request, principal: PrincipalDep) -> dict[str, bool]:
        seen["token"] = request.state.access_token
        seen["principal"] = request.state.principal
        return {"ok": True}

    token = tokens.issue("carol@example.test")
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/test-only/token", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200
    assert seen["token"] == token
    assert getattr(seen["principal"], "email", None) == "carol@example.test"


async def _user(sessionmaker: async_sessionmaker[AsyncSession], email: str) -> User:
    async with sessionmaker() as session:
        user = await session.scalar(select(User).where(User.email == email))
        assert user is not None
        return user


async def test_user_directory_upsert_is_throttled(
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    app: FastAPI,
    sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    email = "erin@example.test"
    await client.get(ME, headers=tokens.headers(" Erin@Example.test", name="Erin", sub="sub-erin"))
    user = await _user(sessionmaker, email)
    assert (user.email, user.name, user.sub) == (email, "Erin", "sub-erin")
    first_seen = user.last_seen_at

    # Within the refresh window nothing is rewritten, even when the in-process cache is cold.
    app.state.user_directory.forget()
    await client.get(ME, headers=tokens.headers(email, name="Erin", sub="sub-erin"))
    assert (await _user(sessionmaker, email)).last_seen_at == first_seen

    # A changed display name is written immediately.
    app.state.user_directory.forget()
    await client.get(ME, headers=tokens.headers(email, name="Erin E.", sub="sub-erin"))
    assert (await _user(sessionmaker, email)).name == "Erin E."

    # After the refresh window, last_seen_at moves forward again.
    backdated = first_seen - timedelta(hours=1)
    async with sessionmaker() as session:
        await session.execute(update(User).where(User.email == email).values(last_seen_at=backdated))
        await session.commit()
    app.state.user_directory.forget()
    await client.get(ME, headers=tokens.headers(email, name="Erin E.", sub="sub-erin"))
    assert (await _user(sessionmaker, email)).last_seen_at >= first_seen


async def test_verifier_rejects_disallowed_algorithms(tokens: TokenFactory) -> None:
    verifier = TokenVerifier(
        issuer=TEST_ISSUER, audience=TEST_AUDIENCE, key_source=StaticKeySource(tokens.jwks), algorithms=["RS256"]
    )
    with pytest.raises(InvalidTokenError):
        await verifier.verify(tokens.issue(algorithm="ES256"))
    assert (await verifier.verify(tokens.issue()))["email"] == "alice@example.test"


async def test_jwks_key_source_discovers_and_caches_keys(tokens: TokenFactory, monkeypatch: pytest.MonkeyPatch) -> None:
    discovery_calls: list[str] = []

    def discovery(request: httpx.Request) -> httpx.Response:
        discovery_calls.append(str(request.url))
        return httpx.Response(200, json={"issuer": TEST_ISSUER, "jwks_uri": f"{TEST_ISSUER}/certs"})

    fetched: list[str] = []

    def fake_fetch(self: jwt.PyJWKClient) -> dict[str, object]:
        fetched.append(self.uri)
        if self.jwk_set_cache is not None:
            self.jwk_set_cache.put(tokens.jwks)
        return tokens.jwks

    monkeypatch.setattr(jwt.PyJWKClient, "fetch_data", fake_fetch)
    source = JwksKeySource(TEST_ISSUER, http_transport=httpx.MockTransport(discovery))
    verifier = TokenVerifier(issuer=TEST_ISSUER, audience=TEST_AUDIENCE, key_source=source)

    assert (await verifier.verify(tokens.issue("alice@example.test")))["email"] == "alice@example.test"
    assert (await verifier.verify(tokens.issue("bob@example.test", algorithm="ES256")))["email"] == "bob@example.test"
    assert discovery_calls == [f"{TEST_ISSUER}/.well-known/openid-configuration"]
    assert fetched == [f"{TEST_ISSUER}/certs"]

    with pytest.raises(InvalidTokenError):
        await verifier.verify(tokens.issue(kid="rotated-away"))


async def test_jwks_key_source_reports_unreachable_provider() -> None:
    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    source = JwksKeySource(TEST_ISSUER, http_transport=httpx.MockTransport(down))
    with pytest.raises(KeysUnavailableError):
        await source.get_signing_key("any")
