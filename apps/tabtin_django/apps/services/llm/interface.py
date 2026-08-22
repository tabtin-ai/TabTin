"""
AI Service Provider 契约层——定义 ProviderMetadata 数据类。

每个 AI Service Provider（LLM / TTS / ASR / 图片 / 视频 / 音乐）在其
register.py 中声明一个 ProviderMetadata 实例，通过 ``capability_domains``
标注所属能力域，供 AIServiceProviderRegistry、各域工厂、Catalog API 等消费。

设计决策：
- service_class_path 使用字符串而非直接类引用，避免 AppConfig.ready() 时循环 import
- @dataclass(frozen=True) 保证注册后不可变，进程级安全
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class ProviderModelDeclaration:
    """Provider 静态声明的模型——在 register.py 中定义，作为 DB 的补充。

    DB 中已存在的同名模型不会被声明覆盖（DB 数据始终优先）。
    声明仅用于 Catalog API 展示，不影响路由和计费。
    """

    model_name: str
    display_name: str = ""
    mode: str = "chat"
    context_window_tokens: int = 128000
    max_output_tokens: int = 4096
    supports_function_calling: bool = True
    supports_vision: bool = False
    supports_video_input: bool = False
    supports_document_input: bool = False
    supports_streaming: bool = True
    supports_json_mode: bool | None = None
    json_modes: tuple[str, ...] = ()
    input_price_per_1k: float = 0.0
    output_price_per_1k: float = 0.0


@dataclass(frozen=True)
class ProviderMetadata:
    """AI Service Provider 元数据——在 register.py 中声明，供 Registry、Factory、Catalog API 消费。

    Attributes:
        name: 唯一标识（如 'openai'），与 DB ``LLMProvider.name`` 对应
        display_name: 展示名（如 'OpenAI'）
        service_class_path: Service 类的完整 import 路径（延迟加载避免循环依赖）
        sdk_type: SDK 类型——'openai' | 'anthropic' | 'custom'
        default_base_url: 默认 API 地址
        icon_emoji: 遗留字段（Catalog 仍下发）；模型选择器无 icon_url，缺失时前端用 lucide Bot
        icon_key: 品牌图标 stem（``provider_icons`` → ``/api/services/llm/provider-icons/<key>``）；
            空则按 provider.name 查默认映射，仍无则 Catalog 不返回 icon_url
        color_class: 前端颜色类
        supports_openai_compat: 是否兼容 OpenAI 协议
        fallback_api_key_envs: Django settings 属性名，按优先级排列
            如 ("OPENAI_API_KEY",) 或 ("CLAUDE_API_KEY", "ANTHROPIC_API_KEY")
        fallback_base_url_envs: 同上，用于 base_url；未命中时回退到 default_base_url
        fallback_model_envs: 同上，用于 model_name；未命中时回退到 default_model_name
        default_max_output_tokens: Provider 级别的默认最大输出 token 数，
            当 kwargs 和 DB 均未指定 max_output_tokens 时的兜底值
        fallback_settings_prefixes: 设置名前缀，用于派生 {PREFIX}_CONTEXT_WINDOW_TOKENS 等
            如 ("CODEX", "OPENAI") 表示先查 CODEX_*，再查 OPENAI_*
        default_model_name: 硬编码默认模型名（如 "gpt-4o"）
        capability_domains: 此 Provider 支持的能力域集合，如 {"llm"}、{"tts", "asr"}、
            {"image_gen", "video_gen"}。用于跨域查询和 Registry 按能力域过滤。
        static_models: Provider 静态声明的模型列表，在 Catalog API 中与 DB 融合展示
    """

    name: str
    display_name: str
    service_class_path: str
    sdk_type: str = "openai"
    default_base_url: str = ""
    icon_emoji: str = "🔷"
    icon_key: str = ""
    color_class: str = "text-muted-foreground"
    supports_openai_compat: bool = True

    api_key_required: bool = True
    default_max_output_tokens: int = 4096
    connection_timeout: int = 5
    request_timeout: int = 120

    fallback_api_key_envs: tuple[str, ...] = ()
    fallback_base_url_envs: tuple[str, ...] = ()
    fallback_model_envs: tuple[str, ...] = ()
    fallback_settings_prefixes: tuple[str, ...] = ()
    default_model_name: str = ""

    capability_domains: frozenset[str] = frozenset({"llm"})

    static_models: tuple[ProviderModelDeclaration, ...] = ()
