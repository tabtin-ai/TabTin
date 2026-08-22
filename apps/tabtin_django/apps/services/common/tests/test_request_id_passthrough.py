"""
Wave 1 D3 / contract 项目 — X-Request-Id 跨进程透传回归测试。

业务目标：
  用户截图含 "操作失败 (req: a3b2c1)" → 开发者用 a3b2c1 直接 grep
  Django log + main 端 log 拿到完整调用链路。

本测试覆盖 Django 端契约：
  1. RequestIdMiddleware 独立保证三端 trace_id 一致（不依赖
     RequestLoggingMiddleware 是否启用）
  2. process_request 优先采用上游 X-Request-Id 头
  3. 上游没传时回退到 generate_request_id() 自产
  4. process_response 把 request.request_id echo 回 X-Request-Id 头
  5. 即使早期中间件在 process_request 之前抛错（譬如 RateLimit 直接
     返 429），response 仍带 X-Request-Id 头（用 hasattr 防御）
  6. 空字符串 X-Request-Id 不被当作"上游传了"——防御性兜底
  7. RequestContextMiddleware 行为对齐 RequestLoggingMiddleware
  8. RequestLoggingMiddleware 不覆盖已被 RequestIdMiddleware 设过的 trace
"""
import os
import sys

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402

django.setup()

import pytest  # noqa: E402
from django.http import HttpResponse  # noqa: E402
from django.test import RequestFactory  # noqa: E402


@pytest.fixture
def rf():
    return RequestFactory()


class TestRequestIdMiddleware:
    """RequestIdMiddleware 是 W1 D3 的实际生效中间件（已加进 settings.MIDDLEWARE）。

    设计上跟 RequestLoggingMiddleware 解耦：后者由于历史原因没启用，但
    本中间件独立保证 trace_id 全链路贯穿（包括 404、5xx 等任何响应）。
    """

    def test_upstream_x_request_id_used_when_present(self, rf):
        from apps.services.common.middleware import RequestIdMiddleware

        request = rf.get("/api/test/")
        request.META["HTTP_X_REQUEST_ID"] = "upstream-trace-rid"

        mw = RequestIdMiddleware(get_response=lambda r: None)
        mw.process_request(request)

        assert request.request_id == "upstream-trace-rid"

    def test_generated_when_upstream_missing(self, rf):
        from apps.services.common.middleware import RequestIdMiddleware

        request = rf.get("/api/test/")
        mw = RequestIdMiddleware(get_response=lambda r: None)
        mw.process_request(request)

        assert hasattr(request, "request_id") and request.request_id

    def test_does_not_overwrite_existing_request_id(self, rf):
        """Idempotent — 如果 request 已有 request_id（譬如其他 middleware 先
        设置），本中间件不应覆盖。这条是 trace_id 单源的关键保证。"""
        from apps.services.common.middleware import RequestIdMiddleware

        request = rf.get("/api/test/")
        request.request_id = "preset-by-upstream-mw"
        request.META["HTTP_X_REQUEST_ID"] = "should-be-ignored"

        mw = RequestIdMiddleware(get_response=lambda r: None)
        mw.process_request(request)

        assert request.request_id == "preset-by-upstream-mw"

    def test_empty_string_not_overwritten_check(self, rf):
        """request.request_id 是空字符串/None 时，应被视为未设置，重新生成。
        防御性：避免空 trace_id 让日志关联断掉。"""
        from apps.services.common.middleware import RequestIdMiddleware

        request = rf.get("/api/test/")
        request.request_id = ""  # 异常状态
        request.META["HTTP_X_REQUEST_ID"] = "from-upstream"

        mw = RequestIdMiddleware(get_response=lambda r: None)
        mw.process_request(request)

        assert request.request_id == "from-upstream"

    def test_response_echoes_trace_header(self, rf):
        from apps.services.common.middleware import RequestIdMiddleware

        request = rf.get("/api/test/")
        request.META["HTTP_X_REQUEST_ID"] = "echo-back-this"

        mw = RequestIdMiddleware(get_response=lambda r: None)
        mw.process_request(request)

        response = HttpResponse(status=200)
        result = mw.process_response(request, response)

        assert result["X-Request-Id"] == "echo-back-this"

    def test_response_echoes_for_404(self, rf):
        """关键：404 / 5xx 响应也必须带 trace 头——否则用户报障常见的
        '点哪都 404' 类问题就反查不到 Django 端日志。"""
        from apps.services.common.middleware import RequestIdMiddleware

        request = rf.get("/no/such/path")
        mw = RequestIdMiddleware(get_response=lambda r: None)
        mw.process_request(request)
        generated = request.request_id

        response = HttpResponse(status=404)
        result = mw.process_response(request, response)

        assert result["X-Request-Id"] == generated

    def test_response_skipped_when_no_request_id(self, rf):
        """request.request_id 因某原因不存在时（极端边界），不应抛错。"""
        from apps.services.common.middleware import RequestIdMiddleware

        request = rf.get("/api/test/")
        # 故意不调 process_request

        mw = RequestIdMiddleware(get_response=lambda r: None)
        response = HttpResponse(status=200)
        result = mw.process_response(request, response)

        assert "X-Request-Id" not in result

    def test_whitespace_stripped(self, rf):
        from apps.services.common.middleware import RequestIdMiddleware

        request = rf.get("/api/test/")
        request.META["HTTP_X_REQUEST_ID"] = "   "

        mw = RequestIdMiddleware(get_response=lambda r: None)
        mw.process_request(request)

        # 空白被剥掉 → fallback 到 generate
        assert request.request_id.strip() != ""
        assert request.request_id != "   "

    def test_access_log_emitted_for_normal_path(self, rf):
        """每个非健康检查请求都打一行 access log，含 trace_id（grep 反查支撑）。

        直接 patch logger 拦截调用——caplog 在 Django 全局 LOGGING dictConfig
        被加载时不一定有 propagate（取决于 settings.LOGGING 配置），所以
        改用 mock，确保不依赖运行环境的 logger 配置。
        """
        from unittest.mock import patch
        from apps.services.common.middleware import RequestIdMiddleware

        request = rf.get("/api/some-endpoint/")
        request.META["HTTP_X_REQUEST_ID"] = "log-grep-target"

        mw = RequestIdMiddleware(get_response=lambda r: None)
        mw.process_request(request)

        with patch(
            "apps.services.common.middleware._request_id_access_logger"
        ) as mock_logger:
            response = HttpResponse(status=200)
            mw.process_response(request, response)

        mock_logger.info.assert_called_once()
        args = mock_logger.info.call_args.args
        # 调用形态：logger.info(fmt, trace_id, method, path, status_code)
        assert "log-grep-target" in args
        assert "GET" in args
        assert "/api/some-endpoint/" in args
        assert 200 in args

    def test_health_check_paths_skip_access_log(self, rf):
        """健康检查路径不打 access log（避免污染日志）。"""
        from unittest.mock import patch
        from apps.services.common.middleware import RequestIdMiddleware

        for path in ("/health", "/health/", "/ping", "/ping/"):
            request = rf.get(path)
            mw = RequestIdMiddleware(get_response=lambda r: None)
            mw.process_request(request)

            with patch(
                "apps.services.common.middleware._request_id_access_logger"
            ) as mock_logger:
                response = HttpResponse(status=200)
                mw.process_response(request, response)

            mock_logger.info.assert_not_called()


class TestRequestLoggingMiddlewareTracePassthrough:
    """RequestLoggingMiddleware 对 X-Request-Id 的请求/响应处理。"""

    def test_upstream_x_request_id_used_when_present(self, rf):
        from apps.services.common.middleware import RequestLoggingMiddleware

        request = rf.get("/api/test/")
        request.META["HTTP_X_REQUEST_ID"] = "client-supplied-trace-12"

        mw = RequestLoggingMiddleware(get_response=lambda r: None)
        mw.process_request(request)

        assert request.request_id == "client-supplied-trace-12"

    def test_generated_when_upstream_header_missing(self, rf):
        from apps.services.common.middleware import RequestLoggingMiddleware

        request = rf.get("/api/test/")
        # 不设置 HTTP_X_REQUEST_ID

        mw = RequestLoggingMiddleware(get_response=lambda r: None)
        mw.process_request(request)

        assert hasattr(request, "request_id")
        assert isinstance(request.request_id, str)
        # generate_request_id() 形态: <YYYYMMDDHHmmSS>_<random8>
        assert len(request.request_id) == 23
        assert "_" in request.request_id

    def test_empty_string_x_request_id_treated_as_missing(self, rf):
        """空字符串视为缺失——上游 echo 一个空串不应让后端 trace 关联断掉。"""
        from apps.services.common.middleware import RequestLoggingMiddleware

        request = rf.get("/api/test/")
        request.META["HTTP_X_REQUEST_ID"] = ""

        mw = RequestLoggingMiddleware(get_response=lambda r: None)
        mw.process_request(request)

        assert request.request_id != ""
        # generate 的 fallback 形态
        assert "_" in request.request_id

    def test_whitespace_only_x_request_id_treated_as_missing(self, rf):
        """纯空白字符串视为缺失（防御性 trim）。"""
        from apps.services.common.middleware import RequestLoggingMiddleware

        request = rf.get("/api/test/")
        request.META["HTTP_X_REQUEST_ID"] = "   "

        mw = RequestLoggingMiddleware(get_response=lambda r: None)
        mw.process_request(request)

        assert request.request_id.strip() != ""
        assert "_" in request.request_id

    def test_response_echoes_request_id_when_present(self, rf):
        from apps.services.common.middleware import RequestLoggingMiddleware

        request = rf.get("/api/test/")
        request.META["HTTP_X_REQUEST_ID"] = "echo-trace-abc"

        mw = RequestLoggingMiddleware(get_response=lambda r: None)
        mw.process_request(request)

        response = HttpResponse(status=200)
        result = mw.process_response(request, response)

        assert result["X-Request-Id"] == "echo-trace-abc"

    def test_response_echoes_generated_id_when_no_upstream(self, rf):
        """上游没 X-Request-Id 时，Django 自己 generate 的 ID 也要 echo 回去
        让上游能反读对齐 ALS。"""
        from apps.services.common.middleware import RequestLoggingMiddleware

        request = rf.get("/api/test/")

        mw = RequestLoggingMiddleware(get_response=lambda r: None)
        mw.process_request(request)
        generated_id = request.request_id

        response = HttpResponse(status=200)
        result = mw.process_response(request, response)

        assert result["X-Request-Id"] == generated_id

    def test_response_skips_header_when_request_id_missing(self, rf):
        """request_id 不存在时（譬如 process_request 完全没跑）不应抛错。"""
        from apps.services.common.middleware import RequestLoggingMiddleware

        request = rf.get("/api/test/")
        # 故意不调 process_request

        mw = RequestLoggingMiddleware(get_response=lambda r: None)
        response = HttpResponse(status=200)
        result = mw.process_response(request, response)

        assert "X-Request-Id" not in result

    def test_response_writes_header_even_when_start_time_missing(self, rf):
        """RateLimit 早抛 429 时 process_request 还没设 start_time，
        但若 request_id 已经被设进来仍应 echo 头（trace 关联高优先级）。"""
        from apps.services.common.middleware import RequestLoggingMiddleware

        request = rf.get("/api/test/")
        request.request_id = "early-set-trace"
        # 故意不设 start_time

        mw = RequestLoggingMiddleware(get_response=lambda r: None)
        response = HttpResponse(status=200)
        result = mw.process_response(request, response)

        assert result["X-Request-Id"] == "early-set-trace"

    def test_does_not_overwrite_request_id_set_by_upstream_middleware(self, rf):
        """关键：RequestIdMiddleware 跑在前面已经设 request.request_id 时，
        RequestLoggingMiddleware 不能覆盖之——单源 trace_id 是 echo 头与
        日志、envelope 三处一致的前提。"""
        from apps.services.common.middleware import RequestLoggingMiddleware

        request = rf.get("/api/test/")
        request.request_id = "set-by-request-id-mw"
        # 即便 META 里也有 X-Request-Id，也应保留已设的值
        request.META["HTTP_X_REQUEST_ID"] = "should-be-ignored-2"

        mw = RequestLoggingMiddleware(get_response=lambda r: None)
        mw.process_request(request)

        assert request.request_id == "set-by-request-id-mw"


class TestRequestContextMiddlewareTracePassthrough:
    """RequestContextMiddleware 行为对齐 RequestLoggingMiddleware。"""

    def test_upstream_header_takes_precedence(self, rf):
        from apps.services.common.middleware import RequestContextMiddleware

        request = rf.get("/api/test/")
        request.META["HTTP_X_REQUEST_ID"] = "ctx-upstream-trace"

        mw = RequestContextMiddleware(get_response=lambda r: None)
        mw.process_request(request)

        assert request.request_id == "ctx-upstream-trace"

    def test_existing_request_id_not_overwritten(self, rf):
        """如果 RequestLoggingMiddleware 先跑过设置了 request_id，
        RequestContextMiddleware 不应覆盖（保持 deterministic 行为）。"""
        from apps.services.common.middleware import RequestContextMiddleware

        request = rf.get("/api/test/")
        request.request_id = "preset-by-upstream-mw"
        # 即使 META 里也有 X-Request-Id 也以已设的为准
        request.META["HTTP_X_REQUEST_ID"] = "should-be-ignored"

        mw = RequestContextMiddleware(get_response=lambda r: None)
        mw.process_request(request)

        assert request.request_id == "preset-by-upstream-mw"

    def test_generated_when_no_upstream_and_no_preset(self, rf):
        from apps.services.common.middleware import RequestContextMiddleware

        request = rf.get("/api/test/")

        mw = RequestContextMiddleware(get_response=lambda r: None)
        mw.process_request(request)

        assert hasattr(request, "request_id")
        assert "_" in request.request_id


class TestEndToEndTraceFlow:
    """模拟 main 端 → Django 完整调用：trace_id 三端一致。"""

    def test_trace_flows_from_request_to_response_to_envelope(self, rf):
        from apps.services.common.middleware import RequestLoggingMiddleware
        from apps.services.common.error_codes import err_response, ok_response

        request = rf.get("/api/test/")
        request.META["HTTP_X_REQUEST_ID"] = "e2e-trace-xyz"

        mw = RequestLoggingMiddleware(get_response=lambda r: None)
        mw.process_request(request)

        # 业务层用 err_response/ok_response 自动从 request 拿 trace_id
        envelope_err = err_response("NOT_FOUND", "missing", request=request)
        envelope_ok = ok_response({"x": 1}, request=request)

        assert envelope_err["trace_id"] == "e2e-trace-xyz"
        assert envelope_ok["trace_id"] == "e2e-trace-xyz"

        # 响应头 echo 同一 trace
        response = HttpResponse(status=404)
        mw.process_response(request, response)
        assert response["X-Request-Id"] == "e2e-trace-xyz"


class TestCorsAllowsXRequestId:
    """X-Request-Id 必须在 CORS 允许的请求头列表里，
    否则 renderer 直接 fetch（W2 之后）会被浏览器 preflight 剥离。"""

    def test_x_request_id_in_allowed_headers(self):
        from apps.services.common.middleware import CORSMiddleware

        mw = CORSMiddleware(get_response=lambda r: None)
        # 大小写无关 — CORS 协议规范
        normalized = [h.lower() for h in mw.allowed_headers]
        assert "x-request-id" in normalized
