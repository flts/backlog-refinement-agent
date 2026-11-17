"""Run admission limits (process-local; agent-service runs as a single replica or with sticky routing by thread).

* :class:`TokenBucketLimiter`: per-user rate limit for AG-UI runs; a refused run is HTTP 429 with ``Retry-After``.
* :class:`ThreadRunLocks`: one active run per thread; a second run of the same thread is HTTP 409 ``thread-busy``.
  This is an in-process lock, independent of ``threads.status`` (which only reports what the UI shows).

Both are checked before the SSE stream starts (:func:`agent_service.agents.endpoint.guard_agent_request`).
"""

from __future__ import annotations

import math
import time
from collections.abc import Callable
from dataclasses import dataclass, field


@dataclass(slots=True)
class _Bucket:
    tokens: float
    updated: float


class TokenBucketLimiter:
    """``per_minute`` tokens per minute per key, at most ``burst`` banked. ``per_minute <= 0`` disables the limiter."""

    _PRUNE_THRESHOLD = 1024

    def __init__(self, per_minute: float, burst: int, *, clock: Callable[[], float] = time.monotonic) -> None:
        self._rate = max(per_minute, 0.0) / 60.0
        self._burst = max(burst, 1)
        self._clock = clock
        self._buckets: dict[str, _Bucket] = {}

    @property
    def enabled(self) -> bool:
        return self._rate > 0

    def try_acquire(self, key: str) -> float | None:
        """``None`` when the run is admitted, otherwise the seconds until a token is available."""
        if not self.enabled:
            return None
        now = self._clock()
        bucket = self._buckets.get(key)
        if bucket is None:
            if len(self._buckets) >= self._PRUNE_THRESHOLD:
                self._prune(now)
            bucket = self._buckets[key] = _Bucket(tokens=float(self._burst), updated=now)
        else:
            bucket.tokens = min(float(self._burst), bucket.tokens + (now - bucket.updated) * self._rate)
            bucket.updated = now
        if bucket.tokens >= 1.0:
            bucket.tokens -= 1.0
            return None
        return (1.0 - bucket.tokens) / self._rate

    def _prune(self, now: float) -> None:
        """Forget users whose bucket has refilled completely (they are indistinguishable from new users)."""
        full = [
            key
            for key, bucket in self._buckets.items()
            if bucket.tokens + (now - bucket.updated) * self._rate >= self._burst
        ]
        for key in full:
            del self._buckets[key]


def retry_after_header(seconds: float) -> str:
    return str(max(1, math.ceil(seconds)))


class RunPermit:
    """Holds one thread's run lock; :meth:`release` is idempotent."""

    __slots__ = ("_locks", "key")

    def __init__(self, locks: ThreadRunLocks, key: str) -> None:
        self._locks: ThreadRunLocks | None = locks
        self.key = key

    def release(self) -> None:
        locks, self._locks = self._locks, None
        if locks is not None:
            locks._release(self.key)  # pyright: ignore[reportPrivateUsage]


@dataclass(slots=True)
class ThreadRunLocks:
    _active: set[str] = field(default_factory=set)

    def try_acquire(self, scope: str, thread_id: str) -> RunPermit | None:
        key = f"{scope}\x00{thread_id}"
        if key in self._active:
            return None
        self._active.add(key)
        return RunPermit(self, key)

    def _release(self, key: str) -> None:
        self._active.discard(key)

    def __len__(self) -> int:
        return len(self._active)


@dataclass(slots=True)
class RunLimits:
    rate: TokenBucketLimiter
    threads: ThreadRunLocks = field(default_factory=ThreadRunLocks)
