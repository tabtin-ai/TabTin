from apps.services.llm.registry import ProviderRegistry
from apps.services.llm.interface import ProviderMetadata, ProviderModelDeclaration

ProviderRegistry.register(ProviderMetadata(
    name="replicate",
    display_name="Replicate",
    service_class_path="apps.services.media_generation.services.image.replicate_image_service.ReplicateImageService",
    sdk_type="custom",
    default_base_url="https://api.replicate.com/v1",
    icon_emoji="🔄",
    color_class="text-amber-500",
    supports_openai_compat=False,
    capability_domains=frozenset({"image_gen", "video_gen"}),
    fallback_api_key_envs=("REPLICATE_API_TOKEN", "REPLICATE_API_KEY"),
    fallback_base_url_envs=("REPLICATE_BASE_URL",),
    fallback_settings_prefixes=("REPLICATE",),
    static_models=(
        ProviderModelDeclaration(model_name="black-forest-labs/flux-schnell", display_name="FLUX Schnell", mode="image_generation", context_window_tokens=0, max_output_tokens=0, supports_function_calling=False),
        ProviderModelDeclaration(model_name="black-forest-labs/flux-1.1-pro", display_name="FLUX 1.1 Pro", mode="image_generation", context_window_tokens=0, max_output_tokens=0, supports_function_calling=False),
        ProviderModelDeclaration(model_name="bytedance/seedance-1-pro", display_name="Seedance Pro", mode="video_generation", context_window_tokens=0, max_output_tokens=0, supports_function_calling=False),
        ProviderModelDeclaration(model_name="luma/ray", display_name="Luma Ray", mode="video_generation", context_window_tokens=0, max_output_tokens=0, supports_function_calling=False),
    ),
))
