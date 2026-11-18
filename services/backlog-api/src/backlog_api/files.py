"""File storage port for original source files.

``FileStore`` is deliberately small (put/get/delete keyed by source id) so a later ``S3FileStore`` can replace
:class:`PostgresFileStore` without touching the routes. The Postgres implementation stores bytes in ``source_files``
inside the caller's transaction, so a file is committed or rolled back together with its ``sources`` row.
"""

from __future__ import annotations

import hashlib
import uuid
from dataclasses import dataclass
from typing import Annotated, Protocol

from fastapi import Depends
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from backlog_api.db.models import SourceFile
from backlog_api.db.session import SessionDep


@dataclass(frozen=True, slots=True)
class StoredFile:
    content: bytes
    media_type: str
    size: int
    sha256: str


class FileStore(Protocol):
    async def put(self, source_id: uuid.UUID, content: bytes, media_type: str) -> StoredFile: ...

    async def get(self, source_id: uuid.UUID) -> StoredFile | None: ...

    async def delete(self, source_id: uuid.UUID) -> None: ...


class PostgresFileStore:
    """Stores file content as ``bytea`` in ``source_files`` using the request's session (the caller commits)."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def put(self, source_id: uuid.UUID, content: bytes, media_type: str) -> StoredFile:
        stored = StoredFile(
            content=content, media_type=media_type, size=len(content), sha256=hashlib.sha256(content).hexdigest()
        )
        await self._session.merge(
            SourceFile(
                source_id=source_id,
                content=stored.content,
                media_type=stored.media_type,
                size=stored.size,
                sha256=stored.sha256,
            )
        )
        return stored

    async def get(self, source_id: uuid.UUID) -> StoredFile | None:
        row = await self._session.scalar(select(SourceFile).where(SourceFile.source_id == source_id))
        if row is None:
            return None
        return StoredFile(content=row.content, media_type=row.media_type, size=row.size, sha256=row.sha256)

    async def delete(self, source_id: uuid.UUID) -> None:
        await self._session.execute(delete(SourceFile).where(SourceFile.source_id == source_id))


def get_file_store(session: SessionDep) -> FileStore:
    return PostgresFileStore(session)


FileStoreDep = Annotated[FileStore, Depends(get_file_store)]
