"""Edition-aware startup capabilities and external endpoint resolution."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Mapping
from urllib.parse import urlsplit

from tabtin.edition import TabTinEdition, resolve_edition_configuration


class StartupCapability(StrEnum):
    DJANGO_API = "django_api"
    POSTGRESQL = "postgresql"
    REDIS = "redis"
    CELERY_CORE = "celery_core"
    CENTRIFUGO = "centrifugo"
    BUILTIN_IM = "builtin_im"
    LOCAL_STORAGE = "local_storage"
    EMAIL_PHONE_AUTH = "email_phone_auth"
    ORGANIZATION = "organization"
    WORKSPACE = "workspace"
    AGENT = "agent"
    DEVICE_RUNTIME_PRESENCE = "device_runtime_presence"
    AI_MODEL = "ai_model"
    EMAIL_DELIVERY = "email_delivery"
    WEB_PORTAL = "web_portal"
    RUNTIME_ONLINE = "runtime_online"
    SENTRY = "sentry"
    TELEMETRY = "telemetry"
    EXTERNAL_CHANNELS = "external_channels"
    PAYMENT = "payment"
    OFFICIAL_CREDIT = "official_credit"
    OFFICIAL_MODEL = "official_model"
    COMPANY_LLM_PROXY = "company_llm_proxy"
    EXTERNAL_IM = "external_im"
    ALIYUN_OSS = "aliyun_oss"
    OFFICIAL_UPDATER = "official_updater"
    COMPANY_ENDPOINTS = "company_endpoints"


@dataclass(frozen=True)
class _CapabilityRule:
    enabled_by_default: bool
    startup_required: bool
    user_configurable: bool


_CORE = _CapabilityRule(True, True, False)
_OPTIONAL = _CapabilityRule(False, False, True)
_DISABLED = _CapabilityRule(False, False, False)

_COMMUNITY_RULES: dict[StartupCapability, _CapabilityRule] = {
    **{
        capability: _CORE
        for capability in (
            StartupCapability.DJANGO_API,
            StartupCapability.POSTGRESQL,
            StartupCapability.REDIS,
            StartupCapability.CELERY_CORE,
            StartupCapability.CENTRIFUGO,
            StartupCapability.BUILTIN_IM,
            StartupCapability.LOCAL_STORAGE,
            StartupCapability.EMAIL_PHONE_AUTH,
            StartupCapability.ORGANIZATION,
            StartupCapability.WORKSPACE,
            StartupCapability.AGENT,
            StartupCapability.DEVICE_RUNTIME_PRESENCE,
        )
    },
    **{
        capability: _OPTIONAL
        for capability in (
            StartupCapability.AI_MODEL,
            StartupCapability.EMAIL_DELIVERY,
            StartupCapability.WEB_PORTAL,
            StartupCapability.RUNTIME_ONLINE,
            StartupCapability.SENTRY,
            StartupCapability.TELEMETRY,
            StartupCapability.EXTERNAL_CHANNELS,
        )
    },
    **{
        capability: _DISABLED
        for capability in (
            StartupCapability.PAYMENT,
            StartupCapability.OFFICIAL_CREDIT,
            StartupCapability.OFFICIAL_MODEL,
            StartupCapability.COMPANY_LLM_PROXY,
            StartupCapability.EXTERNAL_IM,
            StartupCapability.ALIYUN_OSS,
            StartupCapability.OFFICIAL_UPDATER,
            StartupCapability.COMPANY_ENDPOINTS,
        )
    },
}

if set(_COMMUNITY_RULES) != set(StartupCapability):
    raise RuntimeError("Community startup capability classification is incomplete")


@dataclass(frozen=True)
class StartupPolicy:
    edition: TabTinEdition

    @property
    def is_community(self) -> bool:
        return self.edition is TabTinEdition.COMMUNITY

    def _rule(self, capability: StartupCapability) -> _CapabilityRule:
        if not self.is_community:
            return _CapabilityRule(True, True, True)
        return _COMMUNITY_RULES[capability]

    def is_enabled_by_default(self, capability: StartupCapability) -> bool:
        return self._rule(capability).enabled_by_default

    def is_startup_required(self, capability: StartupCapability) -> bool:
        return self._rule(capability).startup_required

    def blocks_startup(
        self,
        capability: StartupCapability,
        *,
        configured: bool,
    ) -> bool:
        return self.is_startup_required(capability) and not configured

    def allows(
        self,
        capability: StartupCapability,
        *,
        explicitly_configured: bool = False,
    ) -> bool:
        rule = self._rule(capability)
        return rule.enabled_by_default or (
            explicitly_configured and rule.user_configurable
        )


def resolve_startup_policy(environ: Mapping[str, str]) -> StartupPolicy:
    edition = resolve_edition_configuration(environ).edition
    return StartupPolicy(edition=edition)


_COMPANY_HOST_SUFFIXES = (
    "example.com",
    "xmov.ai",
    "aliyuncs.com",
)


def _endpoint_host(endpoint: str) -> str:
    candidate = endpoint if "://" in endpoint else f"//{endpoint}"
    return (urlsplit(candidate).hostname or "").lower().rstrip(".")


def _is_company_endpoint(endpoint: str) -> bool:
    host = _endpoint_host(endpoint)
    return any(
        host == suffix or host.endswith(f".{suffix}")
        for suffix in _COMPANY_HOST_SUFFIXES
    )


def resolve_endpoint_setting(
    environ: Mapping[str, str],
    key: str,
    *,
    saas_default: str,
    community_default: str = "",
) -> str:
    policy = resolve_startup_policy(environ)
    if not policy.is_community:
        return environ[key] if key in environ else saas_default
    configured = environ.get(key, "").strip()
    if not configured:
        return community_default
    if _is_company_endpoint(configured):
        raise ValueError(f"{key} resolves to a blocked company endpoint")
    return configured
