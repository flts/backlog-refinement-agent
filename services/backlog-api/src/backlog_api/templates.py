"""Template seam for item creation.

Currently returns the default template from the skills catalog. The coordinator replaces the body of
:func:`template_for` with ``backlog_api.guidance.effective_template(session, project_id, item_type)`` (project
override, falling back to the skill default) when the guidance work is merged.
"""

from __future__ import annotations

import uuid
from functools import lru_cache

from backlog_skills import SkillCatalog, load_skills
from sqlalchemy.ext.asyncio import AsyncSession


@lru_cache(maxsize=1)
def _catalog() -> SkillCatalog:
    return load_skills()


async def template_for(session: AsyncSession, project_id: uuid.UUID, item_type: str) -> str:  # noqa: ARG001
    """The effective Markdown template (hints included) for ``item_type`` in the project."""
    return _catalog().template(item_type)  # pyright: ignore[reportArgumentType]
