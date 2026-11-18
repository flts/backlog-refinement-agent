"""Template seam for item creation: the project's effective template (override, else the skill default)."""

from __future__ import annotations

import uuid
from typing import cast

from backlog_skills import ItemType
from sqlalchemy.ext.asyncio import AsyncSession

from backlog_api.guidance import effective_template


async def template_for(session: AsyncSession, project_id: uuid.UUID, item_type: str) -> str:
    """The effective Markdown template (hints included) for ``item_type`` in the project."""
    return await effective_template(session, project_id, cast(ItemType, item_type))
