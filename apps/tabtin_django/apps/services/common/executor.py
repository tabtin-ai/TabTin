"""Agent 线程池 — LLM 密集型与 I/O 密集型分离。

两个独立线程池：
- **agent_executor** (LLM 密集型)：ChatService、ReAct loop、LLM stream、
  群聊 orchestrator 等需要长时间等待 LLM 响应的路径。
- **agent_io_executor** (I/O 密集型)：RAG、TabDoc、
  Extensions 等涉及文件操作/外部 HTTP 调用但非 LLM 的路径。

拆分可避免高并发时 LLM 长耗时请求占满线程池，导致轻量 I/O 操作排队。

便捷函数 ``run_in_agent_executor`` / ``run_in_agent_io_executor`` 自动在
执行前后调用 ``close_old_connections()``，防止线程复用过期 DB 连接。
"""

from __future__ import annotations

import asyncio
import atexit
import functools
import logging
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, TypeVar

from django.conf import settings

T = TypeVar("T")

logger = logging.getLogger(__name__)

_agent_executor: ThreadPoolExecutor | None = None
_agent_io_executor: ThreadPoolExecutor | None = None
_init_lock = threading.Lock()

AGENT_EXECUTOR_MAX_WORKERS_DEFAULT = 12
AGENT_IO_EXECUTOR_MAX_WORKERS_DEFAULT = 8


def _build_executor(
    setting_name: str,
    env_name: str,
    default: int,
    thread_prefix: str,
) -> ThreadPoolExecutor:
    max_workers = getattr(settings, setting_name, None)
    if max_workers is None:
        max_workers = int(os.environ.get(env_name, default))
    executor = ThreadPoolExecutor(
        max_workers=max_workers,
        thread_name_prefix=thread_prefix,
    )
    atexit.register(executor.shutdown, wait=False)
    logger.info("[AgentExecutor] %s initialized with max_workers=%d", thread_prefix, max_workers)
    return executor


def get_agent_executor() -> ThreadPoolExecutor:
    """LLM 密集型线程池（惰性单例）。"""
    global _agent_executor
    if _agent_executor is not None:
        return _agent_executor
    with _init_lock:
        if _agent_executor is not None:
            return _agent_executor
        _agent_executor = _build_executor(
            "AGENT_EXECUTOR_MAX_WORKERS",
            "AGENT_EXECUTOR_MAX_WORKERS",
            AGENT_EXECUTOR_MAX_WORKERS_DEFAULT,
            "agent-llm",
        )
    return _agent_executor


def get_agent_io_executor() -> ThreadPoolExecutor:
    """I/O 密集型线程池（惰性单例）。"""
    global _agent_io_executor
    if _agent_io_executor is not None:
        return _agent_io_executor
    with _init_lock:
        if _agent_io_executor is not None:
            return _agent_io_executor
        _agent_io_executor = _build_executor(
            "AGENT_IO_EXECUTOR_MAX_WORKERS",
            "AGENT_IO_EXECUTOR_MAX_WORKERS",
            AGENT_IO_EXECUTOR_MAX_WORKERS_DEFAULT,
            "agent-io",
        )
    return _agent_io_executor


def _db_safe_wrapper(fn: Callable[..., T], *args: Any) -> T:
    from django.db import close_old_connections
    close_old_connections()
    try:
        return fn(*args)
    finally:
        close_old_connections()


async def run_in_agent_executor(fn: Callable[..., T], *args: Any) -> T:
    """在 LLM 线程池中执行 fn，自动清理 DB 连接。"""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        get_agent_executor(),
        functools.partial(_db_safe_wrapper, fn, *args),
    )


async def run_in_agent_io_executor(fn: Callable[..., T], *args: Any) -> T:
    """在 I/O 线程池中执行 fn，自动清理 DB 连接。"""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        get_agent_io_executor(),
        functools.partial(_db_safe_wrapper, fn, *args),
    )


def _fire_and_forget_done_callback(future: Any) -> None:
    """Future 完成回调：确保后台任务的异常进入应用日志。"""
    try:
        exc = future.exception()
    except Exception:
        return
    if exc is not None:
        logger.error(
            "[AgentExecutor] fire-and-forget task failed: %s",
            exc, exc_info=exc,
        )


def fire_and_forget_in_agent_executor(fn: Callable[..., Any], *args: Any) -> None:
    """提交 fn 到 LLM 线程池，不等待结果（fire-and-forget）。

    用于 HTTP 异步分发场景：参数校验后立即返回 HTTP 响应，
    Agent 执行在后台线程池中完成，结果通过 WS 推送。

    传入的 fn 应自行捕获业务异常并通过 WS 推送错误事件。
    本函数通过 done_callback 兜底记录未捕获的异常到日志。
    """
    future = get_agent_executor().submit(_db_safe_wrapper, fn, *args)
    future.add_done_callback(_fire_and_forget_done_callback)
