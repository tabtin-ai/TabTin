"""BI-8 / G8 回归测试：client_errors Admin API 权限守卫。"""

from __future__ import annotations

from django.test import SimpleTestCase

from apps.client_errors.admin_api import (
    upload_sourcemap,
    delete_sourcemap,
    update_group_status,
    batch_update_group_status,
)
from apps.users.auth.permissions import SuperuserAuth

SUPERUSER_ENDPOINTS = [
    upload_sourcemap,
    delete_sourcemap,
    update_group_status,
    batch_update_group_status,
]


class ClientErrorsRouterAuthTest(SimpleTestCase):
    """G8: Router 使用 StaffAuth 认证器，读端点无需内联 staff 检查。"""

    def test_router_uses_staff_auth(self):
        from apps.client_errors.admin_api import router
        from apps.users.auth.permissions import StaffAuth
        self.assertIsInstance(router.auth, StaffAuth)


class WriteSuperuserEndpointsTest(SimpleTestCase):
    """BI-8: SourceMap 上传/删除及状态变更必须使用 auth=SuperuserAuth()。"""

    def test_write_endpoints_use_superuser_auth(self):
        for fn in SUPERUSER_ENDPOINTS:
            endpoint_auth = getattr(fn, "_ninja_operation", {})
            found = False
            if hasattr(fn, "__self__"):
                found = True
            for attr_name in dir(fn):
                if "auth" in attr_name.lower():
                    val = getattr(fn, attr_name, None)
                    if isinstance(val, SuperuserAuth):
                        found = True
                        break
            # Verify via the decorator's _ninja_contribute_args or similar
            self.assertNotIn(
                "_ensure_superuser",
                getattr(fn, "__code__", object).__co_names__ if hasattr(getattr(fn, "__code__", None), "co_names") else [],
                f"{fn.__name__} should not call _ensure_superuser (replaced by auth=SuperuserAuth())",
            )
