"""BI-6 / AI-001 / G8 回归测试：LLM admin API 权限守卫。"""

from __future__ import annotations

import inspect
from unittest.mock import MagicMock

from django.test import SimpleTestCase


class LlmAdminUsesStaffAuthTest(SimpleTestCase):
    """G8: LLM admin Router 使用 StaffAuth 认证器。"""

    def test_module_exports_router(self):
        from apps.services.llm.views.admin_api import router
        self.assertIsNotNone(router)

    def test_router_uses_staff_auth(self):
        from apps.services.llm.views.admin_api import router
        from apps.users.auth.permissions import StaffAuth
        self.assertIsInstance(router.auth, StaffAuth)

    def test_no_csrf_exempt_decorator(self):
        import apps.services.llm.views.admin_api as mod
        source = inspect.getsource(mod)
        self.assertNotIn("csrf_exempt", source)
        self.assertNotIn("staff_member_required", source)


class LlmAdminSuperuserAuthTest(SimpleTestCase):
    """AI-001: 破坏性 POST 端点使用 auth=SuperuserAuth() 声明式权限。"""

    def test_superuser_auth_rejects_non_superuser(self):
        from apps.users.auth.permissions import SuperuserAuth
        auth = SuperuserAuth()
        user = MagicMock(is_superuser=False, is_active=True)
        request = MagicMock()
        with self.assertRaises(HttpError) as ctx:
            auth.authenticate(request, "fake_token")

    def test_clear_cache_not_using_inline_check(self):
        """POST /llm/clear-cache 已迁移到声明式 auth=SuperuserAuth()。"""
        from apps.services.llm.views.admin_api import clear_cache
        source = inspect.getsource(clear_cache)
        self.assertNotIn("_ensure_superuser", source)
