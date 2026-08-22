from __future__ import annotations

import uuid
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch

from django.test import TestCase, override_settings

from apps.services.billing.models import (
    ProviderCreditTransaction,
)
from apps.services.billing.services.gateway import BillingGateway
from apps.services.billing.services.provider_credit_capability import (
    ProviderCreditCapabilityService,
)
from apps.services.billing.services.provider_credit_service import (
    ProviderCreditService,
)
from apps.services.billing.tests.org_test_utils import org_id_for
from apps.services.llm.api import get_model_catalog, preview_model_funding
from apps.services.llm.schemas import FundingPreviewRequest
from apps.users.wallet.models import OrganizationWallet


class ProviderCreditCapabilityTests(TestCase):
    databases = {"default"}

    def setUp(self):
        self.organization_id = org_id_for("provider_credit_capability")
        self.doubao_model_id = str(uuid.uuid4())
        self.kimi_model_id = str(uuid.uuid4())
        campaign = ProviderCreditService.create_campaign(
            code="DOUBAO_NEW_USER",
            name="豆包推广赠送额度",
            provider_key="volcengine",
            eligible_model_ids=[self.doubao_model_id],
            credits_amount=Decimal("100"),
            total_budget_credits=Decimal("100"),
        )
        self.grant = ProviderCreditService.grant_credit(
            organization=self.organization_id,
            campaign=campaign,
        )

    def test_doubao_model_returns_promotion_credit(self):
        promotion = ProviderCreditCapabilityService.get_model_promotion_credit(
            organization=self.organization_id,
            provider_key="volcengine",
            model_id=self.doubao_model_id,
        )

        self.assertIsNotNone(promotion)
        self.assertTrue(promotion["eligible"])
        self.assertEqual(promotion["provider_key"], "volcengine")
        self.assertEqual(promotion["remaining_credits"], 100.0)
        self.assertEqual(promotion["total_credits"], 100.0)
        self.assertEqual(promotion["label"], "豆包推广赠送额度")
        self.assertIsNotNone(promotion["expire_at"])

    def test_kimi_model_does_not_receive_doubao_promotion_credit(self):
        promotion = ProviderCreditCapabilityService.get_model_promotion_credit(
            organization=self.organization_id,
            provider_key="moonshot",
            model_id=self.kimi_model_id,
        )

        self.assertIsNone(promotion)

    @patch(
        "apps.services.billing.services.provider_credit_capability."
        "FundingAllocator.preview_funding",
        return_value=[],
    )
    def test_preview_uses_read_only_allocator(self, preview_funding):
        ProviderCreditCapabilityService.preview_funding(
            organization=self.organization_id,
            provider_key="volcengine",
            model_id=self.doubao_model_id,
            required_credits=Decimal("0"),
            billing_context={"idempotency_key": "preview"},
        )

        preview_funding.assert_called_once_with(
            organization=self.organization_id,
            provider_key="volcengine",
            model_id=self.doubao_model_id,
            required_credits=Decimal("0"),
            billing_context={"idempotency_key": "preview"},
        )

    @override_settings(
        PROVIDER_CREDIT_FUNDING_ENABLED=True,
        PROVIDER_CREDIT_UI_ENABLED=True,
    )
    @patch(
        "apps.services.billing.services.gateway."
        "MeterPricingService.get_unit_price",
        return_value=Decimal("1"),
    )
    @patch(
        "apps.services.billing.services.policy_service."
        "OrganizationBillingPolicyService.get_effective_policy",
        return_value={"llm_billing_mode": "paygo_only"},
    )
    @patch(
        "apps.services.billing.services.gateway."
        "OrganizationLlmBudgetService.get_remaining_quota_credits",
        return_value=Decimal("0"),
    )
    def test_doubao_precheck_reuses_allocator_and_rolls_back_preview(
        self,
        _remaining,
        _policy,
        _price,
    ):
        consume_count_before = ProviderCreditTransaction.objects.filter(
            grant=self.grant,
            transaction_type=ProviderCreditTransaction.TransactionType.CONSUME,
        ).count()

        decision = BillingGateway.precheck_llm_usage(
            organization_id=self.organization_id,
            user_id="provider-credit-capability-user",
            estimated_tokens=1000,
            model_id=self.doubao_model_id,
            idempotency_key="pr4-doubao-preview",
            model_config={
                "provider_key": "volcengine",
                "canonical_provider_key": "volcengine",
                "model_id": self.doubao_model_id,
                "model_name": "not-used-for-provider-matching",
                "input_price_per_1k": "1",
                "output_price_per_1k": "0",
            },
        )

        self.assertTrue(decision["allowed"])
        self.assertEqual(decision["estimated_credits"], "100.0000")
        self.assertEqual(
            [item["source_type"] for item in decision["funding_preview"]],
            ["provider_credit"],
        )
        self.assertEqual(
            decision["funding_preview"][0]["campaign_code"],
            "DOUBAO_NEW_USER",
        )
        self.grant.refresh_from_db()
        self.assertEqual(self.grant.remaining_credits, Decimal("100"))
        self.assertEqual(
            ProviderCreditTransaction.objects.filter(
                grant=self.grant,
                transaction_type=ProviderCreditTransaction.TransactionType.CONSUME,
            ).count(),
            consume_count_before,
        )

    @override_settings(
        PROVIDER_CREDIT_FUNDING_ENABLED=True,
        PROVIDER_CREDIT_UI_ENABLED=True,
    )
    @patch(
        "apps.services.billing.services.gateway."
        "MeterPricingService.get_unit_price",
        return_value=Decimal("1"),
    )
    @patch(
        "apps.services.billing.services.policy_service."
        "OrganizationBillingPolicyService.get_effective_policy",
        return_value={"llm_billing_mode": "paygo_only"},
    )
    @patch(
        "apps.services.billing.services.gateway."
        "OrganizationLlmBudgetService.get_remaining_quota_credits",
        return_value=Decimal("0"),
    )
    def test_kimi_precheck_excludes_doubao_credit(
        self,
        _remaining,
        _policy,
        _price,
    ):
        OrganizationWallet.objects.create(
            organization_id=self.organization_id,
            credits_precise=Decimal("100"),
        )

        decision = BillingGateway.precheck_llm_usage(
            organization_id=self.organization_id,
            user_id="provider-credit-capability-user",
            estimated_tokens=1000,
            model_id=self.kimi_model_id,
            idempotency_key="pr4-kimi-preview",
            model_config={
                "provider_key": "moonshot",
                "canonical_provider_key": "moonshot",
                "model_id": self.kimi_model_id,
                "model_name": "not-used-for-provider-matching",
                "input_price_per_1k": "1",
                "output_price_per_1k": "0",
            },
        )

        self.assertTrue(decision["allowed"])
        self.assertEqual(
            [item["source_type"] for item in decision["funding_preview"]],
            ["organization_wallet"],
        )
        self.assertNotIn(
            "provider_credit",
            {
                item["source_type"]
                for item in decision["funding_preview"]
            },
        )
        self.grant.refresh_from_db()
        self.assertEqual(self.grant.remaining_credits, Decimal("100"))

    @override_settings(
        PROVIDER_CREDIT_FUNDING_ENABLED=False,
        PROVIDER_CREDIT_UI_ENABLED=True,
    )
    @patch(
        "apps.services.billing.services.gateway."
        "MeterPricingService.get_unit_price",
        return_value=Decimal("1"),
    )
    @patch(
        "apps.services.billing.services.gateway."
        "OrganizationBillingPolicyService.get_effective_policy",
        return_value={"llm_billing_mode": "paygo_only"},
    )
    @patch(
        "apps.services.billing.services.gateway."
        "OrganizationLlmBudgetService.get_remaining_quota_credits",
        return_value=Decimal("0"),
    )
    @patch(
        "apps.services.billing.services.gateway.BillingGateway._wallet_available",
        return_value=Decimal("0"),
    )
    def test_ui_flag_alone_never_changes_legacy_precheck_decision(
        self,
        _wallet,
        _remaining,
        _policy,
        _price,
    ):
        decision = BillingGateway.precheck_llm_usage(
            organization_id=self.organization_id,
            user_id="provider-credit-capability-user",
            estimated_tokens=1000,
            model_id=self.doubao_model_id,
            model_config={
                "provider_key": "volcengine",
                "canonical_provider_key": "volcengine",
                "model_id": self.doubao_model_id,
                "model_name": "doubao",
                "input_price_per_1k": "1",
            },
        )

        self.assertFalse(decision["allowed"])
        self.assertEqual(decision["funding_preview"], [])


class ProviderCreditCatalogFlagTests(TestCase):
    databases = {"default"}

    def setUp(self):
        self.organization_id = org_id_for("provider_credit_catalog")
        self.user_id = "provider-credit-catalog-user"
        self.doubao_model_id = str(uuid.uuid4())
        self.kimi_model_id = str(uuid.uuid4())
        self.models = [
            self._model(
                model_id=self.doubao_model_id,
                provider="volcengine",
                display_name="豆包 Seed",
            ),
            self._model(
                model_id=self.kimi_model_id,
                provider="moonshot",
                display_name="Kimi K2.6",
            ),
        ]
        self.request = SimpleNamespace(auth=SimpleNamespace(id=self.user_id))

    @staticmethod
    def _model(*, model_id: str, provider: str, display_name: str) -> dict:
        return {
            "id": model_id,
            "name": f"{provider}-model",
            "model_name": f"{provider}-model",
            "display_name": display_name,
            "provider": provider,
            "provider_display_name": provider,
            "provider_key": provider,
            "capability_domain": "chat",
            "billing_type": "token",
            "cost_per_1k_tokens": 1.0,
            "is_user_config": False,
        }

    def _catalog(self):
        with patch(
            "apps.services.llm.api._ensure_self_user_id",
            return_value=self.user_id,
        ), patch(
            "apps.services.llm.api._ensure_organization_permission",
        ), patch(
            "apps.services.llm.api.get_available_models",
            return_value=[dict(model) for model in self.models],
        ), patch(
            "apps.services.llm.api._filter_models_by_member_policy",
            side_effect=lambda models, *_args: models,
        ), patch(
            "apps.services.llm.api._get_providers_metadata",
            return_value={},
        ), patch(
            "apps.services.llm.api._get_platform_capabilities",
            return_value={},
        ):
            return get_model_catalog(
                self.request,
                organization_id=self.organization_id,
                use_case="chat",
            )

    @override_settings(PROVIDER_CREDIT_UI_ENABLED=True)
    def test_catalog_adds_promotion_only_to_eligible_model(self):
        promotion = {
            "eligible": True,
            "provider_key": "volcengine",
            "remaining_credits": 8000.0,
            "total_credits": 10000.0,
            "expire_at": "2026-09-01T00:00:00+00:00",
            "label": "豆包推广赠送额度",
        }
        with patch(
            "apps.services.billing.services.provider_credit_capability."
            "ProviderCreditCapabilityService.get_model_promotion_credits",
            return_value={
                self.doubao_model_id: promotion,
                self.kimi_model_id: None,
            },
        ):
            response = self._catalog()

        models = response["data"]["models"]
        self.assertEqual(models[0]["promotion_credit"], promotion)
        self.assertIsNone(models[1]["promotion_credit"])

    @override_settings(PROVIDER_CREDIT_UI_ENABLED=True)
    def test_catalog_omits_promotion_field_when_projection_is_unavailable(self):
        with patch(
            "apps.services.billing.services.provider_credit_capability."
            "ProviderCreditCapabilityService.get_model_promotion_credits",
            side_effect=RuntimeError("projection unavailable"),
        ):
            response = self._catalog()

        self.assertTrue(
            all(
                "promotion_credit" not in model
                for model in response["data"]["models"]
            )
        )

    @override_settings(PROVIDER_CREDIT_UI_ENABLED=False)
    def test_feature_flag_off_keeps_catalog_and_precheck_legacy_shape(self):
        response = self._catalog()
        self.assertTrue(
            all(
                "promotion_credit" not in model
                for model in response["data"]["models"]
            )
        )

        with patch(
            "apps.services.billing.services.gateway."
            "MeterPricingService.get_unit_price",
            return_value=Decimal("0"),
        ), patch(
            "apps.services.billing.services.gateway."
            "OrganizationBillingPolicyService.get_effective_policy",
            return_value={"llm_billing_mode": "paygo_only"},
        ), patch(
            "apps.services.billing.services.gateway."
            "OrganizationLlmBudgetService.get_remaining_quota_credits",
            return_value=Decimal("0"),
        ):
            decision = BillingGateway.precheck_llm_usage(
                organization_id=self.organization_id,
                user_id=self.user_id,
                estimated_tokens=1000,
                model_id=self.doubao_model_id,
                model_config={
                    "provider_key": "volcengine",
                    "model_name": "doubao",
                    "input_price_per_1k": "0",
                },
            )

        self.assertNotIn("estimated_credits", decision)
        self.assertNotIn("funding_preview", decision)

    @override_settings(PROVIDER_CREDIT_UI_ENABLED=True)
    def test_precheck_api_validates_visible_model_and_returns_gateway_preview(self):
        gateway_preview = {
            "allowed": True,
            "estimated_credits": "100.0000",
            "funding_preview": [
                {
                    "source_type": "provider_credit",
                    "credits": "100.0000",
                    "campaign_code": "DOUBAO_NEW_USER",
                }
            ],
        }
        with patch(
            "apps.services.llm.api._ensure_self_user_id",
            return_value=self.user_id,
        ), patch(
            "apps.services.llm.api._ensure_organization_permission",
        ), patch(
            "apps.services.llm.api.get_available_models",
            return_value=[dict(model) for model in self.models],
        ), patch(
            "apps.services.llm.api._filter_models_by_member_policy",
            side_effect=lambda models, *_args: models,
        ), patch(
            "apps.services.billing.services.gateway."
            "BillingGateway.precheck_llm_usage",
            return_value=gateway_preview,
        ) as precheck:
            response = preview_model_funding(
                self.request,
                FundingPreviewRequest(
                    organization_id=self.organization_id,
                    model_id=self.doubao_model_id,
                    estimated_tokens=1000,
                ),
            )

        self.assertEqual(response["data"], gateway_preview)
        precheck.assert_called_once_with(
            organization_id=self.organization_id,
            user_id=self.user_id,
            estimated_tokens=1000,
            model_id=self.doubao_model_id,
            context={"source": "electron_funding_preview"},
            perform_side_effects=False,
        )
