from __future__ import annotations

import logging

import pytest
from agent_framework_ag_ui import AGUIThreadSnapshot, AGUIThreadSnapshotStore
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from agent_service.threads import PgThreadSnapshotStore

ALICE = "user:alice@example.test"
BOB = "user:bob@example.test"


@pytest.fixture
def store(sessionmaker: async_sessionmaker[AsyncSession]) -> PgThreadSnapshotStore:
    return PgThreadSnapshotStore(sessionmaker)


def snapshot(**overrides: object) -> AGUIThreadSnapshot:
    values: dict[str, object] = {
        "messages": [{"id": "m1", "role": "user", "content": "häs unicode ✓"}],
        "state": {"schemaVersion": 1, "preview": None},
        "interrupt": [{"id": "af-call-1", "toolCallId": "c1"}],
        "session_state": {"in_memory": {"messages": []}},
    }
    values.update(overrides)
    return AGUIThreadSnapshot(**values)  # type: ignore[arg-type]


async def test_conforms_to_the_maf_protocol(store: PgThreadSnapshotStore) -> None:
    assert isinstance(store, AGUIThreadSnapshotStore)


async def test_save_get_round_trip_and_upsert(store: PgThreadSnapshotStore) -> None:
    assert await store.get(scope=ALICE, thread_id="t1") is None
    await store.save(scope=ALICE, thread_id="t1", snapshot=snapshot())
    assert await store.get(scope=ALICE, thread_id="t1") == snapshot()

    await store.save(scope=ALICE, thread_id="t1", snapshot=snapshot(state=None, interrupt=None, session_state=None))
    loaded = await store.get(scope=ALICE, thread_id="t1")
    assert loaded is not None
    assert (loaded.state, loaded.interrupt, loaded.session_state) == (None, None, None)
    assert await store.count() == 1


async def test_scopes_are_isolated(store: PgThreadSnapshotStore) -> None:
    await store.save(scope=ALICE, thread_id="t1", snapshot=snapshot())
    assert await store.get(scope=BOB, thread_id="t1") is None
    assert await store.delete(scope=BOB, thread_id="t1") is False
    assert await store.get(scope=ALICE, thread_id="t1") is not None


async def test_delete_and_clear(store: PgThreadSnapshotStore) -> None:
    for scope in (ALICE, BOB):
        for thread_id in ("t1", "t2"):
            await store.save(scope=scope, thread_id=thread_id, snapshot=snapshot())
    assert await store.delete(scope=ALICE, thread_id="t1") is True
    assert await store.delete(scope=ALICE, thread_id="t1") is False
    await store.clear(scope=ALICE)
    assert await store.count(scope=ALICE) == 0
    assert await store.count(scope=BOB) == 2
    await store.clear()
    assert await store.count() == 0


async def test_save_failure_is_counted_and_logged(
    store: PgThreadSnapshotStore, sessionmaker: async_sessionmaker[AsyncSession], caplog: pytest.LogCaptureFixture
) -> None:
    async with sessionmaker() as session:
        await session.execute(text("ALTER TABLE thread_snapshots RENAME TO thread_snapshots_gone"))
        await session.commit()
    try:
        with caplog.at_level(logging.ERROR), pytest.raises(Exception, match="thread_snapshots"):
            await store.save(scope=ALICE, thread_id="t1", snapshot=snapshot())
    finally:
        async with sessionmaker() as session:
            await session.execute(text("ALTER TABLE thread_snapshots_gone RENAME TO thread_snapshots"))
            await session.commit()
    assert store.save_failures == 1
    assert any(record.getMessage() == "thread snapshot save failed" for record in caplog.records)
