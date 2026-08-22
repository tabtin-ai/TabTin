"""
Claude 服务实现（OpenAI 兼容）
"""

from __future__ import annotations

from typing import Any, Dict, List
import logging
import time

import openai

from apps.services.llm.providers.openai.service import OpenAIService
from apps.services.llm.utils.capabilities import ModelCapabilities

logger = logging.getLogger(__name__)

_VALIDATE_CACHE_TTL = 300  # 5 分钟


class ClaudeService(OpenAIService):
    """
    Claude API 服务（OpenAI 兼容格式）。

    复用 OpenAIService 的请求构造、stream/usage 解析与 prompt caching 参数透传，
    避免双实现导致参数/计费语义漂移。
    """

    CAPABILITIES = ModelCapabilities(
        supports_streaming=True,
        supports_function_calling=True,
        supports_vision=True,
        # ：本地 proxy 仅透传 OpenAI-compat file_url（Moonshot 语义），Claude 尚未 wire
        supports_document_input=False,
        supports_prompt_caching=True,
        supports_reasoning=True,
        supports_json_mode=True,
        supports_responses_api=False,
        supports_token_estimate=False,
        supports_tool_choice=True,
        supports_parallel_function_calling=False,
    ).to_dict()

    _validate_cache: Dict[str, Any] | None = None
    _validate_cache_ts: float = 0.0

    def __init__(self, provider_config: Dict[str, Any]):
        super().__init__(provider_config)
        self.default_model = provider_config.get("model_name", "claude-3-sonnet-20240229")
        logger.info("初始化 Claude 服务: model=%s base_url=%s", self.default_model, self.base_url)

    def _validate_connection(self) -> Dict[str, Any]:
        """Claude 兼容网关不一定支持 models.list，改为最小 chat 调用探测。

        加入 TTL 缓存防止频繁健康检测消耗 token（每次 ~15-30 tokens 且不计入计费记录）。
        """
        now = time.time()
        if (
            self._validate_cache is not None
            and (now - self._validate_cache_ts) < _VALIDATE_CACHE_TTL
        ):
            return self._validate_cache

        try:
            self.client.chat.completions.create(
                model=self.default_model,
                messages=[{"role": "user", "content": "ping"}],
                max_tokens=1,
            )
            result: Dict[str, Any] = {
                "valid": True,
                "details": {
                    "model": self.default_model,
                    "api_base": self.base_url,
                },
            }
        except openai.APIError as exc:
            result = {
                "valid": False,
                "error": f"Claude API连接失败: {str(exc)}",
            }
        except Exception as exc:  # pragma: no cover - 防御性兜底
            result = {
                "valid": False,
                "error": f"连接验证异常: {str(exc)}",
            }

        self._validate_cache = result
        self._validate_cache_ts = now
        return result

    def _prepare_chat_params(self, messages, **kwargs):
        """参数冲突由 adapt_params 注册表统一处理。"""
        return super()._prepare_chat_params(messages, **kwargs)

    @staticmethod
    def _extract_reasoning_from_message(
        message: Any,
        *,
        is_stream: bool = False,
    ) -> list:
        """从 Claude OpenAI 兼容层响应中提取 thinking/reasoning 内容。

        Anthropic 兼容层可能将 thinking 放在以下位置：
        1. message.reasoning_content / message.thinking_content（标准 OpenAI 扩展）
        2. message.content 为 list 时，包含 type="thinking" 的 content block
        """
        reasoning = None
        if isinstance(message, dict):
            reasoning = message.get("reasoning_content") or message.get("thinking_content")
        else:
            reasoning = getattr(message, "reasoning_content", None) or getattr(message, "thinking_content", None)

        if reasoning:
            entry_type = "reasoning.delta" if is_stream else "reasoning.text"
            return [{"type": entry_type, "text": reasoning}]

        content = None
        if isinstance(message, dict):
            content = message.get("content")
        else:
            content = getattr(message, "content", None)

        if isinstance(content, list):
            details: list = []
            entry_type = "reasoning.delta" if is_stream else "reasoning.text"
            for block in content:
                block_type = block.get("type") if isinstance(block, dict) else getattr(block, "type", None)
                if block_type == "thinking":
                    text = block.get("thinking") if isinstance(block, dict) else getattr(block, "thinking", None)
                    if text:
                        details.append({"type": entry_type, "text": text})
            return details

        return []

    def _model_supports_vision(self, model: str) -> bool:
        if super()._model_supports_vision(model):
            return True
        name = (model or "").lower()
        return "claude-3" in name or "claude-4" in name

    def _model_supports_json_mode(self, model: str) -> bool:
        if self.model is not None:
            return super()._model_supports_json_mode(model)
        name = (model or "").lower()
        return "claude-3" in name or "claude-4" in name

    def get_supported_models(self) -> List[Dict[str, Any]]:
        return [
            {
                "id": "claude-3-opus-20240229",
                "name": "Claude 3 Opus",
                "provider": "claude",
                "supports_vision": True,
                "supports_json": True,
                "context_window": 200000,
            },
            {
                "id": "claude-3-sonnet-20240229",
                "name": "Claude 3 Sonnet",
                "provider": "claude",
                "supports_vision": True,
                "supports_json": True,
                "context_window": 200000,
            },
            {
                "id": "claude-3-haiku-20240307",
                "name": "Claude 3 Haiku",
                "provider": "claude",
                "supports_vision": True,
                "supports_json": True,
                "context_window": 200000,
            },
            {
                "id": "claude-3-5-sonnet-20240620",
                "name": "Claude 3.5 Sonnet",
                "provider": "claude",
                "supports_vision": True,
                "supports_json": True,
                "context_window": 200000,
            },
        ]
