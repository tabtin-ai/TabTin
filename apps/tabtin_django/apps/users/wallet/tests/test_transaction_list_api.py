"""组织点券交易流水序列化：FK 收敛后 organization_id 须为 str。

用量中心「交易流水」走 get_transaction_history → TransactionResponse；
#3832 后 Organization.id 为 UUIDField，ORM 读回 organization_id 是 UUID，
直接塞进 Schema 会 ValidationError → API 500「查询交易记录失败」。
"""

from decimal import Decimal
from uuid import UUID

from django.test import TestCase

from apps.users.auth.models import User
from apps.users.wallet.models import WalletTransaction
from apps.users.wallet.schemas import TransactionHistoryResponse, TransactionResponse
from apps.users.wallet.services.organization_wallet_service import OrganizationWalletService


class WalletTransactionListSerializeTests(TestCase):
    databases = {"default"}

    def setUp(self):
        self.user = User.objects.create_user(
            email="wallet_tx_serialize@test.com",
            password="test-pass-123",
        )
        from apps.tabtinspace.models import Organization

        self.organization = Organization.objects.create(
            name="wallet-tx-serialize-org",
            owner_id=self.user.id,
            type=Organization.OrganizationType.TEAM,
        )
        self.organization_id = str(self.organization.id)
        self.service = OrganizationWalletService()
        self.service.recharge(self.organization_id, Decimal("100"), description="序列化充值")

    def test_history_payload_organization_id_is_str_not_uuid(self):
        tx = WalletTransaction.objects.filter(
            organization_wallet__organization_id=self.organization_id
        ).first()
        self.assertIsNotNone(tx)
        self.assertIsInstance(tx.organization_id, UUID)

        history = self.service.get_transaction_history(
            self.organization_id, limit=20, offset=0
        )
        self.assertGreaterEqual(history["total"], 1)
        org_id = history["transactions"][0]["organization_id"]
        self.assertIsInstance(org_id, str)
        self.assertEqual(org_id, self.organization_id)

        # 与 api.get_organization_transactions 同一条组装路径
        TransactionHistoryResponse(
            total=history["total"],
            transactions=[TransactionResponse(**t) for t in history["transactions"]],
        )

    def test_history_payload_tolerates_null_organization(self):
        tx = WalletTransaction.objects.filter(
            organization_wallet__organization_id=self.organization_id
        ).first()
        self.assertIsNotNone(tx)
        WalletTransaction.objects.filter(pk=tx.pk).update(organization=None)

        history = self.service.get_transaction_history(
            self.organization_id, limit=20, offset=0
        )
        self.assertEqual(history["transactions"][0]["organization_id"], "")
        TransactionHistoryResponse(
            total=history["total"],
            transactions=[TransactionResponse(**t) for t in history["transactions"]],
        )
