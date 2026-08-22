"""
Memory 系统分布式锁 — 防止 L2/L4/L5 的并发写入冲突

锁类型:
    session 级: memory:extract:{session_id}  — L2 增量提取与 L4 空闲结算互斥
    space 级:   memory:space_write:{space_id} — L5 压缩/淘汰等写入类任务互斥
"""

from __future__ import annotations

import logging
from contextlib import contextmanager
from typing import Generator, Optional

logger = logging.getLogger(__name__)

SESSION_LOCK_PREFIX = "memory:extract:"
SPACE_LOCK_PREFIX = "memory:space_write:"

DEFAULT_LOCK_TIMEOUT = 320
DEFAULT_BLOCKING_TIMEOUT = 5


def _get_redis_client():
    """获取 Redis 客户端实例。"""
    try:
        from django.core.cache import caches
        cache = caches["default"]
        if hasattr(cache, "client"):
            client = cache.client.get_client()
            return client
    except Exception:
        pass  # defensive: django_redis/cache 客户端不可用，尝试 broker URL 直连

    try:
        import redis
        from django.conf import settings
        redis_url = getattr(settings, "CELERY_BROKER_URL", None)
        if redis_url:
            return redis.from_url(redis_url)
    except Exception:
        pass  # defensive: 直连 Redis 失败，Memory 锁降级为无锁（调用方需容忍）

    return None


@contextmanager
def session_memory_lock(
    session_id: str,
    timeout: int = DEFAULT_LOCK_TIMEOUT,
    blocking_timeout: int = DEFAULT_BLOCKING_TIMEOUT,
) -> Generator[bool, None, None]:
    """Session 级记忆提取锁。

    Usage:
        with session_memory_lock(session_id) as acquired:
            if acquired:
                # do extraction
            else:
                # skip, another worker is extracting
    """
    client = _get_redis_client()
    if client is None:
        logger.debug("[MemoryLock] Redis not available, proceeding without lock")
        yield True
        return

    lock_key = f"{SESSION_LOCK_PREFIX}{session_id}"
    lock = client.lock(lock_key, timeout=timeout, blocking_timeout=blocking_timeout)

    try:
        acquired = lock.acquire(blocking=True, blocking_timeout=blocking_timeout)
    except Exception as exc:
        logger.warning("[MemoryLock] Lock error for session %s: %s", session_id, exc)
        yield False
        return

    if not acquired:
        logger.info("[MemoryLock] Session lock contention: %s", session_id)
    try:
        yield acquired
    finally:
        if acquired:
            try:
                lock.release()
            except Exception:
                logger.error(
                    "[MemoryLock] lock.release 失败: session_id=%s",
                    session_id,
                    exc_info=True,
                )


@contextmanager
def space_memory_lock(
    space_id: str,
    timeout: int = DEFAULT_LOCK_TIMEOUT * 2,
    blocking_timeout: int = DEFAULT_BLOCKING_TIMEOUT,
) -> Generator[bool, None, None]:
    """Space 级记忆写入锁（L5 压缩/淘汰任务使用）。"""
    client = _get_redis_client()
    if client is None:
        yield True
        return

    lock_key = f"{SPACE_LOCK_PREFIX}{space_id}"
    lock = client.lock(lock_key, timeout=timeout, blocking_timeout=blocking_timeout)

    acquired = False
    try:
        acquired = lock.acquire(blocking=True, blocking_timeout=blocking_timeout)
        if not acquired:
            logger.info("[MemoryLock] Space lock contention: %s", space_id)
        yield acquired
    except Exception as exc:
        logger.warning("[MemoryLock] Lock error for space %s: %s", space_id, exc)
        yield False
    finally:
        if acquired:
            try:
                lock.release()
            except Exception:
                logger.error(
                    "[MemoryLock] lock.release 失败: space_id=%s",
                    space_id,
                    exc_info=True,
                )
