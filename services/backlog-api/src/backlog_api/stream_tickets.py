"""Short-lived signed tickets for opening an event stream without an ``Authorization`` header.

The browser's ``EventSource`` cannot set headers. A client that authenticated normally asks for a ticket
(``POST /projects/{id}/events/ticket``) and opens ``GET /projects/{id}/events?ticket=<ticket>``. A ticket is
``<base64url(json {e: email, p: project id, x: expiry})>.<base64url(HMAC-SHA256)>``, bound to one user and one
project and valid for ``BACKLOG_EVENTS_TICKET_TTL_SECONDS`` (60 s by default). It is only accepted by the project
event stream.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import secrets
import time
import uuid
from dataclasses import dataclass


class TicketError(Exception):
    """The ticket is malformed, has a bad signature or has expired."""


@dataclass(frozen=True, slots=True)
class StreamTicket:
    email: str
    project_id: uuid.UUID
    expires_at: int


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


class TicketSigner:
    def __init__(self, secret: str | bytes | None = None, *, ttl_seconds: int = 60) -> None:
        raw = secret if secret is not None else secrets.token_bytes(32)
        self._key = raw.encode() if isinstance(raw, str) else raw
        self.ttl_seconds = ttl_seconds

    def _sign(self, body: str) -> str:
        return _b64(hmac.new(self._key, body.encode(), hashlib.sha256).digest())

    def issue(self, email: str, project_id: uuid.UUID, *, now: float | None = None) -> StreamTicket:
        expires_at = int((time.time() if now is None else now) + self.ttl_seconds)
        return StreamTicket(email=email, project_id=project_id, expires_at=expires_at)

    def encode(self, ticket: StreamTicket) -> str:
        body = _b64(
            json.dumps(
                {"e": ticket.email, "p": str(ticket.project_id), "x": ticket.expires_at}, separators=(",", ":")
            ).encode()
        )
        return f"{body}.{self._sign(body)}"

    def verify(self, value: str, *, now: float | None = None) -> StreamTicket:
        body, _, signature = value.partition(".")
        if not body or not signature or not hmac.compare_digest(self._sign(body), signature):
            raise TicketError("The stream ticket is invalid.")
        try:
            claims = json.loads(_unb64(body))
            ticket = StreamTicket(
                email=str(claims["e"]), project_id=uuid.UUID(claims["p"]), expires_at=int(claims["x"])
            )
        except (ValueError, KeyError, TypeError, binascii.Error) as exc:
            raise TicketError("The stream ticket is invalid.") from exc
        if ticket.expires_at < (time.time() if now is None else now):
            raise TicketError("The stream ticket has expired.")
        return ticket
