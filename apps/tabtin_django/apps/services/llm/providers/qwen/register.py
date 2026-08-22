from apps.services.llm.registry import ProviderRegistry
from apps.services.llm.interface import ProviderMetadata, ProviderModelDeclaration

ProviderRegistry.register(ProviderMetadata(
    name="qwen",
    display_name="通义千问",
    service_class_path="apps.services.llm.providers.qwen.service.QwenService",
    sdk_type="openai",
    default_base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
    icon_emoji="🌟",
    color_class="text-brand-500",
    supports_openai_compat=True,
    default_max_output_tokens=4000,
    fallback_api_key_envs=("QWEN_API_KEY",),
    fallback_base_url_envs=("QWEN_BASE_URL",),
    fallback_model_envs=("QWEN_MODEL", "QWEN_DEFAULT_MODEL"),
    fallback_settings_prefixes=("QWEN",),
    default_model_name="qwen3-coder-flash",
    capability_domains=frozenset({"llm"}),
    static_models=(
        ProviderModelDeclaration(model_name="qwen3-235b", display_name="Qwen3 235B", context_window_tokens=131072, max_output_tokens=16384, supports_vision=False, input_price_per_1k=0.004, output_price_per_1k=0.016),
        ProviderModelDeclaration(model_name="qwen3-30b", display_name="Qwen3 30B", context_window_tokens=131072, max_output_tokens=16384, input_price_per_1k=0.0008, output_price_per_1k=0.002),
        ProviderModelDeclaration(model_name="qwen3-coder-plus", display_name="Qwen3 Coder Plus", context_window_tokens=131072, max_output_tokens=16384, input_price_per_1k=0.002, output_price_per_1k=0.006),
        ProviderModelDeclaration(model_name="qwen-vl-max", display_name="Qwen VL Max", context_window_tokens=131072, max_output_tokens=8192, supports_vision=True, input_price_per_1k=0.003, output_price_per_1k=0.009),
    ),
))
