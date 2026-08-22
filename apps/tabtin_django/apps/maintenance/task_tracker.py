"""
统一的异步任务投递跟踪器。

解决 Celery AsyncResult 的固有缺陷：对不存在的 task_id 也返回 PENDING，
无法区分「真正在排队」与「任务不存在」。

用法：
    dispatch 侧::

        result = my_task.apply_async(...)
        TaskTracker.mark_dispatched(result.id, meta={"type": "skill_batch", ...})

    status API 侧::

        state = TaskTracker.resolve_state(task_id)
        # "QUEUED" | "NOT_FOUND" | "STARTED" | "SUCCESS" | "FAILURE" | ...
"""

import logging

from celery.result import AsyncResult
from django.core.cache import cache

logger = logging.getLogger("celery.task_tracker")

_CACHE_PREFIX = "task:alive:"
_DEFAULT_TTL = 3600  # 1 小时，覆盖队列堆积场景


class TaskTracker:

    @classmethod
    def mark_dispatched(cls, task_id: str, meta: dict | None = None, ttl: int = _DEFAULT_TTL):
        """在 dispatch 点调用，向 cache 写入短 TTL 标记。"""
        cache.set(f"{_CACHE_PREFIX}{task_id}", meta or {}, timeout=ttl)

    @classmethod
    def resolve_state(cls, task_id: str) -> str:
        """区分 QUEUED / NOT_FOUND / 其它 Celery 原生状态。"""
        result = AsyncResult(task_id)
        if result.state != "PENDING":
            return result.state
        if cache.get(f"{_CACHE_PREFIX}{task_id}") is not None:
            return "QUEUED"
        return "NOT_FOUND"

    @classmethod
    def get_meta(cls, task_id: str) -> dict | None:
        """获取 dispatch 时写入的元数据。"""
        return cache.get(f"{_CACHE_PREFIX}{task_id}")

    @classmethod
    def refresh_ttl(cls, task_id: str, ttl: int = _DEFAULT_TTL):
        """Worker 开始消费时可刷新 TTL，防止长排队后误判。"""
        key = f"{_CACHE_PREFIX}{task_id}"
        meta = cache.get(key)
        if meta is not None:
            cache.set(key, meta, timeout=ttl)
