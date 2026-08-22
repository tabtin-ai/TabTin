"""
CC-001 / CC-023 回归测试：CORS 与限流中间件修复

CC-001: 生产环境未配置 CORS_ALLOWED_ORIGINS 时必须 fail-fast，不能静默拒绝所有跨域请求
CC-023: /s/{slug}/ 站点公开访问路径应使用更高限流阈值
"""
import os
import sys

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402

django.setup()

import pytest  # noqa: E402
from unittest.mock import patch  # noqa: E402
from django.core.exceptions import ImproperlyConfigured  # noqa: E402


# ────────────────────────────────────────────────────────
# CC-001: CORSMiddleware 生产环境 fail-fast
# ────────────────────────────────────────────────────────


class TestCC001_CORSMiddlewareProductionGuard:
    """CC-001: 生产环境未配置 CORS_ALLOWED_ORIGINS 必须抛 ImproperlyConfigured。"""

    @patch.dict(os.environ, {"CORS_ALLOWED_ORIGINS": "*"})
    def test_production_without_cors_config_raises(self):
        """未配置 CORS_ALLOWED_ORIGINS 的生产环境应启动失败。"""
        from apps.services.common.middleware import CORSMiddleware

        with patch("django.conf.settings.DEBUG", False):
            with pytest.raises(ImproperlyConfigured, match="CORS_ALLOWED_ORIGINS"):
                CORSMiddleware(get_response=lambda r: None)

    def test_production_default_env_raises(self):
        """CORS_ALLOWED_ORIGINS 完全未设置（取默认值 *）在生产环境也应失败。"""
        env = os.environ.copy()
        env.pop("CORS_ALLOWED_ORIGINS", None)

        from apps.services.common.middleware import CORSMiddleware

        with patch.dict(os.environ, env, clear=True):
            with patch("django.conf.settings.DEBUG", False):
                with pytest.raises(ImproperlyConfigured):
                    CORSMiddleware(get_response=lambda r: None)

    @patch.dict(os.environ, {"CORS_ALLOWED_ORIGINS": "*"})
    def test_debug_mode_allows_wildcard(self):
        """DEBUG 模式下 * 通配符应正常工作。"""
        from apps.services.common.middleware import CORSMiddleware

        with patch("django.conf.settings.DEBUG", True):
            mw = CORSMiddleware(get_response=lambda r: None)
            assert mw.allowed_origins == ["*"]

    @patch.dict(
        os.environ,
        {"CORS_ALLOWED_ORIGINS": "https://www.example.com,https://site.example.com"},
    )
    def test_production_with_explicit_origins_works(self):
        """显式配置 CORS 源的生产环境应正常初始化。"""
        from apps.services.common.middleware import CORSMiddleware

        with patch("django.conf.settings.DEBUG", False):
            mw = CORSMiddleware(get_response=lambda r: None)
            assert "https://www.example.com" in mw.allowed_origins
            assert "https://site.example.com" in mw.allowed_origins


# ────────────────────────────────────────────────────────
# : CORS 暴露 Content-Disposition（DOCX 导出文件名）
# ────────────────────────────────────────────────────────


class TestExposeContentDisposition:
    """: 跨域 fetch 必须能读到 Content-Disposition，否则导出 DOCX
    文件名退化成默认 document.docx。"""

    @patch.dict(
        os.environ,
        {"CORS_ALLOWED_ORIGINS": "https://www.example.com"},
    )
    def test_allowed_origin_exposes_content_disposition(self):
        from django.http import HttpResponse

        from apps.services.common.middleware import CORSMiddleware

        with patch("django.conf.settings.DEBUG", False):
            mw = CORSMiddleware(get_response=lambda r: None)

        response = HttpResponse()
        mw._set_cors_headers(response, "https://www.example.com")

        exposed = response["Access-Control-Expose-Headers"]
        assert "Content-Disposition" in exposed

    @patch.dict(os.environ, {"CORS_ALLOWED_ORIGINS": "*"})
    def test_wildcard_origin_exposes_content_disposition(self):
        from django.http import HttpResponse

        from apps.services.common.middleware import CORSMiddleware

        with patch("django.conf.settings.DEBUG", True):
            mw = CORSMiddleware(get_response=lambda r: None)

        response = HttpResponse()
        mw._set_cors_headers(response, "https://example.com")

        assert "Content-Disposition" in response["Access-Control-Expose-Headers"]

    @patch.dict(os.environ, {"CORS_ALLOWED_ORIGINS": "http://127.0.0.1:5173"})
    def test_table_share_headers_are_allowed(self):
        from django.http import HttpResponse

        from apps.services.common.middleware import CORSMiddleware

        with patch("django.conf.settings.DEBUG", False):
            mw = CORSMiddleware(get_response=lambda r: None)

        response = HttpResponse()
        mw._set_cors_headers(response, "http://127.0.0.1:5173")

        allowed = response["Access-Control-Allow-Headers"]
        assert "X-Table-Share-Id" in allowed
        assert "X-Table-Share-Password" in allowed
        # ：历史头也曾被 SharedTablePage 使用，须继续放行以免加密分享预检失败
        assert "X-Share-Password" in allowed


# ────────────────────────────────────────────────────────
# : CORS 预检须允许 PATCH（版本历史置顶/重命名）
# ────────────────────────────────────────────────────────


class TestIssue1556_CorsAllowsPatch:
    """: renderer 直 fetch PATCH 时 CORS 预检须放行 PATCH。"""

    @patch.dict(os.environ, {"CORS_ALLOWED_ORIGINS": "*"})
    def test_options_preflight_includes_patch(self):
        from django.http import HttpResponse
        from django.test import RequestFactory

        from apps.services.common.middleware import CORSMiddleware

        with patch("django.conf.settings.DEBUG", True):
            mw = CORSMiddleware(get_response=lambda r: HttpResponse())

        request = RequestFactory().options(
            "/api/collab/v1/docs/doc-id/versions/v-id/pin",
            HTTP_ORIGIN="http://127.0.0.1:5175",
        )
        response = mw.process_request(request)

        assert response is not None
        methods = response["Access-Control-Allow-Methods"]
        assert "PATCH" in methods


# ────────────────────────────────────────────────────────
# CC-023: /s/ 路径限流阈值
# ────────────────────────────────────────────────────────


class TestCC023_RateLimitSiteAccessTier:
    """CC-023: /s/{slug}/ 路径应有独立的高阈值限流规则。"""

    def test_site_access_path_has_dedicated_tier(self):
        """验证 /s/ 前缀存在于 _TIER_RULES 中。"""
        from apps.services.common.middleware import RateLimitMiddleware

        prefixes = [rule[0] for rule in RateLimitMiddleware._TIER_RULES]
        assert "/s/" in prefixes

    def test_site_access_tier_limit_higher_than_default(self):
        """站点访问限流阈值应高于默认值。"""
        from apps.services.common.middleware import RateLimitMiddleware

        site_rule = None
        for prefix, limit, window in RateLimitMiddleware._TIER_RULES:
            if prefix == "/s/":
                site_rule = (prefix, limit, window)
                break

        assert site_rule is not None, "/s/ 规则未找到"
        assert site_rule[1] > RateLimitMiddleware._DEFAULT_LIMIT

    def test_resolve_tier_matches_site_path(self):
        """_resolve_tier 应正确匹配 /s/my-slug/ 到站点规则。"""
        from apps.services.common.middleware import RateLimitMiddleware

        mw = RateLimitMiddleware.__new__(RateLimitMiddleware)
        tier_key, limit, window = mw._resolve_tier("/s/my-cool-site/")

        assert limit > 100
        assert "s" in tier_key

    def test_resolve_tier_api_path_unaffected(self):
        """普通 API 路径不受站点规则影响，仍走默认限流。"""
        from apps.services.common.middleware import RateLimitMiddleware

        mw = RateLimitMiddleware.__new__(RateLimitMiddleware)
        tier_key, limit, window = mw._resolve_tier("/api/some/endpoint/")

        assert limit == RateLimitMiddleware._DEFAULT_LIMIT
