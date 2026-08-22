from apps.services.llm.interface import ProviderMetadata, ProviderModelDeclaration
from apps.services.llm.registry import ProviderRegistry


ProviderRegistry.register(ProviderMetadata(
    name="kimi_coding",
    display_name="Kimi For Coding",
    service_class_path="apps.services.llm.providers.openai.service.OpenAIService",
    sdk_type="openai",
    default_base_url="https://api.kimi.com/coding/v1",
    icon_emoji="🌙",
    color_class="text-muted-foreground",
    supports_openai_compat=True,
    default_max_output_tokens=32_768,
    default_model_name="kimi-for-coding",
    capability_domains=frozenset({"llm"}),
    static_models=(
        ProviderModelDeclaration(
            model_name="kimi-for-coding",
            display_name="Kimi K2.7 Code",
            context_window_tokens=262_144,
            max_output_tokens=32_768,
        ),
        ProviderModelDeclaration(
            model_name="kimi-for-coding-highspeed",
            display_name="Kimi K2.7 Code HighSpeed",
            context_window_tokens=262_144,
            max_output_tokens=32_768,
        ),
        ProviderModelDeclaration(
            model_name="k3-256k",
            display_name="Kimi K3 256K",
            context_window_tokens=262_144,
            max_output_tokens=131_072,
        ),
    ),
))
