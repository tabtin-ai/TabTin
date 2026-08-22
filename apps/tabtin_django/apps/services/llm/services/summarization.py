"""
对话摘要服务。
"""

from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple
import logging

logger = logging.getLogger(__name__)

DEFAULT_SUMMARY_MAX_TOKENS = 800
DEFAULT_OUTPUT_TOKENS_BUDGET = 2000
DEFAULT_MAX_INPUT_FALLBACK = 30_000


def _validate_summary_content(content: str) -> None:
    """复用业务层原有的“空摘要即失败”规则，并在结算前执行。"""
    if not str(content or "").strip():
        raise ValueError("summarization 结果为空")


@dataclass
class SummaryResult:
    summary: str
    kept_messages: List[Dict[str, str]]
    overflow: bool


class SummarizationService:
    """
    公共摘要服务：基于摘要模型对历史消息做压缩。

    触发策略由调用方决定；本服务提供"按模型上下文是否超限"判断。
    """

    def __init__(
        self,
        summary_model_id: Optional[str] = None,
        user_id: str = "",
        organization_id: str = "",
    ):
        self.summary_model_id = summary_model_id
        self.user_id = user_id
        self.organization_id = organization_id

    def summarize_if_overflow(
        self,
        messages: List[Dict[str, str]],
        target_model_id: Optional[str],
        *,
        existing_summary: str = "",
        keep_last_messages: int = 20,
        max_output_tokens: Optional[int] = None,
        summary_max_tokens: int = DEFAULT_SUMMARY_MAX_TOKENS,
    ) -> Optional[SummaryResult]:
        """
        如果目标模型上下文超限，生成摘要并返回保留消息。
        """
        if not target_model_id:
            return None

        from apps.services.llm.services.factory import get_llm_service
        try:
            target_service = get_llm_service(model_id=target_model_id)
        except Exception as exc:
            logger.warning("[Summarization] 获取目标模型失败，跳过摘要: %s", exc)
            return None
        budget = self._resolve_max_input_budget(target_service, max_output_tokens)
        if budget is None:
            return None

        token_counter = target_service._get_token_counter()
        total_tokens = token_counter.count_messages_tokens(self._normalize_messages(messages))
        if total_tokens <= budget:
            return SummaryResult(summary=existing_summary, kept_messages=messages, overflow=False)

        system_messages, non_system_messages = self._partition_messages(messages)
        kept_messages, to_summarize = self._split_messages(non_system_messages, keep_last_messages)
        if not to_summarize:
            return SummaryResult(summary=existing_summary, kept_messages=messages, overflow=True)

        summary = self._summarize_messages(to_summarize, existing_summary, summary_max_tokens)
        new_messages = system_messages + kept_messages

        # FND-34: 摘要后仍超限时告警（system messages 过大场景）
        new_tokens = token_counter.count_messages_tokens(self._normalize_messages(new_messages))
        if new_tokens > budget:
            logger.warning(
                "[Summarization] 摘要后消息仍超限 (%d > %d tokens)，"
                "可能因 system 消息过大（%d 条，约 %d tokens）",
                new_tokens,
                budget,
                len(system_messages),
                token_counter.count_messages_tokens(self._normalize_messages(system_messages)),
            )

        return SummaryResult(summary=summary, kept_messages=new_messages, overflow=True)

    def summarize_messages(
        self,
        messages: List[Dict[str, str]],
        *,
        existing_summary: str = "",
        summary_max_tokens: int = DEFAULT_SUMMARY_MAX_TOKENS,
    ) -> str:
        """
        强制对消息列表生成摘要（不做上下文预算判断）。
        """
        if not messages:
            return existing_summary
        return self._summarize_messages(messages, existing_summary, summary_max_tokens)

    def _resolve_max_input_budget(self, target_service, max_output_tokens: Optional[int]) -> Optional[int]:
        """
        根据目标模型的上下文上限与输出预算，计算最大输入预算。
        """
        output_budget = max_output_tokens or target_service.max_output_tokens or DEFAULT_OUTPUT_TOKENS_BUDGET
        max_input = None

        if target_service.context_window_tokens:
            max_input = target_service.context_window_tokens - output_budget
        if target_service.max_input_tokens is not None:
            max_input = min(max_input, target_service.max_input_tokens) if max_input is not None else target_service.max_input_tokens

        # FND-35: 无 token 配置时使用保守默认值，防止超长消息裸发
        if max_input is None:
            max_input = DEFAULT_MAX_INPUT_FALLBACK - output_budget
            logger.warning(
                "[Summarization] 目标模型未配置 context_window / max_input_tokens，"
                "使用保守默认预算 %d tokens",
                max_input,
            )

        return max_input if max_input > 0 else None

    def _partition_messages(
        self, messages: List[Dict[str, str]]
    ) -> Tuple[List[Dict[str, str]], List[Dict[str, str]]]:
        system_messages = [msg for msg in messages if msg.get("role") == "system"]
        non_system_messages = [msg for msg in messages if msg.get("role") != "system"]
        return system_messages, non_system_messages

    def _split_messages(
        self, messages: List[Dict[str, str]], keep_last_messages: int
    ) -> Tuple[List[Dict[str, str]], List[Dict[str, str]]]:
        if keep_last_messages <= 0:
            return [], messages
        if len(messages) <= keep_last_messages:
            return messages, []
        return messages[-keep_last_messages:], messages[:-keep_last_messages]

    def _summarize_messages(
        self,
        messages: List[Dict[str, str]],
        existing_summary: str,
        summary_max_tokens: int,
    ) -> str:
        if not (self.organization_id or "").strip():
            logger.warning("[Summarization] organization_id 为空，跳过摘要以防计费缺口")
            return existing_summary

        from apps.services.llm.services.chat import unified_llm_call

        try:
            result = unified_llm_call(
                scene_key="summarization",
                variables={
                    "existing_summary": existing_summary,
                    "messages": messages,
                },
                user_id=self.user_id,
                organization_id=self.organization_id,
                result_validator=_validate_summary_content,
                selected_model_id=self.summary_model_id,
            )
        except Exception as exc:
            logger.error("[Summarization] unified_llm_call 失败: %s", exc)
            return existing_summary

        summary = result.content.strip()
        return summary or existing_summary

    def _normalize_messages(self, messages: List[Dict[str, str]]) -> List[Dict[str, str]]:
        normalized = []
        for msg in messages:
            normalized.append({
                "role": msg.get("role", "user"),
                "content": msg.get("content", ""),
            })
        return normalized
