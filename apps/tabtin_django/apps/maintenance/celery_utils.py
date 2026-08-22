"""Celery broker 相关的公共工具。

提供 broker 连接错误的判断和日志降噪辅助，供所有需要调用 .delay() 的模块使用。
"""
from __future__ import annotations

import logging
from typing import Optional

logger = logging.getLogger(__name__)

_BROKER_ERROR_TYPE_NAMES = frozenset({
    "OperationalError",
    "ConnectionError",
    "TimeoutError",
    "ConnectionRefusedError",
    "BrokenPipeError",
})


def is_broker_connection_error(exc: BaseException) -> bool:
    """判断异常链中是否包含 broker/Redis 连接类错误。

    遍历 __cause__ / __context__ 链（最深 10 层），检查：
    - 异常类名是否属于已知连接错误类型
    - 异常消息是否包含 Redis 连接关键词
    """
    cur: Optional[BaseException] = exc
    depth = 0
    while cur and depth < 10:
        if type(cur).__name__ in _BROKER_ERROR_TYPE_NAMES:
            return True
        msg = str(cur).lower()
        if "connecting to" in msg or "connection refused" in msg:
            return True
        cur = cur.__cause__ or cur.__context__
        depth += 1
    return False


def safe_delay(task, *args, label: str = "", logger_obj=None, **kwargs):
    """安全调用 Celery task.delay()，broker 连接失败时只打单行 WARNING。

    返回 (success: bool, result_or_exc)。
    """
    log = logger_obj or logger
    try:
        result = task.delay(*args, **kwargs)
        return True, result
    except Exception as exc:
        if is_broker_connection_error(exc):
            log.warning(
                "%s broker 不可达，任务未入队: %s (%s)",
                label or task.name,
                type(exc).__name__,
                exc,
            )
        else:
            log.error(
                "%s 任务入队失败: %s",
                label or task.name,
                exc,
                exc_info=True,
            )
        return False, exc
