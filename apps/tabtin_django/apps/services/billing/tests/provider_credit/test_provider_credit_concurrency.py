from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
from threading import Barrier

from django.db import close_old_connections
from django.test import TransactionTestCase

from apps.services.billing.models import ProviderCreditGrant, ProviderCreditTransaction
from apps.services.billing.services.provider_credit_service import ProviderCreditService
from apps.services.billing.tests.org_test_utils import org_id_for


class ProviderCreditGrantConcurrencyTests(TransactionTestCase):
    databases = {"default"}
    reset_sequences = False

    def setUp(self):
        self.organization_id = org_id_for("provider_credit_concurrency")
        self.campaign = ProviderCreditService.create_campaign(
            code="DOUBAO_CONCURRENT_GRANT",
            name="豆包并发发放测试",
            provider_key="volcengine",
            eligible_model_ids=[],
            credits_amount=Decimal("10000"),
            total_budget_credits=Decimal("10000"),
        )

    def test_two_threads_only_create_one_grant(self):
        barrier = Barrier(2)

        def _grant():
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                result = ProviderCreditService.grant_credit(
                    organization=self.organization_id,
                    campaign=self.campaign.id,
                )
                return str(result.id)
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda _: _grant(), range(2)))

        self.assertEqual(len(set(results)), 1)
        self.assertEqual(
            ProviderCreditGrant.objects.filter(
                organization_id=self.organization_id,
                campaign=self.campaign,
            ).count(),
            1,
        )
        grant = ProviderCreditGrant.objects.get(
            organization_id=self.organization_id,
            campaign=self.campaign,
        )
        self.assertEqual(
            ProviderCreditTransaction.objects.filter(
                grant=grant,
                transaction_type=ProviderCreditTransaction.TransactionType.GRANT,
            ).count(),
            1,
        )
        self.campaign.refresh_from_db()
        self.assertEqual(self.campaign.granted_credits, Decimal("10000"))
