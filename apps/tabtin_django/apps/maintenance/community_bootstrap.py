"""Idempotent Community installation bootstrap.

The bootstrap persists code-owned installation metadata only.  Provider,
model, credential, and scene-binding rows remain user configuration.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from enum import StrEnum
from typing import Any

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import connection, transaction
from django.db.migrations.executor import MigrationExecutor

from apps.platform_config.models import PlatformRuntimeConfigItem
from apps.services.llm.models import (
    LLMModel,
    LLMProvider,
    LLMProviderKey,
    LLMSceneBinding,
    LLMUsageFact,
)
from apps.services.llm.scenes.capability_check import check_model_capability_match
from apps.services.llm.scenes.registry import SCENES
from apps.services.llm.scenes.types import ModelSource
from apps.users.membership.models import MembershipTier, OrganizationMembership


COMMUNITY_BOOTSTRAP_REVISION = "community_bootstrap_v1"
COMMUNITY_SCENE_CATALOG_KEY = "community.ai.scene_catalog"
COMMUNITY_INSTALLATION_MARKER_KEY = "community.installation.complete"
COMMUNITY_MEMBERSHIP_TIER_TYPE = "community"
_COMMUNITY_MEMBERSHIP_END_DATE = datetime.max.replace(tzinfo=UTC)
_COMMUNITY_MEMBERSHIP_TIER_DEFAULTS = {
    "name": "Community",
    "description": "Community 自托管版的完整本地产品权益",
    "price": Decimal("0.00"),
    "duration_months": 1,
    "max_tables": -1,
    "max_documents": -1,
    "max_groups": -1,
    "max_records_per_table": -1,
    "max_api_calls_per_day": 0,
    "max_crawl_tasks_per_day": 0,
    "included_storage_bytes": -1,
    "included_llm_credits_monthly": Decimal("0"),
    "included_media_monthly": 0,
    "included_search_monthly": 0,
    "included_tts_monthly": 0,
    "max_conversations_per_day": -1,
    "max_members": -1,
    "base_seats": 1,
    "extra_seat_price": Decimal("0.00"),
    "trash_retention_days": 90,
    "features": {
        "api_access": True,
        "advanced_export": True,
        "custom_branding": True,
        "sso": True,
        "audit_log": True,
    },
    "sort_order": 100,
    "tier_level": 100,
    "is_active": True,
}


class InstallationState(StrEnum):
    READY = "READY"
    NOT_READY = "NOT_READY"


class AIConfigurationState(StrEnum):
    NOT_CONFIGURED = "NOT_CONFIGURED"
    PARTIALLY_CONFIGURED = "PARTIALLY_CONFIGURED"
    READY = "READY"


class ExistingCommunityDataError(RuntimeError):
    """Fresh-install cleanup cannot safely run after users exist."""


@dataclass(frozen=True, slots=True)
class CommunityBootstrapResult:
    revision: str
    already_complete: bool
    removed_migration_defaults: int


@dataclass(frozen=True, slots=True)
class CommunityAIReadiness:
    status: AIConfigurationState
    domains: dict[str, str]
    scenes: dict[str, str]


# Classification is product metadata, not an installation requirement.  Every
# scene may remain unconfigured on a fresh Community installation.
_CORE_SCENE_KEYS = frozenset(
    {
        "_main_chat",
        "_compact",
        "_summary_judge",
        "_sub_agent",
        "title_generation",
        "summarization",
        "memory_capture",
        "memory_flush",
        "task_summary",
        "diary_distill",
        "memory_compaction",
        "checkpoint_intent_summary",
        "checkpoint_decision_summary",
        "tool_risk_classify",
    }
)


_MIGRATION_DEFAULT_MODELS: dict[str, dict[str, str]] = {
    "moonshot": {
        "kimi-k2.5": "chat",
        "kimi-k2.6": "chat",
        "kimi-k2.7-code": "chat",
        "kimi-k3": "chat",
    },
    "bytedance_default": {
        "doubao-asr": "asr",
        "seed-tts-3.0": "tts",
    },
    "volcengine": {
        "doubao-seed-2-0-lite-260428": "chat",
        "doubao-seed-evolving": "chat",
        "doubao-seedream-4-0-250828": "image_gen",
        "doubao-seedream-4-5-251128": "image_gen",
        "doubao-seedream-5-0-260128": "image_gen",
        "doubao-seedream-5-0-pro-260628": "image_gen",
    },
}


def _json_safe(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_json_safe(item) for item in value]
    if isinstance(value, StrEnum):
        return value.value
    return value


def build_community_scene_catalog() -> dict[str, Any]:
    """Build the persistent system catalog from the existing SCENES SSoT."""
    if not _CORE_SCENE_KEYS.issubset(SCENES):
        missing = sorted(_CORE_SCENE_KEYS - set(SCENES))
        raise RuntimeError(f"Community core scene classification drift: {missing}")

    scenes = []
    for scene_key, spec in sorted(SCENES.items()):
        scenes.append(
            {
                "scene_key": scene_key,
                "name": spec.display_name,
                "purpose": spec.description,
                "capability_domain": spec.capability_domain,
                "capability_requirements": _json_safe(
                    spec.capability_requirements
                ),
                "classification": (
                    "core" if scene_key in _CORE_SCENE_KEYS else "optional"
                ),
                "can_remain_unconfigured": True,
                "routing_requirement": (
                    "selected_runtime_model"
                    if spec.is_system
                    else "compatible_user_scene_binding"
                ),
            }
        )
    return {"revision": COMMUNITY_BOOTSTRAP_REVISION, "scenes": scenes}


def _assert_community_prerequisites() -> None:
    if getattr(settings, "TABTIN_EDITION", "saas") != "community":
        raise RuntimeError("Community bootstrap requires TABTIN_EDITION=community")
    if connection.vendor != "postgresql":
        raise RuntimeError("Community bootstrap requires PostgreSQL")
    if getattr(settings, "SERVICES_OSS_PROVIDER", "") != "local":
        raise RuntimeError("Community bootstrap requires local storage mode")

    required_secrets = (
        "SECRET_KEY",
        "JWT_SECRET_KEY",
        "CREDENTIAL_ENCRYPTION_KEY",
        "CENTRIFUGO_API_KEY",
        "CENTRIFUGO_PROXY_SECRET",
        "CENTRIFUGO_TOKEN_SECRET",
    )
    missing = [name for name in required_secrets if not getattr(settings, name, "")]
    if missing:
        raise RuntimeError("Community installation secrets are incomplete")

    executor = MigrationExecutor(connection)
    pending = executor.migration_plan(executor.loader.graph.leaf_nodes())
    if pending:
        raise RuntimeError("Community database has unapplied migrations")


def _migration_defaults_present() -> bool:
    return LLMProvider.objects.filter(
        scope="global",
        provider_key__in=_MIGRATION_DEFAULT_MODELS,
        organization_id__isnull=True,
        user_id__isnull=True,
    ).exists()


def _remove_fresh_migration_ai_defaults() -> int:
    """Remove only the exact official defaults created by historical migrations.

    Historical migrations cannot be edited.  The cleanup is therefore limited
    to a pre-user fresh database with the complete known provider/model
    fingerprint and no usage/key references.  Any drift fails closed instead
    of guessing whether a row is operator-managed.
    """
    if not _migration_defaults_present():
        return 0
    if get_user_model().objects.exists():
        raise ExistingCommunityDataError(
            "Cannot remove historical AI defaults after user data exists"
        )

    providers = list(
        LLMProvider.objects.filter(
            scope="global",
            provider_key__in=_MIGRATION_DEFAULT_MODELS,
            organization_id__isnull=True,
            user_id__isnull=True,
        ).prefetch_related("models")
    )
    if {provider.provider_key for provider in providers} != set(
        _MIGRATION_DEFAULT_MODELS
    ):
        raise RuntimeError("Historical AI provider fingerprint is incomplete")

    model_ids = []
    for provider in providers:
        expected = _MIGRATION_DEFAULT_MODELS[provider.provider_key]
        actual = {
            model.model_name: model.capability_domain
            for model in provider.models.all()
        }
        if (
            provider.encrypted_api_key
            or provider.routing_enabled
            or provider.scope != "global"
            or actual != expected
        ):
            raise RuntimeError(
                "Historical AI provider fingerprint was modified; refusing cleanup"
            )
        model_ids.extend(model.id for model in provider.models.all())

    bindings = list(LLMSceneBinding.objects.all())
    if len(bindings) != 1 or bindings[0].scene_key != "diary_distill":
        raise RuntimeError("Historical AI binding fingerprint was modified")
    if bindings[0].fallback_models:
        raise RuntimeError("Historical AI binding contains operator fallback data")
    if LLMProviderKey.objects.filter(provider__in=providers).exists():
        raise RuntimeError("Historical AI providers contain credential rows")
    if LLMUsageFact.objects.filter(
        provider__in=providers
    ).exists() or LLMUsageFact.objects.filter(model_id__in=model_ids).exists():
        raise RuntimeError("Historical AI defaults are referenced by usage data")

    LLMSceneBinding.objects.filter(pk=bindings[0].pk).delete()
    deleted_models, _ = LLMModel.objects.filter(id__in=model_ids).delete()
    deleted_providers, _ = LLMProvider.objects.filter(
        id__in=[provider.id for provider in providers]
    ).delete()
    return 1 + deleted_models + deleted_providers


def _upsert_system_item(*, key: str, name: str, description: str, value: dict) -> None:
    defaults = {
        "name": name,
        "description": description,
        "category": "community_installation",
        "value_type": PlatformRuntimeConfigItem.ValueType.JSON,
        "value": value,
        "default_value": value,
        "is_active": True,
        "is_system": True,
        "sort_order": 0,
        "extra_schema": {},
    }
    item, created = PlatformRuntimeConfigItem.objects.get_or_create(
        key=key,
        defaults=defaults,
    )
    if created:
        return
    if not item.is_system or item.category != "community_installation":
        raise RuntimeError(f"Community bootstrap key is not system-owned: {key}")

    changed = [field for field, expected in defaults.items() if getattr(item, field) != expected]
    if not changed:
        return
    for field in changed:
        setattr(item, field, defaults[field])
    item.save(update_fields=[*changed, "updated_at"])


def _upsert_community_membership_tier() -> MembershipTier:
    tier, created = MembershipTier.objects.get_or_create(
        tier_type=COMMUNITY_MEMBERSHIP_TIER_TYPE,
        defaults=_COMMUNITY_MEMBERSHIP_TIER_DEFAULTS,
    )
    if created:
        return tier

    changed = [
        field
        for field, expected in _COMMUNITY_MEMBERSHIP_TIER_DEFAULTS.items()
        if getattr(tier, field) != expected
    ]
    if not changed:
        return tier
    for field in changed:
        setattr(tier, field, _COMMUNITY_MEMBERSHIP_TIER_DEFAULTS[field])
    tier.save(update_fields=[*changed, "updated_at"])
    return tier


def ensure_community_organization_membership(
    organization_id: str,
    *,
    tier: MembershipTier | None = None,
) -> OrganizationMembership | None:
    """Give an organization the code-owned Community entitlement.

    SaaS callers are deliberately a no-op. Community membership is a local
    installation entitlement, not a purchase, so no order, wallet credit, or
    provider-credit record is created here.
    """
    if getattr(settings, "TABTIN_EDITION", "saas") != "community":
        return None

    tier = tier or _upsert_community_membership_tier()
    now = datetime.now(tz=UTC)
    defaults = {
        "tier": tier,
        "status": "active",
        "start_date": now,
        "end_date": _COMMUNITY_MEMBERSHIP_END_DATE,
        "billing_cycle": OrganizationMembership.BillingCycle.MONTHLY,
        "current_actual_paid_period_price": None,
        "grace_period_end": None,
        "related_order_id": "",
        "scheduled_tier": None,
        "scheduled_billing_cycle": None,
        "scheduled_change_type": None,
        "scheduled_change_effective_at": None,
        "scheduled_change_log_id": None,
        "auto_renew": False,
        "purchased_by": "",
    }
    membership, created = OrganizationMembership.objects.get_or_create(
        organization_id=str(organization_id),
        defaults=defaults,
    )
    if created:
        return membership

    desired = {key: value for key, value in defaults.items() if key != "start_date"}
    changed = [
        field
        for field, expected in desired.items()
        if getattr(membership, field) != expected
    ]
    if membership.tier_id != tier.id or membership.status != "active":
        membership.start_date = now
        changed.append("start_date")
    if not changed:
        return membership
    for field in changed:
        if field != "start_date":
            setattr(membership, field, desired[field])
    membership.save(update_fields=[*dict.fromkeys(changed), "updated_at"])
    return membership


def _reconcile_community_organization_memberships(
    tier: MembershipTier,
) -> None:
    from apps.tabtinspace.models import Organization

    for organization_id in Organization.objects.values_list("id", flat=True).iterator():
        ensure_community_organization_membership(
            str(organization_id),
            tier=tier,
        )


def apply_community_bootstrap(
    *, before_marker: Callable[[], None] | None = None
) -> CommunityBootstrapResult:
    """Apply the Community bootstrap atomically, writing the marker last."""
    with transaction.atomic():
        _assert_community_prerequisites()
        existing_marker = PlatformRuntimeConfigItem.objects.filter(
            key=COMMUNITY_INSTALLATION_MARKER_KEY,
            value={"revision": COMMUNITY_BOOTSTRAP_REVISION},
            is_system=True,
        ).exists()
        removed = _remove_fresh_migration_ai_defaults()
        community_tier = _upsert_community_membership_tier()
        _reconcile_community_organization_memberships(community_tier)
        _upsert_system_item(
            key=COMMUNITY_SCENE_CATALOG_KEY,
            name="Community AI Scene Catalog",
            description=(
                "Code-owned scene and capability catalog; contains no user "
                "model configuration."
            ),
            value=build_community_scene_catalog(),
        )
        if before_marker is not None:
            before_marker()
        _upsert_system_item(
            key=COMMUNITY_INSTALLATION_MARKER_KEY,
            name="Community installation marker",
            description="Required local installation prerequisites completed.",
            value={"revision": COMMUNITY_BOOTSTRAP_REVISION},
        )
        return CommunityBootstrapResult(
            revision=COMMUNITY_BOOTSTRAP_REVISION,
            already_complete=existing_marker,
            removed_migration_defaults=removed,
        )


def get_community_installation_state() -> InstallationState:
    marker_ready = PlatformRuntimeConfigItem.objects.filter(
        key=COMMUNITY_INSTALLATION_MARKER_KEY,
        value={"revision": COMMUNITY_BOOTSTRAP_REVISION},
        is_active=True,
        is_system=True,
    ).exists()
    catalog_ready = PlatformRuntimeConfigItem.objects.filter(
        key=COMMUNITY_SCENE_CATALOG_KEY,
        value=build_community_scene_catalog(),
        is_active=True,
        is_system=True,
    ).exists()
    return (
        InstallationState.READY
        if marker_ready and catalog_ready
        else InstallationState.NOT_READY
    )


def get_community_ai_readiness() -> CommunityAIReadiness:
    bindings = {
        binding.scene_key: binding
        for binding in LLMSceneBinding.objects.select_related(
            "primary_model", "primary_model__provider"
        )
    }
    byok_models = list(
        LLMModel.objects.select_related("provider").filter(
            provider__scope__in=("organization", "user"),
            provider__routing_enabled=True,
        )
    )
    scene_states: dict[str, str] = {}
    for scene_key, spec in SCENES.items():
        binding = bindings.get(scene_key)
        model = binding.primary_model if binding is not None else None
        if model is None:
            policy = spec.policy
            supports_byok = bool(
                policy and ModelSource.BYOK in policy.allowed_model_sources
            )
            byok_ready = supports_byok and any(
                check_model_capability_match(
                    model=candidate,
                    requirements=spec.capability_requirements,
                    capability_domain=spec.capability_domain,
                ) is None
                for candidate in byok_models
            )
            scene_states[scene_key] = "READY" if byok_ready else "UNCONFIGURED"
            continue
        mismatch = check_model_capability_match(
            model=model,
            requirements=spec.capability_requirements,
            capability_domain=spec.capability_domain,
        )
        scene_states[scene_key] = "READY" if mismatch is None else "INCOMPATIBLE"

    domains: dict[str, str] = {}
    for domain in sorted({spec.capability_domain for spec in SCENES.values()}):
        relevant = [
            scene_states[key]
            for key, spec in SCENES.items()
            if spec.capability_domain == domain and not spec.is_system
        ]
        domains[domain] = "READY" if "READY" in relevant else "UNCONFIGURED"

    ready_domains = sum(value == "READY" for value in domains.values())
    if ready_domains == 0:
        status = AIConfigurationState.NOT_CONFIGURED
    elif ready_domains == len(domains):
        status = AIConfigurationState.READY
    else:
        status = AIConfigurationState.PARTIALLY_CONFIGURED
    return CommunityAIReadiness(status=status, domains=domains, scenes=scene_states)
