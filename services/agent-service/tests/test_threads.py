from __future__ import annotations

import uuid

import httpx
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from agent_service.db.models import Feedback, Thread, ThreadSnapshot
from agent_service.threads import purge_threads
from agent_service_testkit import API, ITEM_ID, PROJECT_ID, TokenFactory, create_thread
from conftest import BacklogMock

BOB = "bob@example.test"


async def test_thread_crud(client: httpx.AsyncClient, tokens: TokenFactory) -> None:
    thread = await create_thread(client, tokens, title="Refine login")
    assert uuid.UUID(thread["id"])
    assert thread["status"] == "idle"
    assert thread["title"] == "Refine login"
    assert thread["projectId"] == PROJECT_ID
    assert thread["itemId"] == ITEM_ID

    listed = await client.get(
        f"{API}/threads", params={"projectId": PROJECT_ID, "itemId": ITEM_ID}, headers=tokens.headers()
    )
    assert [item["id"] for item in listed.json()["items"]] == [thread["id"]]
    other_item = await client.get(f"{API}/threads", params={"itemId": str(uuid.uuid4())}, headers=tokens.headers())
    assert other_item.json()["items"] == []

    renamed = await client.patch(f"{API}/threads/{thread['id']}", json={"title": "New title"}, headers=tokens.headers())
    assert renamed.status_code == 200
    assert renamed.json()["title"] == "New title"

    deleted = await client.delete(f"{API}/threads/{thread['id']}", headers=tokens.headers())
    assert deleted.status_code == 204
    assert (await client.get(f"{API}/threads", headers=tokens.headers())).json()["items"] == []
    assert (await client.delete(f"{API}/threads/{thread['id']}", headers=tokens.headers())).status_code == 404


async def test_threads_are_private(client: httpx.AsyncClient, tokens: TokenFactory) -> None:
    thread = await create_thread(client, tokens)
    assert (await client.get(f"{API}/threads", headers=tokens.headers(BOB))).json()["items"] == []
    patch = await client.patch(f"{API}/threads/{thread['id']}", json={"title": "x"}, headers=tokens.headers(BOB))
    assert patch.status_code == 404
    assert patch.json()["type"] == "/problems/thread-not-found"
    assert (await client.delete(f"{API}/threads/{thread['id']}", headers=tokens.headers(BOB))).status_code == 404
    assert (await client.get(f"{API}/threads", headers=tokens.headers())).json()["items"][0]["id"] == thread["id"]


async def test_create_checks_membership_with_the_user_token(
    client: httpx.AsyncClient, tokens: TokenFactory, backlog: BacklogMock
) -> None:
    token = tokens.issue()
    response = await client.post(
        f"{API}/threads",
        json={"projectId": PROJECT_ID, "itemId": ITEM_ID},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 201
    assert [request.url.path for request in backlog.requests] == [
        f"/api/backlog/projects/{PROJECT_ID}",
        f"/api/backlog/projects/{PROJECT_ID}/items/{ITEM_ID}",
    ]
    assert set(backlog.authorizations) == {f"Bearer {token}"}


async def test_create_for_non_member_or_missing_item_is_404(
    client: httpx.AsyncClient,
    tokens: TokenFactory,
    backlog: BacklogMock,
    sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    backlog.missing.add(f"/api/backlog/projects/{PROJECT_ID}")
    response = await client.post(
        f"{API}/threads", json={"projectId": PROJECT_ID, "itemId": ITEM_ID}, headers=tokens.headers()
    )
    assert response.status_code == 404
    backlog.missing.clear()
    backlog.missing.add(f"/api/backlog/projects/{PROJECT_ID}/items/{ITEM_ID}")
    response = await client.post(
        f"{API}/threads", json={"projectId": PROJECT_ID, "itemId": ITEM_ID}, headers=tokens.headers()
    )
    assert response.status_code == 404
    async with sessionmaker() as session:
        assert (await session.execute(select(func.count()).select_from(Thread))).scalar_one() == 0


async def test_create_when_backlog_is_down_is_503(
    client: httpx.AsyncClient, tokens: TokenFactory, backlog: BacklogMock
) -> None:
    backlog.status = 500
    response = await client.post(
        f"{API}/threads", json={"projectId": PROJECT_ID, "itemId": ITEM_ID}, headers=tokens.headers()
    )
    assert response.status_code == 503
    assert response.json()["type"] == "/problems/backlog-unavailable"


async def test_create_validates_body(client: httpx.AsyncClient, tokens: TokenFactory) -> None:
    response = await client.post(
        f"{API}/threads", json={"projectId": "nope", "itemId": ITEM_ID}, headers=tokens.headers()
    )
    assert response.status_code == 422


async def test_feedback_upsert_and_privacy(
    client: httpx.AsyncClient, tokens: TokenFactory, sessionmaker: async_sessionmaker[AsyncSession]
) -> None:
    thread = await create_thread(client, tokens)
    body = {"threadId": thread["id"], "messageId": "m1", "rating": "up"}
    first = await client.post(f"{API}/feedback", json=body, headers=tokens.headers())
    assert first.status_code == 200
    second = await client.post(
        f"{API}/feedback", json={**body, "rating": "down", "comment": "too long"}, headers=tokens.headers()
    )
    assert second.json()["rating"] == "down"
    async with sessionmaker() as session:
        rows = (await session.execute(select(Feedback))).scalars().all()
    assert len(rows) == 1
    assert (rows[0].rating, rows[0].comment) == ("down", "too long")

    denied = await client.post(f"{API}/feedback", json=body, headers=tokens.headers(BOB))
    assert denied.status_code == 404
    bad = await client.post(f"{API}/feedback", json={**body, "rating": "meh"}, headers=tokens.headers())
    assert bad.status_code == 422


async def test_delete_removes_snapshot_and_feedback(
    client: httpx.AsyncClient, tokens: TokenFactory, sessionmaker: async_sessionmaker[AsyncSession]
) -> None:
    thread = await create_thread(client, tokens)
    async with sessionmaker() as session:
        session.add(ThreadSnapshot(scope="user:alice@example.test", thread_id=thread["id"], messages=[]))
        await session.commit()
    await client.post(
        f"{API}/feedback", json={"threadId": thread["id"], "messageId": "m", "rating": "up"}, headers=tokens.headers()
    )
    assert (await client.delete(f"{API}/threads/{thread['id']}", headers=tokens.headers())).status_code == 204
    async with sessionmaker() as session:
        assert (await session.execute(select(func.count()).select_from(ThreadSnapshot))).scalar_one() == 0
        assert (await session.execute(select(func.count()).select_from(Feedback))).scalar_one() == 0


async def test_purge_threads(
    client: httpx.AsyncClient, tokens: TokenFactory, sessionmaker: async_sessionmaker[AsyncSession]
) -> None:
    other_item = str(uuid.uuid4())
    other_project = str(uuid.uuid4())
    alice_a = await create_thread(client, tokens)
    alice_b = await create_thread(client, tokens, item_id=other_item)
    bob_a = await create_thread(client, tokens, BOB)
    elsewhere = await create_thread(client, tokens, project_id=other_project)
    async with sessionmaker() as session:
        for thread, email in ((alice_a, "alice"), (alice_b, "alice"), (bob_a, "bob"), (elsewhere, "alice")):
            session.add(ThreadSnapshot(scope=f"user:{email}@example.test", thread_id=thread["id"], messages=[]))
        await session.commit()

    async def remaining() -> set[str]:
        async with sessionmaker() as session:
            return set((await session.execute(select(Thread.id))).scalars().all())

    async with sessionmaker() as session:
        assert await purge_threads(session, project_id=uuid.UUID(PROJECT_ID), item_id=uuid.UUID(other_item)) == 1
        await session.commit()
    assert alice_b["id"] not in await remaining()

    async with sessionmaker() as session:
        deleted = await purge_threads(session, project_id=uuid.UUID(PROJECT_ID), owner_email="BOB@example.test ")
        await session.commit()
    assert deleted == 1
    assert await remaining() == {alice_a["id"], elsewhere["id"]}

    async with sessionmaker() as session:
        assert await purge_threads(session, project_id=uuid.UUID(PROJECT_ID)) == 1
        await session.commit()
        snapshots = set((await session.execute(select(ThreadSnapshot.thread_id))).scalars().all())
    assert await remaining() == {elsewhere["id"]}
    assert snapshots == {elsewhere["id"]}
