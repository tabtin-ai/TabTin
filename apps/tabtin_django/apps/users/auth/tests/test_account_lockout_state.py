"""账号密码锁定状态机回归测试。"""

from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth import authenticate, get_user_model
from django.test import RequestFactory, TestCase, override_settings
from django.utils import timezone

from apps.users.auth.api.auth_routes import login_user
from apps.users.auth.schemas import UserLoginSchema


User = get_user_model()


@override_settings(LOGIN_ATTEMPT_LIMIT=2, ACCOUNT_LOCKOUT_DURATION=120)
class AccountLockoutStateMachineTest(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            email="lockout@example.com",
            username="lockout_state",
            password="CorrectPass1!",
        )
        self.factory = RequestFactory()

    def _set_failed_state(self, attempts, last_failed_login):
        User.objects.filter(id=self.user.id).update(
            failed_login_attempts=attempts,
            last_failed_login=last_failed_login,
        )
        self.user.refresh_from_db()

    def _login(self, password):
        request = self.factory.post("/api/auth/login")
        data = UserLoginSchema(
            username=self.user.email,
            password=password,
            remember_me=False,
        )
        with patch(
            "apps.users.auth.api.auth_routes.get_client_ip",
            return_value="127.0.0.1",
        ), patch(
            "apps.users.auth.api.auth_routes.check_login_rate_limit",
            return_value=(True, ""),
        ), patch(
            "apps.users.auth.api.auth_routes.record_rate_limit_hit",
        ) as record_rate_limit, patch(
            "apps.users.auth.api.auth_routes.log_security_event",
        ):
            result = login_user(request, data)
        return result, record_rate_limit

    def test_lockout_uses_configured_limit_and_duration(self):
        fixed_now = timezone.now()
        self._set_failed_state(2, fixed_now - timedelta(seconds=30))

        self.assertEqual(self.user.login_attempt_limit(), 2)
        self.assertEqual(self.user.account_lockout_duration_seconds(), 120)
        self.assertEqual(
            self.user.account_lockout_remaining_seconds(now=fixed_now),
            90,
        )
        self.assertTrue(self.user.is_account_locked())

    def test_locked_retry_returns_real_remaining_time_without_extending_state(self):
        fixed_now = timezone.now()
        last_failed = fixed_now - timedelta(seconds=30)
        self._set_failed_state(2, last_failed)

        with patch("apps.users.auth.models.timezone.now", return_value=fixed_now):
            result, record_rate_limit = self._login("WrongPass1!")

        status_code, body = result
        self.assertEqual(status_code, 401)
        self.assertEqual(body.code, "ACCOUNT_LOCKED")
        self.assertEqual(body.retry_after_seconds, 90)
        self.assertIn("2分钟", body.message)
        record_rate_limit.assert_not_called()

        self.user.refresh_from_db()
        self.assertEqual(self.user.failed_login_attempts, 2)
        self.assertEqual(self.user.last_failed_login, last_failed)

    def test_first_wrong_password_after_expiry_starts_a_new_failure_cycle(self):
        fixed_now = timezone.now()
        self._set_failed_state(2, fixed_now - timedelta(seconds=121))

        with patch("apps.users.auth.models.timezone.now", return_value=fixed_now):
            result, record_rate_limit = self._login("WrongPass1!")

        status_code, body = result
        self.assertEqual(status_code, 401)
        self.assertEqual(body.code, "AUTH_INVALID")
        record_rate_limit.assert_called_once()

        self.user.refresh_from_db()
        self.assertEqual(self.user.failed_login_attempts, 1)
        self.assertEqual(self.user.last_failed_login, fixed_now)
        self.assertFalse(self.user.is_account_locked())

    def test_correct_password_after_expiry_clears_all_failure_state(self):
        self._set_failed_state(2, timezone.now() - timedelta(seconds=121))

        authenticated = authenticate(
            username=self.user.email,
            password="CorrectPass1!",
        )

        self.assertIsNotNone(authenticated)
        self.user.refresh_from_db()
        self.assertEqual(self.user.failed_login_attempts, 0)
        self.assertIsNone(self.user.last_failed_login)

    def test_missing_last_failure_timestamp_is_treated_as_an_expired_cycle(self):
        fixed_now = timezone.now()
        self._set_failed_state(2, None)

        with patch("apps.users.auth.models.timezone.now", return_value=fixed_now):
            result, _ = self._login("WrongPass1!")

        status_code, body = result
        self.assertEqual(status_code, 401)
        self.assertEqual(body.code, "AUTH_INVALID")

        self.user.refresh_from_db()
        self.assertEqual(self.user.failed_login_attempts, 1)
        self.assertEqual(self.user.last_failed_login, fixed_now)

    def test_threshold_failure_returns_full_lockout_window(self):
        fixed_now = timezone.now()
        self._set_failed_state(1, fixed_now - timedelta(seconds=10))

        with patch("apps.users.auth.models.timezone.now", return_value=fixed_now):
            result, record_rate_limit = self._login("WrongPass1!")

        status_code, body = result
        self.assertEqual(status_code, 401)
        self.assertEqual(body.code, "ACCOUNT_LOCKED")
        self.assertEqual(body.retry_after_seconds, 120)
        record_rate_limit.assert_called_once()

        self.user.refresh_from_db()
        self.assertEqual(self.user.failed_login_attempts, 2)
        self.assertEqual(self.user.last_failed_login, fixed_now)
