"""Async boundary helpers for WebSocket runtime.

WS handlers run on Daphne's event loop. Any Django cache, redis-py, ORM, or
other blocking sync I/O must cross this boundary explicitly so one slow call
cannot freeze the whole ASGI worker.
"""

from __future__ import annotations

from typing import Any, Callable, TypeVar

from asgiref.sync import sync_to_async

T = TypeVar("T")


async def run_sync_io(func: Callable[..., T], /, *args: Any, **kwargs: Any) -> T:
    """Run sync I/O off the event loop.

    ``thread_sensitive=False`` is intentional: cache/Redis/file/network helpers
    do not require Django's thread-affine DB executor, and sharing that executor
    would let realtime cache work starve DB-bound sync views.
    """

    return await sync_to_async(func, thread_sensitive=False)(*args, **kwargs)
