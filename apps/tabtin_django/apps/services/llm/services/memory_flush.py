"""
预紧缩记忆刷新服务。
"""

from dataclasses import dataclass
from typing import Dict, List, Optional
import logging

logger = logging.getLogger(__name__)


DEFAULT_MEMORY_FLUSH_MAX_TOKENS = 800


@dataclass
class MemoryFlushResult:
    notes: str
    overflow: bool


class MemoryFlushService:
    """
    从对话中提取"长期记忆/偏好/决策/约束"等关键信息。
    """

    def __init__(
        self,
        model_id: Optional[str] = None,
        user_id: str = "",
        organization_id: str = "",
    ):
        self.user_id = user_id
        self.organization_id = organization_id

    def flush(
        self,
        messages: List[Dict[str, str]],
        *,
        existing_notes: str = "",
        max_tokens: int = DEFAULT_MEMORY_FLUSH_MAX_TOKENS,
    ) -> Optional[MemoryFlushResult]:
        if not (self.organization_id or "").strip():
            logger.warning("[MemoryFlush] organization_id 为空，跳过 LLM 调用以防计费缺口")
            return MemoryFlushResult(notes=existing_notes, overflow=True)

        from apps.services.llm.services.chat import unified_llm_call

        try:
            result = unified_llm_call(
                scene_key="memory_flush",
                variables={
                    "existing_notes": existing_notes,
                    "messages": messages,
                },
                user_id=self.user_id,
                organization_id=self.organization_id,
            )
        except Exception as exc:
            logger.warning("[MemoryFlush] unified_llm_call 失败: %s", exc)
            return MemoryFlushResult(notes=existing_notes, overflow=True)

        notes = result.content.strip()
        return MemoryFlushResult(notes=notes or existing_notes, overflow=False)


__all__ = ["MemoryFlushService", "MemoryFlushResult"]
