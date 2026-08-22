from apps.services.llm.registry import ProviderRegistry
from apps.services.llm.interface import ProviderMetadata, ProviderModelDeclaration

ProviderRegistry.register(ProviderMetadata(
    name="moonshot",
    display_name="Moonshot",
    service_class_path="apps.services.llm.providers.moonshot.service.MoonshotService",
    sdk_type="openai",
    default_base_url="https://api.moonshot.cn/v1",
    icon_emoji="🌙",
    color_class="text-muted-foreground",
    supports_openai_compat=True,
    default_max_output_tokens=2000,
    fallback_api_key_envs=("MOONSHOT_API_KEY",),
    fallback_base_url_envs=("MOONSHOT_BASE_URL",),
    fallback_model_envs=("MOONSHOT_MODEL", "MOONSHOT_DEFAULT_MODEL"),
    fallback_settings_prefixes=("MOONSHOT",),
    default_model_name="kimi-k2.5",
    capability_domains=frozenset({"llm"}),
    static_models=(
        # 国内站人民币牌价（元/1k）：见 migration 0051 / 0040
        ProviderModelDeclaration(model_name="kimi-k3", display_name="Kimi K3", context_window_tokens=1048576, max_output_tokens=131072, supports_vision=True, supports_video_input=True, supports_document_input=True, input_price_per_1k=0.02, output_price_per_1k=0.1),
        ProviderModelDeclaration(model_name="kimi-k2.6", display_name="Kimi K2.6", context_window_tokens=262144, max_output_tokens=32768, supports_vision=True, supports_video_input=True, supports_document_input=True, input_price_per_1k=0.0065, output_price_per_1k=0.027),
        ProviderModelDeclaration(model_name="kimi-k2.5", display_name="Kimi K2.5", context_window_tokens=131072, max_output_tokens=8192, supports_vision=True, supports_video_input=True, supports_document_input=True, input_price_per_1k=0.004, output_price_per_1k=0.021),
        # ：v1 未配 wire_adapter.document.file_extract，勿开文档能力（Host 放行会上游 400）
        ProviderModelDeclaration(model_name="moonshot-v1-128k", display_name="Moonshot v1 128K", context_window_tokens=131072, max_output_tokens=4096, supports_document_input=False, input_price_per_1k=0.0008, output_price_per_1k=0.0008),
        ProviderModelDeclaration(model_name="moonshot-v1-32k", display_name="Moonshot v1 32K", context_window_tokens=32768, max_output_tokens=4096, supports_document_input=False, input_price_per_1k=0.0003, output_price_per_1k=0.0003),
    ),
))
