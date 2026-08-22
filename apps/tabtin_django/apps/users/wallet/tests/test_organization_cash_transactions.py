"""组织现金钱包流水（账单中心「现金钱包」子视图数据源）测试。

覆盖：分页 + 倒序 + 团队维度隔离、类型过滤、序列化口径（金额正负号保留、
不外显操作人、metadata 原样带出供前端展示买到的点券数）、
充值成功后 cash_recharged 业务事件 + 统一账户通知适配器（含幂等跳过）。
不走 HTTP（避开 JWT / 权限 mock），直接测 service 分页逻辑 + 序列化纯函数。
"""

from decimal import Decimal
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase, TestCase

from apps.users.wallet.services.organization_cash_wallet_service import (
    DuplicateCashTransactionOrder,
    OrganizationCashWalletService,
    serialize_cash_transaction,
)

ORG = "org_cash_tx_001"
OTHER = "org_cash_tx_other"


class OrganizationCashTransactionHistoryTests(TestCase):
    databases = {"default"}

    def setUp(self):
        self.svc = OrganizationCashWalletService()

    def test_history_paginated_desc_and_team_scoped(self):
        self.svc.recharge(organization_id=ORG, amount_cny=Decimal("10.00"), description="充值A")
        self.svc.spend(
            organization_id=ORG,
            amount_cny=Decimal("1.00"),
            transaction_type="llm_auto_topup",
            description="LLM 点券自动补充（2026-07）",
            metadata={"credits": "100.0000"},
        )
        # 另一个组织的流水不应混入
        self.svc.recharge(organization_id=OTHER, amount_cny=Decimal("5.00"), description="别的组织")

        page1 = self.svc.get_transaction_history(ORG, limit=1, offset=0)
        self.assertEqual(page1["total"], 2)
        self.assertEqual(len(page1["transactions"]), 1)
        # 倒序：最新一条是自动补充
        self.assertEqual(page1["transactions"][0]["transaction_type"], "llm_auto_topup")

        page2 = self.svc.get_transaction_history(ORG, limit=1, offset=1)
        self.assertEqual(len(page2["transactions"]), 1)
        self.assertEqual(page2["transactions"][0]["transaction_type"], "recharge")

    def test_filter_by_transaction_type(self):
        self.svc.recharge(organization_id=ORG, amount_cny=Decimal("10.00"))
        self.svc.spend(
            organization_id=ORG,
            amount_cny=Decimal("1.00"),
            transaction_type="llm_auto_topup",
            description="自动补充",
        )
        res = self.svc.get_transaction_history(ORG, transaction_type="llm_auto_topup")
        self.assertEqual(res["total"], 1)
        self.assertEqual(res["transactions"][0]["transaction_type"], "llm_auto_topup")

    def test_serialize_spend_negative_sign_hides_operator(self):
        self.svc.recharge(organization_id=ORG, amount_cny=Decimal("10.00"))
        tx = self.svc.spend(
            organization_id=ORG,
            amount_cny=Decimal("1.00"),
            transaction_type="llm_auto_topup",
            description="LLM 点券自动补充（2026-07）",
            operator_user_id="operator_should_not_leak",
            metadata={"credits": "100.0000"},
        )
        data = serialize_cash_transaction(tx)
        # 现金支出记负值，前端据此展示 -¥
        self.assertEqual(data["amount_cny"], "-1.00")
        # 操作人属审计信息，用户侧不外显
        self.assertNotIn("operator_user_id", data)
        # metadata 原样带出，供前端展示「买到的点券数」
        self.assertEqual(data["metadata"]["credits"], "100.0000")
        self.assertEqual(data["description"], "LLM 点券自动补充（2026-07）")

    def test_serialize_recharge_positive_sign(self):
        tx = self.svc.recharge(organization_id=ORG, amount_cny=Decimal("10.00"), description="充值")
        data = serialize_cash_transaction(tx)
        self.assertEqual(data["amount_cny"], "10.00")
        self.assertEqual(data["transaction_type"], "recharge")


class OrganizationCashWalletDuplicateOrderTests(SimpleTestCase):
    def test_recharge_can_reject_an_existing_order_for_manual_admin_actions(self):
        with patch(
            "apps.users.wallet.services.organization_cash_wallet_service."
            "CashWalletTransaction.objects.filter"
        ) as mock_filter:
            mock_filter.return_value.first.return_value = MagicMock()

            with self.assertRaises(DuplicateCashTransactionOrder):
                OrganizationCashWalletService.recharge.__wrapped__(
                    OrganizationCashWalletService(),
                    organization_id=ORG,
                    amount_cny=Decimal("10.00"),
                    related_order_id="OPS-CASH-DUPLICATE",
                    reject_duplicate=True,
                )


class OrganizationCashWalletRechargeNotifyTests(SimpleTestCase):
    """现金钱包入账通知契约（不依赖完整 migrate / test DB）。

    入账路径本身由 OrganizationCashTransactionHistoryTests 覆盖；
    此处锁定 WS payload、统一适配器边界与事件类型白名单。
    """

    @patch(
        "apps.services.notification.services.notification_service.NotificationService.notify",
    )
    @patch("apps.services.billing.ws_events.publish_billing_event")
    def test_try_notify_publishes_ws_and_delegates_bell_to_account_adapter(
        self,
        mock_publish,
        mock_notify,
    ):
        OrganizationCashWalletService._try_notify_cash_recharged(
            ORG,
            Decimal("128.50"),
            "OPS-CASH-NOTIFY-1",
        )
        mock_publish.assert_called_once_with(
            ORG,
            "cash_recharged",
            {
                "amount_cny": "128.50",
                "order_id": "OPS-CASH-NOTIFY-1",
            },
        )
        # 持久铃铛由 publish_billing_event 内的统一账户适配器负责，钱包服务不再双写。
        mock_notify.assert_not_called()

    @patch(
        "apps.services.notification.services.notification_service.NotificationService.notify",
    )
    @patch("apps.services.billing.ws_events.publish_billing_event")
    def test_try_notify_skips_empty_organization(self, mock_publish, mock_notify):
        OrganizationCashWalletService._try_notify_cash_recharged(
            "",
            Decimal("1.00"),
            "OPS-EMPTY",
        )
        mock_publish.assert_not_called()
        mock_notify.assert_not_called()

    @patch(
        "apps.services.notification.services.notification_service.NotificationService.notify",
    )
    @patch("apps.services.billing.ws_events.publish_billing_event")
    def test_try_notify_does_not_directly_write_bell(
        self,
        mock_publish,
        mock_notify,
    ):
        OrganizationCashWalletService._try_notify_cash_recharged(
            ORG,
            Decimal("1.00"),
            "OPS-NO-ADMIN",
        )
        mock_publish.assert_called_once()
        mock_notify.assert_not_called()

    def test_cash_recharged_is_valid_billing_event_type(self):
        from apps.services.billing.ws_events import VALID_EVENT_TYPES

        self.assertIn("cash_recharged", VALID_EVENT_TYPES)

    def test_cash_recharged_is_valid_notification_type(self):
        from apps.services.notification.models import Notification

        self.assertIn(
            ("cash_recharged", "现金钱包充值到账"),
            Notification.TYPE_CHOICES,
        )

    @patch.object(OrganizationCashWalletService, "_try_notify_cash_recharged")
    @patch(
        "apps.users.wallet.services.organization_cash_wallet_service.transaction.on_commit",
        side_effect=lambda fn: fn(),
    )
    def test_schedule_cash_recharged_notify_runs_callback(self, _on_commit, mock_try):
        OrganizationCashWalletService()._schedule_cash_recharged_notify(
            organization_id=ORG,
            amount_cny=Decimal("10.00"),
            order_id="OPS-SCHED-1",
        )
        mock_try.assert_called_once_with(ORG, Decimal("10.00"), "OPS-SCHED-1")

    @patch.object(OrganizationCashWalletService, "_schedule_cash_recharged_notify")
    @patch(
        "apps.users.wallet.services.organization_cash_wallet_service."
        "CashWalletTransaction.objects.filter",
    )
    def test_idempotent_recharge_early_return_skips_notify_schedule(
        self,
        mock_filter,
        mock_schedule,
    ):
        """同 related_order_id 命中已有流水时早退，不得 schedule 铃铛/WS。"""
        existing = MagicMock(id="tx-existing")
        mock_filter.return_value.first.return_value = existing
        result = OrganizationCashWalletService.recharge.__wrapped__(
            OrganizationCashWalletService(),
            organization_id=ORG,
            amount_cny=Decimal("10.00"),
            description="idem",
            related_order_id="OPS-IDEM-NOTIFY-1",
        )
        self.assertIs(result, existing)
        mock_schedule.assert_not_called()
