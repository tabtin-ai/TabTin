"""绑定邮箱 API：手机号账号可补绑邮箱。"""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.core.exceptions import ValidationError
from django.test import SimpleTestCase, RequestFactory


class BindEmailApiTests(SimpleTestCase):
    def setUp(self):
        self.factory = RequestFactory()

    @patch("apps.users.auth.api.verification_routes.VerificationCodeManager")
    @patch("apps.users.auth.api.verification_routes.validate_unique_email")
    @patch("apps.users.auth.api.verification_routes.check_verification_code_rate_limit")
    def test_send_bind_email_code_ok(self, rate_mock, unique_mock, vcm):
        from apps.users.auth.api.verification_routes import send_bind_email_code

        rate_mock.return_value = (True, "")
        vcm.send_code.return_value = (True, "ok", "123456")
        user = MagicMock(email=None, id="u1")
        request = self.factory.post("/auth/send-bind-email-code")
        request.auth = user
        data = SimpleNamespace(email="new@example.com")

        result = send_bind_email_code(request, data)
        self.assertTrue(result.success)
        vcm.send_code.assert_called_once()
        self.assertEqual(vcm.send_code.call_args.args[1], "bind_email")

    @patch("apps.users.auth.api.verification_routes.validate_unique_email")
    def test_send_bind_email_code_rejects_already_bound(self, _unique_mock):
        from apps.users.auth.api.verification_routes import send_bind_email_code

        user = MagicMock(email="old@example.com", id="u1")
        request = self.factory.post("/auth/send-bind-email-code")
        request.auth = user
        data = SimpleNamespace(email="new@example.com")

        result = send_bind_email_code(request, data)
        self.assertFalse(result.success)
        self.assertEqual(result.code, "VALIDATION_ERROR")

    @patch("apps.users.auth.api.verification_routes.log_user_action")
    @patch("apps.users.auth.api.verification_routes.VerificationCodeManager")
    @patch("apps.users.auth.api.verification_routes.validate_unique_email")
    @patch("apps.users.auth.api.verification_routes._check_verify_submit_ip_rate")
    def test_bind_email_success(self, rate_mock, unique_mock, vcm, _log):
        from apps.users.auth.api.verification_routes import bind_email

        rate_mock.return_value = (True, "")
        vcm.verify_code.return_value = True
        user = MagicMock(email=None, id="u1")
        request = self.factory.post("/auth/bind-email")
        request.auth = user
        data = SimpleNamespace(email="new@example.com", verification_code="123456")

        result = bind_email(request, data)
        self.assertTrue(result.success)
        self.assertEqual(user.email, "new@example.com")
        self.assertTrue(user.is_verified_email)
        user.save.assert_called_once()

    @patch("apps.users.auth.api.verification_routes.validate_unique_email")
    def test_bind_email_rejects_taken_email(self, unique_mock):
        from apps.users.auth.api.verification_routes import bind_email

        unique_mock.side_effect = ValidationError("该邮箱已被注册")
        user = MagicMock(email=None, id="u1")
        request = self.factory.post("/auth/bind-email")
        request.auth = user
        data = SimpleNamespace(email="taken@example.com", verification_code="123456")

        result = bind_email(request, data)
        self.assertFalse(result.success)
        self.assertIn("邮箱", result.message)
