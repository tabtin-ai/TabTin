"""
Conversation Compaction Service

为会话生成/更新对话摘要，并更新会话压缩统计。

─── 失败语义（Wave 1 A2 改造）────────────────────────────────────

本服务**不再返回 ``success: bool`` 字段**。原因：legacy
``{"success": True/False, ...}`` 形态混用了两件本不该混的事——

1. "操作完成与否"（应该走异常 / NotFound）
2. "本次是否真的执行了压缩动作"（用 ``compacted: bool`` 表达）

新约定：

- session 找不到 → 抛 ``SessionCompactionNotFoundError``，view 层转 NOT_FOUND
  错误响应。
- 操作完成但本轮无需压缩 / 无可压缩内容 / LLM 退化为旧摘要 →
  返 ``compacted=False`` + ``reason``，view 层正常包成 ``ok:true`` envelope。
- 真正写入新摘要 → 返 ``compacted=True`` + ``summary`` + 统计字段。

**view 层 NOT_FOUND 形态备注**：当前 view（``api/session.py.compact_session``）
用 ``error_response_with_status('NOT_FOUND', ..., 404)`` 返回，是 contract 主战场
§五 P1 登记的老 helper（legacy ``{success: False, code, message, data}`` tuple
形态），W6/W7 surface 收敛时统一切到 wire envelope ``err_response('NOT_FOUND')``。
本期只做"fail-soft → NOT_FOUND 语义切换"，不做 helper 形态迁移。

这样前端不再需要判 ``data.success``——看 envelope ``ok`` 决定要不要 throw，
看 ``data.compacted`` 决定要不要刷新摘要 UI。
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from django.utils import timezone

from apps.services.llm.services.summarization import (
    SummarizationService,
    DEFAULT_SUMMARY_MAX_TOKENS,
)

logger = logging.getLogger(__name__)


class SessionCompactionNotFoundError(LookupError):  # noqa: D401 — 见类 docstring
    """会话不存在 / 当前用户无权访问 — view 层转 ``err_response('NOT_FOUND', ...)``。"""


class SessionCompactionService:
    """
    会话压缩服务（生成对话摘要并写入 ChatContext）。
    """

    @staticmethod
    def compact_session(
        *,
        session_id: str,
        user,
        model_id: Optional[str] = None,
        force: bool = False,
        keep_last_messages: int = 20,
        summary_max_tokens: int = DEFAULT_SUMMARY_MAX_TOKENS,
    ) -> Dict[str, Any]:
        """
        对指定会话执行压缩。

        Raises:
            SessionCompactionNotFoundError: 会话不存在或无权访问；view 层转
                ``err_response('NOT_FOUND', ...)`` envelope。
        """
        from apps.chat.conversation.models import ChatSession, ChatContext

        # v0.1 宪法 §5.1：current_model 是软引用 UUIDField，不再支持 prefetch_related。
        # 本函数只用 ``session.current_model_id``（参见下方 target_model_id 计算），
        # 不需要 LLMModel 实例，故无需 attach 预加载。
        session = (
            ChatSession.objects
            .filter(id=session_id, user=user)
            .first()
        )
        if not session:
            raise SessionCompactionNotFoundError(session_id)

        # W3 §3.3.1：content → text_summary（compaction 服务摘要消息历史给 LLM 看）
        raw_messages = list(
            session.messages.order_by("created_at").values("role", "text_summary")
        )
        messages = [
            {"role": m["role"], "content": m.get("text_summary", "") or ""}
            for m in raw_messages
        ]
        if not messages:
            return {"compacted": False, "reason": "no_messages"}

        context, _ = ChatContext.objects.get_or_create(session=session)
        context_data = dict(context.context_data or {})
        existing_summary = context_data.get("conversation_summary") or ""

        target_model_id = model_id or (str(session.current_model_id) if session.current_model_id else None)
        _uid = str(getattr(user, "id", "") or "")
        _wid = str(getattr(session, "organization_id", "") or "")

        summarizer = SummarizationService(
            summary_model_id=target_model_id,
            user_id=_uid,
            organization_id=_wid,
        )

        if force:
            to_summarize = _select_messages_for_summary(
                messages, keep_last_messages=keep_last_messages
            )
            if not to_summarize:
                return {"compacted": False, "reason": "nothing_to_summarize"}
            summary = summarizer.summarize_messages(
                to_summarize,
                existing_summary=existing_summary,
                summary_max_tokens=summary_max_tokens,
            )
        else:
            result = summarizer.summarize_if_overflow(
                messages,
                target_model_id,
                existing_summary=existing_summary,
                keep_last_messages=keep_last_messages,
                summary_max_tokens=summary_max_tokens,
            )
            if not result:
                return {"compacted": False, "reason": "no_budget"}
            if not result.overflow:
                return {"compacted": False, "reason": "not_overflow"}
            summary = result.summary

        if not summary:
            return {"compacted": False, "reason": "empty_summary"}

        is_fallback = bool(existing_summary) and summary == existing_summary
        if is_fallback:
            logger.warning(
                "[Compaction] session=%s LLM 摘要失败，返回旧摘要 fallback，不递增 compaction_count",
                session_id,
            )
            return {"compacted": False, "reason": "llm_fallback"}

        now = timezone.now()
        context_data["conversation_summary"] = summary
        context_data["conversation_summary_updated_at"] = now.isoformat()
        context.context_data = context_data
        context.save(update_fields=["context_data", "updated_at"])

        session.compaction_count = int(session.compaction_count or 0) + 1
        session.last_compaction_at = now
        session.save(update_fields=["compaction_count", "last_compaction_at", "updated_at"])

        return {
            "compacted": True,
            "summary": summary,
            "message_count": len(messages),
            "keep_last_messages": keep_last_messages,
            "compaction_count": session.compaction_count,
            "last_compaction_at": session.last_compaction_at,
        }


def _select_messages_for_summary(
    messages: list[dict[str, Any]],
    *,
    keep_last_messages: int,
) -> list[dict[str, Any]]:
    if keep_last_messages <= 0:
        return messages

    system_messages = [msg for msg in messages if msg.get("role") == "system"]
    non_system_messages = [msg for msg in messages if msg.get("role") != "system"]

    if len(non_system_messages) <= keep_last_messages:
        return []

    to_summarize = non_system_messages[:-keep_last_messages]
    return system_messages + to_summarize


__all__ = ["SessionCompactionService", "SessionCompactionNotFoundError"]
