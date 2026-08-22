from __future__ import annotations

import uuid
from decimal import Decimal

from django.core.exceptions import ValidationError
from django.test import TestCase

from apps.services.billing.models import (
    ProviderCreditCampaign,
    ProviderCreditGrant,
    ProviderCreditTransaction,
)
from apps.services.billing.services.provider_credit_service import (
    ProviderCreditService,
    matches_provider_credit,
)
from apps.services.billing.tests.org_test_utils import org_id_for


class ProviderCreditServiceTests(TestCase):
    databases = {"default"}

    def setUp(self):
        self.organization_id = org_id_for("provider_credit_service")
        self.doubao_model_id = str(uuid.uuid4())
        self.other_model_id = str(uuid.uuid4())

    def _create_campaign(self, *, code: str = "DOUBAO_2026_SUMMER", **overrides):
        defaults = {
            "code": code,
            "name": "豆包 2026 夏季活动",
            "provider_key": " VolcEngine ",
            "eligible_model_ids": [self.doubao_model_id],
            "credits_amount": Decimal("10000.00000000"),
            "total_budget_credits": Decimal("50000.00000000"),
        }
        defaults.update(overrides)
        return ProviderCreditService.create_campaign(**defaults)

    def test_create_campaign_normalizes_provider_key(self):
        campaign = self._create_campaign()

        self.assertEqual(campaign.provider_key, "volcengine")
        self.assertEqual(campaign.eligible_model_ids, [self.doubao_model_id])
        self.assertEqual(campaign.granted_credits, Decimal("0"))

    def test_campaign_code_is_unique(self):
        self._create_campaign(code="UNIQUE_PROVIDER_CAMPAIGN")

        with self.assertRaises(ValidationError):
            self._create_campaign(code="UNIQUE_PROVIDER_CAMPAIGN")

        self.assertEqual(
            ProviderCreditCampaign.objects.filter(
                code="UNIQUE_PROVIDER_CAMPAIGN"
            ).count(),
            1,
        )

    def test_campaign_rejects_display_name_as_model_identity(self):
        with self.assertRaises(ValidationError):
            self._create_campaign(
                code="INVALID_MODEL_ID",
                eligible_model_ids=["doubao-pro-display-name"],
            )

    def test_grant_credit_is_idempotent_by_organization_and_campaign(self):
        campaign = self._create_campaign()

        first = ProviderCreditService.grant_credit(
            organization=self.organization_id,
            campaign=campaign,
        )
        second = ProviderCreditService.grant_credit(
            organization=self.organization_id,
            campaign=campaign,
        )

        self.assertEqual(first.id, second.id)
        self.assertEqual(
            ProviderCreditGrant.objects.filter(
                organization_id=self.organization_id,
                campaign=campaign,
            ).count(),
            1,
        )
        self.assertEqual(
            ProviderCreditTransaction.objects.filter(
                grant=first,
                transaction_type=ProviderCreditTransaction.TransactionType.GRANT,
            ).count(),
            1,
        )
        campaign.refresh_from_db()
        self.assertEqual(campaign.granted_credits, Decimal("10000"))

    def test_matches_provider_then_model_uuid(self):
        campaign = self._create_campaign()
        grant = ProviderCreditService.grant_credit(
            organization=self.organization_id,
            campaign=campaign,
        )

        self.assertTrue(
            matches_provider_credit(
                grant,
                provider_key="volcengine",
                model_id=self.doubao_model_id,
            )
        )
        self.assertFalse(
            matches_provider_credit(
                grant,
                provider_key="moonshot",
                model_id=self.doubao_model_id,
            )
        )
        self.assertFalse(
            matches_provider_credit(
                grant,
                provider_key="volcengine",
                model_id=self.other_model_id,
            )
        )

    def test_empty_model_list_matches_all_models_for_same_provider(self):
        campaign = self._create_campaign(
            code="DOUBAO_ALL_MODELS",
            eligible_model_ids=[],
        )
        grant = ProviderCreditService.grant_credit(
            organization=self.organization_id,
            campaign=campaign,
        )

        self.assertTrue(
            matches_provider_credit(grant, "volcengine", self.other_model_id)
        )
        self.assertFalse(
            matches_provider_credit(grant, "deepseek", self.other_model_id)
        )

    def test_get_available_credit_only_sums_matching_grants(self):
        matching = self._create_campaign(code="DOUBAO_MATCHING")
        other_provider = self._create_campaign(
            code="QWEN_OTHER_PROVIDER",
            provider_key="dashscope",
            eligible_model_ids=[],
            credits_amount=Decimal("5000"),
            total_budget_credits=Decimal("5000"),
        )
        ProviderCreditService.grant_credit(
            organization=self.organization_id,
            campaign=matching,
        )
        ProviderCreditService.grant_credit(
            organization=self.organization_id,
            campaign=other_provider,
        )

        self.assertEqual(
            ProviderCreditService.get_available_credit(
                organization=self.organization_id,
                provider_key="VOLCENGINE",
                model_id=self.doubao_model_id,
            ),
            Decimal("10000"),
        )
        self.assertEqual(
            ProviderCreditService.get_available_credit(
                organization=self.organization_id,
                provider_key="volcengine",
                model_id=self.other_model_id,
            ),
            Decimal("0"),
        )

    def test_grant_and_consume_transactions_are_idempotent(self):
        campaign = self._create_campaign()
        grant = ProviderCreditService.grant_credit(
            organization=self.organization_id,
            campaign=campaign,
        )
        grant_tx = ProviderCreditTransaction.objects.get(
            grant=grant,
            transaction_type=ProviderCreditTransaction.TransactionType.GRANT,
        )
        self.assertEqual(grant_tx.amount, Decimal("10000"))
        self.assertEqual(grant_tx.balance_after, Decimal("10000"))

        first = ProviderCreditService.record_transaction(
            grant=grant,
            transaction_type=ProviderCreditTransaction.TransactionType.CONSUME,
            amount=Decimal("-125.50000000"),
            idempotency_key="provider-credit-consume:test-usage-1",
            reference_type="billing_usage_event",
            reference_id="usage-1",
        )
        replay = ProviderCreditService.record_transaction(
            grant=grant,
            transaction_type=ProviderCreditTransaction.TransactionType.CONSUME,
            amount=Decimal("-125.50000000"),
            idempotency_key="provider-credit-consume:test-usage-1",
            reference_type="billing_usage_event",
            reference_id="usage-1",
        )

        self.assertEqual(first.id, replay.id)
        grant.refresh_from_db()
        self.assertEqual(grant.consumed_credits, Decimal("125.5"))
        self.assertEqual(grant.remaining_credits, Decimal("9874.5"))
        self.assertEqual(
            ProviderCreditTransaction.objects.filter(grant=grant).count(),
            2,
        )

    def test_idempotency_key_cannot_be_reused_for_different_ledger_entry(self):
        campaign = self._create_campaign()
        grant = ProviderCreditService.grant_credit(
            organization=self.organization_id,
            campaign=campaign,
        )
        ProviderCreditService.record_transaction(
            grant=grant,
            transaction_type=ProviderCreditTransaction.TransactionType.CONSUME,
            amount=Decimal("-10"),
            idempotency_key="provider-credit-consume:conflict",
        )

        with self.assertRaises(ValidationError):
            ProviderCreditService.record_transaction(
                grant=grant,
                transaction_type=ProviderCreditTransaction.TransactionType.CONSUME,
                amount=Decimal("-11"),
                idempotency_key="provider-credit-consume:conflict",
            )

        grant.refresh_from_db()
        self.assertEqual(grant.remaining_credits, Decimal("9990"))

    def test_consume_cannot_make_grant_balance_negative(self):
        campaign = self._create_campaign()
        grant = ProviderCreditService.grant_credit(
            organization=self.organization_id,
            campaign=campaign,
        )

        with self.assertRaises(ValidationError):
            ProviderCreditService.record_transaction(
                grant=grant,
                transaction_type=ProviderCreditTransaction.TransactionType.CONSUME,
                amount=Decimal("-10000.00000001"),
                idempotency_key="provider-credit-consume:overdraft",
            )

        grant.refresh_from_db()
        self.assertEqual(grant.remaining_credits, Decimal("10000"))
        self.assertEqual(ProviderCreditTransaction.objects.filter(grant=grant).count(), 1)
