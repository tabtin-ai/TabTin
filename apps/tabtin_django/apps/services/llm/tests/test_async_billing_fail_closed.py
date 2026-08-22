from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4

from django.test import SimpleTestCase

from apps.services.llm.tasks.llm_tasks import _process_single_llm_request


class TestAsyncBillingFailClosed(SimpleTestCase):
    def _model(self):
        return SimpleNamespace(
            id=uuid4(),
            model_name="gpt-4o-mini",
            provider=SimpleNamespace(provider_key="openai", name="OpenAI", scope="global"),
            input_price_per_1k="0.0015",
            output_price_per_1k="0.0060",
        )

    @patch("apps.services.llm.tasks.llm_tasks.report_provider_call_result")
    @patch("apps.services.llm.services.usage_tracking.record_usage_fact_from_dict_safely")
    @patch("apps.services.llm.services.usage_tracking.derive_scope_and_cost_status", return_value=("global", "platform_billed"))
    @patch("apps.services.llm.tasks.llm_tasks.charge_llm_usage", side_effect=Exception("charge failed"))
    @patch("apps.services.billing.services.billing_precheck.billing_precheck")
    @patch("apps.services.llm.tasks.llm_tasks.resolve_model")
    @patch("apps.services.llm.tasks.llm_tasks.get_llm_service")
    def test_process_single_llm_request_blocks_delivery_when_charge_fails(
        self,
        mock_service,
        mock_resolve,
        mock_precheck,
        mock_charge,
        _mock_scope,
        _mock_record_usage_fact,
        _mock_report,
    ):
        mock_precheck.return_value = SimpleNamespace(blocked=False)
        mock_resolve.return_value = self._model()
        mock_llm = MagicMock()
        mock_llm.chat.return_value = {
            "success": True,
            "content": "secret answer",
            "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15},
            "cost": {},
            "response_time": 0.5,
        }
        mock_llm.provider = None
        mock_llm.provider_key = None
        mock_service.return_value = mock_llm

        result = _process_single_llm_request({
            "request_id": str(uuid4()),
            "model_id": str(uuid4()),
            "messages": [{"role": "user", "content": "hi"}],
            "user_id": str(uuid4()),
            "organization_id": str(uuid4()),
            "parameters": {},
        })

        self.assertFalse(result["success"])
        self.assertEqual(result["error_code"], "BILLING_CHARGE_FAILED")
        self.assertNotIn("content", result)
        mock_charge.assert_called_once()
