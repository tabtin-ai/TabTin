from apps.services.llm.registry import ProviderRegistry
from apps.services.llm.interface import ProviderMetadata, ProviderModelDeclaration

ProviderRegistry.register(ProviderMetadata(
    name="minimax",
    display_name="MiniMax",
    service_class_path="apps.services.llm.providers.minimax.service.MiniMaxService",
    sdk_type="anthropic",
    default_base_url="https://api.minimaxi.com/anthropic",
    icon_emoji="🔷",
    color_class="text-muted-foreground",
    supports_openai_compat=False,
    default_max_output_tokens=4096,
    fallback_api_key_envs=("MINIMAX_API_KEY",),
    fallback_base_url_envs=("MINIMAX_BASE_URL",),
    fallback_model_envs=("MINIMAX_MODEL", "MINIMAX_DEFAULT_MODEL"),
    fallback_settings_prefixes=("MINIMAX",),
    default_model_name="MiniMax-M3",
    capability_domains=frozenset({"llm"}),
    static_models=(
        ProviderModelDeclaration(model_name="MiniMax-M3", display_name="MiniMax M3 (1M)", context_window_tokens=1000000, max_output_tokens=64000, supports_vision=True, input_price_per_1k=0.0021, output_price_per_1k=0.0084),
        ProviderModelDeclaration(model_name="MiniMax-M2.7", display_name="MiniMax M2.7", context_window_tokens=204800, max_output_tokens=131072, input_price_per_1k=0.0021, output_price_per_1k=0.0084),
        ProviderModelDeclaration(model_name="MiniMax-M2.7-highspeed", display_name="MiniMax M2.7 Highspeed", context_window_tokens=204800, max_output_tokens=131072, input_price_per_1k=0.0042, output_price_per_1k=0.0168),
    ),
))

ProviderRegistry.register(ProviderMetadata(
    name="minimax_bgm",
    display_name="MiniMax BGM",
    service_class_path="apps.services.music.minimax_music.MiniMaxMusicService",
    sdk_type="custom",
    default_base_url="https://api.minimaxi.com/v1/music_generation",
    icon_emoji="🎵",
    color_class="text-brand-500",
    supports_openai_compat=False,
    capability_domains=frozenset({"audio_generation", "bgm"}),
    fallback_api_key_envs=("MINIMAX_API_KEY",),
    fallback_settings_prefixes=("MINIMAX_BGM", "MINIMAX"),
    static_models=(
        ProviderModelDeclaration(model_name="music-2.5", display_name="MiniMax Music 2.5", mode="audio_generation", context_window_tokens=0, max_output_tokens=0, supports_function_calling=False),
    ),
))
