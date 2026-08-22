"""
火山引擎方舟（Volcengine Ark / 豆包）服务实现。

Ark 提供 OpenAI 兼容接口：
- base_url: https://ark.cn-beijing.volces.com/api/v3
- chat: POST /chat/completions
"""

from typing import Dict, Any, List
import logging

from apps.services.llm.providers.openai.service import OpenAIService
from apps.services.llm.utils.capabilities import ModelCapabilities

logger = logging.getLogger(__name__)


class VolcengineService(OpenAIService):
    """火山方舟 Ark OpenAI 兼容 Chat Completions 服务。"""

    CAPABILITIES = ModelCapabilities(
        supports_streaming=True,
        supports_function_calling=True,
        supports_vision=True,
        supports_document_input=False,
        supports_prompt_caching=False,
        supports_reasoning=True,
        supports_json_mode=True,
        supports_responses_api=False,
        supports_token_estimate=False,
        supports_tool_choice=True,
        supports_parallel_function_calling=True,
    ).to_dict()

    @classmethod
    def validate_provider_config(cls, provider_name: str, config: dict) -> None:
        base_url = str(config.get("base_url", "") or "")
        if base_url and "volces.com" not in base_url:
            logger.warning(
                "Volcengine Ark base_url 通常应为 https://ark.cn-beijing.volces.com/api/v3，当前: %s",
                base_url,
            )

    def __init__(self, provider_config: Dict[str, Any]):
        super().__init__(provider_config)
        self.default_model = provider_config.get("model_name", "doubao-seed-2-0-lite-260428")
        logger.info("Volcengine Ark 服务初始化成功，默认模型: %s", self.default_model)

    @staticmethod
    def _inject_prompt_cache_payload(extra_body: Dict[str, Any], kwargs: Dict[str, Any]) -> Dict[str, Any]:
        payload = dict(extra_body or {})
        removed = []
        for key in ("prompt_cache_key", "prompt_cache_retention"):
            if payload.pop(key, None) is not None or kwargs.get(key) is not None:
                removed.append(key)
        if removed:
            logger.debug("Volcengine Ark 不支持 prompt caching 字段，已忽略: %s", removed)
        return payload

    def _model_supports_vision(self, model: str) -> bool:
        if super()._model_supports_vision(model):
            return True
        name = (model or "").lower()
        return "doubao" in name or "seed" in name

    def get_supported_models(self) -> List[Dict[str, Any]]:
        models = super().get_supported_models()
        for item in models:
            item["provider"] = "volcengine"
        return models
