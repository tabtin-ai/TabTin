"""
DE-20 回归测试：/devices/activate IP 速率限制

验证 _check_activate_rate_limit 函数：
1. 正常请求（首次）应通过
2. 超过限额（10次后）应被拒绝
3. Redis 故障时应 Fail-Close（拒绝）
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

from django.http import HttpRequest
from django.test import SimpleTestCase


class TestActivateRateLimit(SimpleTestCase):
    """DE-20: _check_activate_rate_limit 单元测试。"""

    def _make_request(self, ip: str = "192.168.1.1") -> HttpRequest:
        """构造带 IP 的请求。"""
        request = HttpRequest()
        request.META = {"REMOTE_ADDR": ip}
        return request

    @patch("django_redis.get_redis_connection")
    @patch("apps.users.auth.utils.hash_string")
    @patch("apps.users.auth.utils.get_client_ip")
    def test_first_request_passes(
        self,
        mock_get_client_ip: MagicMock,
        mock_hash_string: MagicMock,
        mock_get_redis: MagicMock,
    ):
        """正常请求（首次）应通过。"""
        mock_get_client_ip.return_value = "192.168.1.1"
        mock_hash_string.return_value = "abc123def456"
        mock_conn = MagicMock()
        mock_conn.incr.return_value = 1
        mock_get_redis.return_value = mock_conn

        from apps.tabtinspace.routers.shared import _check_activate_rate_limit

        request = self._make_request()
        result = _check_activate_rate_limit(request)

        self.assertTrue(result)
        mock_conn.incr.assert_called_once()
        mock_conn.expire.assert_called_once()

    @patch("django_redis.get_redis_connection")
    @patch("apps.users.auth.utils.hash_string")
    @patch("apps.users.auth.utils.get_client_ip")
    def test_over_limit_rejected(
        self,
        mock_get_client_ip: MagicMock,
        mock_hash_string: MagicMock,
        mock_get_redis: MagicMock,
    ):
        """超过限额（10次后）应被拒绝。"""
        mock_get_client_ip.return_value = "192.168.1.1"
        mock_hash_string.return_value = "abc123def456"
        mock_conn = MagicMock()
        mock_conn.incr.return_value = 11  # 第 11 次
        mock_get_redis.return_value = mock_conn

        from apps.tabtinspace.routers.shared import _check_activate_rate_limit

        request = self._make_request()
        result = _check_activate_rate_limit(request)

        self.assertFalse(result)

    @patch("django_redis.get_redis_connection")
    @patch("apps.users.auth.utils.get_client_ip")
    def test_redis_failure_fail_close(
        self,
        mock_get_client_ip: MagicMock,
        mock_get_redis: MagicMock,
    ):
        """Redis 故障时应 Fail-Close（拒绝）。"""
        mock_get_client_ip.return_value = "192.168.1.1"
        mock_get_redis.side_effect = ConnectionError("Redis connection refused")

        from apps.tabtinspace.routers.shared import _check_activate_rate_limit

        request = self._make_request()
        result = _check_activate_rate_limit(request)

        self.assertFalse(result)

    @patch("apps.users.auth.utils.get_client_ip")
    def test_no_ip_passes(self, mock_get_client_ip: MagicMock):
        """无 IP 时放行（不依赖 Redis）。"""
        mock_get_client_ip.return_value = None

        from apps.tabtinspace.routers.shared import _check_activate_rate_limit

        request = self._make_request()
        result = _check_activate_rate_limit(request)

        self.assertTrue(result)
