from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase


class LLMApiBillingFailClosedTests(SimpleTestCase):
    def test_charge_helper_returns_safe_failure_payload_without_content(self):
        from apps.services.llm.api import (
            _billing_charge_failed_result,
            _charge_llm_request_usage,
        )

        with patch(
            "apps.services.llm.services.billed_call.safe_charge_usage",
            return_value=False,
        ) as mock_safe_charge:
            charged = _charge_llm_request_usage(
                llm_service=SimpleNamespace(model=None),
                result={"success": True, "content": "paid result", "usage": {"total_tokens": 3}},
                user_id="user-1",
                organization_id="organization-1",
                request_id="request-1",
            )

        self.assertFalse(charged)
        mock_safe_charge.assert_called_once()

        payload = _billing_charge_failed_result("request-1")
        self.assertFalse(payload["success"])
        self.assertEqual(payload["error_code"], "BILLING_CHARGE_FAILED")
        self.assertNotIn("content", payload)
