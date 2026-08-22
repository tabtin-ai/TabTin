"""DeepSeek Provider 注册。

DeepSeek 提供 OpenAI 兼容的 Chat Completions 接口（base_url ``https://api.deepseek.com``），
因此直接复用 ``OpenAIService``（与 zenmux / codex / local 同一做法），无需单独 service 类。

兼容性决策（参考 https://api-docs.deepseek.com/ ，2026-07 口径）：
- **只注册现役 V4 模型**（``deepseek-v4-flash`` / ``deepseek-v4-pro``）。旧别名
  ``deepseek-chat`` / ``deepseek-reasoner`` 于 2026-07-24 15:59 UTC 下线，且旧 reasoner
  存在 temperature/top_p/工具调用等参数限制的坑；V4 两个模型均支持工具调用 + JSON 输出，
  故不注册旧别名，规避兼容性地雷。
- V4 默认开启 thinking（思考）模式，会返回 ``reasoning_content``；是否启用/思考强度
  （``reasoning_effort``）按模型在 AdminDash 的 capabilities_config 配置，走 canonical
  stream 的 reasoning_delta 归一化。**思考模式下带工具调用时，需在消息历史保留 assistant
  的 reasoning_content，否则上游 400**——由 wire adapter 负责，不在本注册处理。
- V4 文本模型不支持图片输入（vision），如需多模态用 DeepSeek 独立 VL 模型另行接入。
- ``static_models`` 定价仅用于 Catalog 展示（不参与计费），单位 USD/1K tokens，取自官方
  cache-miss 输入价；实际计费以 AdminDash 的 LLMModel 配置为准，价格可能变动。
"""

from apps.services.llm.registry import ProviderRegistry
from apps.services.llm.interface import ProviderMetadata, ProviderModelDeclaration

ProviderRegistry.register(ProviderMetadata(
    name="deepseek",
    display_name="DeepSeek",
    service_class_path="apps.services.llm.providers.openai.service.OpenAIService",
    sdk_type="openai",
    default_base_url="https://api.deepseek.com",
    icon_emoji="🐋",
    color_class="text-brand-500",
    supports_openai_compat=True,
    default_max_output_tokens=8192,
    fallback_api_key_envs=("DEEPSEEK_API_KEY",),
    fallback_base_url_envs=("DEEPSEEK_BASE_URL",),
    fallback_model_envs=("DEEPSEEK_MODEL", "DEEPSEEK_DEFAULT_MODEL"),
    fallback_settings_prefixes=("DEEPSEEK",),
    default_model_name="deepseek-v4-flash",
    capability_domains=frozenset({"llm"}),
    static_models=(
        ProviderModelDeclaration(
            model_name="deepseek-v4-flash",
            display_name="DeepSeek V4 Flash",
            context_window_tokens=1000000,
            max_output_tokens=65536,
            supports_function_calling=True,
            supports_vision=False,
            input_price_per_1k=0.00014,
            output_price_per_1k=0.00028,
        ),
        ProviderModelDeclaration(
            model_name="deepseek-v4-pro",
            display_name="DeepSeek V4 Pro",
            context_window_tokens=1000000,
            max_output_tokens=65536,
            supports_function_calling=True,
            supports_vision=False,
            input_price_per_1k=0.000435,
            output_price_per_1k=0.00087,
        ),
    ),
))
