from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase

from apps.services.billing.services.gateway import BillingGateway
from apps.services.llm.scenes.exceptions import BudgetExceeded
from apps.services.llm.services._runtime.billing_precheck import check_billing
from apps.services.llm.services._runtime.usage_recorder import _settle_llm_billing
from apps.services.billing.tests.org_test_utils import fake_org_id


class BillingGatewayPrecheckTests(SimpleTestCase):
    def test_precheck_allows_when_monthly_quota_covers_estimate(self):
        with patch(
            "apps.services.billing.services.gateway.MeterPricingService.get_unit_price",
            return_value=Decimal("0.01"),
        ), patch(
            "apps.services.billing.services.gateway.OrganizationBillingPolicyService.get_effective_policy",
            return_value={"llm_billing_mode": "quota_then_paygo"},
        ), patch(
            "apps.services.billing.services.gateway.OrganizationLlmBudgetService.get_remaining_quota_credits",
            return_value=Decimal("10"),
        ), patch(
            "apps.services.billing.services.gateway.BillingGateway._wallet_available",
            return_value=Decimal("0"),
        ), patch.object(BillingGateway, "record_blocked_llm_usage") as mock_blocked:
            decision = BillingGateway.precheck_llm_usage(
                fake_org_id("wt_1"),
                "user_1",
                1000,
                model_config={
                    "provider_key": "openai",
                    "model_name": "gpt-test",
                    "input_price_per_1k": "0.01",
                },
            )

        self.assertTrue(decision["allowed"])
        self.assertEqual(decision["charge_mode"], "included_quota")
        mock_blocked.assert_not_called()

    def test_precheck_allows_when_wallet_covers_quota_overflow(self):
        with patch(
            "apps.services.billing.services.gateway.MeterPricingService.get_unit_price",
            return_value=Decimal("0.01"),
        ), patch(
            "apps.services.billing.services.gateway.OrganizationBillingPolicyService.get_effective_policy",
            return_value={"llm_billing_mode": "quota_then_paygo"},
        ), patch(
            "apps.services.billing.services.gateway.OrganizationLlmBudgetService.get_remaining_quota_credits",
            return_value=Decimal("0.5"),
        ), patch(
            "apps.services.billing.services.gateway.BillingGateway._wallet_available",
            return_value=Decimal("5"),
        ):
            decision = BillingGateway.precheck_llm_usage(
                fake_org_id("wt_1"),
                "user_1",
                1000,
                model_config={
                    "provider_key": "openai",
                    "model_name": "gpt-test",
                    "input_price_per_1k": "0.01",
                },
            )

        self.assertTrue(decision["allowed"])
        self.assertEqual(decision["charge_mode"], "mixed_quota_wallet")
        self.assertEqual(decision["wallet_required"], "0.5000")

    def test_precheck_records_blocked_when_wallet_cannot_cover_overflow(self):
        with patch(
            "apps.services.billing.services.gateway.MeterPricingService.get_unit_price",
            return_value=Decimal("0.01"),
        ), patch(
            "apps.services.billing.services.gateway.OrganizationBillingPolicyService.get_effective_policy",
            return_value={"llm_billing_mode": "quota_then_paygo"},
        ), patch(
            "apps.services.billing.services.gateway.OrganizationLlmBudgetService.get_remaining_quota_credits",
            return_value=Decimal("0"),
        ), patch(
            "apps.services.billing.services.gateway.BillingGateway._wallet_available",
            return_value=Decimal("0"),
        ), patch.object(BillingGateway, "record_blocked_llm_usage") as mock_blocked:
            decision = BillingGateway.precheck_llm_usage(
                fake_org_id("wt_1"),
                "user_1",
                1000,
                idempotency_key="msg_1",
                model_config={
                    "provider_key": "openai",
                    "model_name": "gpt-test",
                    "input_price_per_1k": "0.01",
                },
            )

        self.assertFalse(decision["allowed"])
        self.assertEqual(decision["code"], "BILLING_WALLET_INSUFFICIENT")
        self.assertEqual(decision["charge_mode"], "blocked")
        mock_blocked.assert_called_once()

    def test_precheck_can_suppress_blocked_event_for_candidate_model(self):
        with patch(
            "apps.services.billing.services.gateway.MeterPricingService.get_unit_price",
            return_value=Decimal("0.01"),
        ), patch(
            "apps.services.billing.services.gateway.OrganizationBillingPolicyService.get_effective_policy",
            return_value={"llm_billing_mode": "quota_then_paygo"},
        ), patch(
            "apps.services.billing.services.gateway.OrganizationLlmBudgetService.get_remaining_quota_credits",
            return_value=Decimal("0"),
        ), patch(
            "apps.services.billing.services.gateway.BillingGateway._wallet_available",
            return_value=Decimal("0"),
        ), patch.object(BillingGateway, "record_blocked_llm_usage") as mock_blocked:
            decision = BillingGateway.precheck_llm_usage(
                fake_org_id("wt_1"),
                "user_1",
                1000,
                context={"suppress_blocked_event": True},
                idempotency_key="msg_1",
                model_config={
                    "provider_key": "openai",
                    "model_name": "gpt-test",
                    "input_price_per_1k": "0.01",
                },
            )

        self.assertFalse(decision["allowed"])
        self.assertEqual(decision["charge_mode"], "blocked")
        mock_blocked.assert_not_called()

    def test_read_only_preview_does_not_top_up_or_record_block(self):
        with patch(
            "apps.services.billing.services.gateway.MeterPricingService.get_unit_price",
            return_value=Decimal("0.01"),
        ), patch(
            "apps.services.billing.services.gateway.OrganizationBillingPolicyService.get_effective_policy",
            return_value={"llm_billing_mode": "quota_only"},
        ), patch(
            "apps.services.billing.services.gateway.OrganizationLlmBudgetService.get_remaining_quota_credits",
            return_value=Decimal("0"),
        ) as mock_quota, patch(
            "apps.services.billing.services.gateway.BillingGateway._wallet_available",
            return_value=Decimal("0"),
        ), patch(
            "apps.services.billing.services.llm_topup_service.LlmQuotaTopupService.try_auto_topup",
        ) as mock_topup, patch.object(
            BillingGateway, "record_blocked_llm_usage",
        ) as mock_blocked:
            decision = BillingGateway.precheck_llm_usage(
                fake_org_id("wt_preview"),
                "user_1",
                1000,
                model_config={
                    "provider_key": "openai",
                    "model_name": "gpt-test",
                    "input_price_per_1k": "0.01",
                },
                perform_side_effects=False,
            )

        self.assertFalse(decision["allowed"])
        mock_quota.assert_called_once_with(
            fake_org_id("wt_preview"),
            sync_entitlement=False,
        )
        mock_topup.assert_not_called()
        mock_blocked.assert_not_called()

    def test_precheck_quota_only_allows_when_monthly_quota_covers(self):
        # ：quota_only 月度配额可覆盖预估时放行，钱包无需参与（wallet_required=0）
        with patch(
            "apps.services.billing.services.gateway.MeterPricingService.get_unit_price",
            return_value=Decimal("0.01"),
        ), patch(
            "apps.services.billing.services.gateway.OrganizationBillingPolicyService.get_effective_policy",
            return_value={"llm_billing_mode": "quota_only"},
        ), patch(
            "apps.services.billing.services.gateway.OrganizationLlmBudgetService.get_remaining_quota_credits",
            return_value=Decimal("10"),
        ), patch(
            "apps.services.billing.services.gateway.BillingGateway._wallet_available",
            return_value=Decimal("0"),
        ), patch.object(BillingGateway, "record_blocked_llm_usage") as mock_blocked:
            decision = BillingGateway.precheck_llm_usage(
                fake_org_id("wt_1"),
                "user_1",
                1000,
                model_config={
                    "provider_key": "openai",
                    "model_name": "gpt-test",
                    "input_price_per_1k": "0.01",
                },
            )

        self.assertTrue(decision["allowed"])
        self.assertEqual(decision["wallet_required"], "0")
        mock_blocked.assert_not_called()

    def test_precheck_quota_only_allows_when_wallet_covers_after_quota_exhausted(self):
        # ：quota_only 月度配额耗尽后，持久点券钱包可覆盖剩余即放行
        with patch(
            "apps.services.billing.services.gateway.MeterPricingService.get_unit_price",
            return_value=Decimal("0.01"),
        ), patch(
            "apps.services.billing.services.gateway.OrganizationBillingPolicyService.get_effective_policy",
            return_value={"llm_billing_mode": "quota_only"},
        ), patch(
            "apps.services.billing.services.gateway.OrganizationLlmBudgetService.get_remaining_quota_credits",
            return_value=Decimal("0"),
        ), patch(
            "apps.services.billing.services.gateway.BillingGateway._wallet_available",
            return_value=Decimal("5"),
        ), patch.object(BillingGateway, "record_blocked_llm_usage") as mock_blocked:
            decision = BillingGateway.precheck_llm_usage(
                "wt_1",
                "user_1",
                1000,
                model_config={
                    "provider_key": "openai",
                    "model_name": "gpt-test",
                    "input_price_per_1k": "0.01",
                },
            )

        self.assertTrue(decision["allowed"])
        self.assertEqual(decision["wallet_required"], "1.0000")
        mock_blocked.assert_not_called()

    def test_precheck_quota_only_topup_covers_dead_zone_dust(self):
        #  零头死区：配额空、钱包剩零头 0.5 < 本次预估 1.0，
        # 自动补充必须按本次所需触发（required_credits=1.0），补充后复查放行。
        with patch(
            "apps.services.billing.services.gateway.MeterPricingService.get_unit_price",
            return_value=Decimal("0.01"),
        ), patch(
            "apps.services.billing.services.gateway.OrganizationBillingPolicyService.get_effective_policy",
            return_value={"llm_billing_mode": "quota_only"},
        ), patch(
            "apps.services.billing.services.gateway.OrganizationLlmBudgetService.get_remaining_quota_credits",
            side_effect=[Decimal("0"), Decimal("0")],
        ), patch(
            "apps.services.billing.services.gateway.BillingGateway._wallet_available",
            side_effect=[Decimal("0.5"), Decimal("100.5")],
        ), patch(
            "apps.services.billing.services.llm_topup_service.LlmQuotaTopupService.try_auto_topup",
            return_value={"topped_up": True, "reason": "topped_up"},
        ) as mock_topup, patch.object(BillingGateway, "record_blocked_llm_usage") as mock_blocked:
            decision = BillingGateway.precheck_llm_usage(
                "wt_1",
                "user_1",
                1000,
                model_config={
                    "provider_key": "openai",
                    "model_name": "gpt-test",
                    "input_price_per_1k": "0.01",
                },
            )

        self.assertTrue(decision["allowed"])
        mock_blocked.assert_not_called()
        # 关键：补充按「本次所需」触发，而非只看静态阈值（消除死区）
        _, kwargs = mock_topup.call_args
        self.assertEqual(kwargs.get("required_credits"), Decimal("1.0000"))

    def test_precheck_quota_only_blocks_when_quota_and_wallet_empty(self):
        # ：quota_only 月度配额 + 钱包 均空、自动补充也无法完成时阻断
        with patch(
            "apps.services.billing.services.gateway.MeterPricingService.get_unit_price",
            return_value=Decimal("0.01"),
        ), patch(
            "apps.services.billing.services.gateway.OrganizationBillingPolicyService.get_effective_policy",
            return_value={"llm_billing_mode": "quota_only"},
        ), patch(
            "apps.services.billing.services.gateway.OrganizationLlmBudgetService.get_remaining_quota_credits",
            return_value=Decimal("0"),
        ), patch(
            "apps.services.billing.services.gateway.BillingGateway._wallet_available",
            return_value=Decimal("0"),
        ), patch(
            "apps.services.billing.services.llm_topup_service.LlmQuotaTopupService.try_auto_topup",
            return_value={"topped_up": False, "reason": "wallet_insufficient"},
        ), patch.object(BillingGateway, "record_blocked_llm_usage") as mock_blocked:
            decision = BillingGateway.precheck_llm_usage(
                "wt_1",
                "user_1",
                1000,
                idempotency_key="msg_1",
                model_config={
                    "provider_key": "openai",
                    "model_name": "gpt-test",
                    "input_price_per_1k": "0.01",
                },
            )

        self.assertFalse(decision["allowed"])
        self.assertEqual(decision["charge_mode"], "blocked")


class BillingGatewaySettleTests(SimpleTestCase):
    def test_settle_normalizes_quota_only_result(self):
        with patch(
            "apps.users.wallet.services.credits_service.CreditsService.consume_credits_for_llm",
            return_value={
                "used_quota": True,
                "credits_consumed_precise": Decimal("0"),
                "raw_credits_cost_precise": Decimal("1.2"),
                "quota_covered_credits_precise": Decimal("1.2"),
            },
        ):
            result = BillingGateway.settle_llm_usage(
                fake_org_id("wt_1"),
                "user_1",
                1200,
                "model_1",
                idempotency_key="msg_1",
                model_config={
                    "provider_key": "openai",
                    "model_name": "gpt-test",
                    "input_price_per_1k": "0.01",
                    "output_price_per_1k": "0.01",
                },
                input_tokens=1000,
                output_tokens=200,
            )

        self.assertEqual(result["charge_mode"], "included_quota")
        self.assertEqual(result["charge_status"], "included")
        self.assertEqual(result["included_credits"], "1.2000")
        self.assertEqual(result["wallet_credits"], "0.0000")

    def test_settle_normalizes_mixed_quota_wallet_result(self):
        with patch(
            "apps.users.wallet.services.credits_service.CreditsService.consume_credits_for_llm",
            return_value={
                "used_quota": True,
                "credits_consumed_precise": Decimal("2"),
                "raw_credits_cost_precise": Decimal("5"),
                "quota_covered_credits_precise": Decimal("3"),
            },
        ):
            result = BillingGateway.settle_llm_usage(
                fake_org_id("wt_1"),
                "user_1",
                5000,
                "model_1",
                idempotency_key="msg_2",
                model_config={
                    "provider_key": "openai",
                    "model_name": "gpt-test",
                    "input_price_per_1k": "0.01",
                    "output_price_per_1k": "0.01",
                },
                input_tokens=3000,
                output_tokens=2000,
            )

        self.assertEqual(result["charge_mode"], "mixed_quota_wallet")
        self.assertEqual(result["charge_status"], "charged")
        self.assertEqual(result["included_credits"], "3.0000")
        self.assertEqual(result["wallet_credits"], "2.0000")

    def test_settle_requires_stable_idempotency_key(self):
        with self.assertRaisesMessage(ValueError, "BILLING_GATEWAY_REQUIRED"):
            BillingGateway.settle_llm_usage(
                fake_org_id("wt_1"),
                "user_1",
                100,
                "model_1",
                model_config={
                    "provider_key": "openai",
                    "model_name": "gpt-test",
                    "input_price_per_1k": "0.01",
                    "output_price_per_1k": "0.01",
                },
            )

    def test_settle_treats_already_settled_as_idempotent(self):
        with patch(
            "apps.users.wallet.services.credits_service.CreditsService.consume_credits_for_llm",
            return_value={
                "charged": False,
                "reason": "already_settled",
                "used_quota": False,
                "credits_consumed_precise": Decimal("0"),
            },
        ):
            result = BillingGateway.settle_llm_usage(
                fake_org_id("wt_1"),
                "user_1",
                1200,
                "model_1",
                idempotency_key="msg_already",
                model_config={
                    "provider_key": "openai",
                    "model_name": "gpt-test",
                    "input_price_per_1k": "0.01",
                    "output_price_per_1k": "0.01",
                },
                input_tokens=1000,
                output_tokens=200,
            )

        self.assertEqual(result["charge_mode"], "idempotent")
        self.assertEqual(result["reason"], "already_settled")


class UsageRecorderGatewayTests(SimpleTestCase):
    def test_platform_paid_chat_usage_settles_through_gateway(self):
        with patch(
            "apps.services.billing.services.gateway.BillingGateway.settle_llm_usage",
            return_value={"charge_mode": "wallet_charge"},
        ) as mock_settle:
            _settle_llm_billing(
                request_id="req_1",
                scene_key="_main_chat",
                capability_domain="chat",
                provider_id="provider_1",
                provider_key="openai",
                model_id="model_1",
                model_name="gpt-test",
                organization_id=fake_org_id("wt_1"),
                user_id="user_1",
                input_tokens=1000,
                output_tokens=200,
                total_tokens=1200,
                input_cost=Decimal("0.01"),
                output_cost=Decimal("0.02"),
                total_cost=Decimal("0.03"),
                duration_sec=0,
                asset_count=0,
            )

        mock_settle.assert_called_once()
        kwargs = mock_settle.call_args.kwargs
        self.assertEqual(kwargs["organization_id"], fake_org_id("wt_1"))
        self.assertEqual(kwargs["user_id"], "user_1")
        self.assertEqual(kwargs["idempotency_key"], "llm_usage:req_1")
        self.assertEqual(kwargs["input_tokens"], 1000)
        self.assertEqual(kwargs["output_tokens"], 200)

    def test_platform_paid_chat_usage_propagates_settlement_failure(self):
        with patch(
            "apps.services.billing.services.gateway.BillingGateway.settle_llm_usage",
            side_effect=RuntimeError("wallet down"),
        ):
            with self.assertRaisesMessage(RuntimeError, "wallet down"):
                _settle_llm_billing(
                    request_id="req_fail",
                    scene_key="_main_chat",
                    capability_domain="chat",
                    provider_id="provider_1",
                    provider_key="openai",
                    model_id="model_1",
                    model_name="gpt-test",
                    organization_id=fake_org_id("wt_1"),
                    user_id="user_1",
                    input_tokens=1000,
                    output_tokens=200,
                    total_tokens=1200,
                    input_cost=Decimal("0.01"),
                    output_cost=Decimal("0.02"),
                    total_cost=Decimal("0.03"),
                    duration_sec=0,
                    asset_count=0,
                )

    def test_platform_paid_chat_usage_falls_back_to_total_tokens(self):
        with patch(
            "apps.services.billing.services.gateway.BillingGateway.settle_llm_usage",
            return_value={"charge_mode": "wallet_charge"},
        ) as mock_settle:
            _settle_llm_billing(
                request_id="req_total_only",
                scene_key="_main_chat",
                capability_domain="chat",
                provider_id="provider_1",
                provider_key="openai",
                model_id="model_1",
                model_name="gpt-test",
                organization_id=fake_org_id("wt_1"),
                user_id="user_1",
                input_tokens=0,
                output_tokens=0,
                total_tokens=1200,
                input_cost=Decimal("0"),
                output_cost=Decimal("0"),
                total_cost=Decimal("0.03"),
                duration_sec=0,
                asset_count=0,
            )

        kwargs = mock_settle.call_args.kwargs
        self.assertEqual(kwargs["input_tokens"], 1200)
        self.assertEqual(kwargs["output_tokens"], 0)
        self.assertEqual(kwargs["model_config"]["input_price_per_1k"], "0.025000")


class RuntimeBillingPrecheckTests(SimpleTestCase):
    def test_model_specific_precheck_defers_legacy_block_to_gateway(self):
        legacy_result = SimpleNamespace(
            blocked=True,
            layer="balance",
            reason="insufficient_credits",
        )
        with patch(
            "apps.services.billing.services.billing_precheck.billing_precheck",
            return_value=legacy_result,
        ), patch(
            "apps.services.billing.services.gateway.BillingGateway.precheck_llm_usage",
            return_value={"allowed": True},
        ) as mock_gateway:
            check_billing(
                organization_id=fake_org_id("wt_1"),
                user_id="user_1",
                scene_key="title_generation",
                capability_domain="chat",
                estimated_tokens=100,
                model_id="model_with_provider_credit",
                context={"request_id": "req_1"},
            )

        mock_gateway.assert_called_once()

    def test_gateway_precheck_exception_fails_closed(self):
        legacy_result = SimpleNamespace(blocked=False)
        with patch(
            "apps.services.billing.services.billing_precheck.billing_precheck",
            return_value=legacy_result,
        ), patch(
            "apps.services.billing.services.gateway.BillingGateway.precheck_llm_usage",
            side_effect=RuntimeError("pricing unavailable"),
        ):
            with self.assertRaises(BudgetExceeded):
                check_billing(
                    organization_id=fake_org_id("wt_1"),
                    user_id="user_1",
                    scene_key="_main_chat",
                    capability_domain="chat",
                    estimated_tokens=100,
                    model_id="model_1",
                    context={"request_id": "req_1"},
                )
