"""
Moonshot（Kimi）服务实现
"""

from typing import Dict, Any, List
import logging
import requests

from apps.services.llm.providers.openai.service import OpenAIService
from apps.services.llm.utils.capabilities import ModelCapabilities

logger = logging.getLogger(__name__)


class MoonshotService(OpenAIService):
    """
    Moonshot（Kimi）API 服务实现。

    Moonshot 提供 OpenAI 兼容接口：
    - base_url: https://api.moonshot.cn/v1
    - chat: POST /chat/completions
    - models: GET /models
    """

    CAPABILITIES = ModelCapabilities(
        supports_streaming=True,
        supports_function_calling=True,
        supports_vision=True,
        supports_document_input=True,
        supports_prompt_caching=True,
        supports_reasoning=True,
        supports_json_mode=True,
        supports_responses_api=False,
        supports_token_estimate=True,
        supports_tool_choice=True,
        supports_parallel_function_calling=True,
    ).to_dict()

    @classmethod
    def validate_provider_config(cls, provider_name: str, config: dict) -> None:
        if 'moonshot.cn' not in config.get('base_url', ''):
            logger.warning("Moonshot base_url 通常应为 https://api.moonshot.cn/v1")

    def __init__(self, provider_config: Dict[str, Any]):
        super().__init__(provider_config)
        self.default_model = provider_config.get('model_name', 'kimi-k2.5')
        logger.info("Moonshot 服务初始化成功，默认模型: %s", self.default_model)

    @staticmethod
    def _apply_prompt_cache_policy(
        payload: Dict[str, Any],
        *,
        prompt_cache_key: Any = None,
        prompt_cache_retention: Any = None,
    ) -> Dict[str, Any]:
        """统一归一化 SDK 与直连代理路径的 Moonshot 缓存字段。"""
        payload = dict(payload or {})
        if prompt_cache_key is None:
            prompt_cache_key = payload.get("prompt_cache_key")
        if prompt_cache_key is not None:
            normalized_key = str(prompt_cache_key).strip()
            if normalized_key:
                payload["prompt_cache_key"] = normalized_key
            else:
                payload.pop("prompt_cache_key", None)
        if (
            payload.pop("prompt_cache_retention", None) is not None
            or prompt_cache_retention is not None
        ):
            logger.debug("Moonshot 不支持 prompt_cache_retention，已忽略")
        return payload

    @classmethod
    def prepare_proxy_request(
        cls,
        body: Dict[str, Any],
        *,
        session_id: str = "",
        incoming_body: Dict[str, Any] | None = None,
    ) -> Dict[str, Any]:
        """用业务对话标识生成 Moonshot 自动缓存路由键。"""
        payload = super().prepare_proxy_request(
            body,
            session_id=session_id,
            incoming_body=incoming_body,
        )
        incoming_body = incoming_body or {}
        return cls._apply_prompt_cache_policy(
            payload,
            prompt_cache_key=(
                payload.get("prompt_cache_key")
                or incoming_body.get("prompt_cache_key")
                or session_id
            ),
            prompt_cache_retention=(
                payload.get("prompt_cache_retention")
                or incoming_body.get("prompt_cache_retention")
            ),
        )

    @classmethod
    def _inject_prompt_cache_payload(
        cls,
        extra_body: Dict[str, Any],
        kwargs: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Moonshot 支持 prompt_cache_key，但不支持 OpenAI retention 参数。"""
        return cls._apply_prompt_cache_policy(
            extra_body,
            prompt_cache_key=kwargs.get("prompt_cache_key"),
            prompt_cache_retention=kwargs.get("prompt_cache_retention"),
        )

    def _model_supports_json_mode(self, model: str) -> bool:
        if self.model is not None:
            return super()._model_supports_json_mode(model)
        name = (model or "").lower()
        return "kimi-" in name or "moonshot-" in name

    def _model_supports_vision(self, model: str) -> bool:
        if super()._model_supports_vision(model):
            return True
        name = (model or "").lower()
        return "vision" in name or "kimi-k2" in name

    def _prepare_chat_params(self, messages, **kwargs):
        """采样参数清理由 adapt_params 注册表统一处理。"""
        return super()._prepare_chat_params(messages, **kwargs)

    def _estimate_tokens_via_provider(self, messages: List[Dict[str, Any]], **kwargs) -> Dict[str, Any]:
        """
        Moonshot 原生 token 估算，失败时降级到本地 tiktoken。
        """
        base = (self.base_url or "").rstrip("/")
        if not base:
            return self._count_tokens_local_fallback(messages)

        url = f"{base}/tokenizers/estimate-token-count"
        payload = {
            "model": kwargs.get("model", self.default_model),
            "messages": messages,
        }
        try:
            response = requests.post(
                url,
                json=payload,
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
                timeout=10,
            )
            response.raise_for_status()
            body = response.json()

            data = body.get("data") if isinstance(body, dict) else None
            candidates = [body, data] if data is not None else [body]

            for item in candidates:
                if not isinstance(item, dict):
                    continue
                if "total_tokens" in item:
                    total = int(item.get("total_tokens", 0) or 0)
                    return {"input_tokens": total, "output_tokens": 0, "total_tokens": total}
                if "token_count" in item:
                    total = int(item.get("token_count", 0) or 0)
                    return {"input_tokens": total, "output_tokens": 0, "total_tokens": total}

            logger.warning("[Moonshot] token 估算返回结构不支持，降级本地估算: %s", body)
        except Exception as e:
            logger.warning("[Moonshot] 远程 token 估算失败，降级本地估算: %s", e)

        return self._count_tokens_local_fallback(messages)

    def _count_tokens_local_fallback(self, messages: List[Dict[str, Any]]) -> Dict[str, Any]:
        counter = self._get_token_counter()
        total = counter.count_messages_tokens(messages)
        return {"input_tokens": total, "output_tokens": 0, "total_tokens": total}

    def get_supported_models(self) -> List[Dict[str, Any]]:
        models = super().get_supported_models()
        for model in models:
            model["provider"] = "moonshot"
        return models
