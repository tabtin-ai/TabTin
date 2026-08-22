"""
relay_memory_trigger — 基于 relay 事件的记忆抽取触发器。

M3.5 改造：MemoryObserver 原本挂在 builtin ReAct 循环的中间件 hook 上
（after_iteration / after_agent / before_compaction），M5 删除 NativeReactLoop
后这些 hook 消失。本模块替代中间件 hook，改为由 relay 事件驱动记忆抽取。

触发点映射：
  L2（增量提取）← lifecycle phase=end  — Agent 一次 run 结束
  L3（压缩前快照）← compaction phase=start — runtime 开始压缩

数据源：MySQL ChatMessage（权威），非 in-memory state。
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


def dispatch_memory_trigger(
    *,
    session_id: str,
    thread_id: str,
    user_id: str,
    accepted_events: List[Dict[str, Any]],
) -> None:
    """从 relay 接受的事件批次中检测记忆触发条件，异步分发 Celery 任务。

    由 relay_handler 在 ACK 之后调用（fire-and-forget）。
    内部捕获全部异常，绝不影响 relay 主流程。
    """
    try:
        _dispatch_impl(
            session_id=session_id,
            thread_id=thread_id,
            user_id=user_id,
            accepted_events=accepted_events,
        )
    except Exception:
        logger.warning(
            "[RelayMemoryTrigger] dispatch failed (non-fatal): session=%s",
            session_id, exc_info=True,
        )


def _dispatch_impl(
    *,
    session_id: str,
    thread_id: str,
    user_id: str,
    accepted_events: List[Dict[str, Any]],
) -> None:
    has_lifecycle_end = False
    has_compaction_start = False

    for evt in accepted_events:
        short = _short_name(evt)
        payload = evt.get("payload") or {}

        if short == "lifecycle" and payload.get("phase") == "end":
            has_lifecycle_end = True
        elif short == "compaction" and payload.get("phase") == "start":
            has_compaction_start = True

    if has_compaction_start:
        _trigger_l3_compaction_snapshot(
            session_id=session_id,
            thread_id=thread_id,
            user_id=user_id,
        )

    if has_lifecycle_end:
        _trigger_l2_incremental_extract(
            session_id=session_id,
            thread_id=thread_id,
            user_id=user_id,
        )


def _trigger_l2_incremental_extract(
    *,
    session_id: str,
    thread_id: str,
    user_id: str,
) -> None:
    """L2 增量记忆抽取：lifecycle phase=end 时触发。

    从 ChatMessage 读取 memory_extracted_index 之后的新消息，
    提交 extract_memories_task Celery 任务。
    """
    ctx = _resolve_memory_ctx_from_session(session_id, user_id)
    if ctx is None:
        return

    space_id = ctx["space_id"]
    selected_model_id = ctx.get("selected_model_id", "")
    memory_config = ctx["memory_config"]
    observer_config = memory_config.get("observer", {})

    if observer_config.get("mode") == "off":
        return

    extracted_index = _get_extracted_index(thread_id)
    messages = _fetch_messages_from_db(session_id, offset=extracted_index)

    interval = observer_config.get("incremental_interval", 10)

    cold_start = _is_cold_start(space_id)
    if cold_start:
        interval = min(interval, 3)

    signals = _detect_memory_signals(messages)
    has_priority = _has_l1_priority_signals(signals)

    if len(messages) < interval and not has_priority:
        logger.debug(
            "[RelayMemoryTrigger:L2] Skip: new_count=%d < interval=%d session=%s signals=%d",
            len(messages), interval, session_id, len(signals),
        )
        return

    from apps.services.agent_engine.utils.memory_utils import serialize_messages
    from apps.services.agent_engine.utils.memory_constants import DEFAULT_DEDUP_THRESHOLD

    dedup_threshold = observer_config.get("dedup_threshold", DEFAULT_DEDUP_THRESHOLD)
    override_detection = observer_config.get("override_detection", True)
    capture_mode = _resolve_capture_mode(observer_config.get("mode", "auto"), signals)
    signals_json = json.dumps(signals, ensure_ascii=False) if signals else ""

    new_index = extracted_index + len(messages)

    try:
        from celery import chord
        from apps.services.agent_engine.tasks.memory.capture import (
            advance_memory_index_task,
            build_memory_capture_event_id,
            extract_memories_task,
        )
        tasks = []
        for agent_id, agent_messages in _group_messages_by_agent(messages).items():
            serialized = serialize_messages(agent_messages)
            capture_event_id = build_memory_capture_event_id(
                thread_id=thread_id,
                start_index=extracted_index,
                end_index=new_index,
                agent_id=agent_id,
            )
            tasks.append(extract_memories_task.s(
                space_id=space_id,
                user_id=user_id,
                thread_id=thread_id,
                messages=serialized,
                dedup_threshold=dedup_threshold,
                capture_mode=capture_mode,
                signals=signals_json,
                override_detection=override_detection,
                agent_id=agent_id,
                selected_model_id=selected_model_id,
                capture_event_id=capture_event_id,
            ))
        if not tasks:
            return
        chord(tasks)(advance_memory_index_task.s(thread_id, new_index))
        logger.info(
            "[RelayMemoryTrigger:L2] Submitted extraction: session=%s "
            "new_msgs=%d [%d:%d] signals=%d capture_mode=%s",
            session_id, len(messages), extracted_index, new_index,
            len(signals), capture_mode,
        )
    except Exception as exc:
        logger.warning(
            "[RelayMemoryTrigger:L2] Failed to submit task: %s", exc,
        )


def _trigger_l3_compaction_snapshot(
    *,
    session_id: str,
    thread_id: str,
    user_id: str,
) -> None:
    """L3 压缩前快照：compaction phase=start 时触发。

    确保 extracted_index 之前的未提取消息在压缩前得到处理。
    Django ChatMessage 是权威源，消息不会被客户端压缩删除，
    但提前触发能确保记忆覆盖被 runtime 丢弃的旧上下文。
    """
    ctx = _resolve_memory_ctx_from_session(session_id, user_id)
    if ctx is None:
        return

    space_id = ctx["space_id"]
    selected_model_id = ctx.get("selected_model_id", "")
    extracted_index = _get_extracted_index(thread_id)

    total_msg_count = _count_messages(session_id)
    if total_msg_count <= extracted_index:
        return

    unextracted = _fetch_messages_from_db(session_id, offset=extracted_index)
    if not unextracted:
        return

    from apps.services.agent_engine.utils.memory_utils import serialize_messages
    from apps.services.agent_engine.utils.memory_constants import DEFAULT_DEDUP_THRESHOLD

    dedup_threshold = ctx["memory_config"].get(
        "observer", {},
    ).get("dedup_threshold", DEFAULT_DEDUP_THRESHOLD)
    observer_config = ctx["memory_config"].get("observer", {})
    override_detection = observer_config.get("override_detection", True)
    signals = _detect_memory_signals(unextracted)
    capture_mode = _resolve_capture_mode(observer_config.get("mode", "auto"), signals)
    signals_json = json.dumps(signals, ensure_ascii=False) if signals else ""

    try:
        from celery import chord
        from apps.services.agent_engine.tasks.memory.capture import (
            advance_memory_index_task,
            build_memory_capture_event_id,
            extract_memories_task,
        )
        end_index = extracted_index + len(unextracted)
        tasks = []
        for agent_id, agent_messages in _group_messages_by_agent(unextracted).items():
            capture_event_id = build_memory_capture_event_id(
                thread_id=thread_id,
                start_index=extracted_index,
                end_index=end_index,
                agent_id=agent_id,
            )
            tasks.append(extract_memories_task.s(
                space_id=space_id,
                user_id=user_id,
                thread_id=thread_id,
                messages=serialize_messages(agent_messages),
                dedup_threshold=dedup_threshold,
                capture_mode=capture_mode,
                signals=signals_json,
                override_detection=override_detection,
                agent_id=agent_id,
                selected_model_id=selected_model_id,
                capture_event_id=capture_event_id,
            ))
        if not tasks:
            return
        chord(tasks)(
            advance_memory_index_task.s(
                thread_id,
                extracted_index + len(unextracted),
            )
        )
        logger.info(
            "[RelayMemoryTrigger:L3] Compaction snapshot submitted: "
            "session=%s unextracted=%d signals=%d capture_mode=%s",
            session_id, len(unextracted), len(signals), capture_mode,
        )
    except Exception as exc:
        logger.warning(
            "[RelayMemoryTrigger:L3] Failed to submit task: %s", exc,
        )


# ── Helper functions ──────────────────────────────────────────────────

# explicit_forget 暂不列入优先级信号（bugbot 评审  medium）：capture 侧对
# forget 仅打日志、未实现删除/supersede，也不会强制 capture_mode=auto。若让它绕过
# incremental_interval 立即触发 L2 提取，用户说「别再记…」时反而白跑一轮 LLM 提取，
# selective 模式下甚至可能写入/强化本应被遗忘的内容。等 forget 真删逻辑落地后再纳入。
_L1_PRIORITY_SIGNAL_TYPES = frozenset({"explicit_remember", "correction"})


def _detect_memory_signals(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """L1 零成本信号检测：扫描本轮新消息中的 remember/forget/correction 等信号。"""
    if not messages:
        return []
    from apps.services.agent_engine.utils.memory_signal import MemorySignalDetector
    return MemorySignalDetector().detect(messages, last_index=0)


def _has_l1_priority_signals(signals: List[Dict[str, Any]]) -> bool:
    """L1 优先级信号可绕过 incremental_interval 门槛，立即触发 L2 提取。"""
    return any(
        isinstance(s, dict) and s.get("type") in _L1_PRIORITY_SIGNAL_TYPES
        for s in signals
    )


def _resolve_capture_mode(observer_mode: str, signals: List[Dict[str, Any]]) -> str:
    """根据 observer 配置与 L1 信号决定 capture_mode。"""
    signal_types = {
        s.get("type") for s in signals if isinstance(s, dict)
    }
    if signal_types & {"explicit_remember", "correction"}:
        return "auto"
    if observer_mode in ("auto", "selective"):
        return observer_mode
    return "auto"


_STREAM_PREFIX = "agent.stream."


def _short_name(evt: dict) -> str:
    event_type = evt.get("type", "")
    if event_type.startswith(_STREAM_PREFIX):
        return event_type[len(_STREAM_PREFIX):]
    return event_type


def _resolve_memory_ctx_from_session(
    session_id: str,
    user_id: str,
) -> Optional[Dict[str, Any]]:
    """从 session_id 解析 memory 上下文（space_id + memory_config）。

    检查 Space 是否启用 memory，返回 None 表示无需记忆抽取。
    """
    try:
        from apps.chat.conversation.models import ChatSession
        session = ChatSession.objects.select_related("agent", "workspace").filter(id=session_id).only(
            "workspace_id", "workspace__organization_id", "agent__agent_config",
        ).first()
        if not session or not session.workspace_id:
            return None

        workspace_id = str(session.workspace_id)
        space_id = workspace_id
        organization_id = str(session.workspace.organization_id)
        agent_config = (
            session.agent.agent_config
            if session.agent and isinstance(session.agent.agent_config, dict)
            else {}
        )
    except Exception:
        logger.debug(
            "[RelayMemoryTrigger] session lookup failed: %s",
            session_id, exc_info=True,
        )
        return None

    try:
        from apps.agent_memory.workspace_memory_execution import (
            resolve_workspace_memory_dispatch,
        )

        execution = resolve_workspace_memory_dispatch(
            scene_key="memory_capture",
            organization_id=organization_id,
            user_id=user_id,
        )
        if not execution.enabled:
            return None

        from apps.services.agent_engine.services.memory_table_service import (
            MemoryTableService,
        )
        if not MemoryTableService.is_memory_enabled_for_organization(
            user_id,
            organization_id,
        ):
            return None

        memory_config = MemoryTableService.get_memory_config(agent_config)
        return {
            "space_id": space_id,
            "workspace_id": workspace_id,
            "memory_config": memory_config,
            "selected_model_id": execution.selected_model_id,
        }
    except Exception:
        logger.debug(
            "[RelayMemoryTrigger] memory ctx resolve failed: space=%s",
            session_id, exc_info=True,
        )
        return None


def _get_extracted_index(thread_id: str) -> int:
    if not thread_id:
        return 0
    try:
        from apps.chat.conversation.models import ChatSession
        session = ChatSession.objects.filter(thread_id=thread_id).only(
            "memory_extracted_index",
        ).first()
        return session.memory_extracted_index if session else 0
    except Exception:
        return 0


def _fetch_messages_from_db(
    session_id: str,
    *,
    offset: int = 0,
) -> List[Dict[str, str]]:
    """从 ChatMessage 读取指定 offset 之后的主对话消息，按 created_at 排序。

    ：正文取自 ``content_blocks_json`` 的完整 text 块（
    ``plaintext_for_memory_capture`` / ``derive_full_text_content``），
    **不用** ``text_summary``（仅 200 字列表摘要）；无 text 块则跳过该行，
    不做 text_summary 回退。

    - 用户消息：完整 text，自然排除 image/document/file 等附件块
    - Agent 消息：完整面向用户的 text，自然排除 thinking / tool_use / tool_result
    - 仅 ``message_kind=llm``，跳过 environment_context 等内部行
      （capture 输入边界在此收口；共享 ``serialize_messages`` 仍保留 tool 行
      供 L4 task_summary）

    返回 [{role, content, agent_id}, ...] 供 serialize_messages 处理。
    """
    try:
        from apps.chat.conversation.models import ChatMessage
        from apps.services.agent_engine.utils.memory_utils import (
            plaintext_for_memory_capture,
        )

        qs = ChatMessage.objects.filter(
            session_id=session_id,
            role__in=("user", "assistant"),
            message_kind="llm",
        ).order_by("created_at").values(
            "role", "content_blocks_json", "agent_id",
        )

        result: List[Dict[str, str]] = []
        for m in qs[offset:]:
            content = plaintext_for_memory_capture(m.get("content_blocks_json"))
            if not content:
                continue
            result.append({
                "role": m["role"],
                "content": content,
                "agent_id": str(m["agent_id"]) if m.get("agent_id") else "",
            })
        return result
    except Exception as exc:
        logger.warning(
            "[RelayMemoryTrigger] fetch messages failed: session=%s error=%s",
            session_id, exc,
        )
        return []


def _group_messages_by_agent(
    messages: List[Dict[str, str]],
) -> Dict[str, List[Dict[str, str]]]:
    """按实际回复者分账；用户消息归入紧随其后的 assistant 轮。"""
    groups: Dict[str, List[Dict[str, str]]] = {}
    pending: List[Dict[str, str]] = []
    for message in messages:
        pending.append(message)
        if message.get("role") != "assistant":
            continue
        agent_id = message.get("agent_id") or ""
        if not agent_id:
            pending = []
            continue
        groups.setdefault(agent_id, []).extend(pending)
        pending = []
    return groups


def _count_messages(session_id: str) -> int:
    try:
        from apps.chat.conversation.models import ChatMessage
        return ChatMessage.objects.filter(
            session_id=session_id,
            role__in=("user", "assistant"),
            message_kind="llm",
        ).count()
    except Exception:
        return 0


def _is_cold_start(space_id: str) -> bool:
    try:
        from apps.chat.conversation.models import ChatSession
        count = ChatSession.objects.filter(
            workspace_id=space_id, memory_settled=True,
        ).count()
        return count < 3
    except Exception:
        return False
