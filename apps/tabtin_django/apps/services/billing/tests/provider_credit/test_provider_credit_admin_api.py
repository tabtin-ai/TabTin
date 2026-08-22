from __future__ import annotations

from decimal import Decimal

from django.contrib.auth import get_user_model
from django.test import RequestFactory, TestCase

from apps.services.billing.api_admin import (
    admin_list_organization_provider_credit_grants,
    admin_list_provider_credit_campaigns,
    admin_list_provider_credit_transactions,
)
from apps.services.billing.models import BillingAdminAuditLog, ProviderCreditTransaction
from apps.services.billing.services.provider_credit_service import ProviderCreditService
from apps.services.billing.tests.org_test_utils import org_id_for


class ProviderCreditReadOnlyAdminApiTests(TestCase):
    databases = {"default"}

    def setUp(self):
        self.factory = RequestFactory()
        self.admin = get_user_model().objects.create_superuser(
            username="provider_credit_admin",
            email="provider-credit-admin@test.local",
            password="test-pass-123",
        )
        self.organization_id = org_id_for("provider_credit_admin_api")
        self.campaign = ProviderCreditService.create_campaign(
            code="DOUBAO_ADMIN_QUERY",
            name="豆包 Admin 查询测试",
            provider_key="volcengine",
            eligible_model_ids=[],
            credits_amount=Decimal("1000"),
            total_budget_credits=Decimal("1000"),
        )
        self.grant = ProviderCreditService.grant_credit(
            organization=self.organization_id,
            campaign=self.campaign,
        )
        ProviderCreditService.record_transaction(
            grant=self.grant,
            transaction_type=ProviderCreditTransaction.TransactionType.CONSUME,
            amount=Decimal("-10"),
            idempotency_key="provider-credit-admin-api:consume",
        )

    def _request(self, path: str):
        request = self.factory.get(path)
        request.auth = self.admin
        request.admin_permissions = {"*"}
        return request

    def test_campaign_query_records_billing_audit(self):
        response = admin_list_provider_credit_campaigns(
            self._request("/admin/billing/provider-credit/campaigns"),
            provider_key="volcengine",
        )

        self.assertEqual(response["data"]["items"][0]["code"], self.campaign.code)
        self.assertTrue(
            BillingAdminAuditLog.objects.filter(
                action="provider_credit_campaign_list",
                target_type="provider_credit_campaign",
            ).exists()
        )

    def test_campaign_query_matches_name_or_code(self):
        by_name = admin_list_provider_credit_campaigns(
            self._request("/admin/billing/provider-credit/campaigns"),
            code="Admin 查询",
        )
        by_code = admin_list_provider_credit_campaigns(
            self._request("/admin/billing/provider-credit/campaigns"),
            code="DOUBAO_ADMIN",
        )

        self.assertEqual(
            [item["code"] for item in by_name["data"]["items"]],
            [self.campaign.code],
        )
        self.assertEqual(
            [item["code"] for item in by_code["data"]["items"]],
            [self.campaign.code],
        )

    def test_organization_grant_query_records_billing_audit(self):
        response = admin_list_organization_provider_credit_grants(
            self._request(
                f"/admin/billing/organizations/{self.organization_id}"
                "/provider-credit/grants"
            ),
            organization_id=self.organization_id,
        )

        self.assertEqual(response["data"]["items"][0]["id"], str(self.grant.id))
        self.assertTrue(
            BillingAdminAuditLog.objects.filter(
                action="provider_credit_grant_list",
                organization_id=self.organization_id,
            ).exists()
        )

    def test_transaction_query_records_billing_audit(self):
        response = admin_list_provider_credit_transactions(
            self._request("/admin/billing/provider-credit/transactions"),
            organization_id=self.organization_id,
            grant_id=str(self.grant.id),
        )

        self.assertEqual(len(response["data"]["items"]), 2)
        item = response["data"]["items"][0]
        self.assertEqual(item["organization_id"], self.organization_id)
        self.assertEqual(item["organization"]["id"], self.organization_id)
        self.assertIn("name", item["organization"])
        self.assertEqual(item["grant"]["campaign_code"], self.campaign.code)
        self.assertEqual(item["grant"]["campaign_name"], self.campaign.name)
        self.assertTrue(
            BillingAdminAuditLog.objects.filter(
                action="provider_credit_transaction_list",
                organization_id=self.organization_id,
            ).exists()
        )
