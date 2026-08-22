"""
任务摘要生成异步任务 — 使用 LLM 从对话中生成结构化任务摘要，
写入独立 AgentMemory 表（memo_type=task_summary， M4.5/C5 分家）。

历史：TabData TableRecord → tabmemo.Memo 混存 → 独立 AgentMemory 表。
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

from celery import shared_task

logger = logging.getLogger(__name__)

VALID_OUTCOMES = {"成功", "部分完成", "失败", "取消"}

OUTCOME_ALIASES: Dict[str, str] = {
    "success": "成功",
    "partial": "部分完成",
    "partially_completed": "部分完成",
    "failed": "失败",
    "failure": "失败",
    "cancelled": "取消",
    "canceled": "取消",
}


def _normalize_outcome(raw: str) -> str:
    """将 LLM 返回的 outcome 规范化为中文枚举值。"""
    if raw in VALID_OUTCOMES:
        return raw
    lowered = raw.strip().lower()
    return OUTCOME_ALIASES.get(lowered, "成功")




@shared_task(
    bind=True,
    ignore_result=True,
    max_retries=2,
    default_retry_delay=30,
    time_limit=600,
    soft_time_limit=560,
    # P0: queue 由 CELERY_TASK_ROUTES → ai_background 控制，禁止 decorator 绑部署拓扑
)
def generate_task_summary_task(
    self,
    space_id: str,
    user_id: str,
    thread_id: str,
    messages: List[Dict[str, str]],
    tool_call_count: int = 0,
    agent_id: str = "",
    selected_model_id: str = "",
):
    """从对话消息中生成任务摘要并写入表格。"""
    from apps.services.common.thread_context import clear_context

    clear_context()
    try:
        _do_generate_task_summary(
            self, space_id, user_id, thread_id,
            messages, tool_call_count, agent_id, selected_model_id,
        )
    finally:
        clear_context()


def _do_generate_task_summary(
    task_self,
    space_id: str,
    user_id: str,
    thread_id: str,
    messages: List[Dict[str, str]],
    tool_call_count: int = 0,
    agent_id: str = "",
    selected_model_id: str = "",
):
    """核心任务摘要逻辑 — 供 task 和直接调用共用。

    FIX P1-70: 拆分为 LLM 生成阶段和持久化阶段，
    _write_to_memo 失败时 re-raise 以阻止调用方标记 settled。
    """
    from celery.exceptions import SoftTimeLimitExceeded

    # ── Phase 1: LLM 生成（非持久化，parse 错误可安全吞噬）──
    try:
        celery_task_id = str(
            getattr(getattr(task_self, "request", None), "id", "") or ""
        )
        summary = _generate_with_llm(
            messages,
            user_id=user_id,
            space_id=space_id,
            thread_id=thread_id,
            task_id=celery_task_id,
            retry_source="celery" if celery_task_id else "",
            selected_model_id=selected_model_id,
        )
        if not summary:
            logger.info("[TaskSummary] No summary generated for space=%s", space_id)
            return
    except SoftTimeLimitExceeded:
        logger.error(
            "[TaskSummary] SoftTimeLimitExceeded: space=%s — not retrying",
            space_id,
        )
        return
    except (ValueError, json.JSONDecodeError) as exc:
        logger.error(
            "[TaskSummary] Non-retryable LLM parse error: space=%s error=%s", space_id, exc,
        )
        return
    except Exception as exc:
        logger.error(
            "[TaskSummary] LLM call failed: space=%s error=%s", space_id, exc,
            exc_info=True,
        )
        from apps.services.llm.services._runtime.background_invocation import (
            is_retryable_background_error,
        )

        if (
            task_self is not None
            and hasattr(task_self, "retry")
            and is_retryable_background_error(exc)
        ):
            raise task_self.retry(exc=exc, countdown=2 ** task_self.request.retries * 15)
        raise

    # ── Phase 2: 持久化（写入失败必须 re-raise）──
    try:
        _write_to_memo(
            summary, space_id, user_id, thread_id, tool_call_count, agent_id,
        )
    except Exception as exc:
        logger.error(
            "[TaskSummary] Memo write failed, NOT marking settled: space=%s error=%s",
            space_id, exc, exc_info=True,
        )
        if task_self is not None and hasattr(task_self, "retry"):
            raise task_self.retry(exc=exc, countdown=2 ** task_self.request.retries * 15)
        raise

    logger.info(
        "[TaskSummary] Wrote summary for space=%s thread=%s title='%s'",
        space_id, thread_id, summary.get("title", "")[:40],
    )


def _generate_with_llm(
    messages: List[Dict[str, str]],
    user_id: str = "",
    space_id: str = "",
    thread_id: str = "",
    task_id: str = "",
    retry_source: str = "",
    selected_model_id: str = "",
) -> Dict[str, Any]:
    """调用 LLM 生成任务摘要。"""
    from apps.services.llm.services.chat import unified_llm_call
    from apps.services.agent_engine.utils.memory_utils import strip_code_fence

    MAX_INPUT_CHARS = 30000
    conversation_text = "\n".join(
        f"[{m['role']}]: {m['content']}" for m in messages
    )
    if len(conversation_text) > MAX_INPUT_CHARS:
        conversation_text = conversation_text[:MAX_INPUT_CHARS] + "\n...(truncated)"

    organization_id = _resolve_organization(space_id) or "" if space_id else ""
    if not organization_id:
        logger.warning("[TaskSummary] organization_id 为空，跳过")
        return {}

    from apps.agent_memory.workspace_memory_execution import (
        resolve_workspace_memory_worker,
    )

    execution = resolve_workspace_memory_worker(
        scene_key="task_summary",
        organization_id=organization_id,
        user_id=user_id,
        selected_model_id=selected_model_id,
    )
    if not execution.enabled:
        return {}
    selected_model_id = execution.selected_model_id

    # 用户级记录风格（per-(user, organization)）：关闭则跳过；否则渲染偏好注入 prompt
    # （TM-16：读配置 + 渲染收口到 resolve_record_preference，与 memory_capture 共用同一接线）。
    from apps.tabmemo.services.record_style_service import resolve_record_preference

    enabled, record_pref = resolve_record_preference(user_id, organization_id)
    if not enabled:
        logger.info(
            "[TaskSummary] record style disabled, skip: user=%s ws=%s",
            user_id, organization_id,
        )
        return {}

    invocation_context = None
    if thread_id:
        from apps.services.llm.services._runtime.background_invocation import (
            build_background_scene_invocation,
        )

        invocation_context = build_background_scene_invocation(
            scene_key="task_summary",
            business_identity=thread_id,
            organization_id=organization_id,
            user_id=user_id or "",
            selected_model_id=selected_model_id,
            business_object_type="thread",
            business_object_id=thread_id,
            task_id=task_id,
            retry_source=retry_source,
        )

    try:
        result = unified_llm_call(
            scene_key="task_summary",
            variables={
                "conversation_text": conversation_text,
                "record_preference": record_pref,
            },
            user_id=user_id or "",
            organization_id=organization_id,
            invocation_context=invocation_context,
            result_validator=_validate_task_summary_result,
            selected_model_id=selected_model_id or None,
        )
    except Exception as exc:
        from apps.services.llm.scenes.exceptions import BYOKSceneError

        if isinstance(exc, BYOKSceneError):
            raise
        logger.warning("[TaskSummary] unified_llm_call failed: %s", exc)
        return {}

    try:
        return _parse_task_summary_result(strip_code_fence(result.content))
    except ValueError:
        logger.warning("[TaskSummary] Failed to parse LLM response")
        return {}


def _validate_task_summary_result(content: str) -> None:
    from apps.services.agent_engine.utils.memory_utils import strip_code_fence

    _parse_task_summary_result(strip_code_fence(content))


def _parse_task_summary_result(content: str) -> Dict[str, Any]:
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError as exc:
        raise ValueError("task_summary 结果不是合法 JSON") from exc
    if not isinstance(parsed, dict) or not parsed.get("title"):
        raise ValueError("task_summary 结果缺少 title")
    return parsed


def _write_to_memo(
    summary: Dict[str, Any],
    space_id: str,
    user_id: str,
    thread_id: str,
    tool_call_count: int,
    agent_id: str = "",
) -> None:
    """将任务摘要写入独立 AgentMemory 表（memo_type=task_summary，）。

    写入前归档同 thread_id 的旧条目，确保每个会话只保留一条最终摘要。
    解析不到执行 agent 时跳过写入（记忆必须归属 Agent）。
    """
    from apps.agent_memory.repository import AgentMemoryRepository

    try:
        from apps.tabtinspace.services.host_resolver import host_organization_id
        org_id = host_organization_id(space_id)
        if org_id is None:
            raise LookupError(f"host {space_id} not found")
        organization_id = str(org_id)
    except Exception:
        logger.error("[TaskSummary] Space %s not found, cannot write memo", space_id)
        raise

    # ：task_summary 是记忆行，归属执行 agent——调用方显式传入
    # （idle_settlement 派发时带 space.agent_id）优先；否则会话直挂的执行
    # 分身（thread_id 反查）、space 1:1 回退；解析失败 = 无归属，跳过。
    from apps.services.agent_engine.utils.memory_constants import (
        resolve_space_execution_agent_id,
    )
    agent_id = agent_id or resolve_space_execution_agent_id(space_id, thread_id=thread_id)
    if not agent_id:
        logger.warning(
            "[TaskSummary] no execution agent resolved, skip summary write: "
            "space=%s thread=%s", space_id, thread_id,
        )
        return

    if thread_id:
        _archive_old_summaries(
            agent_id=agent_id,
            organization_id=organization_id,
            owner_id=user_id,
            thread_id=thread_id,
        )

    outcome = _normalize_outcome(summary.get("outcome", "成功"))

    pitfalls = summary.get("pitfalls", [])
    pitfall_lines = [p for p in pitfalls if isinstance(p, str) and p.strip()] if isinstance(pitfalls, list) else []

    title = summary.get("title", "")[:255]
    diary = summary.get("diary", "")

    structured_parts = [title]
    if outcome:
        structured_parts.append(f"结果: {outcome}")
    if pitfall_lines:
        structured_parts.append("踩坑: " + " / ".join(pitfall_lines))
    structured_plaintext = "\n".join(structured_parts)

    content_markdown = diary if diary else title

    VALID_EMOTIONS = {"neutral", "happy", "curious", "frustrated", "relieved", "surprised", "reflective"}
    emotion = summary.get("emotion", "neutral")
    if emotion not in VALID_EMOTIONS:
        emotion = "neutral"
    ai_tags = [f"emotion:{emotion}"]
    if outcome:
        ai_tags.append(f"outcome:{outcome}")

    AgentMemoryRepository.create(
        agent_id=agent_id,
        organization_id=organization_id,
        owner_id=user_id or None,
        memo_type="task_summary",
        content_markdown=content_markdown,
        content_plaintext=structured_plaintext,
        ai_tags=ai_tags,
        source_url=f"thread://{thread_id}" if thread_id else "",
        tags=["task_summary"],
    )


def _archive_old_summaries(
    *,
    agent_id: str,
    organization_id: str,
    owner_id: str,
    thread_id: str,
) -> None:
    """归档同一 thread_id 的旧 task_summary 记忆，避免重复。"""
    if not organization_id or not owner_id:
        logger.warning(
            "[TaskSummary] subject scope missing, skip old summary archive: "
            "agent=%s thread=%s",
            agent_id,
            thread_id,
        )
        return
    try:
        from apps.agent_memory.repository import AgentMemoryRepository
        from apps.agent_memory.models import AgentMemory

        source_url = f"thread://{thread_id}"
        archived = AgentMemoryRepository.base_qs().filter(
            agent_id=agent_id,
            organization_id=organization_id,
            owner_id=owner_id,
            memo_type="task_summary",
            source_url=source_url,
            status=AgentMemory.Status.ACTIVE,
            forgotten_at__isnull=True,
        ).update(status=AgentMemory.Status.ARCHIVED)

        if archived:
            logger.info(
                "[TaskSummary] Archived %d old summary memories for thread=%s",
                archived, thread_id,
            )
    except Exception as exc:
        logger.warning(
            "[TaskSummary] Failed to archive old summaries (non-critical): thread=%s error=%s",
            thread_id, exc,
        )


# 向后兼容别名
_write_to_table = _write_to_memo


def _trigger_rag_indexing(record: Any) -> None:
    """主动触发单条记录的 RAG 向量索引。"""
    try:
        from apps.rag.tasks import embed_record_task

        record_id = str(record.id) if hasattr(record, "id") else str(record)
        embed_record_task.apply_async(args=[record_id], kwargs={"force": False}, countdown=1)
        logger.info("[TaskSummary] Triggered RAG indexing for record %s", record_id)
    except Exception as exc:
        logger.debug("[TaskSummary] RAG indexing trigger failed (non-critical): %s", exc)


def _resolve_organization(space_id: str) -> Optional[str]:
    """从 space_id 解析 organization_id（委托统一 resolver）。"""
    from apps.services.billing.organization_resolver import resolve_organization_id_from_space
    return resolve_organization_id_from_space(space_id)
