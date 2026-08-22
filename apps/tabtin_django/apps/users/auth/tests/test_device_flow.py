"""
OAuth Device Authorization Flow 回归测试

覆盖场景：
- 申请 device_code/user_code 成功，携带可配置 verification_uri
- 申请 → 用户 approve → CLI token 换取成功，session_type='api'
- token 端点在 pending 阶段返回 AUTHORIZATION_PENDING
- 用户 deny 后 token 端点返回 ACCESS_DENIED，且记录被一次性消费
- device_code 不存在/已过期（cache 未命中模拟）返回 EXPIRED_TOKEN
- 轮询过快返回 SLOW_DOWN
- approve 时 user_code 不存在返回 NOT_FOUND
"""
from django.core.cache import cache
from django.test import RequestFactory, TestCase
from django.utils import timezone

from apps.users.auth.api.device_routes import (
    DeviceAuthorizationStore,
    approve_device_code,
    device_token,
    request_device_code,
)
from apps.users.auth.models import User, UserSession
from apps.users.auth.schemas import (
    DeviceApproveSchema,
    DeviceCodeRequestSchema,
    DeviceTokenRequestSchema,
)
from apps.users.auth.utils import mask_email


class DeviceFlowTestCase(TestCase):
    """OAuth Device Authorization Flow 端到端测试基类"""

    databases = {"default", "postgresql"}

    def setUp(self):
        cache.clear()
        self.factory = RequestFactory()
        self.user = User.objects.create_user(
            email="device_flow_user@test.com",
            password="DeviceFlowPass123!",
        )

    def tearDown(self):
        cache.clear()

    def _request(self, path="/api/auth/device/code"):
        request = self.factory.post(path)
        request.META["REMOTE_ADDR"] = "127.0.0.1"
        request.META["HTTP_USER_AGENT"] = "device-flow-test"
        return request

    def _request_code(self, client_id="tabtin-cli", device_name="Test Laptop"):
        result = request_device_code(
            self._request(),
            DeviceCodeRequestSchema(client_id=client_id, device_name=device_name),
        )
        # 成功路径直接返回 dict（success_response），失败路径返回 (status, Schema)
        self.assertIsInstance(result, dict, f"申请 device_code 失败: {result}")
        return result["data"]

    def _approve(self, user_code, approve=True):
        request = self._request("/api/auth/device/approve")
        request.auth = self.user
        return approve_device_code(request, DeviceApproveSchema(user_code=user_code, approve=approve))

    def _poll_token(self, device_code):
        return device_token(
            self._request("/api/auth/device/token"),
            DeviceTokenRequestSchema(device_code=device_code),
        )


class RequestDeviceCodeTests(DeviceFlowTestCase):
    def test_request_device_code_returns_pending_record(self):
        """申请 device_code 应返回 device_code/user_code/verification_uri，且状态为 pending"""
        data = self._request_code(client_id="tabtin-cli", device_name="MacBook")

        self.assertTrue(data["device_code"])
        self.assertRegex(data["user_code"], r"^[A-Z0-9]{4}-[A-Z0-9]{4}$")
        self.assertIn(data["user_code"], data["verification_uri_complete"])
        self.assertEqual(data["expires_in"], DeviceAuthorizationStore.TTL_SECONDS)
        self.assertEqual(data["interval"], DeviceAuthorizationStore.MIN_POLL_INTERVAL_SECONDS)

        record = DeviceAuthorizationStore.get_by_device_code(data["device_code"])
        self.assertIsNotNone(record)
        self.assertEqual(record["status"], "pending")
        self.assertEqual(record["device_name"], "MacBook")

    def test_verification_uri_configurable_via_settings(self):
        """verification_uri 应读取 settings.TABTIN_DEVICE_VERIFY_URL"""
        with self.settings(TABTIN_DEVICE_VERIFY_URL="https://tabtin.example.com/device"):
            data = self._request_code()
            self.assertEqual(data["verification_uri"], "https://tabtin.example.com/device")


class ApproveThenTokenSuccessTests(DeviceFlowTestCase):
    def test_full_flow_issues_token_with_api_session_type(self):
        """申请 → approve → token 全链路成功，且落库 session_type='api'"""
        code_data = self._request_code()

        approve_result = self._approve(code_data["user_code"], approve=True)
        self.assertIsInstance(approve_result, dict)
        self.assertTrue(approve_result["success"])
        self.assertEqual(approve_result["data"]["status"], "approved")

        token_result = self._poll_token(code_data["device_code"])
        self.assertIsInstance(token_result, dict, f"token 换取失败: {token_result}")
        payload = token_result["data"]
        self.assertTrue(payload["access_token"])
        self.assertTrue(payload["refresh_token"])
        # 用户信息复用 _build_user_info，邮箱按平台惯例脱敏展示
        self.assertEqual(payload["user"]["email"], mask_email(self.user.email))

        session = UserSession.objects.get(user=self.user)
        self.assertEqual(session.session_type, "api")
        self.assertTrue(session.is_active)

    def test_token_deleted_after_successful_exchange_prevents_replay(self):
        """成功换取 token 后 cache 记录必须被删除，防止重放"""
        code_data = self._request_code()
        self._approve(code_data["user_code"], approve=True)
        self._poll_token(code_data["device_code"])

        self.assertIsNone(DeviceAuthorizationStore.get_by_device_code(code_data["device_code"]))
        self.assertIsNone(DeviceAuthorizationStore.get_by_user_code(code_data["user_code"]))

        replay_status, replay_body = self._poll_token(code_data["device_code"])
        self.assertEqual(replay_status, 400)
        self.assertEqual(replay_body.code, "EXPIRED_TOKEN")


class TokenPendingTests(DeviceFlowTestCase):
    def test_poll_before_approval_returns_authorization_pending(self):
        """未 approve 前轮询应返回 AUTHORIZATION_PENDING"""
        code_data = self._request_code()

        status_code, body = self._poll_token(code_data["device_code"])

        self.assertEqual(status_code, 400)
        self.assertFalse(body.success)
        self.assertEqual(body.code, "AUTHORIZATION_PENDING")


class TokenDeniedTests(DeviceFlowTestCase):
    def test_deny_then_poll_returns_access_denied_and_consumes_record(self):
        """用户 deny 后轮询应返回 ACCESS_DENIED，且记录被一次性消费"""
        code_data = self._request_code()
        self._approve(code_data["user_code"], approve=False)

        status_code, body = self._poll_token(code_data["device_code"])

        self.assertEqual(status_code, 400)
        self.assertEqual(body.code, "ACCESS_DENIED")
        self.assertIsNone(DeviceAuthorizationStore.get_by_device_code(code_data["device_code"]))


class TokenExpiredTests(DeviceFlowTestCase):
    def test_unknown_device_code_returns_expired_token(self):
        """cache 未命中（过期或不存在）时应返回 EXPIRED_TOKEN，不泄露区分信息"""
        status_code, body = self._poll_token("this-device-code-was-never-issued")

        self.assertEqual(status_code, 400)
        self.assertEqual(body.code, "EXPIRED_TOKEN")

    def test_ttl_expiry_simulated_by_cache_delete_returns_expired_token(self):
        """TTL 到期等价于 cache 命中失败：直接删除 cache 记录模拟过期"""
        code_data = self._request_code()
        DeviceAuthorizationStore.delete({
            "device_code": code_data["device_code"],
            "user_code": code_data["user_code"],
        })

        status_code, body = self._poll_token(code_data["device_code"])
        self.assertEqual(status_code, 400)
        self.assertEqual(body.code, "EXPIRED_TOKEN")


class TokenSlowDownTests(DeviceFlowTestCase):
    def test_poll_too_fast_returns_slow_down(self):
        """两次轮询间隔小于 interval 时应返回 SLOW_DOWN"""
        code_data = self._request_code()

        record = DeviceAuthorizationStore.get_by_device_code(code_data["device_code"])
        record["last_poll_ts"] = timezone.now().timestamp()
        DeviceAuthorizationStore.save(record)

        status_code, body = self._poll_token(code_data["device_code"])

        self.assertEqual(status_code, 400)
        self.assertEqual(body.code, "SLOW_DOWN")


class ApproveEdgeCaseTests(DeviceFlowTestCase):
    def test_approve_unknown_user_code_returns_not_found(self):
        """approve 时 user_code 不存在（未申请/已过期）应返回 NOT_FOUND"""
        status_code, body = self._approve("ZZZZ-9999", approve=True)

        self.assertEqual(status_code, 404)
        self.assertEqual(body.code, "NOT_FOUND")

    def test_approve_already_processed_returns_conflict(self):
        """同一 user_code 被重复 approve 应返回 409 ALREADY_PROCESSED"""
        code_data = self._request_code()
        self._approve(code_data["user_code"], approve=True)

        status_code, body = self._approve(code_data["user_code"], approve=True)

        self.assertEqual(status_code, 409)
        self.assertEqual(body.code, "ALREADY_PROCESSED")
