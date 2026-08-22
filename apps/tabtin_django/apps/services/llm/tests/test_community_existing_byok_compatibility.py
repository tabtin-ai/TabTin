from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

from cryptography.fernet import Fernet
from django.test import TestCase, override_settings

from apps.services.llm.api_config import (
    create_organization_model,
    create_organization_provider,
    delete_organization_model,
)
from apps.services.billing.models import ProviderCreditGrant
from apps.services.llm.models import LLMModel, LLMProvider, LLMSceneBinding
from apps.services.payment.models import PaymentOrder
from apps.services.llm.schemas import (
    OrganizationModelCreateRequest,
    OrganizationProviderCreateRequest,
)
from apps.services.llm.scenes.policy import resolve_runtime_scene_payer
from apps.services.llm.scenes.capability_check import check_model_capability_match
from apps.services.llm.scenes.registry import SCENES
from apps.services.llm.scenes.types import ModelSource
from apps.services.llm.services._runtime.byok_resolver import resolve_scene_execution
from apps.services.llm.utils.capabilities import resolve_model_capabilities
from apps.users.wallet.models import OrganizationCashWallet, OrganizationWallet
from tabtin.community_golden_path import _funding_snapshot


TEST_CREDENTIAL_KEY = Fernet.generate_key().decode("ascii")


@override_settings(
    TABTIN_EDITION="community",
    CREDENTIAL_ENCRYPTION_KEY=TEST_CREDENTIAL_KEY,
)
class CommunityExistingByokCompatibilityTests(TestCase):
    def test_golden_path_funding_audit_matches_current_wallet_schema(self):
        official_provider_count = LLMProvider.objects.filter(scope="global").count()
        self.assertEqual(
            _funding_snapshot("00000000-0000-0000-0000-000000000000"),
            {
                "wallet_exists": False,
                "wallet_balance": None,
                "wallet_frozen": None,
                "wallet_transactions": 0,
                "wallet_consumptions": 0,
                "provider_credit_grants": 0,
                "provider_credit_consumed": "0",
                "provider_credit_reserved": "0",
                "provider_credit_consumptions": 0,
                "payment_orders": 0,
                "official_providers": official_provider_count,
            },
        )

    def test_main_chat_resolves_existing_byok_model_without_scene_binding(self):
        from apps.maintenance.community_bootstrap import apply_community_bootstrap

        # A fresh PostgreSQL database still contains the exact historical
        # migration defaults. The official Community startup removes that
        # fingerprint before users configure BYOK, so this resolver test must
        # exercise the same public installation boundary.
        apply_community_bootstrap()
        organization_id = "community-org"
        user_id = "community-user"
        provider = LLMProvider.objects.create(
            name="openai",
            provider_key="openai",
            display_name="OpenAI compatible",
            default_base_url="http://127.0.0.1:18080/v1",
            api_key="local-placeholder",
            capability_domains=["chat"],
            scope="organization",
            organization_id=organization_id,
            routing_enabled=True,
        )
        model = LLMModel.objects.create(
            provider=provider,
            model_name="community-chat-model",
            display_name="Community chat model",
            capability_domain="chat",
            base_url=provider.default_base_url,
            context_window_tokens=200_000,
            max_output_tokens=16_384,
            capabilities_config={
                "supports_streaming": True,
                "supports_function_calling": True,
            },
        )
        scene = SCENES["_main_chat"]

        execution = resolve_scene_execution(
            scene_key=scene.scene_key,
            payer=resolve_runtime_scene_payer(scene.scene_key),
            selected_model_id=str(model.id),
            organization_id=organization_id,
            user_id=user_id,
            capability_domain=scene.capability_domain,
            capability_requirements=scene.capability_requirements,
        )

        self.assertEqual(execution.model_source, ModelSource.BYOK)
        self.assertEqual(execution.model_id, str(model.id))
        self.assertTrue(execution.source_locked)
        self.assertEqual(LLMSceneBinding.objects.count(), 0)

        from apps.chat.conversation.services.title_generator import (
            TitleGeneratorService,
        )

        session = SimpleNamespace(
            current_model_id=model.id,
            user_id=user_id,
            organization_id=organization_id,
            user=None,
        )
        with patch(
            "apps.services.llm.services.chat.unified_llm_call",
            return_value=SimpleNamespace(content="Community 首条消息标题"),
        ) as unified_call:
            title = TitleGeneratorService.generate_title(
                [{"role": "user", "content": "帮我创建第一张表"}],
                session=session,
            )

        self.assertEqual(title, "Community 首条消息标题")
        self.assertEqual(
            unified_call.call_args.kwargs["selected_model_id"],
            str(model.id),
        )
        self.assertEqual(LLMSceneBinding.objects.count(), 0)

    def test_existing_openai_compatible_flow_completes_main_chat_capabilities(self):
        from apps.maintenance.community_bootstrap import (
            apply_community_bootstrap,
            get_community_ai_readiness,
            get_community_installation_state,
        )

        organization_id = "community-org"
        request = SimpleNamespace(auth=SimpleNamespace(id="community-user"))
        apply_community_bootstrap()

        self.assertEqual(get_community_installation_state().value, "READY")
        self.assertEqual(get_community_ai_readiness().status.value, "NOT_CONFIGURED")
        self.assertEqual(LLMProvider.objects.count(), 0)
        self.assertEqual(LLMModel.objects.count(), 0)
        self.assertEqual(LLMSceneBinding.objects.count(), 0)
        self.assertEqual(OrganizationWallet.objects.count(), 0)
        self.assertEqual(OrganizationCashWallet.objects.count(), 0)
        self.assertEqual(PaymentOrder.objects.count(), 0)
        self.assertEqual(ProviderCreditGrant.objects.count(), 0)

        with (
            patch("apps.services.llm.api_config.ensure_organization_permission"),
            patch("apps.services.llm.api_config.invalidate_models_cache"),
        ):
            provider_response = create_organization_provider.__wrapped__(
                request,
                organization_id,
                OrganizationProviderCreateRequest(
                    provider_name="openai",
                    provider_key="openai",
                    display_name="OpenAI compatible",
                    base_url="http://127.0.0.1:18080/v1",
                    api_key="local-placeholder",
                    scope="organization",
                ),
            )
            provider = LLMProvider.objects.get(
                id=provider_response["data"]["provider_id"]
            )
            create_organization_model.__wrapped__(
                request,
                organization_id,
                OrganizationModelCreateRequest(
                    provider_id=str(provider.id),
                    model_name="community-chat-model",
                    display_name="Community chat model",
                    context_window_tokens=200_000,
                    capabilities_config={
                        "supports_streaming": True,
                        "supports_vision": False,
                        "supports_json_mode": True,
                        "json_mode": {"modes": ["json_object"]},
                    },
                ),
            )

        model = LLMModel.objects.get(provider=provider)
        capabilities = resolve_model_capabilities(model)

        self.assertNotEqual(provider.encrypted_api_key, "local-placeholder")
        self.assertTrue(provider.encrypted_api_key.startswith("gAAAA"))
        self.assertEqual(provider.api_key, "local-placeholder")
        self.assertEqual(LLMProvider.objects.count(), 1)
        self.assertEqual(LLMModel.objects.count(), 1)
        self.assertEqual(LLMSceneBinding.objects.count(), 0)
        self.assertFalse(LLMProvider.objects.filter(scope="global").exists())
        self.assertFalse(LLMModel.objects.filter(provider__scope="global").exists())
        self.assertTrue(capabilities["supports_function_calling"])
        scene = SCENES["_main_chat"]
        self.assertIsNone(
            check_model_capability_match(
                model=model,
                requirements=scene.capability_requirements,
                capability_domain=scene.capability_domain,
            )
        )
        execution = resolve_scene_execution(
            scene_key=scene.scene_key,
            payer=resolve_runtime_scene_payer(scene.scene_key),
            selected_model_id=str(model.id),
            organization_id=organization_id,
            user_id=str(request.auth.id),
            capability_domain=scene.capability_domain,
            capability_requirements=scene.capability_requirements,
        )
        self.assertEqual(execution.model_source, ModelSource.BYOK)
        self.assertEqual(LLMSceneBinding.objects.count(), 0)
        self.assertEqual(
            get_community_ai_readiness().status.value,
            "PARTIALLY_CONFIGURED",
        )

        with (
            patch("apps.services.llm.api_config.ensure_organization_permission"),
            patch("apps.services.llm.api_config.invalidate_models_cache"),
            patch("apps.services.llm.api_config._clear_organization_default_model_id"),
            patch("apps.services.llm.api_config._clear_organization_subagent_model_id"),
        ):
            delete_response = delete_organization_model.__wrapped__(
                request,
                organization_id,
                str(model.id),
            )

        self.assertTrue(delete_response["success"])
        self.assertEqual(LLMProvider.objects.count(), 1)
        self.assertEqual(LLMModel.objects.count(), 0)
        self.assertEqual(LLMSceneBinding.objects.count(), 0)
        self.assertEqual(get_community_ai_readiness().status.value, "NOT_CONFIGURED")
        self.assertEqual(OrganizationWallet.objects.count(), 0)
        self.assertEqual(OrganizationCashWallet.objects.count(), 0)
        self.assertEqual(PaymentOrder.objects.count(), 0)
        self.assertEqual(ProviderCreditGrant.objects.count(), 0)

    @override_settings(TABTIN_EDITION="saas")
    def test_saas_model_creation_does_not_apply_community_profile_defaults(self):
        organization_id = "saas-org"
        request = SimpleNamespace(auth=SimpleNamespace(id="saas-user"))
        provider = LLMProvider.objects.create(
            name="openai",
            provider_key="saas-openai",
            display_name="SaaS OpenAI",
            default_base_url="https://api.example.invalid/v1",
            api_key="",
            capability_domains=["chat"],
            scope="organization",
            organization_id=organization_id,
        )

        with (
            patch("apps.services.llm.api_config.ensure_organization_permission"),
            patch("apps.services.llm.api_config.invalidate_models_cache"),
        ):
            create_organization_model.__wrapped__(
                request,
                organization_id,
                OrganizationModelCreateRequest(
                    provider_id=str(provider.id),
                    model_name="saas-model",
                    display_name="SaaS model",
                    context_window_tokens=200_000,
                    capabilities_config={"supports_streaming": True},
                ),
            )

        model = LLMModel.objects.get(provider=provider)
        self.assertFalse(
            resolve_model_capabilities(model)["supports_function_calling"]
        )
        self.assertIsNone(model.max_output_tokens)
