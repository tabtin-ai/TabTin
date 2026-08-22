"""：组织详情 staff 只读 API（usage/catalog/member-budget/payment/cash）。"""

from __future__ import annotations

from decimal import Decimal

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import Client, RequestFactory, TestCase

from apps.services.billing.tests.org_test_utils import org_id_for
from apps.tabtinspace.signals import create_default_organization
from apps.users.auth.models import (
    AdminAccount,
    RegistrationInviteCode,
    RegistrationInviteRedemption,
)
from apps.users.auth.session_manager import SessionManager
from apps.users.auth.utils import generate_jwt_token
from apps.users.wallet.models import OrganizationWallet

User = get_user_model()

BILLING_BASE = "/api/services/billing"
PAYMENT_BASE = "/api/services/payment"
AUTH_ADMIN_BASE = "/api/auth/admin"


def _auth(token: str) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {token}"}


class OrgDetailStaffReadApiTests(TestCase):
    """新增组织详情 staff 只读端点：200 + 关键字段形状。"""

    databases = {"default"}

    def setUp(self):
        post_save.disconnect(create_default_organization, sender=User)
        self.client = Client()
        self.factory = RequestFactory()
        self.admin = User.objects.create_superuser(
            username="org_detail_staff_admin",
            email="org_detail_staff_admin@test.com",
            password="admin123",
        )
        AdminAccount.objects.create(
            user=self.admin,
            display_name="org detail staff",
            status=AdminAccount.STATUS_ACTIVE,
            admin_login_enabled=True,
            created_by=self.admin,
        )
        invite = RegistrationInviteCode.objects.create(
            code="5702-ORG-DETAIL-STAFF",
            description="test invite for org detail staff apis",
            created_by=self.admin,
        )
        RegistrationInviteRedemption.objects.create(
            invite_code=invite,
            user=self.admin,
            entrypoint="test",
        )
        self.token = self._issue_access_token(self.admin)
        self.organization_id = org_id_for("5702_org_detail_staff")
        OrganizationWallet.objects.get_or_create(
            organization_id=self.organization_id,
            defaults={
                "credits": Decimal("10"),
                "credits_precise": Decimal("10"),
            },
        )

    def tearDown(self):
        post_save.connect(create_default_organization, sender=User)
        super().tearDown()

    def _issue_access_token(self, user) -> str:
        # DB 存 hash，JWT sid 必须是 create_session 返回的明文 key
        session = SessionManager.create_session(
            user=user,
            request=self.factory.get("/"),
            session_type="web",
            expire_hours=24,
        )
        return generate_jwt_token(user, session_key=session.session_key)

    def test_usage_dashboard_ok(self):
        resp = self.client.get(
            f"{BILLING_BASE}/admin/billing/organizations/{self.organization_id}/usage-dashboard",
            **_auth(self.token),
        )
        self.assertEqual(resp.status_code, 200, resp.content[:500])
        payload = resp.json()
        self.assertTrue(payload.get("success", True) or "data" in payload)
        data = payload.get("data") or payload
        self.assertIn("organization_id", data)
        self.assertEqual(str(data["organization_id"]), self.organization_id)

    def test_service_catalog_ok(self):
        resp = self.client.get(
            f"{BILLING_BASE}/admin/billing/organizations/{self.organization_id}/service-catalog",
            **_auth(self.token),
        )
        self.assertEqual(resp.status_code, 200, resp.content[:500])
        data = (resp.json().get("data") or resp.json())
        self.assertTrue(isinstance(data, (dict, list)))

    def test_member_budget_shape(self):
        resp = self.client.get(
            f"{BILLING_BASE}/admin/billing/organizations/{self.organization_id}/member-budget",
            **_auth(self.token),
        )
        self.assertEqual(resp.status_code, 200, resp.content[:500])
        data = resp.json()["data"]
        self.assertEqual(data["organization_id"], self.organization_id)
        self.assertIn("default_policy", data)
        self.assertIn("exempt_roles", data)
        self.assertIn("admin_exempt", data)
        self.assertIsInstance(data["exempt_roles"], list)
        self.assertIsInstance(data["admin_exempt"], bool)

    def test_payment_transactions_ok(self):
        resp = self.client.get(
            f"{PAYMENT_BASE}/admin/organizations/{self.organization_id}/transactions",
            **_auth(self.token),
        )
        self.assertEqual(resp.status_code, 200, resp.content[:500])
        data = resp.json().get("data") or resp.json()
        self.assertTrue(isinstance(data, (dict, list)))

    def test_cash_wallet_transactions_ok(self):
        """直调 staff handler 校验数据形状（HTTP 路由由 live/CDP 覆盖）。"""
        from uuid import UUID

        from apps.tabtinspace.admin_api import (
            admin_list_organization_cash_wallet_transactions,
        )

        request = self.factory.get(
            f"{AUTH_ADMIN_BASE}/organizations/{self.organization_id}"
            "/cash-wallet/transactions"
        )
        request.user = self.admin
        request.auth = self.admin
        payload = admin_list_organization_cash_wallet_transactions(
            request,
            organization_id=UUID(self.organization_id),
        )
        self.assertIsInstance(payload, dict)
        data = payload["data"]
        self.assertEqual(str(data["organization_id"]), self.organization_id)
        self.assertIn("transactions", data)
        self.assertIn("total", data)

    def test_missing_session_jwt_rejected(self):
        bare = generate_jwt_token(self.admin)
        resp = self.client.get(
            f"{BILLING_BASE}/admin/billing/organizations/{self.organization_id}/member-budget",
            **_auth(bare),
        )
        self.assertIn(resp.status_code, (401, 403))
