"""onboarding 默认文案回归（当前固定中文）。"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.test import TestCase

from apps.i18n.language import SupportedLanguage, set_user_language, clear_user_language
from apps.tabtinspace.services.onboarding_defaults import (
    DEFAULT_ONBOARDING_SPACE_NAME,
    resolve_onboarding_defaults,
)

User = get_user_model()


class OnboardingDefaultsTests(TestCase):
    databases = {"default", "postgresql"}

    def tearDown(self) -> None:
        clear_user_language()
        super().tearDown()

    def test_chinese_user_gets_chinese_defaults(self) -> None:
        user = User.objects.db_manager("default").create_user(
            username="onboard-zh",
            email="onboard-zh@test.com",
            password="testpass123",
        )
        defaults = resolve_onboarding_defaults(user)
        self.assertEqual(defaults.space_name, DEFAULT_ONBOARDING_SPACE_NAME)
        self.assertEqual(defaults.agent_name, "小Tin")

    def test_english_profile_also_gets_chinese_defaults(self) -> None:
        """默认名暂不跟 UI 语言走英文，避免本机 Default Space 目录。"""
        user = User.objects.db_manager("default").create_user(
            username="onboard-en",
            email="onboard-en@test.com",
            password="testpass123",
        )
        profile = user.profile
        profile.language = "en-US"
        profile.save(update_fields=["language"])

        defaults = resolve_onboarding_defaults(user)
        self.assertEqual(defaults.space_name, DEFAULT_ONBOARDING_SPACE_NAME)
        self.assertEqual(defaults.agent_name, "小Tin")
        self.assertEqual(defaults.space_description, "自动创建的默认 Workspace")

    def test_thread_local_english_still_chinese_defaults(self) -> None:
        user = User.objects.db_manager("default").create_user(
            username="onboard-thread",
            email="onboard-thread@test.com",
            password="testpass123",
        )
        set_user_language(SupportedLanguage.EN_US)
        defaults = resolve_onboarding_defaults(user)
        self.assertEqual(defaults.space_name, DEFAULT_ONBOARDING_SPACE_NAME)
