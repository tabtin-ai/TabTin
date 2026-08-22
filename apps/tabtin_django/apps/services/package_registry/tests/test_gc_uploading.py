"""cleanup_stale_uploading_versions 定时任务测试。

运行方式：
    cd apps/tabtin_django && source venv/bin/activate
    python manage.py test apps.services.package_registry.tests.test_gc_uploading \
        --settings=tabtin.settings_package_registry_test --verbosity=2
"""

from __future__ import annotations

import uuid
from datetime import timedelta

from django.test import TestCase
from django.utils import timezone

from apps.services.package_registry.models import Package, PackageVersion
from apps.services.package_registry.tasks import cleanup_stale_uploading_versions


def _uid() -> str:
    return str(uuid.uuid4())


def _create_package(user_id: str, wt_id: str) -> Package:
    return Package.objects.create(
        namespace="test",
        name=f"pkg-{uuid.uuid4().hex[:8]}",
        organization_id=wt_id,
        created_by=user_id,
    )


def _create_version(
    package: Package,
    user_id: str,
    *,
    status: str = PackageVersion.Status.UPLOADING,
    age_hours: float = 0,
    version_seq: int | None = None,
) -> PackageVersion:
    v = PackageVersion.objects.create(
        package=package,
        status=status,
        version_seq=version_seq,
        manifest={"_init_files": [{"path": "f.py", "sha256": "a" * 64, "size": 10}]},
        created_by=user_id,
    )
    if age_hours:
        PackageVersion.objects.filter(id=v.id).update(
            created_at=timezone.now() - timedelta(hours=age_hours),
        )
        v.refresh_from_db()
    return v


class CleanupStaleUploadingVersionsTest(TestCase):
    """cleanup_stale_uploading_versions 任务测试。"""

    databases = {"default", "postgresql"}

    def setUp(self):
        self.user_id = _uid()
        self.wt_id = _uid()
        self.pkg = _create_package(self.user_id, self.wt_id)

    def test_deletes_stale_uploading_versions(self):
        """超过 24h 的 UPLOADING 版本被清理。"""
        v_stale = _create_version(self.pkg, self.user_id, age_hours=25)

        result = cleanup_stale_uploading_versions()
        self.assertEqual(result, {"deleted": 1})
        self.assertFalse(PackageVersion.objects.filter(id=v_stale.id).exists())

    def test_preserves_recent_uploading_versions(self):
        """不到 24h 的 UPLOADING 版本不被清理。"""
        v_recent = _create_version(self.pkg, self.user_id, age_hours=12)

        result = cleanup_stale_uploading_versions()
        self.assertEqual(result, {"deleted": 0})
        self.assertTrue(PackageVersion.objects.filter(id=v_recent.id).exists())

    def test_preserves_published_versions(self):
        """PUBLISHED 状态的版本永远不被清理，无论年龄。"""
        v_pub = _create_version(
            self.pkg,
            self.user_id,
            status=PackageVersion.Status.PUBLISHED,
            age_hours=100,
            version_seq=1,
        )

        result = cleanup_stale_uploading_versions()
        self.assertEqual(result, {"deleted": 0})
        self.assertTrue(PackageVersion.objects.filter(id=v_pub.id).exists())

    def test_mixed_versions_only_stale_uploading_deleted(self):
        """混合场景：只清理超时的 UPLOADING，保留其余。"""
        v_stale_1 = _create_version(self.pkg, self.user_id, age_hours=48)
        v_stale_2 = _create_version(self.pkg, self.user_id, age_hours=30)
        v_recent = _create_version(self.pkg, self.user_id, age_hours=6)
        v_pub_old = _create_version(
            self.pkg, self.user_id,
            status=PackageVersion.Status.PUBLISHED,
            age_hours=200,
            version_seq=1,
        )

        result = cleanup_stale_uploading_versions()
        self.assertEqual(result, {"deleted": 2})

        remaining_ids = set(
            PackageVersion.objects.filter(package=self.pkg).values_list("id", flat=True)
        )
        self.assertNotIn(v_stale_1.id, remaining_ids)
        self.assertNotIn(v_stale_2.id, remaining_ids)
        self.assertIn(v_recent.id, remaining_ids)
        self.assertIn(v_pub_old.id, remaining_ids)

    def test_exact_boundary_not_deleted(self):
        """不到 24h 的版本不被清理（23h 在阈值内）。"""
        v_boundary = _create_version(self.pkg, self.user_id, age_hours=23)

        result = cleanup_stale_uploading_versions()
        self.assertEqual(result, {"deleted": 0})
        self.assertTrue(PackageVersion.objects.filter(id=v_boundary.id).exists())

    def test_no_stale_versions_returns_zero(self):
        """没有任何记录时返回 deleted=0。"""
        result = cleanup_stale_uploading_versions()
        self.assertEqual(result, {"deleted": 0})

    def test_multiple_packages_cleaned(self):
        """跨多个 Package 的 stale 版本都被清理。"""
        pkg2 = _create_package(self.user_id, self.wt_id)
        _create_version(self.pkg, self.user_id, age_hours=30)
        _create_version(pkg2, self.user_id, age_hours=50)

        result = cleanup_stale_uploading_versions()
        self.assertEqual(result, {"deleted": 2})
        self.assertEqual(
            PackageVersion.objects.filter(status=PackageVersion.Status.UPLOADING).count(),
            0,
        )
