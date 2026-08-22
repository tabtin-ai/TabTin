from decimal import Decimal

from django.test import TestCase
from django.db.models.signals import post_save

from apps.services.billing.models import (
    BillingUsageEvent,
    OrganizationBillingEntitlement,
    OrganizationBillingPolicy,
    OrganizationLlmMonthlyBudget,
)
from apps.tabtinspace.signals import create_default_organization
from apps.users.auth.models import User
from apps.users.wallet.models import OrganizationWallet
from apps.users.wallet.services.credits_service import CreditsService
from apps.services.billing.tests.org_test_utils import org_id_for


class OrganizationLlmBillingIntegrationTests(TestCase):
    databases = {"default"}

    def setUp(self):
        post_save.disconnect(create_default_organization, sender=User)
        self.addCleanup(lambda: post_save.connect(create_default_organization, sender=User))
        self.user = User.objects.create_user(
            email="organization_llm_billing@test.com",
            password="test-pass-123",
        )
        OrganizationBillingPolicy.objects.create(
            organization_id=org_id_for("ws_llm_integration_001"),
            storage_billing_mode="package_plus_paygo",
            llm_billing_mode="quota_then_paygo",
            currency="CREDITS",
            is_active=True,
        )
        OrganizationBillingEntitlement.objects.create(
            organization_id=org_id_for("ws_llm_integration_001"),
            included_storage_bytes=0,
            purchased_storage_bytes=0,
            included_llm_credits_monthly=Decimal("1.0000"),
            is_active=True,
        )
        OrganizationWallet.objects.create(
            organization_id=org_id_for("ws_llm_integration_001"),
            credits=100,
            credits_precise=Decimal("100.0000"),
        )

    def test_organization_quota_then_paygo(self):
        result = CreditsService.consume_credits_for_llm(
            self.user,
            input_tokens=1500,
            output_tokens=0,
            model_config={
                "provider_key": "openai",
                "model_name": "gpt-4o-mini",
                "input_price_per_1k": "0.01",
                "output_price_per_1k": "0",
            },
            organization_id=org_id_for("ws_llm_integration_001"),
            biz_id="llm_req_ws_001",
            billing_metadata={"billing_gateway": True, "charge_mode": "pending"},
        )

        ws_wallet = OrganizationWallet.objects.get(organization_id=org_id_for("ws_llm_integration_001"))
        budget = OrganizationLlmMonthlyBudget.objects.get(organization_id=org_id_for("ws_llm_integration_001"))
        usage = BillingUsageEvent.objects.get(organization_id=org_id_for("ws_llm_integration_001"), biz_id="llm_req_ws_001")

        self.assertEqual(result["raw_credits_cost_precise"], Decimal("1.5000"))
        self.assertEqual(result["quota_covered_credits_precise"], Decimal("1.0000"))
        self.assertEqual(result["credits_consumed_precise"], Decimal("0.5000"))
        self.assertEqual(ws_wallet.credits_precise, Decimal("99.5000"))

        self.assertEqual(budget.included_credits, Decimal("1.0000"))
        self.assertEqual(budget.consumed_credits, Decimal("1.0000"))
        self.assertEqual(usage.amount, Decimal("0.5000"))
        self.assertEqual(usage.metadata.get("raw_credits_cost"), "1.5000")
        self.assertEqual(usage.metadata.get("quota_covered_credits"), "1.0000")
        self.assertEqual(usage.metadata.get("paygo_credits"), "0.5000")
        self.assertEqual(usage.metadata.get("charge_mode"), "mixed_quota_wallet")

    def test_scene_key_persisted_without_changing_amount(self):
        # 子 Agent 计费收尾（任务 B）：scene_key 经 consume_credits_for_llm 落进
        # BillingUsageEvent，且**纯分类、不影响任何金额**——与上面不带 scene_key 的
        # 同口径调用（1500 input → 1.5 成本、配额覆盖 1.0、实扣 0.5）金额完全一致。
        result = CreditsService.consume_credits_for_llm(
            self.user,
            input_tokens=1500,
            output_tokens=0,
            model_config={
                "provider_key": "openai",
                "model_name": "gpt-4o-mini",
                "input_price_per_1k": "0.01",
                "output_price_per_1k": "0",
            },
            organization_id=org_id_for("ws_llm_integration_001"),
            biz_id="llm_req_scene_sub",
            idempotency_key="idem_scene_sub_001",
            scene_key="_sub_agent",
        )

        usage = BillingUsageEvent.objects.get(idempotency_key="idem_scene_sub_001")
        self.assertEqual(usage.scene_key, "_sub_agent")
        # 金额与不带 scene_key 时逐一致：scene_key 不参与计费
        self.assertEqual(usage.amount, Decimal("0.5000"))
        self.assertEqual(result["credits_consumed_precise"], Decimal("0.5000"))

    def test_scene_key_defaults_empty_for_legacy_callers(self):
        # 不传 scene_key 的旧调用方（如非 LLM / 历史路径）→ 列留空，归报表「未分类」。
        CreditsService.consume_credits_for_llm(
            self.user,
            input_tokens=1500,
            output_tokens=0,
            model_config={
                "provider_key": "openai",
                "model_name": "gpt-4o-mini",
                "input_price_per_1k": "0.01",
                "output_price_per_1k": "0",
            },
            organization_id=org_id_for("ws_llm_integration_001"),
            biz_id="llm_req_no_scene",
            idempotency_key="idem_no_scene_001",
        )
        usage = BillingUsageEvent.objects.get(idempotency_key="idem_no_scene_001")
        self.assertEqual(usage.scene_key, "")
