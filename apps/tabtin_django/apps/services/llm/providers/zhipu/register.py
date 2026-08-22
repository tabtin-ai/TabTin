"""智谱 GLM Provider 注册。

GLM Coding Plan 走 OpenAI 兼容 Chat Completions：
https://open.bigmodel.cn/api/coding/paas/v4

按量 API 与 Coding Plan 专属 Key / Base URL 不互通，见官方接入文档。
"""

from apps.services.llm.registry import ProviderRegistry
from apps.services.llm.interface import ProviderMetadata, ProviderModelDeclaration

ProviderRegistry.register(ProviderMetadata(
    name="zhipu",
    display_name="智谱 GLM",
    service_class_path="apps.services.llm.providers.openai.service.OpenAIService",
    sdk_type="openai",
    default_base_url="https://open.bigmodel.cn/api/coding/paas/v4",
    icon_emoji="🧠",
    color_class="text-brand-500",
    supports_openai_compat=True,
    default_max_output_tokens=8192,
    fallback_api_key_envs=("ZHIPU_API_KEY", "GLM_API_KEY"),
    fallback_base_url_envs=("ZHIPU_BASE_URL", "GLM_BASE_URL"),
    fallback_model_envs=("ZHIPU_MODEL", "GLM_MODEL", "GLM_DEFAULT_MODEL"),
    fallback_settings_prefixes=("ZHIPU", "GLM"),
    default_model_name="glm-5.2",
    capability_domains=frozenset({"llm"}),
    static_models=(
        ProviderModelDeclaration(
            model_name="glm-5.2",
            display_name="GLM-5.2",
            context_window_tokens=1000000,
            max_output_tokens=65536,
            supports_function_calling=True,
            input_price_per_1k=0.0,
            output_price_per_1k=0.0,
        ),
        ProviderModelDeclaration(
            model_name="glm-5-turbo",
            display_name="GLM-5 Turbo",
            context_window_tokens=200000,
            max_output_tokens=65536,
            supports_function_calling=True,
        ),
        ProviderModelDeclaration(
            model_name="glm-4.7",
            display_name="GLM-4.7",
            context_window_tokens=200000,
            max_output_tokens=65536,
            supports_function_calling=True,
            supports_json_mode=True,
            json_modes=("json_object",),
        ),
    ),
))
