"""
Billing organization-level API 端点测试
覆盖：权限校验、summary、policy CRUD、entitlement CRUD、settlement、invoice 生命周期。
"""

import json
import uuid
from decimal import Decimal
from unittest.mock import patch, MagicMock

from django.contrib.auth import get_user_model
from django.test import Client, TestCase
from django.utils import timezone

from apps.services.billing.models import (
    BillingUsageEvent,
    OrganizationBillingPolicy,
    OrganizationBillingEntitlement,
    BillingInvoice,
    BillingInvoiceLine,
    StoragePackagePlan,
)
from apps.services.payment.models import PaymentOrder
from apps.users.auth.utils import generate_jwt_token

User = get_user_model()

BASE = "/api/services/billing"

ORGANIZATION_ID = str(uuid.uuid4())  #  FK 化：必须是真实组织行（setUpTestData 建）


def _auth(token: str) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {token}"}


def _json_body(data: dict) -> dict:
    return {"data": json.dumps(data), "content_type": "application/json"}


class BillingApiBaseTestCase(TestCase):
    databases = {"default"}

    @classmethod
    def setUpTestData(cls):
        cls.admin_user = User.objects.create_superuser(
            username="billing_api_admin",
            email="billing_api_admin@test.com",
            password="pass123",
        )
        cls.normal_user = User.objects.create_user(
            username="billing_api_normal",
            email="billing_api_normal@test.com",
            password="pass123",
        )
        #  FK 化：billing 操作表挂真 FK，测试组织必须真实存在
        from apps.tabtinspace.models import Organization
        Organization.objects.get_or_create(
            id=ORGANIZATION_ID,
            defaults={
                "name": "billing-api-test-org",
                "owner_id": cls.admin_user.id,
                "type": Organization.OrganizationType.TEAM,
            },
        )

    def setUp(self):
        self.client = Client()
        self.admin_token = generate_jwt_token(self.admin_user)
        self.normal_token = generate_jwt_token(self.normal_user)

    @staticmethod
    def _mock_permission_check(allowed=True):
        """返回一个 mock patch 对象，模拟 organization 权限检查。"""
        if allowed:
            return patch(
                "apps.services.billing.api._check_organization_permission",
                return_value=None,
            )
        side_effect = __import__("ninja.errors", fromlist=["HttpError"]).HttpError
        return patch(
            "apps.services.billing.api._check_organization_permission",
            side_effect=lambda *a, **kw: (_ for _ in ()).throw(side_effect(403, "无权限")),
        )


class SummaryEndpointTests(BillingApiBaseTestCase):
    def test_summary_success(self):
        with self._mock_permission_check():
            resp = self.client.get(
                f"{BASE}/organizations/{ORGANIZATION_ID}/summary",
                **_auth(self.admin_token),
            )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertTrue(data.get("success"))

    def test_summary_auto_topup_spent_yuan_from_cash_ledger(self):
        """#5604：本月已花费取 llm_auto_topup 现金流水，不读已废弃的 topup_credits。"""
        from apps.users.auth.permissions import JWTAuth
        from apps.users.wallet.models import CashWalletTransaction, OrganizationCashWallet

        cash_wallet = OrganizationCashWallet.objects.create(
            organization_id=ORGANIZATION_ID,
            balance_cny=Decimal("10.00"),
        )
        CashWalletTransaction.objects.create(
            cash_wallet=cash_wallet,
            organization_id=ORGANIZATION_ID,
            transaction_type="llm_auto_topup",
            amount_cny=Decimal("-1.50"),
            balance_before_cny=Decimal("10.00"),
            balance_after_cny=Decimal("8.50"),
            related_order_id="test-auto-topup-1",
            description="自动补充测试",
        )
        CashWalletTransaction.objects.create(
            cash_wallet=cash_wallet,
            organization_id=ORGANIZATION_ID,
            transaction_type="llm_auto_topup",
            amount_cny=Decimal("-2.00"),
            balance_before_cny=Decimal("8.50"),
            balance_after_cny=Decimal("6.50"),
            related_order_id="test-auto-topup-2",
            description="自动补充测试",
        )
        # 非自动补充流水不应计入
        CashWalletTransaction.objects.create(
            cash_wallet=cash_wallet,
            organization_id=ORGANIZATION_ID,
            transaction_type="recharge",
            amount_cny=Decimal("5.00"),
            balance_before_cny=Decimal("6.50"),
            balance_after_cny=Decimal("11.50"),
            related_order_id="test-recharge-1",
        )

        with self._mock_permission_check(), patch.object(
            JWTAuth, "authenticate", return_value=self.admin_user
        ), patch(
            "apps.users.auth.invite_gate_middleware._has_redeemed_invite",
            return_value=True,
        ):
            resp = self.client.get(
                f"{BASE}/organizations/{ORGANIZATION_ID}/summary",
                **_auth(self.admin_token),
            )
        self.assertEqual(resp.status_code, 200)
        budget = resp.json()["data"]["llm_month_budget"]
        self.assertEqual(Decimal(budget["auto_topup_spent_yuan"]), Decimal("3.50"))
        self.assertEqual(Decimal(budget["topup_credits"]), Decimal("0"))

    def test_summary_permission_denied(self):
        with self._mock_permission_check(allowed=False):
            resp = self.client.get(
                f"{BASE}/organizations/{ORGANIZATION_ID}/summary",
                **_auth(self.normal_token),
            )
        self.assertEqual(resp.status_code, 403)

    def test_summary_nonexistent_organization(self):
        with self._mock_permission_check():
            resp = self.client.get(
                f"{BASE}/organizations/nonexistent-ws-id/summary",
                **_auth(self.admin_token),
            )
        self.assertEqual(resp.status_code, 200)


class PolicyEndpointTests(BillingApiBaseTestCase):
    def test_get_policy_default(self):
        with self._mock_permission_check():
            resp = self.client.get(
                f"{BASE}/organizations/{ORGANIZATION_ID}/policy",
                **_auth(self.admin_token),
            )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertTrue(data.get("success"))

    def test_put_policy(self):
        with self._mock_permission_check():
            resp = self.client.put(
                f"{BASE}/organizations/{ORGANIZATION_ID}/policy",
                json.dumps({"storage_billing_mode": "paygo_only", "is_active": True}),
                content_type="application/json",
                **_auth(self.admin_token),
            )
        self.assertIn(resp.status_code, (200, 201))
        data = resp.json()
        self.assertTrue(data.get("success"))

    def test_put_policy_permission_denied(self):
        with self._mock_permission_check(allowed=False):
            resp = self.client.put(
                f"{BASE}/organizations/{ORGANIZATION_ID}/policy",
                json.dumps({"is_active": True}),
                content_type="application/json",
                **_auth(self.normal_token),
            )
        self.assertEqual(resp.status_code, 403)


class EntitlementEndpointTests(BillingApiBaseTestCase):
    def test_get_entitlement_default(self):
        with self._mock_permission_check():
            resp = self.client.get(
                f"{BASE}/organizations/{ORGANIZATION_ID}/entitlement",
                **_auth(self.admin_token),
            )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertTrue(data.get("success"))

    def test_put_entitlement(self):
        with self._mock_permission_check():
            resp = self.client.put(
                f"{BASE}/organizations/{ORGANIZATION_ID}/entitlement",
                json.dumps({"included_storage_bytes": 1073741824, "is_active": True}),
                content_type="application/json",
                **_auth(self.admin_token),
            )
        self.assertIn(resp.status_code, (200, 201))
        data = resp.json()
        self.assertTrue(data.get("success"))


class SettlementEndpointTests(BillingApiBaseTestCase):
    def test_daily_settlement(self):
        with self._mock_permission_check():
            resp = self.client.post(
                f"{BASE}/organizations/{ORGANIZATION_ID}/settlement/daily",
                json.dumps({}),
                content_type="application/json",
                **_auth(self.admin_token),
            )
        self.assertIn(resp.status_code, (200, 422))


class InvoiceEndpointTests(BillingApiBaseTestCase):
    def test_generate_invoice(self):
        now = timezone.now()
        with self._mock_permission_check():
            resp = self.client.post(
                f"{BASE}/organizations/{ORGANIZATION_ID}/invoices/generate",
                json.dumps({"year": now.year, "month": now.month}),
                content_type="application/json",
                **_auth(self.admin_token),
            )
        self.assertIn(resp.status_code, (401, 410))

    def test_list_invoices(self):
        with self._mock_permission_check():
            resp = self.client.get(
                f"{BASE}/organizations/{ORGANIZATION_ID}/invoices",
                **_auth(self.admin_token),
            )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertTrue(data.get("success"))
        self.assertIn("invoices", data.get("data", {}))

    def test_get_invoice_nonexistent(self):
        fake_id = str(uuid.uuid4())
        with self._mock_permission_check():
            resp = self.client.get(
                f"{BASE}/organizations/{ORGANIZATION_ID}/invoices/{fake_id}",
                **_auth(self.admin_token),
            )
        self.assertEqual(resp.status_code, 404)

    def test_collect_invoice_nonexistent(self):
        fake_id = str(uuid.uuid4())
        with self._mock_permission_check():
            resp = self.client.post(
                f"{BASE}/organizations/{ORGANIZATION_ID}/invoices/{fake_id}/collect",
                content_type="application/json",
                **_auth(self.admin_token),
            )
        self.assertEqual(resp.status_code, 404)

    def test_collect_invoice_success(self):
        invoice = BillingInvoice.objects.create(
            organization_id=ORGANIZATION_ID,
            period_start=timezone.now().date().replace(day=1),
            period_end=timezone.now().date(),
            status="open",
            total_amount=Decimal("0"),
            subtotal_amount=Decimal("0"),
            discount_amount=Decimal("0"),
        )
        with self._mock_permission_check():
            resp = self.client.post(
                f"{BASE}/organizations/{ORGANIZATION_ID}/invoices/{invoice.id}/collect",
                content_type="application/json",
                **_auth(self.admin_token),
            )
        self.assertIn(resp.status_code, (401, 410))

    def test_invoice_overview_report(self):
        with self._mock_permission_check():
            resp = self.client.get(
                f"{BASE}/organizations/{ORGANIZATION_ID}/reports/invoice-overview",
                **_auth(self.admin_token),
            )
        self.assertEqual(resp.status_code, 200)

    def test_usage_dashboard(self):
        with self._mock_permission_check():
            resp = self.client.get(
                f"{BASE}/organizations/{ORGANIZATION_ID}/usage-dashboard",
                **_auth(self.admin_token),
            )
        self.assertEqual(resp.status_code, 200)


class StoragePackageEndpointTests(BillingApiBaseTestCase):
    def setUp(self):
        super().setUp()
        self.package = StoragePackagePlan.objects.create(
            name="10GB 月包",
            description="测试存储套餐",
            price=Decimal("9.90"),
            storage_bytes=10,
            bonus_storage_bytes=2,
            duration_months=1,
            is_active=True,
        )

    def test_list_storage_packages(self):
        resp = self.client.get(f"{BASE}/storage-packages")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        items = data.get("data", [])
        self.assertTrue(any(item["id"] == str(self.package.id) for item in items))

    @patch("apps.services.payment.services.factory.PaymentServiceFactory.get_service")
    def test_purchase_storage_package_creates_order(self, mock_get_service):
        payment_service = MagicMock()
        payment_service.create_payment.return_value = {
            "third_party_order_no": "tp_storage_001",
            "pay_url": "https://pay.example.com/storage",
        }
        mock_get_service.return_value = payment_service

        with self._mock_permission_check():
            resp = self.client.post(
                f"{BASE}/organizations/{ORGANIZATION_ID}/storage-packages/purchase",
                json.dumps({
                    "package_id": str(self.package.id),
                    "payment_method": "alipay",
                }),
                content_type="application/json",
                **_auth(self.admin_token),
            )

        self.assertEqual(resp.status_code, 200)
        order = PaymentOrder.objects.get(order_type="storage_package", organization_id=ORGANIZATION_ID)
        self.assertEqual(order.business_data["storage_package_id"], str(self.package.id))
        self.assertEqual(order.status, "paying")
