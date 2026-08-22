"""#6133: 连通性探针失败时透传 error_code / status_code（无 DB）。"""

from __future__ import annotations

from unittest.mock import patch

from django.test import SimpleTestCase

from apps.services.llm.services.base import BaseLLMService


class _DummyProbeService(BaseLLMService):
    def _do_chat(self, messages, **kwargs):
        return {
            "success": True,
            "content": "ok",
            "usage": {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0},
        }

    def chat_stream(self, messages, **kwargs):
        yield {"success": True, "content": "", "finished": True}

    def _validate_connection(self):
        return {"valid": True, "details": {}}


class ProbeErrorCodePropagationTests(SimpleTestCase):
    def test_probe_propagates_error_code_and_status_code(self):
        service = _DummyProbeService({
            "name": "openai",
            "api_key": "sk-test-key",
            "base_url": "https://api.openai.com/v1",
            "model_name": "gpt-4",
            "max_retries": 0,
            "retry_delay": 0,
        })

        with patch.object(
            service,
            "validate_config",
            return_value={"valid": True, "details": {}},
        ), patch.object(
            service,
            "chat",
            return_value={
                "success": False,
                "error": "Error code: 404 - model not found",
                "error_code": "MODEL_NOT_FOUND",
                "status_code": 404,
            },
        ):
            result = service.probe(level=1, model_name="gpt-5")

        self.assertFalse(result["valid"])
        self.assertEqual(result["error_code"], "MODEL_NOT_FOUND")
        self.assertEqual(result["status_code"], 404)
        self.assertIn("404", result["error"] or "")
        self.assertEqual(result["details"]["level_1"]["error_code"], "MODEL_NOT_FOUND")

    def test_probe_classifies_raised_exception(self):
        service = _DummyProbeService({
            "name": "openai",
            "api_key": "sk-test-key",
            "base_url": "https://api.openai.com/v1",
            "model_name": "gpt-4",
            "max_retries": 0,
            "retry_delay": 0,
        })

        exc = Exception("boom")
        exc.status_code = 401  # type: ignore[attr-defined]

        with patch.object(
            service,
            "validate_config",
            return_value={"valid": True, "details": {}},
        ), patch.object(service, "chat", side_effect=exc):
            result = service.probe(level=1, model_name="gpt-5")

        self.assertFalse(result["valid"])
        self.assertEqual(result["error_code"], "AUTH_FAILED")
        self.assertEqual(result["status_code"], 401)
