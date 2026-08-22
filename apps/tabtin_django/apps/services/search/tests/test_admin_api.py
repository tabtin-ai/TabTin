from __future__ import annotations

from datetime import timedelta
import json
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import Client, TestCase
from django.utils import timezone

from apps.services.billing.models import BillingUsageEvent
from apps.services.search.constants import SEARCH_BILLING_METER_KEY
from apps.services.search.models import SearchGlobalConfig, SearchProvider
from apps.tabtinspace.signals import create_default_organization
from apps.users.auth.models import UserSession
from apps.users.auth.utils import generate_jwt_token

User = get_user_model()

BASE = "/api/auth/admin/search"


def _auth(token: str) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {token}"}


class SearchAdminApiTests(TestCase):
    databases = {"default"}

    def setUp(self):
        post_save.disconnect(create_default_organization, sender=User)
        self.client = Client()
        self.admin = User.objects.create_superuser(
            username="search_admin",
            email="search_admin@test.com",
            password="admin123",
        )
        self.staff = User.objects.create_user(
            username="search_staff",
            email="search_staff@test.com",
            password="staff123",
            is_staff=True,
        )
        self.admin_token = self._issue_access_token(self.admin)
        self.staff_token = self._issue_access_token(self.staff)

        SearchProvider.objects.update_or_create(
            provider_key="bocha",
            defaults={
                "provider_type": "bocha",
                "display_name": "博查搜索",
                "base_url": "https://api.bocha.cn/v1/web-search",
                "api_key": "sk-test-bocha",
                "api_key_env_name": "BOCHA_API_KEY",
                "request_timeout_sec": 30,
                "is_active": True,
                "priority": 100,
                "capabilities_config": {"summary": True},
                "extra_config": {},
            },
        )
        SearchGlobalConfig.objects.all().delete()
        SearchGlobalConfig.objects.create(
            default_provider_key="bocha",
            default_count=8,
            default_summary_enabled=True,
            default_freshness="noLimit",
        )

    def tearDown(self):
        post_save.connect(create_default_organization, sender=User)
        super().tearDown()

    def _issue_access_token(self, user: User) -> str:
        session = UserSession.objects.create(
            user=user,
            session_key=f"search-admin-{user.id[:8]}",
            session_type="web",
            ip_address="127.0.0.1",
            user_agent="Django Test Client",
            device_info={"device": "test"},
            expires_at=timezone.now() + timedelta(hours=24),
            is_active=True,
        )
        return generate_jwt_token(user, session_key=session.session_key)

    def test_staff_can_get_config_and_provider_list(self):
        config_resp = self.client.get(f"{BASE}/config", **_auth(self.staff_token))
        self.assertEqual(config_resp.status_code, 200)
        self.assertEqual(config_resp.json()["default_provider_key"], "bocha")

        provider_resp = self.client.get(f"{BASE}/providers", **_auth(self.staff_token))
        self.assertEqual(provider_resp.status_code, 200)
        providers = provider_resp.json()["providers"]
        self.assertGreaterEqual(len(providers), 1)
        self.assertEqual(providers[0]["provider_key"], "bocha")

    def test_superuser_can_update_config(self):
        resp = self.client.put(
            f"{BASE}/config",
            data=json.dumps(
                {
                    "default_provider_key": "bocha",
                    "default_count": 12,
                    "default_summary_enabled": False,
                    "default_freshness": "oneWeek",
                }
            ),
            content_type="application/json",
            **_auth(self.admin_token),
        )
        self.assertEqual(resp.status_code, 200)
        payload = resp.json()
        self.assertEqual(payload["default_count"], 12)
        self.assertFalse(payload["default_summary_enabled"])
        self.assertEqual(payload["default_freshness"], "oneWeek")

    def test_billing_overview_only_counts_search_meter(self):
        BillingUsageEvent.objects.create(
            organization_id="ws_search_bill_001",
            user_id="u1",
            meter_key=SEARCH_BILLING_METER_KEY,
            quantity=Decimal("1"),
            unit="request",
            unit_price=Decimal("0.1"),
            amount=Decimal("0.1"),
            currency="CREDITS",
            provider_key="bocha",
            biz_type="orchestration.web_search",
            biz_id="search_evt_001",
            idempotency_key="search_evt_001",
        )
        BillingUsageEvent.objects.create(
            organization_id="ws_other_001",
            user_id="u2",
            meter_key="llm.tokens",
            quantity=Decimal("10"),
            unit="token",
            unit_price=Decimal("0.1"),
            amount=Decimal("1"),
            currency="CREDITS",
            provider_key="openai",
            biz_type="chat",
            biz_id="llm_evt_001",
            idempotency_key="llm_evt_001",
        )

        resp = self.client.get(f"{BASE}/billing/overview?days=30", **_auth(self.staff_token))
        self.assertEqual(resp.status_code, 200)
        payload = resp.json()
        self.assertEqual(payload["summary"]["total_requests"], 1)
        self.assertEqual(Decimal(str(payload["summary"]["total_amount"])), Decimal("0.1"))
        self.assertEqual(payload["by_provider"][0]["provider_key"], "bocha")
