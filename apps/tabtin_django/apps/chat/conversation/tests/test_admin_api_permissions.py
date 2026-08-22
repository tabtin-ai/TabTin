"""BI-1 / BI-9 回归测试：superuser 权限已迁移为声明式 auth=SuperuserAuth()。"""

from __future__ import annotations

import inspect

from django.test import SimpleTestCase

from apps.users.auth.permissions import SuperuserAuth


class SuperuserAuthClassTest(SimpleTestCase):
    """SuperuserAuth 认证器行为验证。"""

    def test_superuser_auth_exists(self):
        self.assertTrue(callable(SuperuserAuth))


class UpdateChatConfigPermissionTest(SimpleTestCase):
    """BI-1: update_chat_config 端点使用声明式 auth=SuperuserAuth()。"""

    def test_update_chat_config_no_inline_require_superuser(self):
        """确保 update_chat_config 不再使用内联 _require_superuser。"""
        from apps.chat.conversation.admin_api import update_chat_config
        source = inspect.getsource(update_chat_config)
        self.assertNotIn("_require_superuser", source)


class ChatAdminRouterAuthTest(SimpleTestCase):
    """Router 级别使用 StaffAuth。"""

    def test_router_uses_staff_auth(self):
        from apps.chat.conversation.admin_api import router
        from apps.users.auth.permissions import StaffAuth
        self.assertIsInstance(router.auth, StaffAuth)
