from decimal import Decimal
from unittest.mock import patch

from django.test import Client, TestCase

from apps.users.auth.models import User
from apps.users.auth.permissions import JWTAuth
from apps.users.wallet.models import OrganizationWallet
from apps.users.wallet.services.organization_wallet_service import OrganizationWalletService


BASE = "/api/wallet"


def _auth_header() -> dict:
    return {"HTTP_AUTHORIZATION": "Bearer test-token"}


class WalletTransactionExportApiTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.client = Client()
        self.user = User.objects.create_user(
            email="wallet_export@test.com",
            password="test-pass-123",
        )
        from apps.tabtinspace.models import Organization
        self.organization_id = str(Organization.objects.create(
            name="wallet-export-org",
            owner_id=self.user.id,
            type=Organization.OrganizationType.TEAM,
        ).id)
        self.service = OrganizationWalletService()
        self.service.recharge(self.organization_id, Decimal("100"), description="测试充值 A")
        self.service.recharge(self.organization_id, Decimal("50"), description="测试充值 B")
        self.service.consume(self.organization_id, Decimal("10"), description="测试消费")

    def test_export_uses_current_filters_without_pagination(self):
        wallet = OrganizationWallet.objects.get(organization_id=self.organization_id)
        self.assertEqual(wallet.transactions.filter(transaction_type="recharge").count(), 2)

        url = (
            f"{BASE}/organizations/{self.organization_id}/transactions/export"
            "?transaction_type=recharge&search=测试&order_by=created_at"
        )
        with (
            patch.object(JWTAuth, "authenticate", return_value=self.user),
            patch("apps.users.wallet.api.ensure_organization_permission", return_value=None),
        ):
            resp = self.client.get(url, **_auth_header())

        self.assertEqual(resp.status_code, 200)
        content = b"".join(resp.streaming_content).decode("utf-8")
        self.assertIn("测试充值 A", content)
        self.assertIn("测试充值 B", content)
        self.assertNotIn("测试消费", content)
        self.assertEqual(content.count("recharge"), 2)
