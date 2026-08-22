from apps.services.llm.registry import ProviderRegistry
from apps.services.llm.interface import ProviderMetadata, ProviderModelDeclaration

ProviderRegistry.register(ProviderMetadata(
    name="openai",
    display_name="OpenAI",
    service_class_path="apps.services.llm.providers.openai.service.OpenAIService",
    sdk_type="openai",
    default_base_url="https://api.openai.com/v1",
    icon_emoji="🤖",
    color_class="text-success",
    supports_openai_compat=True,
    default_max_output_tokens=2000,
    fallback_api_key_envs=("OPENAI_API_KEY",),
    fallback_base_url_envs=("OPENAI_BASE_URL",),
    fallback_model_envs=("OPENAI_MODEL", "OPENAI_DEFAULT_MODEL"),
    fallback_settings_prefixes=("OPENAI",),
    default_model_name="gpt-4o",
    capability_domains=frozenset({"llm"}),
    static_models=(
        ProviderModelDeclaration(model_name="gpt-4o", display_name="GPT-4o", context_window_tokens=128000, max_output_tokens=16384, supports_vision=True, input_price_per_1k=0.0025, output_price_per_1k=0.01),
        ProviderModelDeclaration(model_name="gpt-4o-mini", display_name="GPT-4o Mini", context_window_tokens=128000, max_output_tokens=16384, supports_vision=True, input_price_per_1k=0.00015, output_price_per_1k=0.0006),
        ProviderModelDeclaration(model_name="o3-mini", display_name="o3 Mini", context_window_tokens=200000, max_output_tokens=100000, input_price_per_1k=0.0011, output_price_per_1k=0.0044),
        ProviderModelDeclaration(model_name="gpt-4.1", display_name="GPT-4.1", context_window_tokens=1047576, max_output_tokens=32768, supports_vision=True, input_price_per_1k=0.002, output_price_per_1k=0.008),
        ProviderModelDeclaration(model_name="gpt-4.1-mini", display_name="GPT-4.1 Mini", context_window_tokens=1047576, max_output_tokens=32768, supports_vision=True, input_price_per_1k=0.0004, output_price_per_1k=0.0016),
    ),
))

ProviderRegistry.register(ProviderMetadata(
    name="codex",
    display_name="OpenAI Codex",
    service_class_path="apps.services.llm.providers.openai.service.OpenAIService",
    sdk_type="openai",
    default_base_url="https://api.openai.com/v1",
    icon_emoji="🤖",
    color_class="text-success",
    supports_openai_compat=True,
    default_max_output_tokens=2000,
    fallback_api_key_envs=("CODEX_API_KEY", "OPENAI_API_KEY"),
    fallback_base_url_envs=("CODEX_BASE_URL", "OPENAI_BASE_URL"),
    fallback_model_envs=("CODEX_MODEL", "CODEX_DEFAULT_MODEL", "OPENAI_MODEL"),
    fallback_settings_prefixes=("CODEX", "OPENAI"),
    default_model_name="gpt-5-codex",
    capability_domains=frozenset({"llm"}),
    static_models=(
        ProviderModelDeclaration(model_name="codex-mini", display_name="Codex Mini", context_window_tokens=200000, max_output_tokens=16384),
        ProviderModelDeclaration(model_name="o3", display_name="o3", context_window_tokens=200000, max_output_tokens=100000, input_price_per_1k=0.002, output_price_per_1k=0.008),
        ProviderModelDeclaration(model_name="o4-mini", display_name="o4 Mini", context_window_tokens=200000, max_output_tokens=100000, input_price_per_1k=0.0011, output_price_per_1k=0.0044),
    ),
))

ProviderRegistry.register(ProviderMetadata(
    name="zenmux",
    display_name="ZenMux",
    service_class_path="apps.services.llm.providers.openai.service.OpenAIService",
    sdk_type="openai",
    default_base_url="https://zenmux.ai/api/v1",
    icon_emoji="🔷",
    color_class="text-muted-foreground",
    supports_openai_compat=True,
    default_max_output_tokens=4096,
    fallback_api_key_envs=("ZENMUX_API_KEY",),
    fallback_base_url_envs=("ZENMUX_BASE_URL",),
    fallback_model_envs=("ZENMUX_MODEL", "ZENMUX_DEFAULT_MODEL"),
    fallback_settings_prefixes=("ZENMUX",),
    default_model_name="anthropic/claude-sonnet-4.6",
    capability_domains=frozenset({"llm"}),
))

ProviderRegistry.register(ProviderMetadata(
    name="local",
    display_name="本地模型",
    service_class_path="apps.services.llm.providers.openai.service.OpenAIService",
    sdk_type="openai",
    default_base_url="",
    icon_emoji="💻",
    color_class="text-muted-foreground",
    supports_openai_compat=True,
    api_key_required=False,
    default_max_output_tokens=2000,
    # ⚠️ 仅 `local` provider 用 300s（用户自 host 模型可能在 CPU 上慢推理）；
    # 其他 provider 走 interface.py:78 默认 120s。注意 chat.completions / embedding /
    # title 这些**短任务**链路如果走了慢 provider，应在调用方加 wall-clock 短熔断
    # （参考 chat/conversation/api/session.py:generate_title 的 asyncio.wait_for 模式），
    # **不要**在 view / sync handler 里裸跑 LLM 调用——会霸占 daphne 主 sync threadpool。
    # dogfood 504718c9 复盘见 docs/agent-runtime/dogfood-debugging-handbook.md §5.7。
    connection_timeout=30,
    request_timeout=300,
    fallback_api_key_envs=("LOCAL_LLM_API_KEY",),
    fallback_base_url_envs=("LOCAL_LLM_BASE_URL",),
    fallback_model_envs=("LOCAL_LLM_MODEL",),
    fallback_settings_prefixes=("LOCAL_LLM",),
    default_model_name="default",
    capability_domains=frozenset({"llm"}),
))
