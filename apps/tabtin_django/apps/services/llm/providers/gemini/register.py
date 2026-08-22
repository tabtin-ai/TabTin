from apps.services.llm.registry import ProviderRegistry
from apps.services.llm.interface import ProviderMetadata, ProviderModelDeclaration

ProviderRegistry.register(ProviderMetadata(
    name="gemini",
    display_name="Gemini",
    service_class_path="apps.services.llm.providers.gemini.service.GeminiService",
    sdk_type="openai",
    default_base_url="https://generativelanguage.googleapis.com/v1beta/openai",
    icon_emoji="💎",
    color_class="text-brand-500",
    supports_openai_compat=True,
    default_max_output_tokens=8192,
    fallback_api_key_envs=("GEMINI_API_KEY", "GOOGLE_API_KEY"),
    fallback_base_url_envs=("GEMINI_BASE_URL",),
    fallback_model_envs=("GEMINI_MODEL", "GEMINI_DEFAULT_MODEL"),
    fallback_settings_prefixes=("GEMINI",),
    default_model_name="gemini-2.5-flash",
    capability_domains=frozenset({"llm"}),
    static_models=(
        ProviderModelDeclaration(model_name="gemini-2.5-pro", display_name="Gemini 2.5 Pro", context_window_tokens=1048576, max_output_tokens=65536, supports_vision=True, input_price_per_1k=0.00125, output_price_per_1k=0.01),
        ProviderModelDeclaration(model_name="gemini-2.5-flash", display_name="Gemini 2.5 Flash", context_window_tokens=1048576, max_output_tokens=65536, supports_vision=True, input_price_per_1k=0.000075, output_price_per_1k=0.0003),
        ProviderModelDeclaration(model_name="gemini-2.0-flash", display_name="Gemini 2.0 Flash", context_window_tokens=1048576, max_output_tokens=8192, supports_vision=True, input_price_per_1k=0.0001, output_price_per_1k=0.0004),
    ),
))
