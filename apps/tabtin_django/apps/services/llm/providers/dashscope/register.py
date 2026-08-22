from apps.services.llm.registry import ProviderRegistry
from apps.services.llm.interface import ProviderMetadata, ProviderModelDeclaration

ProviderRegistry.register(ProviderMetadata(
    name="dashscope",
    display_name="阿里云百炼",
    service_class_path="apps.services.media_generation.services.image.dashscope_image_service.DashScopeImageService",
    sdk_type="custom",
    default_base_url="https://dashscope.aliyuncs.com/api/v1",
    icon_emoji="🎨",
    color_class="text-brand-500",
    supports_openai_compat=False,
    capability_domains=frozenset({"image_gen", "video_gen"}),
    fallback_api_key_envs=("DASHSCOPE_API_KEY", "QWEN_API_KEY"),
    fallback_base_url_envs=("DASHSCOPE_BASE_URL",),
    fallback_settings_prefixes=("DASHSCOPE",),
    static_models=(
        ProviderModelDeclaration(model_name="wan2.6-t2i", display_name="万相 2.6 文生图", mode="image_generation", context_window_tokens=0, max_output_tokens=0, supports_function_calling=False, input_price_per_1k=0.0, output_price_per_1k=0.0),
        ProviderModelDeclaration(model_name="qwen-image-max", display_name="千问图像 Max", mode="image_generation", context_window_tokens=0, max_output_tokens=0, supports_function_calling=False),
        ProviderModelDeclaration(model_name="flux-schnell", display_name="FLUX Schnell", mode="image_generation", context_window_tokens=0, max_output_tokens=0, supports_function_calling=False),
        ProviderModelDeclaration(model_name="wan2.6-t2v", display_name="万相 2.6 文生视频", mode="video_generation", context_window_tokens=0, max_output_tokens=0, supports_function_calling=False),
        ProviderModelDeclaration(model_name="wan2.6-i2v-flash", display_name="万相 2.6 图生视频", mode="video_generation", context_window_tokens=0, max_output_tokens=0, supports_function_calling=False),
    ),
))
