from unittest.mock import MagicMock, patch
from types import SimpleNamespace

from django.test import RequestFactory, SimpleTestCase, override_settings

from apps.users.auth.api.verification_routes import send_verification_code
from apps.users.auth.verification_manager import VerificationCodeManager


class CommunityFixedVerificationCodeTests(SimpleTestCase):
    def setUp(self):
        self.request_factory = RequestFactory()
        self.redis_values: dict[str, str] = {}
        self.redis = MagicMock()
        self.redis.setex.side_effect = (
            lambda key, _ttl, value: self.redis_values.__setitem__(key, value)
        )
        self.redis.get.side_effect = lambda key: self.redis_values.get(key)
        self.redis.delete.side_effect = lambda key: self.redis_values.pop(key, None)

    @override_settings(
        TABTIN_EDITION="community",
        AUTH_FIXED_VERIFICATION_CODE="",
        SERVICES_SMS_PROVIDER="disabled",
    )
    @patch("apps.users.auth.verification_manager.get_redis_connection")
    def test_community_phone_login_defaults_to_888888(self, get_redis_connection):
        get_redis_connection.return_value = self.redis

        success, message, code = VerificationCodeManager.send_code(
            "13900009999",
            "login",
            skip_rate_limit=True,
            challenge_key="community-login-challenge",
        )

        self.assertTrue(success)
        self.assertIn("888888", message)
        self.assertEqual(code, "888888")
        self.assertTrue(
            VerificationCodeManager.verify_code(
                "13900009999",
                "888888",
                "login",
                challenge_key="community-login-challenge",
            )
        )

    @override_settings(
        TABTIN_EDITION="community",
        AUTH_FIXED_VERIFICATION_CODE="",
        SERVICES_SMS_PROVIDER="disabled",
    )
    @patch.object(VerificationCodeManager, "check_rate_limit", return_value=(True, ""))
    @patch("apps.users.auth.verification_manager.get_redis_connection")
    def test_community_send_endpoint_tells_the_user_the_fixed_code(
        self, get_redis_connection, _check_rate_limit
    ):
        get_redis_connection.return_value = self.redis
        request = self.request_factory.post("/api/auth/send-verification-code")
        payload = SimpleNamespace(
            username="13900009995",
            code_type="login",
            challenge_key="community-route-challenge",
        )

        response = send_verification_code(request, payload)

        self.assertTrue(response.success)
        self.assertIn("888888", response.message)

    @override_settings(
        TABTIN_EDITION="community",
        AUTH_FIXED_VERIFICATION_CODE="654321",
        SERVICES_SMS_PROVIDER="disabled",
    )
    @patch("apps.users.auth.verification_manager.get_redis_connection")
    def test_community_phone_registration_uses_configured_fixed_code(
        self, get_redis_connection
    ):
        get_redis_connection.return_value = self.redis

        success, message, code = VerificationCodeManager.send_code(
            "13900009998", "register", skip_rate_limit=True
        )

        self.assertTrue(success)
        self.assertIn("654321", message)
        self.assertEqual(code, "654321")

    @override_settings(
        TABTIN_EDITION="community",
        AUTH_FIXED_VERIFICATION_CODE="888888",
        SERVICES_SMS_PROVIDER="disabled",
    )
    @patch("apps.users.auth.verification_manager.get_redis_connection")
    def test_community_fixed_code_does_not_apply_to_password_reset(
        self, get_redis_connection
    ):
        get_redis_connection.return_value = self.redis

        success, _message, code = VerificationCodeManager.send_code(
            "13900009997", "reset_password", skip_rate_limit=True
        )

        self.assertFalse(success)
        self.assertEqual(code, "")

    @override_settings(
        TABTIN_EDITION="saas",
        AUTH_FIXED_VERIFICATION_CODE="888888",
        SERVICES_SMS_PROVIDER="aliyun",
    )
    @patch("apps.users.auth.verification_manager.VerificationCodeManager.generate_code")
    @patch("apps.users.auth.verification_manager.get_redis_connection")
    @patch("apps.services.sms.services.factory.get_sms_service")
    def test_saas_ignores_fixed_verification_code(
        self, get_sms_service, get_redis_connection, generate_code
    ):
        sms_service = MagicMock()
        sms_service.send_verification_code.return_value = {"success": True}
        get_sms_service.return_value = sms_service
        get_redis_connection.return_value = self.redis
        generate_code.return_value = "123456"

        success, _message, code = VerificationCodeManager.send_code(
            "13900009996", "login", skip_rate_limit=True
        )

        self.assertTrue(success)
        self.assertEqual(code, "123456")
