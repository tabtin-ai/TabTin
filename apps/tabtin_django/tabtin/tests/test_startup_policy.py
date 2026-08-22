from __future__ import annotations

from importlib import import_module, util

import pytest


def _policy_module():
    assert util.find_spec("tabtin.startup_policy") is not None, "startup policy is missing"
    return import_module("tabtin.startup_policy")


def test_community_core_keeps_builtin_product_paths_enabled() -> None:
    policy_module = _policy_module()
    policy = policy_module.resolve_startup_policy(
        {"TABTIN_EDITION": "community"}
    )

    core = {
        policy_module.StartupCapability.DJANGO_API,
        policy_module.StartupCapability.POSTGRESQL,
        policy_module.StartupCapability.REDIS,
        policy_module.StartupCapability.CELERY_CORE,
        policy_module.StartupCapability.CENTRIFUGO,
        policy_module.StartupCapability.BUILTIN_IM,
        policy_module.StartupCapability.LOCAL_STORAGE,
        policy_module.StartupCapability.EMAIL_PHONE_AUTH,
        policy_module.StartupCapability.ORGANIZATION,
        policy_module.StartupCapability.WORKSPACE,
        policy_module.StartupCapability.AGENT,
        policy_module.StartupCapability.DEVICE_RUNTIME_PRESENCE,
    }

    assert all(policy.is_enabled_by_default(capability) for capability in core)
    assert all(policy.is_startup_required(capability) for capability in core)


def test_community_optional_services_do_not_block_startup_when_unconfigured() -> None:
    policy_module = _policy_module()
    policy = policy_module.resolve_startup_policy(
        {"TABTIN_EDITION": "community"}
    )

    optional = {
        policy_module.StartupCapability.AI_MODEL,
        policy_module.StartupCapability.EMAIL_DELIVERY,
        policy_module.StartupCapability.WEB_PORTAL,
        policy_module.StartupCapability.RUNTIME_ONLINE,
    }

    assert all(not policy.is_startup_required(capability) for capability in optional)
    assert all(not policy.blocks_startup(capability, configured=False) for capability in optional)


def test_community_external_startup_integrations_are_opt_in_not_permanently_disabled() -> None:
    policy_module = _policy_module()
    policy = policy_module.resolve_startup_policy(
        {"TABTIN_EDITION": "community"}
    )

    configurable = {
        policy_module.StartupCapability.SENTRY,
        policy_module.StartupCapability.TELEMETRY,
        policy_module.StartupCapability.EXTERNAL_CHANNELS,
    }

    assert all(not policy.allows(capability) for capability in configurable)
    assert all(
        policy.allows(capability, explicitly_configured=True)
        for capability in configurable
    )


def test_community_commercial_dependencies_stay_disabled_even_if_requested() -> None:
    policy_module = _policy_module()
    policy = policy_module.resolve_startup_policy(
        {"TABTIN_EDITION": "community"}
    )

    disabled = {
        policy_module.StartupCapability.PAYMENT,
        policy_module.StartupCapability.OFFICIAL_CREDIT,
        policy_module.StartupCapability.OFFICIAL_MODEL,
        policy_module.StartupCapability.COMPANY_LLM_PROXY,
        policy_module.StartupCapability.EXTERNAL_IM,
        policy_module.StartupCapability.ALIYUN_OSS,
        policy_module.StartupCapability.OFFICIAL_UPDATER,
        policy_module.StartupCapability.COMPANY_ENDPOINTS,
    }

    assert all(not policy.allows(capability) for capability in disabled)
    assert all(
        not policy.allows(capability, explicitly_configured=True)
        for capability in disabled
    )


def test_default_saas_policy_preserves_existing_capability_behavior() -> None:
    policy_module = _policy_module()
    policy = policy_module.resolve_startup_policy({})

    assert policy.is_community is False
    assert all(policy.allows(capability) for capability in policy_module.StartupCapability)


def test_saas_endpoint_resolution_preserves_an_explicit_empty_value() -> None:
    policy_module = _policy_module()

    endpoint = policy_module.resolve_endpoint_setting(
        {"OPENAI_BASE_URL": ""},
        "OPENAI_BASE_URL",
        saas_default="https://gptapi.xmov.ai/v1",
    )

    assert endpoint == ""


def test_community_company_fallback_is_not_resolved() -> None:
    policy_module = _policy_module()

    endpoint = policy_module.resolve_endpoint_setting(
        {"TABTIN_EDITION": "community"},
        "DAEMON_SERVER_URL",
        saas_default="https://api.example.com",
    )

    assert endpoint == ""


def test_community_accepts_an_explicit_third_party_endpoint() -> None:
    policy_module = _policy_module()

    endpoint = policy_module.resolve_endpoint_setting(
        {
            "TABTIN_EDITION": "community",
            "OPENAI_BASE_URL": "https://llm.community.example/v1",
        },
        "OPENAI_BASE_URL",
        saas_default="https://gptapi.xmov.ai/v1",
    )

    assert endpoint == "https://llm.community.example/v1"


@pytest.mark.parametrize(
    "endpoint",
    [
        "https://api.example.com",
        "wss://ws.example.com",
        "https://web.example.com",
        "https://gptapi.xmov.ai/v1",
        "oss-cn-wuhan-lr.aliyuncs.com",
    ],
)
def test_community_rejects_explicit_company_endpoints(endpoint: str) -> None:
    policy_module = _policy_module()

    with pytest.raises(ValueError, match="company endpoint"):
        policy_module.resolve_endpoint_setting(
            {
                "TABTIN_EDITION": "community",
                "CUSTOM_ENDPOINT": endpoint,
            },
            "CUSTOM_ENDPOINT",
            saas_default="",
        )
