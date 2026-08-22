from types import SimpleNamespace
import json
from unittest.mock import patch
from datetime import timedelta

from django.test import RequestFactory, TestCase, override_settings
from django.http import HttpResponse
from django.utils import timezone

from apps.users.auth.api._shared import _create_auth_session
from apps.users.auth.api.auth_routes import login_with_verification_code, register_user
from apps.users.auth.api.profile_routes import redeem_invite_code
from apps.users.auth.api.verification_routes import send_verification_code
from apps.users.auth.invite_gate_middleware import InviteGateMiddleware
from apps.users.auth.models import RegistrationInviteCode, RegistrationInviteRedemption, User
from apps.users.auth.services.invite_code_service import (
    InviteCodeValidationError,
    consume_after_user_created,
)


@override_settings(TABTIN_REQUIRE_INVITE_CODE=True)
class RegistrationInviteCodeTests(TestCase):
    def setUp(self):
        self.factory = RequestFactory()
        self.invite = RegistrationInviteCode.objects.create(
            code="ALPHA2026",
            channel="feishu_group",
            campaign="alpha_batch_1",
            usage_limit=1,
        )

    def _request(self, path="/api/auth/register"):
        request = self.factory.post(path)
        request.META["REMOTE_ADDR"] = "127.0.0.1"
        request.META["HTTP_USER_AGENT"] = "invite-code-test"
        return request

    def _register_payload(self, *, invite_code=None, phone="13900000001"):
        return SimpleNamespace(
            email=None,
            phone=phone,
            password="ValidPass123!",
            nickname="Invite User",
            username=None,
            verification_code="123456",
            invite_code=invite_code,
            language=None,
        )

    @patch("apps.users.auth.api.auth_routes._create_auth_session", return_value=("access", "refresh", 24))
    @patch("apps.users.auth.api.auth_routes._ensure_personal_organization_before_login", return_value=True)
    @patch("apps.users.auth.api.auth_routes.VerificationCodeManager.verify_code", return_value=True)
    @patch("apps.users.auth.api.auth_routes._check_verify_submit_ip_rate", return_value=(True, ""))
    def test_register_without_invite_code_creates_account(self, *_mocks):
        result = register_user(self._request(), self._register_payload(invite_code=None))

        self.assertIsInstance(result, dict)
        self.assertTrue(User.objects.filter(phone="13900000001").exists())
        self.assertEqual(RegistrationInviteRedemption.objects.count(), 0)

    @patch("apps.users.auth.api.auth_routes._create_auth_session", return_value=("access", "refresh", 24))
    @patch("apps.users.auth.api.auth_routes._ensure_personal_organization_before_login", return_value=True)
    @patch("apps.users.auth.api.auth_routes.VerificationCodeManager.verify_code", return_value=True)
    @patch("apps.users.auth.api.auth_routes._check_verify_submit_ip_rate", return_value=(True, ""))
    def test_register_with_invite_code_does_not_consume_until_later_gate(self, *_mocks):
        response = register_user(self._request(), self._register_payload(invite_code="alpha2026"))

        self.assertIsInstance(response, dict)
        self.invite.refresh_from_db()
        self.assertEqual(self.invite.used_count, 0)
        self.assertEqual(RegistrationInviteRedemption.objects.count(), 0)

    @patch("apps.users.auth.api.auth_routes._create_auth_session", return_value=("access", "refresh", 24))
    @patch("apps.users.auth.api.auth_routes._ensure_personal_organization_before_login", return_value=True)
    @patch("apps.users.auth.api.auth_routes.VerificationCodeManager.verify_code", return_value=True)
    @patch("apps.users.auth.api.auth_routes._check_verify_submit_ip_rate", return_value=(True, ""))
    def test_verification_login_auto_register_without_invite_code_creates_account(self, *_mocks):
        payload = SimpleNamespace(
            username="13900000002",
            verification_code="123456",
            invite_code=None,
            remember_me=False,
        )

        result = login_with_verification_code(
            self._request("/api/auth/login/verification-code"),
            payload,
        )

        self.assertIsInstance(result, dict)
        self.assertTrue(User.objects.filter(phone="13900000002").exists())
        self.assertEqual(RegistrationInviteRedemption.objects.count(), 0)

    @patch("apps.users.auth.api.verification_routes.VerificationCodeManager.send_code", return_value=(True, "ok", "123456"))
    @patch("apps.users.auth.api.verification_routes.VerificationCodeManager.check_rate_limit", return_value=(True, ""))
    def test_register_send_code_does_not_require_invite_code(self, *_mocks):
        payload = SimpleNamespace(
            username="13900000003",
            code_type="register",
            invite_code=None,
        )

        response = send_verification_code(
            self._request("/api/auth/send-verification-code"),
            payload,
        )

        self.assertTrue(response.success)
        self.invite.refresh_from_db()
        self.assertEqual(self.invite.used_count, 0)

    @patch("apps.users.auth.api.verification_routes.VerificationCodeManager.send_code", return_value=(True, "ok", "123456"))
    @patch("apps.users.auth.api.verification_routes.VerificationCodeManager.check_rate_limit", return_value=(True, ""))
    def test_login_send_code_for_new_phone_does_not_require_invite_code(self, *_mocks):
        payload = SimpleNamespace(
            username="13900000007",
            code_type="login",
            invite_code=None,
        )

        response = send_verification_code(
            self._request("/api/auth/send-verification-code"),
            payload,
        )

        self.assertTrue(response.success)
        self.invite.refresh_from_db()
        self.assertEqual(self.invite.used_count, 0)

    def test_post_auth_gate_redeems_invite_code(self):
        user = User.objects.create_user(phone="13900000008", username="invite_gate")
        request = self._request("/api/auth/invite-code/redeem")
        request.auth = user
        second_invite = RegistrationInviteCode.objects.create(
            code="BETA2026",
            channel="feishu_group",
            campaign="alpha_batch_1",
            usage_limit=1,
        )

        response = redeem_invite_code(request, SimpleNamespace(invite_code="alpha2026"))
        duplicate_response = redeem_invite_code(request, SimpleNamespace(invite_code="beta2026"))

        self.assertTrue(response.success)
        self.assertTrue(duplicate_response.success)
        self.assertEqual(response.data["user"]["invite_code_required"], True)
        self.assertEqual(response.data["user"]["invite_code_redeemed"], True)
        self.invite.refresh_from_db()
        second_invite.refresh_from_db()
        self.assertEqual(self.invite.used_count, 1)
        self.assertEqual(second_invite.used_count, 0)
        self.assertEqual(RegistrationInviteRedemption.objects.filter(user=user).count(), 1)

    @patch("apps.users.auth.api.profile_routes.check_simple_rate_limit", return_value=False)
    def test_post_auth_gate_keeps_legacy_200_rate_limit_envelope(self, _mock_limit):
        user = User.objects.create_user(phone="13900000015", username="invite_rate_limited")
        request = self._request("/api/auth/invite-code/redeem")
        request.auth = user

        response = redeem_invite_code(
            request,
            SimpleNamespace(invite_code="alpha2026"),
        )

        self.assertFalse(response.success)
        self.assertEqual(response.code, "RATE_LIMITED")
        self.assertEqual(response.message, "请求频率过高，请稍后再试")
        self.assertFalse(hasattr(response, "retry_after_seconds"))

    @patch("apps.users.auth.api.profile_routes.check_simple_rate_limit", return_value=False)
    def test_post_auth_gate_uses_http_429_for_capable_clients(self, _mock_limit):
        user = User.objects.create_user(phone="13900000016", username="invite_http_429")
        request = self._request("/api/auth/invite-code/redeem")
        request.META["HTTP_X_TABTIN_ERROR_STATUS"] = "standard"
        request.auth = user

        response = redeem_invite_code(
            request,
            SimpleNamespace(invite_code="alpha2026"),
        )

        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.headers["Retry-After"], str(15 * 60))
        body = json.loads(response.content)
        self.assertFalse(body["success"])
        self.assertEqual(body["code"], "RATE_LIMITED")
        self.assertEqual(body["message"], "请求频率过高，请稍后再试")
        self.assertEqual(body["retry_after_seconds"], 15 * 60)

    def test_one_time_invite_consumption_is_atomic(self):
        user = User.objects.create_user(phone="13900000004", username="invite_atomic")
        consume_after_user_created(
            code="ALPHA2026",
            user=user,
            identifier=user.phone,
            request=self._request(),
            entrypoint="register",
        )

        second_user = User.objects.create_user(phone="13900000005", username="invite_atomic_2")
        with self.assertRaises(InviteCodeValidationError) as ctx:
            consume_after_user_created(
                code="ALPHA2026",
                user=second_user,
                identifier=second_user.phone,
                request=self._request(),
                entrypoint="register",
            )

        self.assertEqual(ctx.exception.code, "INVITE_CODE_USAGE_EXHAUSTED")

    def test_expired_invite_rejected(self):
        self.invite.expires_at = timezone.now() - timedelta(minutes=1)
        self.invite.save(update_fields=["expires_at"])
        user = User.objects.create_user(phone="13900000006", username="invite_expired")

        with self.assertRaises(InviteCodeValidationError) as ctx:
            consume_after_user_created(
                code="ALPHA2026",
                user=user,
                identifier=user.phone,
                request=self._request(),
                entrypoint="register",
            )

        self.assertEqual(ctx.exception.code, "INVITE_CODE_EXPIRED")

    def _auth_headers(self, user):
        token, _, _ = _create_auth_session(user, self._request(), remember_me=False)
        return {"HTTP_AUTHORIZATION": f"Bearer {token}"}

    def _authenticated_get(self, user, path="/api/context/organizations"):
        return self.factory.get(path, **self._auth_headers(user))

    def test_invite_gate_blocks_pending_user_core_api(self):
        user = User.objects.create_user(phone="13900000009", username="invite_pending_gate")
        middleware = InviteGateMiddleware(lambda request: HttpResponse("ok"))

        response = middleware(self._authenticated_get(user))

        self.assertEqual(response.status_code, 403)
        self.assertJSONEqual(
            response.content,
            {
                "success": False,
                "message": "请先完成邀请码验证",
                "data": None,
                "code": "INVITE_CODE_REQUIRED",
            },
        )

    def test_invite_gate_allows_redeemed_user_core_api(self):
        user = User.objects.create_user(phone="13900000010", username="invite_redeemed_gate")
        consume_after_user_created(
            code="ALPHA2026",
            user=user,
            identifier=user.phone,
            request=self._request(),
            entrypoint="post_auth_gate",
        )
        middleware = InviteGateMiddleware(lambda request: HttpResponse("ok"))

        response = middleware(self._authenticated_get(user))

        self.assertEqual(response.status_code, 200)

    def test_invite_gate_allows_auth_allowlist_for_pending_user(self):
        user = User.objects.create_user(phone="13900000011", username="invite_allowlist_gate")
        middleware = InviteGateMiddleware(lambda request: HttpResponse("ok"))

        response = middleware(self._authenticated_get(user, "/api/auth/invite-code/redeem"))

        self.assertEqual(response.status_code, 200)

    def test_invite_gate_allows_tabdoc_shared_for_pending_user(self):
        """公开分享页 collab-token / 评论走 /api/tabdoc/shared/，不应被邀请码门禁挡住。"""
        user = User.objects.create_user(phone="13900000014", username="invite_tabdoc_share_gate")
        middleware = InviteGateMiddleware(lambda request: HttpResponse("ok"))

        response = middleware(
            self._authenticated_get(user, "/api/tabdoc/shared/bFw99wHMqatZYMon/collab-token")
        )

        self.assertEqual(response.status_code, 200)

    def test_invite_gate_allows_admin_invite_codes_for_pending_staff(self):
        user = User.objects.create_user(
            phone="13900000012",
            username="invite_pending_staff_invites",
            is_staff=True,
        )
        middleware = InviteGateMiddleware(lambda request: HttpResponse("ok"))

        response = middleware(self._authenticated_get(user, "/api/auth/admin/invite-codes"))

        self.assertEqual(response.status_code, 200)

    def test_invite_gate_still_blocks_other_admin_apis_for_pending_staff(self):
        user = User.objects.create_user(
            phone="13900000013",
            username="invite_pending_staff_admin",
            is_staff=True,
        )
        middleware = InviteGateMiddleware(lambda request: HttpResponse("ok"))

        response = middleware(self._authenticated_get(user, "/api/auth/admin/users"))

        self.assertEqual(response.status_code, 403)
