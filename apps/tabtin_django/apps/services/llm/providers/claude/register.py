from apps.services.llm.registry import ProviderRegistry
from apps.services.llm.interface import ProviderMetadata, ProviderModelDeclaration

ProviderRegistry.register(ProviderMetadata(
    name="claude",
    display_name="Claude",
    service_class_path="apps.services.llm.providers.claude.service.ClaudeService",
    sdk_type="openai",
    default_base_url="https://api.anthropic.com/v1",
    icon_emoji="🧠",
    color_class="text-warning",
    supports_openai_compat=True,
    default_max_output_tokens=4096,
    fallback_api_key_envs=("CLAUDE_API_KEY", "ANTHROPIC_API_KEY"),
    fallback_base_url_envs=("CLAUDE_BASE_URL", "ANTHROPIC_BASE_URL"),
    fallback_model_envs=("CLAUDE_MODEL", "CLAUDE_DEFAULT_MODEL"),
    fallback_settings_prefixes=("CLAUDE",),
    default_model_name="claude-sonnet-4-20250514",
    capability_domains=frozenset({"llm"}),
    static_models=(
        ProviderModelDeclaration(model_name="claude-sonnet-4-20250514", display_name="Claude Sonnet 4", context_window_tokens=200000, max_output_tokens=16384, supports_vision=True, input_price_per_1k=0.003, output_price_per_1k=0.015),
        ProviderModelDeclaration(model_name="claude-4-opus-20260210", display_name="Claude 4 Opus", context_window_tokens=200000, max_output_tokens=32000, supports_vision=True, input_price_per_1k=0.015, output_price_per_1k=0.075),
        ProviderModelDeclaration(model_name="claude-haiku-4-20260210", display_name="Claude Haiku 4", context_window_tokens=200000, max_output_tokens=8192, supports_vision=True, input_price_per_1k=0.0008, output_price_per_1k=0.004),
    ),
))
