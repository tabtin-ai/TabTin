"""
财务 P0 回归测试 — 支付模块（FIN-1, FIN-2）
"""

from datetime import timedelta
from decimal import Decimal
from unittest.mock import patch, MagicMock

from django.test import TestCase
from django.utils import timezone

from apps.services.payment.models import PaymentOrder
from apps.users.auth.models import User


class FIN1CheckPendingOrdersTests(TestCase):
    """FIN-1: check_pending_orders 的 select_for_update 必须在 transaction.atomic 内。"""

    databases = {"default", "postgresql"}

    def setUp(self):
        self.user = User.objects.create_user(
            email="fin1_test@test.com",
            password="test-pass-123",
        )

    @patch("apps.services.payment.tasks.PaymentServiceFactory")
    def test_check_pending_orders_does_not_raise_transaction_error(self, mock_factory):
        """验证 select_for_update 在事务中执行，不会抛 TransactionManagementError。"""
        mock_svc = MagicMock()
        mock_factory.get_service.return_value = mock_svc

        PaymentOrder.objects.create(
            user=self.user,
            order_type="credits",
            subject="测试",
            description="",
            amount=Decimal("10.00"),
            payment_method="alipay",
            status="pending",
            expired_at=timezone.now() - timedelta(minutes=5),
        )

        from apps.services.payment.tasks import check_pending_orders
        result = check_pending_orders()

        self.assertEqual(result, 1)
        order = PaymentOrder.objects.first()
        self.assertEqual(order.status, "cancelled")

    @patch("apps.services.payment.tasks._try_acquire_lock", return_value=False)
    def test_check_pending_orders_skips_when_lock_held(self, _lock_mock):
        from apps.services.payment.tasks import check_pending_orders

        result = check_pending_orders()

        self.assertEqual(result, {"skipped": True, "reason": "lock_held"})
