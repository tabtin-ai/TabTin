"""
Billing Admin API 端点测试
覆盖：权限校验、钱包管理、计费概览/事件、定价 CRUD、预算策略 CRUD、会员管理、分页边界。
"""

import json
from datetime import timedelta
from decimal import Decimal
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import Client, RequestFactory, TestCase
from django.utils import timezone

from apps.services.billing.api_admin import _paginate
from apps.services.billing.models import (
    BillingAdminAuditLog,
    BillingAnomalyAlert,
    BillingBudgetPolicy,
    BillingUsageEvent,
    MeterPricing,
    OrganizationBillingPolicy,
    OrganizationCreditLedger,
    OrganizationStorageUsage,
)
from apps.tabtinspace.models import Organization
from apps.users.auth.models import (
    AdminAccount,
    AdminSensitiveActionLog,
    RegistrationInviteCode,
    RegistrationInviteRedemption,
)
from apps.users.auth.session_manager import SessionManager
from apps.users.auth.utils import generate_jwt_token
from apps.users.membership.models import MembershipTier, OrganizationMembership
from apps.users.wallet.models import OrganizationWallet
from apps.services.billing.tests.org_test_utils import org_id_for

User = get_user_model()

BASE = "/api/services/billing"


def _auth(token: str) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {token}"}


def _ensure_admin_account(user) -> AdminAccount:
    account, _ = AdminAccount.objects.get_or_create(
        user=user,
        defaults={
            "display_name": user.get_display_name() if hasattr(user, "get_display_name") else user.username,
            "status": AdminAccount.STATUS_ACTIVE,
            "admin_login_enabled": True,
            "created_by": user,
        },
    )
    if account.status != AdminAccount.STATUS_ACTIVE or not account.admin_login_enabled:
        account.status = AdminAccount.STATUS_ACTIVE
        account.admin_login_enabled = True
        account.save(update_fields=["status", "admin_login_enabled", "updated_at"])
    return account


class BillingAdminPermissionTests(TestCase):
    """非超级管理员访问 admin 端点应返回 403。"""

    databases = {"default"}

    def setUp(self):
        self.client = Client()
        self.normal_user = User.objects.create_user(
            username="normal", email="normal@test.com", password="pass123"
        )
        self.token = generate_jwt_token(self.normal_user)

    def test_non_superuser_wallets_list(self):
        resp = self.client.get(f"{BASE}/admin/wallets/organizations", **_auth(self.token))
        self.assertIn(resp.status_code, (403, 422))

    def test_non_superuser_billing_overview(self):
        resp = self.client.get(f"{BASE}/admin/billing/overview", **_auth(self.token))
        self.assertIn(resp.status_code, (403, 422))

    def test_non_superuser_pricing_list(self):
        resp = self.client.get(f"{BASE}/admin/billing/pricing", **_auth(self.token))
        self.assertIn(resp.status_code, (403, 422))


class WalletAdminTests(TestCase):
    """钱包管理端点测试。"""

    databases = {"default"}

    def setUp(self):
        self.client = Client()
        self.admin = User.objects.create_superuser(
            username="admin", email="admin@test.com", password="admin123"
        )
        self.token = generate_jwt_token(self.admin)
        self.ws_wallet = OrganizationWallet.objects.create(organization_id=org_id_for("ws_test_001"), credits=500, credits_precise=Decimal("500"))

    def test_list_organization_wallets(self):
        resp = self.client.get(f"{BASE}/admin/wallets/organizations", **_auth(self.token))
        self.assertEqual(resp.status_code, 200)
        data = resp.json()["data"]
        self.assertGreaterEqual(data["total"], 1)
        ids = [w["id"] for w in data["wallets"]]
        self.assertIn(str(self.ws_wallet.id), ids)

    def test_wallet_detail(self):
        resp = self.client.get(f"{BASE}/admin/wallets/{self.ws_wallet.id}", **_auth(self.token))
        self.assertEqual(resp.status_code, 200)
        data = resp.json()["data"]
        self.assertEqual(data["wallet"]["type"], "organization")

    def test_wallet_detail_404(self):
        resp = self.client.get(f"{BASE}/admin/wallets/nonexistent-id", **_auth(self.token))
        self.assertEqual(resp.status_code, 404)

    def test_adjust_wallet_positive(self):
        resp = self.client.post(
            f"{BASE}/admin/wallets/{self.ws_wallet.id}/adjust",
            data=json.dumps({"amount": "200", "description": "测试充值"}),
            content_type="application/json",
            **_auth(self.token),
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()["data"]
        self.assertEqual(data["balance_after"], "1200.0000")

    def test_adjust_wallet_requires_reason(self):
        resp = self.client.post(
            f"{BASE}/admin/wallets/{self.ws_wallet.id}/adjust",
            data=json.dumps({"amount": "200"}),
            content_type="application/json",
            **_auth(self.token),
        )
        self.assertEqual(resp.status_code, 400)

    def test_adjust_wallet_negative_over_balance(self):
        resp = self.client.post(
            f"{BASE}/admin/wallets/{self.ws_wallet.id}/adjust",
            data=json.dumps({"amount": "-9999"}),
            content_type="application/json",
            **_auth(self.token),
        )
        self.assertEqual(resp.status_code, 400)

    def test_adjust_wallet_invalid_amount(self):
        resp = self.client.post(
            f"{BASE}/admin/wallets/{self.ws_wallet.id}/adjust",
            data=json.dumps({"amount": "abc"}),
            content_type="application/json",
            **_auth(self.token),
        )
        self.assertEqual(resp.status_code, 400)

    def test_keyword_search(self):
        resp = self.client.get(
            f"{BASE}/admin/wallets/organizations?keyword=ws_test_001", **_auth(self.token)
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()["data"]
        self.assertEqual(data["total"], 1)


class CreditLedgerAdminTests(TestCase):
    databases = {"default"}

    def setUp(self):
        self.client = Client()
        self.admin = User.objects.create_superuser(
            username="admin_credit_ledger", email="admin_credit_ledger@test.com", password="admin123"
        )
        self.token = generate_jwt_token(self.admin)
        self.organization_id = org_id_for("ws_credit_ledger_001")
        self.wallet = OrganizationWallet.objects.create(
            organization_id=self.organization_id,
            credits=100,
            credits_precise=Decimal("100.0000"),
        )

    def test_organization_credit_ledger_list(self):
        OrganizationCreditLedger.objects.create(
            organization_id=self.organization_id,
            ledger_type="system_gift",
            amount_points=Decimal("20.0000"),
            balance_after_points=Decimal("120.0000"),
            reason="测试赠送",
            operator_user_id=str(self.admin.id),
        )
        resp = self.client.get(
            f"{BASE}/admin/billing/organizations/{self.organization_id}/credit-ledger",
            **_auth(self.token),
        )
        self.assertEqual(resp.status_code, 200, msg=resp.content)
        data = resp.json()["data"]
        self.assertGreaterEqual(data["total"], 1)
        self.assertTrue(any(item["ledger_type"] == "system_gift" for item in data["items"]))

    def test_organization_credit_ledger_adjust_requires_reason(self):
        resp = self.client.post(
            f"{BASE}/admin/billing/organizations/{self.organization_id}/credit-ledger/adjust",
            data=json.dumps({
                "action": "grant",
                "amount_points": "10",
            }),
            content_type="application/json",
            **_auth(self.token),
        )
        self.assertEqual(resp.status_code, 400, msg=resp.content)

    def test_organization_credit_ledger_adjust_writes_ledger(self):
        before_count = OrganizationCreditLedger.objects.filter(organization_id=self.organization_id).count()
        resp = self.client.post(
            f"{BASE}/admin/billing/organizations/{self.organization_id}/credit-ledger/adjust",
            data=json.dumps({
                "action": "grant",
                "amount_points": "30",
                "reason": "手工赠送",
            }),
            content_type="application/json",
            **_auth(self.token),
        )
        self.assertEqual(resp.status_code, 200, msg=resp.content)
        after_count = OrganizationCreditLedger.objects.filter(organization_id=self.organization_id).count()
        self.assertEqual(after_count, before_count + 1)
        ledger = OrganizationCreditLedger.objects.filter(organization_id=self.organization_id).order_by("-created_at").first()
        self.assertIsNotNone(ledger)
        self.assertEqual(ledger.ledger_type, "system_gift")
        self.assertEqual(ledger.reason, "手工赠送")

    def test_organization_credit_ledger_adjust_writes_sensitive_audit(self):
        before_count = AdminSensitiveActionLog.objects.count()
        resp = self.client.post(
            f"{BASE}/admin/billing/organizations/{self.organization_id}/credit-ledger/adjust",
            data=json.dumps({
                "action": "grant",
                "amount_points": "15",
                "reason": "审计验证",
                "ticket_id": "TICKET-1",
            }),
            content_type="application/json",
            **_auth(self.token),
        )
        self.assertEqual(resp.status_code, 200, msg=resp.content)
        self.assertEqual(AdminSensitiveActionLog.objects.count(), before_count + 1)
        audit = AdminSensitiveActionLog.objects.order_by("-created_at").first()
        self.assertIsNotNone(audit)
        self.assertEqual(audit.permission_code, "credit:grant")
        self.assertEqual(audit.action, "credit_ledger.grant")
        self.assertEqual(audit.target_type, "organization")
        self.assertEqual(audit.target_id, self.organization_id)
        self.assertEqual(audit.reason, "审计验证")

    def test_wallet_money_adjust_does_not_create_credit_ledger_if_it_is_yuan(self):
        before_count = OrganizationCreditLedger.objects.count()
        resp = self.client.post(
            f"{BASE}/admin/wallets/{self.wallet.id}/adjust",
            data=json.dumps({
                "amount": "10",
                "amount_unit": "yuan",
                "reason": "财务金额调账",
            }),
            content_type="application/json",
            **_auth(self.token),
        )
        self.assertEqual(resp.status_code, 400, msg=resp.content)
        self.assertEqual(OrganizationCreditLedger.objects.count(), before_count)


class MembershipAdminTests(TestCase):
    """会员管理 Admin 端点测试。"""

    databases = {"default"}

    def setUp(self):
        from django.db.models.signals import post_save
        from django.test import RequestFactory

        from apps.tabtinspace.signals import create_default_organization
        from apps.users.auth.models import RegistrationInviteCode, RegistrationInviteRedemption
        from apps.users.auth.session_manager import SessionManager

        post_save.disconnect(create_default_organization, sender=User)
        self.addCleanup(lambda: post_save.connect(create_default_organization, sender=User))

        self.client = Client()
        self.factory = RequestFactory()
        self.admin = User.objects.create_superuser(
            username="admin_membership", email="admin_membership@test.com", password="admin123"
        )
        _ensure_admin_account(self.admin)
        invite = RegistrationInviteCode.objects.create(
            code="5702-MEMBERSHIP-ADMIN",
            description="test invite for membership admin apis",
            created_by=self.admin,
        )
        RegistrationInviteRedemption.objects.create(
            invite_code=invite,
            user=self.admin,
            entrypoint="test",
        )
        self.owner = User.objects.create_user(
            username="owner_membership", email="owner_membership@test.com", password="pass123"
        )
        session = SessionManager.create_session(
            user=self.admin,
            request=self.factory.get("/"),
            session_type="web",
            expire_hours=24,
        )
        self.token = generate_jwt_token(self.admin, session_key=session.session_key)
        self.free_tier = MembershipTier.objects.create(tier_type="free", name="免费版")
        self.pro_tier = MembershipTier.objects.create(tier_type="pro", name="专业版")
        self.organization = Organization.objects.create(name="测试团队会员", owner=self.owner)
        self.membership = OrganizationMembership.objects.create(
            organization_id=str(self.organization.id),
            tier=self.free_tier,
            status="active",
            start_date=timezone.now(),
            end_date=timezone.now() + timedelta(days=30),
            auto_renew=False,
        )

    def test_list_memberships_returns_organization_membership(self):
        resp = self.client.get(
            f"{BASE}/admin/membership/users?page=1&page_size=20",
            **_auth(self.token),
        )

        self.assertEqual(resp.status_code, 200, msg=resp.content)
        data = resp.json()["data"]
        self.assertEqual(data["total"], 1)
        self.assertEqual(data["memberships"][0]["id"], str(self.membership.id))
        self.assertEqual(data["memberships"][0]["username"], "测试团队会员")
        self.assertEqual(data["memberships"][0]["email"], "owner_membership@test.com")

    def test_subscription_detail_returns_same_catalog_snapshot_as_electron(self):
        response = self.client.get(
            f"{BASE}/admin/membership/organizations/{self.organization.id}/subscription",
            **_auth(self.token),
        )

        self.assertEqual(response.status_code, 200, msg=response.content)
        data = response.json()["data"]
        self.assertEqual(data["membership"]["membership_id"], str(self.membership.id))
        self.assertEqual(data["membership"]["tier"]["id"], str(self.free_tier.id))
        self.assertIn("included_credits", data)
        self.assertIn("wallet", data)
        self.assertIn("entitlements", data)

    @patch(
        "apps.services.billing.api_admin.SubscriptionOrderService.create_upgrade_order"
    )
    def test_create_upgrade_order_uses_admin_as_requester(self, create_order):
        create_order.return_value = {
            "order_id": "upgrade-order-1",
            "order_no": "MU-1",
            "payable_amount": "12.34",
        }

        response = self.client.post(
            f"{BASE}/admin/membership/organizations/{self.organization.id}/upgrade",
            data=json.dumps({
                "target_tier_id": str(self.pro_tier.id),
                "billing_cycle": "monthly",
                "quote_token": "signed-quote",
            }),
            content_type="application/json",
            **_auth(self.token),
        )

        self.assertEqual(response.status_code, 200, msg=response.content)
        create_order.assert_called_once_with(
            user=self.admin,
            organization_id=str(self.organization.id),
            target_tier_id=str(self.pro_tier.id),
            billing_cycle="monthly",
            quote_token="signed-quote",
        )
        self.assertTrue(
            BillingAdminAuditLog.objects.filter(
                action="membership_upgrade_order_create",
                organization_id=str(self.organization.id),
            ).exists()
        )

    def test_list_memberships_handles_legacy_non_uuid_organization_id(self):
        legacy_membership = OrganizationMembership.objects.create(
            organization_id="legacy_ws_001",
            tier=self.pro_tier,
            status="active",
            start_date=timezone.now(),
            end_date=timezone.now() + timedelta(days=30),
        )

        resp = self.client.get(
            f"{BASE}/admin/membership/users?keyword=legacy_ws_001",
            **_auth(self.token),
        )

        self.assertEqual(resp.status_code, 200, msg=resp.content)
        data = resp.json()["data"]
        self.assertEqual(data["total"], 1)
        self.assertEqual(data["memberships"][0]["id"], str(legacy_membership.id))
        self.assertEqual(data["memberships"][0]["username"], "legacy_ws_001")

    def test_update_membership_changes_tier_and_status(self):
        resp = self.client.put(
            f"{BASE}/admin/membership/users/{self.membership.id}",
            data=json.dumps({
                "tier_type": "pro",
                "status": "expired",
                "auto_renew": True,
                "end_date": "2026-07-01",
            }),
            content_type="application/json",
            **_auth(self.token),
        )

        self.assertEqual(resp.status_code, 200, msg=resp.content)
        self.membership.refresh_from_db()
        self.assertEqual(self.membership.tier.tier_type, "pro")
        self.assertEqual(self.membership.status, "expired")
        self.assertTrue(self.membership.auto_renew)
        data = resp.json()["data"]
        self.assertEqual(data["tier_type"], "pro")
        self.assertEqual(data["status"], "expired")

    def test_cancel_auto_renew_requires_reason(self):
        self.membership.auto_renew = True
        self.membership.save(update_fields=["auto_renew", "updated_at"])

        resp = self.client.put(
            f"{BASE}/admin/membership/users/{self.membership.id}",
            data=json.dumps({"auto_renew": False, "reason": ""}),
            content_type="application/json",
            **_auth(self.token),
        )
        self.assertEqual(resp.status_code, 400, msg=resp.content)
        self.membership.refresh_from_db()
        self.assertTrue(self.membership.auto_renew)

    def test_cancel_auto_renew_writes_sensitive_audit_with_reason_and_ticket(self):
        self.membership.auto_renew = True
        self.membership.save(update_fields=["auto_renew", "updated_at"])
        before_count = AdminSensitiveActionLog.objects.count()

        resp = self.client.put(
            f"{BASE}/admin/membership/users/{self.membership.id}",
            data=json.dumps({
                "auto_renew": False,
                "reason": "组织详情 SensitiveConfirm 关闭自动续费",
                "ticket_id": "PR5802-RENEW",
            }),
            content_type="application/json",
            **_auth(self.token),
        )
        self.assertEqual(resp.status_code, 200, msg=resp.content)
        self.membership.refresh_from_db()
        self.assertFalse(self.membership.auto_renew)

        self.assertEqual(AdminSensitiveActionLog.objects.count(), before_count + 1)
        audit = AdminSensitiveActionLog.objects.filter(
            action="billing.membership.auto_renew.cancel",
            target_id=str(self.membership.id),
        ).first()
        self.assertIsNotNone(audit)
        self.assertEqual(audit.reason, "组织详情 SensitiveConfirm 关闭自动续费")
        self.assertEqual(audit.ticket_id, "PR5802-RENEW")
        self.assertEqual(audit.before_json.get("auto_renew"), True)
        self.assertEqual(audit.after_json.get("auto_renew"), False)

        billing_audit = BillingAdminAuditLog.objects.filter(
            action="membership_update",
            target_id=str(self.membership.id),
        ).order_by("-created_at").first()
        self.assertIsNotNone(billing_audit)
        self.assertEqual(
            billing_audit.detail.get("reason"),
            "组织详情 SensitiveConfirm 关闭自动续费",
        )
        self.assertEqual(billing_audit.detail.get("ticket_id"), "PR5802-RENEW")


class BillingOverviewTests(TestCase):
    """计费概览端点测试。"""

    databases = {"default"}

    def setUp(self):
        self.client = Client()
        self.admin = User.objects.create_superuser(
            username="admin_ov", email="adminov@test.com", password="admin123"
        )
        self.token = generate_jwt_token(self.admin)
        BillingUsageEvent.objects.create(
            organization_id=org_id_for("ws_ov_001"),
            user_id="u1",
            meter_key="llm.token",
            quantity=Decimal("100"),
            unit="token",
            unit_price=Decimal("0.001"),
            amount=Decimal("0.1"),
        )

    def test_overview_returns_aggregates(self):
        resp = self.client.get(f"{BASE}/admin/billing/overview?days=30", **_auth(self.token))
        self.assertEqual(resp.status_code, 200)
        data = resp.json()["data"]
        self.assertEqual(data["total_events"], 1)
        self.assertIn("by_meter", data)
        self.assertIn("trends", data)


class BillingEventTests(TestCase):
    """计费事件列表 + 导出测试。"""

    databases = {"default"}

    def setUp(self):
        self.client = Client()
        self.admin = User.objects.create_superuser(
            username="admin_ev", email="adminev@test.com", password="admin123"
        )
        self.token = generate_jwt_token(self.admin)
        for i in range(3):
            BillingUsageEvent.objects.create(
                organization_id=org_id_for("ws_ev_001"),
                user_id="u1",
                meter_key="storage.bytes" if i % 2 == 0 else "llm.token",
                quantity=Decimal("10"),
                unit="byte" if i % 2 == 0 else "token",
                unit_price=Decimal("0.01"),
                amount=Decimal("0.1"),
            )

    def test_list_events(self):
        resp = self.client.get(f"{BASE}/admin/billing/events", **_auth(self.token))
        self.assertEqual(resp.status_code, 200)
        data = resp.json()["data"]
        self.assertGreaterEqual(data["total"], 3)
        self.assertIn("organization_name", data["events"][0])
        self.assertIn("username", data["events"][0])

    def test_list_events_includes_organization_and_user_names(self):
        owner = User.objects.create_user(
            username="event_owner",
            email="event_owner@test.com",
            password="pass123",
            nickname="事件负责人",
        )
        organization = Organization.objects.create(name="事件测试组织", owner=owner)
        BillingUsageEvent.objects.create(
            organization_id=str(organization.id),
            user_id=str(owner.id),
            meter_key="llm.tokens",
            quantity=Decimal("10"),
            unit="token",
            unit_price=Decimal("0.01"),
            amount=Decimal("0.1"),
        )

        resp = self.client.get(
            f"{BASE}/admin/billing/events?organization_id={organization.id}",
            **_auth(self.token),
        )
        self.assertEqual(resp.status_code, 200)
        events = resp.json()["data"]["events"]
        matched = next(
            (item for item in events if item["organization_id"] == str(organization.id)),
            None,
        )
        self.assertIsNotNone(matched)
        self.assertEqual(matched["organization_name"], "事件测试组织")
        self.assertEqual(matched["username"], "事件负责人")

    def test_list_events_filter_meter_key(self):
        resp = self.client.get(
            f"{BASE}/admin/billing/events?meter_key=storage.bytes", **_auth(self.token)
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()["data"]
        self.assertEqual(data["total"], 2)

    def test_list_events_filter_has_charge(self):
        BillingUsageEvent.objects.create(
            organization_id=org_id_for("ws_ev_charge"),
            user_id="u_charge",
            meter_key="llm.tokens",
            quantity=Decimal("100"),
            unit="token",
            unit_price=Decimal("0.01"),
            amount=Decimal("1.0"),
        )
        BillingUsageEvent.objects.create(
            organization_id=org_id_for("ws_ev_usage"),
            user_id="u_usage",
            meter_key="storage.bytes",
            quantity=Decimal("1024"),
            unit="byte",
            unit_price=Decimal("0"),
            amount=Decimal("0"),
        )

        charged = self.client.get(
            f"{BASE}/admin/billing/events?has_charge=true", **_auth(self.token)
        )
        self.assertEqual(charged.status_code, 200)
        charged_events = charged.json()["data"]["events"]
        self.assertTrue(charged_events)
        self.assertTrue(all(Decimal(item["amount"]) > 0 for item in charged_events))

        usage = self.client.get(
            f"{BASE}/admin/billing/events?has_charge=false", **_auth(self.token)
        )
        self.assertEqual(usage.status_code, 200)
        usage_events = usage.json()["data"]["events"]
        self.assertTrue(usage_events)
        self.assertTrue(all(Decimal(item["amount"]) <= 0 for item in usage_events))

    def test_export_csv(self):
        resp = self.client.get(f"{BASE}/admin/billing/events/export", **_auth(self.token))
        self.assertEqual(resp.status_code, 200)
        self.assertIn("text/csv", resp["Content-Type"])
        content = resp.content.decode("utf-8")
        lines = content.strip().split("\n")
        self.assertGreaterEqual(len(lines), 4)  # header + 3 rows


class BillingSceneBreakdownTests(TestCase):
    """子 Agent 计费收尾（任务 B）：报表按 scene_key（活类型）下钻，金额总数不变。"""

    databases = {"default"}

    def setUp(self):
        self.client = Client()
        self.admin = User.objects.create_superuser(
            username="admin_scene", email="adminscene@test.com", password="admin123"
        )
        self.token = generate_jwt_token(self.admin)
        # 4 个 system scene + 一条空 scene（非 LLM / 历史）各一条；_sub_agent 再加一条
        # 验证聚合是把同 scene 多条相加（而非去重/漏算）。
        rows = [
            ("_main_chat", Decimal("0.50")),
            ("_sub_agent", Decimal("0.10")),
            ("_sub_agent", Decimal("0.20")),
            ("_compact", Decimal("0.05")),
            ("_summary_judge", Decimal("0.03")),
            ("", Decimal("0.07")),
        ]
        for sk, amount in rows:
            BillingUsageEvent.objects.create(
                organization_id=org_id_for("ws_scene_001"),
                user_id="u1",
                meter_key="llm.tokens",
                quantity=Decimal("100"),
                unit="token",
                unit_price=Decimal("0.001"),
                amount=amount,
                scene_key=sk,
            )
        # 总额 = 0.50+0.10+0.20+0.05+0.03+0.07 = 0.95
        self.expected_total = Decimal("0.95")

    def test_overview_by_scene_sums_to_total_no_double_count(self):
        resp = self.client.get(f"{BASE}/admin/billing/overview?days=30", **_auth(self.token))
        self.assertEqual(resp.status_code, 200)
        data = resp.json()["data"]

        self.assertIn("by_scene", data)
        total_amount = Decimal(data["total_amount"])
        self.assertEqual(total_amount, self.expected_total)

        # ★ 关键：按 scene 切分后金额总数恒等于不切分总数（不重复扣、不漏算）
        by_scene_sum = sum(Decimal(r["total_amount"]) for r in data["by_scene"])
        self.assertEqual(by_scene_sum, total_amount)
        # 与 by_meter 切分口径也一致（同一份金额的两种切面）
        by_meter_sum = sum(Decimal(r["total_amount"]) for r in data["by_meter"])
        self.assertEqual(by_meter_sum, total_amount)

        # _sub_agent 桶是两条之和（0.10 + 0.20 = 0.30），证明聚合相加而非去重
        sub = next(r for r in data["by_scene"] if r["scene_key"] == "_sub_agent")
        self.assertEqual(Decimal(sub["total_amount"]), Decimal("0.30"))
        self.assertEqual(sub["total_events"], 2)

        # 友好标签映射正确
        labels = {r["scene_key"]: r["scene_label"] for r in data["by_scene"]}
        self.assertEqual(labels["_main_chat"], "主管对话")
        self.assertEqual(labels["_sub_agent"], "子 Agent")
        self.assertEqual(labels["_compact"], "后台压缩")
        self.assertEqual(labels["_summary_judge"], "摘要评判")
        self.assertEqual(labels[""], "未分类（非 LLM / 历史数据）")

    def test_events_filter_by_scene_key(self):
        resp = self.client.get(
            f"{BASE}/admin/billing/events?scene_key=_sub_agent", **_auth(self.token)
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()["data"]
        self.assertEqual(data["total"], 2)
        for item in data["events"]:
            self.assertEqual(item["scene_key"], "_sub_agent")
            self.assertEqual(item["scene_label"], "子 Agent")

    def test_export_csv_has_scene_columns(self):
        resp = self.client.get(f"{BASE}/admin/billing/events/export", **_auth(self.token))
        self.assertEqual(resp.status_code, 200)
        content = resp.content.decode("utf-8")
        header = content.strip().split("\n")[0]
        self.assertIn("scene_key", header)
        self.assertIn("scene_label", header)


class SceneKeyDataLayerTests(TestCase):
    """子 Agent 计费收尾（任务 B）数据层验证 —— 不走 HTTP/鉴权，可在隔离
    sqlite settings（settings_billing_test）本地跑，证明三件事：
      ① 按 scene_key 切分后金额总数一分不变（不漏算）；
      ② 不引入任何重复扣费（同 scene 多条相加、写入侧不新增扣费调用）；
      ③ scene_key 经 record_event / consume_credits_for_llm 正确落库，且不改金额。
    """

    databases = {"default"}

    def test_record_event_persists_scene_key(self):
        from apps.services.billing.services.usage_service import BillingUsageService
        ev = BillingUsageService.record_event(
            organization_id=org_id_for("ws_scene_dl"),
            user_id="u1",
            meter_key="llm.tokens",
            quantity=Decimal("100"),
            unit="token",
            unit_price=Decimal("0.001"),
            amount=Decimal("0.10"),
            scene_key="_sub_agent",
            biz_id="b-scene-1",
            idempotency_key="idem-scene-dl-1",
        )
        self.assertEqual(ev.scene_key, "_sub_agent")

    def test_record_event_scene_key_defaults_empty(self):
        from apps.services.billing.services.usage_service import BillingUsageService
        ev = BillingUsageService.record_event(
            organization_id=org_id_for("ws_scene_dl"),
            user_id="u1",
            meter_key="llm.tokens",
            quantity=Decimal("100"),
            unit="token",
            unit_price=Decimal("0.001"),
            amount=Decimal("0.10"),
            biz_id="b-scene-2",
            idempotency_key="idem-scene-dl-2",
        )
        self.assertEqual(ev.scene_key, "")

    def test_by_scene_aggregation_equals_total_no_double_count(self):
        """★ 金额不变 + 不双扣的核心断言（复刻 overview 端点的聚合口径）。"""
        from django.db.models import Count, Sum

        rows = [
            ("_main_chat", Decimal("0.50")),
            ("_sub_agent", Decimal("0.10")),
            ("_sub_agent", Decimal("0.20")),  # 同 scene 两条 → 验证相加非去重
            ("_compact", Decimal("0.05")),
            ("_summary_judge", Decimal("0.03")),
            ("", Decimal("0.07")),            # 未分类桶（非 LLM/历史）
        ]
        for i, (sk, amount) in enumerate(rows):
            BillingUsageEvent.objects.create(
                organization_id=org_id_for("ws_scene_agg"),
                user_id="u1",
                meter_key="llm.tokens",
                quantity=Decimal("100"),
                unit="token",
                unit_price=Decimal("0.001"),
                amount=amount,
                scene_key=sk,
                idempotency_key=f"idem-agg-{i}",
            )

        qs = BillingUsageEvent.objects.filter(organization_id=org_id_for("ws_scene_agg"))
        total = qs.aggregate(t=Sum("amount"))["t"]
        self.assertEqual(total, Decimal("0.95"))

        by_scene = list(qs.values("scene_key").annotate(s=Sum("amount"), c=Count("id")))
        by_meter = list(qs.values("meter_key").annotate(s=Sum("amount")))

        # ① 切分后总额恒等（scene 维度 / meter 维度都等于不切分总额）
        self.assertEqual(sum(r["s"] for r in by_scene), total)
        self.assertEqual(sum(r["s"] for r in by_meter), total)

        # ② 同 scene 多条是「相加」而非「去重/覆盖」——_sub_agent = 0.10 + 0.20
        sub = next(r for r in by_scene if r["scene_key"] == "_sub_agent")
        self.assertEqual(sub["s"], Decimal("0.30"))
        self.assertEqual(sub["c"], 2)

        # 每条事件恰好归一个 scene 桶 → 桶事件数之和 == 总事件数（无重复计）
        self.assertEqual(sum(r["c"] for r in by_scene), qs.count())

    def test_scene_label_mapping(self):
        from apps.services.billing.api_admin import _scene_label
        self.assertEqual(_scene_label("_main_chat"), "主管对话")
        self.assertEqual(_scene_label("_sub_agent"), "子 Agent")
        self.assertEqual(_scene_label("_compact"), "后台压缩")
        self.assertEqual(_scene_label("_summary_judge"), "摘要评判")
        self.assertEqual(_scene_label(""), "未分类（非 LLM / 历史数据）")
        # 业务 scene 回退 SCENES 注册表的中文 display_name（一次覆盖全量、永不漂移）
        self.assertEqual(_scene_label("title_generation"), "会话标题生成")
        # 完全未注册的 key 回退原值（_scene_label 永不抛错）
        self.assertEqual(_scene_label("totally_unknown_scene_xyz"), "totally_unknown_scene_xyz")

    def test_consume_credits_for_llm_scene_key_does_not_change_amount(self):
        """走真实扣费链路：scene_key 落库且金额与不带 scene_key 时逐分一致。"""
        from apps.services.billing.models import OrganizationBillingPolicy
        from apps.users.wallet.models import OrganizationWallet
        from apps.users.wallet.services.credits_service import CreditsService

        wt = org_id_for("ws_scene_consume")
        OrganizationBillingPolicy.objects.create(
            organization_id=wt,
            storage_billing_mode="paygo_only",
            llm_billing_mode="paygo_only",
            currency="CREDITS",
            is_active=True,
        )
        OrganizationWallet.objects.create(
            organization_id=wt, credits=1000, credits_precise=Decimal("1000.0000"),
        )

        model_config = {
            "provider_key": "openai",
            "model_name": "gpt-4o-mini",
            "input_price_per_1k": "0.01",
            "output_price_per_1k": "0",
        }

        # 调用 1：带 scene_key="_sub_agent"
        CreditsService.consume_credits_for_llm(
            "user-scene-1",
            input_tokens=1500,
            output_tokens=0,
            model_config=model_config,
            organization_id=wt,
            biz_id="consume-scene",
            idempotency_key="idem-consume-scene",
            scene_key="_sub_agent",
        )
        # 调用 2：完全相同但不带 scene_key
        CreditsService.consume_credits_for_llm(
            "user-scene-1",
            input_tokens=1500,
            output_tokens=0,
            model_config=model_config,
            organization_id=wt,
            biz_id="consume-noscene",
            idempotency_key="idem-consume-noscene",
        )

        ev_scene = BillingUsageEvent.objects.get(idempotency_key="idem-consume-scene")
        ev_noscene = BillingUsageEvent.objects.get(idempotency_key="idem-consume-noscene")

        # scene_key 正确落库
        self.assertEqual(ev_scene.scene_key, "_sub_agent")
        self.assertEqual(ev_noscene.scene_key, "")
        # ★ 金额完全一致：scene_key 是纯分类维度，绝不影响计费
        self.assertEqual(ev_scene.amount, ev_noscene.amount)
        self.assertGreater(ev_scene.amount, Decimal("0"))
        # 每次调用只产生一条扣费事件（不双扣）
        self.assertEqual(
            BillingUsageEvent.objects.filter(idempotency_key="idem-consume-scene").count(), 1,
        )


class PricingCRUDTests(TestCase):
    """定价规则 CRUD 测试。"""

    databases = {"default"}

    def setUp(self):
        self.client = Client()
        self.admin = User.objects.create_superuser(
            username="admin_pr", email="adminpr@test.com", password="admin123"
        )
        self.token = generate_jwt_token(self.admin)

    def _create_pricing(self, **overrides):
        payload = {
            "meter_key": "llm.token",
            "scope": "global",
            "unit": "token",
            "unit_price": "0.001",
            **overrides,
        }
        resp = self.client.post(
            f"{BASE}/admin/billing/pricing",
            data=json.dumps(payload),
            content_type="application/json",
            **_auth(self.token),
        )
        return resp

    def test_create(self):
        resp = self._create_pricing()
        self.assertEqual(resp.status_code, 200)
        pricing_id = resp.json()["data"]["id"]
        self.assertTrue(MeterPricing.objects.filter(id=pricing_id).exists())

    def test_list(self):
        self._create_pricing(meter_key="test.list.a")
        self._create_pricing(meter_key="test.list.b")
        resp = self.client.get(f"{BASE}/admin/billing/pricing", **_auth(self.token))
        self.assertEqual(resp.status_code, 200)
        data = resp.json()["data"]
        self.assertGreaterEqual(data["total"], 2)

    def test_update(self):
        resp = self._create_pricing(meter_key="test.update")
        pricing_id = resp.json()["data"]["id"]

        update_resp = self.client.put(
            f"{BASE}/admin/billing/pricing/{pricing_id}",
            data=json.dumps({"meter_key": "test.update", "unit_price": "0.005"}),
            content_type="application/json",
            **_auth(self.token),
        )
        self.assertEqual(update_resp.status_code, 200)
        pricing = MeterPricing.objects.get(id=pricing_id)
        self.assertEqual(pricing.unit_price, Decimal("0.005"))

    def test_update_effective_to_clear(self):
        """effective_to 传空字符串应清为 None。"""
        resp = self._create_pricing(meter_key="test.eff", effective_to="2030-12-31T23:59:59")
        pricing_id = resp.json()["data"]["id"]
        pricing = MeterPricing.objects.get(id=pricing_id)
        self.assertIsNotNone(pricing.effective_to)

        self.client.put(
            f"{BASE}/admin/billing/pricing/{pricing_id}",
            data=json.dumps({"meter_key": "test.eff", "unit_price": "0.001", "effective_to": ""}),
            content_type="application/json",
            **_auth(self.token),
        )
        pricing.refresh_from_db()
        self.assertIsNone(pricing.effective_to)

    def test_delete(self):
        resp = self._create_pricing(meter_key="test.delete")
        pricing_id = resp.json()["data"]["id"]

        del_resp = self.client.delete(
            f"{BASE}/admin/billing/pricing/{pricing_id}", **_auth(self.token)
        )
        self.assertEqual(del_resp.status_code, 200)
        self.assertFalse(MeterPricing.objects.filter(id=pricing_id).exists())

    def test_delete_not_found(self):
        resp = self.client.delete(
            f"{BASE}/admin/billing/pricing/00000000-0000-0000-0000-000000000000",
            **_auth(self.token),
        )
        self.assertEqual(resp.status_code, 404)

    def test_invalid_unit_price(self):
        resp = self._create_pricing(unit_price="abc")
        self.assertEqual(resp.status_code, 400)


class BudgetPolicyCRUDTests(TestCase):
    """预算策略 CRUD 测试。"""

    databases = {"default"}

    def setUp(self):
        self.client = Client()
        self.admin = User.objects.create_superuser(
            username="admin_bp", email="adminbp@test.com", password="admin123"
        )
        self.token = generate_jwt_token(self.admin)

    def _create_policy(self, organization_id=None, **overrides):
        # 默认参数不能在模块导入期调 org_id_for（会触发 DB 访问），延迟到调用时。
        if organization_id is None:
            organization_id = org_id_for("ws_bp_001")
        payload = {
            "organization_id": organization_id,
            "warning_threshold_percent": 80,
            "critical_threshold_percent": 100,
            **overrides,
        }
        return self.client.post(
            f"{BASE}/admin/billing/budget-policies",
            data=json.dumps(payload),
            content_type="application/json",
            **_auth(self.token),
        )

    def test_create(self):
        resp = self._create_policy()
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(BillingBudgetPolicy.objects.filter(organization_id=org_id_for("ws_bp_001")).exists())

    def test_create_invalid_threshold(self):
        resp = self._create_policy(
            organization_id=org_id_for("ws_bp_inv"),
            warning_threshold_percent=100,
            critical_threshold_percent=50,
        )
        self.assertEqual(resp.status_code, 400)

    def test_list(self):
        self._create_policy(organization_id=org_id_for("ws_bp_list1"))
        self._create_policy(organization_id=org_id_for("ws_bp_list2"))
        resp = self.client.get(f"{BASE}/admin/billing/budget-policies", **_auth(self.token))
        self.assertEqual(resp.status_code, 200)
        data = resp.json()["data"]
        self.assertGreaterEqual(data["total"], 2)

    def test_update(self):
        self._create_policy(organization_id=org_id_for("ws_bp_upd"))
        policy = BillingBudgetPolicy.objects.get(organization_id=org_id_for("ws_bp_upd"))
        resp = self.client.put(
            f"{BASE}/admin/billing/budget-policies/{policy.id}",
            data=json.dumps({
                "organization_id": org_id_for("ws_bp_upd"),
                "warning_threshold_percent": 60,
                "critical_threshold_percent": 90,
            }),
            content_type="application/json",
            **_auth(self.token),
        )
        self.assertEqual(resp.status_code, 200)
        policy.refresh_from_db()
        self.assertEqual(policy.warning_threshold_percent, Decimal("60"))

    def test_delete(self):
        self._create_policy(organization_id=org_id_for("ws_bp_del"))
        policy = BillingBudgetPolicy.objects.get(organization_id=org_id_for("ws_bp_del"))
        resp = self.client.delete(
            f"{BASE}/admin/billing/budget-policies/{policy.id}", **_auth(self.token)
        )
        self.assertEqual(resp.status_code, 200)
        self.assertFalse(BillingBudgetPolicy.objects.filter(organization_id=org_id_for("ws_bp_del")).exists())

    def test_delete_not_found(self):
        resp = self.client.delete(
            f"{BASE}/admin/billing/budget-policies/00000000-0000-0000-0000-000000000000",
            **_auth(self.token),
        )
        self.assertEqual(resp.status_code, 404)


class PaginateUtilTests(TestCase):
    """_paginate 工具函数单元测试。"""

    databases = {"default"}

    def setUp(self):
        for i in range(15):
            MeterPricing.objects.create(
                meter_key=f"paginate.test.{i}",
                unit_price=Decimal("0.01"),
            )

    def test_normal_page(self):
        qs = MeterPricing.objects.filter(meter_key__startswith="paginate.test.").order_by("meter_key")
        items, meta = _paginate(qs, page=1, page_size=5)
        self.assertEqual(len(items), 5)
        self.assertEqual(meta["total"], 15)
        self.assertEqual(meta["total_pages"], 3)
        self.assertEqual(meta["page"], 1)

    def test_page_zero_clamped_to_one(self):
        qs = MeterPricing.objects.filter(meter_key__startswith="paginate.test.").order_by("meter_key")
        items, meta = _paginate(qs, page=0, page_size=5)
        self.assertEqual(meta["page"], 1)
        self.assertEqual(len(items), 5)

    def test_page_size_zero_clamped_to_one(self):
        qs = MeterPricing.objects.filter(meter_key__startswith="paginate.test.").order_by("meter_key")
        items, meta = _paginate(qs, page=1, page_size=0)
        self.assertEqual(meta["page_size"], 1)
        self.assertEqual(len(items), 1)

    def test_page_size_exceeds_max(self):
        qs = MeterPricing.objects.filter(meter_key__startswith="paginate.test.").order_by("meter_key")
        items, meta = _paginate(qs, page=1, page_size=999, max_size=10)
        self.assertEqual(meta["page_size"], 10)
        self.assertEqual(len(items), 10)

    def test_last_page_partial(self):
        qs = MeterPricing.objects.filter(meter_key__startswith="paginate.test.").order_by("meter_key")
        items, meta = _paginate(qs, page=3, page_size=7)
        self.assertEqual(len(items), 1)  # 15 - 14 = 1
        self.assertEqual(meta["total_pages"], 3)

    def test_beyond_last_page_empty(self):
        qs = MeterPricing.objects.filter(meter_key__startswith="paginate.test.").order_by("meter_key")
        items, meta = _paginate(qs, page=100, page_size=5)
        self.assertEqual(len(items), 0)
        self.assertEqual(meta["total"], 15)


class AnomalyAlertAdminTests(TestCase):
    """异常告警列表默认按 created_at 排序（模型无 updated_at）。"""

    databases = {"default"}

    def setUp(self):
        self.client = Client()
        self.factory = RequestFactory()
        self.admin = User.objects.create_superuser(
            username="anomaly_admin",
            email="anomaly_admin@test.com",
            password="admin123",
        )
        AdminAccount.objects.create(
            user=self.admin,
            display_name="anomaly admin",
            status=AdminAccount.STATUS_ACTIVE,
            admin_login_enabled=True,
            created_by=self.admin,
        )
        invite = RegistrationInviteCode.objects.create(
            code="5702-ANOMALY-ADMIN",
            description="test invite for anomaly alert admin apis",
            created_by=self.admin,
        )
        RegistrationInviteRedemption.objects.create(
            invite_code=invite,
            user=self.admin,
            entrypoint="test",
        )
        session = SessionManager.create_session(
            user=self.admin,
            request=self.factory.get("/"),
            session_type="web",
            expire_hours=24,
        )
        self.token = generate_jwt_token(self.admin, session_key=session.session_key)
        self.org_a = org_id_for("ws_anomaly_a")
        self.org_b = org_id_for("ws_anomaly_b")
        BillingAnomalyAlert.objects.create(
            alert_type="spike",
            severity="warning",
            organization_id=self.org_a,
            metric_name="daily_spend",
            current_value=Decimal("100"),
            message="test unresolved alert",
            is_resolved=False,
        )
        BillingAnomalyAlert.objects.create(
            alert_type="pattern",
            severity="info",
            organization_id=self.org_b,
            metric_name="daily_spend",
            current_value=Decimal("1"),
            message="other org alert",
            is_resolved=False,
        )

    def test_list_anomaly_alerts_without_order_by(self):
        resp = self.client.get(
            f"{BASE}/admin/billing/anomaly/alerts",
            {"page": 1, "page_size": 5, "is_resolved": "false"},
            **_auth(self.token),
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()["data"]
        self.assertGreaterEqual(data["total"], 1)
        self.assertTrue(any(item["message"] == "test unresolved alert" for item in data["items"]))

    def test_list_anomaly_alerts_filters_by_organization_id(self):
        resp = self.client.get(
            f"{BASE}/admin/billing/anomaly/alerts",
            {
                "page": 1,
                "page_size": 50,
                "organization_id": self.org_a,
                "is_resolved": "false",
            },
            **_auth(self.token),
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()["data"]
        self.assertEqual(data["total"], 1)
        self.assertEqual(len(data["items"]), 1)
        self.assertEqual(data["items"][0]["organization_id"], self.org_a)
        self.assertEqual(data["items"][0]["message"], "test unresolved alert")

    def test_resolve_anomaly_alert_with_reason_writes_sensitive_audit(self):
        alert = BillingAnomalyAlert.objects.get(message="test unresolved alert")
        before_count = AdminSensitiveActionLog.objects.count()
        resp = self.client.put(
            f"{BASE}/admin/billing/anomaly/alerts/{alert.id}/resolve",
            data=json.dumps({
                "reason": "人工确认误报后消警",
                "ticket_id": "OPS-5702",
            }),
            content_type="application/json",
            **_auth(self.token),
        )
        self.assertEqual(resp.status_code, 200, msg=resp.content)
        alert.refresh_from_db()
        self.assertTrue(alert.is_resolved)
        self.assertIsNotNone(alert.resolved_at)
        self.assertEqual(AdminSensitiveActionLog.objects.count(), before_count + 1)
        audit = AdminSensitiveActionLog.objects.order_by("-created_at").first()
        self.assertIsNotNone(audit)
        self.assertEqual(audit.permission_code, "anomaly_alert:resolve")
        self.assertEqual(audit.action, "anomaly_alert.resolve")
        self.assertEqual(audit.target_id, str(alert.id))
        self.assertEqual(audit.reason, "人工确认误报后消警")
        self.assertEqual(audit.ticket_id, "OPS-5702")

    def test_resolve_anomaly_alert_without_reason_still_succeeds(self):
        alert = BillingAnomalyAlert.objects.create(
            alert_type="pattern",
            severity="info",
            metric_name="daily_spend",
            current_value=Decimal("1"),
            message="resolve without reason",
            is_resolved=False,
        )
        before_count = AdminSensitiveActionLog.objects.count()
        resp = self.client.put(
            f"{BASE}/admin/billing/anomaly/alerts/{alert.id}/resolve",
            data=json.dumps({}),
            content_type="application/json",
            **_auth(self.token),
        )
        self.assertEqual(resp.status_code, 200, msg=resp.content)
        alert.refresh_from_db()
        self.assertTrue(alert.is_resolved)
        self.assertEqual(AdminSensitiveActionLog.objects.count(), before_count)


class OrganizationAiCostAdminApiTests(TestCase):
    """Staff 组织 AI 成本：自动补充策略 + 低余额配置。"""

    databases = {"default"}

    def setUp(self):
        from django.db.models.signals import post_save
        from django.test import RequestFactory

        from apps.tabtinspace.signals import create_default_organization
        from apps.users.auth.models import (
            AdminAccount,
            RegistrationInviteCode,
            RegistrationInviteRedemption,
        )
        from apps.users.auth.session_manager import SessionManager

        post_save.disconnect(create_default_organization, sender=User)
        self.addCleanup(lambda: post_save.connect(create_default_organization, sender=User))

        self.client = Client()
        self.factory = RequestFactory()
        self.admin = User.objects.create_superuser(
            username="ai_cost_admin",
            email="ai_cost_admin@test.com",
            password="admin123",
        )
        AdminAccount.objects.create(
            user=self.admin,
            display_name="ai cost admin",
            status=AdminAccount.STATUS_ACTIVE,
            admin_login_enabled=True,
            created_by=self.admin,
        )
        invite = RegistrationInviteCode.objects.create(
            code="5702-AI-COST-ADMIN",
            description="test invite for ai cost admin apis",
            created_by=self.admin,
        )
        RegistrationInviteRedemption.objects.create(
            invite_code=invite,
            user=self.admin,
            entrypoint="test",
        )
        session = SessionManager.create_session(
            user=self.admin,
            request=self.factory.get("/"),
            session_type="web",
            expire_hours=24,
        )
        self.token = generate_jwt_token(self.admin, session_key=session.session_key)
        self.organization_id = org_id_for("ws_ai_cost_001")
        OrganizationBillingPolicy.objects.create(
            organization_id=self.organization_id,
            auto_topup_enabled=False,
            auto_topup_spend_yuan=Decimal("10.00"),
            auto_topup_monthly_cap_yuan=Decimal("100.00"),
        )

    def test_get_policy_includes_auto_topup_and_spent(self):
        resp = self.client.get(
            f"{BASE}/admin/billing/organizations/{self.organization_id}/policy",
            **_auth(self.token),
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()["data"]
        self.assertEqual(data["organization_id"], self.organization_id)
        self.assertFalse(data["auto_topup_enabled"])
        self.assertEqual(Decimal(data["auto_topup_spend_yuan"]), Decimal("10.00"))
        self.assertIn("auto_topup_spent_yuan", data)

    def test_put_policy_requires_reason(self):
        resp = self.client.put(
            f"{BASE}/admin/billing/organizations/{self.organization_id}/policy",
            data=json.dumps(
                {
                    "auto_topup_enabled": True,
                    "auto_topup_spend_yuan": "20",
                    "auto_topup_monthly_cap_yuan": "200",
                    "reason": "",
                }
            ),
            content_type="application/json",
            **_auth(self.token),
        )
        self.assertEqual(resp.status_code, 400)

    def test_put_policy_updates_auto_topup_and_audits(self):
        resp = self.client.put(
            f"{BASE}/admin/billing/organizations/{self.organization_id}/policy",
            data=json.dumps(
                {
                    "auto_topup_enabled": True,
                    "auto_topup_spend_yuan": "20",
                    "auto_topup_monthly_cap_yuan": "200",
                    "reason": "客服代开自动补充",
                    "ticket_id": "TK-5702",
                }
            ),
            content_type="application/json",
            **_auth(self.token),
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()["data"]
        self.assertTrue(data["auto_topup_enabled"])
        self.assertEqual(Decimal(data["auto_topup_spend_yuan"]), Decimal("20"))
        self.assertEqual(Decimal(data["auto_topup_monthly_cap_yuan"]), Decimal("200"))

        policy = OrganizationBillingPolicy.objects.get(organization_id=self.organization_id)
        self.assertTrue(policy.auto_topup_enabled)
        self.assertEqual(policy.auto_topup_spend_yuan, Decimal("20"))

        audit = AdminSensitiveActionLog.objects.filter(
            action="billing.organization_policy.auto_topup.update",
            target_id=self.organization_id,
        ).first()
        self.assertIsNotNone(audit)
        self.assertEqual(audit.ticket_id, "TK-5702")

    def test_get_and_put_low_balance_config(self):
        get_resp = self.client.get(
            f"{BASE}/admin/billing/organizations/{self.organization_id}/low-balance-config",
            **_auth(self.token),
        )
        self.assertEqual(get_resp.status_code, 200)
        before = get_resp.json()["data"]
        self.assertIn("warning_credits", before)
        self.assertIn("critical_credits", before)

        put_resp = self.client.put(
            f"{BASE}/admin/billing/organizations/{self.organization_id}/low-balance-config",
            data=json.dumps(
                {
                    "warning_credits": "500",
                    "critical_credits": "100",
                    "reason": "调低预警阈值",
                    "ticket_id": "TK-5702-lb",
                }
            ),
            content_type="application/json",
            **_auth(self.token),
        )
        self.assertEqual(put_resp.status_code, 200)
        data = put_resp.json()["data"]
        self.assertEqual(Decimal(data["warning_credits"]), Decimal("500"))
        self.assertEqual(Decimal(data["critical_credits"]), Decimal("100"))

        audit = AdminSensitiveActionLog.objects.filter(
            action="billing.organization_low_balance_config.update",
            target_id=self.organization_id,
        ).first()
        self.assertIsNotNone(audit)

    def test_put_low_balance_rejects_critical_gte_warning(self):
        resp = self.client.put(
            f"{BASE}/admin/billing/organizations/{self.organization_id}/low-balance-config",
            data=json.dumps(
                {
                    "warning_credits": "100",
                    "critical_credits": "100",
                    "reason": "非法阈值",
                }
            ),
            content_type="application/json",
            **_auth(self.token),
        )
        self.assertEqual(resp.status_code, 400)


class StorageOrganizationsAdminTests(TestCase):
    """存储组织列表：按组织名 / ID 服务端筛选。"""

    databases = {"default"}

    def setUp(self):
        self.client = Client()
        self.admin = User.objects.create_superuser(
            username="admin_storage_org",
            email="admin_storage_org@test.com",
            password="admin123",
        )
        self.token = generate_jwt_token(self.admin)
        owner = User.objects.create_user(
            username="storage_org_owner",
            email="storage_org_owner@test.com",
            password="pass123",
        )
        self.org_match = Organization.objects.create(name="泰苑科技", owner=owner)
        self.org_other = Organization.objects.create(name="其他组织", owner=owner)
        OrganizationStorageUsage.objects.create(
            organization=self.org_match,
            active_storage_bytes=1000,
            active_file_count=1,
        )
        OrganizationStorageUsage.objects.create(
            organization=self.org_other,
            active_storage_bytes=2000,
            active_file_count=2,
        )

    def test_search_by_organization_name(self):
        resp = self.client.get(
            f"{BASE}/admin/billing/storage/organizations?search=泰苑",
            **_auth(self.token),
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()["data"]
        self.assertEqual(data["total"], 1)
        self.assertEqual(len(data["organizations"]), 1)
        row = data["organizations"][0]
        self.assertEqual(row["organization_id"], str(self.org_match.id))
        self.assertEqual(row["organization_name"], "泰苑科技")

    def test_search_chinese_name_does_not_500(self):
        resp = self.client.get(
            f"{BASE}/admin/billing/storage/organizations?search=不存在的组织名xyz",
            **_auth(self.token),
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["data"]["total"], 0)

    def test_search_by_organization_id_fragment(self):
        fragment = str(self.org_match.id)[:8]
        resp = self.client.get(
            f"{BASE}/admin/billing/storage/organizations?search={fragment}",
            **_auth(self.token),
        )
        self.assertEqual(resp.status_code, 200)
        ids = {row["organization_id"] for row in resp.json()["data"]["organizations"]}
        self.assertIn(str(self.org_match.id), ids)


class CreditExplanationAdminTests(TestCase):
    """credits 解释链：全组织默认列表 + 单组织详情。"""

    databases = {"default"}

    def setUp(self):
        self.client = Client()
        self.factory = RequestFactory()
        self.admin = User.objects.create_superuser(
            username="credit_expl_admin",
            email="credit_expl_admin@test.com",
            password="admin123",
        )
        _ensure_admin_account(self.admin)
        invite = RegistrationInviteCode.objects.create(
            code="8795-CREDIT-EXPL-ADMIN",
            description="test invite for credit explanation admin apis",
            created_by=self.admin,
        )
        RegistrationInviteRedemption.objects.create(
            invite_code=invite,
            user=self.admin,
            entrypoint="test",
        )
        session = SessionManager.create_session(
            user=self.admin,
            request=self.factory.get("/"),
            session_type="web",
            expire_hours=24,
        )
        self.token = generate_jwt_token(self.admin, session_key=session.session_key)
        owner = User.objects.create_user(
            username="credit_expl_owner",
            email="credit_expl_owner@test.com",
            password="pass123",
        )
        self.organization = Organization.objects.create(
            name="计费记录测试组织",
            owner=owner,
        )
        self.org_id = str(self.organization.id)
        self.wallet = OrganizationWallet.objects.create(
            organization_id=self.org_id,
            credits=100,
            credits_precise=Decimal("100"),
        )
        from apps.users.wallet.models import WalletTransaction

        WalletTransaction.objects.create(
            organization_wallet=self.wallet,
            organization_id=self.org_id,
            transaction_type="consume",
            amount=1,
            amount_precise=Decimal("0.1000"),
            balance_before=100,
            balance_before_precise=Decimal("100.0000"),
            balance_after=99,
            balance_after_precise=Decimal("99.9000"),
            description="credit explanation test",
        )
        BillingUsageEvent.objects.create(
            organization_id=self.org_id,
            user_id=str(self.admin.id),
            meter_key="llm.tokens",
            quantity=Decimal("10"),
            unit="token",
            unit_price=Decimal("0.01"),
            amount=Decimal("0.1"),
            currency="CREDITS",
            provider_key="moonshot",
            model_name="kimi-test",
            biz_type="chat",
            biz_id="biz-1",
            occurred_at=timezone.now(),
        )

    def test_all_organizations_credit_explanation(self):
        resp = self.client.get(
            f"{BASE}/admin/billing/credit-explanation",
            **_auth(self.token),
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()["data"]
        self.assertEqual(data["scope"], "all")
        self.assertIsNone(data["organization_id"])
        self.assertGreaterEqual(len(data["recent_transactions"]), 1)
        self.assertTrue(
            any(tx.get("organization_id") == self.org_id for tx in data["recent_transactions"])
        )

    def test_single_organization_credit_explanation(self):
        resp = self.client.get(
            f"{BASE}/admin/billing/organizations/{self.org_id}/credit-explanation",
            **_auth(self.token),
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()["data"]
        self.assertEqual(data["scope"], "organization")
        self.assertEqual(data["organization_id"], self.org_id)
        self.assertIsNotNone(data["wallet"])
        self.assertEqual(data["wallet"]["organization_id"], self.org_id)


    def test_list_credit_explanation_organizations(self):
        resp = self.client.get(
            f"{BASE}/admin/billing/credit-explanation/organizations",
            **_auth(self.token),
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()["data"]
        self.assertIn("organizations", data)
        org_ids = {row["organization_id"] for row in data["organizations"]}
        self.assertIn(self.org_id, org_ids)
        row = next(r for r in data["organizations"] if r["organization_id"] == self.org_id)
        self.assertGreaterEqual(row["transaction_count"], 1)
        self.assertEqual(row["organization_name"], "计费记录测试组织")

    def test_list_credit_explanation_organizations_search_and_month(self):
        by_name = self.client.get(
            f"{BASE}/admin/billing/credit-explanation/organizations",
            {"keyword": "计费记录", "month": timezone.localdate().strftime("%Y-%m")},
            **_auth(self.token),
        )
        self.assertEqual(by_name.status_code, 200)
        name_data = by_name.json()["data"]
        self.assertGreaterEqual(name_data["total"], 1)
        self.assertTrue(
            any(row["organization_id"] == self.org_id for row in name_data["organizations"])
        )
        self.assertGreaterEqual(
            next(
                row["usage_event_count"]
                for row in name_data["organizations"]
                if row["organization_id"] == self.org_id
            ),
            1,
        )

        by_id = self.client.get(
            f"{BASE}/admin/billing/credit-explanation/organizations",
            {"keyword": self.org_id[:8]},
            **_auth(self.token),
        )
        self.assertEqual(by_id.status_code, 200)
        self.assertTrue(
            any(
                row["organization_id"] == self.org_id
                for row in by_id.json()["data"]["organizations"]
            )
        )


class PaymentOrdersAdminTests(TestCase):
    """支付订单 Admin 列表。"""

    databases = {"default"}

    def setUp(self):
        from apps.services.payment.models import PaymentOrder

        self.client = Client()
        self.factory = RequestFactory()
        self.admin = User.objects.create_superuser(
            username="payment_orders_admin",
            email="payment_orders_admin@test.com",
            password="admin123",
        )
        _ensure_admin_account(self.admin)
        invite = RegistrationInviteCode.objects.create(
            code="PAYMENT-ORDERS-ADMIN",
            description="test invite for payment orders admin",
            created_by=self.admin,
        )
        RegistrationInviteRedemption.objects.create(
            invite_code=invite,
            user=self.admin,
            entrypoint="test",
        )
        session = SessionManager.create_session(
            user=self.admin,
            request=self.factory.get("/"),
            session_type="web",
            expire_hours=24,
        )
        self.token = generate_jwt_token(self.admin, session_key=session.session_key)
        owner = User.objects.create_user(
            username="payment_orders_owner",
            email="payment_orders_owner@test.com",
            password="pass123",
        )
        self.organization = Organization.objects.create(
            name="支付订单测试组织",
            owner=owner,
        )
        self.org_id = str(self.organization.id)
        now = timezone.now()
        self.order = PaymentOrder.objects.create(
            user=owner,
            organization_id=self.org_id,
            order_type="membership",
            subject="套餐订阅测试订单",
            amount=Decimal("27.78"),
            paid_amount=Decimal("27.78"),
            payment_method="organization_wallet",
            status="completed",
            paid_at=now,
            expired_at=now + timedelta(hours=1),
        )

    def test_list_payment_orders(self):
        resp = self.client.get(
            f"{BASE}/admin/billing/payment-orders",
            {"month": timezone.localdate().strftime("%Y-%m")},
            **_auth(self.token),
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()["data"]
        self.assertGreaterEqual(data["total"], 1)
        row = next(item for item in data["items"] if item["id"] == str(self.order.id))
        self.assertEqual(row["organization_id"], self.org_id)
        self.assertEqual(row["organization_name"], "支付订单测试组织")
        self.assertEqual(row["order_type"], "membership")
        self.assertEqual(row["status"], "completed")
        self.assertEqual(row["payment_method"], "organization_wallet")
        self.assertEqual(row["order_no"], self.order.order_no)
        self.assertIn("operator_user_id", row)
        self.assertTrue(row.get("operator_name") or row.get("operator_user_id"))

    def test_list_payment_orders_filter_status(self):
        resp = self.client.get(
            f"{BASE}/admin/billing/payment-orders",
            {"status": "expired"},
            **_auth(self.token),
        )
        self.assertEqual(resp.status_code, 200)
        ids = {item["id"] for item in resp.json()["data"]["items"]}
        self.assertNotIn(str(self.order.id), ids)

    def test_list_payment_orders_filter_fields(self):
        resp = self.client.get(
            f"{BASE}/admin/billing/payment-orders",
            {
                "order_no": self.order.order_no[:8],
                "organization": "支付订单测试",
                "order_type": "membership",
                "payment_method": "organization_wallet",
                "status": "completed",
                "operator": "payment_orders_owner",
            },
            **_auth(self.token),
        )
        self.assertEqual(resp.status_code, 200)
        ids = {item["id"] for item in resp.json()["data"]["items"]}
        self.assertIn(str(self.order.id), ids)

        miss = self.client.get(
            f"{BASE}/admin/billing/payment-orders",
            {"organization": "不存在的组织名xyz"},
            **_auth(self.token),
        )
        self.assertEqual(miss.status_code, 200)
        miss_ids = {item["id"] for item in miss.json()["data"]["items"]}
        self.assertNotIn(str(self.order.id), miss_ids)

    def test_real_recharge_delivery_config_masks_webhook_url(self):
        response = self.client.put(
            f"{BASE}/admin/billing/payment-orders/report-delivery",
            data=json.dumps(
                {
                    "enabled": True,
                    "name": "经营数据群",
                    "provider": "feishu",
                    "delivery_mode": "daily",
                    "daily_time": "18:30",
                    "schedule_timezone": "Asia/Shanghai",
                    "webhook_url": (
                        "https://open.feishu.cn/open-apis/bot/v2/hook/"
                        "00000000-0000-0000-0000-000000000000"
                    ),
                }
            ),
            content_type="application/json",
            **_auth(self.token),
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()["data"]
        self.assertTrue(data["has_webhook_url"])
        self.assertEqual(data["provider"], "feishu")
        self.assertEqual(data["delivery_mode"], "daily")
        self.assertEqual(data["daily_time"], "18:30")
        self.assertTrue(any(item["key"] == "feishu" for item in data["available_providers"]))
        self.assertNotIn("webhook_url", data)

        get_response = self.client.get(
            f"{BASE}/admin/billing/payment-orders/report-delivery",
            **_auth(self.token),
        )
        self.assertEqual(get_response.status_code, 200)
        self.assertNotIn("webhook_url", get_response.json()["data"])

    @patch("apps.services.billing.api_admin.test_delivery")
    def test_real_recharge_delivery_test_endpoint(self, mocked_test):
        mocked_test.return_value = {
            "provider_message_id": "om_test",
            "summary": {"amount": "0.00"},
        }
        response = self.client.post(
            f"{BASE}/admin/billing/payment-orders/report-delivery/test",
            **_auth(self.token),
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["data"]["provider_message_id"], "om_test")

    @patch("apps.services.billing.api_admin.test_delivery")
    def test_real_recharge_delivery_test_returns_actionable_error(self, mocked_test):
        mocked_test.side_effect = ValueError("飞书 Webhook 地址暂时无法访问")

        response = self.client.post(
            f"{BASE}/admin/billing/payment-orders/report-delivery/test",
            **_auth(self.token),
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("飞书 Webhook 地址暂时无法访问", response.content.decode())

    @patch("apps.services.billing.api_admin.queue_recharge_report")
    def test_real_recharge_report_send_passes_period(self, mocked_queue):
        mocked_queue.return_value = {
            "outbox_id": "outbox-test",
            "status": "pending",
            "summary": {"amount": "50.00"},
        }
        response = self.client.post(
            f"{BASE}/admin/billing/payment-orders/report-delivery/send",
            data=json.dumps(
                {
                    "period_key": "custom",
                    "start_date": "2026-08-01",
                    "end_date": "2026-08-11",
                }
            ),
            content_type="application/json",
            **_auth(self.token),
        )
        self.assertEqual(response.status_code, 200)
        period = mocked_queue.call_args.args[0]
        self.assertEqual(period.label, "2026-08-01 至 2026-08-11")
