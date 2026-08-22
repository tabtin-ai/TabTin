"""S4: 工具结果落盘与 Message 级预算。

当单个工具结果超过阈值时，将完整内容存入外部存储，
消息中替换为简短预览，避免截断导致信息永久丢失。

存储策略（按优先级）：
1. Redis（via Django cache）: key = tool_result:{run_id}:{tool_call_id}, TTL = 24h
2. Fallback: state["_tool_result_store"]（Redis 不可用时）
"""

from __future__ import annotations

import logging
from typing import Optional

from django.conf import settings

logger = logging.getLogger(__name__)

DEFAULT_PERSIST_THRESHOLD_CHARS = 40_000

_PREVIEW_HEAD_CHARS = 2000

_PREVIEW_TAIL_CHARS = 1000

def _max_stored_results() -> int:
    from apps.services.agent_engine.configuration import OrchestrationConfiguration
    return OrchestrationConfiguration.from_settings().tool_result_store_max_entries

_MAX_ARCHIVED_INDEX_ENTRIES = 50

_REDIS_TTL_SECONDS = 86_400  # 24h — condense/compaction 可能在长会话中回读完整结果

_CACHE_KEY_PREFIX = "tool_result"


def _get_threshold() -> int:
    return getattr(settings, "TOOL_RESULT_PERSIST_THRESHOLD_CHARS", DEFAULT_PERSIST_THRESHOLD_CHARS)


def _make_cache_key(run_id: str, tool_call_id: str) -> str:
    return f"{_CACHE_KEY_PREFIX}:{run_id}:{tool_call_id}"


def _try_redis_set(run_id: str, tool_call_id: str, content: str) -> bool:
    """尝试将内容写入 Redis。成功返回 True。"""
    if not run_id:
        return False
    try:
        from django.core.cache import cache
        key = _make_cache_key(run_id, tool_call_id)
        cache.set(key, content, timeout=_REDIS_TTL_SECONDS)
        return True
    except Exception:
        logger.warning(
            "[ToolResultStorage] Redis write failed, falling back to state",
            exc_info=True,
        )
        return False


def _try_redis_get(run_id: str, tool_call_id: str) -> Optional[str]:
    """尝试从 Redis 获取内容。失败返回 None。"""
    if not run_id:
        return None
    try:
        from django.core.cache import cache
        key = _make_cache_key(run_id, tool_call_id)
        return cache.get(key)
    except Exception:
        logger.debug(
            "[ToolResultStorage] Redis read failed",
            exc_info=True,
        )
        return None


def _fallback_store_to_state(
    tool_call_id: str,
    content: str,
    state: dict,
) -> None:
    """Fallback: 将结果存入 state["_tool_result_store"]（原有行为）。"""
    store: dict = state.setdefault("_tool_result_store", {})

    _max = _max_stored_results()
    if len(store) >= _max and tool_call_id not in store:
        referenced_ids: Optional[set] = None
        evicted = 0
        while len(store) >= _max:
            oldest_key = next(iter(store), None)
            if oldest_key is None:
                break
            if referenced_ids is None:
                referenced_ids = {
                    m.get("tool_call_id")
                    for m in state.get("messages", [])
                    if isinstance(m, dict) and m.get("role") == "tool"
                }
            if oldest_key in referenced_ids:
                val = store.pop(oldest_key)
                store[oldest_key] = val
                evicted += 1
                if evicted >= len(store):
                    oldest_key = next(iter(store))
                    del store[oldest_key]
                    logger.warning(
                        "tool_result_store: force-evicted referenced entry %s",
                        oldest_key,
                    )
                    break
                continue
            del store[oldest_key]
            logger.debug(
                "[ToolResultStorage] Evicted stale result: id=%s (store size was %d)",
                oldest_key, len(store) + 1,
            )
            break

    store[tool_call_id] = content


def maybe_persist_large_result(
    tool_call_id: str,
    tool_name: str,
    content: str,
    state: dict,
    threshold: int | None = None,
    run_id: str = "",
) -> str:
    """如果 *content* 超过阈值，将完整内容存入外部存储，
    返回替换后的简短预览；否则原样返回。

    存储优先级：Redis → state fallback。
    同时维护 ``state["_archived_result_index"]`` 索引，供按工具名回溯查找。

    预览格式::

        [工具结果已存档: {tool_name} | tool_call_id={tool_call_id}]
        --- 前 2000 字符 ---
        {content[:2000]}
        --- 后 1000 字符 ---
        {content[-1000:]}
        --- 共 {N} 字符，使用 retrieve_tool_result 工具获取完整内容 ---
    """
    if threshold is None:
        threshold = _get_threshold()

    if len(content) <= threshold:
        return content

    if not run_id:
        run_id = state.get("run_id", "")

    redis_ok = _try_redis_set(run_id, tool_call_id, content)
    if not redis_ok:
        _fallback_store_to_state(tool_call_id, content, state)

    total_chars = len(content)
    head_text = content[:_PREVIEW_HEAD_CHARS]
    tail_text = content[-_PREVIEW_TAIL_CHARS:]

    # 维护按工具名查找的索引
    index: list = state.setdefault("_archived_result_index", [])
    index.append({
        "tool_name": tool_name,
        "tool_call_id": tool_call_id,
        "size": total_chars,
    })
    if len(index) > _MAX_ARCHIVED_INDEX_ENTRIES:
        del index[: len(index) - _MAX_ARCHIVED_INDEX_ENTRIES]

    storage_backend = "redis" if redis_ok else "state"
    logger.info(
        "[ToolResultStorage] Persisted large result: tool=%s id=%s size=%d chars backend=%s",
        tool_name, tool_call_id, total_chars, storage_backend,
    )

    return (
        f"[工具结果已存档: {tool_name} | tool_call_id={tool_call_id}]\n"
        f"--- 前 {_PREVIEW_HEAD_CHARS} 字符 ---\n"
        f"{head_text}\n"
        f"--- 后 {_PREVIEW_TAIL_CHARS} 字符 ---\n"
        f"{tail_text}\n"
        f"--- 共 {total_chars} 字符，使用 retrieve_tool_result 工具获取完整内容 ---"
    )


def get_persisted_result(
    tool_call_id: str,
    state: dict,
    run_id: str = "",
) -> Optional[str]:
    """获取落盘的完整结果（供后续需要时使用）。

    查找优先级：Redis → state fallback。

    Returns:
        完整内容字符串，若未找到则返回 None。
    """
    if not run_id:
        run_id = state.get("run_id", "")

    result = _try_redis_get(run_id, tool_call_id)
    if result is not None:
        return result

    store: dict = state.get("_tool_result_store", {})
    return store.get(tool_call_id)


def get_persisted_result_by_name(
    tool_name: str,
    recency: int,
    state: dict,
    run_id: str = "",
) -> Optional[str]:
    """按工具名倒序查找第 *recency* 个存档结果。

    依赖 ``maybe_persist_large_result`` 维护的
    ``state["_archived_result_index"]`` 索引列表。

    Args:
        tool_name: 工具名称（如 ``execute_in_terminal``）。
        recency: 第几个最近的匹配（1 = 最近一次）。
        state: 引擎 state 字典。
        run_id: 当前 run ID，用于 Redis 查找。

    Returns:
        完整内容字符串，若未找到则返回 None。
    """
    index: list = state.get("_archived_result_index", [])
    matches = [
        entry for entry in reversed(index)
        if entry.get("tool_name") == tool_name
    ]
    if recency < 1 or recency > len(matches):
        return None
    target = matches[recency - 1]
    target_id = target.get("tool_call_id", "")
    if not target_id:
        return None
    return get_persisted_result(tool_call_id=target_id, state=state, run_id=run_id)
