"""#7844: 成员侧 probe 必须调用 apply_provider_runtime_feedback（不依赖完整 migrate）。"""

from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock, patch
from uuid import uuid4


class ProbeProviderPersistsFeedbackTests(TestCase):
    @patch("apps.services.llm.api_config.ensure_organization_permission")
    @patch("apps.services.llm.services.runtime.apply_provider_runtime_feedback")
    @patch("apps.services.llm.services.factory.LLMServiceFactory.create_service")
    @patch("apps.services.llm.api_config.LLMModel")
    @patch("apps.services.llm.api_config.LLMProvider")
    def test_failed_probe_invokes_runtime_feedback(
        self,
        provider_model,
        model_model,
        create_service,
        apply_feedback,
        _ensure_permission,
    ) -> None:
        from apps.services.llm.api_config import probe_provider

        organization_id = str(uuid4())
        provider_id = str(uuid4())
        provider = SimpleNamespace(
            id=provider_id,
            name="openai",
            api_key="sk-test",
            scope="organization",
            organization_id=organization_id,
            user_id=None,
        )
        provider_model.objects.get.return_value = provider
        target_model = SimpleNamespace(
            model_name="glm-5",
            base_url="https://147ai.com/v1",
        )
        model_model.objects.filter.return_value.filter.return_value.only.return_value.first.return_value = None
        model_model.objects.filter.return_value.only.return_value.first.return_value = target_model
        create_service.return_value.probe.return_value = {
            "valid": False,
            "level": 1,
            "error": "Authentication failed (HTTP 401)",
            "error_code": "unauthorized",
            "status_code": 401,
            "latency_ms": 175,
            "details": {},
        }
        apply_feedback.return_value = {
            "provider_id": provider_id,
            "runtime_status": "degraded",
            "is_success": False,
            "latency_ms": 175,
            "health_consecutive_failures": 1,
            "health_total_checks": 11,
            "health_success_checks": 10,
            "health_success_rate": 90.9,
        }
        request = SimpleNamespace(auth=SimpleNamespace(id=uuid4()))

        response = probe_provider.__wrapped__(
            request,
            organization_id,
            provider_id,
            level=1,
        )

        self.assertTrue(response["success"])
        self.assertFalse(response["data"]["valid"])
        self.assertEqual(response["data"]["runtime_status"], "degraded")
        apply_feedback.assert_called_once()
        kwargs = apply_feedback.call_args.kwargs
        self.assertIs(apply_feedback.call_args.args[0], provider)
        self.assertFalse(kwargs["is_success"])
        self.assertEqual(kwargs["latency_ms"], 175)
        self.assertIn("401", kwargs["error_message"])
        self.assertEqual(kwargs["check_type"], "manual")
        self.assertTrue(kwargs["persist_log"])

    @patch("apps.services.llm.api_config.ensure_organization_permission")
    @patch("apps.services.llm.services.runtime.apply_provider_runtime_feedback")
    @patch("apps.services.llm.services.factory.LLMServiceFactory.create_service")
    @patch("apps.services.llm.api_config.LLMModel")
    @patch("apps.services.llm.api_config.LLMProvider")
    def test_successful_probe_invokes_runtime_feedback(
        self,
        provider_model,
        model_model,
        create_service,
        apply_feedback,
        _ensure_permission,
    ) -> None:
        from apps.services.llm.api_config import probe_provider

        organization_id = str(uuid4())
        provider_id = str(uuid4())
        provider = SimpleNamespace(
            id=provider_id,
            name="openai",
            api_key="sk-test",
            scope="organization",
            organization_id=organization_id,
            user_id=None,
        )
        provider_model.objects.get.return_value = provider
        target_model = SimpleNamespace(
            model_name="glm-5",
            base_url="https://147ai.com/v1",
        )
        model_model.objects.filter.return_value.only.return_value.first.return_value = target_model
        create_service.return_value.probe.return_value = {
            "valid": True,
            "level": 1,
            "error": "",
            "latency_ms": 88,
            "details": {},
        }
        apply_feedback.return_value = {
            "provider_id": provider_id,
            "runtime_status": "healthy",
            "is_success": True,
            "latency_ms": 88,
            "health_consecutive_failures": 0,
            "health_total_checks": 1,
            "health_success_checks": 1,
            "health_success_rate": 100.0,
        }
        request = SimpleNamespace(auth=SimpleNamespace(id=uuid4()))

        response = probe_provider.__wrapped__(
            request,
            organization_id,
            provider_id,
            level=1,
        )

        self.assertTrue(response["success"])
        self.assertTrue(response["data"]["valid"])
        self.assertEqual(response["data"]["runtime_status"], "healthy")
        apply_feedback.assert_called_once()
        self.assertTrue(apply_feedback.call_args.kwargs["is_success"])
