from decimal import Decimal

from django.test import TestCase

from apps.services.billing.models import BillingUsageEvent
from apps.users.auth.models import User
from apps.users.wallet.models import WalletTransaction, OrganizationWallet
from apps.users.wallet.services.credits_service import CreditsService
from apps.users.wallet.services.organization_wallet_service import OrganizationWalletService


class WalletPrecisionBillingTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.user = User.objects.create_user(
            email="wallet_precision@test.com",
            password="test-pass-123",
        )

    def _create_team_wallet(self, name: str, balance: Decimal):
        from apps.tabtinspace.models import Organization

        organization_id = str(Organization.objects.create(
            name=name,
            owner_id=self.user.id,
            type=Organization.OrganizationType.TEAM,
        ).id)
        wallet = OrganizationWallet.objects.create(
            organization_id=organization_id,
            credits=int(balance),
            credits_precise=balance,
        )
        return organization_id, wallet

    def test_wallet_service_supports_decimal_balance(self):
        service = OrganizationWalletService()
        from apps.tabtinspace.models import Organization
        organization_id = str(Organization.objects.create(
            name="precision-decimal-org",
            owner_id=self.user.id,
            type=Organization.OrganizationType.TEAM,
        ).id)
        service.recharge(organization_id, Decimal("10"))
        service.consume(organization_id, Decimal("0.125"), description="小数扣费")

        wallet = OrganizationWallet.objects.get(organization_id=organization_id)
        self.assertEqual(wallet.credits_precise, Decimal("9.8750"))
        self.assertEqual(wallet.credits, 9)

        tx = WalletTransaction.objects.filter(organization_wallet=wallet, transaction_type="consume").latest("created_at")
        self.assertEqual(tx.amount_precise, Decimal("-0.1250"))
        self.assertEqual(tx.balance_after_precise, Decimal("9.8750"))

    def test_llm_consume_records_organization_usage_event(self):
        from apps.tabtinspace.models import Organization
        org_id = str(Organization.objects.create(
            name="precision-llm-org",
            owner_id=self.user.id,
            type=Organization.OrganizationType.TEAM,
        ).id)
        OrganizationWallet.objects.create(
            organization_id=org_id,
            credits=100,
            credits_precise=Decimal("100.0000"),
        )

        result = CreditsService.consume_credits_for_llm(
            self.user,
            input_tokens=500,
            output_tokens=500,
            model_config={
                "provider_key": "openai",
                "model_name": "gpt-4o-mini",
                "input_price_per_1k": "0.003",
                "output_price_per_1k": "0.015",
            },
            organization_id=org_id,
            biz_id="llm_req_001",
        )

        ws = OrganizationWallet.objects.get(organization_id=org_id)
        self.assertEqual(ws.credits_precise, Decimal("99.1000"))
        self.assertEqual(result["credits_consumed_precise"], Decimal("0.9000"))
        self.assertEqual(result["credits_remaining_precise"], Decimal("99.1000"))
        self.assertEqual(result["credits_remaining_source"], "organization_wallet")

        usage = BillingUsageEvent.objects.get(organization_id=org_id, biz_id="llm_req_001")
        self.assertEqual(usage.amount, Decimal("0.9000"))
        self.assertEqual(usage.meter_key, "llm.tokens")

    def test_llm_settlement_can_spend_its_own_frozen_credits(self):
        from apps.tabtinspace.models import Organization

        org_id = str(Organization.objects.create(
            name="precision-frozen-settlement-org",
            owner_id=self.user.id,
            type=Organization.OrganizationType.TEAM,
        ).id)
        OrganizationWallet.objects.create(
            organization_id=org_id,
            credits=0,
            credits_precise=Decimal("0.9000"),
        )
        freeze_id = "freeze:precision:settlement"
        self.assertTrue(
            CreditsService.freeze_credits_for_llm(
                org_id,
                Decimal("0.9000"),
                freeze_id,
            )
        )

        result = CreditsService.consume_credits_for_llm(
            self.user,
            input_tokens=500,
            output_tokens=500,
            model_config={
                "provider_key": "openai",
                "model_name": "gpt-4o-mini",
                "input_price_per_1k": "0.003",
                "output_price_per_1k": "0.015",
            },
            organization_id=org_id,
            biz_id="llm_frozen_req_001",
            idempotency_key="llm_frozen_req_001",
            billing_metadata={"freeze_id": freeze_id},
        )

        wallet = OrganizationWallet.objects.get(organization_id=org_id)
        self.assertEqual(result["credits_consumed_precise"], Decimal("0.9000"))
        self.assertEqual(wallet.credits_precise, Decimal("0.0000"))
        self.assertEqual(wallet.credits_frozen_precise, Decimal("0.0000"))
        self.assertTrue(
            WalletTransaction.objects.filter(
                organization_wallet=wallet,
                transaction_type="unfreeze",
                reference_key=freeze_id,
            ).exists()
        )
        settle_result = CreditsService.settle_frozen_credits(
            org_id,
            freeze_id,
            Decimal("0.9000"),
        )
        self.assertEqual(settle_result["reason"], "already_settled")
        self.assertEqual(
            WalletTransaction.objects.filter(
                organization_wallet=wallet,
                transaction_type="unfreeze",
                reference_key=freeze_id,
            ).count(),
            1,
        )

    def test_llm_settlement_uses_available_balance_beyond_its_reservation(self):
        org_id, wallet = self._create_team_wallet(
            "precision-underestimated-freeze-org",
            Decimal("1.2000"),
        )
        freeze_id = "freeze:precision:underestimated"
        self.assertTrue(
            CreditsService.freeze_credits_for_llm(
                org_id,
                Decimal("0.5000"),
                freeze_id,
            )
        )

        result = CreditsService._deduct_from_organization_wallet(
            org_id,
            Decimal("0.9000"),
            Decimal("0.9000"),
            Decimal("0.0000"),
            500,
            500,
            operator_user_id=str(self.user.id),
            billing_metadata={"freeze_id": freeze_id},
        )

        self.assertIsNotNone(result)
        wallet.refresh_from_db()
        self.assertEqual(wallet.credits_precise, Decimal("0.3000"))
        self.assertEqual(wallet.credits_frozen_precise, Decimal("0.0000"))

    def test_llm_settlement_preserves_other_request_reservations(self):
        org_id, wallet = self._create_team_wallet(
            "precision-concurrent-freeze-org",
            Decimal("2.0000"),
        )
        current_freeze_id = "freeze:precision:current"
        other_freeze_id = "freeze:precision:other"
        self.assertTrue(
            CreditsService.freeze_credits_for_llm(
                org_id,
                Decimal("1.2000"),
                current_freeze_id,
            )
        )
        self.assertTrue(
            CreditsService.freeze_credits_for_llm(
                org_id,
                Decimal("0.5000"),
                other_freeze_id,
            )
        )

        result = CreditsService._deduct_from_organization_wallet(
            org_id,
            Decimal("0.9000"),
            Decimal("0.9000"),
            Decimal("0.0000"),
            500,
            500,
            operator_user_id=str(self.user.id),
            billing_metadata={"freeze_id": current_freeze_id},
        )

        self.assertIsNotNone(result)
        wallet.refresh_from_db()
        self.assertEqual(wallet.credits_precise, Decimal("1.1000"))
        self.assertEqual(wallet.credits_frozen_precise, Decimal("0.5000"))
        self.assertFalse(
            WalletTransaction.objects.filter(
                organization_wallet=wallet,
                transaction_type="unfreeze",
                reference_key=other_freeze_id,
            ).exists()
        )
