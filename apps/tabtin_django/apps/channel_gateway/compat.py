"""Async-to-sync compatibility helpers for channel_gateway.

Celery workers and Django synchronous views need to call async adapter
methods (send_text, send_media, poll_updates, etc.).  This module provides
two entry points:

- ``run_adapter_coro``          – run coroutine, return result; when an event
                                   loop is already running, uses ThreadPoolExecutor.
                                   Returns None if the thread-pool path fails.
- ``run_adapter_coro_required`` – must-complete (falls back to a thread pool
                                   if a loop is already running, never returns None)
"""

from __future__ import annotations

import asyncio
import logging
from typing import TypeVar

logger = logging.getLogger(__name__)

T = TypeVar("T")


def run_adapter_coro(coro) -> T | None:
    """Run an async coroutine from a synchronous context.

    If an event loop is already running, dispatches to a worker thread via
    ``ThreadPoolExecutor`` so callers always get a valid result instead of
    ``None`` (which previously caused ``AttributeError`` on ``.ok`` access).
    """
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop and loop.is_running():
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            try:
                return pool.submit(asyncio.run, coro).result(timeout=30)
            except Exception:
                logger.warning("[run_adapter_coro] thread-pool fallback failed", exc_info=True)
                return None

    new_loop = asyncio.new_event_loop()
    try:
        return new_loop.run_until_complete(coro)
    finally:
        new_loop.close()


def run_adapter_coro_required(coro, *, timeout: float = 30) -> T:
    """Run an async coroutine and **always** return its result.

    Unlike ``run_adapter_coro``, if an event loop is already running this
    function dispatches the coroutine to a worker thread via
    ``ThreadPoolExecutor`` so the caller still gets a value.

    Intended for admin/management operations (probe, webhook setup) where
    silently returning ``None`` would be a bug.
    """
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop and loop.is_running():
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            return pool.submit(asyncio.run, coro).result(timeout=timeout)

    new_loop = asyncio.new_event_loop()
    try:
        return new_loop.run_until_complete(coro)
    finally:
        new_loop.close()
