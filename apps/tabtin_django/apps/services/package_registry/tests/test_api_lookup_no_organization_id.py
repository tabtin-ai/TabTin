"""C4 验证 — lookup API 响应不再泄露 organization_id。

防止跨团队探测:任何认证用户调 GET /packages/lookup 不应能拿到归属团队 id。
service 层 lookup_package 返回完整 ORM 对象不变(后端内部仍需用 organization_id 做权限/路由),
HTTP 端点严格只暴露 namespace/name/版本元信息。

运行方式::

    cd apps/tabtin_django && source venv/bin/activate
    python manage.py test \\
        apps.services.package_registry.tests.test_api_lookup_no_organization_id \\
        --settings=tabtin.settings_package_registry_test --verbosity=2
"""

from __future__ import annotations

import json
import uuid
from unittest.mock import MagicMock, patch

from django.test import Client, TestCase, override_settings

from apps.services.package_registry import services
from apps.services.package_registry.tests.conftest import apply_all_mocks

# 复用 test_http_integration 的 NinjaAPI 实例:
# Ninja Router 同一对象只能 attached 到一个 NinjaAPI,
# 重复 attach 会触发 "Router has already been attached" 异常。
from apps.services.package_registry.tests import test_http_integration as _http_t


_BASE = _http_t._BASE
_URL_CONF = _http_t._URL_CONF

_auth_patcher = _http_t._auth_patcher
_get = _http_t._get


def _uid() -> str:
    return str(uuid.uuid4())


# ---------------------------------------------------------------------------
# 测试
# ---------------------------------------------------------------------------

@override_settings(ROOT_URLCONF=_URL_CONF)
class LookupNoOrganizationIdLeakTest(TestCase):
    """确保 GET /packages/lookup 不泄露 organization_id。"""

    databases = {"default", "postgresql"}

    def setUp(self):
        self.client = Client()
        apply_all_mocks(self)

    def test_lookup_response_does_not_contain_organization_id(self):
        """成功响应中 data 不含 organization_id key,任何深度都没有。"""
        owner_wt = _uid()
        services.create_package(
            namespace="c4-leak", name="probe-pkg",
            organization_id=owner_wt, created_by=_uid(),
        )

        with _auth_patcher():
            resp = _get(
                self.client,
                f"{_BASE}/packages/lookup?namespace=c4-leak&name=probe-pkg",
            )

        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertTrue(body["success"])

        # data 顶层不应有 organization_id
        self.assertNotIn("organization_id", body["data"])
        # 全文不应出现该 organization 的 id 字符串(防止意外混入其它字段)
        self.assertNotIn(owner_wt, json.dumps(body))

    def test_lookup_response_keeps_required_fields(self):
        """删字段不应误伤其它字段:package_id / namespace / name /
        latest_version_seq / created_at 仍存在。
        """
        services.create_package(
            namespace="c4-keep", name="keep-pkg",
            organization_id=_uid(), created_by=_uid(),
        )

        with _auth_patcher():
            resp = _get(
                self.client,
                f"{_BASE}/packages/lookup?namespace=c4-keep&name=keep-pkg",
            )

        self.assertEqual(resp.status_code, 200)
        data = resp.json()["data"]
        for field in (
            "package_id", "namespace", "name",
            "latest_version_seq", "created_at",
        ):
            self.assertIn(field, data, f"lookup 响应丢失关键字段 {field}")

    def test_lookup_404_response_also_clean(self):
        """404 路径同样不应泄露任何团队信息。"""
        with _auth_patcher():
            resp = _get(
                self.client,
                f"{_BASE}/packages/lookup?namespace=c4-no&name=missing-pkg",
            )
        self.assertEqual(resp.status_code, 404)
        body = resp.json()
        self.assertNotIn("organization_id", json.dumps(body))

    def test_lookup_cross_organization_user_cannot_probe_owner(self):
        """跨团队用户调 lookup 同样不能从响应反推 owner organization:
        只要响应里完全没 organization_id key 就算通过。
        """
        owner_wt = _uid()
        services.create_package(
            namespace="c4-cross", name="cross-pkg",
            organization_id=owner_wt, created_by=_uid(),
        )

        # 模拟另一个 organization 的用户
        other_user = MagicMock()
        other_user.id = uuid.uuid4()
        other_user.is_authenticated = True
        other_user.pk = other_user.id

        with patch(
            "apps.users.auth.permissions.JWTAuth.authenticate",
            return_value=other_user,
        ):
            resp = _get(
                self.client,
                f"{_BASE}/packages/lookup?namespace=c4-cross&name=cross-pkg",
            )
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertNotIn("organization_id", body["data"])
        self.assertNotIn(owner_wt, json.dumps(body))


class LookupSchemaSourceCheckTest(TestCase):
    """直接对 schema 类做静态检查 — 防止有人改回去。"""

    def test_lookup_schema_class_has_no_organization_field(self):
        from apps.services.package_registry.api import LookupPackageData

        fields = set(LookupPackageData.__fields__.keys())
        self.assertNotIn(
            "organization_id", fields,
            "LookupPackageData 不应含 organization_id;C4 要求严格隐藏归属团队",
        )
