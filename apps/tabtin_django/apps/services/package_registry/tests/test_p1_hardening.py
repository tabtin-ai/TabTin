"""P1 巩固项测试：#6 #10 #11 #12 #15 #18。

覆盖范围：
  - #6  Namespace 归属校验（抢注拒绝 + 平台 namespace 豁免 + 首次占用）
  - #10 包大小限制（单文件/总大小/文件数）
  - #11 finalize N+1 批量化（_find_existing_file_records_batch 被调用）
  - #12 fork bulk_create（PackageFile.objects.bulk_create 被调用）
  - #15 init_version 在事务内（transaction.atomic 被调用）
  - #18 fork parent_package_id 传 UUID 不传 str

运行方式：
    cd apps/tabtin_django && source venv/bin/activate
    python manage.py test apps.services.package_registry.tests.test_p1_hardening \
        --settings=tabtin.settings_package_registry_test --verbosity=2
"""

from __future__ import annotations

import uuid
from unittest.mock import MagicMock, patch, call

from django.test import TestCase, TransactionTestCase

from apps.services.package_registry import services
from apps.services.package_registry.models import Package, PackageFile, PackageVersion
from apps.services.package_registry.tests.conftest import (
    apply_all_mocks,
    apply_eventbus_mock,
    apply_oss_mocks,
    apply_permission_mock,
    apply_using_db_mock,
    compute_bundle,
    uid,
)


def _publish_one(test_inst, pkg, path="main.py", content_sha=None, size=100):
    """Helper: publish 一个版本到 pkg。"""
    sha = content_sha or ("a" * 64)
    init = services.init_version(
        package=pkg,
        files=[{"path": path, "sha256": sha, "size": size}],
        manifest={"type": "skill"},
        version_label=None,
        user_id=uid(),
    )
    v = PackageVersion.objects.get(id=init["version_id"])
    bundle = compute_bundle([(path, sha)])
    return services.finalize_version(
        package=pkg, version=v,
        bundle_sha256=bundle,
        init_files=[{"path": path, "sha256": sha, "size": size}],
        user_id=uid(),
    )


# ---------------------------------------------------------------------------
# #6 Namespace 归属校验
# ---------------------------------------------------------------------------

class NamespaceOwnershipTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        apply_all_mocks(self)

    def test_first_occupant_succeeds(self):
        wt = uid()
        pkg = services.create_package(
            namespace="fresh-ns", name="first-pkg",
            organization_id=wt, created_by=uid(),
        )
        self.assertEqual(pkg.namespace, "fresh-ns")

    def test_same_organization_can_create_second_package(self):
        wt = uid()
        services.create_package(
            namespace="shared-ns", name="pkg-a",
            organization_id=wt, created_by=uid(),
        )
        pkg2 = services.create_package(
            namespace="shared-ns", name="pkg-b",
            organization_id=wt, created_by=uid(),
        )
        self.assertEqual(pkg2.namespace, "shared-ns")

    def test_different_organization_rejected(self):
        wt1 = uid()
        wt2 = uid()
        services.create_package(
            namespace="owned-ns", name="pkg-a",
            organization_id=wt1, created_by=uid(),
        )
        with self.assertRaises(PermissionError) as ctx:
            services.create_package(
                namespace="owned-ns", name="pkg-b",
                organization_id=wt2, created_by=uid(),
            )
        self.assertIn("NAMESPACE_CONFLICT", str(ctx.exception))

    def test_platform_namespace_exempt(self):
        for ns in ("platform", "global", "tabtin", "system"):
            wt = uid()
            pkg = services.create_package(
                namespace=ns, name=f"pkg-{uuid.uuid4().hex[:6]}",
                organization_id=wt, created_by=uid(),
            )
            self.assertEqual(pkg.namespace, ns)

    def test_platform_namespace_multiple_organizations(self):
        services.create_package(
            namespace="platform", name="pkg-wt1",
            organization_id=uid(), created_by=uid(),
        )
        pkg2 = services.create_package(
            namespace="platform", name="pkg-wt2",
            organization_id=uid(), created_by=uid(),
        )
        self.assertEqual(pkg2.namespace, "platform")


# ---------------------------------------------------------------------------
# #10 包大小限制
# ---------------------------------------------------------------------------

class PackageSizeLimitTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        apply_all_mocks(self)
        self.pkg = services.create_package(
            namespace="sz", name="test",
            organization_id=uid(), created_by=uid(),
        )

    def test_single_file_too_large(self):
        big_size = 51 * 1024 * 1024  # 51 MB
        with self.assertRaises(ValueError) as ctx:
            services.init_version(
                package=self.pkg,
                files=[{"path": "huge.bin", "sha256": "a" * 64, "size": big_size}],
                manifest={}, version_label=None, user_id=uid(),
            )
        self.assertIn("FILE_TOO_LARGE", str(ctx.exception))

    def test_total_size_exceeded(self):
        files = [
            {"path": f"f{i}.bin", "sha256": f"{i:064x}", "size": 45 * 1024 * 1024}
            for i in range(5)  # 5 * 45MB = 225MB > 200MB
        ]
        with self.assertRaises(ValueError) as ctx:
            services.init_version(
                package=self.pkg, files=files,
                manifest={}, version_label=None, user_id=uid(),
            )
        self.assertIn("TOTAL_SIZE_EXCEEDED", str(ctx.exception))

    def test_file_count_exceeded(self):
        files = [
            {"path": f"f{i}.py", "sha256": f"{i:064x}", "size": 10}
            for i in range(501)
        ]
        with self.assertRaises(ValueError) as ctx:
            services.init_version(
                package=self.pkg, files=files,
                manifest={}, version_label=None, user_id=uid(),
            )
        self.assertIn("FILE_COUNT_EXCEEDED", str(ctx.exception))

    def test_within_limits_succeeds(self):
        files = [
            {"path": f"f{i}.py", "sha256": f"{i:064x}", "size": 1000}
            for i in range(10)
        ]
        result = services.init_version(
            package=self.pkg, files=files,
            manifest={}, version_label=None, user_id=uid(),
        )
        self.assertIn("version_id", result)
        self.assertEqual(len(result["upload_tasks"]), 10)

    def test_exact_single_file_limit(self):
        exact = 50 * 1024 * 1024  # exactly 50 MB
        result = services.init_version(
            package=self.pkg,
            files=[{"path": "exact.bin", "sha256": "b" * 64, "size": exact}],
            manifest={}, version_label=None, user_id=uid(),
        )
        self.assertIn("version_id", result)

    def test_exact_file_count_limit(self):
        files = [
            {"path": f"f{i}.py", "sha256": f"{i:064x}", "size": 10}
            for i in range(500)
        ]
        result = services.init_version(
            package=self.pkg, files=files,
            manifest={}, version_label=None, user_id=uid(),
        )
        self.assertIn("version_id", result)


# ---------------------------------------------------------------------------
# #11 finalize N+1 批量化
# ---------------------------------------------------------------------------

class FinalizeBatchQueryTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        apply_all_mocks(self)
        self.user_id = uid()
        self.pkg = services.create_package(
            namespace="batch", name="test",
            organization_id=uid(), created_by=self.user_id,
        )

    def test_finalize_uses_batch_query(self):
        sha1 = "a" * 64
        sha2 = "b" * 64
        init = services.init_version(
            package=self.pkg,
            files=[
                {"path": "a.py", "sha256": sha1, "size": 10},
                {"path": "b.py", "sha256": sha2, "size": 20},
            ],
            manifest={}, version_label=None, user_id=self.user_id,
        )
        v = PackageVersion.objects.get(id=init["version_id"])
        bundle = compute_bundle([("a.py", sha1), ("b.py", sha2)])

        with patch(
            "apps.services.package_registry.services._find_existing_file_records_batch",
            return_value={},
        ) as mock_batch:
            services.finalize_version(
                package=self.pkg, version=v,
                bundle_sha256=bundle,
                init_files=[
                    {"path": "a.py", "sha256": sha1, "size": 10},
                    {"path": "b.py", "sha256": sha2, "size": 20},
                ],
                user_id=self.user_id,
            )
            mock_batch.assert_called_once_with([sha1, sha2])

    def test_init_uses_batch_query(self):
        with patch(
            "apps.services.package_registry.services._find_existing_file_records_batch",
            return_value={},
        ) as mock_batch:
            services.init_version(
                package=self.pkg,
                files=[
                    {"path": "x.py", "sha256": "c" * 64, "size": 5},
                    {"path": "y.py", "sha256": "d" * 64, "size": 5},
                ],
                manifest={}, version_label=None, user_id=self.user_id,
            )
            mock_batch.assert_called_once_with(["c" * 64, "d" * 64])


# ---------------------------------------------------------------------------
# #12 fork bulk_create
# ---------------------------------------------------------------------------

class ForkBulkCreateTest(TransactionTestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        apply_all_mocks(self)
        self.user_id = uid()
        self.src_wt = uid()
        self.pkg = services.create_package(
            namespace="fbc", name="source",
            organization_id=self.src_wt, created_by=self.user_id,
        )
        _publish_one(self, self.pkg, "a.py", "a" * 64, 10)
        _publish_one(self, self.pkg, "b.py", "b" * 64, 20)

    def test_fork_calls_bulk_create(self):
        with patch.object(
            PackageFile.objects, "bulk_create", wraps=PackageFile.objects.bulk_create,
        ) as mock_bulk:
            result = services.fork_package(
                source_package=self.pkg,
                target_namespace="fbc-target",
                target_name="forked",
                target_organization_id=uid(),
                user_id=self.user_id,
            )
            self.assertEqual(result["copied_versions"], 2)
            self.assertEqual(mock_bulk.call_count, 2)

    def test_fork_files_match_source(self):
        result = services.fork_package(
            source_package=self.pkg,
            target_namespace="fbc-target2",
            target_name="verify",
            target_organization_id=uid(),
            user_id=self.user_id,
        )
        new_pkg = Package.objects.get(id=result["new_package_id"])
        src_paths = set(
            PackageFile.objects.filter(version__package=self.pkg)
            .values_list("path", flat=True)
        )
        new_paths = set(
            PackageFile.objects.filter(version__package=new_pkg)
            .values_list("path", flat=True)
        )
        self.assertEqual(src_paths, new_paths)


# ---------------------------------------------------------------------------
# #15 init_version 在事务内
# ---------------------------------------------------------------------------

class InitVersionTransactionTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        apply_all_mocks(self)
        self.pkg = services.create_package(
            namespace="txn", name="test",
            organization_id=uid(), created_by=uid(),
        )

    def test_init_version_wraps_in_atomic(self):
        with patch(
            "apps.services.package_registry.services.transaction.atomic",
        ) as mock_atomic:
            mock_atomic.return_value.__enter__ = MagicMock()
            mock_atomic.return_value.__exit__ = MagicMock(return_value=False)

            services.init_version(
                package=self.pkg,
                files=[{"path": "t.py", "sha256": "e" * 64, "size": 10}],
                manifest={}, version_label=None, user_id=uid(),
            )
            mock_atomic.assert_called()


# ---------------------------------------------------------------------------
# #18 fork parent_package_id 传 UUID
# ---------------------------------------------------------------------------

class ForkParentPackageIdTypeTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        apply_all_mocks(self)
        self.user_id = uid()
        self.pkg = services.create_package(
            namespace="ppid", name="source",
            organization_id=uid(), created_by=self.user_id,
        )
        _publish_one(self, self.pkg)

    def test_parent_package_id_is_uuid(self):
        result = services.fork_package(
            source_package=self.pkg,
            target_namespace="ppid-tgt",
            target_name="forked",
            target_organization_id=uid(),
            user_id=self.user_id,
        )
        new_pkg = Package.objects.get(id=result["new_package_id"])
        self.assertIsInstance(new_pkg.parent_package_id, uuid.UUID)
        self.assertEqual(new_pkg.parent_package_id, self.pkg.id)

    def test_parent_package_id_not_string(self):
        result = services.fork_package(
            source_package=self.pkg,
            target_namespace="ppid-tgt2",
            target_name="forked2",
            target_organization_id=uid(),
            user_id=self.user_id,
        )
        new_pkg = Package.objects.get(id=result["new_package_id"])
        self.assertNotIsInstance(new_pkg.parent_package_id, str)
