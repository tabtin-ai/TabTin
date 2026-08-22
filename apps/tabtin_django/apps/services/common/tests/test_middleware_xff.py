"""
AI-013 / AI-014 回归测试：中间件层 XFF IP 提取统一使用 get_client_ip

验证：
  - RateLimitMiddleware 在 JWT 解析失败时的 IP 兜底路径使用安全的 get_client_ip
  - SensitivePathBlockMiddleware / RequestContextMiddleware / RequestLoggingMiddleware
    的 IP 提取均委托给 get_client_ip（遵守 TRUSTED_PROXY_COUNT 配置）
  - OpenApiLoggingMiddleware（tabdata/middleware/api_logging.py）同理
"""
import os
import sys

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402
from unittest.mock import patch, MagicMock  # noqa: E402
from django.test import RequestFactory  # noqa: E402


@pytest.fixture
def rf():
    return RequestFactory()


def _make_request(rf, xff_header=None, remote_addr="10.0.0.1", path="/api/test/"):
    """构造带有指定 XFF 和 REMOTE_ADDR 的请求对象。"""
    request = rf.get(path)
    request.META["REMOTE_ADDR"] = remote_addr
    if xff_header is not None:
        request.META["HTTP_X_FORWARDED_FOR"] = xff_header
    else:
        request.META.pop("HTTP_X_FORWARDED_FOR", None)
    return request


# ────────────────────────────────────────────────────────
# AI-013: RateLimitMiddleware 的 IP 兜底路径
# ────────────────────────────────────────────────────────


class TestAI013_RateLimitMiddlewareIPFallback:
    """确保 RateLimitMiddleware 的 IP 兜底路径不再直接取 XFF[0]。"""

    def test_spoofed_xff_ignored_when_no_trusted_proxy(self, rf):
        """TRUSTED_PROXY_COUNT=0 时，伪造的 XFF 不应影响限流 key。"""
        from apps.services.common.middleware import RateLimitMiddleware

        request = _make_request(rf, xff_header="1.2.3.4, 5.6.7.8", remote_addr="10.0.0.1")
        request.META.pop("HTTP_AUTHORIZATION", None)

        mw = RateLimitMiddleware(get_response=lambda r: None)
        with patch("apps.services.common.middleware.get_client_ip", return_value="10.0.0.1") as mock_ip:
            client_id = mw._get_client_identifier(request)

        mock_ip.assert_called_once_with(request)
        assert client_id == "ip:10.0.0.1"

    def test_xff_used_correctly_with_trusted_proxy(self, rf):
        """TRUSTED_PROXY_COUNT=1 时，从 XFF 右起第 1 个 IP 作为限流 key。"""
        from apps.services.common.middleware import RateLimitMiddleware

        request = _make_request(rf, xff_header="1.2.3.4, 5.6.7.8", remote_addr="10.0.0.1")
        request.META.pop("HTTP_AUTHORIZATION", None)

        mw = RateLimitMiddleware(get_response=lambda r: None)
        with patch("apps.services.common.middleware.get_client_ip", return_value="5.6.7.8") as mock_ip:
            client_id = mw._get_client_identifier(request)

        assert client_id == "ip:5.6.7.8"

    def test_no_xff_no_remote_addr_returns_unknown(self, rf):
        """无 XFF 且无 REMOTE_ADDR 时，限流 key 降级为 'ip:unknown'。"""
        from apps.services.common.middleware import RateLimitMiddleware

        request = _make_request(rf, remote_addr="")
        request.META.pop("HTTP_AUTHORIZATION", None)

        mw = RateLimitMiddleware(get_response=lambda r: None)
        with patch("apps.services.common.middleware.get_client_ip", return_value=None):
            client_id = mw._get_client_identifier(request)

        assert client_id == "ip:unknown"

    def test_jwt_user_takes_priority_over_ip(self, rf):
        """携带有效 JWT 时，限流 key 应为 user:{id} 而非 IP。"""
        import base64
        import json as _json
        from apps.services.common.middleware import RateLimitMiddleware

        payload = base64.urlsafe_b64encode(
            _json.dumps({"user_id": "u-abc-123"}).encode()
        ).rstrip(b"=").decode()
        fake_jwt = f"header.{payload}.signature"

        request = _make_request(rf, xff_header="1.2.3.4")
        request.META["HTTP_AUTHORIZATION"] = f"Bearer {fake_jwt}"

        mw = RateLimitMiddleware(get_response=lambda r: None)
        client_id = mw._get_client_identifier(request)
        assert client_id == "user:u-abc-123"


# ────────────────────────────────────────────────────────
# AI-014: 中间件层 _get_client_ip 统一委托
# ────────────────────────────────────────────────────────


class TestAI014_MiddlewareIPDelegation:
    """确保 middleware.py 中所有 IP 提取路径均委托给 get_client_ip。"""

    def test_request_logging_middleware_uses_get_client_ip(self, rf):
        from apps.services.common.middleware import RequestLoggingMiddleware

        request = _make_request(rf, xff_header="spoofed.ip")
        with patch("apps.services.common.middleware.get_client_ip", return_value="10.0.0.1") as mock_ip:
            mw = RequestLoggingMiddleware(get_response=lambda r: None)
            mw.process_request(request)

        mock_ip.assert_called_with(request)

    def test_sensitive_path_block_uses_get_client_ip(self, rf):
        from apps.services.common.middleware import SensitivePathBlockMiddleware

        request = _make_request(rf, xff_header="spoofed.ip", path="/.env")
        with patch("apps.services.common.middleware.get_client_ip", return_value="10.0.0.1") as mock_ip:
            mw = SensitivePathBlockMiddleware(get_response=lambda r: None)
            mw.process_request(request)

        mock_ip.assert_called_once_with(request)

    def test_request_context_middleware_uses_get_client_ip(self, rf):
        from apps.services.common.middleware import RequestContextMiddleware

        request = _make_request(rf, xff_header="spoofed.ip")
        with patch("apps.services.common.middleware.get_client_ip", return_value="10.0.0.1") as mock_ip:
            mw = RequestContextMiddleware(get_response=lambda r: None)
            mw.process_request(request)

        mock_ip.assert_called_once_with(request)
        assert request.client_ip == "10.0.0.1"


class TestAI014_OpenApiLoggingMiddlewareIPDelegation:
    """确保 tabdata/middleware/api_logging.py 的 _get_client_ip 委托给 get_client_ip。"""

    def test_delegates_to_get_client_ip(self, rf):
        from apps.tabdata.middleware.api_logging import _get_client_ip

        request = _make_request(rf, xff_header="spoofed.ip", remote_addr="10.0.0.1")
        with patch("apps.users.auth.utils.get_client_ip", return_value="10.0.0.1") as mock_ip:
            result = _get_client_ip(request)

        mock_ip.assert_called_once_with(request)
        assert result == "10.0.0.1"

    def test_returns_empty_string_when_get_client_ip_returns_none(self, rf):
        from apps.tabdata.middleware.api_logging import _get_client_ip

        request = _make_request(rf, remote_addr="")
        with patch("apps.users.auth.utils.get_client_ip", return_value=None):
            result = _get_client_ip(request)

        assert result == ""


# ────────────────────────────────────────────────────────
# 集成测试：验证 get_client_ip 实际行为与中间件一致
# ────────────────────────────────────────────────────────


class TestGetClientIPIntegration:
    """端到端验证 get_client_ip 在不同 TRUSTED_PROXY_COUNT 设置下的行为。"""

    def test_trusted_proxy_count_zero_ignores_xff(self, rf):
        """TRUSTED_PROXY_COUNT=0（默认）时 XFF 被忽略，返回 REMOTE_ADDR。"""
        from apps.users.auth.utils import get_client_ip

        request = _make_request(rf, xff_header="1.2.3.4, 5.6.7.8", remote_addr="10.0.0.1")
        with patch("apps.users.auth.utils.settings") as mock_settings:
            mock_settings.TRUSTED_PROXY_COUNT = 0
            ip = get_client_ip(request)

        assert ip == "10.0.0.1"

    def test_trusted_proxy_count_one_takes_rightmost(self, rf):
        """TRUSTED_PROXY_COUNT=1 时取 XFF 右起第 1 个。"""
        from apps.users.auth.utils import get_client_ip

        request = _make_request(rf, xff_header="1.2.3.4, 5.6.7.8", remote_addr="10.0.0.1")
        with patch("apps.users.auth.utils.settings") as mock_settings:
            mock_settings.TRUSTED_PROXY_COUNT = 1
            ip = get_client_ip(request)

        assert ip == "5.6.7.8"

    def test_trusted_proxy_count_two_takes_second_from_right(self, rf):
        """TRUSTED_PROXY_COUNT=2 时取 XFF 右起第 2 个。"""
        from apps.users.auth.utils import get_client_ip

        request = _make_request(rf, xff_header="1.2.3.4, 5.6.7.8, 9.0.0.1", remote_addr="10.0.0.1")
        with patch("apps.users.auth.utils.settings") as mock_settings:
            mock_settings.TRUSTED_PROXY_COUNT = 2
            ip = get_client_ip(request)

        assert ip == "5.6.7.8"
