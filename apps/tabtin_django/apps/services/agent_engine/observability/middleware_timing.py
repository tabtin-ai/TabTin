"""Middleware timing 持久化到 TraceEvent。

在每次 run 结束时，将 state["_middleware_timing"] 中累积的中间件耗时
写入 TraceEvent (event_type="middleware_timing")，使得：
1. AdminDash API 可从 trace events 查询（而非从 state 中读取）
2. state 不再需要持久化 _middleware_timing，减少膨胀
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


def flush_middleware_timing(state: dict) -> Optional[int]:
    """将 state 中累积的 _middleware_timing 写入 TraceEvent。

    Returns:
        event_id (int | None) — 如果 trace 上下文存在则返回 event_id
    """
    timing = state.get("_middleware_timing")
    if not timing:
        return None

    try:
        from apps.services.common.observability.trace import TraceRecorder
    except Exception:
        return None

    total_ms = 0.0
    for hook_data in timing.values():
        if isinstance(hook_data, dict):
            total_ms += sum(
                v for v in hook_data.values() if isinstance(v, (int, float))
            )

    event_id = TraceRecorder.record_event(
        event_type="middleware_timing",
        name="middleware_timing.summary",
        input_data=timing,
        output_data={"total_ms": round(total_ms, 2)},
    )
    if event_id is None:
        logger.debug(
            "[MiddlewareTiming] flush 跳过：无 active trace（可能是非 API 调用场景）"
        )
    return event_id


def load_middleware_timing_from_trace(trace_id: str) -> Dict[str, Any]:
    """从 TraceEvent 加载 middleware timing 数据。

    优先从 event 读取，若不存在则从 state 回退。
    """
    try:
        from apps.services.agent_engine.models import ExecutionTrace, TraceEvent

        trace = ExecutionTrace.objects.filter(trace_id=trace_id).first()
        if not trace:
            return {}

        event = (
            TraceEvent.objects
            .filter(trace=trace, event_type="middleware_timing")
            .order_by("-seq")
            .first()
        )
        if event and event.input:
            return event.input

        # 迁移过渡回退：Round 11 之前的旧 trace 可能仍将 timing 存于 state。
        # 一旦 thread 被新 run 保存，_EXCLUDED_STATE_KEYS 会清除此字段，此路径失效。
        from apps.services.agent_engine.persistence.conversation_store import ConversationStore
        # ATK-3: 仅由 superuser 专用的 agentdash API 调用，不传 expected_user_id
        state = ConversationStore.load_state(trace.thread_id)
        return (state or {}).get("_middleware_timing") or {}

    except Exception:
        logger.debug("[MiddlewareTiming] Failed to load timing for trace %s", trace_id, exc_info=True)
        return {}


__all__ = ["flush_middleware_timing", "load_middleware_timing_from_trace"]
