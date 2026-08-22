"""
Gemini 服务实现
"""

from typing import Dict, Any, List
import logging

import openai
from apps.services.llm.providers.openai.service import OpenAIService
from apps.services.llm.utils.capabilities import ModelCapabilities

logger = logging.getLogger(__name__)

GEMINI_DEFAULT_MAX_OUTPUT_TOKENS = 8192


class GeminiService(OpenAIService):
    """
    Gemini API 服务实现。

    继承 OpenAIService 兼容层，覆写 Gemini 特有的能力判断、
    连接验证和默认参数，避免 OpenAI 关键词逻辑误判。
    """

    CAPABILITIES = ModelCapabilities(
        supports_streaming=True,
        supports_function_calling=True,
        supports_vision=True,
        # ：本地 proxy 仅透传 OpenAI-compat file_url（Moonshot 语义），Gemini 尚未 wire
        supports_document_input=False,
        supports_prompt_caching=False,
        supports_reasoning=True,
        supports_json_mode=True,
        supports_responses_api=False,
        supports_token_estimate=False,
        supports_tool_choice=True,
        supports_parallel_function_calling=False,
    ).to_dict()

    def __init__(self, provider_config: Dict[str, Any]):
        super().__init__(provider_config)

        self.default_model = provider_config.get('model_name', 'gemini-2.5-flash')

        if self.max_output_tokens is None:
            self.max_output_tokens = GEMINI_DEFAULT_MAX_OUTPUT_TOKENS

        logger.info("Gemini 服务初始化成功，默认模型: %s", self.default_model)

    # ------------------------------------------------------------------
    # 能力判断覆写（绕过 OpenAIService 的 GPT 关键词匹配）
    # ------------------------------------------------------------------

    def _model_supports_vision(self, model: str) -> bool:
        """Gemini 主流模型（1.5 / 2.0 / 2.5 系列）均支持视觉。"""
        from apps.services.llm.services.base import BaseLLMService
        if BaseLLMService._model_supports_vision(self, model):
            return True
        name = (model or "").lower()
        return "gemini" in name

    def _model_supports_json_mode(self, model: str) -> bool:
        """Gemini 1.5+ 均支持 JSON mode。"""
        from apps.services.llm.services.base import BaseLLMService
        return BaseLLMService._model_supports_json_mode(self, model)

    # ------------------------------------------------------------------
    # 连接验证覆写
    # ------------------------------------------------------------------

    def _validate_connection(self) -> Dict[str, Any]:
        """验证 Gemini 连接：1-token 请求同时验证 API Key 和模型可用性。

        父类使用 models.list() 验证，但 Gemini 默认模型可能不在列表中，
        导致假阳性（验证通过但模型不可用）。
        """
        try:
            response = self.client.chat.completions.create(
                model=self.default_model,
                messages=[{"role": "user", "content": "hi"}],
                max_tokens=1,
            )
            return {
                "valid": True,
                "details": {
                    "model": self.default_model,
                    "response_model": getattr(response, 'model', None),
                }
            }
        except openai.AuthenticationError as e:
            return {"valid": False, "error": f"Gemini 认证失败: {e}"}
        except openai.NotFoundError as e:
            return {"valid": False, "error": f"Gemini 模型不可用（{self.default_model}）: {e}"}
        except Exception as e:
            return {"valid": False, "error": f"Gemini 连接验证失败: {e}"}

    # ------------------------------------------------------------------
    # 模型列表覆写
    # ------------------------------------------------------------------

    def get_supported_models(self) -> List[Dict[str, Any]]:
        """获取 Gemini 支持的模型列表，使用正确的 provider 标识和能力判断。"""
        try:
            models = self.client.models.list()
            supported_models = []
            for model in models.data:
                supported_models.append({
                    "id": model.id,
                    "name": model.id,
                    "provider": "gemini",
                    "supports_vision": self._model_supports_vision(model.id),
                    "supports_json": self._model_supports_json_mode(model.id),
                    "created": model.created,
                })
            return sorted(supported_models, key=lambda x: x.get('created', 0), reverse=True)
        except Exception as e:
            logger.error("获取 Gemini 模型列表失败: %s", e)
            return []

    # ------------------------------------------------------------------
    # Prompt caching 覆写
    # ------------------------------------------------------------------

    @staticmethod
    def _inject_prompt_cache_payload(extra_body: Dict[str, Any], kwargs: Dict[str, Any]) -> Dict[str, Any]:
        """Gemini 不支持 Anthropic 风格的 prompt_cache_key / prompt_cache_retention，
        剥离这些字段防止无效参数进入请求。Gemini 上下文缓存需通过
        CachedContent API 单独管理，不在 chat 请求层面处理。"""
        payload = dict(extra_body or {})
        removed = []
        for key in ("prompt_cache_key", "prompt_cache_retention"):
            if payload.pop(key, None) is not None or kwargs.get(key) is not None:
                removed.append(key)
        if removed:
            logger.debug("Gemini 不支持 prompt caching 字段，已忽略: %s", removed)
        return payload
