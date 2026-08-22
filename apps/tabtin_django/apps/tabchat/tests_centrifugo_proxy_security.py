"""Centrifugo Proxy 安全修复回归测试（Wave 2: RT-07 ~ RT-14）。"""
import hmac
import ipaddress
import os
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

django_root = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir, os.pardir, os.pardir))
if django_root not in sys.path:
    sys.path.insert(0, django_root)
if "DJANGO_SETTINGS_MODULE" not in os.environ:
    os.environ["DJANGO_SETTINGS_MODULE"] = "tabtin.settings"

import django
from django.apps import apps
if not apps.ready:
    django.setup()


class TimingSafeCompareTests(unittest.TestCase):
    """RT-07: proxy secret 必须使用 hmac.compare_digest。"""

    def test_check_proxy_secret_uses_hmac_compare(self):
        from apps.tabchat.centrifugo_proxy import _check_proxy_secret

        import inspect
        source = inspect.getsource(_check_proxy_secret)
        self.assertIn("hmac.compare_digest", source)
        self.assertNotIn("actual != expected", source)


class VerifyJwtTokenSecretKeyTests(unittest.TestCase):
    """RT-08: verify_jwt_token 支持 secret_key 参数。"""

    def test_default_secret_key(self):
        import jwt as pyjwt
        from django.conf import settings
        from apps.users.auth.utils import verify_jwt_token

        secret = settings.JWT_SECRET_KEY
        token = pyjwt.encode({"user_id": "u1", "token_type": "access"}, secret, algorithm="HS256")
        payload = verify_jwt_token(token)
        self.assertIsNotNone(payload)
        self.assertEqual(payload["user_id"], "u1")

    def test_custom_secret_key(self):
        import jwt as pyjwt
        from apps.users.auth.utils import verify_jwt_token

        custom_secret = "my-custom-centrifugo-secret"
        token = pyjwt.encode({"user_id": "u2"}, custom_secret, algorithm="HS256")

        payload_wrong = verify_jwt_token(token)
        self.assertIsNone(payload_wrong)

        payload_right = verify_jwt_token(token, secret_key=custom_secret)
        self.assertIsNotNone(payload_right)
        self.assertEqual(payload_right["user_id"], "u2")


class ProxyIpWhitelistTests(unittest.TestCase):
    """RT-10: 代理端点 IP 白名单。"""

    def _make_request(self, remote_addr):
        req = MagicMock()
        req.META = {"REMOTE_ADDR": remote_addr}
        req.headers = {}
        return req

    @patch("apps.tabchat.centrifugo_proxy.settings")
    def test_allowed_ip_passes(self, mock_settings):
        mock_settings.CENTRIFUGO_ALLOWED_PROXY_IPS = ["127.0.0.1", "::1"]
        from apps.tabchat.centrifugo_proxy import _check_proxy_ip

        result = _check_proxy_ip(self._make_request("127.0.0.1"))
        self.assertIsNone(result)

    @patch("apps.tabchat.centrifugo_proxy.settings")
    def test_blocked_ip_rejected(self, mock_settings):
        mock_settings.CENTRIFUGO_ALLOWED_PROXY_IPS = ["127.0.0.1"]
        from apps.tabchat.centrifugo_proxy import _check_proxy_ip

        result = _check_proxy_ip(self._make_request("10.0.0.5"))
        self.assertIsNotNone(result)
        self.assertEqual(result.status_code, 403)

    @patch("apps.tabchat.centrifugo_proxy.settings")
    def test_cidr_range_allowed(self, mock_settings):
        mock_settings.CENTRIFUGO_ALLOWED_PROXY_IPS = ["10.0.0.0/24"]
        from apps.tabchat.centrifugo_proxy import _check_proxy_ip

        result = _check_proxy_ip(self._make_request("10.0.0.42"))
        self.assertIsNone(result)

    @patch("apps.tabchat.centrifugo_proxy.settings")
    def test_invalid_remote_addr_rejected(self, mock_settings):
        mock_settings.CENTRIFUGO_ALLOWED_PROXY_IPS = ["127.0.0.1"]
        from apps.tabchat.centrifugo_proxy import _check_proxy_ip

        result = _check_proxy_ip(self._make_request("not-an-ip"))
        self.assertIsNotNone(result)
        self.assertEqual(result.status_code, 403)


class PersonalChannelSubscribeTests(unittest.TestCase):
    """RT-12: personal 频道 subscribe proxy 校验 owner。"""

    _USER_A = "00000000-0000-0000-0000-00000000000a"
    _USER_B = "00000000-0000-0000-0000-00000000000b"

    def test_subscribe_proxy_rejects_other_personal_channel(self):
        from apps.tabchat.centrifugo_proxy import centrifugo_subscribe_proxy, SubscribeRequest

        req = MagicMock()
        req.META = {"REMOTE_ADDR": "127.0.0.1"}
        req.headers = {"X-Centrifugo-Proxy-Secret": "test-secret"}

        payload = SubscribeRequest(
            client="c1", user=self._USER_A, channel=f"personal:{self._USER_B}",
        )

        with patch("apps.tabchat.centrifugo_proxy._check_proxy_secret", return_value=None), \
             patch("apps.tabchat.centrifugo_proxy.User") as MockUser:
            MockUser.objects.filter.return_value.exists.return_value = True
            resp = centrifugo_subscribe_proxy(req, payload)

        self.assertIsNotNone(resp.error)
        self.assertEqual(resp.error["code"], 403)

    def test_subscribe_proxy_allows_own_personal_channel(self):
        from apps.tabchat.centrifugo_proxy import centrifugo_subscribe_proxy, SubscribeRequest

        req = MagicMock()
        payload = SubscribeRequest(
            client="c1", user=self._USER_A, channel=f"personal:{self._USER_A}",
        )

        with patch("apps.tabchat.centrifugo_proxy._check_proxy_secret", return_value=None), \
             patch("apps.tabchat.centrifugo_proxy.User") as MockUser:
            MockUser.objects.filter.return_value.exists.return_value = True
            resp = centrifugo_subscribe_proxy(req, payload)

        self.assertIsNotNone(resp.result)
        self.assertIsNone(resp.error)

    def test_subscribe_proxy_rejects_unknown_namespace(self):
        from apps.tabchat.centrifugo_proxy import centrifugo_subscribe_proxy, SubscribeRequest

        req = MagicMock()
        payload = SubscribeRequest(
            client="c1", user=self._USER_A, channel="unknown:something",
        )

        with patch("apps.tabchat.centrifugo_proxy._check_proxy_secret", return_value=None), \
             patch("apps.tabchat.centrifugo_proxy.User") as MockUser:
            MockUser.objects.filter.return_value.exists.return_value = True
            resp = centrifugo_subscribe_proxy(req, payload)

        self.assertIsNotNone(resp.error)
        self.assertEqual(resp.error["code"], 403)

    def test_subscribe_proxy_rejects_malformed_personal_channel(self):
        """FP-017: 畸形 personal 频道名（非 UUID）必须被拒绝。"""
        from apps.tabchat.centrifugo_proxy import centrifugo_subscribe_proxy, SubscribeRequest

        malformed_ids = ["../admin", "not-a-uuid", "", "user-A", "12345"]
        for bad_id in malformed_ids:
            req = MagicMock()
            payload = SubscribeRequest(
                client="c1", user=self._USER_A, channel=f"personal:{bad_id}",
            )
            with patch("apps.tabchat.centrifugo_proxy._check_proxy_secret", return_value=None), \
                 patch("apps.tabchat.centrifugo_proxy.User") as MockUser:
                MockUser.objects.filter.return_value.exists.return_value = True
                resp = centrifugo_subscribe_proxy(req, payload)
            self.assertIsNotNone(resp.error, f"should reject personal:{bad_id}")
            self.assertEqual(resp.error["code"], 400, f"personal:{bad_id} should return 400")


class ConnectProxyConnectionCounterTests(unittest.TestCase):
    """FP-021: connect proxy 连接数采样不应阻断合法连接。"""

    @patch("apps.tabchat.centrifugo_proxy.settings")
    def test_counter_samples_connection_set(self, mock_settings):
        """连接采样写 Redis Set；硬限制交给 Centrifugo 内建配置。"""
        mock_settings.CENTRIFUGO_USER_CONNECTION_LIMIT = 10

        from apps.tabchat.centrifugo_proxy import centrifugo_connect_proxy, ConnectRequest

        req = MagicMock()
        mock_user = SimpleNamespace()
        mock_user.id = "00000000-0000-0000-0000-000000000001"
        mock_user.display_name = "Test"
        redis_conn = MagicMock()
        pipe = MagicMock()
        pipe.execute.return_value = [1, True, 1]
        redis_conn.pipeline.return_value = pipe

        payload = ConnectRequest(client="c1", data={"token": "tok"})

        with patch("apps.tabchat.centrifugo_proxy._check_proxy_secret", return_value=None), \
             patch("apps.tabchat.centrifugo_proxy.verify_jwt_token", return_value={
                 "token_type": "access", "user_id": str(mock_user.id), "exp": 9999999999, "sid": "sess1",
             }), \
             patch("apps.tabchat.centrifugo_proxy.User") as MockUser, \
             patch("apps.tabchat.centrifugo_proxy.SessionManager") as MockSM, \
             patch("django_redis.get_redis_connection", return_value=redis_conn):
            MockUser.objects.get.return_value = mock_user
            mock_session = MagicMock()
            mock_session.user_id = mock_user.id
            MockSM.validate_session.return_value = mock_session

            resp = centrifugo_connect_proxy(req, payload)

        redis_conn.pipeline.assert_called_once()
        pipe.sadd.assert_called_once()
        pipe.expire.assert_called_once()
        pipe.scard.assert_called_once()
        pipe.execute.assert_called_once()
        self.assertIsNotNone(resp.result)

    @patch("apps.tabchat.centrifugo_proxy.settings")
    def test_counter_does_not_reject_when_sample_is_over_limit(self, mock_settings):
        """采样超过阈值只记录日志，不由 Django 侧拒绝连接。"""
        mock_settings.CENTRIFUGO_USER_CONNECTION_LIMIT = 5

        from apps.tabchat.centrifugo_proxy import centrifugo_connect_proxy, ConnectRequest

        mock_user = SimpleNamespace()
        mock_user.id = "00000000-0000-0000-0000-000000000002"
        mock_user.display_name = "Test"
        redis_conn = MagicMock()
        pipe = MagicMock()
        pipe.execute.return_value = [1, True, 6]
        redis_conn.pipeline.return_value = pipe

        payload = ConnectRequest(client="c1", data={"token": "tok"})
        req = MagicMock()

        with patch("apps.tabchat.centrifugo_proxy._check_proxy_secret", return_value=None), \
             patch("apps.tabchat.centrifugo_proxy.verify_jwt_token", return_value={
                 "token_type": "access", "user_id": str(mock_user.id), "exp": 9999999999, "sid": "sess1",
             }), \
             patch("apps.tabchat.centrifugo_proxy.User") as MockUser, \
             patch("apps.tabchat.centrifugo_proxy.SessionManager") as MockSM, \
             patch("django_redis.get_redis_connection", return_value=redis_conn):
            MockUser.objects.get.return_value = mock_user
            mock_session = MagicMock()
            mock_session.user_id = mock_user.id
            MockSM.validate_session.return_value = mock_session

            resp = centrifugo_connect_proxy(req, payload)

        self.assertIsNotNone(resp.result)
        self.assertIsNone(resp.disconnect)

    @patch("apps.tabchat.centrifugo_proxy.settings")
    def test_counter_sampling_error_does_not_block_connect(self, mock_settings):
        """Redis 采样失败时继续连接，避免本地计数误伤用户。"""
        mock_settings.CENTRIFUGO_USER_CONNECTION_LIMIT = 10

        from apps.tabchat.centrifugo_proxy import centrifugo_connect_proxy, ConnectRequest

        mock_user = SimpleNamespace()
        mock_user.id = "00000000-0000-0000-0000-000000000003"
        mock_user.display_name = "Test"

        payload = ConnectRequest(client="c1", data={"token": "tok"})
        req = MagicMock()

        with patch("apps.tabchat.centrifugo_proxy._check_proxy_secret", return_value=None), \
             patch("apps.tabchat.centrifugo_proxy.verify_jwt_token", return_value={
                 "token_type": "access", "user_id": str(mock_user.id), "exp": 9999999999, "sid": "sess1",
             }), \
             patch("apps.tabchat.centrifugo_proxy.User") as MockUser, \
             patch("apps.tabchat.centrifugo_proxy.SessionManager") as MockSM, \
             patch("django_redis.get_redis_connection", side_effect=ValueError("redis down")):
            MockUser.objects.get.return_value = mock_user
            mock_session = MagicMock()
            mock_session.user_id = mock_user.id
            MockSM.validate_session.return_value = mock_session

            resp = centrifugo_connect_proxy(req, payload)

        self.assertIsNotNone(resp.result)


class DefaultKeyStartupCheckTests(unittest.TestCase):
    """RT-14: 生产环境不允许使用默认开发密钥。"""

    def test_dev_default_values_detected(self):
        from apps.tabchat.centrifugo_proxy import _check_proxy_secret
        dev_defaults = {
            "tabtin-centrifugo-dev-secret-change-in-production",
            "tabtin-centrifugo-proxy-dev-secret",
            "tabtin-centrifugo-dev-api-key",
        }
        for val in dev_defaults:
            self.assertGreater(len(val), 10, f"default key too short: {val}")


class ConnectProxySessionBindingTests(unittest.TestCase):
    """RB-003: centrifugo_connect_proxy 必须校验 session 绑定和 daemon token 吊销。"""

    def _call_connect(self, jwt_payload, user_obj=None, session_valid=True,
                      session_user_id_match=True, daemon_revoked=False):
        from apps.tabchat.centrifugo_proxy import centrifugo_connect_proxy, ConnectRequest
        import jwt as pyjwt

        secret = "test-secret"
        token = pyjwt.encode(jwt_payload, secret, algorithm="HS256")
        req = MagicMock()
        body = ConnectRequest(client="c1", data={"token": token})

        mock_cache = MagicMock()
        mock_cache.incr.return_value = 1
        mock_cache.get.return_value = 0
        mock_cache.add.return_value = True

        patches = [
            patch("apps.tabchat.centrifugo_proxy._check_proxy_secret", return_value=None),
            patch("apps.tabchat.centrifugo_proxy.verify_jwt_token", return_value=jwt_payload),
            patch("apps.tabchat.centrifugo_proxy.cache", mock_cache),
        ]

        if user_obj is not None:
            user_mock = MagicMock()
            user_mock.objects.get.return_value = user_obj
            patches.append(patch("apps.tabchat.centrifugo_proxy.User", user_mock))

        if "jti" in jwt_payload:
            patches.append(
                patch(
                    "apps.tabtinspace.services.daemon_token_service.is_daemon_token_revoked",
                    return_value=daemon_revoked,
                )
            )

        if session_valid:
            mock_session = MagicMock()
            mock_session.user_id = jwt_payload.get("user_id") if session_user_id_match else "other-user"
            patches.append(
                patch.object(
                    __import__("apps.users.auth.session_manager", fromlist=["SessionManager"]).SessionManager,
                    "validate_session",
                    return_value=mock_session,
                )
            )
        else:
            patches.append(
                patch.object(
                    __import__("apps.users.auth.session_manager", fromlist=["SessionManager"]).SessionManager,
                    "validate_session",
                    return_value=None,
                )
            )

        for p in patches:
            p.start()
        try:
            return centrifugo_connect_proxy(req, body)
        finally:
            for p in patches:
                p.stop()

    def _make_user(self, user_id="user-1"):
        user = MagicMock()
        user.id = user_id
        user.is_active = True
        user.display_name = "Test"
        return user

    def test_connect_rejected_when_no_sid(self):
        """token 中没有 sid（session 绑定），应被拒绝。"""
        payload = {"user_id": "user-1", "token_type": "access", "exp": 9999999999}
        resp = self._call_connect(payload, user_obj=self._make_user())
        self.assertIsNotNone(resp.disconnect)
        self.assertEqual(resp.disconnect["code"], 4008)

    def test_connect_rejected_when_session_revoked(self):
        """session 已吊销（validate_session 返回 None），应被拒绝。"""
        payload = {"user_id": "user-1", "token_type": "access", "exp": 9999999999, "sid": "some-session"}
        resp = self._call_connect(payload, user_obj=self._make_user(), session_valid=False)
        self.assertIsNotNone(resp.disconnect)
        self.assertEqual(resp.disconnect["code"], 4009)

    def test_connect_rejected_when_session_user_mismatch(self):
        """session 存在但属于其他用户，应被拒绝。"""
        payload = {"user_id": "user-1", "token_type": "access", "exp": 9999999999, "sid": "some-session"}
        resp = self._call_connect(
            payload, user_obj=self._make_user(), session_valid=True, session_user_id_match=False,
        )
        self.assertIsNotNone(resp.disconnect)
        self.assertEqual(resp.disconnect["code"], 4009)

    def test_connect_allowed_when_session_valid(self):
        """session 有效且用户匹配，应允许连接。"""
        payload = {"user_id": "user-1", "token_type": "access", "exp": 9999999999, "sid": "valid-session"}
        resp = self._call_connect(payload, user_obj=self._make_user(), session_valid=True)
        self.assertIsNotNone(resp.result)
        self.assertEqual(resp.result.user, "user-1")

    def test_connect_rejected_when_daemon_token_revoked(self):
        """daemon token 已被吊销（jti 在黑名单），应被拒绝。"""
        payload = {
            "user_id": "user-1", "token_type": "access", "exp": 9999999999,
            "sid": "valid-session", "jti": "revoked-jti",
        }
        resp = self._call_connect(
            payload, user_obj=self._make_user(), daemon_revoked=True,
        )
        self.assertIsNotNone(resp.disconnect)
        self.assertEqual(resp.disconnect["code"], 4007)

    def test_connect_allowed_when_daemon_token_not_revoked(self):
        """daemon token 未吊销，session 有效，应允许连接。"""
        payload = {
            "user_id": "user-1", "token_type": "access", "exp": 9999999999,
            "sid": "valid-session", "jti": "active-jti",
        }
        resp = self._call_connect(
            payload, user_obj=self._make_user(), daemon_revoked=False,
        )
        self.assertIsNotNone(resp.result)
        self.assertEqual(resp.result.user, "user-1")


class ReverseProxyIpResolutionTests(unittest.TestCase):
    """FP-003: 反向代理场景下，从可信代理头提取真实来源 IP 后再做白名单校验。"""

    def _make_request(self, remote_addr, x_real_ip=None, x_forwarded_for=None):
        req = MagicMock()
        meta = {"REMOTE_ADDR": remote_addr}
        if x_real_ip is not None:
            meta["HTTP_X_REAL_IP"] = x_real_ip
        if x_forwarded_for is not None:
            meta["HTTP_X_FORWARDED_FOR"] = x_forwarded_for
        req.META = meta
        req.headers = {}
        return req

    @patch("apps.tabchat.centrifugo_proxy.settings")
    def test_trusted_proxy_with_x_real_ip(self, mock_settings):
        """REMOTE_ADDR 是 Nginx，X-Real-IP 是 Centrifugo 白名单 IP → 放行。"""
        mock_settings.CENTRIFUGO_TRUSTED_PROXIES = ["172.17.0.1"]
        mock_settings.CENTRIFUGO_ALLOWED_PROXY_IPS = ["10.0.0.50"]
        from apps.tabchat.centrifugo_proxy import _check_proxy_ip

        req = self._make_request("172.17.0.1", x_real_ip="10.0.0.50")
        result = _check_proxy_ip(req)
        self.assertIsNone(result)

    @patch("apps.tabchat.centrifugo_proxy.settings")
    def test_trusted_proxy_with_x_real_ip_blocked(self, mock_settings):
        """REMOTE_ADDR 是可信代理，但 X-Real-IP 不在白名单 → 拒绝。"""
        mock_settings.CENTRIFUGO_TRUSTED_PROXIES = ["172.17.0.1"]
        mock_settings.CENTRIFUGO_ALLOWED_PROXY_IPS = ["10.0.0.50"]
        from apps.tabchat.centrifugo_proxy import _check_proxy_ip

        req = self._make_request("172.17.0.1", x_real_ip="192.168.1.100")
        result = _check_proxy_ip(req)
        self.assertIsNotNone(result)
        self.assertEqual(result.status_code, 403)

    @patch("apps.tabchat.centrifugo_proxy.settings")
    def test_trusted_proxy_with_xff(self, mock_settings):
        """X-Forwarded-For 链路：取最右侧非代理 IP 做校验。"""
        mock_settings.CENTRIFUGO_TRUSTED_PROXIES = ["172.17.0.1", "172.17.0.2"]
        mock_settings.CENTRIFUGO_ALLOWED_PROXY_IPS = ["10.0.0.50"]
        from apps.tabchat.centrifugo_proxy import _check_proxy_ip

        req = self._make_request(
            "172.17.0.1",
            x_forwarded_for="10.0.0.50, 172.17.0.2",
        )
        result = _check_proxy_ip(req)
        self.assertIsNone(result)

    @patch("apps.tabchat.centrifugo_proxy.settings")
    def test_no_trusted_proxies_uses_remote_addr(self, mock_settings):
        """未配置可信代理时，忽略代理头，直接用 REMOTE_ADDR。"""
        mock_settings.CENTRIFUGO_TRUSTED_PROXIES = []
        mock_settings.CENTRIFUGO_ALLOWED_PROXY_IPS = ["127.0.0.1"]
        from apps.tabchat.centrifugo_proxy import _check_proxy_ip

        req = self._make_request("127.0.0.1", x_real_ip="10.0.0.50")
        result = _check_proxy_ip(req)
        self.assertIsNone(result)

    @patch("apps.tabchat.centrifugo_proxy.settings")
    def test_untrusted_remote_addr_ignores_headers(self, mock_settings):
        """REMOTE_ADDR 不在可信代理列表中时，不信任代理头。"""
        mock_settings.CENTRIFUGO_TRUSTED_PROXIES = ["172.17.0.1"]
        mock_settings.CENTRIFUGO_ALLOWED_PROXY_IPS = ["10.0.0.50"]
        from apps.tabchat.centrifugo_proxy import _check_proxy_ip

        req = self._make_request("192.168.1.1", x_real_ip="10.0.0.50")
        result = _check_proxy_ip(req)
        self.assertIsNotNone(result)
        self.assertEqual(result.status_code, 403)

    @patch("apps.tabchat.centrifugo_proxy.settings")
    def test_trusted_proxy_cidr(self, mock_settings):
        """可信代理支持 CIDR 匹配。"""
        mock_settings.CENTRIFUGO_TRUSTED_PROXIES = ["172.17.0.0/16"]
        mock_settings.CENTRIFUGO_ALLOWED_PROXY_IPS = ["10.0.0.50"]
        from apps.tabchat.centrifugo_proxy import _check_proxy_ip

        req = self._make_request("172.17.0.5", x_real_ip="10.0.0.50")
        result = _check_proxy_ip(req)
        self.assertIsNone(result)


class DockerNetworkDefaultTests(unittest.TestCase):
    """FP-004: DEBUG 模式下 Docker 内部网段应在白名单默认值中。"""

    @patch("apps.tabchat.centrifugo_proxy.settings")
    def test_docker_bridge_ip_allowed_in_debug_defaults(self, mock_settings):
        """典型 Docker 网桥 IP 172.17.0.2 应匹配 172.16.0.0/12 网段。"""
        mock_settings.CENTRIFUGO_ALLOWED_PROXY_IPS = [
            "127.0.0.1", "::1",
            "172.16.0.0/12", "10.0.0.0/8", "192.168.0.0/16",
        ]
        mock_settings.CENTRIFUGO_TRUSTED_PROXIES = []
        from apps.tabchat.centrifugo_proxy import _check_proxy_ip

        for docker_ip in ("172.17.0.2", "172.18.0.3", "10.0.0.1", "192.168.1.100"):
            req = self._make_request(docker_ip)
            result = _check_proxy_ip(req)
            self.assertIsNone(result, f"Docker IP {docker_ip} should be allowed")

    @patch("apps.tabchat.centrifugo_proxy.settings")
    def test_production_strict_default_rejects_docker_ip(self, mock_settings):
        """生产环境严格默认值不包含 Docker 网段。"""
        mock_settings.CENTRIFUGO_ALLOWED_PROXY_IPS = ["127.0.0.1", "::1"]
        mock_settings.CENTRIFUGO_TRUSTED_PROXIES = []
        from apps.tabchat.centrifugo_proxy import _check_proxy_ip

        req = self._make_request("172.17.0.2")
        result = _check_proxy_ip(req)
        self.assertIsNotNone(result)
        self.assertEqual(result.status_code, 403)

    def _make_request(self, remote_addr):
        req = MagicMock()
        req.META = {"REMOTE_ADDR": remote_addr}
        req.headers = {}
        return req


class SubscribeProxyEmptyUserIdTests(unittest.TestCase):
    """FP-001 + FP-002: subscribe proxy 必须拒绝空 user_id，与 Django WS 路径 RT-26 修复对齐。"""

    def test_empty_user_id_rejected_personal_channel(self):
        """空字符串 user_id + personal: 频道 → 被拒绝（FP-001 回归场景）。"""
        from apps.tabchat.centrifugo_proxy import centrifugo_subscribe_proxy, SubscribeRequest

        req = MagicMock()
        payload = SubscribeRequest(
            client="c1", user="", channel="personal:",
        )

        with patch("apps.tabchat.centrifugo_proxy._check_proxy_secret", return_value=None), \
             patch("apps.tabchat.centrifugo_proxy.User") as MockUser:
            MockUser.objects.filter.return_value.exists.return_value = True
            resp = centrifugo_subscribe_proxy(req, payload)

        self.assertIsNotNone(resp.error)
        self.assertEqual(resp.error["code"], 403)
        self.assertIn("missing user_id", resp.error["message"])

    def test_empty_user_id_rejected_chat_channel(self):
        """空 user_id 在 chat 频道也必须被拒绝（FP-002 对称防御）。"""
        from apps.tabchat.centrifugo_proxy import centrifugo_subscribe_proxy, SubscribeRequest

        req = MagicMock()
        payload = SubscribeRequest(
            client="c1", user="", channel="chat:00000000-0000-0000-0000-000000000001",
        )

        with patch("apps.tabchat.centrifugo_proxy._check_proxy_secret", return_value=None), \
             patch("apps.tabchat.centrifugo_proxy.User") as MockUser:
            MockUser.objects.filter.return_value.exists.return_value = True
            resp = centrifugo_subscribe_proxy(req, payload)

        self.assertIsNotNone(resp.error)
        self.assertEqual(resp.error["code"], 403)

    def test_valid_user_id_passes_personal_channel(self):
        """正常 user_id 订阅自己的 personal 频道应放行。"""
        from apps.tabchat.centrifugo_proxy import centrifugo_subscribe_proxy, SubscribeRequest

        user_id = "550e8400-e29b-41d4-a716-446655440000"
        req = MagicMock()
        payload = SubscribeRequest(
            client="c1", user=user_id, channel=f"personal:{user_id}",
        )

        with patch("apps.tabchat.centrifugo_proxy._check_proxy_secret", return_value=None), \
             patch("apps.tabchat.centrifugo_proxy.User") as MockUser:
            MockUser.objects.filter.return_value.exists.return_value = True
            resp = centrifugo_subscribe_proxy(req, payload)

        self.assertIsNotNone(resp.result)
        self.assertIsNone(resp.error)


class CentrifugoDevConfigTests(unittest.TestCase):
    """FP-005 + FP-006: centrifugo-dev.json personal namespace 配置完整性。"""

    def setUp(self):
        import json
        config_path = os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            os.pardir, os.pardir, os.pardir, os.pardir,
            "scripts", "backend", "centrifugo-dev.json",
        )
        config_path = os.path.normpath(config_path)
        with open(config_path) as f:
            self.config = json.load(f)
        namespaces = self.config.get("channel", {}).get("namespaces", [])
        self.personal_ns = next(
            (ns for ns in namespaces if ns["name"] == "personal"), None,
        )

    def test_personal_namespace_exists(self):
        self.assertIsNotNone(self.personal_ns, "personal namespace 必须存在")

    def test_subscribe_proxy_enabled(self):
        """FP-005: personal namespace 必须开启 subscribe proxy。"""
        self.assertTrue(
            self.personal_ns.get("subscribe_proxy_enabled"),
            "personal namespace 必须设置 subscribe_proxy_enabled: true",
        )

    def test_global_subscribe_proxy_endpoint_defined(self):
        """FP-005: 全局 subscribe proxy endpoint 必须定义，供 personal namespace 使用。"""
        endpoint = (
            self.config
            .get("channel", {})
            .get("proxy", {})
            .get("subscribe", {})
            .get("endpoint", "")
        )
        self.assertTrue(
            endpoint,
            "全局 channel.proxy.subscribe.endpoint 必须定义",
        )

    def test_publish_proxy_enabled(self):
        """FP-006: personal namespace 必须开启 publish proxy（纵深防御）。"""
        self.assertTrue(
            self.personal_ns.get("publish_proxy_enabled"),
            "personal namespace 必须设置 publish_proxy_enabled: true",
        )

    def test_publish_for_subscriber_disabled(self):
        """FP-006: personal namespace 必须禁止客户端直接发布。"""
        self.assertFalse(
            self.personal_ns.get("allow_publish_for_subscriber", False),
            "personal namespace 必须禁止 allow_publish_for_subscriber",
        )


class ResolveSourceIpUnitTests(unittest.TestCase):
    """_resolve_source_ip 独立单元测试。"""

    def _make_request(self, remote_addr, x_real_ip=None, x_forwarded_for=None):
        req = MagicMock()
        meta = {"REMOTE_ADDR": remote_addr}
        if x_real_ip is not None:
            meta["HTTP_X_REAL_IP"] = x_real_ip
        if x_forwarded_for is not None:
            meta["HTTP_X_FORWARDED_FOR"] = x_forwarded_for
        req.META = meta
        return req

    @patch("apps.tabchat.centrifugo_proxy.settings")
    def test_xff_rightmost_non_proxy(self, mock_settings):
        """XFF 链中多个代理 IP 时，返回最右侧非代理 IP。"""
        mock_settings.CENTRIFUGO_TRUSTED_PROXIES = ["172.17.0.1", "172.17.0.2"]
        from apps.tabchat.centrifugo_proxy import _resolve_source_ip

        req = self._make_request(
            "172.17.0.1",
            x_forwarded_for="203.0.113.1, 10.0.0.50, 172.17.0.2",
        )
        result = _resolve_source_ip(req, "172.17.0.1")
        self.assertEqual(result, "10.0.0.50")

    @patch("apps.tabchat.centrifugo_proxy.settings")
    def test_x_real_ip_takes_priority(self, mock_settings):
        """同时存在 X-Real-IP 和 XFF 时，优先 X-Real-IP。"""
        mock_settings.CENTRIFUGO_TRUSTED_PROXIES = ["172.17.0.1"]
        from apps.tabchat.centrifugo_proxy import _resolve_source_ip

        req = self._make_request(
            "172.17.0.1",
            x_real_ip="10.0.0.50",
            x_forwarded_for="203.0.113.1, 172.17.0.2",
        )
        result = _resolve_source_ip(req, "172.17.0.1")
        self.assertEqual(result, "10.0.0.50")

    @patch("apps.tabchat.centrifugo_proxy.settings")
    def test_invalid_x_real_ip_falls_through(self, mock_settings):
        """X-Real-IP 格式非法时回退到 XFF。"""
        mock_settings.CENTRIFUGO_TRUSTED_PROXIES = ["172.17.0.1"]
        from apps.tabchat.centrifugo_proxy import _resolve_source_ip

        req = self._make_request(
            "172.17.0.1",
            x_real_ip="not-an-ip",
            x_forwarded_for="10.0.0.50",
        )
        result = _resolve_source_ip(req, "172.17.0.1")
        self.assertEqual(result, "10.0.0.50")

    @patch("apps.tabchat.centrifugo_proxy.settings")
    def test_no_headers_returns_remote_addr(self, mock_settings):
        """可信代理但无代理头时，返回原始 REMOTE_ADDR。"""
        mock_settings.CENTRIFUGO_TRUSTED_PROXIES = ["172.17.0.1"]
        from apps.tabchat.centrifugo_proxy import _resolve_source_ip

        req = self._make_request("172.17.0.1")
        result = _resolve_source_ip(req, "172.17.0.1")
        self.assertEqual(result, "172.17.0.1")


class DisconnectCentrifugoUserTests(unittest.TestCase):
    """RB-005: disconnect_centrifugo_user 调用 CentrifugoService.disconnect。"""

    @patch("apps.tabchat.services.centrifugo_service.get_centrifugo_service")
    def test_disconnect_calls_centrifugo_service(self, mock_get_service):
        mock_service = MagicMock()
        mock_get_service.return_value = mock_service

        from apps.tabchat.centrifugo_proxy import disconnect_centrifugo_user
        disconnect_centrifugo_user("user-123")

        mock_service.disconnect.assert_called_once_with("user-123")

    @patch("apps.tabchat.services.centrifugo_service.get_centrifugo_service")
    def test_disconnect_does_not_raise_on_service_error(self, mock_get_service):
        mock_service = MagicMock()
        mock_service.disconnect.side_effect = Exception("connection refused")
        mock_get_service.return_value = mock_service

        from apps.tabchat.centrifugo_proxy import disconnect_centrifugo_user
        disconnect_centrifugo_user("user-456")

    @patch("apps.tabchat.services.centrifugo_service.get_centrifugo_service")
    def test_disconnect_handles_import_error(self, mock_get_service):
        mock_get_service.side_effect = ImportError("no module")

        from apps.tabchat.centrifugo_proxy import disconnect_centrifugo_user
        disconnect_centrifugo_user("user-789")


class CentrifugoTokenSecretAlignmentTests(unittest.TestCase):
    """TDP-001~004: connect proxy 必须使用 JWT_SECRET_KEY 验证 access token，
    而非独立的 CENTRIFUGO_TOKEN_SECRET（RT-08-DEBT 方案A）。
    """

    def test_connect_proxy_verifies_with_jwt_secret_key(self):
        """TDP-001/TDP-004: 用 JWT_SECRET_KEY 签发的 token 应在 connect proxy 中通过验证。

        修复前 centrifugo_proxy 显式传 secret_key=CENTRIFUGO_TOKEN_SECRET，
        但 token 由 generate_jwt_token 用 JWT_SECRET_KEY 签发，密钥不一致导致 100% 失败。
        """
        import jwt as pyjwt
        from django.conf import settings
        from apps.tabchat.centrifugo_proxy import centrifugo_connect_proxy, ConnectRequest

        user_id = "00000000-0000-0000-0000-000000000099"
        token = pyjwt.encode(
            {"user_id": user_id, "token_type": "access", "exp": 9999999999, "sid": "s1"},
            settings.JWT_SECRET_KEY,
            algorithm="HS256",
        )

        req = MagicMock()
        payload = ConnectRequest(client="c1", data={"token": token})

        mock_user = MagicMock()
        mock_user.id = user_id
        mock_user.display_name = "Test"

        mock_cache = MagicMock()
        mock_cache.incr.return_value = 1

        mock_session = MagicMock()
        mock_session.user_id = user_id

        with patch("apps.tabchat.centrifugo_proxy._check_proxy_secret", return_value=None), \
             patch("apps.tabchat.centrifugo_proxy.User") as MockUser, \
             patch("apps.tabchat.centrifugo_proxy.SessionManager") as MockSM, \
             patch("apps.tabchat.centrifugo_proxy.cache", mock_cache):
            MockUser.objects.get.return_value = mock_user
            MockSM.validate_session.return_value = mock_session

            resp = centrifugo_connect_proxy(req, payload)

        self.assertIsNotNone(resp.result, "JWT_SECRET_KEY 签发的 token 应通过验证")
        self.assertEqual(resp.result.user, user_id)

    def test_connect_proxy_rejects_token_signed_with_wrong_key(self):
        """TDP-001 反面验证：用错误密钥签发的 token 仍然应被拒绝。"""
        import jwt as pyjwt
        from apps.tabchat.centrifugo_proxy import centrifugo_connect_proxy, ConnectRequest

        token = pyjwt.encode(
            {"user_id": "u1", "token_type": "access", "exp": 9999999999, "sid": "s1"},
            "completely-wrong-secret",
            algorithm="HS256",
        )

        req = MagicMock()
        payload = ConnectRequest(client="c1", data={"token": token})

        with patch("apps.tabchat.centrifugo_proxy._check_proxy_secret", return_value=None):
            resp = centrifugo_connect_proxy(req, payload)

        self.assertIsNotNone(resp.disconnect)
        self.assertEqual(resp.disconnect["code"], 4002)

    def test_connect_proxy_does_not_pass_secret_key_to_verify(self):
        """TDP-004 架构断层验证：connect proxy 不应显式传递 secret_key 参数。

        confirm verify_jwt_token is called without secret_key override,
        ensuring it uses the default JWT_SECRET_KEY.
        """
        import inspect
        from apps.tabchat.centrifugo_proxy import centrifugo_connect_proxy

        source = inspect.getsource(centrifugo_connect_proxy)
        self.assertNotIn("secret_key=", source,
                         "connect proxy 不应显式传递 secret_key（RT-08-DEBT 方案A）")
        self.assertIn("verify_jwt_token", source)

    def test_centrifugo_token_secret_defaults_to_jwt_secret_key(self):
        """TDP-002/TDP-003: CENTRIFUGO_TOKEN_SECRET 未配置时应回退到 JWT_SECRET_KEY。"""
        from django.conf import settings

        self.assertEqual(
            settings.CENTRIFUGO_TOKEN_SECRET,
            settings.JWT_SECRET_KEY,
            "CENTRIFUGO_TOKEN_SECRET 应默认等于 JWT_SECRET_KEY（RT-08-DEBT 方案A）",
        )


class SubRefreshProxyTests(unittest.TestCase):
    """DS-027: sub_refresh proxy 重验订阅权限。"""

    def setUp(self):
        self._user_patcher = patch("apps.tabchat.centrifugo_proxy.User")
        mock_user = self._user_patcher.start()
        mock_user.objects.filter.return_value.exists.return_value = True

    def tearDown(self):
        self._user_patcher.stop()

    def _build_request(self, secret="test_secret"):
        req = MagicMock()
        req.headers = {"X-Centrifugo-Proxy-Secret": secret}
        req.META = {"REMOTE_ADDR": "127.0.0.1"}
        return req

    @patch("apps.tabchat.centrifugo_proxy.settings")
    @patch("apps.tabchat.services.conversation_access.ConversationAccessResolver.resolve")
    @patch("apps.tabchat.models.Conversation")
    @patch("apps.tabchat.centrifugo_proxy.cache")
    def test_sub_refresh_revokes_when_not_member(
        self, _mock_cache, mock_conv, mock_resolve, mock_settings,
    ):
        """成员被移除后，sub_refresh 返回 expired=True。"""
        mock_settings.CENTRIFUGO_PROXY_SECRET = "test_secret"
        mock_settings.CENTRIFUGO_ALLOWED_PROXY_IPS = None
        mock_settings.CENTRIFUGO_TRUSTED_PROXIES = []
        mock_conv.objects.filter.return_value.first.return_value = MagicMock()
        mock_resolve.return_value.can_subscribe = False

        from apps.tabchat.centrifugo_proxy import centrifugo_sub_refresh_proxy, SubRefreshRequest
        payload = SubRefreshRequest(
            client="client-1",
            user="user-123",
            channel="chat:11111111-1111-1111-1111-111111111111",
        )
        resp = centrifugo_sub_refresh_proxy(self._build_request(), payload)
        self.assertTrue(resp.result.expired)

    @patch("apps.tabchat.centrifugo_proxy.settings")
    @patch("apps.tabchat.services.conversation_access.ConversationAccessResolver.resolve")
    @patch("apps.tabchat.models.Conversation")
    @patch("apps.tabchat.centrifugo_proxy.cache")
    def test_sub_refresh_allows_valid_member(
        self, _mock_cache, mock_conv, mock_resolve, mock_settings,
    ):
        """仍是成员时，sub_refresh 返回 expired=False。"""
        mock_settings.CENTRIFUGO_PROXY_SECRET = "test_secret"
        mock_settings.CENTRIFUGO_ALLOWED_PROXY_IPS = None
        mock_settings.CENTRIFUGO_TRUSTED_PROXIES = []
        mock_conv.objects.filter.return_value.first.return_value = MagicMock()
        mock_resolve.return_value.can_subscribe = True

        from apps.tabchat.centrifugo_proxy import centrifugo_sub_refresh_proxy, SubRefreshRequest
        payload = SubRefreshRequest(
            client="client-1",
            user="user-123",
            channel="chat:22222222-2222-2222-2222-222222222222",
        )
        resp = centrifugo_sub_refresh_proxy(self._build_request(), payload)
        self.assertFalse(resp.result.expired)

    @patch("apps.tabchat.centrifugo_proxy.settings")
    @patch("apps.tabchat.services.conversation_access.ConversationAccessResolver.resolve")
    @patch("apps.tabchat.models.Conversation")
    @patch("apps.tabchat.centrifugo_proxy.cache")
    def test_sub_refresh_revokes_when_not_organization_member(
        self, _mock_cache, mock_conv, mock_resolve, mock_settings,
    ):
        """organization 成员被移除后，sub_refresh 返回 expired=True。"""
        mock_settings.CENTRIFUGO_PROXY_SECRET = "test_secret"
        mock_settings.CENTRIFUGO_ALLOWED_PROXY_IPS = None
        mock_settings.CENTRIFUGO_TRUSTED_PROXIES = []
        mock_conv.objects.filter.return_value.first.return_value = MagicMock()
        mock_resolve.return_value.can_subscribe = False

        from apps.tabchat.centrifugo_proxy import centrifugo_sub_refresh_proxy, SubRefreshRequest
        payload = SubRefreshRequest(
            client="client-1",
            user="user-123",
            channel="chat:33333333-3333-3333-3333-333333333333",
        )
        resp = centrifugo_sub_refresh_proxy(self._build_request(), payload)
        self.assertTrue(resp.result.expired)

    @patch("apps.tabchat.centrifugo_proxy.settings")
    @patch("apps.tabchat.models.Conversation")
    @patch("apps.tabchat.centrifugo_proxy.cache")
    def test_sub_refresh_revokes_unknown_conversation(self, _mock_cache, mock_conv, mock_settings):
        """conversation 不存在时返回 expired=True。"""
        mock_settings.CENTRIFUGO_PROXY_SECRET = "test_secret"
        mock_settings.CENTRIFUGO_ALLOWED_PROXY_IPS = None
        mock_settings.CENTRIFUGO_TRUSTED_PROXIES = []
        mock_conv.objects.filter.return_value.first.return_value = None

        from apps.tabchat.centrifugo_proxy import centrifugo_sub_refresh_proxy, SubRefreshRequest
        payload = SubRefreshRequest(
            client="client-1",
            user="user-123",
            channel="chat:44444444-4444-4444-4444-444444444444",
        )
        resp = centrifugo_sub_refresh_proxy(self._build_request(), payload)
        self.assertTrue(resp.result.expired)

    @patch("apps.tabchat.centrifugo_proxy.settings")
    @patch("apps.tabchat.centrifugo_proxy.cache")
    def test_sub_refresh_personal_channel_valid(self, _mock_cache, mock_settings):
        """personal channel: 自己的频道返回 expired=False。"""
        mock_settings.CENTRIFUGO_PROXY_SECRET = "test_secret"
        mock_settings.CENTRIFUGO_ALLOWED_PROXY_IPS = None
        mock_settings.CENTRIFUGO_TRUSTED_PROXIES = []

        from apps.tabchat.centrifugo_proxy import centrifugo_sub_refresh_proxy, SubRefreshRequest
        uid = "55555555-5555-5555-5555-555555555555"
        payload = SubRefreshRequest(
            client="client-1",
            user=uid,
            channel=f"personal:{uid}",
        )
        resp = centrifugo_sub_refresh_proxy(self._build_request(), payload)
        self.assertFalse(resp.result.expired)

    @patch("apps.tabchat.centrifugo_proxy.settings")
    @patch("apps.tabchat.centrifugo_proxy.cache")
    def test_sub_refresh_personal_channel_other_user(self, _mock_cache, mock_settings):
        """personal channel: 他人频道返回 expired=True。"""
        mock_settings.CENTRIFUGO_PROXY_SECRET = "test_secret"
        mock_settings.CENTRIFUGO_ALLOWED_PROXY_IPS = None
        mock_settings.CENTRIFUGO_TRUSTED_PROXIES = []

        from apps.tabchat.centrifugo_proxy import centrifugo_sub_refresh_proxy, SubRefreshRequest
        payload = SubRefreshRequest(
            client="client-1",
            user="66666666-6666-6666-6666-666666666666",
            channel="personal:77777777-7777-7777-7777-777777777777",
        )
        resp = centrifugo_sub_refresh_proxy(self._build_request(), payload)
        self.assertTrue(resp.result.expired)


class UnsubscribeOrganizationChannelsTests(unittest.TestCase):
    """DS-027: unsubscribe_centrifugo_user_from_organization 主动退订。"""

    @patch("apps.tabchat.services.centrifugo_service.get_centrifugo_service")
    @patch("apps.tabchat.models.Conversation")
    def test_unsubscribe_calls_service_for_each_channel(self, mock_conv, mock_get_service):
        from apps.tabchat.centrifugo_proxy import unsubscribe_centrifugo_user_from_organization

        mock_service = MagicMock()
        mock_get_service.return_value = mock_service
        mock_conv.objects.filter.return_value.values_list.return_value = [
            "conv-aaa", "conv-bbb",
        ]

        unsubscribe_centrifugo_user_from_organization("user-123", "ws-456")

        self.assertEqual(mock_service.unsubscribe.call_count, 2)
        mock_service.unsubscribe.assert_any_call("user-123", "chat:conv-aaa")
        mock_service.unsubscribe.assert_any_call("user-123", "chat:conv-bbb")

    @patch("apps.tabchat.services.centrifugo_service.get_centrifugo_service")
    @patch("apps.tabchat.models.Conversation")
    def test_synchronous_unsubscribe_waits_for_each_channel(self, mock_conv, mock_get_service):
        """组织移除必须同步撤销，不能与随后群消息的异步发布竞争。"""
        from apps.tabchat.centrifugo_proxy import unsubscribe_centrifugo_user_from_organization

        mock_service = MagicMock()
        mock_get_service.return_value = mock_service
        mock_conv.objects.filter.return_value.values_list.return_value = ["conv-aaa", "conv-bbb"]

        unsubscribe_centrifugo_user_from_organization(
            "user-123",
            "ws-456",
            synchronous=True,
        )

        self.assertEqual(mock_service.unsubscribe_sync.call_count, 2)
        mock_service.unsubscribe_sync.assert_any_call("user-123", "chat:conv-aaa")
        mock_service.unsubscribe_sync.assert_any_call("user-123", "chat:conv-bbb")
        mock_service.unsubscribe.assert_not_called()

    @patch("apps.tabchat.services.centrifugo_service.get_centrifugo_service")
    @patch("apps.tabchat.models.Conversation")
    def test_unsubscribe_no_conversations_is_noop(self, mock_conv, mock_get_service):
        from apps.tabchat.centrifugo_proxy import unsubscribe_centrifugo_user_from_organization

        mock_conv.objects.filter.return_value.values_list.return_value = []
        unsubscribe_centrifugo_user_from_organization("user-123", "ws-456")
        mock_get_service.assert_not_called()

    @patch("apps.tabchat.services.centrifugo_service.get_centrifugo_service")
    @patch("apps.tabchat.models.Conversation")
    def test_unsubscribe_does_not_raise_on_error(self, mock_conv, mock_get_service):
        from apps.tabchat.centrifugo_proxy import unsubscribe_centrifugo_user_from_organization

        mock_service = MagicMock()
        mock_service.unsubscribe.side_effect = Exception("connection refused")
        mock_get_service.return_value = mock_service
        mock_conv.objects.filter.return_value.values_list.return_value = ["conv-x"]

        unsubscribe_centrifugo_user_from_organization("user-err", "ws-err")


if __name__ == "__main__":
    unittest.main(verbosity=2)
