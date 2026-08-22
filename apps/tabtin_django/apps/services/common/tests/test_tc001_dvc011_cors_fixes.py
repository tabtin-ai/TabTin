"""TC-009 / TC-019：CORS 动态白名单与拒绝日志回归测试。"""
import os
import sys

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402

django.setup()

from unittest.mock import patch, MagicMock  # noqa: E402


# ────────────────────────────────────────────────────────
# TC-019: CORS 拒绝 origin 时记录 warning 日志
# ────────────────────────────────────────────────────────


class TestTC019_CORSRejectionLogging:
    """当 origin 不在白名单且非通配符时，应记录 warning 日志。"""

    @patch.dict(
        os.environ,
        {"CORS_ALLOWED_ORIGINS": "https://www.example.com,https://site.example.com"},
    )
    def test_rejected_origin_logs_warning(self):
        from apps.services.common.middleware import CORSMiddleware

        with patch("django.conf.settings.DEBUG", False):
            mw = CORSMiddleware(get_response=lambda r: None)

        response = MagicMock()
        response.__setitem__ = MagicMock()
        response.__contains__ = MagicMock(return_value=False)

        with patch("apps.services.common.middleware.logger") as mock_logger:
            with patch.object(mw, '_is_tabsite_custom_domain', return_value=False):
                mw._set_cors_headers(response, "https://evil.com")
            rejection_calls = [
                c for c in mock_logger.warning.call_args_list
                if "Origin 被拒绝" in str(c)
            ]
            assert len(rejection_calls) == 1, f"期望恰好 1 次 CORS 拒绝日志，实际: {mock_logger.warning.call_args_list}"
            assert "evil.com" in str(rejection_calls[0])

    @patch.dict(
        os.environ,
        {"CORS_ALLOWED_ORIGINS": "https://www.example.com"},
    )
    def test_allowed_origin_does_not_log_warning(self):
        from apps.services.common.middleware import CORSMiddleware

        with patch("django.conf.settings.DEBUG", False):
            mw = CORSMiddleware(get_response=lambda r: None)

        response = MagicMock()
        response.__setitem__ = MagicMock()
        response.__contains__ = MagicMock(return_value=False)

        with patch("apps.services.common.middleware.logger") as mock_logger:
            mw._set_cors_headers(response, "https://www.example.com")
            mock_logger.warning.assert_not_called()


# ────────────────────────────────────────────────────────
# TC-009: 自定义域名 CORS 动态白名单
# ────────────────────────────────────────────────────────


class TestTC009_CustomDomainCORS:
    """CORSMiddleware 应通过缓存查询支持 TabSite 自定义域名。"""

    @patch.dict(
        os.environ,
        {"CORS_ALLOWED_ORIGINS": "https://www.example.com"},
    )
    def test_custom_domain_origin_allowed_via_cache(self):
        """缓存中存在自定义域名时，该 origin 应被允许。"""
        from apps.services.common.middleware import CORSMiddleware

        with patch("django.conf.settings.DEBUG", False):
            mw = CORSMiddleware(get_response=lambda r: None)

        cached_domains = {"https://my-site.example.com", "http://my-site.example.com"}
        with patch("django.core.cache.cache.get", return_value=cached_domains):
            assert mw._origin_allowed("https://my-site.example.com") is True

    @patch.dict(
        os.environ,
        {"CORS_ALLOWED_ORIGINS": "https://www.example.com"},
    )
    def test_unknown_origin_rejected_with_empty_cache(self):
        """缓存为空集合时，不在白名单的 origin 应被拒绝。"""
        from apps.services.common.middleware import CORSMiddleware

        with patch("django.conf.settings.DEBUG", False):
            mw = CORSMiddleware(get_response=lambda r: None)

        with patch("django.core.cache.cache.get", return_value=set()):
            assert mw._origin_allowed("https://unknown.example.com") is False

    @patch.dict(
        os.environ,
        {"CORS_ALLOWED_ORIGINS": "https://www.example.com"},
    )
    def test_cache_miss_triggers_db_query(self):
        """缓存未命中时应查询 Site 模型并写回缓存。"""
        from apps.services.common.middleware import CORSMiddleware

        with patch("django.conf.settings.DEBUG", False):
            mw = CORSMiddleware(get_response=lambda r: None)

        mock_qs = MagicMock()
        mock_qs.exclude.return_value = mock_qs
        mock_qs.values_list.return_value = ["my-site.example.com"]

        with patch("django.core.cache.cache.get", return_value=None) as mock_get, \
             patch("django.core.cache.cache.set") as mock_set, \
             patch("apps.tabsite.models.Site.objects", mock_qs):
            result = mw._origin_allowed("https://my-site.example.com")
            assert result is True
            mock_set.assert_called_once()
            cached_set = mock_set.call_args[0][1]
            assert "https://my-site.example.com" in cached_set

    @patch.dict(
        os.environ,
        {"CORS_ALLOWED_ORIGINS": "https://www.example.com"},
    )
    def test_db_query_failure_returns_false(self):
        """DB 查询异常时应降级返回 False，不影响主流程。"""
        from apps.services.common.middleware import CORSMiddleware

        with patch("django.conf.settings.DEBUG", False):
            mw = CORSMiddleware(get_response=lambda r: None)

        with patch("django.core.cache.cache.get", side_effect=Exception("Redis down")):
            assert mw._origin_allowed("https://my-site.example.com") is False
