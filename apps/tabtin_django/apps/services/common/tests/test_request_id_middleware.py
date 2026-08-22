import json
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.http import JsonResponse
from django.test import RequestFactory, SimpleTestCase, override_settings


class RequestIdMiddlewareTraceEnvelopeTests(SimpleTestCase):
    def setUp(self):
        self.factory = RequestFactory()

    def test_json_error_response_gets_trace_id(self):
        from apps.services.common.middleware import RequestIdMiddleware

        request = self.factory.get("/api/extensions")
        request.request_id = "trace-123"
        response = JsonResponse({"ok": False, "error": "Unauthorized"}, status=401)

        result = RequestIdMiddleware(lambda req: response).process_response(request, response)

        self.assertEqual(result["X-Request-Id"], "trace-123")
        self.assertEqual(json.loads(result.content)["trace_id"], "trace-123")

    def test_json_success_response_is_not_modified(self):
        from apps.services.common.middleware import RequestIdMiddleware

        request = self.factory.get("/api/extensions")
        request.request_id = "trace-123"
        response = JsonResponse({"ok": True}, status=200)

        result = RequestIdMiddleware(lambda req: response).process_response(request, response)

        self.assertNotIn("trace_id", json.loads(result.content))


class HealthCheckMiddlewareReadyTests(SimpleTestCase):
    def setUp(self):
        self.factory = RequestFactory()

    @override_settings(HEALTH_CHECK_TOKEN="health-token")
    @patch("django_redis.get_redis_connection")
    @patch("django.db.connections")
    def test_ready_uses_single_postgresql_check_name(self, mock_connections, mock_get_redis):
        from apps.services.common.middleware import HealthCheckMiddleware

        cursor = MagicMock()
        mock_connections.__getitem__.return_value.cursor.return_value = cursor
        mock_get_redis.return_value = SimpleNamespace(ping=lambda: True)

        request = self.factory.get(
            "/health/ready",
            HTTP_AUTHORIZATION="Bearer health-token",
        )
        request.request_id = "trace-123"
        response = HealthCheckMiddleware(lambda req: None)._deep_health_check(request)
        payload = json.loads(response.content)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["status"], "ready")
        self.assertEqual(payload["checks"]["postgresql"], "ok")
        self.assertEqual(payload["checks"]["redis"], "ok")
        self.assertNotIn("mysql", payload["checks"])
        mock_connections.__getitem__.assert_called_once_with("default")

