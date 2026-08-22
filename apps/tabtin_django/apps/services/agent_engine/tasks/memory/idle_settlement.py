"""
L4 空闲结算 — 会话空闲超时后执行完整记忆提取 + 任务摘要生成

触发路径: Beat 定时扫描空闲 >= idle_timeout_minutes 的未结算 session

Beat 调度: 每 5 分钟扫描一次
"""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any, Dict, List, Optional

from apps.services.agent_engine.utils.memory_constants import DEFAULT_DEDUP_THRESHOLD

from celery import shared_task
from django.utils import timezone

logger = logging.getLogger(__name__)


@shared_task(
    bind=True,
    ignore_result=True,
    max_retries=2,
    default_retry_delay=30,
    time_limit=300,
    soft_time_limit=280,
)
def settle_idle_session_task(
    self,
    session_id: str,
    space_id: str,
    user_id: str,
    agent_id: str = "",
    selected_model_id: str = "",
    task_summary_skip_reason: str = "",
    memory_capture_model_id: str = "",
    task_summary_model_id: str = "",
):
    """对单个空闲 session 执行完整结算。

    ``selected_model_id`` 与 ``task_summary_skip_reason`` 仅保留给已入队旧消息做
    参数兼容，不再作为模型来源。缺少新的 Workspace 模型快照时必须 fail closed。
    """
    from apps.services.common.thread_context import clear_context
    from apps.services.agent_engine.utils.memory_locks import session_memory_lock

    clear_context()

    lock_timeout = settle_idle_session_task.time_limit + 60
    try:
        with session_memory_lock(session_id, timeout=lock_timeout) as acquired:
            if not acquired:
                logger.info(
                    "[Memory:L4] Lock contention session=%s, retry=%d/%d",
                    session_id, self.request.retries, self.max_retries,
                )
                raise self.retry(exc=RuntimeError(f"Lock contention for session {session_id}"))

            _do_full_settlement(
                session_id=session_id,
                space_id=space_id,
                user_id=user_id,
                agent_id=agent_id,
                memory_capture_model_id=memory_capture_model_id,
                task_summary_model_id=task_summary_model_id,
            )
    finally:
        clear_context()


def _do_full_settlement(
    session_id: str,
    space_id: str,
    user_id: str,
    agent_id: str = "",
    memory_capture_model_id: str = "",
    task_summary_model_id: str = "",
) -> None:
    """完整结算流程: 增量提取 + 任务摘要 + 技能进化 + 标记已结算。

    分阶段标记：
    - 记忆提取成功 → 更新 memory_extracted_index
    - 任务摘要成功 → 标记 memory_settled=True
    任何阶段失败只标记已完成的部分，下次 Beat 会重试未完成的部分。
    """
    from apps.chat.conversation.models import ChatSession
    from apps.services.agent_engine.services.memory_table_service import MemoryTableService
    try:
        session = ChatSession.objects.select_related("agent", "workspace").get(
            thread_id=session_id,
        )
    except ChatSession.DoesNotExist:
        return

    if session.memory_settled:
        return

    if not session.workspace_id or not session.agent_id:
        return

    agent_config = (
        session.agent.agent_config
        if isinstance(session.agent.agent_config, dict)
        else {}
    )
    if not MemoryTableService.is_memory_enabled_for_organization(
        user_id,
        session.workspace.organization_id,
    ):
        return

    memory_config = MemoryTableService.get_memory_config(agent_config)

    messages = _load_session_messages(session_id)
    if not messages:
        ChatSession.objects.filter(thread_id=session_id).update(memory_settled=True)
        return

    extracted_index = session.memory_extracted_index
    extraction_ok = True
    summary_ok = True

    if extracted_index < len(messages) and memory_capture_model_id:
        try:
            _extract_remaining(
                space_id=space_id,
                user_id=user_id,
                session_id=session_id,
                messages=messages,
                extracted_index=extracted_index,
                dedup_threshold=memory_config.get("observer", {}).get("dedup_threshold", DEFAULT_DEDUP_THRESHOLD),
                selected_model_id=memory_capture_model_id,
            )
        except Exception as exc:
            extraction_ok = False
            logger.error(
                "[Memory:L4] Extraction failed, NOT marking settled: session=%s error=%s",
                session_id, exc,
            )
        else:
            extraction_ok = _update_extracted_index_with_retry(
                session_id, len(messages),
            )

    if _is_worth_summarizing(messages):
        if not task_summary_model_id:
            summary_ok = False
            logger.warning(
                "[Memory:L4] Task Summary missing Workspace model snapshot; "
                "fail closed: session=%s",
                session_id,
            )
        else:
            try:
                for executing_agent_id, agent_messages in _group_messages_by_agent(
                    messages,
                ).items():
                    if _is_worth_summarizing(agent_messages):
                        _generate_settlement_summary(
                            space_id=space_id,
                            user_id=user_id,
                            session_id=session_id,
                            messages=agent_messages,
                            agent_id=executing_agent_id,
                            selected_model_id=task_summary_model_id,
                        )
            except Exception as exc:
                summary_ok = False
                logger.error(
                    "[Memory:L4] Summary generation failed, NOT marking settled: "
                    "session=%s error=%s",
                    session_id,
                    exc,
                )
    else:
        logger.info(
            "[Memory:L4] Skipping summary (low-value conversation): session=%s msgs=%d",
            session_id, len(messages),
        )

    if extraction_ok and summary_ok:
        ChatSession.objects.filter(thread_id=session_id).update(
            memory_settled=True,
            memory_extracted_index=len(messages),
        )
        logger.info(
            "[Memory:L4] Full settlement completed: session=%s space=%s msgs=%d",
            session_id, space_id, len(messages),
        )
    else:
        logger.warning(
            "[Memory:L4] Partial settlement: session=%s extraction=%s summary=%s",
            session_id, extraction_ok, summary_ok,
        )



MIN_USER_MESSAGES_FOR_SUMMARY = 2
MIN_TOTAL_MESSAGES_FOR_SUMMARY = 4


def _is_worth_summarizing(messages: List[Dict[str, Any]]) -> bool:
    """判断对话是否值得生成 task_summary。

    过滤掉极短对话（如一句问候、简单问答）——朋友不会把每次打招呼都写进日记。
    """
    user_msgs = [m for m in messages if isinstance(m, dict) and m.get("role") == "user"]
    if len(user_msgs) < MIN_USER_MESSAGES_FOR_SUMMARY:
        return False
    if len(messages) < MIN_TOTAL_MESSAGES_FOR_SUMMARY:
        return False
    total_user_chars = sum(len(m.get("content", "") or "") for m in user_msgs)
    if total_user_chars < 20:
        return False
    return True


def _load_session_messages(session_id: str) -> List[Dict[str, Any]]:
    """从 ConversationState 加载完整消息列表。"""
    try:
        from apps.services.agent_engine.persistence.conversation_store import ConversationStore
        store = ConversationStore()
        state = store.load(session_id)
        return state.get("messages", []) if state else []
    except Exception as exc:
        logger.debug("[Memory:L4] Load messages failed for %s: %s", session_id, exc)
        return []


def _group_messages_by_agent(
    messages: List[Dict[str, Any]],
) -> Dict[str, List[Dict[str, Any]]]:
    groups: Dict[str, List[Dict[str, Any]]] = {}
    pending: List[Dict[str, Any]] = []
    for message in messages:
        pending.append(message)
        if message.get("role") != "assistant":
            continue
        agent_id = message.get("agent_id") or message.get("agentId") or ""
        if agent_id:
            groups.setdefault(str(agent_id), []).extend(pending)
        pending = []
    return groups


def _update_extracted_index_with_retry(
    session_id: str, new_index: int, max_retries: int = 2,
) -> bool:
    """PG 提取成功后更新 MySQL memory_extracted_index，带重试。

    FIX P1-72: PG 写成功 + MySQL 更新失败时，下次 Beat 会重复提取已入库的记忆。
    通过重试降低 MySQL 瞬时故障导致的不一致概率。
    """
    import time
    from apps.chat.conversation.models import ChatSession

    for attempt in range(max_retries + 1):
        try:
            ChatSession.objects.filter(thread_id=session_id).update(
                memory_extracted_index=new_index,
            )
            return True
        except Exception as exc:
            if attempt < max_retries:
                time.sleep(0.5 * (attempt + 1))
                logger.warning(
                    "[Memory:L4] MySQL index update retry %d/%d: session=%s error=%s",
                    attempt + 1, max_retries, session_id, exc,
                )
            else:
                logger.error(
                    "[Memory:L4] MySQL index update failed after %d attempts "
                    "(PG extraction already succeeded, risk of re-extraction): session=%s error=%s",
                    max_retries + 1, session_id, exc,
                )
                return False


def _extract_remaining(
    *,
    space_id: str,
    user_id: str,
    session_id: str,
    messages: list,
    extracted_index: int,
    dedup_threshold: float,
    selected_model_id: str = "",
) -> None:
    """同步执行剩余消息的记忆提取（L4 在 Celery worker 中运行，可同步）。"""
    from apps.services.agent_engine.utils.memory_utils import serialize_messages
    from apps.services.agent_engine.tasks.memory.capture import (
        _do_extract_memories,
        build_memory_capture_event_id,
    )

    new_messages = messages[extracted_index:]
    if not new_messages:
        return

    for agent_id, agent_messages in _group_messages_by_agent(new_messages).items():
        capture_event_id = build_memory_capture_event_id(
            thread_id=session_id,
            start_index=extracted_index,
            end_index=extracted_index + len(new_messages),
            agent_id=agent_id,
        )
        _do_extract_memories(
            None,
            space_id,
            user_id,
            session_id,
            serialize_messages(agent_messages),
            dedup_threshold,
            "auto",
            agent_id=agent_id,
            selected_model_id=selected_model_id,
            capture_event_id=capture_event_id,
        )


def _generate_settlement_summary(
    *,
    space_id: str,
    user_id: str,
    session_id: str,
    messages: list,
    agent_id: str = "",
    selected_model_id: str = "",
) -> None:
    """同步生成任务摘要。"""
    from apps.services.agent_engine.utils.memory_utils import serialize_messages
    from apps.services.agent_engine.tasks.memory.task_summary import _do_generate_task_summary

    HEAD_KEEP = 10
    TAIL_KEEP = 50
    if len(messages) > HEAD_KEEP + TAIL_KEEP:
        truncated = messages[:HEAD_KEEP] + messages[-TAIL_KEEP:]
    else:
        truncated = messages

    _do_generate_task_summary(
        None, space_id, user_id, session_id,
        serialize_messages(truncated),
        0,
        agent_id,
        selected_model_id,
    )


# ── Beat 入口 ──

@shared_task(ignore_result=True, time_limit=60, soft_time_limit=50)
def dispatch_idle_settlement():
    """Beat 入口：扫描所有空闲超时的未结算 session，为每个分发结算子任务。

    """
    from apps.chat.conversation.models import ChatSession
    from apps.services.agent_engine.services.memory_table_service import MemoryTableService
    from apps.tabtinspace.memory_defaults import MEMORY_DEFAULTS_V2

    default_timeout = MEMORY_DEFAULTS_V2["observer"]["idle_timeout_minutes"]

    FLOOR_IDLE_MINUTES = 5
    prefilter_threshold = timezone.now() - timedelta(minutes=FLOOR_IDLE_MINUTES)

    sessions = list(ChatSession.objects.filter(
        updated_at__lt=prefilter_threshold,
        memory_settled=False,
        workspace_id__isnull=False,
        agent_id__isnull=False,
    ).only(
        "id", "thread_id", "user_id", "workspace_id", "agent_id", "updated_at",
    )[:50])

    if not sessions:
        return 0

    from apps.tabtinspace.models import Agent, Workspace
    workspaces_map = {
        str(workspace.id): workspace
        for workspace in Workspace.objects.filter(
            id__in={session.workspace_id for session in sessions},
        ).only("id", "organization_id")
    }
    agents_map = {
        str(agent.id): agent
        for agent in Agent.objects.filter(
            id__in={session.agent_id for session in sessions},
        ).only("id", "agent_config")
    }

    dispatched = 0
    for session in sessions:
        workspace = workspaces_map.get(str(session.workspace_id))
        agent = agents_map.get(str(session.agent_id))
        if not workspace or not agent:
            continue
        agent_config = agent.agent_config if isinstance(agent.agent_config, dict) else {}
        if not MemoryTableService.is_memory_enabled_for_organization(
            session.user_id,
            workspace.organization_id,
        ):
            continue

        memory_config = MemoryTableService.get_memory_config(agent_config)
        idle_minutes = memory_config.get("observer", {}).get(
            "idle_timeout_minutes", default_timeout,
        )

        if not session.user_id:
            logger.warning(
                "[Memory:L4] Skipping session with missing user_id: session=%s space=%s",
                session.thread_id or session.id, session.workspace_id,
            )
            continue

        session_threshold = timezone.now() - timedelta(minutes=idle_minutes)
        if session.updated_at >= session_threshold:
            continue

        sid = session.thread_id or f"chat-session-{session.id}"
        from apps.agent_memory.workspace_memory_execution import (
            resolve_workspace_memory_dispatch,
        )

        try:
            summary_execution = resolve_workspace_memory_dispatch(
                scene_key="task_summary",
                organization_id=str(workspace.organization_id),
                user_id=str(session.user_id),
            )
        except Exception as exc:
            logger.warning(
                "[Memory:L4] Task Summary dispatch blocked by Workspace Memory "
                "policy: session=%s error=%s",
                sid,
                type(exc).__name__,
            )
            continue
        if not summary_execution.enabled:
            continue

        memory_capture_model_id = ""
        try:
            capture_execution = resolve_workspace_memory_dispatch(
                scene_key="memory_capture",
                organization_id=str(workspace.organization_id),
                user_id=str(session.user_id),
            )
            if capture_execution.enabled:
                memory_capture_model_id = capture_execution.selected_model_id
        except Exception as exc:
            logger.warning(
                "[Memory:L4] Memory Capture dispatch blocked by Workspace Memory "
                "policy: session=%s error=%s",
                sid,
                type(exc).__name__,
            )
        try:
            settle_idle_session_task.apply_async(
                kwargs={
                    "session_id": sid,
                    "space_id": str(session.workspace_id),
                    "user_id": str(session.user_id),
                    "agent_id": str(session.agent_id),
                    "memory_capture_model_id": memory_capture_model_id,
                    "task_summary_model_id": summary_execution.selected_model_id,
                },
                countdown=2,
            )
            dispatched += 1
        except Exception as exc:
            logger.warning(
                "[Memory] dispatch failed for %s: %s",
                sid,
                exc,
            )
            continue

    if dispatched:
        logger.info("[Memory:L4] Dispatched %d idle settlements", dispatched)


IDLE_SETTLEMENT_BEAT_SCHEDULE = {
    "memory-idle-settlement-every-5m": {
        "task": "apps.services.agent_engine.tasks.memory.idle_settlement.dispatch_idle_settlement",
        "schedule": 5 * 60,
        "options": {"queue": "default"},
    },
}
