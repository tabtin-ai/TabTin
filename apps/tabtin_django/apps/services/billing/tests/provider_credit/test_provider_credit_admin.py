from __future__ import annotations

from decimal import Decimal

from django.contrib.auth import get_user_model
from django.test import RequestFactory, TestCase
from ninja.errors import HttpError

from apps.services.billing.api_admin import (
    ProviderCreditCampaignCreateIn,
    ProviderCreditCampaignUpdateIn,
    ProviderCreditGrantAdjustmentIn,
    ProviderCreditGrantRevokeIn,
    admin_adjust_provider_credit_grant,
    admin_create_provider_credit_campaign,
    admin_get_provider_credit_campaign_report,
    admin_list_provider_credit_grants,
    admin_list_provider_credit_transactions,
    admin_revoke_provider_credit_grant,
    admin_update_provider_credit_campaign,
)
from apps.services.billing.models import (
    BillingAdminAuditLog,
    ProviderCreditCampaign,
    ProviderCreditGrant,
    ProviderCreditTransaction,
)
from apps.services.billing.services.provider_credit_service import ProviderCreditService
from apps.services.billing.tests.org_test_utils import org_id_for
from apps.users.auth.models import AdminSensitiveActionLog


class ProviderCreditAdminTests(TestCase):
    databases = {"default"}

    def setUp(self):
        self.factory = RequestFactory()
        self.organization_id = org_id_for("provider_credit_admin")
        self.other_organization_id = org_id_for("provider_credit_admin_other")
        self.admin = get_user_model().objects.create_superuser(
            username="provider_credit_admin_user",
            email="provider-credit-admin@test.local",
            password="test-pass-123",
        )

    def _request(self, method: str, path: str, permissions: set[str]):
        request = getattr(self.factory, method.lower())(path)
        request.auth = self.admin
        request.admin_permissions = permissions
        return request

    def _campaign(self, *, code: str, provider_key: str = "volcengine"):
        return ProviderCreditService.create_campaign(
            code=code,
            name=code,
            provider_key=provider_key,
            eligible_model_ids=[],
            credits_amount=Decimal("100"),
            total_budget_credits=Decimal("1000"),
        )

    def _grant(self, *, code: str = "ADMIN_GRANT", organization_id: str | None = None):
        campaign = self._campaign(code=code)
        grant = ProviderCreditService.grant_credit_from_campaign(
            organization=organization_id or self.organization_id,
            campaign_code=campaign.code,
            source="admin",
        )
        return campaign, grant

    def test_operator_can_create_campaign_and_write_audit(self):
        request = self._request(
            "post",
            "/admin/billing/provider-credit/campaigns",
            {"provider_credit:operate"},
        )

        response = admin_create_provider_credit_campaign(
            request,
            ProviderCreditCampaignCreateIn(
                code="OPS_CREATE_QWEN",
                name="Qwen 联合活动",
                provider_key="dashscope",
                eligible_model_ids=[],
                grant_credits=Decimal("50"),
                total_budget_credits=Decimal("500"),
                expire_days=20,
            ),
        )

        campaign = ProviderCreditCampaign.objects.get(code="OPS_CREATE_QWEN")
        self.assertEqual(response["data"]["campaign"]["grant_credits"], "50")
        self.assertTrue(campaign.enabled)
        self.assertTrue(
            BillingAdminAuditLog.objects.filter(
                action="provider_credit_campaign_create",
                target_id=str(campaign.id),
            ).exists()
        )

    def test_campaign_code_is_immutable_and_scope_freezes_after_grant(self):
        campaign, _grant = self._grant(code="FROZEN_SCOPE")
        request = self._request(
            "put",
            f"/admin/billing/provider-credit/campaigns/{campaign.code}",
            {"provider_credit:admin"},
        )

        with self.assertRaises(HttpError) as code_error:
            admin_update_provider_credit_campaign(
                request,
                campaign.code,
                ProviderCreditCampaignUpdateIn(code="RENAMED_SCOPE"),
            )
        self.assertEqual(code_error.exception.status_code, 409)

        with self.assertRaises(HttpError) as provider_error:
            admin_update_provider_credit_campaign(
                request,
                campaign.code,
                ProviderCreditCampaignUpdateIn(provider_key="dashscope"),
            )
        self.assertEqual(provider_error.exception.status_code, 409)

    def test_admin_can_disable_campaign(self):
        campaign = self._campaign(code="DISABLE_CAMPAIGN")
        request = self._request(
            "put",
            f"/admin/billing/provider-credit/campaigns/{campaign.code}",
            {"provider_credit:admin"},
        )

        admin_update_provider_credit_campaign(
            request,
            campaign.code,
            ProviderCreditCampaignUpdateIn(enabled=False),
        )

        campaign.refresh_from_db()
        self.assertFalse(campaign.enabled)
        self.assertTrue(
            BillingAdminAuditLog.objects.filter(
                action="provider_credit_campaign_update",
                target_id=str(campaign.id),
            ).exists()
        )

    def test_grant_query_filters_organization_provider_campaign_and_status(self):
        matching_campaign, matching = self._grant(code="FILTER_MATCH")
        self._grant(code="FILTER_OTHER_ORG", organization_id=self.other_organization_id)
        qwen = self._campaign(code="FILTER_QWEN", provider_key="dashscope")
        ProviderCreditService.grant_credit_from_campaign(
            organization=self.organization_id,
            campaign_code=qwen.code,
            source="admin",
        )
        request = self._request(
            "get",
            "/admin/billing/provider-credit/grants",
            {"provider_credit:view"},
        )

        response = admin_list_provider_credit_grants(
            request,
            organization_id=self.organization_id,
            provider_key="volcengine",
            campaign_code=matching_campaign.code,
            status=ProviderCreditGrant.Status.ACTIVE,
        )

        self.assertEqual([item["id"] for item in response["data"]["items"]], [str(matching.id)])

    def test_adjustment_changes_balance_through_adjust_transaction_and_audits(self):
        _campaign, grant = self._grant(code="ADJUST_BALANCE")
        request = self._request(
            "post",
            f"/admin/billing/provider-credit/grants/{grant.id}/adjust",
            {"provider_credit:operate"},
        )

        response = admin_adjust_provider_credit_grant(
            request,
            str(grant.id),
            ProviderCreditGrantAdjustmentIn(
                amount=Decimal("50"),
                reason="供应商对账补发",
                idempotency_key="admin-adjust-test-1",
            ),
        )

        grant.refresh_from_db()
        adjustment = ProviderCreditTransaction.objects.get(
            id=response["data"]["transaction"]["id"]
        )
        self.assertEqual(adjustment.transaction_type, "adjust")
        self.assertEqual(adjustment.amount, Decimal("50"))
        self.assertEqual(grant.total_credits, Decimal("150"))
        self.assertEqual(grant.remaining_credits, Decimal("150"))
        self.assertTrue(
            BillingAdminAuditLog.objects.filter(
                action="provider_credit_grant_adjust",
                target_id=str(grant.id),
            ).exists()
        )
        self.assertTrue(
            AdminSensitiveActionLog.objects.filter(
                action="provider_credit.grant.adjust",
                target_id=str(grant.id),
            ).exists()
        )

    def test_revoke_preserves_grant_and_records_negative_adjustment(self):
        _campaign, grant = self._grant(code="REVOKE_GRANT")
        request = self._request(
            "post",
            f"/admin/billing/provider-credit/grants/{grant.id}/revoke",
            {"provider_credit:admin"},
        )

        response = admin_revoke_provider_credit_grant(
            request,
            str(grant.id),
            ProviderCreditGrantRevokeIn(reason="供应商活动提前终止"),
        )

        grant.refresh_from_db()
        adjustment = ProviderCreditTransaction.objects.get(
            id=response["data"]["transaction"]["id"]
        )
        self.assertEqual(grant.status, ProviderCreditGrant.Status.REVOKED)
        self.assertEqual(grant.remaining_credits, Decimal("0"))
        self.assertEqual(adjustment.transaction_type, "adjust")
        self.assertEqual(adjustment.amount, Decimal("-100"))
        self.assertTrue(ProviderCreditGrant.objects.filter(id=grant.id).exists())
        self.assertTrue(
            BillingAdminAuditLog.objects.filter(
                action="provider_credit_grant_revoke",
                target_id=str(grant.id),
            ).exists()
        )

    def test_viewer_cannot_adjust_but_operator_can(self):
        _campaign, grant = self._grant(code="PERMISSION_ADJUST")
        viewer_request = self._request(
            "post",
            f"/admin/billing/provider-credit/grants/{grant.id}/adjust",
            {"provider_credit:view"},
        )
        payload = ProviderCreditGrantAdjustmentIn(
            amount=Decimal("10"),
            reason="权限测试",
            idempotency_key="permission-adjust-test",
        )

        with self.assertRaises(HttpError) as denied:
            admin_adjust_provider_credit_grant(viewer_request, str(grant.id), payload)
        self.assertEqual(denied.exception.status_code, 403)

        operator_request = self._request(
            "post",
            f"/admin/billing/provider-credit/grants/{grant.id}/adjust",
            {"provider_credit:operate"},
        )
        admin_adjust_provider_credit_grant(operator_request, str(grant.id), payload)
        self.assertTrue(
            ProviderCreditTransaction.objects.filter(
                idempotency_key="permission-adjust-test"
            ).exists()
        )

    def test_transaction_query_supports_grant_org_and_type_filters(self):
        _campaign, grant = self._grant(code="TRANSACTION_FILTER")
        request = self._request(
            "get",
            "/admin/billing/provider-credit/transactions",
            {"provider_credit:view"},
        )

        response = admin_list_provider_credit_transactions(
            request,
            organization_id=self.organization_id,
            grant_id=str(grant.id),
            transaction_type=ProviderCreditTransaction.TransactionType.GRANT,
        )

        self.assertEqual(len(response["data"]["items"]), 1)
        self.assertEqual(response["data"]["items"][0]["transaction_type"], "grant")

    def test_campaign_report_aggregates_granted_consumed_remaining_and_usage(self):
        campaign, grant = self._grant(code="REPORT_CAMPAIGN")
        ProviderCreditService.record_transaction(
            grant=grant,
            transaction_type=ProviderCreditTransaction.TransactionType.CONSUME,
            amount=Decimal("-25"),
            idempotency_key="report-consume-1",
        )
        request = self._request(
            "get",
            f"/admin/billing/provider-credit/reports/campaign/{campaign.code}",
            {"provider_credit:view"},
        )

        response = admin_get_provider_credit_campaign_report(request, campaign.code)

        self.assertEqual(response["data"]["campaign"], campaign.code)
        self.assertEqual(response["data"]["provider"], "volcengine")
        self.assertEqual(response["data"]["granted"], "100.00000000")
        self.assertEqual(response["data"]["consumed"], "25.00000000")
        self.assertEqual(response["data"]["remaining"], "75.00000000")
        self.assertEqual(response["data"]["organizations"], 1)
        self.assertEqual(response["data"]["usage_count"], 1)

