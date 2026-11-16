"""The authenticated principal: the normalized, verified email address from the access token."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from agent_service.identity import is_valid_email, normalize_email
from agent_service.problems import ProblemError


@dataclass(frozen=True, slots=True)
class Principal:
    """Who is calling. ``email`` is normalized (trimmed, lower-case) and decides project access."""

    email: str
    sub: str | None = None
    name: str | None = None


def principal_from_claims(claims: Mapping[str, Any]) -> Principal:
    """Build the principal from verified token claims; 403 when the email is missing, invalid or not verified."""
    raw_email = claims.get("email")
    if not isinstance(raw_email, str) or not raw_email.strip():
        raise ProblemError(403, "email-required", detail="The access token has no email claim.")
    if claims.get("email_verified") is not True:
        raise ProblemError(403, "email-not-verified", detail="The email address of this account is not verified.")
    email = normalize_email(raw_email)
    if not is_valid_email(email):
        raise ProblemError(403, "email-invalid", detail="The email claim is not a valid email address.")
    sub = claims.get("sub")
    return Principal(email=email, sub=sub if isinstance(sub, str) and sub else None, name=_display_name(claims))


def _display_name(claims: Mapping[str, Any]) -> str | None:
    name = claims.get("name")
    if isinstance(name, str) and name.strip():
        return name.strip()
    parts = [claims.get("given_name"), claims.get("family_name")]
    joined = " ".join(part.strip() for part in parts if isinstance(part, str) and part.strip())
    return joined or None
