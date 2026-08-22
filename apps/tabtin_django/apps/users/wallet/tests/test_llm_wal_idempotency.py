from decimal import Decimal
from unittest.mock import patch

from django.test import TestCase

from apps.services.billing.models import BillingUsageEvent
from apps.users.wallet.services.credits_service import CreditsService


class LlmWalIdempotencyTests(TestCase):
    def test_zero_token_call_does_not_create_pending_placeholder(self):
        result = CreditsService.consume_credits_for_llm(
            user="user-1",
            input_tokens=0,
            output_tokens=0,
            model_config={"organization_id": "00000000-0000-0000-0000-000000000001"},
            idempotency_key="llm-zero-token",
        )

        self.assertEqual(result["credits_consumed_precise"], Decimal("0.0000"))
        self.assertFalse(
            BillingUsageEvent.objects.filter(idempotency_key="llm-zero-token").exists()
        )

    def test_missing_organization_does_not_create_pending_placeholder(self):
        result = CreditsService.consume_credits_for_llm(
            user="user-1",
            input_tokens=10,
            output_tokens=5,
            model_config={},
            idempotency_key="llm-missing-org",
        )

        self.assertEqual(result["reason"], "missing_organization_id")
        self.assertFalse(
            BillingUsageEvent.objects.filter(idempotency_key="llm-missing-org").exists()
        )

    def test_pending_placeholder_is_adopted_instead_of_idempotent_hit(self):
        BillingUsageEvent.objects.create(
            meter_key="llm.tokens",
            quantity=Decimal("0"),
            unit="tokens",
            unit_price=Decimal("0"),
            amount=Decimal("0"),
            currency="CREDITS",
            idempotency_key="llm-pending",
            metadata={"status": "pending_deduction"},
        )

        with patch.object(
            CreditsService,
            "_compute_llm_credits_cost",
            return_value={
                "credits_cost": Decimal("1.0000"),
                "input_price": Decimal("0.0100"),
                "output_price": Decimal("0.0100"),
                "total_cost": Decimal("0.0100"),
                "credits_rate": "1",
                "provider_key": "test",
                "model_name": "test-model",
            },
        ), patch.object(
            CreditsService,
            "_apply_organization_budget",
            return_value={
                "quota_covered_credits": Decimal("1.0000"),
                "credits_to_deduct": Decimal("0.0000"),
                "overflow_credits": Decimal("0.0000"),
                "quota_remaining": Decimal("9.0000"),
                "used_quota": True,
                "llm_billing_mode": "quota_only",
            },
        ), patch.object(CreditsService, "_record_billing_usage") as mock_record:
            result = CreditsService.consume_credits_for_llm(
                user="user-1",
                input_tokens=10,
                output_tokens=5,
                model_config={"organization_id": "00000000-0000-0000-0000-000000000001"},
                idempotency_key="llm-pending",
            )

        self.assertNotEqual(result.get("reason"), "idempotent_hit")
        self.assertTrue(result["used_quota"])
        mock_record.assert_called_once()
        self.assertTrue(mock_record.call_args.kwargs["billing_event_pre_created"])

    def test_charged_placeholder_is_treated_as_already_settled(self):
        BillingUsageEvent.objects.create(
            meter_key="llm.tokens",
            quantity=Decimal("15"),
            unit="tokens",
            unit_price=Decimal("0.0100"),
            amount=Decimal("0.1500"),
            currency="CREDITS",
            biz_type="llm_call",
            idempotency_key="llm-charged",
            metadata={"status": "charged", "raw_credits_cost": "0.1500"},
        )

        with patch.object(CreditsService, "_compute_llm_credits_cost") as mock_compute:
            result = CreditsService.consume_credits_for_llm(
                user="user-1",
                input_tokens=10,
                output_tokens=5,
                model_config={"organization_id": "00000000-0000-0000-0000-000000000001"},
                idempotency_key="llm-charged",
            )

        self.assertEqual(result["reason"], "already_settled")
        mock_compute.assert_not_called()
