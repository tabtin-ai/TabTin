from types import SimpleNamespace
from unittest.mock import patch

from django.test import RequestFactory, TestCase

from apps.users.auth.admin_api import list_intent_users
from apps.users.auth.api.auth_routes import reserve_phone
from apps.users.auth.api.verification_routes import send_verification_code
from apps.users.auth.models import IntentUser, User


class IntentUserReservationTests(TestCase):
    def setUp(self):
        self.factory = RequestFactory()
        self.admin = User.objects.create_user(
            email="intent-admin@test.com",
            phone="13900009999",
            password="AdminPass123!",
            is_staff=True,
            is_superuser=True,
        )

    def _public_request(self):
        request = self.factory.post("/api/auth/phone-reservations")
        request.META["REMOTE_ADDR"] = "127.0.0.1"
        request.META["HTTP_USER_AGENT"] = "intent-user-test"
        return request

    def _admin_request(self):
        request = self.factory.get("/api/auth/admin/intent-users")
        request.auth = self.admin
        return request

    @patch("apps.users.auth.api.auth_routes.VerificationCodeManager.verify_code", return_value=True)
    def test_reserve_phone_creates_intent_user(self, _mock_verify):
        response = reserve_phone(
            self._public_request(),
            SimpleNamespace(phone="13800138000", verification_code="123456"),
        )

        self.assertTrue(response.success)
        self.assertEqual(response.code, "PHONE_RESERVED")
        self.assertEqual(response.data, {"phone": "13800138000"})
        self.assertTrue(IntentUser.objects.filter(phone="13800138000").exists())

    def test_reserve_phone_rejects_invalid_phone_with_business_code(self):
        status, response = reserve_phone(
            self._public_request(),
            SimpleNamespace(phone="abc", verification_code="123456"),
        )

        self.assertEqual(status, 400)
        self.assertFalse(response.success)
        self.assertEqual(response.code, "PHONE_FORMAT_INVALID")
        self.assertEqual(IntentUser.objects.count(), 0)

    @patch("apps.users.auth.api.auth_routes.VerificationCodeManager.verify_code", return_value=True)
    def test_reserve_phone_rejects_duplicate_phone_without_consuming_code(self, mock_verify):
        IntentUser.objects.create(phone="13800138001")

        status, response = reserve_phone(
            self._public_request(),
            SimpleNamespace(phone="13800138001", verification_code="123456"),
        )

        self.assertEqual(status, 409)
        self.assertFalse(response.success)
        self.assertEqual(response.code, "PHONE_ALREADY_RESERVED")
        self.assertEqual(response.data, {"phone": "13800138001"})
        self.assertEqual(IntentUser.objects.filter(phone="13800138001").count(), 1)
        mock_verify.assert_not_called()

    @patch("apps.users.auth.api.auth_routes.VerificationCodeManager.verify_code", return_value=False)
    def test_reserve_phone_requires_valid_verification_code(self, mock_verify):
        status, response = reserve_phone(
            self._public_request(),
            SimpleNamespace(phone="13800138004", verification_code="123456"),
        )

        self.assertEqual(status, 400)
        self.assertFalse(response.success)
        self.assertEqual(response.code, "VERIFICATION_CODE_INVALID")
        self.assertEqual(IntentUser.objects.count(), 0)
        mock_verify.assert_called_once_with(
            "13800138004",
            "123456",
            "phone_reservation",
            delete_after_verify=True,
        )

    def test_admin_list_intent_users_supports_keyword_and_pagination(self):
        IntentUser.objects.create(phone="13800138002")
        IntentUser.objects.create(phone="13900139003")

        response = list_intent_users(
            self._admin_request(),
            keyword="1380013",
            page=1,
            page_size=20,
        )

        self.assertEqual(response.pagination.total, 1)
        self.assertEqual(response.summary.total_intent_users, 2)
        self.assertEqual(response.summary.filtered_intent_users, 1)
        self.assertEqual(response.items[0].phone, "13800138002")

    @patch("apps.users.auth.api.verification_routes.VerificationCodeManager.send_code", return_value=(True, "验证码已发送，请查收", "123456"))
    @patch("apps.users.auth.api.verification_routes.VerificationCodeManager.check_rate_limit", return_value=(True, ""))
    def test_send_phone_reservation_verification_code(self, _mock_rate_limit, mock_send_code):
        response = send_verification_code(
            self._public_request(),
            SimpleNamespace(username="13800138005", code_type="phone_reservation", invite_code=None),
        )

        self.assertTrue(response.success)
        mock_send_code.assert_called_once_with(
            "13800138005",
            "phone_reservation",
            ip_address="127.0.0.1",
            skip_rate_limit=True,
        )

    @patch("apps.users.auth.api.verification_routes.VerificationCodeManager.send_code")
    @patch("apps.users.auth.api.verification_routes.VerificationCodeManager.check_rate_limit", return_value=(True, ""))
    def test_send_phone_reservation_verification_code_rejects_email(self, _mock_rate_limit, mock_send_code):
        response = send_verification_code(
            self._public_request(),
            SimpleNamespace(username="user@example.com", code_type="phone_reservation", invite_code=None),
        )

        self.assertFalse(response.success)
        self.assertEqual(response.code, "PHONE_FORMAT_INVALID")
        mock_send_code.assert_not_called()
