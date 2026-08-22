from apps.services.llm.registry import ProviderRegistry
from apps.services.llm.interface import ProviderMetadata

ProviderRegistry.register(ProviderMetadata(
    name="bytedance",
    display_name="字节跳动",
    service_class_path="apps.services.speech.tts.providers.bytedance.http_unidirectional.ByteDanceHttpTTS",
    sdk_type="custom",
    default_base_url="",
    icon_emoji="🎙️",
    color_class="text-brand-500",
    supports_openai_compat=False,
    capability_domains=frozenset({"tts", "asr"}),
    fallback_api_key_envs=("BYTEDANCE_TTS_ACCESS_TOKEN", "BYTEDANCE_ASR_ACCESS_TOKEN"),
    fallback_settings_prefixes=("BYTEDANCE_TTS", "BYTEDANCE_ASR"),
))
