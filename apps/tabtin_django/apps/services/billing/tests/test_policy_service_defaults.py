from decimal import Decimal

from django.test import TestCase

from apps.services.billing.services.policy_service import OrganizationBillingPolicyService


class OrganizationBillingPolicyDefaultTests(TestCase):
    databases = {"default"}

    def test_effective_policy_defaults_open_001_unlimited_cap(self):
        policy = OrganizationBillingPolicyService.get_effective_policy("missing-org-auto-topup")
        self.assertTrue(policy["auto_topup_enabled"])
        self.assertEqual(policy["auto_topup_spend_yuan"], Decimal("1"))
        self.assertEqual(policy["auto_topup_monthly_cap_yuan"], Decimal("0"))
        self.assertTrue(policy["is_default"])
