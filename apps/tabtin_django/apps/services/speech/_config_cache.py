"""
Speech 服务配置缓存

ASR / TTS factory 的 _try_load_from_db 每次创建服务实例都要执行 2 次 DB 查询
（LLMProvider + LLMModel）。在 WS streaming 场景下（每个用户录音/合成都触发），
这是热路径。

本模块提供一个带 TTL 的线程安全内存缓存，按 (service, provider, mode) 三元组缓存
已解析的 config 对象（frozen dataclass 或 dict）。

TTL 默认 60 秒：配置变更后最多 60 秒生效，在后台管理修改频率极低的场景下完全可接受。

改进点：
  - per-key 锁：不同 key 的 loader 互不阻塞
  - stale-while-revalidate：TTL 过期时，只有一个线程去刷新，其他线程返回旧值
  - 泛型类型：支持 frozen dataclass（直接返回）和 dict（deepcopy 返回）
"""

from __future__ import annotations

import copy
import dataclasses
import logging
import threading
import time
from typing import Any, Callable, Optional, TypeVar

logger = logging.getLogger(__name__)

T = TypeVar("T")

_DEFAULT_TTL = 60  # seconds

_meta_lock = threading.Lock()
_key_locks: dict[str, threading.Lock] = {}
_store: dict[str, tuple[float, Any]] = {}


def _get_key_lock(cache_key: str) -> threading.Lock:
    with _meta_lock:
        lock = _key_locks.get(cache_key)
        if lock is None:
            lock = threading.Lock()
            _key_locks[cache_key] = lock
        return lock


def _safe_copy(value: T) -> T:
    """frozen dataclass 直接返回；dict 等可变类型做 deepcopy。"""
    if value is None:
        return value  # type: ignore[return-value]
    if dataclasses.is_dataclass(value) and getattr(value, "__dataclass_params__", None):
        if value.__dataclass_params__.frozen:
            return value
    return copy.deepcopy(value)


def get_cached_config(
    cache_key: str,
    loader: Callable[[], Optional[T]],
    ttl: int = _DEFAULT_TTL,
) -> Optional[T]:
    """
    获取缓存的配置。缓存命中且未过期则直接返回；否则调用 loader 重新加载。

    - per-key 锁：不同 cache_key 的 loader 互不阻塞
    - stale-while-revalidate：TTL 过期后，竞争到锁的线程刷新缓存，
      未竞争到的线程立即返回过期数据（而非阻塞等待）
    - frozen dataclass 直接返回（不可变），dict 返回 deepcopy

    Args:
        cache_key: 缓存键，如 "asr:bytedance:flash"
        loader: 无参函数，返回 config 对象或 None
        ttl: 缓存有效期（秒）

    Returns:
        config 对象，或 None（loader 返回 None 也会被缓存，避免穿透）
    """
    now = time.monotonic()

    entry = _store.get(cache_key)
    if entry is not None:
        expire_at, cached = entry
        if now < expire_at:
            return _safe_copy(cached)

        lock = _get_key_lock(cache_key)
        if not lock.acquire(blocking=False):
            return _safe_copy(cached)
        try:
            entry2 = _store.get(cache_key)
            if entry2 is not None and time.monotonic() < entry2[0]:
                return _safe_copy(entry2[1])
            result = loader()
            _store[cache_key] = (time.monotonic() + ttl, result)
            return _safe_copy(result)
        finally:
            lock.release()

    lock = _get_key_lock(cache_key)
    with lock:
        entry = _store.get(cache_key)
        if entry is not None:
            return _safe_copy(entry[1])
        result = loader()
        _store[cache_key] = (time.monotonic() + ttl, result)
        return _safe_copy(result)


def invalidate(cache_key: Optional[str] = None) -> None:
    """
    手动失效缓存。

    Args:
        cache_key: 指定 key 失效；为 None 则清空全部缓存。
    """
    with _meta_lock:
        if cache_key is None:
            _store.clear()
        else:
            _store.pop(cache_key, None)
