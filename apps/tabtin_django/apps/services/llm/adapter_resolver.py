"""统一解析 LLMProvider 对应的 Runtime Service Adapter。

``LLMProvider.name`` 是协议 / 厂商类型；``provider_key`` 是连接身份。
分发必须先认已注册的 ``provider_key``（套餐如 ``kimi_coding``），
再认已注册的 ``name``（如 ``openai``），最后走 Registry 的 OpenAI Compatible 降级。
"""

from __future__ import annotations

from typing import Any


def resolve_adapter_name(provider: Any) -> str:
    """返回 Registry 分发键。无可用字段时返回空串。"""
    from apps.services.llm.registry import ProviderRegistry

    name = str(getattr(provider, "name", "") or "").strip().lower()
    provider_key = str(getattr(provider, "provider_key", "") or "").strip().lower()

    if provider_key and ProviderRegistry.is_registered(provider_key):
        return provider_key
    if name and ProviderRegistry.is_registered(name):
        return name
    return name or provider_key


def resolve_provider_adapter(provider: Any) -> type:
    """返回对应 Service 类。未注册时沿用 Registry 的 OpenAI Compatible 降级。"""
    from apps.services.llm.registry import ProviderRegistry

    return ProviderRegistry.get_service_class(resolve_adapter_name(provider))
