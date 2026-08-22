"""
通义千问服务实现
"""

from typing import Dict, Any, List
import logging

from apps.services.llm.providers.openai.service import OpenAIService
from apps.services.llm.utils.capabilities import ModelCapabilities

logger = logging.getLogger(__name__)

QWEN_DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
QWEN_DEFAULT_MAX_OUTPUT_TOKENS = 4000


class QwenService(OpenAIService):
    """通义千问 API 服务实现（继承 OpenAI 兼容层）。

    Qwen 使用完全兼容的 OpenAI Chat Completions 协议，
    仅在搜索增强、视觉模型识别等方面有少量差异。
    """

    CAPABILITIES = ModelCapabilities(
        supports_streaming=True,
        supports_function_calling=True,
        supports_vision=False,
        supports_document_input=False,
        supports_prompt_caching=True,
        supports_reasoning=True,
        supports_json_mode=True,
        supports_responses_api=False,
        supports_token_estimate=False,
        supports_tool_choice=True,
        supports_parallel_function_calling=False,
    ).to_dict()

    @classmethod
    def validate_provider_config(cls, provider_name: str, config: dict) -> None:
        base_url = config.get('base_url', '')
        if 'dashscope.aliyuncs.com' in base_url:
            if not config.get('api_key', '').startswith('sk-'):
                logger.warning("通义千问API密钥格式可能不正确")
        else:
            logger.info("使用自定义通义千问API端点")

    def __init__(self, provider_config: Dict[str, Any]):
        if not provider_config.get('base_url'):
            provider_config = dict(provider_config)
            provider_config['base_url'] = QWEN_DEFAULT_BASE_URL
            logger.warning("Qwen base_url 未配置，使用默认值: %s", QWEN_DEFAULT_BASE_URL)

        super().__init__(provider_config)
        self.default_model = provider_config.get('model_name', 'qwen3-coder-flash')
        self.organization_id = provider_config.get('organization_id')

        if self.max_output_tokens is None:
            self.max_output_tokens = QWEN_DEFAULT_MAX_OUTPUT_TOKENS

    # ------------------------------------------------------------------
    # 能力判断覆写
    # ------------------------------------------------------------------

    def supports_structured_output(self) -> bool:
        if self.supports_function_calling is not None:
            return bool(self.supports_function_calling)
        return self.get_capability("structured_output", default=False)

    def _model_supports_vision(self, model: str) -> bool:
        if super()._model_supports_vision(model):
            return True
        name = (model or "").lower()
        return any(kw in name for kw in ("qwen-vl", "qwen2-vl", "qwen2.5-vl", "qwen3-vl"))

    def _model_supports_json_mode(self, model: str) -> bool:
        if self.model is not None:
            return super()._model_supports_json_mode(model)
        return True

    # ------------------------------------------------------------------
    # 搜索增强参数注入
    # ------------------------------------------------------------------

    def _prepare_chat_params(self, messages, **kwargs):
        params = super()._prepare_chat_params(messages, **kwargs)

        if kwargs.get('enable_search') or kwargs.get('web_search_options'):
            extra_body = params.get('extra_body') or {}
            if kwargs.get('enable_search'):
                extra_body['enable_search'] = True
            web_search_opts = kwargs.get('web_search_options')
            if isinstance(web_search_opts, dict):
                extra_body['web_search_options'] = web_search_opts
            params['extra_body'] = extra_body

        return params

    # ------------------------------------------------------------------
    # 模型列表
    # ------------------------------------------------------------------

    def get_supported_models(self) -> List[Dict[str, Any]]:
        return [
            {
                "id": "qwen3-coder-flash",
                "name": "通义千问Plus",
                "provider": "qwen",
                "supports_vision": False,
                "supports_json": True,
                "description": "通用对话模型，平衡性能和成本",
            },
            {
                "id": "qwen-max",
                "name": "通义千问Max",
                "provider": "qwen",
                "supports_vision": False,
                "supports_json": True,
                "description": "最强性能模型，适合复杂任务",
            },
            {
                "id": "qwen-vl-plus",
                "name": "通义千问VL Plus",
                "provider": "qwen",
                "supports_vision": True,
                "supports_json": True,
                "description": "多模态模型，支持图片理解",
            },
            {
                "id": "qwen-vl-max",
                "name": "通义千问VL Max",
                "provider": "qwen",
                "supports_vision": True,
                "supports_json": True,
                "description": "最强多模态模型",
            },
        ]
