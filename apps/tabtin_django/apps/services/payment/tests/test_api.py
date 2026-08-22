import json
from decimal import Decimal
from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.test import Client, TestCase, override_settings

from apps.services.billing.models import StoragePackagePlan
from apps.services.payment.models import PaymentOrder
from apps.tabtinspace.models import Organization
from apps.users.auth.permissions import JWTAuth
from apps.users.auth.utils import generate_jwt_token
from apps.users.wallet.models import CreditPackage

User = get_user_model()

BASE = "/api/services/payment"


def _auth(token: str) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {token}"}


@override_settings(TABTIN_REQUIRE_INVITE_CODE=False)
class CreatePaymentOrderApiTests(TestCase):
    databases = {"default"}

    @classmethod
    def setUpTestData(cls):
        cls.user = User.objects.create_user(
            username="payment_api_user",
            email="payment_api_user@test.com",
            password="pass123",
        )
        cls.organization = Organization.objects.create(
            name="payment-api-org",
            owner_id=cls.user.id,
            type=Organization.OrganizationType.TEAM,
        )
        cls.organization_id = str(cls.organization.id)
        cls.credit_package = CreditPackage.objects.create(
            name="100 点券",
            description="测试点券套餐",
            price=Decimal("9.90"),
            credits_amount=100,
            bonus_credits=20,
            is_active=True,
        )
        cls.storage_package = StoragePackagePlan.objects.create(
            name="20GB 月包",
            description="测试存储套餐",
            price=Decimal("29.90"),
            storage_bytes=20,
            bonus_storage_bytes=5,
            duration_months=1,
            is_active=True,
        )

    def setUp(self):
        self.client = Client()
        self.token = generate_jwt_token(self.user)
        self.auth_patcher = patch.object(JWTAuth, "authenticate", return_value=self.user)
        self.auth_patcher.start()
        self.addCleanup(self.auth_patcher.stop)

    @patch("apps.services.payment.api.PaymentServiceFactory.get_service")
    def test_create_credits_order_persists_organization_and_total_credits(self, mock_get_service):
        payment_service = MagicMock()
        payment_service.create_payment.return_value = {
            "third_party_order_no": "tp_credit_001",
            "pay_url": "https://pay.example.com/credit",
        }
        mock_get_service.return_value = payment_service

        resp = self.client.post(
            f"{BASE}/create-order",
            json.dumps(
                {
                    "order_type": "credits",
                    "payment_method": "alipay",
                    "subject": "购买点券",
                    "description": "测试组织点券充值",
                    "amount": str(self.credit_package.price),
                    "business_data": {
                        "package_id": str(self.credit_package.id),
                        "organization_id": self.organization_id,
                        "credits_amount": 1000000,
                        "total_credits": 1000000,
                    },
                }
            ),
            content_type="application/json",
            **_auth(self.token),
        )

        self.assertEqual(resp.status_code, 200)
        order = PaymentOrder.objects.get(
            order_type="credits",
            organization_id=self.organization_id,
        )
        self.assertEqual(order.status, "paying")
        self.assertEqual(order.business_data["organization_id"], self.organization_id)
        self.assertEqual(order.business_data["credits_amount"], self.credit_package.total_credits)
        self.assertEqual(order.business_data["total_credits"], self.credit_package.total_credits)
        self.assertEqual(order.business_data["package_name"], self.credit_package.name)
        self.assertEqual(order.business_data["credits_snapshot_source"], "credit_package")

    @patch("apps.services.payment.api.PaymentServiceFactory.get_service")
    def test_create_credits_order_rejects_client_controlled_credits_without_package(self, mock_get_service):
        resp = self.client.post(
            f"{BASE}/create-order",
            json.dumps(
                {
                    "order_type": "credits",
                    "payment_method": "alipay",
                    "subject": "购买点券",
                    "description": "恶意点数",
                    "amount": "0.01",
                    "business_data": {
                        "organization_id": self.organization_id,
                        "credits_amount": 1000000,
                        "total_credits": 1000000,
                    },
                }
            ),
            content_type="application/json",
            **_auth(self.token),
        )

        self.assertEqual(resp.status_code, 400)
        mock_get_service.assert_not_called()
        self.assertFalse(PaymentOrder.objects.filter(order_type="credits").exists())

    @patch("apps.services.payment.api.PaymentServiceFactory.get_service")
    def test_create_credits_order_rejects_missing_organization(self, mock_get_service):
        resp = self.client.post(
            f"{BASE}/create-order",
            json.dumps(
                {
                    "order_type": "credits",
                    "payment_method": "alipay",
                    "subject": "购买点券",
                    "description": "缺组织",
                    "amount": str(self.credit_package.price),
                    "business_data": {
                        "package_id": str(self.credit_package.id),
                    },
                }
            ),
            content_type="application/json",
            **_auth(self.token),
        )

        self.assertEqual(resp.status_code, 400)
        mock_get_service.assert_not_called()
        self.assertFalse(PaymentOrder.objects.filter(order_type="credits").exists())

    @patch("apps.services.payment.api.PaymentServiceFactory.get_service")
    def test_create_credits_order_rejects_package_price_mismatch(self, mock_get_service):
        resp = self.client.post(
            f"{BASE}/create-order",
            json.dumps(
                {
                    "order_type": "credits",
                    "payment_method": "alipay",
                    "subject": "购买点券",
                    "description": "金额不匹配",
                    "amount": "0.01",
                    "business_data": {
                        "package_id": str(self.credit_package.id),
                        "organization_id": self.organization_id,
                    },
                }
            ),
            content_type="application/json",
            **_auth(self.token),
        )

        self.assertEqual(resp.status_code, 400)
        mock_get_service.assert_not_called()
        self.assertFalse(PaymentOrder.objects.filter(order_type="credits").exists())

    @patch("apps.services.payment.api.PaymentServiceFactory.get_service")
    def test_create_storage_package_order_persists_organization_and_package_snapshot(self, mock_get_service):
        payment_service = MagicMock()
        payment_service.create_payment.return_value = {
            "third_party_order_no": "tp_storage_001",
            "pay_url": "https://pay.example.com/storage",
        }
        mock_get_service.return_value = payment_service

        resp = self.client.post(
            f"{BASE}/create-order",
            json.dumps(
                {
                    "order_type": "storage_package",
                    "payment_method": "wechat",
                    "subject": "购买存储包",
                    "description": "测试组织存储包",
                    "amount": str(self.storage_package.price),
                    "business_data": {
                        "storage_package_id": str(self.storage_package.id),
                        "organization_id": self.organization_id,
                    },
                }
            ),
            content_type="application/json",
            **_auth(self.token),
        )

        self.assertEqual(resp.status_code, 200)
        order = PaymentOrder.objects.get(
            order_type="storage_package",
            organization_id=self.organization_id,
        )
        self.assertEqual(order.status, "paying")
        self.assertEqual(order.business_data["organization_id"], self.organization_id)
        self.assertEqual(order.business_data["storage_package_id"], str(self.storage_package.id))
        self.assertEqual(order.business_data["storage_bytes"], self.storage_package.total_storage_bytes)
        self.assertEqual(order.business_data["duration_months"], self.storage_package.duration_months)
        self.assertEqual(order.business_data["package_name"], self.storage_package.name)

    @patch("apps.services.payment.api.PaymentServiceFactory.get_service")
    def test_create_order_rejects_cash_wallet_order_type(self, mock_get_service):
        resp = self.client.post(
            f"{BASE}/create-order",
            json.dumps(
                {
                    "order_type": "cash_wallet",
                    "payment_method": "alipay",
                    "subject": "现金钱包充值",
                    "description": "必须走组织现金钱包专用充值接口",
                    "amount": "10.00",
                    "business_data": {
                        "organization_id": self.organization_id,
                    },
                }
            ),
            content_type="application/json",
            **_auth(self.token),
        )

        self.assertEqual(resp.status_code, 400)
        mock_get_service.assert_not_called()
        self.assertFalse(PaymentOrder.objects.filter(order_type="cash_wallet").exists())

    @patch("apps.services.payment.services.factory.PaymentServiceFactory.get_service")
    def test_wallet_recharge_forwards_payment_type_to_payment_service(self, mock_get_service):
        payment_service = MagicMock()
        payment_service.create_payment.return_value = {
            "third_party_order_no": "tp_wallet_qr_001",
            "pay_url": "https://pay.example.com/qr",
            "qr_code": "data:image/png;base64,qr",
        }
        mock_get_service.return_value = payment_service

        resp = self.client.post(
            "/api/wallet/recharge"
            f"?package_id={self.credit_package.id}"
            f"&organization_id={self.organization_id}"
            "&payment_method=alipay"
            "&payment_type=qr",
            **_auth(self.token),
        )

        self.assertEqual(resp.status_code, 200)
        payment_service.create_payment.assert_called_once()
        _, kwargs = payment_service.create_payment.call_args
        self.assertEqual(kwargs["extra_params"], {"payment_type": "qr"})

    @patch("apps.services.payment.services.factory.PaymentServiceFactory.get_service")
    def test_wallet_recharge_rejects_missing_organization(self, mock_get_service):
        resp = self.client.post(
            "/api/wallet/recharge"
            f"?package_id={self.credit_package.id}"
            "&payment_method=alipay",
            **_auth(self.token),
        )

        self.assertEqual(resp.status_code, 400)
        mock_get_service.assert_not_called()
        self.assertFalse(PaymentOrder.objects.filter(order_type="credits").exists())
