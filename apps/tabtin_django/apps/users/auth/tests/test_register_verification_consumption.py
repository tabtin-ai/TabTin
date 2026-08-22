from types import SimpleNamespace
from unittest.mock import patch

from django.core.exceptions import ValidationError
from django.test import RequestFactory, TestCase

from apps.users.auth.api.auth_routes import register_user
from apps.users.auth.models import User


class RegisterVerificationConsumptionTests(TestCase):
    def setUp(self):
        self.factory = RequestFactory()

    def _request(self):
        request = self.factory.post("/api/auth/register")
        request.META["REMOTE_ADDR"] = "127.0.0.1"
        request.META["HTTP_USER_AGENT"] = "register-verification-test"
        return request

    def _payload(self, *, password: str = "ValidPass123!", phone: str = "13900003001"):
        return SimpleNamespace(
            email=None,
            phone=phone,
            password=password,
            nickname="Register User",
            username=None,
            verification_code="123456",
            invite_code=None,
            language=None,
        )

    @patch("apps.users.auth.api.auth_routes.VerificationCodeManager.verify_code")
    @patch("apps.users.auth.api.auth_routes._check_verify_submit_ip_rate", return_value=(True, ""))
    @patch(
        "apps.users.auth.api.auth_routes.validate_user_password",
        side_effect=ValidationError("密码太简单"),
    )
    def test_invalid_password_does_not_consume_register_code(
        self,
        _mock_validate_password,
        _mock_rate,
        mock_verify_code,
    ):
        response = register_user(self._request(), self._payload(password="weakpass"))

        status_code, body = response
        self.assertEqual(status_code, 400)
        self.assertFalse(body.success)
        self.assertEqual(body.code, "VALIDATION_ERROR")
        mock_verify_code.assert_not_called()

    @patch("apps.users.auth.api.auth_routes._create_auth_session", return_value=("access", "refresh", 24))
    @patch("apps.users.auth.api.auth_routes._ensure_personal_organization_before_login", return_value=True)
    @patch("apps.users.auth.api.auth_routes.VerificationCodeManager.delete_code")
    @patch("apps.users.auth.api.auth_routes.VerificationCodeManager.verify_code", return_value=True)
    @patch("apps.users.auth.api.auth_routes._check_verify_submit_ip_rate", return_value=(True, ""))
    def test_successful_register_consumes_code_after_user_created(
        self,
        _mock_rate,
        mock_verify_code,
        mock_delete_code,
        _mock_ensure_org,
        _mock_create_session,
    ):
        response = register_user(self._request(), self._payload())

        self.assertIsInstance(response, dict)
        self.assertTrue(User.objects.filter(phone="13900003001").exists())
        mock_verify_code.assert_called_once_with(
            "13900003001",
            "123456",
            "register",
            delete_after_verify=False,
        )
        mock_delete_code.assert_called_once_with("13900003001", "register")

    @patch("apps.users.auth.api.auth_routes.VerificationCodeManager.delete_code")
    @patch("apps.users.auth.api.auth_routes.VerificationCodeManager.verify_code", return_value=True)
    @patch("apps.users.auth.api.auth_routes._check_verify_submit_ip_rate", return_value=(True, ""))
    def test_registered_phone_does_not_consume_verified_code(
        self,
        _mock_rate,
        mock_verify_code,
        mock_delete_code,
    ):
        User.objects.create_user(phone="13900003002", username="existing_user")

        response = register_user(self._request(), self._payload(phone="13900003002"))

        status_code, body = response
        self.assertEqual(status_code, 400)
        self.assertFalse(body.success)
        self.assertEqual(body.code, "VALIDATION_ERROR")
        mock_verify_code.assert_called_once_with(
            "13900003002",
            "123456",
            "register",
            delete_after_verify=False,
        )
        mock_delete_code.assert_not_called()
