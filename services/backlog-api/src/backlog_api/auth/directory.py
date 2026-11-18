"""User display directory (``users`` table): names and last-seen times from token claims. Never used for access."""

from __future__ import annotations

import logging
import time
from datetime import timedelta

from sqlalchemy import func, or_
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backlog_api.auth.principal import Principal
from backlog_api.db.models import User

logger = logging.getLogger(__name__)

_MAX_CACHE_ENTRIES = 10_000


class UserDirectory:
    """Upserts the caller's display data at most once per ``refresh_seconds`` (unless sub or name changed).

    The in-process cache avoids a write per request; the ``WHERE`` guard on the upsert keeps replicas from rewriting
    ``last_seen_at`` more often than the refresh interval.
    """

    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession], refresh_seconds: int = 300) -> None:
        self._sessionmaker = sessionmaker
        self._refresh_seconds = refresh_seconds
        self._seen: dict[str, tuple[float, str | None, str | None]] = {}

    def forget(self) -> None:
        self._seen.clear()

    async def touch(self, principal: Principal) -> None:
        now = time.monotonic()
        cached = self._seen.get(principal.email)
        if cached is not None:
            seen_at, sub, name = cached
            if now - seen_at < self._refresh_seconds and sub == principal.sub and name == principal.name:
                return
        try:
            async with self._sessionmaker() as session:
                await upsert_user(session, principal, refresh=timedelta(seconds=self._refresh_seconds))
                await session.commit()
        except SQLAlchemyError:
            logger.warning("Updating the user directory failed", exc_info=True)
            return
        if len(self._seen) >= _MAX_CACHE_ENTRIES:
            self._seen.clear()
        self._seen[principal.email] = (now, principal.sub, principal.name)


async def upsert_user(session: AsyncSession, principal: Principal, *, refresh: timedelta) -> None:
    statement = insert(User).values(
        email=principal.email, sub=principal.sub, name=principal.name, last_seen_at=func.now()
    )
    excluded = statement.excluded
    statement = statement.on_conflict_do_update(
        index_elements=[User.email],
        set_={
            "sub": func.coalesce(excluded.sub, User.sub),
            "name": func.coalesce(excluded.name, User.name),
            "last_seen_at": excluded.last_seen_at,
        },
        where=or_(
            User.last_seen_at < func.now() - refresh,
            User.sub.is_distinct_from(func.coalesce(excluded.sub, User.sub)),
            User.name.is_distinct_from(func.coalesce(excluded.name, User.name)),
        ),
    )
    await session.execute(statement)
