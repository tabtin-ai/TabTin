from __future__ import annotations

import os
from dataclasses import replace
from typing import Type

from django.conf import settings

from apps.services.search.constants import (
    BOCHA_API_KEY_ENV_NAME,
    DEFAULT_SEARCH_COUNT,
    DEFAULT_SEARCH_FRESHNESS,
    DEFAULT_SEARCH_PROVIDER_KEY,
    DEFAULT_SEARCH_PROVIDER_NAME,
    DEFAULT_SEARCH_PROVIDER_TYPE,
    DEFAULT_SEARCH_TIMEOUT_SEC,
    DOUBAO_API_KEY_ENV_NAME,
    QIANFAN_API_KEY_ENV_NAME,
    QIANFAN_SEARCH_BASE_URL,
)
from apps.services.search.models import SearchGlobalConfig, SearchProvider
from apps.services.search.services.base import (
    BaseSearchProvider,
    RuntimeSearchProviderConfig,
    SearchProviderError,
)
from apps.services.search.services.providers import (
    BochaSearchProvider,
    DoubaoSearchProvider,
    QianfanSearchProvider,
)


class SearchProviderRuntime:
    _provider_map: dict[str, Type[BaseSearchProvider]] = {
        "qianfan": QianfanSearchProvider,
        "bocha": BochaSearchProvider,
        "doubao": DoubaoSearchProvider,
    }

    @classmethod
    def get_global_config(cls) -> SearchGlobalConfig:
        config = SearchGlobalConfig.objects.order_by("-updated_at", "-created_at").first()
        if config:
            return config
        return SearchGlobalConfig.objects.create(
            default_provider_key=getattr(settings, "SEARCH_DEFAULT_PROVIDER", DEFAULT_SEARCH_PROVIDER_KEY),
            default_count=getattr(settings, "SEARCH_DEFAULT_COUNT", DEFAULT_SEARCH_COUNT),
            default_summary_enabled=getattr(settings, "SEARCH_DEFAULT_SUMMARY_ENABLED", True),
            default_freshness=getattr(settings, "SEARCH_DEFAULT_FRESHNESS", DEFAULT_SEARCH_FRESHNESS),
        )

    @classmethod
    def list_providers(cls):
        return SearchProvider.objects.all().order_by("-priority", "-created_at")

    @classmethod
    def resolve_provider(cls, provider_key: str | None = None) -> RuntimeSearchProviderConfig:
        config = cls.get_global_config()
        target_key = (provider_key or config.default_provider_key or DEFAULT_SEARCH_PROVIDER_KEY).strip()

        provider = None
        if target_key:
            provider = SearchProvider.objects.filter(provider_key=target_key).first()

        if provider is None:
            provider = SearchProvider.objects.filter(is_active=True).order_by("-priority", "-created_at").first()

        if provider is None:
            return cls._fallback_default_provider()

        if not provider.is_active:
            raise SearchProviderError(
                f"搜索提供商已停用: {provider.provider_key}",
                provider_key=provider.provider_key,
                code="search_provider_inactive",
            )
        return cls.to_runtime_config(provider)

    @classmethod
    def to_runtime_config(cls, provider: SearchProvider) -> RuntimeSearchProviderConfig:
        api_key, source = cls.resolve_api_key(provider)
        return RuntimeSearchProviderConfig(
            provider_type=provider.provider_type,
            provider_key=provider.provider_key,
            display_name=provider.display_name,
            base_url=provider.base_url,
            api_key=api_key,
            api_key_source=source,
            request_timeout_sec=provider.request_timeout_sec or DEFAULT_SEARCH_TIMEOUT_SEC,
            capabilities_config=provider.capabilities_config or {},
            extra_config=provider.extra_config or {},
        )

    @classmethod
    def resolve_api_key(cls, provider: SearchProvider) -> tuple[str, str]:
        if provider.provider_type != "doubao" and provider.api_key:
            return provider.api_key, "database"
        env_name = DOUBAO_API_KEY_ENV_NAME if provider.provider_type == "doubao" else (provider.api_key_env_name or "").strip()
        if not env_name:
            if provider.provider_type == "bocha":
                env_name = BOCHA_API_KEY_ENV_NAME
            else:
                env_name = QIANFAN_API_KEY_ENV_NAME
        env_value = os.getenv(env_name) or getattr(settings, env_name, "")
        if env_value:
            return env_value, f"env:{env_name}"
        return "", f"env:{env_name}"

    @classmethod
    def mask_api_key(cls, provider: SearchProvider) -> tuple[str, str]:
        value, source = cls.resolve_api_key(provider)
        if not value:
            if source.startswith("env:"):
                return "未配置", source
            return "未配置", "unset"
        if len(value) <= 8:
            return "***", source
        return f"{value[:4]}...{value[-4:]}", source

    @classmethod
    def create_provider_client(
        cls,
        runtime_config: RuntimeSearchProviderConfig,
        *,
        single_attempt: bool = False,
    ) -> BaseSearchProvider:
        provider_cls = cls._provider_map.get(runtime_config.provider_type)
        if not provider_cls:
            raise SearchProviderError(
                f"暂不支持的搜索提供商: {runtime_config.provider_type}",
                provider_key=runtime_config.provider_key,
                code="search_provider_unsupported",
            )
        if single_attempt and runtime_config.provider_type == "doubao":
            runtime_config = replace(
                runtime_config,
                extra_config={**runtime_config.extra_config, "max_retries": 0},
            )
        return provider_cls(runtime_config)

    @classmethod
    def _fallback_default_provider(cls) -> RuntimeSearchProviderConfig:
        api_key = os.getenv(QIANFAN_API_KEY_ENV_NAME) or getattr(settings, QIANFAN_API_KEY_ENV_NAME, "")
        source = f"env:{QIANFAN_API_KEY_ENV_NAME}" if api_key else "unset"
        return RuntimeSearchProviderConfig(
            provider_type=DEFAULT_SEARCH_PROVIDER_TYPE,
            provider_key=DEFAULT_SEARCH_PROVIDER_KEY,
            display_name=DEFAULT_SEARCH_PROVIDER_NAME,
            base_url=getattr(settings, "QIANFAN_SEARCH_BASE_URL", QIANFAN_SEARCH_BASE_URL),
            api_key=api_key,
            api_key_source=source,
            request_timeout_sec=getattr(settings, "SEARCH_REQUEST_TIMEOUT_SEC", DEFAULT_SEARCH_TIMEOUT_SEC),
            capabilities_config={"summary": True, "freshness": True, "image": False},
            extra_config={"search_source": "baidu_search_v2"},
        )
