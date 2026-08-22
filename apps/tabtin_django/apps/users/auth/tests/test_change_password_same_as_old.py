from unittest.mock import MagicMock, patch

from django.core.exceptions import ValidationError
from django.test import RequestFactory, SimpleTestCase

from apps.users.auth.api.password_routes import (
    change_password,
    forgot_password,
    reset_current_password,
    reset_password,
    send_current_password_reset_code,
)
from apps.users.auth.schemas import (
    CurrentUserPasswordResetSchema,
    PasswordChangeSchema,
    PasswordResetSchema,
)


class ChangePasswordSameAsOldTests(SimpleTestCase):
    @patch("apps.users.auth.api.password_routes.VerificationCodeManager.send_code", return_value=(True, "ok", "123456"))
    @patch("apps.users.auth.api.password_routes.check_verification_code_rate_limit", return_value=(True, ""))
    @patch("apps.users.auth.api.password_routes.get_client_ip", return_value="127.0.0.1")
    def test_send_current_password_reset_code_uses_authenticated_user_phone(
        self,
        mock_ip,
        mock_rate_limit,
        mock_send_code,
    ):
        user = MagicMock()
        user.phone = "13193422708"
        user.email = "user@example.com"
        request = RequestFactory().post("/api/auth/send-current-password-reset-code")
        request.auth = user

        response = send_current_password_reset_code(request)

        self.assertTrue(response.success)
        mock_rate_limit.assert_called_once_with("13193422708", "127.0.0.1")
        mock_send_code.assert_called_once_with(
            "13193422708",
            "change_password",
            ip_address="127.0.0.1",
            skip_rate_limit=True,
        )

    @patch("apps.users.auth.api.password_routes.UserApiKey")
    @patch("apps.users.auth.api.password_routes.log_user_action")
    @patch("apps.users.auth.api.password_routes._notify_logout_revocations")
    @patch("apps.users.auth.api.password_routes.UserSession")
    @patch("apps.users.auth.api.password_routes.VerificationCodeManager.verify_code", return_value=True)
    def test_reset_current_password_verifies_code_against_authenticated_user_phone(
        self,
        mock_verify_code,
        mock_session,
        mock_revoke,
        mock_log_action,
        mock_api_key,
    ):
        user = MagicMock()
        user.id = "test-user-id"
        user.phone = "13193422708"
        user.email = "user@example.com"
        user.is_account_locked.return_value = False
        user.check_password.return_value = False
        mock_api_key.objects.using.return_value.filter.return_value.count.return_value = 0
        request = RequestFactory().post("/api/auth/reset-current-password")
        request.auth = user

        with patch("apps.users.auth.api.password_routes.validate_user_password"):
            response = reset_current_password(
                request,
                CurrentUserPasswordResetSchema(
                    verification_code="123456",
                    new_password="NewPass1!",
                ),
            )

        self.assertTrue(response.success)
        mock_verify_code.assert_called_once_with(
            "13193422708",
            "123456",
            "change_password",
            delete_after_verify=True,
        )
        user.set_password.assert_called_once_with("NewPass1!")
        user.save.assert_called_once()
        mock_session.objects.filter.return_value.update.assert_called_once_with(is_active=False)
        mock_revoke.assert_called_once_with(str(user.id))

    @patch("apps.users.auth.api.password_routes.VerificationCodeManager.send_code")
    @patch("apps.users.auth.api.password_routes.User")
    @patch("apps.users.auth.api.password_routes.is_suspicious_password_reset_activity")
    @patch("apps.users.auth.api.password_routes.check_password_reset_rate_limit")
    @patch("apps.users.auth.api.password_routes.validate_password_reset_context")
    @patch("apps.users.auth.api.password_routes.log_security_event")
    @patch("apps.users.auth.api.password_routes.get_user_agent", return_value="TabTin-Test/1.0")
    @patch("apps.users.auth.api.password_routes.get_client_ip", return_value="127.0.0.1")
    def test_forgot_password_rejects_masked_identifier_before_risk_counting(
        self,
        mock_ip,
        mock_user_agent,
        mock_log_security,
        mock_validate_context,
        mock_rate_limit,
        mock_suspicious,
        mock_user_model,
        mock_send_code,
    ):
        request = RequestFactory().post("/api/auth/forgot-password")
        data = MagicMock()
        data.username = "131****2708"

        response = forgot_password(request, data)

        self.assertFalse(response.success)
        self.assertEqual(response.code, "VALIDATION_ERROR")
        mock_log_security.assert_called_once()
        mock_validate_context.assert_not_called()
        mock_rate_limit.assert_not_called()
        mock_suspicious.assert_not_called()
        mock_user_model.objects.get.assert_not_called()
        mock_send_code.assert_not_called()

    def test_rejects_new_password_equal_to_current_password(self):
        user = MagicMock()
        user.id = "test-user-id"
        user.check_password.return_value = True

        request = RequestFactory().post("/api/auth/change-password")
        request.auth = user

        with patch("apps.users.auth.api.password_routes.validate_user_password") as mock_validate:
            with patch("apps.users.auth.api.password_routes.UserSession") as mock_session:
                with patch("apps.users.auth.api.password_routes._notify_logout_revocations") as mock_revoke:
                    response = change_password(
                        request,
                        PasswordChangeSchema(
                            old_password="SamePass1!",
                            new_password="SamePass1!",
                        ),
                    )

        self.assertFalse(response.success)
        self.assertEqual(response.code, "VALIDATION_ERROR")
        self.assertEqual(response.message, "新密码不能与原密码相同")
        mock_validate.assert_not_called()
        user.set_password.assert_not_called()
        mock_session.objects.filter.assert_not_called()
        mock_revoke.assert_not_called()

    @patch("apps.users.auth.api.password_routes._check_verify_submit_ip_rate", return_value=(True, ""))
    @patch("apps.users.auth.api.password_routes.VerificationCodeManager.verify_code", return_value=True)
    @patch("apps.users.auth.api.password_routes.User")
    def test_reset_password_rejects_new_password_equal_to_current_password(
        self,
        mock_user_model,
        mock_verify_code,
        mock_rate_limit,
    ):
        user = MagicMock()
        user.id = "test-user-id"
        user.is_account_locked.return_value = False
        user.check_password.return_value = True
        mock_user_model.objects.get.return_value = user

        request = RequestFactory().post("/api/auth/reset-password")

        with patch("apps.users.auth.api.password_routes.validate_user_password") as mock_validate:
            with patch("apps.users.auth.api.password_routes.UserSession") as mock_session:
                with patch("apps.users.auth.api.password_routes._notify_logout_revocations") as mock_revoke:
                    response = reset_password(
                        request,
                        PasswordResetSchema(
                            username="user@example.com",
                            verification_code="123456",
                            new_password="SamePass1!",
                        ),
                    )

        self.assertFalse(response.success)
        self.assertEqual(response.code, "VALIDATION_ERROR")
        self.assertEqual(response.message, "新密码不能与原密码相同")
        mock_rate_limit.assert_called_once()
        mock_verify_code.assert_not_called()
        mock_validate.assert_called_once_with("SamePass1!")
        user.set_password.assert_not_called()
        mock_session.objects.filter.assert_not_called()
        mock_revoke.assert_not_called()

    @patch("apps.users.auth.api.password_routes._check_verify_submit_ip_rate", return_value=(True, ""))
    @patch("apps.users.auth.api.password_routes.VerificationCodeManager.verify_code")
    def test_reset_password_rejects_weak_password_before_verifying_code(
        self,
        mock_verify_code,
        mock_rate_limit,
    ):
        request = RequestFactory().post("/api/auth/reset-password")

        with patch(
            "apps.users.auth.api.password_routes.validate_user_password",
            side_effect=ValidationError("密码太简单"),
        ):
            response = reset_password(
                request,
                PasswordResetSchema(
                    username="user@example.com",
                    verification_code="123456",
                    new_password="12345678",
                ),
            )

        self.assertFalse(response.success)
        self.assertEqual(response.code, "VALIDATION_ERROR")
        mock_rate_limit.assert_called_once()
        mock_verify_code.assert_not_called()

    @patch("apps.users.auth.api.password_routes._check_verify_submit_ip_rate", return_value=(True, ""))
    @patch("apps.users.auth.api.password_routes.VerificationCodeManager.verify_code")
    @patch("apps.users.auth.api.password_routes.User")
    def test_reset_password_rejects_user_context_password_error_before_verifying_code(
        self,
        mock_user_model,
        mock_verify_code,
        mock_rate_limit,
    ):
        user = MagicMock()
        user.id = "test-user-id"
        user.is_account_locked.return_value = False
        user.check_password.return_value = False
        mock_user_model.objects.get.return_value = user

        request = RequestFactory().post("/api/auth/reset-password")

        def validate_side_effect(password, user_arg=None):
            if user_arg is user:
                raise ValidationError("不能包含用户信息")

        with patch(
            "apps.users.auth.api.password_routes.validate_user_password",
            side_effect=validate_side_effect,
        ):
            response = reset_password(
                request,
                PasswordResetSchema(
                    username="user@example.com",
                    verification_code="123456",
                    new_password="UserName1!",
                ),
            )

        self.assertFalse(response.success)
        self.assertEqual(response.code, "VALIDATION_ERROR")
        mock_rate_limit.assert_called_once()
        mock_verify_code.assert_not_called()

    @patch("apps.users.auth.api.password_routes._check_verify_submit_ip_rate", return_value=(True, ""))
    @patch("apps.users.auth.api.password_routes.VerificationCodeManager.verify_code")
    @patch("apps.users.auth.api.password_routes.User")
    def test_reset_password_allows_locked_account_to_recover_with_valid_code(
        self,
        mock_user_model,
        mock_verify_code,
        mock_rate_limit,
    ):
        user = MagicMock()
        user.id = "test-user-id"
        user.check_password.return_value = False
        mock_user_model.objects.get.return_value = user
        mock_verify_code.return_value = True

        request = RequestFactory().post("/api/auth/reset-password")

        with patch("apps.users.auth.api.password_routes.validate_user_password"):
            with patch("apps.users.auth.api.password_routes.UserSession"):
                with patch("apps.users.auth.api.password_routes._notify_logout_revocations"):
                    with patch("apps.users.auth.api.password_routes.log_user_action"):
                        with patch("apps.users.auth.api.password_routes.UserApiKey") as mock_api_key:
                            mock_api_key.objects.using.return_value.filter.return_value.count.return_value = 0
                            response = reset_password(
                                request,
                                PasswordResetSchema(
                                    username="user@example.com",
                                    verification_code="123456",
                                    new_password="NewPass1!",
                                ),
                            )

        self.assertTrue(response.success)
        mock_rate_limit.assert_called_once()
        mock_verify_code.assert_called_once()
        user.reset_login_failures.assert_called_once()

    @patch("apps.users.auth.api.password_routes._check_verify_submit_ip_rate", return_value=(True, ""))
    @patch("apps.users.auth.api.password_routes.VerificationCodeManager.verify_code", return_value=True)
    @patch("apps.users.auth.api.password_routes.User")
    def test_reset_password_consumes_code_after_password_checks(
        self,
        mock_user_model,
        mock_verify_code,
        mock_rate_limit,
    ):
        user = MagicMock()
        user.id = "test-user-id"
        user.is_account_locked.return_value = False
        user.check_password.return_value = False
        mock_user_model.objects.get.return_value = user

        request = RequestFactory().post("/api/auth/reset-password")

        with patch("apps.users.auth.api.password_routes.validate_user_password") as mock_validate:
            with patch("apps.users.auth.api.password_routes.UserSession") as mock_session:
                with patch("apps.users.auth.api.password_routes._notify_logout_revocations") as mock_revoke:
                    with patch("apps.users.auth.api.password_routes.log_user_action"):
                        with patch("apps.users.auth.api.password_routes.UserApiKey") as mock_api_key:
                            mock_api_key.objects.using.return_value.filter.return_value.count.return_value = 0
                            response = reset_password(
                                request,
                                PasswordResetSchema(
                                    username="user@example.com",
                                    verification_code="123456",
                                    new_password="NewPass1!",
                                ),
                            )

        self.assertTrue(response.success)
        mock_rate_limit.assert_called_once()
        self.assertEqual(mock_validate.call_args_list[0].args, ("NewPass1!",))
        self.assertEqual(mock_validate.call_args_list[1].args, ("NewPass1!", user))
        mock_verify_code.assert_called_once_with(
            "user@example.com",
            "123456",
            "reset_password",
            delete_after_verify=True,
        )
        user.set_password.assert_called_once_with("NewPass1!")
        user.save.assert_called_once()
        mock_session.objects.filter.return_value.update.assert_called_once_with(is_active=False)
        mock_revoke.assert_called_once_with(str(user.id))
