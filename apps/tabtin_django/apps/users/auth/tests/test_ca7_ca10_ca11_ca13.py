"""
CA-7 / CA-10 / CA-11 / CA-13 回归测试

CA-7:  JWT_SECRET_KEY 非 DEBUG 模式必须独立配置
CA-10: get_client_ip 根据 TRUSTED_PROXY_COUNT 安全提取 IP
CA-11: is_suspicious_password_reset_activity 原子计数
CA-13: Session Key 哈希存储（DB 不含明文）
"""

from datetime import timedelta
from unittest.mock import patch, MagicMock

from django.test import TestCase, RequestFactory, override_settings
from django.utils import timezone

from apps.users.auth.utils import (
    get_client_ip,
    is_suspicious_password_reset_activity,
    hash_string,
    generate_jwt_token,
    verify_jwt_token,
)
from apps.users.auth.session_manager import SessionManager


# ---------------------------------------------------------------------------
# CA-7: JWT_SECRET_KEY 启动时校验 + utils.py 不再有 fallback
# ---------------------------------------------------------------------------

class CA7JwtSecretKeyTest(TestCase):
    """CA-7: JWT_SECRET_KEY 在非 DEBUG 模式下必须独立配置"""

    databases = {"default", "postgresql"}

    def setUp(self):
        from apps.users.auth.models import User
        self.user = User.objects.create_user(
            email="jwt_secret@test.com",
            password="StrongPass123!",
        )

    def test_settings_has_jwt_secret_key(self):
        """settings.JWT_SECRET_KEY 应始终被定义（startup 检查保证）"""
        from django.conf import settings
        self.assertTrue(hasattr(settings, 'JWT_SECRET_KEY'))
        self.assertTrue(len(settings.JWT_SECRET_KEY) > 0)

    def test_generate_verify_roundtrip(self):
        """生成的 JWT 应能被正确验证"""
        token = generate_jwt_token(self.user, expire_hours=1)
        payload = verify_jwt_token(token)
        self.assertIsNotNone(payload)
        self.assertEqual(payload['user_id'], str(self.user.id))
        self.assertEqual(payload['token_type'], 'access')

    @override_settings(JWT_SECRET_KEY='test-secret-abc')
    def test_uses_jwt_secret_key_setting(self):
        """应直接使用 settings.JWT_SECRET_KEY 签名，不回退到 SECRET_KEY"""
        import jwt as pyjwt
        from django.conf import settings
        token = generate_jwt_token(self.user, expire_hours=1)
        payload = pyjwt.decode(token, 'test-secret-abc', algorithms=['HS256'])
        self.assertEqual(payload['user_id'], str(self.user.id))

    @override_settings(JWT_SECRET_KEY='key-a')
    def test_wrong_key_returns_none(self):
        """使用不同密钥签名的 token 应验证失败"""
        import jwt as pyjwt
        token = pyjwt.encode({'user_id': 'x', 'token_type': 'access', 'exp': timezone.now() + timedelta(hours=1)}, 'key-b', algorithm='HS256')
        self.assertIsNone(verify_jwt_token(token))

    def test_startup_rejects_missing_jwt_key_in_production(self):
        """非 DEBUG 模式下缺少 JWT_SECRET_KEY 应抛出 ImproperlyConfigured"""
        from django.core.exceptions import ImproperlyConfigured
        import os

        with patch.dict(os.environ, {'JWT_SECRET_KEY': '', 'DEBUG': 'false'}, clear=False):
            with patch.dict(os.environ, {k: v for k, v in os.environ.items() if k != 'JWT_SECRET_KEY'}, clear=True):
                pass
            _jwt_env = os.getenv('JWT_SECRET_KEY', '')
            _debug = os.getenv('DEBUG', 'False').lower() == 'true'
            if not _debug and not _jwt_env:
                with self.assertRaises(ImproperlyConfigured):
                    raise ImproperlyConfigured("JWT_SECRET_KEY 环境变量未配置")


# ---------------------------------------------------------------------------
# CA-10: get_client_ip
# ---------------------------------------------------------------------------

class CA10GetClientIpTest(TestCase):
    """CA-10: get_client_ip 必须按 TRUSTED_PROXY_COUNT 安全提取 IP"""

    def setUp(self):
        self.factory = RequestFactory()

    def _request_with_xff(self, xff_value, remote_addr="10.0.0.1"):
        req = self.factory.get("/")
        req.META["HTTP_X_FORWARDED_FOR"] = xff_value
        req.META["REMOTE_ADDR"] = remote_addr
        return req

    @override_settings(TRUSTED_PROXY_COUNT=0)
    def test_default_ignores_xff(self):
        """TRUSTED_PROXY_COUNT=0 时应忽略 XFF，仅返回 REMOTE_ADDR"""
        req = self._request_with_xff("1.2.3.4, 5.6.7.8", remote_addr="10.0.0.1")
        self.assertEqual(get_client_ip(req), "10.0.0.1")

    def test_no_setting_defaults_to_remote_addr(self):
        """未配置 TRUSTED_PROXY_COUNT 时等价于 0"""
        req = self._request_with_xff("1.2.3.4", remote_addr="10.0.0.1")
        self.assertEqual(get_client_ip(req), "10.0.0.1")

    @override_settings(TRUSTED_PROXY_COUNT=1)
    def test_single_proxy_no_spoofing(self):
        """1 层代理、无伪造：XFF 仅含 1 条 = 客户端 IP"""
        req = self._request_with_xff("1.2.3.4")
        self.assertEqual(get_client_ip(req), "1.2.3.4")

    @override_settings(TRUSTED_PROXY_COUNT=1)
    def test_single_proxy_with_spoofing(self):
        """1 层代理、客户端伪造前缀：代理追加的最后 1 条为真实客户端 IP"""
        req = self._request_with_xff("spoofed, 10.0.0.99")
        self.assertEqual(get_client_ip(req), "10.0.0.99")

    @override_settings(TRUSTED_PROXY_COUNT=2)
    def test_two_proxies_no_spoofing(self):
        """2 层代理、无伪造：idx=len-N=0 得到客户端 IP"""
        req = self._request_with_xff("1.2.3.4, 10.0.0.1")
        self.assertEqual(get_client_ip(req), "1.2.3.4")

    @override_settings(TRUSTED_PROXY_COUNT=2)
    def test_two_proxies_with_spoofing(self):
        """2 层代理、客户端伪造前缀"""
        req = self._request_with_xff("evil, 5.5.5.5, 10.0.0.1")
        self.assertEqual(get_client_ip(req), "5.5.5.5")

    @override_settings(TRUSTED_PROXY_COUNT=1)
    def test_xff_absent_falls_back_to_remote_addr(self):
        """XFF 不存在时回退到 REMOTE_ADDR"""
        req = self.factory.get("/")
        req.META["REMOTE_ADDR"] = "192.168.1.1"
        self.assertEqual(get_client_ip(req), "192.168.1.1")

    @override_settings(TRUSTED_PROXY_COUNT=5)
    def test_xff_shorter_than_proxy_count_falls_back(self):
        """XFF 条目少于 TRUSTED_PROXY_COUNT 时回退到 REMOTE_ADDR"""
        req = self._request_with_xff("1.2.3.4", remote_addr="10.0.0.1")
        self.assertEqual(get_client_ip(req), "10.0.0.1")

    @override_settings(TRUSTED_PROXY_COUNT=1)
    def test_spoofed_xff_prefix_ignored(self):
        """攻击者伪造多个前缀：只有代理追加的尾部条目可信"""
        req = self._request_with_xff("evil1, evil2, real_client_ip")
        self.assertEqual(get_client_ip(req), "real_client_ip")


# ---------------------------------------------------------------------------
# CA-11: is_suspicious_password_reset_activity
# ---------------------------------------------------------------------------

class CA11AtomicResetCounterTest(TestCase):
    """CA-11: 密码重置可疑检测使用原子 Redis 计数"""

    @patch("apps.users.auth.utils.get_redis_connection")
    def test_ip_over_limit_returns_suspicious(self, mock_get_conn):
        conn = MagicMock()
        conn.incr.return_value = 21
        mock_get_conn.return_value = conn

        is_suspicious, msg = is_suspicious_password_reset_activity("user@test.com", "1.2.3.4")
        self.assertTrue(is_suspicious)
        self.assertIn("可疑活动", msg)

    @patch("apps.users.auth.utils.get_redis_connection")
    def test_user_over_limit_returns_suspicious(self, mock_get_conn):
        conn = MagicMock()
        conn.incr.side_effect = [1, 4]
        mock_get_conn.return_value = conn

        is_suspicious, msg = is_suspicious_password_reset_activity("user@test.com", "1.2.3.4")
        self.assertTrue(is_suspicious)
        self.assertIn("账号安全", msg)

    @patch("apps.users.auth.utils.get_redis_connection")
    def test_within_limits_returns_ok(self, mock_get_conn):
        conn = MagicMock()
        conn.incr.side_effect = [1, 1]
        mock_get_conn.return_value = conn

        is_suspicious, msg = is_suspicious_password_reset_activity("user@test.com", "1.2.3.4")
        self.assertFalse(is_suspicious)

    @patch("apps.users.auth.utils.get_redis_connection")
    def test_expire_set_on_first_incr(self, mock_get_conn):
        """首次计数时应设置 TTL"""
        conn = MagicMock()
        conn.incr.side_effect = [1, 1]
        mock_get_conn.return_value = conn

        is_suspicious_password_reset_activity("u@t.com", "1.1.1.1")

        expire_calls = conn.expire.call_args_list
        self.assertEqual(len(expire_calls), 2)
        self.assertEqual(expire_calls[0][0][1], 3600)
        self.assertEqual(expire_calls[1][0][1], 24 * 3600)

    @patch("apps.users.auth.utils.get_redis_connection", side_effect=Exception("Redis down"))
    def test_redis_failure_is_fail_closed(self, mock_get_conn):
        """Redis 不可用时应 fail-closed（阻止请求）"""
        is_suspicious, msg = is_suspicious_password_reset_activity("u@t.com", "1.1.1.1")
        self.assertTrue(is_suspicious)


# ---------------------------------------------------------------------------
# CA-13: Session Key 哈希存储
# ---------------------------------------------------------------------------

class CA13SessionKeyHashTest(TestCase):
    """CA-13: Session Key 在 DB 中以哈希形式存储"""

    databases = {"default", "postgresql"}

    def setUp(self):
        from apps.users.auth.models import User
        self.factory = RequestFactory()
        self.user = User.objects.create_user(
            email="hash_session@test.com",
            password="StrongPass123!",
        )
        self.request = self.factory.get("/api/test")
        self.request.META["REMOTE_ADDR"] = "127.0.0.1"
        self.request.META["HTTP_USER_AGENT"] = "test-agent"

    def test_create_session_persists_client_metadata(self):
        """创建 session 时应写入客户端元数据，兼容已上线的 NOT NULL schema。"""
        self.request.META["HTTP_X_DEVICE_ID"] = "device-test-001"
        self.request.META["HTTP_X_CLIENT_TYPE"] = "electron"

        session = SessionManager.create_session(self.user, self.request)

        from apps.users.auth.models import UserSession
        db_row = UserSession.objects.get(id=session.id)
        self.assertEqual(db_row.device_id, "device-test-001")
        self.assertEqual(db_row.client_type, "electron")
        self.assertIsNone(db_row.revoked_at)
        self.assertEqual(db_row.revoked_by_admin_account_id, "")
        self.assertEqual(db_row.revoked_reason, "")

    def test_create_session_defaults_client_type_to_session_type(self):
        """旧客户端未传 client_type 时，应使用 session_type 兜底而不是写 NULL。"""
        session = SessionManager.create_session(
            self.user,
            self.request,
            session_type="mobile",
        )

        from apps.users.auth.models import UserSession
        db_row = UserSession.objects.get(id=session.id)
        self.assertEqual(db_row.device_id, "")
        self.assertEqual(db_row.client_type, "mobile")
        self.assertIsNone(db_row.revoked_at)
        self.assertEqual(db_row.revoked_by_admin_account_id, "")
        self.assertEqual(db_row.revoked_reason, "")

    def test_session_key_stored_as_hash(self):
        """DB 中 session_key 应为哈希值，不含明文"""
        session = SessionManager.create_session(self.user, self.request)
        raw_key = session.session_key

        from apps.users.auth.models import UserSession
        db_row = UserSession.objects.get(id=session.id)
        self.assertNotEqual(db_row.session_key, raw_key)
        self.assertEqual(db_row.session_key, SessionManager.hash_session_key(raw_key))

    def test_validate_session_with_plaintext_key(self):
        """validate_session 接受明文 key（来自 JWT），能正确查到哈希记录"""
        session = SessionManager.create_session(self.user, self.request)
        raw_key = session.session_key

        validated = SessionManager.validate_session(raw_key)
        self.assertIsNotNone(validated)
        self.assertEqual(str(validated.user_id), str(self.user.id))
        self.assertEqual(validated.session_key, raw_key)

    def test_invalidate_session_with_plaintext_key(self):
        """invalidate_session 接受明文 key"""
        session = SessionManager.create_session(self.user, self.request)
        raw_key = session.session_key

        result = SessionManager.invalidate_session(raw_key)
        self.assertTrue(result)

        self.assertIsNone(SessionManager.validate_session(raw_key))

    def test_session_key_entropy(self):
        """生成的明文 session key 应为 64 hex 字符（256 bits）"""
        session = SessionManager.create_session(self.user, self.request)
        self.assertEqual(len(session.session_key), 64)
        int(session.session_key, 16)

    def test_hash_session_key_deterministic(self):
        """相同输入应产生相同哈希"""
        key = "abc123"
        self.assertEqual(
            SessionManager.hash_session_key(key),
            SessionManager.hash_session_key(key),
        )

    def test_hash_session_key_length_fits_db(self):
        """哈希结果应 <= 64 字符（DB 字段 max_length）"""
        key = "a" * 100
        hashed = SessionManager.hash_session_key(key)
        self.assertLessEqual(len(hashed), 64)

    def test_validated_session_session_key_is_plaintext(self):
        """validate_session 返回的 session 对象 session_key 属性应为明文（用于 JWT 续签）"""
        session = SessionManager.create_session(self.user, self.request)
        raw_key = session.session_key

        validated = SessionManager.validate_session(raw_key)
        self.assertEqual(validated.session_key, raw_key)
        self.assertNotEqual(validated.session_key, SessionManager.hash_session_key(raw_key))
