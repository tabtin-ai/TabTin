"""relay LLM 快照写入器——`agent.stream.llm_snapshot` → `chat_llm_snapshot`。

本地 `snapshots.jsonl`（每次 LLM 调用的完整入参：system prompt 分段 + messages
摘要 + 工具 inputSchema + 事后补发的 response 元信息）经 relay 上云的落库端。

设计（与 `relay_audit_writer.spawn_audit_writes` 同模式）：
  - **detail 级 fire-and-forget**：不阻塞 relay ACK、失败不 NAK（快照是观测
    数据，丢一条不影响对话正确性；客户端无重试义务）。
  - **不进 TraceEvent**：快照体大（可达数百 KB），`llm_snapshot` 已加进
    `EXCLUDED_FROM_TRACE`；relay_handler 循环单独截获交给本模块。
  - **不广播**：含内部 system prompt / 工具 schema，publish 跳过（与
    persist_message 同款豁免）。
  - **幂等**：`(session_id, run_id, iteration)` 唯一键 `update_or_create`——
    relay 重试重放覆盖；带 response 的后到快照覆盖先到的纯请求快照。
"""

import asyncio
import logging
from typing import Any, Dict

from channels.db import database_sync_to_async

logger = logging.getLogger(__name__)

# 单条快照落库上限（字节，JSON 序列化后估算）。WS 整帧上限 1MB，正常快照不会
# 超；防御性兜底：超限时丢弃 tools/messages 明细只留计数，避免异常客户端
# 把超大行写进 PG。
_MAX_SNAPSHOT_JSON_BYTES = 900_000


def _persist_llm_snapshot(session_id: str, thread_id: str, payload: Dict[str, Any]) -> None:
    from apps.chat.conversation.models import ChatLLMSnapshot

    run_id = str(payload.get("runId") or payload.get("run_id") or "").strip()
    if not run_id:
        logger.warning(
            "[RelayLLMSnapshotWriter] drop snapshot without runId: session=%s", session_id,
        )
        return
    iteration_raw = payload.get("iteration")
    iteration = iteration_raw if isinstance(iteration_raw, int) else 0
    model = str(payload.get("model") or "")[:128]

    snapshot = _cap_snapshot_size(payload)

    ChatLLMSnapshot.objects.update_or_create(
        session_id=session_id,
        run_id=run_id[:64],
        iteration=iteration,
        defaults={
            "thread_id": str(thread_id or "")[:128],
            "model": model,
            "snapshot_json": snapshot,
        },
    )


def _cap_snapshot_size(payload: Dict[str, Any]) -> Dict[str, Any]:
    """超限兜底：正常快照原样入库；异常超大快照丢明细留摘要。"""
    import json

    try:
        size = len(json.dumps(payload, ensure_ascii=False))
    except (TypeError, ValueError):
        return {"truncated_in_server": True, "reason": "unserializable"}
    if size <= _MAX_SNAPSHOT_JSON_BYTES:
        return payload
    capped = dict(payload)
    capped.pop("messages", None)
    capped.pop("tools", None)
    capped.pop("system", None)
    capped["truncated_in_server"] = True
    capped["original_json_bytes"] = size
    return capped


_async_persist_llm_snapshot = database_sync_to_async(
    _persist_llm_snapshot, thread_sensitive=False,
)


# ── 后台 task 池（与 relay_audit_writer._BACKGROUND_AUDIT_TASKS 模式对称） ──

_BACKGROUND_SNAPSHOT_TASKS: set[asyncio.Task] = set()
_MAX_BACKGROUND_SNAPSHOT_TASKS = 200


def spawn_llm_snapshot_writes(
    session_id: str,
    thread_id: str,
    snapshot_events: list[Dict[str, Any]],
) -> int:
    """fire-and-forget 异步写一批 llm_snapshot 事件。返回实际启动的 task 数。"""
    started = 0
    for evt in snapshot_events:
        if not isinstance(evt, dict):
            continue
        payload = evt.get("payload") or {}
        if not isinstance(payload, dict):
            continue

        if len(_BACKGROUND_SNAPSHOT_TASKS) >= _MAX_BACKGROUND_SNAPSHOT_TASKS:
            logger.warning(
                "[RelayLLMSnapshotWriter] task pool full: capacity=%d dropped session=%s",
                _MAX_BACKGROUND_SNAPSHOT_TASKS, session_id,
            )
            continue

        coro = _async_persist_llm_snapshot(session_id, thread_id, payload)

        async def _run(c=coro, sid=session_id):
            try:
                await c
            except Exception:
                logger.warning(
                    "[RelayLLMSnapshotWriter] background persist exception: session=%s",
                    sid, exc_info=True,
                )

        task = asyncio.create_task(_run(), name=f"llm_snapshot_{session_id[:8]}")
        _BACKGROUND_SNAPSHOT_TASKS.add(task)
        task.add_done_callback(_BACKGROUND_SNAPSHOT_TASKS.discard)
        started += 1
    return started


__all__ = ["spawn_llm_snapshot_writes"]
