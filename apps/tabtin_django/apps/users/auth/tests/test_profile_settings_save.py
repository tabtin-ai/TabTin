"""#576 防回归单测 · PUT /profile/settings 保存设置不应因 i18n `_` 遮蔽假失败。

根因：`update_user_profile_settings` 内 `profile, _ = get_or_create(...)` 把模块级
i18n 翻译函数 `_` 局部遮蔽成 bool（created 标志），返回时 `_("auth.settings_updated")`
抛 TypeError 被宽泛 except 捕获 → 返回 success=False，但 `profile.save()` 已成功落库，
用户看到「保存失败」假象（实际已改）。

覆盖：
  - 传 language="en-US" 时返回 success is True（不再假失败）
  - 落库 profile.language == "en-US"

跑法：
    python -m pytest apps/users/auth/tests/test_profile_settings_save.py -v
"""
from __future__ import annotations

from django.test import RequestFactory, TestCase

from apps.users.auth.api.profile_routes import update_user_profile_settings
from apps.users.auth.models import User, UserProfile
from apps.users.auth.schemas import UserProfileSettingsSchema


class ProfileSettingsSaveTests(TestCase):
    databases = {"default"}

    def setUp(self):
        self.user = User.objects.create_user(
            email="settings@save.test",
            password="StrongPass123!",
        )
        self.rf = RequestFactory()

    def _put(self, **fields):
        req = self.rf.put("/api/auth/profile/settings")
        req.auth = self.user
        return update_user_profile_settings(req, UserProfileSettingsSchema(**fields))

    def test_language_save_returns_success(self):
        """传 language="en-US" 不应因 `_` 遮蔽假失败。"""
        resp = self._put(language="en-US")
        self.assertTrue(resp.success)

    def test_language_persisted_to_profile(self):
        """语言改动落库到 UserProfile.language。"""
        self._put(language="en-US")
        profile = UserProfile.objects.get(user=self.user)
        self.assertEqual(profile.language, "en-US")

    def test_all_supported_languages_persisted_to_profile(self):
        """全部界面语言偏好均可通过接口校验并落库。"""
        for language in ("zh-TW", "ja-JP", "ko-KR", "de-DE", "fr-FR", "es-ES"):
            with self.subTest(language=language):
                resp = self._put(language=language)
                self.assertTrue(resp.success)
                profile = UserProfile.objects.get(user=self.user)
                self.assertEqual(profile.language, language)
