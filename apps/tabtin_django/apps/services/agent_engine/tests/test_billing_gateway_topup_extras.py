"""chat_send 预检拦截时，topup_reason 必须进入 DONE metadata.error_extras。"""

from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase

from apps.services.agent_engine.services.billing_gateway import run_billing_precheck
from apps.services.billing.services.billing_precheck import BillingPrecheckResult as LayerResult


class BillingGatewayTopupExtrasTests(SimpleTestCase):
    def _session(self):
        return SimpleNamespace(organization_id="org-1", id="sess-1")

    def _user(self):
        return SimpleNamespace(id="user-1")

    def test_balance_block_publishes_error_extras_with_topup_reason(self):
        blocked = LayerResult(
            blocked=True,
            layer="balance",
            reason="insufficient_credits",
            error_code="ORGANIZATION_INSUFFICIENT_CREDITS",
            error_category="organization_insufficient_credits",
            raw_detail=tuple({
                "success": False,
                "blocked": True,
                "error_code": "ORGANIZATION_INSUFFICIENT_CREDITS",
                "error_category": "organization_insufficient_credits",
                "error": "[organization_insufficient_credits] LLM 点券已用完",
                "topup_reason": "auto_topup_disabled",
            }.items()),
        )

        with patch(
            "apps.tabtinspace.services.organization_control_guard.assert_organization_ai_allowed",
        ), patch(
            "apps.users.membership.services.quota_service.QuotaService.check_quota",
        ), patch(
            "apps.services.billing.services.member_budget_service.MemberBudgetService.resolve_user_role",
            return_value="owner",
        ), patch(
            "apps.services.billing.services.billing_precheck.billing_precheck",
            return_value=blocked,
        ), patch(
            "apps.services.agent_engine.services.billing_gateway.Publisher.publish_stream_done",
        ) as mock_done:
            result = run_billing_precheck(
                self._user(),
                self._session(),
                None,
                "thread-1",
                app_context=None,
                client_type="electron",
                execution_profile=None,
            )

        self.assertFalse(result.passed)
        self.assertEqual(
            result.result["error_extras"],
            {"topup_reason": "auto_topup_disabled"},
        )
        mock_done.assert_called_once()
        _args, kwargs = mock_done.call_args
        self.assertEqual(
            kwargs["metadata"],
            {
                "error_category": "organization_insufficient_credits",
                "error_extras": {"topup_reason": "auto_topup_disabled"},
            },
        )

    def test_balance_block_without_topup_reason_omits_error_extras(self):
        blocked = LayerResult(
            blocked=True,
            layer="balance",
            reason="insufficient_credits",
            error_code="ORGANIZATION_INSUFFICIENT_CREDITS",
            error_category="organization_insufficient_credits",
            raw_detail=tuple({
                "error_code": "ORGANIZATION_INSUFFICIENT_CREDITS",
                "error_category": "organization_insufficient_credits",
                "error": "[organization_insufficient_credits] 团队钱包余额不足",
            }.items()),
        )

        with patch(
            "apps.tabtinspace.services.organization_control_guard.assert_organization_ai_allowed",
        ), patch(
            "apps.users.membership.services.quota_service.QuotaService.check_quota",
        ), patch(
            "apps.services.billing.services.member_budget_service.MemberBudgetService.resolve_user_role",
            return_value="owner",
        ), patch(
            "apps.services.billing.services.billing_precheck.billing_precheck",
            return_value=blocked,
        ), patch(
            "apps.services.agent_engine.services.billing_gateway.Publisher.publish_stream_done",
        ) as mock_done:
            result = run_billing_precheck(
                self._user(),
                self._session(),
                None,
                "thread-1",
                app_context=None,
                client_type="electron",
                execution_profile=None,
            )

        self.assertFalse(result.passed)
        self.assertNotIn("error_extras", result.result or {})
        _args, kwargs = mock_done.call_args
        self.assertEqual(
            kwargs["metadata"],
            {"error_category": "organization_insufficient_credits"},
        )
