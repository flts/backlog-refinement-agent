"""Email identity helpers. Thread ownership is keyed by the normalized, verified email address."""

from __future__ import annotations

import re

MAX_EMAIL_LENGTH = 254
_EMAIL_PATTERN = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s.]+")


def normalize_email(value: str) -> str:
    """Trim and lower-case an email address (comparison in the database is case-insensitive as well)."""
    return value.strip().lower()


def user_scope(email: str) -> str:
    """The AG-UI snapshot / session / approval scope of a user: ``user:<normalized email>``."""
    return f"user:{normalize_email(email)}"


def is_valid_email(value: str) -> bool:
    """Basic syntax check (``local@domain.tld``, no whitespace); deliverability is not checked."""
    return 0 < len(value) <= MAX_EMAIL_LENGTH and value.isprintable() and _EMAIL_PATTERN.fullmatch(value) is not None
