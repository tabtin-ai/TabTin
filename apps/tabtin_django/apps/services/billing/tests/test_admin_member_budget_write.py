"""：member-budget staff 写入 API。"""

from __future__ import annotations

from decimal import Decimal

from django.contrib.auth import get_user_model
from django.test import RequestFactory, TestCase
from ninja.errors import HttpError

from apps.services.billing.api_admin import (
    AdminMemberBudgetDeleteIn,
    AdminMemberBudgetExemptRolesIn,
    AdminMemberBudgetUpsertIn,
    admin_delete_organization_member_budget_policy,
    admin_get_organization_member_budget,
    admin_patch_organization_member_budget_exempt_roles,
    admin_upsert_organization_member_budget,
)
from apps.services.billing.models import MemberLlmBudgetPolicy, OrganizationBillingPolicy
from apps.services.billing.tests.org_test_utils import org_id_for
from apps.users.auth.models import AdminAccount

User = get_user_model()


class AdminMemberBudgetWriteTests(TestCase):
    databases = {"default"}

    def setUp(self):
        self.factory = RequestFactory()
        self.admin = User.objects.create_superuser(
            username="mb_write_admin",
            email="mb_write_admin@test.com",
            password="admin123",
        )
        AdminAccount.objects.create(
            user=self.admin,
            display_name="mb write",
            status=AdminAccount.STATUS_ACTIVE,
            admin_login_enabled=True,
            created_by=self.admin,
        )
        self.organization_id = org_id_for("5702_member_budget_write")
        self.request = self.factory.put("/api/services/billing/admin/billing/x/member-budget")
        self.request.auth = self.admin
        self.request.admin_permissions = {"*"}
        self.request.admin_account = AdminAccount.objects.filter(user=self.admin).first()
        self.request.META = {
            "REMOTE_ADDR": "127.0.0.1",
            "HTTP_USER_AGENT": "pytest",
        }

    def _view_only_request(self, method: str, path: str):
        request = getattr(self.factory, method.lower())(path)
        request.auth = self.admin
        request.admin_permissions = {"billing_dashboard:view"}
        request.admin_account = self.request.admin_account
        request.META = dict(self.request.META)
        return request

    def test_upsert_default_policy_and_exempt_roles(self):
        upserted = admin_upsert_organization_member_budget(
            self.request,
            self.organization_id,
            AdminMemberBudgetUpsertIn(
                monthly_credits_limit=Decimal("1000"),
                daily_credits_limit=Decimal("100"),
                reason="set default budget",
                ticket_id="OPS-BUDGET-1",
            ),
        )
        assert upserted["data"]["monthly_credits_limit"] == "1000.0000" or upserted["data"][
            "monthly_credits_limit"
        ].startswith("1000")
        assert upserted["data"]["user_id"] is None

        patched = admin_patch_organization_member_budget_exempt_roles(
            self.request,
            self.organization_id,
            AdminMemberBudgetExemptRolesIn(
                exempt_roles=["owner", "admin"],
                reason="enable admin exempt",
                ticket_id="OPS-BUDGET-2",
            ),
        )
        assert patched["data"]["admin_exempt"] is True

        got = admin_get_organization_member_budget(self.request, self.organization_id)
        assert got["data"]["admin_exempt"] is True
        assert got["data"]["default_policy"] is not None
        assert isinstance(got["data"]["policies"], list)
        assert MemberLlmBudgetPolicy.objects.filter(
            organization_id=self.organization_id,
        ).exists()
        policy = OrganizationBillingPolicy.objects.get(organization_id=self.organization_id)
        assert "admin" in policy.metadata.get("member_budget_exempt_roles", [])

    def test_write_denied_with_only_billing_dashboard_view(self):
        """仅有 billing_dashboard:view 时，三个 member-budget 写接口均应 403。"""
        base = f"/api/services/billing/admin/billing/{self.organization_id}/member-budget"

        with self.assertRaises(HttpError) as upsert_ctx:
            admin_upsert_organization_member_budget(
                self._view_only_request("put", base),
                self.organization_id,
                AdminMemberBudgetUpsertIn(
                    monthly_credits_limit=Decimal("1"),
                    reason="should be denied",
                ),
            )
        self.assertEqual(upsert_ctx.exception.status_code, 403)
        self.assertEqual(
            upsert_ctx.exception.message["missing_permission"],
            "team_member:update_budget",
        )

        with self.assertRaises(HttpError) as exempt_ctx:
            admin_patch_organization_member_budget_exempt_roles(
                self._view_only_request("patch", f"{base}/exempt-roles"),
                self.organization_id,
                AdminMemberBudgetExemptRolesIn(
                    exempt_roles=["owner"],
                    reason="should be denied",
                ),
            )
        self.assertEqual(exempt_ctx.exception.status_code, 403)
        self.assertEqual(
            exempt_ctx.exception.message["missing_permission"],
            "team_member:update_budget",
        )

        fake_policy_id = "00000000-0000-4000-8000-000000005702"
        with self.assertRaises(HttpError) as delete_ctx:
            admin_delete_organization_member_budget_policy(
                self._view_only_request(
                    "post", f"{base}/policies/{fake_policy_id}/delete"
                ),
                self.organization_id,
                fake_policy_id,
                AdminMemberBudgetDeleteIn(reason="should be denied"),
            )
        self.assertEqual(delete_ctx.exception.status_code, 403)
        self.assertEqual(
            delete_ctx.exception.message["missing_permission"],
            "team_member:update_budget",
        )
