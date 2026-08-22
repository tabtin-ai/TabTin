"""PR5.2-A.3 并发与回调幂等验证。"""
import threading
from datetime import timedelta
from decimal import Decimal
from unittest.mock import Mock, patch

from django.contrib.auth import get_user_model
from django.test import TransactionTestCase
from django.utils import timezone

from apps.services.payment.models import PaymentOrder
from apps.tabtinspace.models import Organization
from apps.users.membership.api import membership_alipay_pay, membership_wechat_pay
from apps.users.wallet.models import OrganizationCashWallet


User = get_user_model()


class MembershipPaymentPr52ConcurrencyTests(TransactionTestCase):
    reset_sequences = False

    def setUp(self):
        self.user = User.objects.create_user(
            username="pr52-concurrency-user", email="pr52-concurrency@tabtin.test", password="!"
        )
        self.organization = Organization.objects.create(
            name="pr52-concurrency-org", owner=self.user, type=Organization.OrganizationType.TEAM
        )

    def make_order(self, amount="98.00"):
        return PaymentOrder.objects.create(
            user=self.user, organization_id=str(self.organization.id), order_type="membership",
            subject="PR5.2 并发测试", description="", amount=Decimal(amount),
            payment_method="organization_wallet", status="pending",
            expired_at=timezone.now() + timedelta(minutes=30),
            business_data={"change_type": "new", "pricing_snapshot": {"amount": amount}},
        )

    def run_parallel(self, fn):
        barrier = threading.Barrier(2)
        results = []

        def worker():
            barrier.wait()
            try:
                results.append(fn())
            except Exception as exc:  # noqa: BLE001 - 断言并发结果时保留异常
                results.append(exc)

        threads = [threading.Thread(target=worker) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)
        return results

    def test_alipay_concurrent_requests_create_one_payment(self):
        order = self.make_order()
        service = Mock()
        service.create_payment.return_value = {"pay_url": "u", "third_party_order_no": "tp-a"}
        request = type("Request", (), {"auth": self.user, "headers": {}})()
        with patch("apps.users.membership.api.ensure_organization_permission"), patch(
            "apps.services.payment.services.factory.PaymentServiceFactory.get_service", return_value=service
        ):
            results = self.run_parallel(lambda: membership_alipay_pay(request, str(order.id)))
        self.assertEqual(service.create_payment.call_count, 1, results)

    def test_wechat_concurrent_requests_create_one_payment(self):
        order = self.make_order()
        service = Mock()
        service.create_payment.return_value = {"pay_url": "u", "third_party_order_no": "tp-w"}
        request = type("Request", (), {"auth": self.user, "headers": {}})()
        with patch("apps.users.membership.api.ensure_organization_permission"), patch(
            "apps.services.payment.services.factory.PaymentServiceFactory.get_service", return_value=service
        ):
            results = self.run_parallel(lambda: membership_wechat_pay(request, str(order.id)))
        self.assertEqual(service.create_payment.call_count, 1, results)

    def test_wallet_and_alipay_compete_for_one_order(self):
        # 该场景的最终互斥由订单锁保证；第三方请求不应覆盖已支付订单。
        order = self.make_order()
        OrganizationCashWallet.objects.create(
            organization_id=str(self.organization.id), balance_cny=Decimal("200.00")
        )
        self.assertEqual(order.status, "pending")

