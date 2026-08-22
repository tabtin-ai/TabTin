"""
AIServiceProviderRegistry — AI 服务提供商注册中心。

统一管理所有 AI 能力域（LLM / TTS / ASR / 图片 / 视频 / 音乐）的 Provider 元数据。
各 Provider 在其 ``providers/<name>/register.py`` 中声明 ``ProviderMetadata``，
通过 ``capability_domains`` 标注所属能力域。

旧名 ``ProviderRegistry`` 保留为别名以保持向后兼容。

设计决策：
1. _providers / _service_class_cache 是类变量，进程级单例
2. service_class_path 延迟解析 + 缓存
3. clear() 仅供测试用
"""

from __future__ import annotations

import importlib
import logging
from typing import Optional

from .interface import ProviderMetadata

logger = logging.getLogger(__name__)


class AIServiceProviderRegistry:
    """AI 服务提供商注册中心——统一管理所有能力域的 Provider。"""

    _providers: dict[str, ProviderMetadata] = {}
    _service_class_cache: dict[str, type] = {}

    @classmethod
    def register(cls, metadata: ProviderMetadata) -> None:
        """注册一个 Provider。重复注册同名 Provider 时覆盖并清除 Service 类缓存。"""
        if metadata.name in cls._providers:
            logger.info("Provider '%s' 重复注册，将覆盖旧配置", metadata.name)
            cls._service_class_cache.pop(metadata.name, None)
        cls._providers[metadata.name] = metadata

    @classmethod
    def get(cls, name: str) -> Optional[ProviderMetadata]:
        """按名称获取 Provider 元数据，未注册时返回 None。"""
        return cls._providers.get(name)

    @classmethod
    def get_service_class(cls, name: str) -> type:
        """获取 Service 类（延迟加载 + 缓存）。未注册时降级到 OpenAIService。"""
        meta = cls._providers.get(name)
        if meta is None:
            logger.warning(
                "未注册的 Provider '%s'，降级到 OpenAIService（OpenAI 兼容协议）",
                name,
            )
            from apps.services.llm.services.openai_service import OpenAIService
            return OpenAIService

        if meta.name not in cls._service_class_cache:
            module_path, class_name = meta.service_class_path.rsplit(".", 1)
            module = importlib.import_module(module_path)
            cls._service_class_cache[meta.name] = getattr(module, class_name)

        return cls._service_class_cache[meta.name]

    @classmethod
    def all_choices(cls) -> list[tuple[str, str]]:
        """生成 Django choices 列表（替代硬编码 PROVIDER_CHOICES）。"""
        return [
            (name, meta.display_name)
            for name, meta in sorted(cls._providers.items())
        ]

    @classmethod
    def get_by_capability(cls, domain: str) -> list[ProviderMetadata]:
        """按能力域查询所有支持该能力的 Provider。"""
        return [m for m in cls._providers.values() if domain in m.capability_domains]

    @classmethod
    def all_metadata(cls) -> dict[str, dict]:
        """返回所有 Provider 元数据字典（供 Catalog API 消费）。"""
        from apps.services.llm.provider_icons import build_provider_icon_url

        result: dict[str, dict] = {}
        for name, meta in cls._providers.items():
            payload = {
                "display_name": meta.display_name,
                "icon_emoji": meta.icon_emoji,
                "color_class": meta.color_class,
                "default_base_url": meta.default_base_url,
                "supports_openai_compat": meta.supports_openai_compat,
                "api_key_required": meta.api_key_required,
                "sdk_type": meta.sdk_type,
                "capability_domains": sorted(meta.capability_domains),
            }
            icon_url = build_provider_icon_url(name, meta.icon_key)
            if icon_url:
                payload["icon_url"] = icon_url
            result[name] = payload
        return result

    @classmethod
    def is_registered(cls, name: str) -> bool:
        return name in cls._providers

    @classmethod
    def provider_count(cls) -> int:
        """返回已注册 Provider 数量。"""
        return len(cls._providers)

    @classmethod
    def clear(cls) -> None:
        """测试用：清空注册表。"""
        cls._providers.clear()
        cls._service_class_cache.clear()


# 向后兼容别名
ProviderRegistry = AIServiceProviderRegistry
