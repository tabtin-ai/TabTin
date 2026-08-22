from __future__ import annotations

import uuid
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase, override_settings

from apps.services.billing.services.gateway import BillingGateway


class OfficialFundingPriorityPrecheckTests(SimpleTestCase):
    def _precheck(
        self,
        *,
        provider_credit: str,
        monthly_budget: str,
        organization_wallet: str,
        funding_enabled: bool = True,
    ) -> tuple[dict, MagicMock, str]:
        model_id = str(uuid.uuid4())
        with override_settings(
            PROVIDER_CREDIT_FUNDING_ENABLED=funding_enabled,
            PROVIDER_CREDIT_UI_ENABLED=False,
            CREDITS_PER_YUAN=100,
        ), patch(
            "apps.services.billing.services.gateway."
            "MeterPricingService.get_unit_price",
            return_value=Decimal("1"),
        ), patch(
            "apps.services.billing.services.gateway."
            "OrganizationBillingPolicyService.get_effective_policy",
            return_value={"llm_billing_mode": "quota_then_paygo"},
        ), patch(
            "apps.services.billing.services.gateway."
            "OrganizationLlmBudgetService.get_remaining_quota_credits",
            return_value=Decimal(monthly_budget),
        ), patch(
            "apps.services.billing.services.gateway.BillingGateway._wallet_available",
            return_value=Decimal(organization_wallet),
        ), patch(
            "apps.services.billing.services.provider_credit_service."
            "ProviderCreditService.get_available_credit",
            return_value=Decimal(provider_credit),
        ) as targeted:
            decision = BillingGateway.precheck_llm_usage(
                organization_id=str(uuid.uuid4()),
                user_id="funding-audit-user",
                estimated_tokens=1000,
                model_id=model_id,
                model_config={
                    "provider_key": "volcengine",
                    "model_name": "same-display-name",
                    "input_price_per_1k": "1",
                },
                perform_side_effects=False,
            )
        return decision, targeted, model_id

    def test_targeted_credit_can_fully_cover_official_call(self):
        decision, targeted, model_id = self._precheck(
            provider_credit="100",
            monthly_budget="0",
            organization_wallet="0",
        )

        self.assertTrue(decision["allowed"])
        self.assertEqual(decision["wallet_required"], "0")
        self.assertEqual(decision["charge_mode"], "provider_credit")
        targeted.assert_called_once()
        self.assertEqual(targeted.call_args.kwargs["provider_key"], "volcengine")
        self.assertEqual(
            targeted.call_args.kwargs["model_id"],
            model_id,
        )

    def test_partial_funding_uses_targeted_then_general_then_wallet(self):
        decision, _targeted, _model_id = self._precheck(
            provider_credit="20",
            monthly_budget="30",
            organization_wallet="50",
        )

        self.assertTrue(decision["allowed"])
        self.assertEqual(decision["metadata"]["provider_credit_covered"], "20.0000")
        self.assertEqual(decision["included_available"], "30.0000")
        self.assertEqual(decision["wallet_required"], "50.0000")
        self.assertEqual(decision["charge_mode"], "mixed_provider_funding")

    def test_insufficient_combined_funding_blocks_before_provider(self):
        decision, _targeted, _model_id = self._precheck(
            provider_credit="10",
            monthly_budget="20",
            organization_wallet="5",
        )

        self.assertFalse(decision["allowed"])
        self.assertEqual(decision["charge_mode"], "blocked")
        self.assertEqual(decision["wallet_required"], "70.0000")

    def test_funding_flag_off_preserves_legacy_general_then_wallet_path(self):
        decision, targeted, _model_id = self._precheck(
            provider_credit="100",
            monthly_budget="30",
            organization_wallet="70",
            funding_enabled=False,
        )

        self.assertTrue(decision["allowed"])
        targeted.assert_not_called()
        self.assertNotIn("provider_credit_covered", decision["metadata"])
        self.assertEqual(decision["wallet_required"], "70.0000")


class ProviderCreditIdentityTests(SimpleTestCase):
    def test_same_display_name_never_changes_provider_and_model_matching(self):
        from apps.services.billing.services.provider_credit_service import (
            matches_provider_credit,
        )

        selected_model_id = str(uuid.uuid4())
        other_model_id = str(uuid.uuid4())
        grant = SimpleNamespace(
            provider_key="volcengine",
            eligible_model_ids=[selected_model_id],
        )

        self.assertTrue(
            matches_provider_credit(grant, "volcengine", selected_model_id)
        )
        self.assertFalse(
            matches_provider_credit(grant, "moonshot", selected_model_id)
        )
        self.assertFalse(
            matches_provider_credit(grant, "volcengine", other_model_id)
        )


class FundingFlagSnapshotAuditTests(SimpleTestCase):
    def test_funding_mode_is_frozen_per_invocation(self):
        from apps.services.llm.services._runtime.billing_precheck import (
            _current_funding_mode,
        )
        from apps.services.llm.services._runtime.invocation import (
            SceneInvocationContext,
        )

        with override_settings(PROVIDER_CREDIT_FUNDING_ENABLED=True):
            invocation_a = SceneInvocationContext.stable(
                invocation_id="funding-flag-race:a:v1",
                scene_key="diary_distill",
                execution_key="diary_distill",
                organization_id=str(uuid.uuid4()),
                user_id=str(uuid.uuid4()),
            )
            mode_at_dispatch = _current_funding_mode()
        with override_settings(PROVIDER_CREDIT_FUNDING_ENABLED=False):
            mode_at_retry = _current_funding_mode()
            retry_a = invocation_a.start_attempt()
            invocation_b = SceneInvocationContext.stable(
                invocation_id="funding-flag-race:b:v1",
                scene_key="diary_distill",
                execution_key="diary_distill",
                organization_id=str(uuid.uuid4()),
                user_id=str(uuid.uuid4()),
            )

        self.assertEqual(mode_at_dispatch, "provider_credit_v1")
        self.assertEqual(mode_at_retry, "legacy_budget_wallet")
        self.assertEqual(retry_a.funding_mode, "provider_credit_v1")
        self.assertEqual(invocation_b.funding_mode, "legacy_budget_wallet")
