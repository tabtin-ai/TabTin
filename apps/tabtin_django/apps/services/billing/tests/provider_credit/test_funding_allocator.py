from __future__ import annotations

import uuid
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
from threading import Barrier
from unittest.mock import patch

from django.db import close_old_connections
from django.test import SimpleTestCase, TestCase, TransactionTestCase, override_settings

from apps.services.billing.models import (
    BillingUsageEvent,
    ProviderCreditGrant,
    ProviderCreditTransaction,
)
from apps.services.billing.services.gateway import BillingGateway
from apps.services.billing.services.funding_allocator import (
    FundingAllocator,
    ORGANIZATION_WALLET,
    PROVIDER_CREDIT,
)
from apps.services.billing.services.provider_credit_service import ProviderCreditService
from apps.services.billing.tests.org_test_utils import org_id_for
from apps.users.wallet.exceptions import InsufficientCreditsError
from apps.users.wallet.models import OrganizationWallet
from apps.users.wallet.services.credits_service import CreditsService


@override_settings(PROVIDER_CREDIT_FUNDING_ENABLED=True)
class ProviderCreditGatewayPrecheckTests(SimpleTestCase):
    def test_provider_credit_allows_request_without_monthly_or_wallet(self):
        model_id = str(uuid.uuid4())
        with patch(
            "apps.services.billing.services.gateway."
            "MeterPricingService.get_unit_price",
            return_value=Decimal("0.01"),
        ), patch(
            "apps.services.billing.services.gateway."
            "OrganizationBillingPolicyService.get_effective_policy",
            return_value={"llm_billing_mode": "paygo_only"},
        ), patch(
            "apps.services.billing.services.gateway."
            "OrganizationLlmBudgetService.get_remaining_quota_credits",
            return_value=Decimal("0"),
        ), patch(
            "apps.services.billing.services.gateway.BillingGateway._wallet_available",
            return_value=Decimal("0"),
        ), patch(
            "apps.services.billing.services.provider_credit_service."
            "ProviderCreditService.get_available_credit",
            return_value=Decimal("1"),
        ):
            decision = BillingGateway.precheck_llm_usage(
                organization_id=str(uuid.uuid4()),
                user_id="provider-credit-precheck-user",
                estimated_tokens=1000,
                model_id=model_id,
                model_config={
                    "provider_key": "volcengine",
                    "model_name": "doubao-display",
                    "input_price_per_1k": "0.01",
                },
            )

        self.assertTrue(decision["allowed"])
        self.assertEqual(decision["wallet_required"], "0")
        self.assertEqual(decision["charge_mode"], "provider_credit")


@override_settings(PROVIDER_CREDIT_FUNDING_ENABLED=True)
class ProviderCreditFundingAllocatorTests(TestCase):
    databases = {"default"}

    def setUp(self):
        self.organization_id = org_id_for("provider_credit_funding")
        self.doubao_model_id = str(uuid.uuid4())
        self.kimi_model_id = str(uuid.uuid4())
        self.qwen_model_id = str(uuid.uuid4())

    def _grant(
        self,
        *,
        code: str,
        provider_key: str,
        amount: Decimal,
        model_ids: list[str] | None = None,
    ) -> ProviderCreditGrant:
        campaign = ProviderCreditService.create_campaign(
            code=code,
            name=code,
            provider_key=provider_key,
            eligible_model_ids=model_ids or [],
            credits_amount=amount,
            total_budget_credits=amount,
        )
        return ProviderCreditService.grant_credit(
            organization=self.organization_id,
            campaign=campaign,
        )

    def _wallet(self, amount: Decimal) -> OrganizationWallet:
        return OrganizationWallet.objects.create(
            organization_id=self.organization_id,
            credits_precise=amount,
        )

    @patch(
        "apps.services.billing.services.funding_allocator."
        "OrganizationLlmBudgetService.consume_llm_credits",
    )
    @patch(
        "apps.services.billing.services.funding_allocator."
        "OrganizationLlmBudgetService.get_remaining_quota_credits",
        return_value=Decimal("1.0000"),
    )
    def test_preview_allocation_never_consumes_budget(
        self,
        get_remaining,
        consume,
    ):
        allocations = FundingAllocator.preview_funding(
            organization=self.organization_id,
            provider_key="volcengine",
            model_id=self.doubao_model_id,
            required_credits=Decimal("1.0000"),
            billing_context={
                "llm_billing_mode": "quota_then_paygo",
            },
        )

        self.assertEqual(
            [allocation.source_type for allocation in allocations],
            ["monthly_budget"],
        )
        consume.assert_not_called()
        self.assertFalse(get_remaining.call_args.kwargs["sync_entitlement"])

    def _consume(
        self,
        *,
        provider_key: str,
        model_id: str,
        idempotency_key: str,
    ):
        return CreditsService.consume_credits_for_llm(
            user="provider-credit-test-user",
            input_tokens=1000,
            output_tokens=0,
            model_config={
                "provider_key": provider_key,
                "canonical_provider_key": provider_key,
                "model_id": model_id,
                "model_name": "display-name-must-not-match-funding",
                "input_price_per_1k": "1",
                "output_price_per_1k": "0",
            },
            organization_id=self.organization_id,
            biz_id=idempotency_key,
            idempotency_key=idempotency_key,
        )

    @patch(
        "apps.services.billing.services.policy_service."
        "OrganizationBillingPolicyService.get_effective_policy",
        return_value={"llm_billing_mode": "paygo_only"},
    )
    def test_doubao_model_consumes_matching_provider_credit(self, _policy):
        grant = self._grant(
            code="PR3_DOUBAO_MATCH",
            provider_key="volcengine",
            amount=Decimal("100"),
            model_ids=[self.doubao_model_id],
        )

        result = self._consume(
            provider_key="volcengine",
            model_id=self.doubao_model_id,
            idempotency_key="pr3-doubao-match",
        )

        grant.refresh_from_db()
        self.assertEqual(grant.remaining_credits, Decimal("0"))
        self.assertEqual(result["provider_credit_credits_precise"], Decimal("100.0000"))
        self.assertEqual(result["credits_consumed_precise"], Decimal("0.0000"))
        self.assertEqual(
            [item["source_type"] for item in result["funding_allocations"]],
            [PROVIDER_CREDIT],
        )
        event = BillingUsageEvent.objects.get(
            idempotency_key="pr3-doubao-match"
        )
        self.assertEqual(
            event.metadata["funding_allocations"]["total_credits"],
            "100.0000",
        )

    @patch(
        "apps.services.billing.services.policy_service."
        "OrganizationBillingPolicyService.get_effective_policy",
        return_value={"llm_billing_mode": "paygo_only"},
    )
    def test_kimi_model_does_not_consume_doubao_credit(self, _policy):
        grant = self._grant(
            code="PR3_DOUBAO_NOT_KIMI",
            provider_key="volcengine",
            amount=Decimal("100"),
        )
        wallet = self._wallet(Decimal("100"))

        result = self._consume(
            provider_key="moonshot",
            model_id=self.kimi_model_id,
            idempotency_key="pr3-kimi-mismatch",
        )

        grant.refresh_from_db()
        wallet.refresh_from_db()
        self.assertEqual(grant.remaining_credits, Decimal("100"))
        self.assertEqual(wallet.credits_precise, Decimal("0"))
        self.assertEqual(result["provider_credit_credits_precise"], Decimal("0.0000"))
        self.assertEqual(
            [item["source_type"] for item in result["funding_allocations"]],
            [ORGANIZATION_WALLET],
        )

    @patch(
        "apps.services.billing.services.policy_service."
        "OrganizationBillingPolicyService.get_effective_policy",
        return_value={"llm_billing_mode": "paygo_only"},
    )
    def test_qwen_uses_dashscope_credit_independently(self, _policy):
        qwen_grant = self._grant(
            code="PR3_QWEN_MATCH",
            provider_key="dashscope",
            amount=Decimal("100"),
            model_ids=[self.qwen_model_id],
        )
        doubao_grant = self._grant(
            code="PR3_DOUBAO_OTHER_POOL",
            provider_key="volcengine",
            amount=Decimal("100"),
        )

        result = self._consume(
            provider_key="dashscope",
            model_id=self.qwen_model_id,
            idempotency_key="pr3-qwen-match",
        )

        qwen_grant.refresh_from_db()
        doubao_grant.refresh_from_db()
        self.assertEqual(qwen_grant.remaining_credits, Decimal("0"))
        self.assertEqual(doubao_grant.remaining_credits, Decimal("100"))
        self.assertEqual(result["provider_credit_credits_precise"], Decimal("100.0000"))

    @patch(
        "apps.services.billing.services.llm_budget_service."
        "OrganizationLlmBudgetService._resolve_monthly_included_credits",
        return_value=Decimal("30"),
    )
    @patch(
        "apps.services.billing.services.policy_service."
        "OrganizationBillingPolicyService.get_effective_policy",
        return_value={"llm_billing_mode": "quota_then_paygo"},
    )
    def test_partial_provider_then_monthly_then_wallet(self, _policy, _included):
        grant = self._grant(
            code="PR3_MIXED_FUNDING",
            provider_key="volcengine",
            amount=Decimal("50"),
        )
        wallet = self._wallet(Decimal("20"))

        result = self._consume(
            provider_key="volcengine",
            model_id=self.doubao_model_id,
            idempotency_key="pr3-mixed-funding",
        )

        grant.refresh_from_db()
        wallet.refresh_from_db()
        self.assertEqual(grant.remaining_credits, Decimal("0"))
        self.assertEqual(wallet.credits_precise, Decimal("0"))
        self.assertEqual(result["provider_credit_credits_precise"], Decimal("50.0000"))
        self.assertEqual(result["quota_covered_credits_precise"], Decimal("30.0000"))
        self.assertEqual(result["credits_consumed_precise"], Decimal("20.0000"))
        self.assertEqual(
            [item["source_type"] for item in result["funding_allocations"]],
            ["provider_credit", "monthly_budget", "organization_wallet"],
        )

    @patch(
        "apps.services.billing.services.policy_service."
        "OrganizationBillingPolicyService.get_effective_policy",
        return_value={"llm_billing_mode": "paygo_only"},
    )
    def test_no_provider_credit_preserves_wallet_fallback(self, _policy):
        wallet = self._wallet(Decimal("100"))

        result = self._consume(
            provider_key="deepseek",
            model_id=str(uuid.uuid4()),
            idempotency_key="pr3-no-provider",
        )

        wallet.refresh_from_db()
        self.assertEqual(wallet.credits_precise, Decimal("0"))
        self.assertEqual(result["provider_credit_credits_precise"], Decimal("0.0000"))
        self.assertEqual(result["credits_consumed_precise"], Decimal("100.0000"))

    @patch(
        "apps.services.billing.services.policy_service."
        "OrganizationBillingPolicyService.get_effective_policy",
        return_value={"llm_billing_mode": "paygo_only"},
    )
    def test_wallet_failure_rolls_back_provider_reservation(self, _policy):
        grant = self._grant(
            code="PR3_ROLLBACK_PROVIDER",
            provider_key="volcengine",
            amount=Decimal("50"),
        )

        with self.assertRaises(InsufficientCreditsError):
            self._consume(
                provider_key="volcengine",
                model_id=self.doubao_model_id,
                idempotency_key="pr3-rollback-provider",
            )

        grant.refresh_from_db()
        self.assertEqual(grant.remaining_credits, Decimal("50"))
        self.assertEqual(grant.consumed_credits, Decimal("0"))
        self.assertFalse(
            ProviderCreditTransaction.objects.filter(
                grant=grant,
                transaction_type=ProviderCreditTransaction.TransactionType.CONSUME,
            ).exists()
        )
        self.assertFalse(
            BillingUsageEvent.objects.filter(
                idempotency_key="pr3-rollback-provider"
            ).exists()
        )


class ProviderCreditFundingFlagCompatibilityTests(TestCase):
    databases = {"default"}

    @override_settings(PROVIDER_CREDIT_FUNDING_ENABLED=False)
    @patch(
        "apps.services.billing.services.policy_service."
        "OrganizationBillingPolicyService.get_effective_policy",
        return_value={"llm_billing_mode": "paygo_only"},
    )
    def test_flag_disabled_keeps_legacy_wallet_path(self, _policy):
        organization_id = org_id_for("provider_credit_flag_off")
        model_id = str(uuid.uuid4())
        campaign = ProviderCreditService.create_campaign(
            code="PR3_FLAG_OFF",
            name="PR3_FLAG_OFF",
            provider_key="volcengine",
            eligible_model_ids=[model_id],
            credits_amount=Decimal("100"),
            total_budget_credits=Decimal("100"),
        )
        grant = ProviderCreditService.grant_credit(
            organization=organization_id,
            campaign=campaign,
        )
        wallet = OrganizationWallet.objects.create(
            organization_id=organization_id,
            credits_precise=Decimal("100"),
        )

        result = CreditsService.consume_credits_for_llm(
            user="provider-credit-flag-off",
            input_tokens=1000,
            output_tokens=0,
            model_config={
                "provider_key": "volcengine",
                "canonical_provider_key": "volcengine",
                "model_id": model_id,
                "model_name": "doubao",
                "input_price_per_1k": "1",
                "output_price_per_1k": "0",
            },
            organization_id=organization_id,
            idempotency_key="pr3-flag-off",
        )

        grant.refresh_from_db()
        wallet.refresh_from_db()
        self.assertEqual(grant.remaining_credits, Decimal("100"))
        self.assertEqual(wallet.credits_precise, Decimal("0"))
        self.assertNotIn("provider_credit_credits_precise", result)
        self.assertNotIn("funding_allocations", result)
        event = BillingUsageEvent.objects.get(idempotency_key="pr3-flag-off")
        self.assertNotIn("funding_allocations", event.metadata)


@override_settings(PROVIDER_CREDIT_FUNDING_ENABLED=True)
class ProviderCreditFundingConcurrencyTests(TransactionTestCase):
    databases = {"default"}
    reset_sequences = False

    def setUp(self):
        self.organization_id = org_id_for("provider_credit_funding_concurrency")
        self.model_id = str(uuid.uuid4())
        campaign = ProviderCreditService.create_campaign(
            code="PR3_CONCURRENT_CONSUME",
            name="PR3_CONCURRENT_CONSUME",
            provider_key="volcengine",
            eligible_model_ids=[self.model_id],
            credits_amount=Decimal("100"),
            total_budget_credits=Decimal("100"),
        )
        self.grant = ProviderCreditService.grant_credit(
            organization=self.organization_id,
            campaign=campaign,
        )

    def test_two_requests_never_make_same_grant_negative(self):
        barrier = Barrier(2)

        def _allocate(index: int):
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                allocations = FundingAllocator.allocate_funding(
                    organization=self.organization_id,
                    provider_key="volcengine",
                    model_id=self.model_id,
                    required_credits=Decimal("80"),
                    billing_context={
                        "idempotency_key": f"pr3-concurrent-{index}",
                        "llm_billing_mode": "paygo_only",
                    },
                )
                return FundingAllocator.credits_for(
                    allocations,
                    PROVIDER_CREDIT,
                )
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as executor:
            provider_amounts = list(executor.map(_allocate, [1, 2]))

        self.grant.refresh_from_db()
        self.assertEqual(sum(provider_amounts), Decimal("100.0000"))
        self.assertEqual(self.grant.remaining_credits, Decimal("0"))
        self.assertEqual(self.grant.consumed_credits, Decimal("100"))
        self.assertGreaterEqual(self.grant.remaining_credits, Decimal("0"))
        consumed = ProviderCreditTransaction.objects.filter(
            grant=self.grant,
            transaction_type=ProviderCreditTransaction.TransactionType.CONSUME,
        )
        self.assertEqual(
            sum((transaction.amount for transaction in consumed), Decimal("0")),
            Decimal("-100"),
        )
