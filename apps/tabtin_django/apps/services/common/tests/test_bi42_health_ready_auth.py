"""
BI-42 回归测试：/health/ready 无认证泄露基础设施 → 认证保护

修复内容：
1. _deep_health_check 改为接受 request 参数
2. 检查 Authorization: Bearer {HEALTH_CHECK_TOKEN} 头
3. 认证通过返回详细 checks，未认证只返回 status + timestamp（无 checks 详情）
"""

import json
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase, override_settings

from apps.services.common.middleware import HealthCheckMiddleware


def _make_fake_request(path='/health/ready/', auth_header=None):
    """构造 fake request 对象，middleware 使用 request.META"""
    request = MagicMock()
    request.path = path
    request.META = {}
    if auth_header is not None:
        request.META['HTTP_AUTHORIZATION'] = auth_header
    return request


@override_settings(SERVICES_OSS_PROVIDER='aliyun')
class TestBI42HealthReadyAuth(SimpleTestCase):
    """BI-42: /health/ready 认证保护，未认证不返回 checks 详情"""

    @patch('django_redis.get_redis_connection')
    @patch('django.db.connections')
    @override_settings(HEALTH_CHECK_TOKEN='secret-health-token-123')
    def test_unauthorized_no_checks_detail(self, mock_connections, mock_get_redis):
        """未认证请求不返回 checks 详情"""
        mock_cursor = MagicMock()
        mock_db = MagicMock()
        mock_db.cursor.return_value = mock_cursor
        mock_connections.__getitem__ = MagicMock(return_value=mock_db)

        mock_redis = MagicMock()
        mock_get_redis.return_value = mock_redis

        request = _make_fake_request(auth_header=None)
        response = HealthCheckMiddleware._deep_health_check(request)

        self.assertEqual(response.status_code, 200)
        data = json.loads(response.content.decode('utf-8'))
        self.assertIn('status', data)
        self.assertIn('timestamp', data)
        self.assertNotIn('checks', data, '未认证请求不应返回 checks 详情')

    @patch('django_redis.get_redis_connection')
    @patch('django.db.connections')
    @override_settings(HEALTH_CHECK_TOKEN='secret-health-token-123')
    def test_wrong_token_no_checks_detail(self, mock_connections, mock_get_redis):
        """错误 Token 不返回 checks 详情"""
        mock_cursor = MagicMock()
        mock_db = MagicMock()
        mock_db.cursor.return_value = mock_cursor
        mock_connections.__getitem__ = MagicMock(return_value=mock_db)

        mock_redis = MagicMock()
        mock_get_redis.return_value = mock_redis

        request = _make_fake_request(auth_header='Bearer wrong-token')
        response = HealthCheckMiddleware._deep_health_check(request)

        self.assertEqual(response.status_code, 200)
        data = json.loads(response.content.decode('utf-8'))
        self.assertIn('status', data)
        self.assertIn('timestamp', data)
        self.assertNotIn('checks', data, '错误 Token 不应返回 checks 详情')

    @patch('django_redis.get_redis_connection')
    @patch('django.db.connections')
    @override_settings(HEALTH_CHECK_TOKEN='secret-health-token-123')
    def test_correct_token_returns_checks_detail(self, mock_connections, mock_get_redis):
        """正确 Token 返回 checks 详情"""
        mock_cursor = MagicMock()
        mock_db = MagicMock()
        mock_db.cursor.return_value = mock_cursor
        mock_connections.__getitem__ = MagicMock(return_value=mock_db)

        mock_redis = MagicMock()
        mock_get_redis.return_value = mock_redis

        request = _make_fake_request(auth_header='Bearer secret-health-token-123')
        response = HealthCheckMiddleware._deep_health_check(request)

        self.assertEqual(response.status_code, 200)
        data = json.loads(response.content.decode('utf-8'))
        self.assertIn('status', data)
        self.assertIn('timestamp', data)
        self.assertIn('checks', data, '正确 Token 应返回 checks 详情')
        self.assertNotIn('mysql', data['checks'])
        self.assertIn('postgresql', data['checks'])
        self.assertIn('redis', data['checks'])

    @patch('django_redis.get_redis_connection')
    @patch('django.db.connections')
    @override_settings(HEALTH_CHECK_TOKEN='secret-health-token-123')
    def test_status_and_timestamp_always_present(self, mock_connections, mock_get_redis):
        """无论认证状态，status 和 timestamp 都存在"""
        mock_cursor = MagicMock()
        mock_db = MagicMock()
        mock_db.cursor.return_value = mock_cursor
        mock_connections.__getitem__ = MagicMock(return_value=mock_db)

        mock_redis = MagicMock()
        mock_get_redis.return_value = mock_redis

        for auth_header in [None, 'Bearer wrong', 'Bearer secret-health-token-123']:
            request = _make_fake_request(auth_header=auth_header)
            response = HealthCheckMiddleware._deep_health_check(request)
            data = json.loads(response.content.decode('utf-8'))
            self.assertIn('status', data, f'auth_header={auth_header} 时应有 status')
            self.assertIn('timestamp', data, f'auth_header={auth_header} 时应有 timestamp')

    @patch('apps.services.oss.services.factory.get_oss_service')
    @patch('django_redis.get_redis_connection')
    @patch('django.db.connections')
    @override_settings(
        HEALTH_CHECK_TOKEN='secret-health-token-123',
        SERVICES_OSS_PROVIDER='local',
    )
    def test_local_object_volume_failure_marks_readiness_degraded(
        self,
        mock_connections,
        mock_get_redis,
        mock_get_oss,
    ):
        mock_db = MagicMock()
        mock_connections.__getitem__ = MagicMock(return_value=mock_db)
        mock_get_redis.return_value = MagicMock()
        mock_get_oss.return_value.validate_config.return_value = False

        response = HealthCheckMiddleware._deep_health_check(
            _make_fake_request(auth_header='Bearer secret-health-token-123')
        )

        self.assertEqual(response.status_code, 503)
        data = json.loads(response.content.decode('utf-8'))
        self.assertEqual(data['status'], 'degraded')
        self.assertEqual(data['checks']['object_storage'], 'error')
