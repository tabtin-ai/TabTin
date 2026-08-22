"""手机号 +86 / 11 位互认。"""

from types import SimpleNamespace
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.test import RequestFactory, TestCase

from apps.users.auth.api.auth_routes import login_with_verification_code
from apps.users.auth.authentication import MultiFieldAuthBackend
from apps.users.auth.phone import (
    canonicalize_phone,
    maybe_canonicalize_stored_phone,
    phone_lookup_aliases,
    resolve_user_by_phone,
)
from apps.users.auth.validators import validate_unique_phone

User = get_user_model()


class CanonicalizePhoneTests(TestCase):
    def test_cn_national_unchanged(self):
        self.assertEqual(canonicalize_phone("17511610380"), "17511610380")

    def test_plus_86_to_national(self):
        self.assertEqual(canonicalize_phone("+8617511610380"), "17511610380")

    def test_86_prefix_without_plus(self):
        self.assertEqual(canonicalize_phone("8617511610380"), "17511610380")

    def test_strips_spaces_and_dashes(self):
        self.assertEqual(canonicalize_phone("+86 175-1161-0380"), "17511610380")

    def test_aliases_cover_all_forms(self):
        aliases = phone_lookup_aliases("+8617511610380")
        self.assertIn("17511610380", aliases)
        self.assertIn("+8617511610380", aliases)
        self.assertIn("8617511610380", aliases)


def _force_legacy_phone(user, phone: str) -> None:
    """绕过 save()/manager 归一化，模拟历史 +86 脏数据。"""
    User.objects.filter(pk=user.pk).update(phone=phone)
    user.refresh_from_db()


class ResolveUserByPhoneTests(TestCase):
    def test_resolve_plus86_finds_national_user(self):
        user = User.objects.create_user(
            phone="17511610380",
            username="user_0380_a",
            password="ValidPass123!",
        )
        found = resolve_user_by_phone("+8617511610380", active_only=True)
        self.assertEqual(found.id, user.id)

    def test_resolve_national_finds_plus86_user(self):
        user = User.objects.create_user(
            phone="17511610380",
            username="user_0380_b",
            password="ValidPass123!",
        )
        _force_legacy_phone(user, "+8617511610380")
        found = resolve_user_by_phone("17511610380", active_only=True)
        self.assertEqual(found.id, user.id)

    def test_create_user_strips_plus86(self):
        user = User.objects.create_user(
            phone="+8617511610381",
            username="user_strip",
            password="ValidPass123!",
        )
        self.assertEqual(user.phone, "17511610381")

    def test_duplicate_prefers_exact_literal(self):
        national = User.objects.create_user(
            phone="17511610380",
            username="user_national",
            password="ValidPass123!",
        )
        e164 = User.objects.create_user(
            phone="17511610382",
            username="user_e164",
            password="ValidPass123!",
        )
        _force_legacy_phone(e164, "+8617511610380")
        found = resolve_user_by_phone("17511610380", active_only=True)
        self.assertEqual(found.id, national.id)

    def test_validate_unique_blocks_alias(self):
        User.objects.create_user(
            phone="17511610380",
            username="user_taken",
            password="ValidPass123!",
        )
        with self.assertRaises(ValidationError):
            validate_unique_phone("+8617511610380")

    def test_maybe_canonicalize_rewrites_when_safe(self):
        user = User.objects.create_user(
            phone="13900010001",
            username="user_rewrite",
            password="ValidPass123!",
        )
        _force_legacy_phone(user, "+8613900010001")
        self.assertTrue(maybe_canonicalize_stored_phone(user))
        user.refresh_from_db()
        self.assertEqual(user.phone, "13900010001")

    def test_maybe_canonicalize_skips_when_conflict(self):
        User.objects.create_user(
            phone="13900010002",
            username="user_hold",
            password="ValidPass123!",
        )
        user = User.objects.create_user(
            phone="13900010003",
            username="user_conflict",
            password="ValidPass123!",
        )
        _force_legacy_phone(user, "+8613900010002")
        self.assertFalse(maybe_canonicalize_stored_phone(user))
        user.refresh_from_db()
        self.assertEqual(user.phone, "+8613900010002")


class PasswordLoginPhoneAliasTests(TestCase):
    def test_password_login_with_plus86_hits_national_account(self):
        user = User.objects.create_user(
            phone="13900020001",
            username="pwd_user",
            password="ValidPass123!",
        )
        backend = MultiFieldAuthBackend()
        authed = backend.authenticate(
            None,
            username="+8613900020001",
            password="ValidPass123!",
        )
        self.assertIsNotNone(authed)
        self.assertEqual(authed.id, user.id)


class VerificationLoginPhoneAliasTests(TestCase):
    def setUp(self):
        self.factory = RequestFactory()

    def _request(self, path="/api/auth/login/verification-code"):
        request = self.factory.post(path)
        request.META["REMOTE_ADDR"] = "127.0.0.1"
        request.META["HTTP_USER_AGENT"] = "phone-normalize-test"
        return request

    @patch(
        "apps.users.auth.api.auth_routes._create_auth_session",
        return_value=("access", "refresh", 24),
    )
    @patch(
        "apps.users.auth.api.auth_routes._ensure_personal_organization_before_login",
        return_value=True,
    )
    @patch(
        "apps.users.auth.api.auth_routes.VerificationCodeManager.verify_code",
        return_value=True,
    )
    @patch(
        "apps.users.auth.api.auth_routes._check_verify_submit_ip_rate",
        return_value=(True, ""),
    )
    def test_code_login_plus86_does_not_create_second_account(self, *_mocks):
        existing = User.objects.create_user(
            phone="13900030001",
            username="code_user",
            password="ValidPass123!",
        )
        before = User.objects.filter(
            phone__in=phone_lookup_aliases("13900030001")
        ).count()
        self.assertEqual(before, 1)

        payload = SimpleNamespace(
            username="+8613900030001",
            verification_code="123456",
            invite_code=None,
            remember_me=False,
        )
        result = login_with_verification_code(self._request(), payload)
        self.assertIsInstance(result, dict)

        after = User.objects.filter(
            phone__in=phone_lookup_aliases("13900030001")
        ).count()
        self.assertEqual(after, 1)
        existing.refresh_from_db()
        # 无冲突时登录会把库内号收敛为 11 位（本例本就是 11 位）
        self.assertEqual(existing.phone, "13900030001")

    @patch(
        "apps.users.auth.api.auth_routes._create_auth_session",
        return_value=("access", "refresh", 24),
    )
    @patch(
        "apps.users.auth.api.auth_routes._ensure_personal_organization_before_login",
        return_value=True,
    )
    @patch(
        "apps.users.auth.api.auth_routes.VerificationCodeManager.verify_code",
        return_value=True,
    )
    @patch(
        "apps.users.auth.api.auth_routes._check_verify_submit_ip_rate",
        return_value=(True, ""),
    )
    def test_code_login_auto_register_stores_national_form(self, *_mocks):
        payload = SimpleNamespace(
            username="+8613900040001",
            verification_code="123456",
            invite_code=None,
            remember_me=False,
        )
        result = login_with_verification_code(self._request(), payload)
        self.assertIsInstance(result, dict)
        self.assertTrue(User.objects.filter(phone="13900040001").exists())
        self.assertFalse(User.objects.filter(phone="+8613900040001").exists())
