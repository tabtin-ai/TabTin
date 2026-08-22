from __future__ import annotations

import uuid

from django.test import RequestFactory, TestCase
from django.utils import timezone
from dateutil.relativedelta import relativedelta

from apps.services.billing.models import AddonPackage, OrganizationAddonEntitlement
from apps.tabtinspace.admin_api import (
    AdminOrganizationCashPurchaseRequest,
    AdminOrganizationCashRechargeRequest,
    AdminOrganizationQuotaGrantRequest,
    AdminOrganizationWalletRechargeRequest,
    admin_get_organization_entitlements,
    admin_get_organization_cash_wallet,
    admin_grant_organization_entitlement,
    admin_list_organization_audit_logs,
    admin_purchase_addon_package_with_cash_wallet,
    admin_purchase_credit_package_with_cash_wallet,
    admin_recharge_organization_cash_wallet,
    admin_recharge_organization_wallet,
)
from apps.tabtinspace.models import Organization, SpaceAdminActionLog
from apps.users.auth.models import User
from apps.users.membership.models import MembershipTier, OrganizationMembership
from apps.users.wallet.models import CashWalletTransaction, CreditPackage, WalletTransaction


class AdminOrganizationEntitlementGrantTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.factory = RequestFactory()
        self.admin = User.objects.create_user(
            username="ent_admin",
            email="ent-admin@test.com",
            password="test-pass-123",
            is_staff=True,
            is_superuser=True,
        )
        self.organization = Organization.objects.create(
            name="Entitlement Org",
            owner=self.admin,
            type=Organization.OrganizationType.TEAM,
        )
        self.tier = MembershipTier.objects.create(
            tier_type=f"ent_tier_{uuid.uuid4().hex[:8]}",
            name="Ent Tier",
            max_documents=10,
            max_tables=5,
            max_members=3,
            included_llm_credits_monthly="500.00",
            price="1.00",
            duration_months=1,
        )
        OrganizationMembership.objects.create(
            organization_id=str(self.organization.id),
            tier=self.tier,
            status="active",
            start_date=timezone.now(),
            end_date=timezone.now() + relativedelta(months=12),
        )

    def _request(self):
        request = self.factory.post("/api/auth/admin/organizations/x/entitlements/grant")
        request.auth = self.admin
        request.headers = {}
        request.META = {
            "REMOTE_ADDR": "127.0.0.1",
            "HTTP_USER_AGENT": "pytest",
        }
        return request

    def test_grant_document_quota_writes_addon_and_audit_log(self):
        payload = AdminOrganizationQuotaGrantRequest(
            quota_key="max_documents",
            quota_value=7,
            period_months=12,
            reason="customer expansion",
        )

        response = admin_grant_organization_entitlement(
            self._request(),
            self.organization.id,
            payload,
        )

        assert response["data"]["entitlement"]["quota_key"] == "max_documents"
        assert response["data"]["summary"]["limits"]["max_documents"]["plan_limit"] == 10
        assert response["data"]["summary"]["limits"]["max_documents"]["addon_limit"] == 7
        assert response["data"]["summary"]["limits"]["max_documents"]["effective_limit"] == 17

        entitlement = OrganizationAddonEntitlement.objects.get(
            organization_id=str(self.organization.id),
            quota_key="max_documents",
        )
        assert entitlement.metadata["source"] == "admin_grant"
        assert entitlement.metadata["ticket_id"].startswith("QUOTA-GRANT-")

        audit = SpaceAdminActionLog.objects.get(action_type="organization_quota_grant")
        assert audit.organization_id == self.organization.id
        assert audit.target_id == entitlement.id
        assert audit.request_payload["ticket_id"] == entitlement.metadata["ticket_id"]
        assert audit.request_payload["reason"] == "customer expansion"

    def test_entitlement_summary_includes_addon_quota(self):
        admin_grant_organization_entitlement(
            self._request(),
            self.organization.id,
            AdminOrganizationQuotaGrantRequest(
                quota_key="max_tables",
                quota_value=2,
                period_months=12,
                reason="table expansion",
            ),
        )

        response = admin_get_organization_entitlements(self._request(), self.organization.id)

        assert response["data"]["limits"]["max_tables"]["addon_limit"] == 2
        assert response["data"]["limits"]["included_llm_credits_monthly"]["plan_limit"] == 500
        assert response["data"]["limits"]["included_llm_credits_monthly"]["label"] == "点券"

    def test_grant_group_quota_writes_addon_and_summary(self):
        payload = AdminOrganizationQuotaGrantRequest(
            quota_key="max_groups",
            quota_value=5,
            period_months=12,
            reason="group expansion",
        )

        response = admin_grant_organization_entitlement(
            self._request(),
            self.organization.id,
            payload,
        )

        assert response["data"]["entitlement"]["quota_key"] == "max_groups"
        assert response["data"]["entitlement"]["quota_label"] == "群组数量"
        assert response["data"]["summary"]["limits"]["max_groups"]["addon_limit"] == 5

        entitlement = OrganizationAddonEntitlement.objects.get(
            organization_id=str(self.organization.id),
            quota_key="max_groups",
        )
        assert entitlement.metadata["source"] == "admin_grant"
        assert entitlement.metadata["ticket_id"].startswith("QUOTA-GRANT-")

    def test_grant_storage_quota_writes_addon_and_summary(self):
        one_gb = 1024 * 1024 * 1024
        payload = AdminOrganizationQuotaGrantRequest(
            quota_key="storage_quota_bytes",
            quota_value=one_gb,
            period_months=12,
            reason="storage expansion",
        )

        response = admin_grant_organization_entitlement(
            self._request(),
            self.organization.id,
            payload,
        )

        assert response["data"]["entitlement"]["quota_key"] == "storage_quota_bytes"
        assert response["data"]["entitlement"]["quota_label"] == "存储容量"
        assert response["data"]["entitlement"]["quota_value"] == one_gb
        assert (
            response["data"]["summary"]["limits"]["included_storage_bytes"]["addon_limit"]
            == one_gb
        )

    def test_audit_log_filters_by_action_and_operator_keyword(self):
        payload = AdminOrganizationQuotaGrantRequest(
            quota_key="max_members",
            quota_value=1,
            period_months=12,
            reason="seat expansion",
        )
        admin_grant_organization_entitlement(self._request(), self.organization.id, payload)

        response = admin_list_organization_audit_logs(
            self._request(),
            self.organization.id,
            action_type="organization_quota_grant",
            operator_keyword="ent_admin",
            page_size=10,
        )

        assert response["data"]["total"] == 1
        item = response["data"]["items"][0]
        assert item["action_type"] == "organization_quota_grant"
        assert item["request_payload"]["ticket_id"].startswith("QUOTA-GRANT-")

    def test_cash_wallet_recharge_writes_cash_transaction_and_audit(self):
        response = admin_recharge_organization_cash_wallet(
            self._request(),
            self.organization.id,
            AdminOrganizationCashRechargeRequest(
                amount_cny="128.50",
                reason="prepaid balance",
            ),
        )

        assert response["data"]["wallet"]["balance_cny"] == "128.50"
        tx = CashWalletTransaction.objects.get(transaction_type="recharge")
        assert str(tx.amount_cny) == "128.50"
        assert tx.related_order_id.startswith("CASH-RECHARGE-")
        audit = SpaceAdminActionLog.objects.get(action_type="organization_cash_wallet_recharge")
        assert audit.request_payload["ticket_id"] == tx.related_order_id

        detail = admin_get_organization_cash_wallet(self._request(), self.organization.id)
        assert detail["data"]["wallet"]["available_cny"] == "128.50"
        assert detail["data"]["transactions"][0]["transaction_type"] == "recharge"

        second_response = admin_recharge_organization_cash_wallet(
            self._request(),
            self.organization.id,
            AdminOrganizationCashRechargeRequest(
                amount_cny="128.50",
                reason="second prepaid balance",
            ),
        )
        assert second_response["data"]["wallet"]["available_cny"] == "257.00"
        second_tx = CashWalletTransaction.objects.exclude(id=tx.id).get(transaction_type="recharge")
        assert second_tx.related_order_id.startswith("CASH-RECHARGE-")
        assert second_tx.related_order_id != tx.related_order_id
        assert CashWalletTransaction.objects.filter(transaction_type="recharge").count() == 2
        assert SpaceAdminActionLog.objects.filter(
            action_type="organization_cash_wallet_recharge"
        ).count() == 2

    def test_cash_wallet_purchase_credit_package_deducts_cash_and_grants_credits(self):
        admin_recharge_organization_cash_wallet(
            self._request(),
            self.organization.id,
            AdminOrganizationCashRechargeRequest(
                amount_cny="100.00",
                reason="prepaid balance",
            ),
        )
        package = CreditPackage.objects.create(
            name="100 点券包",
            price="30.00",
            credits_amount=100,
            bonus_credits=20,
            is_active=True,
        )

        response = admin_purchase_credit_package_with_cash_wallet(
            self._request(),
            self.organization.id,
            AdminOrganizationCashPurchaseRequest(
                package_id=str(package.id),
                reason="customer purchase",
            ),
        )

        assert response["data"]["credits"] == 120
        cash_tx = CashWalletTransaction.objects.get(transaction_type="purchase_credit_package")
        assert str(cash_tx.amount_cny) == "-30.00"
        assert str(cash_tx.balance_after_cny) == "70.00"
        assert cash_tx.related_wallet_transaction_id
        credit_tx = WalletTransaction.objects.get(id=cash_tx.related_wallet_transaction_id)
        assert credit_tx.amount == 120
        assert cash_tx.related_order_id.startswith("CASH-PURCHASE-CREDIT-")
        audit = SpaceAdminActionLog.objects.get(action_type="organization_cash_purchase_credit_package")
        assert audit.request_payload["ticket_id"] == cash_tx.related_order_id

    def test_cash_wallet_purchase_addon_package_deducts_cash_and_grants_entitlement(self):
        admin_recharge_organization_cash_wallet(
            self._request(),
            self.organization.id,
            AdminOrganizationCashRechargeRequest(
                amount_cny="100.00",
                reason="prepaid balance",
            ),
        )
        package = AddonPackage.objects.create(
            addon_code=f"doc_addon_{uuid.uuid4().hex[:8]}",
            addon_name="文档扩容包",
            price="25.00",
            quota_key="max_documents",
            quota_value=50,
            period_months=12,
            is_active=True,
        )

        response = admin_purchase_addon_package_with_cash_wallet(
            self._request(),
            self.organization.id,
            AdminOrganizationCashPurchaseRequest(
                package_id=str(package.id),
                reason="customer expansion purchase",
            ),
        )

        assert response["data"]["entitlement"]["quota_key"] == "max_documents"
        cash_tx = CashWalletTransaction.objects.get(transaction_type="purchase_addon_package")
        assert str(cash_tx.amount_cny) == "-25.00"
        assert str(cash_tx.balance_after_cny) == "75.00"
        assert cash_tx.related_addon_entitlement_id
        assert cash_tx.related_order_id.startswith("CASH-PURCHASE-ADDON-")
        audit = SpaceAdminActionLog.objects.get(action_type="organization_cash_purchase_addon_package")
        assert audit.request_payload["ticket_id"] == cash_tx.related_order_id

    def test_credits_recharge_generates_operation_reference(self):
        response = admin_recharge_organization_wallet(
            self._request(),
            self.organization.id,
            AdminOrganizationWalletRechargeRequest(
                amount=100,
                description="customer credits",
            ),
        )

        assert response["data"]["amount"] == 100
        audit = SpaceAdminActionLog.objects.get(action_type="organization_wallet_recharge")
        assert audit.request_payload["ticket_id"].startswith("CREDITS-RECHARGE-")
