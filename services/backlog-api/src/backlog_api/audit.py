"""Audit log (``audit_events``): membership, role, project and (later) guidance and agent-applied changes.

Details carry identifiers and metadata only, never document or source content.
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from backlog_api.db.models import AuditEvent

PROJECT_CREATED = "project.created"
PROJECT_RENAMED = "project.renamed"
PROJECT_DELETED = "project.deleted"
MEMBER_ADDED = "member.added"
MEMBER_ROLE_CHANGED = "member.role_changed"
MEMBER_REMOVED = "member.removed"
GUIDANCE_UPDATED = "guidance.updated"
GUIDANCE_RESET = "guidance.reset"
GUIDANCE_IMPORTED = "guidance.imported"


def record(
    session: AsyncSession,
    *,
    actor: str,
    action: str,
    project_id: uuid.UUID | None,
    details: dict[str, Any] | None = None,
) -> None:
    """Add an audit event to the current transaction (it is written when the caller commits)."""
    session.add(AuditEvent(project_id=project_id, actor=actor, action=action, details=details or {}))
