"""注册 / 建团队时默认 Space onboarding 语言回归。"""
from __future__ import annotations

import uuid

from django.contrib.auth import get_user_model
from django.test import RequestFactory, TestCase

from apps.i18n.language import SupportedLanguage, set_user_language, clear_user_language
from apps.tabtinspace.models import Space, Organization
from apps.users.auth.user_onboarding import (
    create_user_with_personal_onboarding,
    profile_language_from_request,
)

User = get_user_model()


class UserOnboardingLanguageTests(TestCase):
    databases = {"default", "postgresql"}

    def tearDown(self) -> None:
        clear_user_language()
        super().tearDown()

    def test_profile_language_from_accept_language_en(self) -> None:
        request = RequestFactory().post(
            '/api/auth/register',
            HTTP_ACCEPT_LANGUAGE='en-US,en;q=0.9',
        )
        self.assertEqual(profile_language_from_request(request), 'en-US')

    def test_register_flow_creates_chinese_default_space_even_for_en_locale(self) -> None:
        set_user_language(SupportedLanguage.EN_US)
        request = RequestFactory().post(
            '/api/auth/register',
            HTTP_ACCEPT_LANGUAGE='en-US,en;q=0.9',
        )
        user = create_user_with_personal_onboarding(
            request,
            user_data={
                'username': f'reg_en_{uuid.uuid4().hex[:8]}',
                'email': f'reg_en_{uuid.uuid4().hex[:8]}@tabtin.test',
                'password': 'TabtinTest#2026',
            },
        )
        wt = Organization.objects.get(owner_id=user.id, type='personal')
        sp = Space.objects.get(organization=wt, is_default=True)
        self.assertEqual(sp.name, '默认 Workspace')
        self.assertEqual(user.profile.language, 'en-US')

    def test_explicit_profile_language_overrides_request(self) -> None:
        request = RequestFactory().post('/api/auth/register')
        user = create_user_with_personal_onboarding(
            request,
            user_data={
                'username': f'reg_zh_{uuid.uuid4().hex[:8]}',
                'email': f'reg_zh_{uuid.uuid4().hex[:8]}@tabtin.test',
                'password': 'TabtinTest#2026',
            },
            profile_language='zh-CN',
        )
        wt = Organization.objects.get(owner_id=user.id, type='personal')
        sp = Space.objects.get(organization=wt, is_default=True)
        self.assertEqual(sp.name, '默认 Workspace')
