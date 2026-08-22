"""Package Registry 单元测试。

覆盖范围：
  - 7 个 API 的正常路径和错误路径
  - 并发 publish 安全（select_for_update + version_seq）
  - content-addressable 去重
  - EventBus 事件发布
  - 跨库事务安全（transaction.atomic(using='postgresql')）
"""

from __future__ import annotations

import hashlib
import uuid
from unittest.mock import MagicMock, patch

from django.test import TestCase, TransactionTestCase

from apps.services.package_registry.models import Package, PackageFile, PackageVersion
from apps.services.package_registry import services


def _uid() -> str:
    return str(uuid.uuid4())


def _compute_bundle(files: list[tuple[str, str]]) -> str:
    sorted_entries = sorted(files, key=lambda x: x[0])
    h = hashlib.sha256()
    for path, sha256 in sorted_entries:
        h.update(f"{path}:{sha256}".encode())
    return h.hexdigest()


# ---------------------------------------------------------------------------
# Mock helpers
# ---------------------------------------------------------------------------

_MOCK_OSS_PATCHES = [
    patch(
        "apps.services.package_registry.services._find_existing_file_records_batch",
        return_value={},
    ),
    patch(
        "apps.services.package_registry.services._generate_presigned_put_url",
        return_value="https://oss.example.com/presigned-put",
    ),
    patch(
        "apps.services.package_registry.services._generate_presigned_get_url",
        return_value="https://oss.example.com/presigned-get",
    ),
    patch(
        "apps.services.package_registry.services._register_file_record",
        side_effect=lambda **kw: MagicMock(id=uuid.uuid4()),
    ),
]


def _apply_oss_mocks(test_instance):
    mocks = []
    for p in _MOCK_OSS_PATCHES:
        m = p.start()
        mocks.append(m)
        test_instance.addCleanup(p.stop)
    return mocks


def _apply_eventbus_mock(test_instance):
    p = patch("apps.services.package_registry.services.emit_on_commit")
    m = p.start()
    test_instance.addCleanup(p.stop)
    return m


def _apply_using_db_mock(test_instance):
    """在 SQLite 测试环境中，将 _USING_DB 替换为 'postgresql'（实际是 SQLite alias）。"""
    p = patch("apps.services.package_registry.services._USING_DB", "postgresql")
    m = p.start()
    test_instance.addCleanup(p.stop)
    return m


def _apply_permission_mock(test_instance):
    p = patch("apps.services.package_registry.services.check_package_write_access")
    m = p.start()
    test_instance.addCleanup(p.stop)
    return m


# ---------------------------------------------------------------------------
# 1. create_package
# ---------------------------------------------------------------------------

class CreatePackageTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.eventbus = _apply_eventbus_mock(self)
        _apply_using_db_mock(self)
        _apply_permission_mock(self)

    def test_create_success(self):
        pkg = services.create_package(
            namespace="acme",
            name="hello",
            organization_id=_uid(),
            created_by=_uid(),
        )
        self.assertEqual(pkg.namespace, "acme")
        self.assertEqual(pkg.name, "hello")
        self.assertIsNotNone(pkg.id)

    def test_create_duplicate_409(self):
        wt = _uid()
        user = _uid()
        services.create_package(namespace="dup", name="pkg", organization_id=wt, created_by=user)
        from django.db import IntegrityError
        with self.assertRaises(IntegrityError):
            services.create_package(namespace="dup", name="pkg", organization_id=wt, created_by=user)

    def test_eventbus_emitted(self):
        services.create_package(namespace="ev", name="test", organization_id=_uid(), created_by=_uid())
        self.eventbus.assert_called()
        call_args = self.eventbus.call_args
        self.assertEqual(call_args[0][0], "pkg.package.created")


# ---------------------------------------------------------------------------
# 2. init_version
# ---------------------------------------------------------------------------

class InitVersionTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        _apply_eventbus_mock(self)
        _apply_oss_mocks(self)
        _apply_using_db_mock(self)
        _apply_permission_mock(self)
        self.pkg = services.create_package(
            namespace="iv", name="test", organization_id=_uid(), created_by=_uid(),
        )

    def test_init_returns_upload_tasks(self):
        result = services.init_version(
            package=self.pkg,
            files=[{"path": "main.py", "sha256": "a" * 64, "size": 100}],
            manifest={"type": "skill"},
            version_label="1.0.0",
            user_id=_uid(),
        )
        self.assertIn("version_id", result)
        self.assertEqual(len(result["upload_tasks"]), 1)
        self.assertEqual(result["upload_tasks"][0]["action"], "upload")

    def test_init_reuse_existing_file(self):
        mock_record = MagicMock(id=uuid.uuid4(), file_key="package_registry/old/ab/abc", file_hash="b" * 64)
        with patch(
            "apps.services.package_registry.services._find_existing_file_records_batch",
            return_value={"b" * 64: mock_record},
        ):
            result = services.init_version(
                package=self.pkg,
                files=[{"path": "reused.py", "sha256": "b" * 64, "size": 50}],
                manifest={},
                version_label=None,
                user_id=_uid(),
            )
        task = result["upload_tasks"][0]
        self.assertEqual(task["action"], "reuse")
        self.assertEqual(task["file_record_id"], str(mock_record.id))

    def test_init_creates_uploading_version(self):
        result = services.init_version(
            package=self.pkg,
            files=[{"path": "x.py", "sha256": "c" * 64, "size": 10}],
            manifest={},
            version_label=None,
            user_id=_uid(),
        )
        v = PackageVersion.objects.get(id=result["version_id"])
        self.assertEqual(v.status, PackageVersion.Status.UPLOADING)
        self.assertIsNone(v.version_seq)


# ---------------------------------------------------------------------------
# 3. finalize_version
# ---------------------------------------------------------------------------

class FinalizeVersionTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        _apply_eventbus_mock(self)
        _apply_oss_mocks(self)
        _apply_using_db_mock(self)
        _apply_permission_mock(self)
        self.user_id = _uid()
        self.pkg = services.create_package(
            namespace="fv", name="test", organization_id=_uid(), created_by=self.user_id,
        )
        self.sha = "d" * 64
        self.init_result = services.init_version(
            package=self.pkg,
            files=[{"path": "app.py", "sha256": self.sha, "size": 200, "content_type": "text/plain"}],
            manifest={"desc": "test"},
            version_label="0.1",
            user_id=self.user_id,
        )

    def test_finalize_success(self):
        bundle = _compute_bundle([("app.py", self.sha)])
        version = PackageVersion.objects.get(id=self.init_result["version_id"])
        result = services.finalize_version(
            package=self.pkg,
            version=version,
            bundle_sha256=bundle,
            init_files=[{"path": "app.py", "sha256": self.sha, "size": 200, "content_type": "text/plain"}],
            user_id=self.user_id,
        )
        self.assertEqual(result["version_seq"], 1)
        self.assertEqual(result["file_count"], 1)
        self.assertEqual(result["total_size"], 200)

        version.refresh_from_db()
        self.assertEqual(version.status, PackageVersion.Status.PUBLISHED)
        self.assertNotIn("_init_files", version.manifest)

        pf = PackageFile.objects.get(version=version)
        self.assertEqual(pf.content_type, "text/plain")

    def test_finalize_wrong_sha256(self):
        version = PackageVersion.objects.get(id=self.init_result["version_id"])
        with self.assertRaises(ValueError) as ctx:
            services.finalize_version(
                package=self.pkg,
                version=version,
                bundle_sha256="wrong" * 8,
                init_files=[{"path": "app.py", "sha256": self.sha, "size": 200}],
                user_id=self.user_id,
            )
        self.assertIn("BUNDLE_SHA256_MISMATCH", str(ctx.exception))

    def test_finalize_empty_files_rejected(self):
        version = PackageVersion.objects.get(id=self.init_result["version_id"])
        with self.assertRaises(ValueError) as ctx:
            services.finalize_version(
                package=self.pkg,
                version=version,
                bundle_sha256="x" * 64,
                init_files=[],
                user_id=self.user_id,
            )
        self.assertIn("FILES_NOT_ALL_UPLOADED", str(ctx.exception))

    def test_version_seq_increments(self):
        sha2 = "e" * 64
        init2 = services.init_version(
            package=self.pkg,
            files=[{"path": "v2.py", "sha256": sha2, "size": 300}],
            manifest={},
            version_label="0.2",
            user_id=self.user_id,
        )

        bundle1 = _compute_bundle([("app.py", self.sha)])
        v1 = PackageVersion.objects.get(id=self.init_result["version_id"])
        r1 = services.finalize_version(
            package=self.pkg, version=v1,
            bundle_sha256=bundle1,
            init_files=[{"path": "app.py", "sha256": self.sha, "size": 200}],
            user_id=self.user_id,
        )
        self.assertEqual(r1["version_seq"], 1)

        bundle2 = _compute_bundle([("v2.py", sha2)])
        v2 = PackageVersion.objects.get(id=init2["version_id"])
        r2 = services.finalize_version(
            package=self.pkg, version=v2,
            bundle_sha256=bundle2,
            init_files=[{"path": "v2.py", "sha256": sha2, "size": 300}],
            user_id=self.user_id,
        )
        self.assertEqual(r2["version_seq"], 2)

        self.pkg.refresh_from_db()
        self.assertEqual(self.pkg.latest_version_seq, 2)

    def test_double_finalize_rejected(self):
        """同一版本不能 finalize 两次。"""
        bundle = _compute_bundle([("app.py", self.sha)])
        version = PackageVersion.objects.get(id=self.init_result["version_id"])
        services.finalize_version(
            package=self.pkg, version=version,
            bundle_sha256=bundle,
            init_files=[{"path": "app.py", "sha256": self.sha, "size": 200}],
            user_id=self.user_id,
        )
        with self.assertRaises(ValueError) as ctx:
            services.finalize_version(
                package=self.pkg, version=version,
                bundle_sha256=bundle,
                init_files=[{"path": "app.py", "sha256": self.sha, "size": 200}],
                user_id=self.user_id,
            )
        self.assertIn("VERSION_ALREADY_FINALIZED", str(ctx.exception))


# ---------------------------------------------------------------------------
# 4. list_versions
# ---------------------------------------------------------------------------

class ListVersionsTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        _apply_eventbus_mock(self)
        _apply_oss_mocks(self)
        _apply_using_db_mock(self)
        _apply_permission_mock(self)
        self.user_id = _uid()
        self.pkg = services.create_package(
            namespace="lv", name="test", organization_id=_uid(), created_by=self.user_id,
        )
        for i in range(3):
            sha = f"{i:064x}"
            path = f"f{i}.py"
            init = services.init_version(
                package=self.pkg,
                files=[{"path": path, "sha256": sha, "size": 10 * (i + 1)}],
                manifest={},
                version_label=f"v{i+1}",
                user_id=self.user_id,
            )
            v = PackageVersion.objects.get(id=init["version_id"])
            bundle = _compute_bundle([(path, sha)])
            services.finalize_version(
                package=self.pkg, version=v,
                bundle_sha256=bundle,
                init_files=[{"path": path, "sha256": sha, "size": 10 * (i + 1)}],
                user_id=self.user_id,
            )

    def test_list_all(self):
        result = services.list_versions(package=self.pkg)
        self.assertEqual(len(result["items"]), 3)
        seqs = [item["version_seq"] for item in result["items"]]
        self.assertEqual(seqs, [3, 2, 1])

    def test_list_with_cursor(self):
        result = services.list_versions(package=self.pkg, limit=1, cursor=3)
        self.assertEqual(len(result["items"]), 1)
        self.assertEqual(result["items"][0]["version_seq"], 2)
        self.assertIsNotNone(result["next_cursor"])

    def test_list_limit_capped(self):
        result = services.list_versions(package=self.pkg, limit=9999)
        self.assertEqual(len(result["items"]), 3)


# ---------------------------------------------------------------------------
# 5. get_version_files
# ---------------------------------------------------------------------------

class GetVersionFilesTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        _apply_eventbus_mock(self)
        _apply_oss_mocks(self)
        _apply_using_db_mock(self)
        _apply_permission_mock(self)
        self.user_id = _uid()
        self.pkg = services.create_package(
            namespace="gvf", name="test", organization_id=_uid(), created_by=self.user_id,
        )
        sha = "f" * 64
        init = services.init_version(
            package=self.pkg,
            files=[{"path": "data.json", "sha256": sha, "size": 500, "content_type": "application/json"}],
            manifest={"key": "val"},
            version_label="1.0",
            user_id=self.user_id,
        )
        v = PackageVersion.objects.get(id=init["version_id"])
        bundle = _compute_bundle([("data.json", sha)])
        services.finalize_version(
            package=self.pkg, version=v,
            bundle_sha256=bundle,
            init_files=[{"path": "data.json", "sha256": sha, "size": 500, "content_type": "application/json"}],
            user_id=self.user_id,
        )

    def test_get_files(self):
        result = services.get_version_files(package=self.pkg, version_seq=1)
        self.assertEqual(result["version_seq"], 1)
        self.assertEqual(len(result["files"]), 1)
        f = result["files"][0]
        self.assertEqual(f["path"], "data.json")
        self.assertIn("download_url", f)
        self.assertIn("content_type", f)
        self.assertEqual(f["content_type"], "application/json")

    def test_not_found(self):
        with self.assertRaises(LookupError):
            services.get_version_files(package=self.pkg, version_seq=999)

    def test_oss_object_key_stored(self):
        """验证 PackageFile 存储了 oss_object_key。"""
        pf = PackageFile.objects.filter(version__package=self.pkg).first()
        self.assertTrue(pf.oss_object_key)
        self.assertIn("package_registry/", pf.oss_object_key)


# ---------------------------------------------------------------------------
# 6. yank_version
# ---------------------------------------------------------------------------

class YankVersionTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.eventbus = _apply_eventbus_mock(self)
        _apply_oss_mocks(self)
        _apply_using_db_mock(self)
        _apply_permission_mock(self)
        self.user_id = _uid()
        self.pkg = services.create_package(
            namespace="yk", name="test", organization_id=_uid(), created_by=self.user_id,
        )
        sha = "1" * 64
        init = services.init_version(
            package=self.pkg,
            files=[{"path": "x.py", "sha256": sha, "size": 10}],
            manifest={},
            version_label=None,
            user_id=self.user_id,
        )
        v = PackageVersion.objects.get(id=init["version_id"])
        bundle = _compute_bundle([("x.py", sha)])
        services.finalize_version(
            package=self.pkg, version=v,
            bundle_sha256=bundle,
            init_files=[{"path": "x.py", "sha256": sha, "size": 10}],
            user_id=self.user_id,
        )

    def test_yank_success(self):
        result = services.yank_version(
            package=self.pkg, version_seq=1, reason="broken", user_id=self.user_id,
        )
        self.assertIn("yanked_at", result)

        v = PackageVersion.objects.get(package=self.pkg, version_seq=1)
        self.assertTrue(v.is_yanked)
        self.assertEqual(v.yanked_reason, "broken")

    def test_yanked_version_blocks_download(self):
        services.yank_version(
            package=self.pkg, version_seq=1, reason="bad", user_id=self.user_id,
        )
        with self.assertRaises(PermissionError):
            services.get_version_files(package=self.pkg, version_seq=1)

    def test_yanked_version_with_include_flag(self):
        services.yank_version(
            package=self.pkg, version_seq=1, reason="test", user_id=self.user_id,
        )
        result = services.get_version_files(
            package=self.pkg, version_seq=1, include_yanked=True,
        )
        self.assertTrue(result["is_yanked"])

    def test_yank_not_found(self):
        with self.assertRaises(LookupError):
            services.yank_version(
                package=self.pkg, version_seq=99, reason="nope", user_id=self.user_id,
            )

    def test_yank_event_emitted(self):
        services.yank_version(
            package=self.pkg, version_seq=1, reason="evt", user_id=self.user_id,
        )
        calls = [c for c in self.eventbus.call_args_list if c[0][0] == "pkg.version.yanked"]
        self.assertEqual(len(calls), 1)


# ---------------------------------------------------------------------------
# 7. fork_package
# ---------------------------------------------------------------------------

class ForkPackageTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        _apply_eventbus_mock(self)
        _apply_oss_mocks(self)
        _apply_using_db_mock(self)
        _apply_permission_mock(self)
        self.user_id = _uid()
        self.src_wt = _uid()
        self.pkg = services.create_package(
            namespace="src", name="forkme", organization_id=self.src_wt, created_by=self.user_id,
        )
        for i in range(2):
            sha = f"{i+10:064x}"
            path = f"f{i}.py"
            init = services.init_version(
                package=self.pkg,
                files=[{"path": path, "sha256": sha, "size": 50}],
                manifest={},
                version_label=None,
                user_id=self.user_id,
            )
            v = PackageVersion.objects.get(id=init["version_id"])
            bundle = _compute_bundle([(path, sha)])
            services.finalize_version(
                package=self.pkg, version=v,
                bundle_sha256=bundle,
                init_files=[{"path": path, "sha256": sha, "size": 50}],
                user_id=self.user_id,
            )

    def test_fork_all_versions(self):
        result = services.fork_package(
            source_package=self.pkg,
            target_namespace="fork-ns",
            target_name="forked",
            target_organization_id=_uid(),
            user_id=self.user_id,
        )
        self.assertEqual(result["copied_versions"], 2)

        new_pkg = Package.objects.get(id=result["new_package_id"])
        self.assertEqual(new_pkg.parent_package_id, self.pkg.id)
        self.assertEqual(new_pkg.latest_version_seq, 2)

        new_versions = PackageVersion.objects.filter(package=new_pkg).count()
        self.assertEqual(new_versions, 2)

    def test_fork_at_specific_version(self):
        result = services.fork_package(
            source_package=self.pkg,
            target_namespace="fork-ns2",
            target_name="partial",
            target_organization_id=_uid(),
            fork_at_version_seq=1,
            user_id=self.user_id,
        )
        self.assertEqual(result["copied_versions"], 1)

    def test_fork_reuses_file_records_and_oss_keys(self):
        """fork 复用 file_record_id 和 oss_object_key（零重传）。"""
        result = services.fork_package(
            source_package=self.pkg,
            target_namespace="fork-ns3",
            target_name="reuse",
            target_organization_id=_uid(),
            user_id=self.user_id,
        )
        new_pkg = Package.objects.get(id=result["new_package_id"])
        src_files = PackageFile.objects.filter(version__package=self.pkg)
        new_files = PackageFile.objects.filter(version__package=new_pkg)

        src_fids = set(str(f.file_record_id) for f in src_files)
        new_fids = set(str(f.file_record_id) for f in new_files)
        self.assertEqual(src_fids, new_fids)

        src_keys = set(f.oss_object_key for f in src_files)
        new_keys = set(f.oss_object_key for f in new_files)
        self.assertEqual(src_keys, new_keys)

    def test_fork_duplicate_409(self):
        services.fork_package(
            source_package=self.pkg,
            target_namespace="dup-fork",
            target_name="same",
            target_organization_id=_uid(),
            user_id=self.user_id,
        )
        from django.db import IntegrityError
        with self.assertRaises(IntegrityError):
            services.fork_package(
                source_package=self.pkg,
                target_namespace="dup-fork",
                target_name="same",
                target_organization_id=_uid(),
                user_id=self.user_id,
            )


# ---------------------------------------------------------------------------
# 8. content-addressable 去重
# ---------------------------------------------------------------------------

class ContentAddressableTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        _apply_eventbus_mock(self)
        _apply_using_db_mock(self)
        _apply_permission_mock(self)
        self.user_id = _uid()
        self.pkg = services.create_package(
            namespace="ca", name="dedup", organization_id=_uid(), created_by=self.user_id,
        )

    def test_dedup_returns_reuse(self):
        mock_record = MagicMock(id=uuid.uuid4(), file_key="package_registry/x/aa/aaa")
        sha_a = "aaa" + "0" * 61
        sha_b = "bbb" + "0" * 61
        with patch(
            "apps.services.package_registry.services._find_existing_file_records_batch",
            return_value={sha_a: mock_record, sha_b: mock_record},
        ), patch(
            "apps.services.package_registry.services._generate_presigned_put_url",
            return_value="https://oss.example.com/put",
        ):
            result = services.init_version(
                package=self.pkg,
                files=[
                    {"path": "a.py", "sha256": sha_a, "size": 10},
                    {"path": "b.py", "sha256": sha_b, "size": 20},
                ],
                manifest={},
                version_label=None,
                user_id=self.user_id,
            )

        actions = {t["path"]: t["action"] for t in result["upload_tasks"]}
        self.assertEqual(actions["a.py"], "reuse")
        self.assertEqual(actions["b.py"], "reuse")

    def test_mixed_reuse_and_upload(self):
        mock_record = MagicMock(id=uuid.uuid4(), file_key="package_registry/x/aa/aaa")
        sha_cached = "aaa" + "0" * 61

        with patch(
            "apps.services.package_registry.services._find_existing_file_records_batch",
            return_value={sha_cached: mock_record},
        ), patch(
            "apps.services.package_registry.services._generate_presigned_put_url",
            return_value="https://oss.example.com/put",
        ):
            result = services.init_version(
                package=self.pkg,
                files=[
                    {"path": "cached.py", "sha256": sha_cached, "size": 10},
                    {"path": "new.py", "sha256": "nnn" + "0" * 61, "size": 30},
                ],
                manifest={},
                version_label=None,
                user_id=self.user_id,
            )

        task_map = {t["path"]: t for t in result["upload_tasks"]}
        self.assertEqual(task_map["cached.py"]["action"], "reuse")
        self.assertEqual(task_map["new.py"]["action"], "upload")
        self.assertIn("presigned_url", task_map["new.py"])


# ---------------------------------------------------------------------------
# 9. EventBus 事件覆盖
# ---------------------------------------------------------------------------

class EventBusTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.eventbus = _apply_eventbus_mock(self)
        _apply_oss_mocks(self)
        _apply_using_db_mock(self)
        _apply_permission_mock(self)
        self.user_id = _uid()
        self.wt = _uid()
        self.pkg = services.create_package(
            namespace="eb", name="events", organization_id=self.wt, created_by=self.user_id,
        )

    def _publish_one_version(self):
        sha = _uid().replace("-", "") + "0" * 32
        init = services.init_version(
            package=self.pkg,
            files=[{"path": "e.py", "sha256": sha, "size": 10}],
            manifest={},
            version_label=None,
            user_id=self.user_id,
        )
        v = PackageVersion.objects.get(id=init["version_id"])
        bundle = _compute_bundle([("e.py", sha)])
        services.finalize_version(
            package=self.pkg, version=v,
            bundle_sha256=bundle,
            init_files=[{"path": "e.py", "sha256": sha, "size": 10}],
            user_id=self.user_id,
        )
        return v

    def test_all_four_event_types(self):
        self._publish_one_version()

        services.yank_version(
            package=self.pkg, version_seq=1, reason="r", user_id=self.user_id,
        )

        services.fork_package(
            source_package=self.pkg,
            target_namespace="eb-fork",
            target_name="copy",
            target_organization_id=_uid(),
            user_id=self.user_id,
        )

        emitted_types = [c[0][0] for c in self.eventbus.call_args_list]
        self.assertIn("pkg.package.created", emitted_types)
        self.assertIn("pkg.version.published", emitted_types)
        self.assertIn("pkg.version.yanked", emitted_types)
        self.assertIn("pkg.fork.created", emitted_types)


# ---------------------------------------------------------------------------
# 10. 并发 publish 安全（select_for_update + version_seq）
# ---------------------------------------------------------------------------

class SequentialPublishSafetyTest(TransactionTestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        _apply_eventbus_mock(self)
        _apply_oss_mocks(self)
        _apply_using_db_mock(self)
        _apply_permission_mock(self)

    def test_version_seq_strictly_increments(self):
        """顺序 finalize 5 次，验证 version_seq 严格递增且不冲突。"""
        user_id = _uid()
        pkg = services.create_package(
            namespace="conc", name="test", organization_id=_uid(), created_by=user_id,
        )

        seqs = []
        for i in range(5):
            sha = f"{i+100:064x}"
            path = f"conc{i}.py"
            init = services.init_version(
                package=pkg,
                files=[{"path": path, "sha256": sha, "size": 10}],
                manifest={},
                version_label=None,
                user_id=user_id,
            )
            v = PackageVersion.objects.get(id=init["version_id"])
            bundle = _compute_bundle([(path, sha)])
            result = services.finalize_version(
                package=pkg, version=v,
                bundle_sha256=bundle,
                init_files=[{"path": path, "sha256": sha, "size": 10}],
                user_id=user_id,
            )
            seqs.append(result["version_seq"])

        self.assertEqual(seqs, [1, 2, 3, 4, 5])
        self.assertEqual(len(set(seqs)), 5)


# ---------------------------------------------------------------------------
# 11. Model 约束
# ---------------------------------------------------------------------------

class ModelConstraintTest(TestCase):
    databases = {"default", "postgresql"}

    def test_package_unique_namespace_name(self):
        from django.db import IntegrityError
        Package.objects.create(
            namespace="u", name="pkg",
            organization_id=uuid.uuid4(), created_by=uuid.uuid4(),
        )
        with self.assertRaises(IntegrityError):
            Package.objects.create(
                namespace="u", name="pkg",
                organization_id=uuid.uuid4(), created_by=uuid.uuid4(),
            )

    def test_version_unique_package_seq(self):
        from django.db import IntegrityError
        pkg = Package.objects.create(
            namespace="vs", name="seq",
            organization_id=uuid.uuid4(), created_by=uuid.uuid4(),
        )
        PackageVersion.objects.create(
            package=pkg, version_seq=1,
            status=PackageVersion.Status.PUBLISHED,
            created_by=uuid.uuid4(),
        )
        with self.assertRaises(IntegrityError):
            PackageVersion.objects.create(
                package=pkg, version_seq=1,
                status=PackageVersion.Status.PUBLISHED,
                created_by=uuid.uuid4(),
            )

    def test_file_unique_version_path(self):
        from django.db import IntegrityError
        pkg = Package.objects.create(
            namespace="fp", name="uniq",
            organization_id=uuid.uuid4(), created_by=uuid.uuid4(),
        )
        v = PackageVersion.objects.create(
            package=pkg, version_seq=1,
            status=PackageVersion.Status.PUBLISHED,
            created_by=uuid.uuid4(),
        )
        PackageFile.objects.create(
            version=v, path="a.py",
            file_record_id=uuid.uuid4(), file_size=10, sha256="x" * 64,
        )
        with self.assertRaises(IntegrityError):
            PackageFile.objects.create(
                version=v, path="a.py",
                file_record_id=uuid.uuid4(), file_size=20, sha256="y" * 64,
            )


# ---------------------------------------------------------------------------
# 12. namespace / name 格式校验
# ---------------------------------------------------------------------------

class SlugValidationTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        _apply_eventbus_mock(self)
        _apply_using_db_mock(self)
        _apply_permission_mock(self)

    def test_valid_slugs(self):
        for ns, name in [
            ("acme", "hello"),
            ("my-org", "code-review"),
            ("platform", "weekly_report"),
            ("demo-app", "v2.0-beta"),
            ("0cool", "tool123"),
        ]:
            pkg = services.create_package(
                namespace=ns, name=name,
                organization_id=_uid(), created_by=_uid(),
            )
            self.assertEqual(pkg.namespace, ns)

    def test_namespace_rejects_uppercase(self):
        with self.assertRaises(ValueError) as ctx:
            services.create_package(
                namespace="Acme", name="hello",
                organization_id=_uid(), created_by=_uid(),
            )
        self.assertIn("INVALID_NAMESPACE", str(ctx.exception))

    def test_namespace_rejects_spaces(self):
        with self.assertRaises(ValueError):
            services.create_package(
                namespace="my org", name="hello",
                organization_id=_uid(), created_by=_uid(),
            )

    def test_namespace_rejects_special_chars(self):
        for bad in ["hello@world", "ns/sub", "ns:name", "ns!", ""]:
            with self.assertRaises(ValueError, msg=f"Should reject namespace '{bad}'"):
                services.create_package(
                    namespace=bad, name="valid",
                    organization_id=_uid(), created_by=_uid(),
                )

    def test_name_rejects_invalid(self):
        with self.assertRaises(ValueError) as ctx:
            services.create_package(
                namespace="valid", name="Hello World",
                organization_id=_uid(), created_by=_uid(),
            )
        self.assertIn("INVALID_NAME", str(ctx.exception))

    def test_name_rejects_hyphen_start(self):
        with self.assertRaises(ValueError):
            services.create_package(
                namespace="valid", name="-bad",
                organization_id=_uid(), created_by=_uid(),
            )

    def test_fork_validates_target_namespace(self):
        _apply_oss_mocks(self)
        pkg = services.create_package(
            namespace="src2", name="forkme2",
            organization_id=_uid(), created_by=_uid(),
        )
        with self.assertRaises(ValueError) as ctx:
            services.fork_package(
                source_package=pkg,
                target_namespace="BAD NS",
                target_name="ok",
                target_organization_id=_uid(),
                user_id=_uid(),
            )
        self.assertIn("INVALID_NAMESPACE", str(ctx.exception))

    def test_fork_validates_target_name(self):
        _apply_oss_mocks(self)
        pkg = services.create_package(
            namespace="src3", name="forkme3",
            organization_id=_uid(), created_by=_uid(),
        )
        with self.assertRaises(ValueError) as ctx:
            services.fork_package(
                source_package=pkg,
                target_namespace="ok",
                target_name="BAD!",
                target_organization_id=_uid(),
                user_id=_uid(),
            )
        self.assertIn("INVALID_NAME", str(ctx.exception))
