"""
_sync_order_with_provider 对账函数测试

覆盖三阶段对账的关键场景：
- 支付平台确认未付款 → 不做更新
- 支付平台确认已付款 + 本地未处理 → 加锁更新 + 权益发放
- 本地已被回调处理 → 跳过，不重复更新
- 权益发放降级 → 同步失败后异步投递
"""

from datetime import timedelta
from decimal import Decimal
from unittest.mock import patch, MagicMock

from django.test import TestCase
from django.utils import timezone

from apps.services.payment.models import PaymentOrder
from apps.services.payment.tasks import _sync_order_with_provider
from apps.users.auth.models import User


class SyncOrderWithProviderTests(TestCase):
    """_sync_order_with_provider 三阶段对账测试"""

    databases = {"default"}

    def setUp(self):
        self.user = User.objects.create_user(
            email="sync_order_test@test.com",
            password="test-pass-123",
        )
        self.now = timezone.now()

    def _make_order(self, **overrides):
        defaults = {
            "user": self.user,
            "order_type": "credits",
            "subject": "测试充值",
            "description": "",
            "amount": Decimal("10.00"),
            "payment_method": "alipay",
            "status": "paying",
            "expired_at": self.now + timedelta(minutes=30),
        }
        defaults.update(overrides)
        return PaymentOrder.objects.create(**defaults)

    def _provider_paid_result(self, amount=Decimal("10.00")):
        return {
            "trade_status": "TRADE_SUCCESS",
            "third_party_trade_no": "SYNC_TRADE_001",
            "total_amount": amount,
        }

    # ── 场景 1：支付平台确认未付款 ──

    @patch("apps.services.payment.tasks.PaymentServiceFactory")
    def test_provider_unpaid_returns_unchanged(self, mock_factory):
        """支付平台返回非成功状态，order 不做更新"""
        order = self._make_order(status="paying")

        mock_svc = MagicMock()
        mock_svc.query_order.return_value = {"trade_status": "WAIT_BUYER_PAY"}
        mock_factory.get_service.return_value = mock_svc

        result = _sync_order_with_provider(order)

        self.assertEqual(result.status, "paying")
        order.refresh_from_db()
        self.assertEqual(order.status, "paying")

    @patch("apps.services.payment.tasks.PaymentServiceFactory")
    def test_provider_returns_none_no_update(self, mock_factory):
        """支付平台查询返回 None，order 不做更新"""
        order = self._make_order(status="paying")

        mock_svc = MagicMock()
        mock_svc.query_order.return_value = None
        mock_factory.get_service.return_value = mock_svc

        result = _sync_order_with_provider(order)

        self.assertEqual(result.status, "paying")
        order.refresh_from_db()
        self.assertEqual(order.status, "paying")

    # ── 场景 2：支付平台确认已付款 + 本地未处理 ──

    @patch("apps.services.payment.callbacks.handler.OrderBenefitService")
    @patch("apps.services.payment.callbacks.handler.PaymentServiceFactory")
    @patch("apps.services.payment.tasks.PaymentServiceFactory")
    def test_provider_paid_local_unprocessed_updates_and_grants(
        self, mock_task_factory, mock_handler_factory, mock_benefit,
    ):
        """支付平台确认已付款 + 本地 paying → 加锁更新为 paid + 触发权益发放"""
        order = self._make_order(status="paying")

        mock_svc = MagicMock()
        mock_svc.query_order.return_value = self._provider_paid_result(order.amount)
        mock_task_factory.get_service.return_value = mock_svc
        mock_handler_factory.get_service.return_value = mock_svc
        mock_benefit.grant.return_value = order.id

        _sync_order_with_provider(order)

        order.refresh_from_db()
        self.assertEqual(order.status, "paid")
        self.assertEqual(order.third_party_trade_no, "SYNC_TRADE_001")
        mock_benefit.grant.assert_called_once_with(order.id)

    # ── 场景 3：本地已被回调处理（status=completed）──

    @patch("apps.services.payment.callbacks.handler.PaymentServiceFactory")
    @patch("apps.services.payment.tasks.PaymentServiceFactory")
    def test_local_completed_skips_update(self, mock_task_factory, mock_handler_factory):
        """本地 order 已是 completed，阶段 2 跳过，不重复更新"""
        order = self._make_order(
            status="completed",
            third_party_trade_no="EXISTING_TRADE",
            paid_amount=Decimal("10.00"),
        )
        original_trade_no = order.third_party_trade_no

        mock_svc = MagicMock()
        mock_svc.query_order.return_value = self._provider_paid_result(order.amount)
        mock_task_factory.get_service.return_value = mock_svc
        mock_handler_factory.get_service.return_value = mock_svc

        result = _sync_order_with_provider(order)

        order.refresh_from_db()
        self.assertEqual(order.status, "completed")
        self.assertEqual(order.third_party_trade_no, original_trade_no)

    # ── 场景 4：权益发放降级 ──

    @patch("apps.services.payment.tasks.grant_order_benefits")
    @patch("apps.services.payment.callbacks.handler.OrderBenefitService")
    @patch("apps.services.payment.callbacks.handler.PaymentServiceFactory")
    @patch("apps.services.payment.tasks.PaymentServiceFactory")
    def test_benefit_grant_fallback_to_async(
        self, mock_task_factory, mock_handler_factory, mock_benefit, mock_grant_task,
    ):
        """阶段 3 同步发放失败 → grant_order_benefits.delay 被调用"""
        order = self._make_order(status="paying")

        mock_svc = MagicMock()
        mock_svc.query_order.return_value = self._provider_paid_result(order.amount)
        mock_task_factory.get_service.return_value = mock_svc
        mock_handler_factory.get_service.return_value = mock_svc
        mock_benefit.grant.side_effect = RuntimeError("权益发放异常")

        _sync_order_with_provider(order)

        order.refresh_from_db()
        self.assertEqual(order.status, "paid")
        mock_grant_task.delay.assert_called_once_with(order.id)
