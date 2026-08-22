"""view 层 _stream_error_response 测试 — 4 处 catch 块改造的回归测试。

[`proxy_api.llm_proxy`](../../proxy_api.py:46) view 函数 4 处 catch 块
(line 134/137/143/180)在 v0.2.1 后必须返回 StreamingHttpResponse 而非
JsonResponse,这样客户端 fetch 拿到 200 OK + SSE 流而不会 reject。

本测试只覆盖 helper 函数(_stream_error_response / _stream_error_for_proxy_error),
完整 view 端到端走 client.post 在 test_api.py 类的 e2e 里。
"""

from __future__ import annotations

import json
from unittest.mock import patch

from django.db import OperationalError
from django.http import StreamingHttpResponse
from django.test import SimpleTestCase

from apps.services.llm.proxy_api import (
    _is_database_connectivity_error,
    _stream_database_unavailable_response,
    _stream_error_response,
    _stream_error_for_proxy_error,
)
from apps.services.llm.services.proxy_service import ProxyError


class TestStreamErrorResponse(SimpleTestCase):
    def test_returns_streaming_http_response(self):
        resp = _stream_error_response(
            user_message="测试错误",
            error_code="t",
            status=400,
        )
        self.assertIsInstance(resp, StreamingHttpResponse)
        self.assertEqual(resp["Content-Type"], "text/event-stream")
        self.assertEqual(resp["Cache-Control"], "no-cache")
        self.assertEqual(resp["X-Accel-Buffering"], "no")

    def test_status_code_is_200_not_error_status(self):
        """SSE 流响应永远 200 OK,error 走流内 chunk(防 fetch reject)。"""
        resp = _stream_error_response(
            user_message="预算超限",
            error_code="budget_exceeded",
            status=402,
        )
        # HTTP status code 必须是 200(SSE 流意义上的 "成功开流"),
        # 业务错误在流内 chunk.error.status=402 体现
        self.assertEqual(resp.status_code, 200)

    def test_stream_content_has_error_then_done(self):
        resp = _stream_error_response(
            user_message="模型不存在",
            error_code="model_not_found",
            status=404,
        )
        body = b"".join(chunk.encode() if isinstance(chunk, str) else chunk for chunk in resp.streaming_content)
        text = body.decode("utf-8")
        # 至少包含一行 data: + [DONE]
        self.assertIn("data:", text)
        self.assertIn("[DONE]", text)
        # 解析 error chunk
        first_data = text.split("\n\n", 1)[0]
        self.assertTrue(first_data.startswith("data: "))
        payload = json.loads(first_data[6:].strip())
        self.assertEqual(payload["error"]["message"], "模型不存在")
        self.assertEqual(payload["error"]["status"], 404)
        self.assertEqual(payload["error"]["type"], "model_not_found")

    def test_request_id_header(self):
        resp = _stream_error_response(
            user_message="x",
            request_id="req-abc123",
        )
        self.assertEqual(resp["X-TabTin-Request-Id"], "req-abc123")

    def test_database_unavailable_response_has_structured_category(self):
        exc = OperationalError("connection to server at host port 5432 failed: timeout expired")
        with patch("apps.services.llm.proxy_api.logger"):
            resp = _stream_database_unavailable_response(
                stage="model_resolve",
                exc=exc,
                request_id="req-db-timeout",
            )

        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp["X-TabTin-Request-Id"], "req-db-timeout")
        body = b"".join(c.encode() if isinstance(c, str) else c for c in resp.streaming_content)
        first_data = body.decode("utf-8").split("\n\n", 1)[0]
        payload = json.loads(first_data[6:].strip())

        self.assertEqual(
            payload["error"]["type"],
            "llm_proxy_result_backend_unavailable",
        )
        self.assertEqual(
            payload["error"]["error_category"],
            "llm_proxy_result_backend_unavailable",
        )
        self.assertEqual(payload["error"]["stage"], "model_resolve")
        self.assertIn("远程数据库/结果服务暂时不可用", payload["error"]["message"])

    def test_database_connectivity_classifier_is_narrow(self):
        self.assertTrue(
            _is_database_connectivity_error(
                OperationalError("could not connect to server: timeout expired")
            )
        )
        self.assertFalse(_is_database_connectivity_error(OperationalError("deadlock detected")))
        self.assertFalse(_is_database_connectivity_error(ValueError("LLM proxy server error (500)")))


class TestStreamErrorForProxyError(SimpleTestCase):
    def test_budget_exceeded_renders_to_sse_chinese(self):
        exc = ProxyError(402, "budget_exceeded", "预算超限")
        resp = _stream_error_for_proxy_error(exc, request_id="r1")
        self.assertEqual(resp.status_code, 200)
        body = b"".join(c.encode() if isinstance(c, str) else c for c in resp.streaming_content)
        text = body.decode("utf-8")
        self.assertIn("预算", text)
        self.assertIn("budget_exceeded", text)
        self.assertEqual(resp["X-TabTin-Request-Id"], "r1")

    def test_freeze_failed_renders_chinese(self):
        exc = ProxyError(402, "freeze_failed", "冻结失败")
        resp = _stream_error_for_proxy_error(exc)
        body = b"".join(c.encode() if isinstance(c, str) else c for c in resp.streaming_content)
        text = body.decode("utf-8")
        self.assertIn("余额", text)

    def test_all_keys_exhausted_renders_chinese(self):
        exc = ProxyError(503, "all_keys_exhausted", "Key 全挂")
        resp = _stream_error_for_proxy_error(exc)
        body = b"".join(c.encode() if isinstance(c, str) else c for c in resp.streaming_content)
        text = body.decode("utf-8")
        self.assertIn("Key", text)
