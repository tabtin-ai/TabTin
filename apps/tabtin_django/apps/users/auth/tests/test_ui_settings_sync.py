"""设置 IA Phase 2 单测 · UserProfile.ui_settings 跨设备同步 API（照抄 approval 范本）。

覆盖：
  - GET/PUT /profile/ui-settings 往返
  - per-namespace last-write-wins（新覆盖旧 / 旧不覆盖新 / updatedAt 相等保留旧 /
    缺 updatedAt 用服务端 now_ms 兜底）
  - namespace 白名单拒非法 + envelope 外壳校验（缺 value / updatedAt 非数字 / 非 dict）
  - 空 settings 拒；批内一条非法整批拒（不落库）
  - 写成功后 WS 广播 ``ui_settings_changed``（payload 带 {settings}）
  - theme 收口：ui_settings.theme 优先、回退旧 theme 列、auto→system 兼容映射

跑法（root conftest 的 _ISOLATED_SETTINGS_HINTS 已登记 → 自动切 isolated settings）：
    python -m pytest apps/users/auth/tests/test_ui_settings_sync.py -v
"""
from __future__ import annotations

import time
from unittest.mock import patch

from django.test import RequestFactory, TestCase

from apps.users.auth.api.profile_routes import (
    get_ui_settings,
    update_ui_settings,
    get_user_profile_settings,
)
from apps.users.auth.models import User, UserProfile
from apps.users.auth.schemas import UISettingsUpdateSchema

_PUBLISH_PATH = "apps.services.common.ws.bus.publish_to_user"


class UISettingsSyncTests(TestCase):
    databases = {"default"}

    def setUp(self):
        self.user = User.objects.create_user(
            email="ui@prefs.test",
            password="StrongPass123!",
        )
        self.rf = RequestFactory()

    # ── helpers ────────────────────────────────────────────────────

    def _put(self, settings: dict):
        """调用 PUT 路由函数，返回 (ApiResponseSchema, publish_to_user mock)。"""
        req = self.rf.put("/api/auth/profile/ui-settings")
        req.auth = self.user
        with patch(_PUBLISH_PATH) as mock_pub:
            resp = update_ui_settings(req, UISettingsUpdateSchema(settings=settings))
        return resp, mock_pub

    def _get_settings(self) -> dict:
        """调用 GET 路由函数，返回 data.settings。"""
        req = self.rf.get("/api/auth/profile/ui-settings")
        req.auth = self.user
        return get_ui_settings(req)["data"]["settings"]

    def _get_profile_settings(self) -> dict:
        """调用 GET /profile/settings，返回 data（含收口后的 theme）。"""
        req = self.rf.get("/api/auth/profile/settings")
        req.auth = self.user
        return get_user_profile_settings(req)["data"]

    def _set_legacy_theme(self, value: str):
        profile, _ = UserProfile.objects.get_or_create(user=self.user)
        profile.theme = value
        profile.save(update_fields=["theme"])

    # ── 1. GET/PUT 往返 ────────────────────────────────────────────

    def test_get_empty_for_new_user(self):
        self.assertEqual(self._get_settings(), {})

    def test_put_then_get_round_trip(self):
        resp, mock_pub = self._put({
            "theme": {"value": "dark", "updatedAt": 1000},
            "fontSize": {"value": 16, "updatedAt": 1000},
        })
        self.assertTrue(resp.success)
        self.assertTrue(mock_pub.called)

        settings = self._get_settings()
        self.assertEqual(settings["theme"], {"value": "dark", "updatedAt": 1000})
        self.assertEqual(settings["fontSize"], {"value": 16, "updatedAt": 1000})

    def test_partial_update_does_not_clobber_other_namespaces(self):
        self._put({"theme": {"value": "dark", "updatedAt": 1000}})
        # 增量只传 fontSize，theme 应保留
        self._put({"fontSize": {"value": 18, "updatedAt": 1000}})
        settings = self._get_settings()
        self.assertEqual(settings["theme"]["value"], "dark")
        self.assertEqual(settings["fontSize"]["value"], 18)

    def test_value_accepts_arbitrary_json(self):
        """后端是通用承载——value 允许任意 JSON（dict / list / null）。"""
        self._put({
            "notificationPrefs": {"value": {"email": True, "muted": ["x"]}, "updatedAt": 1},
            "resourceOpenPrefs": {"value": None, "updatedAt": 1},
        })
        settings = self._get_settings()
        self.assertEqual(settings["notificationPrefs"]["value"], {"email": True, "muted": ["x"]})
        self.assertIsNone(settings["resourceOpenPrefs"]["value"])

    # ── 2. per-namespace last-write-wins ───────────────────────────

    def test_lww_newer_overrides_older(self):
        self._put({"theme": {"value": "light", "updatedAt": 1000}})
        self._put({"theme": {"value": "dark", "updatedAt": 2000}})
        settings = self._get_settings()
        self.assertEqual(settings["theme"]["value"], "dark")
        self.assertEqual(settings["theme"]["updatedAt"], 2000)

    def test_lww_older_does_not_override_newer(self):
        self._put({"theme": {"value": "dark", "updatedAt": 2000}})
        self._put({"theme": {"value": "light", "updatedAt": 1000}})  # 更旧
        settings = self._get_settings()
        self.assertEqual(settings["theme"]["value"], "dark")  # 未被覆盖
        self.assertEqual(settings["theme"]["updatedAt"], 2000)

    def test_lww_equal_updatedat_keeps_existing(self):
        self._put({"theme": {"value": "dark", "updatedAt": 2000}})
        self._put({"theme": {"value": "light", "updatedAt": 2000}})  # 相等 → 跳过
        self.assertEqual(self._get_settings()["theme"]["value"], "dark")

    def test_missing_updatedat_uses_server_now(self):
        before = int(time.time() * 1000)
        resp, _mock = self._put({"fontSize": {"value": 14}})
        after = int(time.time() * 1000)
        self.assertTrue(resp.success)
        entry = self._get_settings()["fontSize"]
        self.assertEqual(entry["value"], 14)
        self.assertIn("updatedAt", entry)
        self.assertGreaterEqual(entry["updatedAt"], before)
        self.assertLessEqual(entry["updatedAt"], after)

    # ── 3. 校验：白名单 + envelope 外壳 ─────────────────────────────

    def test_invalid_namespace_rejected(self):
        resp, mock_pub = self._put({"evilNamespace": {"value": 1, "updatedAt": 1}})
        self.assertFalse(resp.success)
        self.assertEqual(resp.code, "VALIDATION_ERROR")
        self.assertFalse(mock_pub.called)
        self.assertEqual(self._get_settings(), {})  # 未落库

    def test_all_whitelisted_namespaces_accepted(self):
        whitelist = {
            "theme": {"value": "dark", "updatedAt": 1},
            "fontSize": {"value": 16, "updatedAt": 1},
            "colorScheme": {"value": "blue", "updatedAt": 1},
            "notificationPrefs": {"value": {"email": False}, "updatedAt": 1},
            "mobilePushPrefs": {
                "value": {
                    "approval": True,
                    "taskCompleted": True,
                    "messages": True,
                    "mentions": True,
                },
                "updatedAt": 1,
            },
            "voiceHotwords": {"value": ["hi"], "updatedAt": 1},
            "resourceOpenPrefs": {"value": {"mode": "tab"}, "updatedAt": 1},
        }
        resp, _mock = self._put(whitelist)
        self.assertTrue(resp.success)
        self.assertEqual(set(self._get_settings().keys()), set(whitelist.keys()))

    def test_envelope_without_value_rejected(self):
        resp, _mock = self._put({"theme": {"updatedAt": 1}})
        self.assertFalse(resp.success)
        self.assertEqual(resp.code, "VALIDATION_ERROR")

    def test_envelope_non_numeric_updatedat_rejected(self):
        resp, _mock = self._put({"theme": {"value": "dark", "updatedAt": "soon"}})
        self.assertFalse(resp.success)
        self.assertEqual(resp.code, "VALIDATION_ERROR")

    def test_envelope_not_dict_rejected(self):
        resp, _mock = self._put({"theme": "dark"})
        self.assertFalse(resp.success)
        self.assertEqual(resp.code, "VALIDATION_ERROR")

    def test_empty_settings_rejected(self):
        resp, mock_pub = self._put({})
        self.assertFalse(resp.success)
        self.assertEqual(resp.code, "VALIDATION_ERROR")
        self.assertFalse(mock_pub.called)

    def test_partial_invalid_rejects_whole_batch(self):
        resp, _mock = self._put({
            "theme": {"value": "dark", "updatedAt": 1},
            "bogus": {"value": 1, "updatedAt": 1},
        })
        self.assertFalse(resp.success)
        self.assertEqual(resp.code, "VALIDATION_ERROR")
        self.assertEqual(self._get_settings(), {})  # theme 也不落库（整批原子拒）

    # ── 4. WS 广播 ─────────────────────────────────────────────────

    def test_ws_broadcast_on_success(self):
        resp, mock_pub = self._put({"theme": {"value": "dark", "updatedAt": 1000}})
        self.assertTrue(resp.success)
        self.assertTrue(mock_pub.called)
        args, _kwargs = mock_pub.call_args
        user_id_arg, envelope = args[0], args[1]
        self.assertEqual(user_id_arg, str(self.user.id))
        self.assertEqual(envelope.get("type"), "ui_settings_changed")
        self.assertEqual(
            envelope["payload"]["data"]["settings"]["theme"]["value"], "dark",
        )

    # ── 5. theme 收口 ──────────────────────────────────────────────

    def test_theme_fallback_to_legacy_default(self):
        """全新用户：无 ui_settings.theme → 回退旧列默认 'light'。"""
        self.assertEqual(self._get_profile_settings()["theme"], "light")

    def test_theme_fallback_to_legacy_column(self):
        self._set_legacy_theme("dark")
        self.assertEqual(self._get_profile_settings()["theme"], "dark")

    def test_theme_legacy_auto_maps_to_system(self):
        self._set_legacy_theme("auto")
        self.assertEqual(self._get_profile_settings()["theme"], "system")

    def test_theme_prefers_ui_settings_over_legacy(self):
        """ui_settings.theme 是新 SSoT：即便旧列是 auto（本会映射 system），也以 ui 为准。"""
        self._set_legacy_theme("auto")
        self._put({"theme": {"value": "dark", "updatedAt": 1000}})
        self.assertEqual(self._get_profile_settings()["theme"], "dark")

    def test_theme_ui_settings_system_value(self):
        self._put({"theme": {"value": "system", "updatedAt": 1000}})
        self.assertEqual(self._get_profile_settings()["theme"], "system")
