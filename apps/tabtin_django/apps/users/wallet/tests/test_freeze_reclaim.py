from datetime import timedelta
from decimal import Decimal

from django.test import TestCase
from django.utils import timezone

from apps.users.wallet.models import WalletTransaction, OrganizationWallet
from apps.users.wallet.services.credits_service import CreditsService
from apps.users.wallet.tasks import reclaim_stale_frozen_credits


class FreezeReclaimTests(TestCase):
    databases = {"default"}

    def setUp(self):
        from apps.tabtinspace.models import Organization
        from apps.users.auth.models import User
        self.owner = User.objects.create_user(
            email="freeze_reclaim_owner@test.com", password="test-pass-123",
        )
        self.organization_id = str(Organization.objects.create(
            name="freeze-reclaim-org",
            owner_id=self.owner.id,
            type=Organization.OrganizationType.TEAM,
        ).id)
        self.wallet = OrganizationWallet.objects.create(
            organization_id=self.organization_id,
            credits=100,
            credits_precise=Decimal("100.0000"),
        )

    def _backdate_freeze(self, freeze_id: str, *, minutes: int = 180) -> None:
        WalletTransaction.objects.filter(
            transaction_type="freeze",
            reference_key=freeze_id,
        ).update(created_at=timezone.now() - timedelta(minutes=minutes))

    def test_reclaim_only_releases_unsettled_stale_freezes(self):
        stale_freeze_id = "freeze:test:stale"
        recent_freeze_id = "freeze:test:recent"
        released_freeze_id = "freeze:test:released"

        self.assertTrue(
            CreditsService.freeze_credits_for_llm(
                self.organization_id,
                Decimal("10.0000"),
                stale_freeze_id,
            )
        )
        self.assertTrue(
            CreditsService.freeze_credits_for_llm(
                self.organization_id,
                Decimal("5.0000"),
                recent_freeze_id,
            )
        )
        self.assertTrue(
            CreditsService.freeze_credits_for_llm(
                self.organization_id,
                Decimal("7.0000"),
                released_freeze_id,
            )
        )
        self.assertTrue(
            CreditsService.release_frozen_credits(
                self.organization_id,
                released_freeze_id,
            )
        )

        self._backdate_freeze(stale_freeze_id)
        self._backdate_freeze(released_freeze_id)

        summary = reclaim_stale_frozen_credits(
            stale_threshold_minutes=60,
            batch_limit=10,
        )

        self.wallet.refresh_from_db()
        self.assertEqual(summary["released"], 1)
        self.assertEqual(summary["errors"], 0)
        self.assertEqual(self.wallet.credits_frozen_precise, Decimal("5.0000"))
        self.assertTrue(
            WalletTransaction.objects.filter(
                transaction_type="unfreeze",
                reference_key=stale_freeze_id,
            ).exists()
        )

        second_summary = reclaim_stale_frozen_credits(
            stale_threshold_minutes=60,
            batch_limit=10,
        )
        self.assertEqual(second_summary["released"], 0)

    def test_reclaim_uses_reference_key_instead_of_description(self):
        freeze_id = "freeze:test:broken-description"
        self.assertTrue(
            CreditsService.freeze_credits_for_llm(
                self.organization_id,
                Decimal("8.0000"),
                freeze_id,
            )
        )
        self._backdate_freeze(freeze_id)
        WalletTransaction.objects.filter(
            transaction_type="freeze",
            reference_key=freeze_id,
        ).update(description="corrupted stale freeze record")

        summary = reclaim_stale_frozen_credits(
            stale_threshold_minutes=60,
            batch_limit=10,
        )

        self.wallet.refresh_from_db()
        self.assertEqual(summary["released"], 1)
        self.assertEqual(self.wallet.credits_frozen_precise, Decimal("0.0000"))
