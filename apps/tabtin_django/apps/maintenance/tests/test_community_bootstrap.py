from __future__ import annotations

from decimal import Decimal
from unittest.mock import patch

from cryptography.fernet import Fernet
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase, override_settings

from apps.platform_config.models import PlatformRuntimeConfigItem
from apps.services.llm.models import LLMModel, LLMProvider, LLMSceneBinding
from apps.services.llm.scenes.exceptions import SceneBindingUnavailable


TEST_CREDENTIAL_KEY = Fernet.generate_key().decode("ascii")


@override_settings(
    TABTIN_EDITION="community",
    SERVICES_OSS_PROVIDER="local",
    CREDENTIAL_ENCRYPTION_KEY=TEST_CREDENTIAL_KEY,
)
class CommunityBootstrapTests(TestCase):
    def test_bootstrap_creates_zero_cost_unlimited_community_tier(self):
        from apps.maintenance.community_bootstrap import apply_community_bootstrap
        from apps.users.membership.models import MembershipTier

        apply_community_bootstrap()

        tier = MembershipTier.objects.get(
            tier_type="community",
        )
        self.assertEqual(tier.price, Decimal("0.00"))
        self.assertEqual(tier.included_llm_credits_monthly, Decimal("0"))
        self.assertEqual(tier.included_media_monthly, 0)
        self.assertEqual(tier.included_search_monthly, 0)
        self.assertEqual(tier.included_tts_monthly, 0)
        self.assertEqual(tier.included_storage_bytes, -1)
        self.assertEqual(tier.max_tables, -1)
        self.assertEqual(tier.max_documents, -1)
        self.assertEqual(tier.max_groups, -1)
        self.assertEqual(tier.max_records_per_table, -1)
        self.assertEqual(tier.max_conversations_per_day, -1)
        self.assertEqual(tier.max_members, -1)
        self.assertTrue(tier.features["sso"])
        self.assertTrue(tier.features["audit_log"])

    def test_new_and_existing_organizations_receive_community_membership(self):
        from apps.maintenance.community_bootstrap import apply_community_bootstrap
        from apps.services.billing.models import OrganizationBillingEntitlement
        from apps.services.billing.services.storage_service import (
            OrganizationStorageBillingService,
        )
        from apps.tabtinspace.models import Organization
        from apps.tabtinspace.services.organization_service import OrganizationService
        from apps.users.membership.models import OrganizationMembership
        from apps.users.membership.services.quota_service import QuotaService

        apply_community_bootstrap()
        user = get_user_model().objects.create_user(
            email="community-member@example.invalid",
            password="community-test-password",
        )
        organization = Organization.objects.get(owner=user, type="personal")
        membership = OrganizationMembership.objects.get(
            organization_id=str(organization.id),
        )
        self.assertEqual(
            membership.tier.tier_type,
            "community",
        )
        self.assertEqual(membership.status, "active")
        self.assertEqual(
            QuotaService().check_quota(
                quota_type="max_tables",
                organization_id=str(organization.id),
            )["limit"],
            -1,
        )
        self.assertEqual(
            QuotaService().check_quota(
                quota_type="max_documents",
                organization_id=str(organization.id),
            )["limit"],
            -1,
        )
        entitlement = OrganizationBillingEntitlement.objects.get(
            organization_id=str(organization.id),
        )
        self.assertEqual(entitlement.included_storage_bytes, -1)
        self.assertEqual(entitlement.included_llm_credits_monthly, Decimal("0"))
        self.assertTrue(
            OrganizationStorageBillingService.assert_storage_upload_allowed(
                organization_id=str(organization.id),
                incoming_bytes=1024,
            )["allowed"],
        )

        team = OrganizationService(user=user).create_organization(
            "Community team",
            enforce_owner_limit=False,
        )
        self.assertEqual(
            OrganizationMembership.objects.get(
                organization_id=str(team.id),
            ).tier.tier_type,
            "community",
        )

        membership.delete()
        apply_community_bootstrap()

        restored = OrganizationMembership.objects.get(
            organization_id=str(organization.id),
        )
        self.assertEqual(
            restored.tier.tier_type,
            "community",
        )

    def test_fresh_install_persists_catalog_and_marker_without_ai_rows(self):
        from apps.maintenance.community_bootstrap import (
            COMMUNITY_INSTALLATION_MARKER_KEY,
            COMMUNITY_SCENE_CATALOG_KEY,
            apply_community_bootstrap,
            get_community_ai_readiness,
            get_community_installation_state,
        )
        from apps.services.llm.scenes.registry import SCENES

        result = apply_community_bootstrap()

        catalog = PlatformRuntimeConfigItem.objects.get(
            key=COMMUNITY_SCENE_CATALOG_KEY
        )
        marker = PlatformRuntimeConfigItem.objects.get(
            key=COMMUNITY_INSTALLATION_MARKER_KEY
        )
        self.assertEqual(len(catalog.value["scenes"]), len(SCENES))
        self.assertEqual(marker.value, {"revision": result.revision})
        self.assertEqual(LLMProvider.objects.count(), 0)
        self.assertEqual(LLMModel.objects.count(), 0)
        self.assertEqual(LLMSceneBinding.objects.count(), 0)
        self.assertEqual(get_community_installation_state().value, "READY")
        self.assertEqual(get_community_ai_readiness().status.value, "NOT_CONFIGURED")

    def test_bootstrap_is_idempotent_and_does_not_touch_user_configuration(self):
        from apps.maintenance.community_bootstrap import (
            COMMUNITY_INSTALLATION_MARKER_KEY,
            COMMUNITY_SCENE_CATALOG_KEY,
            apply_community_bootstrap,
        )

        provider = LLMProvider.objects.create(
            name="user-provider",
            provider_key="user-provider",
            display_name="User provider",
            capability_domains=["chat"],
            scope="organization",
            organization_id="org-user-owned",
            routing_enabled=True,
        )
        model = LLMModel.objects.create(
            provider=provider,
            model_name="user-text-model",
            display_name="User text model",
            capability_domain="chat",
            context_window_tokens=131_072,
            max_output_tokens=16_384,
            base_url="https://user.example.invalid/v1",
        )

        first = apply_community_bootstrap()
        catalog_before = PlatformRuntimeConfigItem.objects.get(
            key=COMMUNITY_SCENE_CATALOG_KEY
        )
        marker_before = PlatformRuntimeConfigItem.objects.get(
            key=COMMUNITY_INSTALLATION_MARKER_KEY
        )
        first_timestamps = (catalog_before.updated_at, marker_before.updated_at)
        second = apply_community_bootstrap()
        catalog_after = PlatformRuntimeConfigItem.objects.get(
            key=COMMUNITY_SCENE_CATALOG_KEY
        )
        marker_after = PlatformRuntimeConfigItem.objects.get(
            key=COMMUNITY_INSTALLATION_MARKER_KEY
        )

        self.assertFalse(first.already_complete)
        self.assertTrue(second.already_complete)
        self.assertEqual(
            first_timestamps,
            (catalog_after.updated_at, marker_after.updated_at),
        )
        self.assertTrue(LLMProvider.objects.filter(pk=provider.pk).exists())
        self.assertTrue(LLMModel.objects.filter(pk=model.pk).exists())
        self.assertEqual(LLMSceneBinding.objects.count(), 0)

    def test_failure_before_marker_rolls_back_entire_bootstrap(self):
        from apps.maintenance.community_bootstrap import (
            COMMUNITY_INSTALLATION_MARKER_KEY,
            COMMUNITY_SCENE_CATALOG_KEY,
            apply_community_bootstrap,
        )

        def fail_before_marker() -> None:
            raise RuntimeError("injected bootstrap failure")

        with self.assertRaisesRegex(RuntimeError, "injected bootstrap failure"):
            apply_community_bootstrap(before_marker=fail_before_marker)

        self.assertFalse(
            PlatformRuntimeConfigItem.objects.filter(
                key__in=(
                    COMMUNITY_SCENE_CATALOG_KEY,
                    COMMUNITY_INSTALLATION_MARKER_KEY,
                )
            ).exists()
        )

    def test_historical_defaults_are_not_removed_after_user_data_exists(self):
        from apps.maintenance.community_bootstrap import (
            COMMUNITY_INSTALLATION_MARKER_KEY,
            apply_community_bootstrap,
        )

        get_user_model().objects.create_user(email="existing-user@example.invalid")
        seeded_provider_ids = set(
            LLMProvider.objects.filter(
                provider_key__in={"moonshot", "bytedance_default", "volcengine"}
            ).values_list("id", flat=True)
        )

        with self.assertRaisesRegex(RuntimeError, "after user data exists"):
            apply_community_bootstrap()

        self.assertEqual(
            set(
                LLMProvider.objects.filter(id__in=seeded_provider_ids).values_list(
                    "id", flat=True
                )
            ),
            seeded_provider_ids,
        )
        self.assertFalse(
            PlatformRuntimeConfigItem.objects.filter(
                key=COMMUNITY_INSTALLATION_MARKER_KEY
            ).exists()
        )

    def test_startup_seed_skips_existing_user_database_without_traceback(self):
        from apps.maintenance.community_bootstrap import (
            COMMUNITY_INSTALLATION_MARKER_KEY,
        )

        get_user_model().objects.create_user(email="existing-startup@example.invalid")
        seeded_provider_ids = set(
            LLMProvider.objects.filter(
                provider_key__in={"moonshot", "bytedance_default", "volcengine"}
            ).values_list("id", flat=True)
        )

        call_command("seed_scene_bindings", "--if-empty")

        self.assertEqual(
            set(
                LLMProvider.objects.filter(id__in=seeded_provider_ids).values_list(
                    "id", flat=True
                )
            ),
            seeded_provider_ids,
        )
        self.assertFalse(
            PlatformRuntimeConfigItem.objects.filter(
                key=COMMUNITY_INSTALLATION_MARKER_KEY
            ).exists()
        )

    def test_historical_defaults_are_not_removed_with_extra_binding(self):
        from apps.maintenance.community_bootstrap import (
            COMMUNITY_INSTALLATION_MARKER_KEY,
            apply_community_bootstrap,
        )
        from apps.services.llm.scenes.registry import SCENES

        spec = SCENES["summarization"]
        LLMSceneBinding.objects.create(
            scene_key=spec.scene_key,
            display_name=spec.display_name,
            description=spec.description,
            capability_domain=spec.capability_domain,
            capability_requirements=spec.capability_requirements,
            default_params=spec.default_params,
        )

        with self.assertRaisesRegex(
            RuntimeError,
            "Historical AI binding fingerprint was modified",
        ):
            apply_community_bootstrap()

        self.assertTrue(
            LLMSceneBinding.objects.filter(scene_key=spec.scene_key).exists()
        )
        self.assertFalse(
            PlatformRuntimeConfigItem.objects.filter(
                key=COMMUNITY_INSTALLATION_MARKER_KEY
            ).exists()
        )

    def test_partial_text_configuration_does_not_require_advanced_scenes(self):
        from apps.maintenance.community_bootstrap import get_community_ai_readiness
        from apps.services.llm.scenes.registry import SCENES

        provider = LLMProvider.objects.create(
            name="configured-text",
            provider_key="configured-text",
            display_name="Configured text",
            capability_domains=["chat"],
            routing_enabled=True,
        )
        model = LLMModel.objects.create(
            provider=provider,
            model_name="configured-text-model",
            display_name="Configured text model",
            capability_domain="chat",
            context_window_tokens=131_072,
            max_output_tokens=16_384,
            base_url="https://user.example.invalid/v1",
        )
        spec = SCENES["summarization"]
        LLMSceneBinding.objects.create(
            scene_key=spec.scene_key,
            display_name=spec.display_name,
            description=spec.description,
            capability_domain=spec.capability_domain,
            primary_model=model,
            capability_requirements=spec.capability_requirements,
            default_params=spec.default_params,
        )

        status = get_community_ai_readiness()

        self.assertEqual(status.status.value, "PARTIALLY_CONFIGURED")
        self.assertEqual(status.domains["chat"], "READY")
        self.assertEqual(status.domains["vision"], "UNCONFIGURED")
        self.assertEqual(status.domains["image_gen"], "UNCONFIGURED")
        self.assertEqual(status.domains["asr"], "UNCONFIGURED")
        self.assertEqual(status.domains["tts"], "UNCONFIGURED")

    def test_text_and_vision_fail_closed_without_bindings(self):
        from apps.services.llm.scenes.registry import SCENES
        from apps.services.llm.services.chat import unified_llm_call
        from apps.services.llm.services.vision import parse as parse_vision

        vision = SCENES["vision_parse_document"]
        LLMSceneBinding.objects.create(
            scene_key=vision.scene_key,
            display_name=vision.display_name,
            description=vision.description,
            capability_domain=vision.capability_domain,
            capability_requirements=vision.capability_requirements,
            default_params=vision.default_params,
            primary_model=None,
        )
        calls = (
            lambda: unified_llm_call(
                scene_key="summarization",
                variables={"messages": [{"role": "user", "content": "hello"}]},
                user_id="00000000-0000-0000-0000-000000000001",
                organization_id="00000000-0000-0000-0000-000000000002",
            ),
            lambda: parse_vision(
                scene_key="vision_parse_document",
                image=b"not-reached",
                user_id="00000000-0000-0000-0000-000000000001",
                organization_id="00000000-0000-0000-0000-000000000002",
            ),
        )
        with patch(
            "apps.services.llm.services.factory.get_llm_service",
            side_effect=AssertionError("provider dispatch must not be reached"),
        ):
            for call in calls:
                with self.assertRaises(SceneBindingUnavailable) as raised:
                    call()
                self.assertEqual(
                    raised.exception.error_code,
                    "E14_SCENE_BINDING_UNAVAILABLE",
                )
                self.assertEqual(raised.exception.http_status, 503)

    def test_management_command_is_the_unique_community_entrypoint(self):
        call_command("tabtin_bootstrap", edition="community", verbosity=0)
        call_command("tabtin_bootstrap", edition="community", verbosity=0)

        with override_settings(TABTIN_EDITION="saas"):
            with self.assertRaises(CommandError):
                call_command("tabtin_bootstrap", edition="community", verbosity=0)

    def test_legacy_seed_command_is_catalog_only_in_community(self):
        from apps.maintenance.community_bootstrap import COMMUNITY_SCENE_CATALOG_KEY

        call_command("seed_scene_bindings", verbosity=0)

        self.assertTrue(
            PlatformRuntimeConfigItem.objects.filter(
                key=COMMUNITY_SCENE_CATALOG_KEY
            ).exists()
        )
        self.assertEqual(LLMProvider.objects.count(), 0)
        self.assertEqual(LLMModel.objects.count(), 0)
        self.assertEqual(LLMSceneBinding.objects.count(), 0)

    def test_legacy_seed_dry_run_is_read_only_in_community(self):
        from apps.maintenance.community_bootstrap import (
            COMMUNITY_INSTALLATION_MARKER_KEY,
            COMMUNITY_SCENE_CATALOG_KEY,
        )

        counts_before = (
            LLMProvider.objects.count(),
            LLMModel.objects.count(),
            LLMSceneBinding.objects.count(),
        )

        call_command("seed_scene_bindings", dry_run=True, verbosity=0)

        self.assertEqual(
            (
                LLMProvider.objects.count(),
                LLMModel.objects.count(),
                LLMSceneBinding.objects.count(),
            ),
            counts_before,
        )
        self.assertFalse(
            PlatformRuntimeConfigItem.objects.filter(
                key__in=(
                    COMMUNITY_SCENE_CATALOG_KEY,
                    COMMUNITY_INSTALLATION_MARKER_KEY,
                )
            ).exists()
        )

    @override_settings(TABTIN_EDITION="saas")
    def test_community_membership_hook_is_noop_in_saas(self):
        from apps.maintenance.community_bootstrap import (
            ensure_community_organization_membership,
        )
        from apps.users.membership.models import MembershipTier

        self.assertIsNone(
            ensure_community_organization_membership("saas-organization"),
        )
        self.assertFalse(
            MembershipTier.objects.filter(tier_type="community").exists(),
        )

    @override_settings(TABTIN_EDITION="saas")
    def test_saas_legacy_seed_behavior_is_unchanged(self):
        from apps.services.llm.scenes.registry import SCENES

        call_command("seed_scene_bindings", verbosity=0)

        self.assertEqual(
            LLMSceneBinding.objects.filter(scene_key__in={
                key for key, spec in SCENES.items()
                if not spec.is_system
            }).count(),
            sum(not spec.is_system for spec in SCENES.values()),
        )
