"""
AI-015 回归测试 — 验证 SecurityHeadersMiddleware 安全头输出。

确保：
- X-XSS-Protection 设为 '0'（禁用已废弃的 XSS 审计器）
- Content-Security-Policy 包含完整的指令集
"""
import pytest
from django.http import HttpRequest, HttpResponse
from django.test import RequestFactory

from apps.services.common.middleware import SecurityHeadersMiddleware


@pytest.fixture
def middleware():
    return SecurityHeadersMiddleware(get_response=lambda r: HttpResponse("OK"))


@pytest.fixture
def factory():
    return RequestFactory()


class TestAI015_SecurityHeaders:
    """AI-015: SecurityHeadersMiddleware 安全头修复。"""

    def test_xss_protection_disabled(self, middleware, factory):
        """X-XSS-Protection 应设为 '0' 以禁用已废弃的 XSS 审计器。"""
        request = factory.get("/api/test")
        response = middleware.process_response(request, HttpResponse())
        assert response["X-XSS-Protection"] == "0", (
            f"X-XSS-Protection 应为 '0'，实际为 '{response['X-XSS-Protection']}'"
        )

    def test_xss_protection_not_legacy_value(self, middleware, factory):
        """X-XSS-Protection 不应使用废弃的 '1; mode=block'。"""
        request = factory.get("/api/test")
        response = middleware.process_response(request, HttpResponse())
        assert response["X-XSS-Protection"] != "1; mode=block"

    def test_csp_contains_required_directives(self, middleware, factory):
        """CSP 应包含完整的安全指令集。"""
        request = factory.get("/api/test")
        response = middleware.process_response(request, HttpResponse())
        csp = response["Content-Security-Policy"]

        required_directives = [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data:",
            "object-src 'none'",
            "frame-ancestors 'none'",
            "base-uri 'self'",
            "form-action 'self'",
        ]
        for directive in required_directives:
            assert directive in csp, (
                f"CSP 缺少必需指令: '{directive}'，完整 CSP: '{csp}'"
            )

    def test_csp_not_bare_default_src(self, middleware, factory):
        """CSP 不应仅为简单的 default-src 'self'。"""
        request = factory.get("/api/test")
        response = middleware.process_response(request, HttpResponse())
        csp = response["Content-Security-Policy"]
        assert csp != "default-src 'self'", (
            "CSP 不应仅包含 default-src 'self'，应有更完整的指令集"
        )

    def test_other_security_headers_present(self, middleware, factory):
        """其他安全头（X-Frame-Options, X-Content-Type-Options 等）应正常存在。"""
        request = factory.get("/api/test")
        response = middleware.process_response(request, HttpResponse())
        assert response["X-Frame-Options"] == "DENY"
        assert response["X-Content-Type-Options"] == "nosniff"
        assert response["Referrer-Policy"] == "strict-origin-when-cross-origin"


class TestViewDeclaredPolicyWins:
    """#3763: 视图显式声明的嵌入 / 内容策略，中间件必须让路而不是覆盖。"""

    def test_xframe_exempt_response_keeps_no_deny(self, middleware, factory):
        """视图标了 xframe_options_exempt（如 htmlBlock artifact）就不该再挨 DENY。"""
        request = factory.get("/api/services/oss/local-object", {"object_key": "tabdoc/html/demo.html"})
        response = HttpResponse("<html><body>ok</body></html>", content_type="text/html; charset=utf-8")
        response.xframe_options_exempt = True
        response = middleware.process_response(request, response)
        assert "X-Frame-Options" not in response
        # 其余默认安全头仍应照常补齐
        assert response["X-Content-Type-Options"] == "nosniff"
        assert response["Referrer-Policy"] == "strict-origin-when-cross-origin"

    def test_view_supplied_csp_is_not_overwritten(self, middleware, factory):
        """视图声明 csp_override 时其 CSP 原样保留，不被默认的 frame-ancestors 'none' 顶掉。"""
        request = factory.get("/api/services/oss/local-object", {"object_key": "tabdoc/html/demo.html"})
        response = HttpResponse("<html></html>", content_type="text/html; charset=utf-8")
        view_csp = "sandbox allow-scripts; frame-ancestors tabtin-file:"
        response["Content-Security-Policy"] = view_csp
        response.csp_override = True
        response = middleware.process_response(request, response)
        assert response["Content-Security-Policy"] == view_csp

    def test_stray_csp_header_without_optout_is_still_overwritten(self, middleware, factory):
        """光有 CSP 头不算声明——否则头注入 / 误拷上游头能让全局策略静默消失（fail-open）。"""
        request = factory.get("/api/test")
        response = HttpResponse()
        response["Content-Security-Policy"] = "default-src *"
        response = middleware.process_response(request, response)
        assert "frame-ancestors 'none'" in response["Content-Security-Policy"]
        assert "default-src *" not in response["Content-Security-Policy"]

    def test_plain_response_still_gets_defaults(self, middleware, factory):
        """没声明任何策略的普通响应，默认收敛值一个都不能少。"""
        request = factory.get("/api/test")
        response = middleware.process_response(request, HttpResponse())
        assert response["X-Frame-Options"] == "DENY"
        assert "frame-ancestors 'none'" in response["Content-Security-Policy"]
