from django.test import SimpleTestCase

from apps.services.llm.services.runtime import build_probe_failure_diagnostic


class ProbeFailureDiagnosticTests(SimpleTestCase):
    def test_authentication_failure_has_actionable_stage_without_raw_error(self):
        result = build_probe_failure_diagnostic(
            error="401 invalid api key sk-sensitive-value",
            error_code="AUTH_FAILED",
            status_code=401,
            model_name="qwen-plus",
        )

        self.assertEqual(result["failure_stage"], "authentication")
        self.assertEqual(result["http_status"], 401)
        self.assertIn("密钥", result["suggestion"])
        self.assertNotIn("sk-sensitive-value", str(result))

    def test_model_failure_identifies_configured_model(self):
        result = build_probe_failure_diagnostic(
            error="model not found",
            error_code="MODEL_NOT_FOUND",
            status_code=404,
            model_name="glm-4.7",
        )

        self.assertEqual(result["failure_stage"], "model")
        self.assertIn("glm-4.7", result["summary"])

    def test_connection_failure_has_connection_guidance(self):
        result = build_probe_failure_diagnostic(
            error="TLS connection timed out",
            model_name="deepseek-chat",
        )

        self.assertEqual(result["failure_stage"], "connection")
        self.assertIn("API 地址", result["suggestion"])
