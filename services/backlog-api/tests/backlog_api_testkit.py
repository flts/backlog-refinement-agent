"""Reusable test helpers for backlog-api: locally signed access tokens and API shortcuts."""

from __future__ import annotations

import json
import time
import uuid
from collections.abc import Iterable, Mapping
from typing import Any

import httpx
import jwt
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from jwt.algorithms import ECAlgorithm, RSAAlgorithm

TEST_ISSUER = "https://keycloak.test/realms/backlog"
TEST_AUDIENCE = "backlog-api"
API = "/api/backlog"


class TokenFactory:
    """Signs Keycloak-like access tokens with test keys; :attr:`jwks` is the matching public JWK set."""

    def __init__(self, issuer: str = TEST_ISSUER, audience: str = TEST_AUDIENCE) -> None:
        self.issuer = issuer
        self.audience = audience
        self.rsa_kid = "test-rsa"
        self.ec_kid = "test-ec"
        self._rsa_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self._ec_key = ec.generate_private_key(ec.SECP256R1())
        self.untrusted_rsa_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    @property
    def jwks(self) -> dict[str, Any]:
        rsa_jwk = json.loads(RSAAlgorithm.to_jwk(self._rsa_key.public_key()))
        rsa_jwk.update(kid=self.rsa_kid, use="sig", alg="RS256")
        ec_jwk = json.loads(ECAlgorithm.to_jwk(self._ec_key.public_key()))
        ec_jwk.update(kid=self.ec_kid, use="sig", alg="ES256")
        return {"keys": [rsa_jwk, ec_jwk]}

    def claims(
        self,
        email: str | None = "alice@example.test",
        *,
        email_verified: Any = True,
        name: str | None = None,
        sub: str | None = None,
        audience: str | list[str] | None = None,
        issuer: str | None = None,
        expires_in: int = 300,
        not_before: int | None = None,
        extra: Mapping[str, Any] | None = None,
        omit: Iterable[str] = (),
    ) -> dict[str, Any]:
        now = int(time.time())
        local_part = (email or "user").strip().split("@")[0].lower()
        claims: dict[str, Any] = {
            "iss": issuer or self.issuer,
            "aud": audience if audience is not None else [self.audience, "agent-service"],
            "sub": sub or str(uuid.uuid5(uuid.NAMESPACE_URL, local_part)),
            "iat": now,
            "exp": now + expires_in,
            "azp": "backlog-web",
            "email": email,
            "email_verified": email_verified,
            "name": name if name is not None else local_part.capitalize(),
            "preferred_username": local_part,
        }
        if not_before is not None:
            claims["nbf"] = not_before
        if extra:
            claims.update(extra)
        for key in omit:
            claims.pop(key, None)
        return claims

    def issue(
        self,
        email: str | None = "alice@example.test",
        *,
        algorithm: str = "RS256",
        kid: str | None = None,
        signing_key: Any = None,
        **claim_options: Any,
    ) -> str:
        claims = self.claims(email, **claim_options)
        if signing_key is None:
            signing_key = self._ec_key if algorithm == "ES256" else self._rsa_key
        if kid is None:
            kid = self.ec_kid if algorithm == "ES256" else self.rsa_kid
        return jwt.encode(claims, signing_key, algorithm=algorithm, headers={"kid": kid})

    def headers(self, email: str | None = "alice@example.test", **options: Any) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.issue(email, **options)}"}


async def create_project(
    client: httpx.AsyncClient, tokens: TokenFactory, owner: str, name: str = "Project"
) -> dict[str, Any]:
    response = await client.post(f"{API}/projects", json={"name": name}, headers=tokens.headers(owner))
    assert response.status_code == 201, response.text
    return response.json()


async def add_member(
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    project_id: str,
    owner: str,
    email: str,
    role: str = "contributor",
) -> httpx.Response:
    return await client.post(
        f"{API}/projects/{project_id}/members", json={"email": email, "role": role}, headers=tokens.headers(owner)
    )
