"""Background worker: claims jobs (``FOR UPDATE SKIP LOCKED``) and indexes sources and items.

Job kinds: ``index_source`` (chunk + embed a source), ``index_item`` (embed an item's title and document when its
content changed), ``reindex_project`` (fan out to every source and item of a project).

Runs inside the API process (``BACKLOG_WORKER_ENABLED=true``, started by the app lifespan) and/or standalone::

    python -m backlog_api.worker                       # run the loop
    python -m backlog_api.worker reindex --project <uuid>
    python -m backlog_api.worker reindex --all

Handlers are idempotent; a failing job is retried with exponential backoff up to ``BACKLOG_JOB_MAX_ATTEMPTS``. Events
published by a standalone worker only reach subscribers of its own process.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import uuid
from collections.abc import Sequence
from datetime import timedelta
from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backlog_api import jobs
from backlog_api.chunking import chunk_text
from backlog_api.db.models import Item, ItemEmbedding, Project, Source, SourceChunk
from backlog_api.db.session import Database
from backlog_api.embeddings import EmbeddingClient, EmbeddingError
from backlog_api.events import SOURCE_INDEXED, DomainEvent, EventPublisher, InProcessEventPublisher
from backlog_api.indexing import enqueue_item_indexing, enqueue_source_indexing, item_embedding_stamp
from backlog_api.settings import Settings
from backlog_api.sources import SOURCE_UPDATED

logger = logging.getLogger(__name__)

WORKER_ACTOR = "system:indexer"
JOB_KINDS = (jobs.INDEX_SOURCE, jobs.INDEX_ITEM, jobs.REINDEX_PROJECT)
FULLTEXT_ONLY_NOTE = "Indexed for full-text search only: no embedding endpoint is configured."
MAX_ERROR_CHARS = 300


class PermanentJobError(Exception):
    """A job that must not be retried."""


def _source_event(kind: str, source: Source, **extra: Any) -> DomainEvent:
    return DomainEvent(
        kind,
        source.project_id,
        WORKER_ACTOR,
        {
            "sourceId": str(source.id),
            "name": source.name,
            "kind": source.kind,
            "mode": source.mode,
            "charCount": source.char_count,
            "indexStatus": source.index_status,
            "version": source.version,
            **extra,
        },
    )


def sanitize_error(error: BaseException) -> str:
    """A short message safe to show to users: no content, URLs, credentials or stack traces."""
    if isinstance(error, EmbeddingError):
        return str(error)[:MAX_ERROR_CHARS]
    return f"Indexing failed ({type(error).__name__}). See the service logs."


class IndexingWorker:
    def __init__(
        self,
        sessionmaker: async_sessionmaker[AsyncSession],
        settings: Settings,
        embedder: EmbeddingClient | None,
        publisher: EventPublisher,
    ) -> None:
        self._sessionmaker = sessionmaker
        self._settings = settings
        self._embedder = embedder
        self._publisher = publisher

    # --- loop ---------------------------------------------------------------------------------------------------

    async def run_once(self) -> int:
        """Claim and process one batch of due jobs; returns the number processed."""
        async with self._sessionmaker() as session:
            claimed = await jobs.claim(session, JOB_KINDS, self._settings.worker_batch_size)
            await session.commit()
            batch = [(job.id, job.kind, dict(job.payload), job.attempts) for job in claimed]
        for job_id, kind, payload, attempts in batch:
            await self._process(job_id, kind, payload, attempts)
        return len(batch)

    async def run_forever(self, stop: asyncio.Event | None = None) -> None:
        stop = stop or asyncio.Event()
        logger.info("Indexing worker started")
        while not stop.is_set():
            try:
                processed = await self.run_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Indexing worker iteration failed")
                processed = 0
            if processed == 0:
                try:
                    await asyncio.wait_for(stop.wait(), timeout=self._settings.worker_poll_seconds)
                except TimeoutError:
                    pass
        logger.info("Indexing worker stopped")

    async def drain(self, *, max_rounds: int = 100) -> int:
        """Process jobs until none is due (tests and the CLI)."""
        total = 0
        for _ in range(max_rounds):
            processed = await self.run_once()
            total += processed
            if processed == 0:
                break
        return total

    # --- dispatch -----------------------------------------------------------------------------------------------

    async def _process(self, job_id: int, kind: str, payload: dict[str, Any], attempts: int) -> None:
        try:
            if kind == jobs.INDEX_SOURCE:
                await self.index_source(uuid.UUID(payload["sourceId"]))
            elif kind == jobs.INDEX_ITEM:
                await self.index_item(uuid.UUID(payload["itemId"]), force=bool(payload.get("force")))
            elif kind == jobs.REINDEX_PROJECT:
                await self.reindex_project(uuid.UUID(payload["projectId"]))
            else:
                raise PermanentJobError(f"Unknown job kind {kind!r}.")
        except asyncio.CancelledError:
            raise
        except Exception as error:
            await self._handle_failure(job_id, kind, payload, attempts, error)
        else:
            async with self._sessionmaker() as session:
                await jobs.complete(session, job_id)
                await session.commit()

    async def _handle_failure(
        self, job_id: int, kind: str, payload: dict[str, Any], attempts: int, error: Exception
    ) -> None:
        permanent = isinstance(error, PermanentJobError | KeyError | ValueError) or (
            isinstance(error, EmbeddingError) and not error.retryable
        )
        final = permanent or attempts >= self._settings.job_max_attempts
        logger.warning(
            "Job failed",
            extra={"job_id": job_id, "job_kind": kind, "attempt": attempts, "final": final},
            exc_info=error,
        )
        message = sanitize_error(error)
        retry_in = None if final else timedelta(seconds=self._settings.job_retry_backoff_seconds * 2 ** (attempts - 1))
        async with self._sessionmaker() as session:
            await jobs.fail(session, job_id, message, retry_in=retry_in)
            await session.commit()
        if final and kind == jobs.INDEX_SOURCE:
            await self._mark_source_failed(payload.get("sourceId"), message)

    # --- index_source -------------------------------------------------------------------------------------------

    async def index_source(self, source_id: uuid.UUID) -> None:
        async with self._sessionmaker() as session:
            source = await session.get(Source, source_id, with_for_update=True)
            if source is None:
                return
            if source.mode == "excluded":
                await session.execute(delete(SourceChunk).where(SourceChunk.source_id == source.id))
                self._set_status(source, "skipped", None)
                await session.commit()
                await self._publish(_source_event(SOURCE_UPDATED, source))
                return
            self._set_status(source, "indexing", None)
            await session.commit()
            started_version, text = source.version, source.text
            project_id = source.project_id
            await self._publish(_source_event(SOURCE_UPDATED, source))

        settings = self._settings
        chunks = chunk_text(text, target_chars=settings.chunk_target_chars, overlap_ratio=settings.chunk_overlap_ratio)
        vectors: list[list[float]] | None = None
        if self._embedder is not None and chunks:
            vectors = await self._embedder.embed([chunk.text for chunk in chunks])

        async with self._sessionmaker() as session:
            source = await session.get(Source, source_id, with_for_update=True)
            if source is None:
                return
            if source.mode == "excluded" or source.version != started_version:
                # Changed meanwhile: the job queued by that change indexes the current state.
                return
            await session.execute(delete(SourceChunk).where(SourceChunk.source_id == source.id))
            session.add_all(
                SourceChunk(
                    source_id=source.id,
                    project_id=project_id,
                    ordinal=chunk.ordinal,
                    text=chunk.text,
                    heading_path=chunk.heading_path,
                    page=chunk.page,
                    char_start=chunk.char_start,
                    char_end=chunk.char_end,
                    embedding=vectors[index] if vectors is not None else None,
                )
                for index, chunk in enumerate(chunks)
            )
            note = FULLTEXT_ONLY_NOTE if self._embedder is None else None
            self._set_status(source, "indexed", note)
            await session.commit()
            event = _source_event(SOURCE_INDEXED, source, chunks=len(chunks), embedded=vectors is not None)
        await self._publish(event)

    @staticmethod
    def _set_status(source: Source, status: str, error: str | None) -> None:
        source.index_status = status
        source.index_error = error
        source.version += 1

    async def _mark_source_failed(self, raw_id: Any, message: str) -> None:
        try:
            source_id = uuid.UUID(str(raw_id))
        except ValueError:
            return
        async with self._sessionmaker() as session:
            source = await session.get(Source, source_id, with_for_update=True)
            if source is None:
                return
            self._set_status(source, "failed", message)
            await session.commit()
        await self._publish(_source_event(SOURCE_UPDATED, source))

    # --- index_item ---------------------------------------------------------------------------------------------

    async def index_item(self, item_id: uuid.UUID, *, force: bool = False) -> None:
        if self._embedder is None:
            return
        async with self._sessionmaker() as session:
            item = await session.get(Item, item_id)
            if item is None:
                return
            stamp = item_embedding_stamp(item)
            current = await session.scalar(select(ItemEmbedding.document_hash).where(ItemEmbedding.item_id == item.id))
            if current == stamp and not force:
                return
            project_id = item.project_id
            text = f"{item.title}\n\n{item.document[: self._settings.item_embedding_max_chars]}".strip()
        vector = await self._embedder.embed_one(text)
        async with self._sessionmaker() as session:
            statement = insert(ItemEmbedding).values(
                item_id=item_id, project_id=project_id, embedding=vector, document_hash=stamp
            )
            statement = statement.on_conflict_do_update(
                index_elements=[ItemEmbedding.item_id],
                set_={"embedding": vector, "document_hash": stamp, "updated_at": func.now()},
            )
            try:
                await session.execute(statement)
                await session.commit()
            except IntegrityError:
                await session.rollback()  # the item was deleted meanwhile

    # --- reindex_project ----------------------------------------------------------------------------------------

    async def reindex_project(self, project_id: uuid.UUID) -> None:
        async with self._sessionmaker() as session:
            for source_id in (await session.scalars(select(Source.id).where(Source.project_id == project_id))).all():
                await enqueue_source_indexing(session, source_id, project_id, "reindex")
            for item_id in (await session.scalars(select(Item.id).where(Item.project_id == project_id))).all():
                await enqueue_item_indexing(session, item_id, project_id, delay=timedelta(0), force=True)
            await session.commit()

    async def _publish(self, event: DomainEvent) -> None:
        try:
            await self._publisher.publish(event)
        except Exception:
            logger.exception("Publishing an indexing event failed", extra={"event_type": event.type})


async def enqueue_reindex(session: AsyncSession, project_ids: Sequence[uuid.UUID]) -> int:
    for project_id in project_ids:
        await jobs.enqueue(session, jobs.REINDEX_PROJECT, {"projectId": str(project_id)})
    return len(project_ids)


# --- standalone entrypoint ----------------------------------------------------------------------------------------


async def _run_standalone(settings: Settings, args: argparse.Namespace) -> int:
    database = Database(settings.require_runtime_config(), pool_size=settings.db_pool_size)
    embedder = EmbeddingClient.from_settings(settings)
    try:
        if args.command == "reindex":
            async with database.sessionmaker() as session:
                if args.all:
                    ids = list((await session.scalars(select(Project.id))).all())
                else:
                    ids = [uuid.UUID(args.project)]
                count = await enqueue_reindex(session, ids)
                await session.commit()
            print(f"Queued reindexing of {count} project(s); a running worker will process it.")  # noqa: T201
            return 0
        worker = IndexingWorker(database.sessionmaker, settings, embedder, InProcessEventPublisher())
        await worker.run_forever()
        return 0
    finally:
        if embedder is not None:
            await embedder.aclose()
        await database.dispose()


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m backlog_api.worker", description=__doc__)
    commands = parser.add_subparsers(dest="command")
    reindex = commands.add_parser("reindex", help="Queue re-chunking and re-embedding of sources and items.")
    target = reindex.add_mutually_exclusive_group(required=True)
    target.add_argument("--project", help="Project id.")
    target.add_argument("--all", action="store_true", help="Every project.")
    args = parser.parse_args(argv)
    from backlog_api.observability import configure_logging

    settings = Settings()
    configure_logging(settings.log_level)
    try:
        return asyncio.run(_run_standalone(settings, args))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
