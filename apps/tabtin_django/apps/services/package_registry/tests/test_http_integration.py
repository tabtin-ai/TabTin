"""Package Registry HTTP 集成测试。

通过 Django test Client 测试 API 层的 HTTP 行为：
- 请求/响应格式正确（匹配 Ninja response Schema）
- HTTP 状态码（200/400/403/404/409/410）
- JWT 认证（mock）
- 参数校验错误返回 422（Ninja 默认）

使用独立的 NinjaAPI 实例 + mock JWTAuth.authenticate 绕过真实 JWT 校验。

运行方式：
    cd apps/tabtin_django && source venv/bin/activate
    python manage.py test apps.services.package_registry.tests.test_http_integration \
        --settings=tabtin.settings_package_registry_test --verbosity=2
"""

from __future__ import annotations

import json
import uuid
from unittest.mock import patch, MagicMock

from django.test import TestCase, Client, override_settings
from django.urls import path
from ninja import NinjaAPI

from apps.services.package_registry.api import router as package_registry_router
from apps.services.package_registry.models import Package, PackageVersion
from apps.services.package_registry.tests.conftest import (
    apply_all_mocks,
    compute_bundle,
    uid,
)
from apps.users.auth.permissions import JWTAuth

_test_api = NinjaAPI(title="PkgRegistryTestAPI", urls_namespace="pkg_registry_http_test", auth=JWTAuth())
_test_api.add_router("/services/package-registry", package_registry_router)
urlpatterns = [path("api/", _test_api.urls)]

_BASE = "/api/services/package-registry"

_fake_user_id = uuid.uuid4()


def _make_fake_user():
    user = MagicMock()
    user.id = _fake_user_id
    user.is_authenticated = True
    user.pk = _fake_user_id
    return user


_fake_user = _make_fake_user()


def _auth_patcher():
    return patch(
        "apps.users.auth.permissions.JWTAuth.authenticate",
        return_value=_fake_user,
    )


_AUTH = {"HTTP_AUTHORIZATION": "Bearer fake-test-token"}


def _post_json(client, url, data):
    return client.post(url, data=json.dumps(data), content_type="application/json", **_AUTH)


def _get(client, url):
    return client.get(url, **_AUTH)


_URL_CONF = "apps.services.package_registry.tests.test_http_integration"


# ---------------------------------------------------------------------------
# Helper: publish a version via service layer
# ---------------------------------------------------------------------------

def _publish_version(pkg, sha, file_path, user_id):
    from apps.services.package_registry import services

    init = services.init_version(
        package=pkg,
        files=[{"path": file_path, "sha256": sha, "size": 100}],
        manifest={}, version_label=None, user_id=user_id,
    )
    v = PackageVersion.objects.get(id=init["version_id"])
    bundle = compute_bundle([(file_path, sha)])
    services.finalize_version(
        package=pkg, version=v,
        bundle_sha256=bundle,
        init_files=[{"path": file_path, "sha256": sha, "size": 100}],
        user_id=user_id,
    )
    return v


# ===================================================================
# 1. create_package
# ===================================================================

@override_settings(ROOT_URLCONF=_URL_CONF)
class CreatePackageHTTPTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.client = Client()
        apply_all_mocks(self)

    def test_create_200(self):
        with _auth_patcher():
            resp = _post_json(self.client, f"{_BASE}/packages", {
                "namespace": "test-ns",
                "name": "test-pkg",
                "organization_id": uid(),
            })
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertTrue(body["success"])
        self.assertEqual(body["code"], "SUCCESS")
        self.assertIn("package_id", body["data"])
        self.assertEqual(body["data"]["namespace"], "test-ns")
        self.assertEqual(body["data"]["name"], "test-pkg")

    def test_create_duplicate_409(self):
        wt = uid()
        with _auth_patcher():
            _post_json(self.client, f"{_BASE}/packages", {
                "namespace": "dup-ns", "name": "dup-pkg", "organization_id": wt,
            })
            resp = _post_json(self.client, f"{_BASE}/packages", {
                "namespace": "dup-ns", "name": "dup-pkg", "organization_id": wt,
            })
        self.assertEqual(resp.status_code, 409)
        body = resp.json()
        self.assertFalse(body["success"])
        self.assertEqual(body["code"], "PACKAGE_ALREADY_EXISTS")

    def test_create_invalid_slug_400(self):
        with _auth_patcher():
            resp = _post_json(self.client, f"{_BASE}/packages", {
                "namespace": "BAD SLUG",
                "name": "ok",
                "organization_id": uid(),
            })
        self.assertEqual(resp.status_code, 400)
        body = resp.json()
        self.assertFalse(body["success"])

    def test_create_missing_required_field_422(self):
        with _auth_patcher():
            resp = _post_json(self.client, f"{_BASE}/packages", {"namespace": "ok"})
        self.assertEqual(resp.status_code, 422)

    def test_no_auth_401(self):
        with patch(
            "apps.users.auth.permissions.JWTAuth.authenticate",
            return_value=None,
        ):
            resp = _post_json(self.client, f"{_BASE}/packages", {
                "namespace": "ns", "name": "pkg", "organization_id": uid(),
            })
        self.assertEqual(resp.status_code, 401)


# ===================================================================
# 2. lookup_package
# ===================================================================

@override_settings(ROOT_URLCONF=_URL_CONF)
class LookupPackageHTTPTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.client = Client()
        apply_all_mocks(self)

    def test_lookup_200(self):
        from apps.services.package_registry import services
        pkg = services.create_package(
            namespace="lu-http", name="found",
            organization_id=uid(), created_by=str(_fake_user_id),
        )
        with _auth_patcher():
            resp = _get(self.client, f"{_BASE}/packages/lookup?namespace=lu-http&name=found")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertTrue(body["success"])
        self.assertEqual(body["data"]["package_id"], str(pkg.id))
        self.assertEqual(body["data"]["namespace"], "lu-http")
        self.assertIn("created_at", body["data"])
        self.assertIn("latest_version_seq", body["data"])

    def test_lookup_404(self):
        with _auth_patcher():
            resp = _get(self.client, f"{_BASE}/packages/lookup?namespace=no&name=pkg")
        self.assertEqual(resp.status_code, 404)
        body = resp.json()
        self.assertFalse(body["success"])
        self.assertEqual(body["code"], "NOT_FOUND")


# ===================================================================
# 3. init_version
# ===================================================================

@override_settings(ROOT_URLCONF=_URL_CONF)
class InitVersionHTTPTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.client = Client()
        apply_all_mocks(self)
        from apps.services.package_registry import services
        self.pkg = services.create_package(
            namespace="iv-http", name="test",
            organization_id=uid(), created_by=str(_fake_user_id),
        )

    def test_init_200(self):
        with _auth_patcher():
            resp = _post_json(
                self.client,
                f"{_BASE}/packages/{self.pkg.id}/versions/init",
                {
                    "files": [{"path": "main.py", "sha256": "a" * 64, "size": 100}],
                    "manifest": {"type": "skill"},
                    "version_label": "1.0",
                },
            )
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertTrue(body["success"])
        self.assertIn("version_id", body["data"])
        self.assertEqual(len(body["data"]["upload_tasks"]), 1)
        task = body["data"]["upload_tasks"][0]
        self.assertEqual(task["path"], "main.py")
        self.assertIn("action", task)

    def test_init_empty_files_400(self):
        with _auth_patcher():
            resp = _post_json(
                self.client,
                f"{_BASE}/packages/{self.pkg.id}/versions/init",
                {"files": []},
            )
        self.assertEqual(resp.status_code, 400)
        body = resp.json()
        self.assertFalse(body["success"])

    def test_init_package_not_found_404(self):
        fake_id = uuid.uuid4()
        with _auth_patcher():
            resp = _post_json(
                self.client,
                f"{_BASE}/packages/{fake_id}/versions/init",
                {"files": [{"path": "x.py", "sha256": "b" * 64, "size": 10}]},
            )
        self.assertEqual(resp.status_code, 404)


# ===================================================================
# 4. finalize_version
# ===================================================================

@override_settings(ROOT_URLCONF=_URL_CONF)
class FinalizeVersionHTTPTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.client = Client()
        apply_all_mocks(self)
        from apps.services.package_registry import services
        self.user_id = str(_fake_user_id)
        self.pkg = services.create_package(
            namespace="fin-http", name="test",
            organization_id=uid(), created_by=self.user_id,
        )
        self.sha = "c" * 64
        self.init_result = services.init_version(
            package=self.pkg,
            files=[{"path": "app.py", "sha256": self.sha, "size": 200}],
            manifest={"type": "skill"}, version_label="1.0",
            user_id=self.user_id,
        )
        self.version = PackageVersion.objects.get(id=self.init_result["version_id"])
        self.bundle = compute_bundle([("app.py", self.sha)])

    def test_finalize_200(self):
        with _auth_patcher():
            resp = _post_json(
                self.client,
                f"{_BASE}/packages/{self.pkg.id}/versions/{self.version.id}/finalize",
                {"bundle_sha256": self.bundle},
            )
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertTrue(body["success"])
        self.assertEqual(body["data"]["version_seq"], 1)
        self.assertEqual(body["data"]["file_count"], 1)
        self.assertEqual(body["data"]["total_size"], 200)
        self.assertEqual(body["data"]["bundle_sha256"], self.bundle)

    def test_finalize_wrong_sha_409(self):
        with _auth_patcher():
            resp = _post_json(
                self.client,
                f"{_BASE}/packages/{self.pkg.id}/versions/{self.version.id}/finalize",
                {"bundle_sha256": "wrong" * 16},
            )
        self.assertEqual(resp.status_code, 409)
        body = resp.json()
        self.assertFalse(body["success"])
        self.assertEqual(body["code"], "FINALIZE_FAILED")

    def test_finalize_package_not_found_404(self):
        fake_pkg = uuid.uuid4()
        with _auth_patcher():
            resp = _post_json(
                self.client,
                f"{_BASE}/packages/{fake_pkg}/versions/{self.version.id}/finalize",
                {"bundle_sha256": self.bundle},
            )
        self.assertEqual(resp.status_code, 404)

    def test_finalize_version_not_found_404(self):
        fake_ver = uuid.uuid4()
        with _auth_patcher():
            resp = _post_json(
                self.client,
                f"{_BASE}/packages/{self.pkg.id}/versions/{fake_ver}/finalize",
                {"bundle_sha256": self.bundle},
            )
        self.assertEqual(resp.status_code, 404)


# ===================================================================
# 5. list_versions
# ===================================================================

@override_settings(ROOT_URLCONF=_URL_CONF)
class ListVersionsHTTPTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.client = Client()
        apply_all_mocks(self)
        from apps.services.package_registry import services
        self.user_id = str(_fake_user_id)
        self.pkg = services.create_package(
            namespace="lv-http", name="test",
            organization_id=uid(), created_by=self.user_id,
        )
        for i in range(2):
            sha = f"{i:064x}"
            _publish_version(self.pkg, sha, f"f{i}.py", self.user_id)

    def test_list_200(self):
        with _auth_patcher():
            resp = _get(self.client, f"{_BASE}/packages/{self.pkg.id}/versions")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertTrue(body["success"])
        self.assertEqual(len(body["data"]["items"]), 2)
        seqs = [item["version_seq"] for item in body["data"]["items"]]
        self.assertEqual(seqs, [2, 1])

    def test_list_with_limit(self):
        with _auth_patcher():
            resp = _get(self.client, f"{_BASE}/packages/{self.pkg.id}/versions?limit=1")
        body = resp.json()
        self.assertEqual(len(body["data"]["items"]), 1)
        self.assertIsNotNone(body["data"]["next_cursor"])

    def test_list_package_not_found_404(self):
        fake_id = uuid.uuid4()
        with _auth_patcher():
            resp = _get(self.client, f"{_BASE}/packages/{fake_id}/versions")
        self.assertEqual(resp.status_code, 404)


# ===================================================================
# 6. get_version_files
# ===================================================================

@override_settings(ROOT_URLCONF=_URL_CONF)
class GetVersionFilesHTTPTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.client = Client()
        apply_all_mocks(self)
        from apps.services.package_registry import services
        self.user_id = str(_fake_user_id)
        self.pkg = services.create_package(
            namespace="gvf-http", name="test",
            organization_id=uid(), created_by=self.user_id,
        )
        sha = "d" * 64
        init = services.init_version(
            package=self.pkg,
            files=[{"path": "data.json", "sha256": sha, "size": 500, "content_type": "application/json"}],
            manifest={"key": "val"}, version_label="1.0", user_id=self.user_id,
        )
        v = PackageVersion.objects.get(id=init["version_id"])
        bundle = compute_bundle([("data.json", sha)])
        services.finalize_version(
            package=self.pkg, version=v,
            bundle_sha256=bundle,
            init_files=[{"path": "data.json", "sha256": sha, "size": 500, "content_type": "application/json"}],
            user_id=self.user_id,
        )

    def test_get_files_200(self):
        with _auth_patcher():
            resp = _get(self.client, f"{_BASE}/packages/{self.pkg.id}/versions/1/files")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertTrue(body["success"])
        self.assertEqual(body["data"]["version_seq"], 1)
        self.assertEqual(len(body["data"]["files"]), 1)
        f = body["data"]["files"][0]
        self.assertEqual(f["path"], "data.json")
        self.assertIn("download_url", f)
        self.assertEqual(f["content_type"], "application/json")
        self.assertIn("manifest", body["data"])

    def test_version_not_found_404(self):
        with _auth_patcher():
            resp = _get(self.client, f"{_BASE}/packages/{self.pkg.id}/versions/999/files")
        self.assertEqual(resp.status_code, 404)

    def test_yanked_version_410(self):
        from apps.services.package_registry import services
        services.yank_version(
            package=self.pkg, version_seq=1, reason="broken",
            user_id=self.user_id,
        )
        with _auth_patcher():
            resp = _get(self.client, f"{_BASE}/packages/{self.pkg.id}/versions/1/files")
        self.assertEqual(resp.status_code, 410)
        body = resp.json()
        self.assertFalse(body["success"])
        self.assertEqual(body["code"], "VERSION_YANKED")

    def test_yanked_with_include_flag_200(self):
        from apps.services.package_registry import services
        services.yank_version(
            package=self.pkg, version_seq=1, reason="broken",
            user_id=self.user_id,
        )
        with _auth_patcher():
            resp = _get(
                self.client,
                f"{_BASE}/packages/{self.pkg.id}/versions/1/files?include_yanked=1",
            )
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertTrue(body["data"]["is_yanked"])


# ===================================================================
# 7. yank_version
# ===================================================================

@override_settings(ROOT_URLCONF=_URL_CONF)
class YankVersionHTTPTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.client = Client()
        apply_all_mocks(self)
        from apps.services.package_registry import services
        self.user_id = str(_fake_user_id)
        self.pkg = services.create_package(
            namespace="yk-http", name="test",
            organization_id=uid(), created_by=self.user_id,
        )
        _publish_version(self.pkg, "e" * 64, "x.py", self.user_id)

    def test_yank_200(self):
        with _auth_patcher():
            resp = _post_json(
                self.client,
                f"{_BASE}/packages/{self.pkg.id}/versions/1/yank",
                {"reason": "broken"},
            )
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertTrue(body["success"])
        self.assertIn("yanked_at", body["data"])

    def test_yank_not_found_404(self):
        with _auth_patcher():
            resp = _post_json(
                self.client,
                f"{_BASE}/packages/{self.pkg.id}/versions/99/yank",
                {"reason": "nope"},
            )
        self.assertEqual(resp.status_code, 404)

    def test_yank_package_not_found_404(self):
        fake_id = uuid.uuid4()
        with _auth_patcher():
            resp = _post_json(
                self.client,
                f"{_BASE}/packages/{fake_id}/versions/1/yank",
                {"reason": "nope"},
            )
        self.assertEqual(resp.status_code, 404)


# ===================================================================
# 8. fork_package
# ===================================================================

@override_settings(ROOT_URLCONF=_URL_CONF)
class ForkPackageHTTPTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.client = Client()
        apply_all_mocks(self)
        from apps.services.package_registry import services
        self.user_id = str(_fake_user_id)
        self.pkg = services.create_package(
            namespace="fk-http", name="src",
            organization_id=uid(), created_by=self.user_id,
        )
        _publish_version(self.pkg, "f" * 64, "main.py", self.user_id)

    def test_fork_200(self):
        with _auth_patcher():
            resp = _post_json(self.client, f"{_BASE}/packages/{self.pkg.id}/fork", {
                "target_namespace": "fork-dst",
                "target_name": "copy",
                "target_organization_id": uid(),
            })
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertTrue(body["success"])
        self.assertIn("new_package_id", body["data"])
        self.assertEqual(body["data"]["copied_versions"], 1)

    def test_fork_duplicate_409(self):
        with _auth_patcher():
            _post_json(self.client, f"{_BASE}/packages/{self.pkg.id}/fork", {
                "target_namespace": "dup-fk",
                "target_name": "same",
                "target_organization_id": uid(),
            })
            resp = _post_json(self.client, f"{_BASE}/packages/{self.pkg.id}/fork", {
                "target_namespace": "dup-fk",
                "target_name": "same",
                "target_organization_id": uid(),
            })
        self.assertEqual(resp.status_code, 409)
        body = resp.json()
        self.assertFalse(body["success"])
        self.assertEqual(body["code"], "PACKAGE_ALREADY_EXISTS")

    def test_fork_source_not_found_404(self):
        fake_id = uuid.uuid4()
        with _auth_patcher():
            resp = _post_json(self.client, f"{_BASE}/packages/{fake_id}/fork", {
                "target_namespace": "fork-ns",
                "target_name": "pkg",
                "target_organization_id": uid(),
            })
        self.assertEqual(resp.status_code, 404)

    def test_fork_invalid_target_namespace_400(self):
        with _auth_patcher():
            resp = _post_json(self.client, f"{_BASE}/packages/{self.pkg.id}/fork", {
                "target_namespace": "BAD NS",
                "target_name": "ok",
                "target_organization_id": uid(),
            })
        self.assertEqual(resp.status_code, 400)


# ===================================================================
# 9. 响应信封格式一致性
# ===================================================================

@override_settings(ROOT_URLCONF=_URL_CONF)
class ResponseEnvelopeHTTPTest(TestCase):
    """验证所有成功/错误响应共享统一的信封格式。"""
    databases = {"default", "postgresql"}

    def setUp(self):
        self.client = Client()
        apply_all_mocks(self)

    def test_success_envelope(self):
        with _auth_patcher():
            resp = _post_json(self.client, f"{_BASE}/packages", {
                "namespace": "env-ns", "name": "env-pkg", "organization_id": uid(),
            })
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        for key in ("success", "code", "message", "data"):
            self.assertIn(key, body, f"Missing envelope key: {key}")
        self.assertTrue(body["success"])
        self.assertEqual(body["code"], "SUCCESS")

    def test_error_envelope(self):
        with _auth_patcher():
            resp = _get(self.client, f"{_BASE}/packages/lookup?namespace=nonexist&name=pkg")
        self.assertEqual(resp.status_code, 404)
        body = resp.json()
        for key in ("success", "code", "message"):
            self.assertIn(key, body, f"Missing envelope key: {key}")
        self.assertFalse(body["success"])
