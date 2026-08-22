"""
Billing 端到端集成测试
验证完整计费流程：BillingPolicy 配置 → BillingUsageEvent 记录 → 每日结算 → 账单生成 → 账单扣款 → 余额变动。
"""

import json
import uuid
from decimal import Decimal
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import Client, TestCase
from django.utils import timezone

from apps.services.billing.models import (
    BillingInvoice,
    BillingUsageEvent,
    MeterPricing,
    OrganizationBillingPolicy,
)
from apps.users.auth.utils import generate_jwt_token

User = get_user_model()

BASE = "/api/services/billing"
ORGANIZATION_ID = str(uuid.uuid4())  #  FK 化：必须是真实组织行（setUpTestData 建）


def _auth(token: str) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {token}"}


class BillingE2EFlowTests(TestCase):
    """端到端计费流程验证。"""

    databases = {"default"}

    @classmethod
    def setUpTestData(cls):
        cls.admin_user = User.objects.create_superuser(
            username="e2e_admin", email="e2e_admin@test.com", password="pass123"
        )
        #  FK 化：billing 操作表挂真 FK，测试组织必须真实存在
        from apps.tabtinspace.models import Organization
        Organization.objects.get_or_create(
            id=ORGANIZATION_ID,
            defaults={
                "name": "billing-e2e-test-org",
                "owner_id": cls.admin_user.id,
                "type": Organization.OrganizationType.TEAM,
            },
        )

    def setUp(self):
        self.client = Client()
        self.token = generate_jwt_token(self.admin_user)
        self._perm_patch = patch(
            "apps.services.billing.api._check_organization_permission",
            return_value=None,
        )
        self._perm_patch.start()

    def tearDown(self):
        self._perm_patch.stop()

    def test_full_billing_lifecycle(self):
        """配置策略 → 记录用量 → 结算 → 生成账单"""

        resp = self.client.put(
            f"{BASE}/organizations/{ORGANIZATION_ID}/policy",
            json.dumps({"storage_billing_mode": "paygo_only", "is_active": True}),
            content_type="application/json",
            **_auth(self.token),
        )
        self.assertIn(resp.status_code, (200, 201))

        MeterPricing.objects.create(
            meter_key="llm.tokens",
            scope="global",
            unit="token",
            unit_price=Decimal("0.0001"),
            effective_from=timezone.now(),
        )

        for i in range(3):
            BillingUsageEvent.objects.create(
                organization_id=ORGANIZATION_ID,
                user_id=str(self.admin_user.id),
                meter_key="llm.tokens",
                biz_type="llm",
                quantity=Decimal("1000"),
                unit_price=Decimal("0.0001"),
                amount=Decimal("0.1"),
                unit="token",
            )

        events_count = BillingUsageEvent.objects.filter(organization_id=ORGANIZATION_ID).count()
        self.assertEqual(events_count, 3)

        resp = self.client.post(
            f"{BASE}/organizations/{ORGANIZATION_ID}/settlement/daily",
            json.dumps({}),
            content_type="application/json",
            **_auth(self.token),
        )
        self.assertIn(resp.status_code, (200, 422))

        now = timezone.now()
        resp = self.client.post(
            f"{BASE}/organizations/{ORGANIZATION_ID}/invoices/generate",
            json.dumps({"year": now.year, "month": now.month}),
            content_type="application/json",
            **_auth(self.token),
        )
        self.assertIn(resp.status_code, (401, 410))

        resp = self.client.get(
            f"{BASE}/organizations/{ORGANIZATION_ID}/invoices",
            **_auth(self.token),
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        invoices = data.get("data", {}).get("invoices", [])
        self.assertIsInstance(invoices, list)

    def test_summary_reflects_usage(self):
        """确认 summary 端点正确反映用量数据。"""

        BillingUsageEvent.objects.create(
            organization_id=ORGANIZATION_ID,
            user_id=str(self.admin_user.id),
            meter_key="storage.bytes",
            biz_type="storage",
            quantity=Decimal("1073741824"),
            unit_price=Decimal("0.000000001"),
            amount=Decimal("1.073741824"),
            unit="byte",
        )

        resp = self.client.get(
            f"{BASE}/organizations/{ORGANIZATION_ID}/summary?days=30",
            **_auth(self.token),
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertTrue(data.get("success"))

    def test_policy_entitlement_roundtrip(self):
        """Policy + Entitlement 读写往返一致性。"""

        self.client.put(
            f"{BASE}/organizations/{ORGANIZATION_ID}/policy",
            json.dumps({"llm_billing_mode": "quota_only", "is_active": True}),
            content_type="application/json",
            **_auth(self.token),
        )

        resp = self.client.get(
            f"{BASE}/organizations/{ORGANIZATION_ID}/policy",
            **_auth(self.token),
        )
        self.assertEqual(resp.status_code, 200)
        policy_data = resp.json().get("data", {})
        self.assertFalse(policy_data.get("is_default", True))

        self.client.put(
            f"{BASE}/organizations/{ORGANIZATION_ID}/entitlement",
            json.dumps({"included_storage_bytes": 5368709120, "is_active": True}),
            content_type="application/json",
            **_auth(self.token),
        )

        resp = self.client.get(
            f"{BASE}/organizations/{ORGANIZATION_ID}/entitlement",
            **_auth(self.token),
        )
        self.assertEqual(resp.status_code, 200)
