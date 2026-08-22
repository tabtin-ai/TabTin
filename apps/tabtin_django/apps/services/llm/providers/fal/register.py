from apps.services.llm.registry import ProviderRegistry
from apps.services.llm.interface import ProviderMetadata, ProviderModelDeclaration

ProviderRegistry.register(ProviderMetadata(
    name="fal",
    display_name="fal.ai",
    service_class_path="apps.services.media_generation.services.image.fal_image_service.FalImageService",
    sdk_type="custom",
    default_base_url="https://queue.fal.run",
    icon_emoji="⚡",
    color_class="text-violet-500",
    supports_openai_compat=False,
    capability_domains=frozenset({"image_gen", "video_gen"}),
    fallback_api_key_envs=("FAL_API_KEY", "FAL_KEY"),
    fallback_base_url_envs=("FAL_BASE_URL",),
    fallback_settings_prefixes=("FAL",),
    static_models=(
        ProviderModelDeclaration(model_name="fal-ai/flux/dev", display_name="FLUX Dev", mode="image_generation", context_window_tokens=0, max_output_tokens=0, supports_function_calling=False),
        ProviderModelDeclaration(model_name="fal-ai/flux/schnell", display_name="FLUX Schnell", mode="image_generation", context_window_tokens=0, max_output_tokens=0, supports_function_calling=False),
        ProviderModelDeclaration(model_name="fal-ai/recraft-v3", display_name="Recraft V3", mode="image_generation", context_window_tokens=0, max_output_tokens=0, supports_function_calling=False),
        ProviderModelDeclaration(model_name="fal-ai/kling-video/v1/standard", display_name="Kling Video Standard", mode="video_generation", context_window_tokens=0, max_output_tokens=0, supports_function_calling=False),
        ProviderModelDeclaration(model_name="fal-ai/minimax-video", display_name="MiniMax Video", mode="video_generation", context_window_tokens=0, max_output_tokens=0, supports_function_calling=False),
    ),
))
