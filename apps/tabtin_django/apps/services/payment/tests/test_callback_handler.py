"""
PaymentCallbackHandler 回调处理器测试

覆盖第一轮加固中新增的关键防护逻辑：
- 重复回调幂等
- 重复交易号告警
- 金额不匹配拒绝 + 事务外告警
- 已取消订单竞态恢复
- update_fields 精确保存
"""

from datetime import timedelta
from decimal import Decimal
from unittest.mock import patch, MagicMock

from django.test import TestCase
from django.utils import timezone

from apps.services.billing.models import BillingAnomalyAlert
from apps.services.payment.callbacks.handler import PaymentCallbackHandler
from apps.services.payment.exceptions import CallbackProcessError, OrderStatusError
from apps.services.payment.models import PaymentOrder
from apps.users.auth.models import User


class CallbackHandlerTests(TestCase):
    """PaymentCallbackHandler.handle_callback 关键防护逻辑测试"""

    databases = {"default"}

    def setUp(self):
        self.user = User.objects.create_user(
            email="callback_handler_test@test.com",
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
            "status": "pending",
            "expired_at": self.now + timedelta(minutes=30),
        }
        defaults.update(overrides)
        return PaymentOrder.objects.create(**defaults)

    def _parsed_data(self, order, **overrides):
        data = {
            "order_no": order.order_no,
            "third_party_trade_no": "TRADE_001",
            "paid_amount": order.amount,
            "trade_status": "TRADE_SUCCESS",
            "paid_at": self.now,
        }
        data.update(overrides)
        return data

    def _setup_mock_service(self, mock_factory, order, **parse_overrides):
        mock_svc = MagicMock()
        mock_svc.verify_callback.return_value = True
        mock_svc.parse_callback.return_value = self._parsed_data(order, **parse_overrides)
        mock_factory.get_service.return_value = mock_svc
        return mock_svc

    # ── 场景 1：重复回调幂等 ──

    @patch("apps.services.payment.callbacks.handler.OrderBenefitService")
    @patch("apps.services.payment.callbacks.handler.PaymentServiceFactory")
    def test_already_paid_retries_benefit_grant(self, mock_factory, mock_benefit):
        """order.status=paid（未 completed）时返回 already_paid，并补发一次权益（grant 自身幂等）"""
        order = self._make_order(
            status="paid",
            third_party_trade_no="TRADE_001",
            paid_amount=Decimal("10.00"),
        )
        self._setup_mock_service(mock_factory, order)
        mock_benefit.grant.return_value = order.id
        handler = PaymentCallbackHandler("alipay")

        result = handler.handle_callback({"raw": "data"})

        self.assertEqual(result["status"], "already_paid")
        self.assertEqual(result["order"].id, order.id)
        mock_benefit.grant.assert_called_once_with(order.id)

    @patch("apps.services.payment.callbacks.handler.OrderBenefitService")
    @patch("apps.services.payment.callbacks.handler.PaymentServiceFactory")
    def test_already_paid_grant_failure_dispatches_compensation_and_alert(
        self,
        mock_factory,
        mock_benefit,
    ):
        """already_paid 补发失败时同样投递补偿；补偿投递失败则告警"""
        order = self._make_order(
            status="paid",
            third_party_trade_no="TRADE_001",
            paid_amount=Decimal("10.00"),
        )
        self._setup_mock_service(mock_factory, order)
        handler = PaymentCallbackHandler("alipay")

        with patch(
            "apps.services.payment.tasks.grant_order_benefits"
        ) as mock_grant_task, patch(
            "apps.services.billing.tasks._dispatch_billing_alert"
        ) as mock_alert:
            mock_benefit.grant.side_effect = RuntimeError("service down")
            mock_grant_task.delay.side_effect = ConnectionError("Redis unavailable")

            result = handler.handle_callback({"raw": "data"})

        self.assertEqual(result["status"], "already_paid")
        mock_grant_task.delay.assert_called_once_with(order.id)
        mock_alert.assert_called_once()
        self.assertEqual(mock_alert.call_args[0][0], "benefit_queue_failure")
        self.assertEqual(mock_alert.call_args[0][1], "critical")
        self.assertIn(str(order.id), mock_alert.call_args[0][2])

    @patch("apps.services.payment.callbacks.handler.OrderBenefitService")
    @patch("apps.services.payment.callbacks.handler.PaymentServiceFactory")
    def test_already_completed_returns_idempotent(self, mock_factory, mock_benefit):
        """order.status=completed 时返回 already_paid 且不再发放权益"""
        order = self._make_order(
            status="completed",
            third_party_trade_no="TRADE_001",
            paid_amount=Decimal("10.00"),
        )
        self._setup_mock_service(mock_factory, order)
        handler = PaymentCallbackHandler("alipay")

        result = handler.handle_callback({"raw": "data"})

        self.assertEqual(result["status"], "already_paid")
        mock_benefit.grant.assert_not_called()

    # ── 场景 2：重复交易号告警 ──

    @patch("apps.services.payment.callbacks.handler.PaymentServiceFactory")
    def test_duplicate_trade_no_creates_billing_alert(self, mock_factory):
        """already_paid 路径中 third_party_trade_no 不同时创建 BillingAnomalyAlert"""
        order = self._make_order(
            status="paid",
            third_party_trade_no="TRADE_ORIGINAL",
            paid_amount=Decimal("10.00"),
        )
        self._setup_mock_service(
            mock_factory, order, third_party_trade_no="TRADE_DIFFERENT",
        )
        handler = PaymentCallbackHandler("alipay")

        result = handler.handle_callback({"raw": "data"})

        self.assertEqual(result["status"], "already_paid")
        alert = BillingAnomalyAlert.objects.filter(
            metric_name="duplicate_trade_no",
        ).first()
        self.assertIsNotNone(alert, "应创建 duplicate_trade_no 告警")
        self.assertEqual(alert.severity, "critical")
        self.assertEqual(alert.alert_type, "charge_failed")
        self.assertIn("TRADE_ORIGINAL", alert.message)
        self.assertIn("TRADE_DIFFERENT", alert.message)

    # ── 场景 3：金额不匹配拒绝 ──

    @patch("apps.services.payment.callbacks.handler.PaymentServiceFactory")
    def test_amount_mismatch_raises_callback_error(self, mock_factory):
        """实付金额与订单金额差 > 0.01 时 raise CallbackProcessError"""
        order = self._make_order(amount=Decimal("10.00"))
        self._setup_mock_service(mock_factory, order, paid_amount=Decimal("15.00"))
        handler = PaymentCallbackHandler("alipay")

        with self.assertRaises(CallbackProcessError):
            handler.handle_callback({"raw": "data"})

    @patch("apps.services.payment.callbacks.handler.PaymentServiceFactory")
    def test_amount_mismatch_error_has_structured_attrs(self, mock_factory):
        """OrderStatusError 携带 paid_amount / order_amount / order_no 结构化属性"""
        order = self._make_order(amount=Decimal("10.00"))
        mock_factory.get_service.return_value = MagicMock()
        handler = PaymentCallbackHandler("alipay")
        parsed = self._parsed_data(order, paid_amount=Decimal("15.00"))

        with self.assertRaises(OrderStatusError) as ctx:
            handler._update_order_status(order, parsed)

        exc = ctx.exception
        self.assertEqual(exc.paid_amount, Decimal("15.00"))
        self.assertEqual(exc.order_amount, Decimal("10.00"))
        self.assertEqual(exc.order_no, order.order_no)

    # ── 场景 4：金额不匹配事务外告警 ──

    @patch("apps.services.payment.callbacks.handler.PaymentServiceFactory")
    def test_amount_mismatch_creates_alert_outside_transaction(self, mock_factory):
        """金额不匹配后在 except 块中创建 payment_amount_mismatch 告警"""
        order = self._make_order(amount=Decimal("10.00"))
        self._setup_mock_service(mock_factory, order, paid_amount=Decimal("15.00"))
        handler = PaymentCallbackHandler("alipay")

        with self.assertRaises(CallbackProcessError):
            handler.handle_callback({"raw": "data"})

        alert = BillingAnomalyAlert.objects.filter(
            metric_name="payment_amount_mismatch",
        ).first()
        self.assertIsNotNone(alert, "应创建 payment_amount_mismatch 告警")
        self.assertEqual(alert.severity, "critical")
        self.assertEqual(alert.current_value, Decimal("15.00"))
        self.assertEqual(alert.baseline_value, Decimal("10.00"))

    # ── 场景 5：已取消订单竞态恢复 ──

    @patch("apps.services.payment.callbacks.handler.OrderBenefitService")
    @patch("apps.services.payment.callbacks.handler.PaymentServiceFactory")
    def test_cancelled_order_with_confirmed_payment_recovers_to_paid(
        self, mock_factory, mock_benefit,
    ):
        """cancelled + 支付平台确认已扣款 → 恢复为 paid 并发放权益"""
        order = self._make_order(status="cancelled")
        self._setup_mock_service(mock_factory, order)
        mock_benefit.grant.return_value = order.id
        handler = PaymentCallbackHandler("alipay")

        result = handler.handle_callback({"raw": "data"})

        self.assertEqual(result["status"], "success")
        order.refresh_from_db()
        self.assertEqual(order.status, "paid")

    # ── 场景 6：权益发放 + 异步补偿同时失败 → 告警 ──

    @patch("apps.services.payment.callbacks.handler.PaymentServiceFactory")
    def test_benefit_grant_delay_failure_dispatches_alert(self, mock_factory):
        """权益同步发放失败 + grant_order_benefits.delay 也失败 → _dispatch_billing_alert 被调用"""
        order = self._make_order(status="pending")
        self._setup_mock_service(mock_factory, order)
        handler = PaymentCallbackHandler("alipay")

        with patch(
            "apps.services.payment.callbacks.handler.OrderBenefitService"
        ) as mock_benefit, patch(
            "apps.services.payment.tasks.grant_order_benefits"
        ) as mock_grant_task, patch(
            "apps.services.billing.tasks._dispatch_billing_alert"
        ) as mock_alert:
            mock_benefit.grant.side_effect = RuntimeError("service down")
            mock_grant_task.delay.side_effect = ConnectionError("Redis unavailable")

            result = handler.handle_callback({"raw": "data"})

        self.assertEqual(result["status"], "success")
        order.refresh_from_db()
        self.assertEqual(order.status, "paid")

        mock_alert.assert_called_once()
        call_args = mock_alert.call_args
        self.assertEqual(call_args[0][0], "benefit_queue_failure")
        self.assertEqual(call_args[0][1], "critical")
        self.assertIn(str(order.id), call_args[0][2])

    # ── 场景 7：update_fields 精确保存 ──

    @patch("apps.services.payment.callbacks.handler.PaymentServiceFactory")
    def test_update_order_status_saves_with_update_fields(self, mock_factory):
        """_update_order_status 保存时使用 update_fields 精确更新"""
        order = self._make_order(status="pending")
        mock_factory.get_service.return_value = MagicMock()
        handler = PaymentCallbackHandler("alipay")
        parsed = self._parsed_data(order)

        with patch.object(PaymentOrder, "save") as mock_save:
            handler._update_order_status(order, parsed)

            mock_save.assert_called_once()
            call_kwargs = mock_save.call_args.kwargs
            self.assertIn("update_fields", call_kwargs)
            expected = {
                "third_party_trade_no", "paid_amount", "paid_at", "status", "updated_at",
            }
            self.assertEqual(set(call_kwargs["update_fields"]), expected)
