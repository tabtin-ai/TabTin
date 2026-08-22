"""W4-修3 验证 — content_types SSoT 端点。

后端把 ``CONTENT_TYPE_MAP`` 抽到 ``utils.py`` 模块级常量,新增 HTTP
``GET /api/services/package-registry/utils/content-types`` 端点返回该
字典 + default 兜底字符串。Go CLI 启动 lazy fetch 一次缓存,fallback
到内置兜底(避免硬故障)。

运行::

    cd apps/tabtin_django && source venv/bin/activate
    DJANGO_SETTINGS_MODULE=tabtin.settings_package_registry_test \\
      python manage.py test \\
      apps.services.package_registry.tests.test_content_types_endpoint \\
      --noinput --verbosity=2
"""

from __future__ import annotations

from django.test import Client, TestCase, override_settings

# 复用 test_http_integration 的 _test_api 与 ROOT_URLCONF —
# 同进程内 router 只能 attach 到一个 NinjaAPI(早注册的优先)。
from apps.services.package_registry.tests import test_http_integration as _http_t

_BASE = _http_t._BASE
_URL_CONF = _http_t._URL_CONF


@override_settings(ROOT_URLCONF=_URL_CONF)
class ContentTypesEndpointTest(TestCase):
    """端点基本结构 + 关键扩展存在。"""

    def setUp(self):
        self.client = Client()

    def test_endpoint_returns_map_and_default(self):
        resp = self.client.get(
            f"{_BASE}/utils/content-types",
        )
        self.assertEqual(resp.status_code, 200, resp.content[:500])
        body = resp.json()

        # success_response envelope: { success, code, message, data }
        self.assertTrue(body.get("success"))
        data = body.get("data", {})
        self.assertIn("map", data)
        self.assertIn("default", data)

        # default 是 application/octet-stream
        self.assertEqual(data["default"], "application/octet-stream")

        # map 是 dict
        self.assertIsInstance(data["map"], dict)
        # 关键扩展必须存在
        for ext, ct in {
            ".py": "text/x-python",
            ".md": "text/markdown",
            ".json": "application/json",
            ".yaml": "text/yaml",
            ".yml": "text/yaml",
            ".png": "image/png",
            ".pdf": "application/pdf",
            ".zip": "application/zip",
        }.items():
            self.assertIn(ext, data["map"])
            self.assertEqual(data["map"][ext], ct)

    def test_endpoint_no_auth_required(self):
        """端点为静态字典,无需 JWT — 直接 GET 不带 token 也应 200。"""
        # Django test Client 默认就不带 JWT,resp 200 即说明无认证。
        resp = self.client.get(
            f"{_BASE}/utils/content-types",
        )
        self.assertEqual(resp.status_code, 200)

    def test_utils_module_constant_consistency(self):
        """SSoT 模块级常量应与端点返回一致。"""
        from apps.services.package_registry.utils import (
            CONTENT_TYPE_DEFAULT, CONTENT_TYPE_MAP,
        )

        resp = self.client.get(
            f"{_BASE}/utils/content-types",
        )
        data = resp.json()["data"]

        self.assertEqual(data["default"], CONTENT_TYPE_DEFAULT)
        self.assertEqual(data["map"], dict(CONTENT_TYPE_MAP))
