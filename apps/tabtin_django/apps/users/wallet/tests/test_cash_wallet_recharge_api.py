"""组织现金钱包用户侧充值 API 测试。"""

import threading
import time
from datetime import timedelta
from decimal import Decimal
from unittest.mock import patch

from django.db import connection, connections
from django.test import Client, TestCase, TransactionTestCase, override_settings
from django.utils import timezone
from ninja.errors import HttpError

from apps.tabtinspace.models import Organization
from apps.users.auth.models import User
from apps.users.auth.permissions import JWTAuth
from apps.services.payment.models import PaymentOrder


BASE = "/api/wallet"


def _auth_header() -> dict:
    return {"HTTP_AUTHORIZATION": "Bearer test-token"}


@override_settings(TABTIN_REQUIRE_INVITE_CODE=False)
class CashWalletRechargeApiTests(TestCase):
    databases = {"default"}

    def setUp(self):
        self.client = Client()
        self.owner = User.objects.create_user(
            email="cash_recharge_owner@test.com",
            password="test-pass-123",
        )
        self.organization = Organization.objects.create(
            name="cash-recharge-org",
            owner_id=self.owner.id,
            type=Organization.OrganizationType.TEAM,
        )
        self.organization_id = str(self.organization.id)

    @patch("apps.services.payment.services.factory.PaymentServiceFactory.get_service")
    def test_owner_can_create_cash_wallet_recharge_order(self, mock_get_service):
        mock_service = mock_get_service.return_value

        def create_payment(**kwargs):
            order = PaymentOrder.objects.get(order_no=kwargs["order_no"])
            self.assertEqual(order.status, "pending")
            self.assertTrue(order.business_data["cash_wallet_payment_creating"])
            return {
                "pay_url": "https://pay.example/alipay",
                "qr_code": "https://pay.example/qr",
                "third_party_order_no": "tp-001",
            }

        mock_service.create_payment.side_effect = create_payment

        url = f"{BASE}/organizations/{self.organization_id}/cash-wallet/recharge"
        with (
            patch.object(JWTAuth, "authenticate", return_value=self.owner),
            patch("apps.users.wallet.api.ensure_organization_permission", return_value=None),
        ):
            resp = self.client.post(
                url,
                data={
                    "amount_cny": "50.00",
                    "payment_method": "alipay",
                    "payment_type": "qr",
                },
                content_type="application/json",
                **_auth_header(),
            )

        self.assertEqual(resp.status_code, 200, resp.content)
        body = resp.json()
        data = body.get("data") or body
        self.assertIn("order_no", data)
        order = PaymentOrder.objects.get(order_no=data["order_no"])
        self.assertEqual(order.order_type, "cash_wallet")
        self.assertEqual(order.amount, Decimal("50.00"))
        self.assertEqual(order.payment_method, "alipay")
        self.assertEqual(order.status, "paying")
        self.assertEqual(order.organization_id, self.organization_id)
        self.assertNotIn("cash_wallet_payment_creating", order.business_data)

    def test_invalid_amounts_rejected(self):
        url = f"{BASE}/organizations/{self.organization_id}/cash-wallet/recharge"
        for amount in ("0", "0.009", "100000.004", "100000.01", "NaN"):
            with self.subTest(amount=amount):
                with (
                    patch.object(JWTAuth, "authenticate", return_value=self.owner),
                    patch("apps.users.wallet.api.ensure_organization_permission", return_value=None),
                ):
                    resp = self.client.post(
                        url,
                        data={"amount_cny": amount, "payment_method": "wechat"},
                        content_type="application/json",
                        **_auth_header(),
                    )

                self.assertEqual(resp.status_code, 400)
        self.assertEqual(PaymentOrder.objects.count(), 0)

    @patch("apps.services.payment.services.factory.PaymentServiceFactory.get_service")
    def test_amount_boundaries_are_allowed(self, mock_get_service):
        mock_service = mock_get_service.return_value
        mock_service.cancel_order.return_value = True
        mock_service.create_payment.return_value = {
            "pay_url": "https://pay.example/alipay",
            "qr_code": "https://pay.example/qr",
            "third_party_order_no": "tp-boundary",
        }

        for amount in ("0.01", "100000.00"):
            organization = Organization.objects.create(
                name=f"cash-recharge-boundary-{amount}",
                owner_id=self.owner.id,
                type=Organization.OrganizationType.TEAM,
            )
            url = f"{BASE}/organizations/{organization.id}/cash-wallet/recharge"
            with (
                patch.object(JWTAuth, "authenticate", return_value=self.owner),
                patch("apps.users.wallet.api.ensure_organization_permission", return_value=None),
            ):
                resp = self.client.post(
                    url,
                    data={"amount_cny": amount, "payment_method": "alipay"},
                    content_type="application/json",
                    **_auth_header(),
                )

            self.assertEqual(resp.status_code, 200, resp.content)
            self.assertTrue(PaymentOrder.objects.filter(organization_id=str(organization.id), amount=Decimal(amount)).exists())

    def test_non_owner_rejected(self):
        url = f"{BASE}/organizations/{self.organization_id}/cash-wallet/recharge"
        with (
            patch.object(JWTAuth, "authenticate", return_value=self.owner),
            patch(
                "apps.users.wallet.api.ensure_organization_permission",
                side_effect=HttpError(403, "forbidden"),
            ),
        ):
            resp = self.client.post(
                url,
                data={"amount_cny": "10.00", "payment_method": "alipay"},
                content_type="application/json",
                **_auth_header(),
            )

        self.assertEqual(resp.status_code, 403)
        self.assertEqual(PaymentOrder.objects.count(), 0)

    def test_unsupported_payment_method_rejected(self):
        url = f"{BASE}/organizations/{self.organization_id}/cash-wallet/recharge"
        with (
            patch.object(JWTAuth, "authenticate", return_value=self.owner),
            patch("apps.users.wallet.api.ensure_organization_permission", return_value=None),
        ):
            resp = self.client.post(
                url,
                data={"amount_cny": "10.00", "payment_method": "paypal"},
                content_type="application/json",
                **_auth_header(),
            )

        self.assertEqual(resp.status_code, 400)
        self.assertEqual(PaymentOrder.objects.count(), 0)

    @patch("apps.services.payment.services.factory.PaymentServiceFactory.get_service")
    def test_old_order_cancel_failure_keeps_local_order_and_rejects_new_order(self, mock_get_service):
        old_order = PaymentOrder.objects.create(
            user=self.owner,
            organization_id=self.organization_id,
            order_type="cash_wallet",
            subject="旧现金充值",
            description="",
            amount=Decimal("20.00"),
            payment_method="alipay",
            status="paying",
            expired_at=timezone.now() + timedelta(minutes=15),
        )
        mock_service = mock_get_service.return_value
        mock_service.cancel_order.side_effect = RuntimeError("gateway down")
        mock_service.query_order.return_value = {}

        url = f"{BASE}/organizations/{self.organization_id}/cash-wallet/recharge"
        with (
            patch.object(JWTAuth, "authenticate", return_value=self.owner),
            patch("apps.users.wallet.api.ensure_organization_permission", return_value=None),
        ):
            resp = self.client.post(
                url,
                data={"amount_cny": "30.00", "payment_method": "alipay"},
                content_type="application/json",
                **_auth_header(),
            )

        self.assertEqual(resp.status_code, 409, resp.content)
        old_order.refresh_from_db()
        self.assertEqual(old_order.status, "paying")
        mock_service.create_payment.assert_not_called()
        self.assertEqual(PaymentOrder.objects.count(), 1)

    @patch("apps.services.payment.services.benefit_service.OrderBenefitService.grant")
    @patch("apps.services.payment.services.factory.PaymentServiceFactory.get_service")
    def test_old_order_paid_remotely_is_synced_and_granted_before_new_order(
        self,
        mock_get_service,
        mock_grant,
    ):
        old_order = PaymentOrder.objects.create(
            user=self.owner,
            organization_id=self.organization_id,
            order_type="cash_wallet",
            subject="旧现金充值",
            description="",
            amount=Decimal("20.00"),
            payment_method="alipay",
            status="paying",
            expired_at=timezone.now() + timedelta(minutes=15),
        )
        mock_service = mock_get_service.return_value
        mock_service.cancel_order.return_value = False
        mock_service.query_order.return_value = {
            "trade_status": "TRADE_SUCCESS",
            "third_party_trade_no": "TRADE_OLD",
            "total_amount": "20.00",
        }
        mock_service.create_payment.return_value = {
            "pay_url": "https://pay.example/alipay-new",
            "qr_code": "https://pay.example/qr-new",
            "third_party_order_no": "tp-new",
        }
        mock_grant.return_value = old_order.id

        url = f"{BASE}/organizations/{self.organization_id}/cash-wallet/recharge"
        with (
            patch.object(JWTAuth, "authenticate", return_value=self.owner),
            patch("apps.users.wallet.api.ensure_organization_permission", return_value=None),
        ):
            resp = self.client.post(
                url,
                data={"amount_cny": "30.00", "payment_method": "alipay"},
                content_type="application/json",
                **_auth_header(),
            )

        self.assertEqual(resp.status_code, 200, resp.content)
        old_order.refresh_from_db()
        self.assertEqual(old_order.status, "paid")
        self.assertEqual(old_order.third_party_trade_no, "TRADE_OLD")
        mock_grant.assert_called_once_with(old_order.id)
        self.assertEqual(PaymentOrder.objects.filter(status="paying").count(), 1)

    @patch("apps.services.payment.tasks.grant_order_benefits")
    @patch("apps.services.payment.services.benefit_service.OrderBenefitService.grant")
    @patch("apps.services.payment.services.factory.PaymentServiceFactory.get_service")
    def test_old_order_paid_remotely_grant_failure_queues_compensation(
        self,
        mock_get_service,
        mock_grant,
        mock_grant_task,
    ):
        old_order = PaymentOrder.objects.create(
            user=self.owner,
            organization_id=self.organization_id,
            order_type="cash_wallet",
            subject="旧现金充值",
            description="",
            amount=Decimal("20.00"),
            payment_method="alipay",
            status="paying",
            expired_at=timezone.now() + timedelta(minutes=15),
        )
        mock_service = mock_get_service.return_value
        mock_service.cancel_order.return_value = False
        mock_service.query_order.return_value = {
            "trade_status": "TRADE_SUCCESS",
            "third_party_trade_no": "TRADE_OLD",
            "total_amount": "20.00",
        }
        mock_service.create_payment.return_value = {
            "pay_url": "https://pay.example/alipay-new",
            "qr_code": "https://pay.example/qr-new",
            "third_party_order_no": "tp-new",
        }
        mock_grant.side_effect = RuntimeError("grant down")

        url = f"{BASE}/organizations/{self.organization_id}/cash-wallet/recharge"
        with (
            patch.object(JWTAuth, "authenticate", return_value=self.owner),
            patch("apps.users.wallet.api.ensure_organization_permission", return_value=None),
        ):
            resp = self.client.post(
                url,
                data={"amount_cny": "30.00", "payment_method": "alipay"},
                content_type="application/json",
                **_auth_header(),
            )

        self.assertEqual(resp.status_code, 200, resp.content)
        old_order.refresh_from_db()
        self.assertEqual(old_order.status, "paid")
        mock_grant_task.delay.assert_called_once_with(old_order.id)


@override_settings(TABTIN_REQUIRE_INVITE_CODE=False)
class CashWalletRechargeConcurrencyTests(TransactionTestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.owner = User.objects.create_user(
            email="cash_recharge_concurrency@test.com",
            password="test-pass-123",
        )
        self.organization = Organization.objects.create(
            name="cash-recharge-concurrency-org",
            owner_id=self.owner.id,
            type=Organization.OrganizationType.TEAM,
        )
        self.organization_id = str(self.organization.id)

    @patch("apps.services.payment.services.factory.PaymentServiceFactory.get_service")
    def test_concurrent_recharge_requests_are_serialized_by_organization_lock(self, mock_get_service):
        if connection.vendor != "postgresql":
            self.skipTest("requires PostgreSQL row-level locking")

        first_create_entered = threading.Event()
        release_first_create = threading.Event()
        create_calls = []
        lock = threading.Lock()

        def create_payment(**kwargs):
            with lock:
                create_calls.append(kwargs["order_no"])
                call_no = len(create_calls)
            if call_no == 1:
                first_create_entered.set()
                self.assertTrue(release_first_create.wait(timeout=5))
            return {
                "pay_url": f"https://pay.example/{call_no}",
                "qr_code": f"https://pay.example/qr/{call_no}",
                "third_party_order_no": f"tp-{call_no}",
            }

        mock_service = mock_get_service.return_value
        mock_service.create_payment.side_effect = create_payment
        mock_service.cancel_order.return_value = True

        responses = []

        def post_recharge(amount):
            try:
                client = Client()
                url = f"{BASE}/organizations/{self.organization_id}/cash-wallet/recharge"
                with (
                    patch.object(JWTAuth, "authenticate", return_value=self.owner),
                    patch("apps.users.wallet.api.ensure_organization_permission", return_value=None),
                ):
                    responses.append(client.post(
                        url,
                        data={"amount_cny": amount, "payment_method": "alipay"},
                        content_type="application/json",
                        **_auth_header(),
                    ))
            finally:
                connections.close_all()

        first = threading.Thread(target=post_recharge, args=("10.00",))
        second = threading.Thread(target=post_recharge, args=("20.00",))
        first.start()
        self.assertTrue(first_create_entered.wait(timeout=5))
        second.start()
        time.sleep(0.2)
        self.assertEqual(len(create_calls), 1, "第二个请求不应越过组织锁创建第三方支付单")
        release_first_create.set()
        first.join(timeout=5)
        second.join(timeout=5)

        self.assertCountEqual([r.status_code for r in responses], [200, 409])
        self.assertEqual(PaymentOrder.objects.filter(status="paying").count(), 1)
        self.assertEqual(PaymentOrder.objects.filter(status="cancelled").count(), 0)
