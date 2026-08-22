"""Package Registry 权限校验测试。

覆盖范围：
  - check_package_write_access 函数本身
  - 写操作的权限校验集成（含 finalize / yank / revert / fork）
  - 读操作不受影响
  - 角色层级（owner > admin > editor > viewer）

运行方式：
    cd apps/tabtin_django && source venv/bin/activate
    python manage.py test apps.services.package_registry.tests.test_permissions \
        --settings=tabtin.settings_package_registry_test --verbosity=2
"""

from __future__ import annotations

import uuid
from unittest.mock import patch

from django.test import TestCase, TransactionTestCase

from apps.services.package_registry import services
from apps.services.package_registry.models import Package, PackageVersion
from apps.services.package_registry.tests.conftest import (
    apply_eventbus_mock,
    apply_oss_mocks,
    apply_permission_mock,
    apply_using_db_mock,
    compute_bundle,
    uid,
)


def _ensure_user(user_id: str):
    """为权限单测补建 stub User，避免 SQLite teardown 外键检查失败。"""
    from apps.users.auth.models import User

    User.objects.get_or_create(
        id=user_id,
        defaults={
            "email": f"{user_id[:8]}@example.test",
            "nickname": f"u-{user_id[:8]}",
        },
    )


def _create_membership(organization_id: str, user_id: str, role: str = "editor"):
    """在 default DB 中直接创建 OrganizationMember 记录。"""
    from apps.tabtinspace.models import OrganizationMember

    _ensure_user(user_id)
    return OrganizationMember.objects.create(
        organization_id=organization_id,
        user_id=user_id,
        role=role,
    )


def _create_organization(owner_id: str) -> str:
    from apps.tabtinspace.models import Organization

    _ensure_user(owner_id)
    wt = Organization.objects.create(
        name=f"test-wt-{uuid.uuid4().hex[:8]}",
        owner_id=owner_id,
    )
    return str(wt.id)


# ---------------------------------------------------------------------------
# 1. check_package_write_access 单元测试
# ---------------------------------------------------------------------------

class CheckPackageWriteAccessTest(TestCase):
    databases = {"default", "postgresql"}

    def test_organization_owner_passes_without_duplicate_membership_row(self):
        """组织 owner 是权威身份，不应依赖一条可能缺失的成员镜像记录。"""
        user_id = uid()
        wt_id = _create_organization(user_id)

        for min_role in ("viewer", "editor", "admin", "owner"):
            services.check_package_write_access(
                user_id=user_id, organization_id=wt_id, min_role=min_role,
            )

    def test_owner_passes_all_roles(self):
        user_id = uid()
        wt_id = _create_organization(user_id)
        _create_membership(wt_id, user_id, "owner")

        for min_role in ("viewer", "editor", "admin", "owner"):
            services.check_package_write_access(
                user_id=user_id, organization_id=wt_id, min_role=min_role,
            )

    def test_admin_passes_admin_and_below(self):
        user_id = uid()
        wt_id = _create_organization(user_id)
        _create_membership(wt_id, user_id, "admin")

        services.check_package_write_access(
            user_id=user_id, organization_id=wt_id, min_role="editor",
        )
        services.check_package_write_access(
            user_id=user_id, organization_id=wt_id, min_role="admin",
        )
        with self.assertRaises(PermissionError):
            services.check_package_write_access(
                user_id=user_id, organization_id=wt_id, min_role="owner",
            )

    def test_editor_passes_editor_only(self):
        user_id = uid()
        wt_id = _create_organization(user_id)
        _create_membership(wt_id, user_id, "editor")

        services.check_package_write_access(
            user_id=user_id, organization_id=wt_id, min_role="editor",
        )
        with self.assertRaises(PermissionError):
            services.check_package_write_access(
                user_id=user_id, organization_id=wt_id, min_role="admin",
            )

    def test_viewer_cannot_write(self):
        user_id = uid()
        wt_id = _create_organization(user_id)
        _create_membership(wt_id, user_id, "viewer")

        with self.assertRaises(PermissionError) as ctx:
            services.check_package_write_access(
                user_id=user_id, organization_id=wt_id, min_role="editor",
            )
        self.assertIn("PERMISSION_DENIED", str(ctx.exception))

    def test_non_member_rejected(self):
        user_id = uid()
        wt_id = _create_organization(uid())

        with self.assertRaises(PermissionError) as ctx:
            services.check_package_write_access(
                user_id=user_id, organization_id=wt_id, min_role="editor",
            )
        self.assertIn("PERMISSION_DENIED", str(ctx.exception))

    def test_wrong_organization_rejected(self):
        user_id = uid()
        wt1 = _create_organization(user_id)
        wt2 = _create_organization(uid())
        _create_membership(wt1, user_id, "editor")

        services.check_package_write_access(
            user_id=user_id, organization_id=wt1, min_role="editor",
        )
        with self.assertRaises(PermissionError):
            services.check_package_write_access(
                user_id=user_id, organization_id=wt2, min_role="editor",
            )


# ---------------------------------------------------------------------------
# 2. create_package 权限集成
# ---------------------------------------------------------------------------

class CreatePackagePermissionTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        apply_eventbus_mock(self)
        apply_using_db_mock(self)

    def test_editor_can_create(self):
        user_id = uid()
        wt_id = _create_organization(user_id)
        _create_membership(wt_id, user_id, "editor")

        pkg = services.create_package(
            namespace="perm-ns", name="create-ok",
            organization_id=wt_id, created_by=user_id,
        )
        self.assertEqual(pkg.namespace, "perm-ns")

    def test_viewer_cannot_create(self):
        user_id = uid()
        wt_id = _create_organization(user_id)
        _create_membership(wt_id, user_id, "viewer")

        with self.assertRaises(PermissionError):
            services.create_package(
                namespace="perm-ns2", name="create-nope",
                organization_id=wt_id, created_by=user_id,
            )

    def test_non_member_cannot_create(self):
        user_id = uid()
        wt_id = _create_organization(uid())

        with self.assertRaises(PermissionError):
            services.create_package(
                namespace="perm-ns3", name="create-noauth",
                organization_id=wt_id, created_by=user_id,
            )


# ---------------------------------------------------------------------------
# 3. init_version 权限集成
# ---------------------------------------------------------------------------

class InitVersionPermissionTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        apply_eventbus_mock(self)
        apply_oss_mocks(self)
        apply_using_db_mock(self)
        self.user_id = uid()
        self.wt_id = _create_organization(self.user_id)
        _create_membership(self.wt_id, self.user_id, "admin")
        self.pkg = services.create_package(
            namespace="iv-perm", name="test",
            organization_id=self.wt_id, created_by=self.user_id,
        )

    def test_editor_can_init(self):
        editor_id = uid()
        _create_membership(self.wt_id, editor_id, "editor")

        result = services.init_version(
            package=self.pkg,
            files=[{"path": "main.py", "sha256": "a" * 64, "size": 100}],
            manifest={}, version_label=None, user_id=editor_id,
        )
        self.assertIn("version_id", result)

    def test_viewer_cannot_init(self):
        viewer_id = uid()
        _create_membership(self.wt_id, viewer_id, "viewer")

        with self.assertRaises(PermissionError):
            services.init_version(
                package=self.pkg,
                files=[{"path": "main.py", "sha256": "b" * 64, "size": 100}],
                manifest={}, version_label=None, user_id=viewer_id,
            )

    def test_non_member_cannot_init(self):
        stranger = uid()

        with self.assertRaises(PermissionError):
            services.init_version(
                package=self.pkg,
                files=[{"path": "main.py", "sha256": "c" * 64, "size": 100}],
                manifest={}, version_label=None, user_id=stranger,
            )


# ---------------------------------------------------------------------------
# 4. finalize_version 权限集成
# ---------------------------------------------------------------------------

class FinalizeVersionPermissionTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        apply_eventbus_mock(self)
        apply_oss_mocks(self)
        apply_using_db_mock(self)
        self.user_id = uid()
        self.wt_id = _create_organization(self.user_id)
        _create_membership(self.wt_id, self.user_id, "admin")
        self.pkg = services.create_package(
            namespace="fv-perm", name="test",
            organization_id=self.wt_id, created_by=self.user_id,
        )

    def test_non_member_cannot_finalize(self):
        sha = "d" * 64
        init = services.init_version(
            package=self.pkg,
            files=[{"path": "app.py", "sha256": sha, "size": 200}],
            manifest={}, version_label=None, user_id=self.user_id,
        )
        version = PackageVersion.objects.get(id=init["version_id"])
        bundle = compute_bundle([("app.py", sha)])

        stranger = uid()
        with self.assertRaises(PermissionError):
            services.finalize_version(
                package=self.pkg, version=version,
                bundle_sha256=bundle,
                init_files=[{"path": "app.py", "sha256": sha, "size": 200}],
                user_id=stranger,
            )

    def test_editor_can_finalize(self):
        editor_id = uid()
        _create_membership(self.wt_id, editor_id, "editor")

        sha = "e" * 64
        init = services.init_version(
            package=self.pkg,
            files=[{"path": "app.py", "sha256": sha, "size": 200}],
            manifest={}, version_label=None, user_id=self.user_id,
        )
        version = PackageVersion.objects.get(id=init["version_id"])
        bundle = compute_bundle([("app.py", sha)])

        result = services.finalize_version(
            package=self.pkg, version=version,
            bundle_sha256=bundle,
            init_files=[{"path": "app.py", "sha256": sha, "size": 200}],
            user_id=editor_id,
        )
        self.assertEqual(result["version_seq"], 1)


# ---------------------------------------------------------------------------
# 5. yank_version 权限集成（需 admin+）
# ---------------------------------------------------------------------------

class YankVersionPermissionTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        apply_eventbus_mock(self)
        apply_oss_mocks(self)
        apply_using_db_mock(self)
        self.user_id = uid()
        self.wt_id = _create_organization(self.user_id)
        _create_membership(self.wt_id, self.user_id, "owner")
        self.pkg = services.create_package(
            namespace="yk-perm", name="test",
            organization_id=self.wt_id, created_by=self.user_id,
        )
        sha = "f" * 64
        init = services.init_version(
            package=self.pkg,
            files=[{"path": "x.py", "sha256": sha, "size": 10}],
            manifest={}, version_label=None, user_id=self.user_id,
        )
        v = PackageVersion.objects.get(id=init["version_id"])
        bundle = compute_bundle([("x.py", sha)])
        services.finalize_version(
            package=self.pkg, version=v,
            bundle_sha256=bundle,
            init_files=[{"path": "x.py", "sha256": sha, "size": 10}],
            user_id=self.user_id,
        )

    def test_admin_can_yank(self):
        admin_id = uid()
        _create_membership(self.wt_id, admin_id, "admin")

        result = services.yank_version(
            package=self.pkg, version_seq=1, reason="broken",
            user_id=admin_id,
        )
        self.assertIn("yanked_at", result)

    def test_editor_cannot_yank(self):
        editor_id = uid()
        _create_membership(self.wt_id, editor_id, "editor")

        with self.assertRaises(PermissionError) as ctx:
            services.yank_version(
                package=self.pkg, version_seq=1, reason="broken",
                user_id=editor_id,
            )
        self.assertIn("PERMISSION_DENIED", str(ctx.exception))

    def test_viewer_cannot_yank(self):
        viewer_id = uid()
        _create_membership(self.wt_id, viewer_id, "viewer")

        with self.assertRaises(PermissionError):
            services.yank_version(
                package=self.pkg, version_seq=1, reason="nope",
                user_id=viewer_id,
            )

    def test_non_member_cannot_yank(self):
        stranger = uid()
        with self.assertRaises(PermissionError):
            services.yank_version(
                package=self.pkg, version_seq=1, reason="nope",
                user_id=stranger,
            )


# ---------------------------------------------------------------------------
# 5b. revert_to_version 权限集成（需 editor+，与 publish 对齐；yank 仍 admin+）
# ---------------------------------------------------------------------------

class RevertVersionPermissionTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        apply_eventbus_mock(self)
        apply_oss_mocks(self)
        apply_using_db_mock(self)
        self.user_id = uid()
        self.wt_id = _create_organization(self.user_id)
        _create_membership(self.wt_id, self.user_id, "owner")
        self.pkg = services.create_package(
            namespace="rv-perm", name="test",
            organization_id=self.wt_id, created_by=self.user_id,
        )
        # 发布 v1 + v2，便于回滚到 v1
        for label_char, size in (("a", 10), ("b", 20)):
            sha = label_char * 64
            init = services.init_version(
                package=self.pkg,
                files=[{"path": "x.py", "sha256": sha, "size": size}],
                manifest={}, version_label=None, user_id=self.user_id,
            )
            v = PackageVersion.objects.get(id=init["version_id"])
            bundle = compute_bundle([("x.py", sha)])
            services.finalize_version(
                package=self.pkg, version=v,
                bundle_sha256=bundle,
                init_files=[{"path": "x.py", "sha256": sha, "size": size}],
                user_id=self.user_id,
            )
        self.pkg.refresh_from_db()
        self.assertEqual(self.pkg.latest_version_seq, 2)

    def test_editor_can_revert(self):
        editor_id = uid()
        _create_membership(self.wt_id, editor_id, "editor")

        result = services.revert_to_version(
            package=self.pkg, target_version_seq=1, user_id=editor_id,
        )
        self.assertEqual(result["target_version_seq"], 1)
        self.assertEqual(result["new_version_seq"], 3)

    def test_admin_can_revert(self):
        admin_id = uid()
        _create_membership(self.wt_id, admin_id, "admin")

        result = services.revert_to_version(
            package=self.pkg, target_version_seq=1, user_id=admin_id,
        )
        self.assertEqual(result["new_version_seq"], 3)

    def test_viewer_cannot_revert(self):
        viewer_id = uid()
        _create_membership(self.wt_id, viewer_id, "viewer")

        with self.assertRaises(PermissionError) as ctx:
            services.revert_to_version(
                package=self.pkg, target_version_seq=1, user_id=viewer_id,
            )
        self.assertIn("PERMISSION_DENIED", str(ctx.exception))
        self.assertIn("editor+", str(ctx.exception))

    def test_non_member_cannot_revert(self):
        stranger = uid()
        with self.assertRaises(PermissionError):
            services.revert_to_version(
                package=self.pkg, target_version_seq=1, user_id=stranger,
            )


# ---------------------------------------------------------------------------
# 6. fork_package 权限集成（校验目标 organization）
# ---------------------------------------------------------------------------

class ForkPackagePermissionTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        apply_eventbus_mock(self)
        apply_oss_mocks(self)
        apply_using_db_mock(self)
        self.user_id = uid()
        self.src_wt = _create_organization(self.user_id)
        _create_membership(self.src_wt, self.user_id, "owner")
        self.pkg = services.create_package(
            namespace="fk-perm", name="source",
            organization_id=self.src_wt, created_by=self.user_id,
        )
        sha = "1" * 64
        init = services.init_version(
            package=self.pkg,
            files=[{"path": "m.py", "sha256": sha, "size": 10}],
            manifest={}, version_label=None, user_id=self.user_id,
        )
        v = PackageVersion.objects.get(id=init["version_id"])
        bundle = compute_bundle([("m.py", sha)])
        services.finalize_version(
            package=self.pkg, version=v,
            bundle_sha256=bundle,
            init_files=[{"path": "m.py", "sha256": sha, "size": 10}],
            user_id=self.user_id,
        )

    def test_editor_can_fork_to_own_organization(self):
        target_wt = _create_organization(self.user_id)
        _create_membership(target_wt, self.user_id, "editor")

        result = services.fork_package(
            source_package=self.pkg,
            target_namespace="fk-target", target_name="forked",
            target_organization_id=target_wt,
            user_id=self.user_id,
        )
        self.assertIn("new_package_id", result)

    def test_non_member_cannot_fork(self):
        target_wt = _create_organization(uid())
        stranger = uid()

        with self.assertRaises(PermissionError):
            services.fork_package(
                source_package=self.pkg,
                target_namespace="fk-target2", target_name="nope",
                target_organization_id=target_wt,
                user_id=stranger,
            )

    def test_viewer_cannot_fork(self):
        target_wt = _create_organization(self.user_id)
        viewer_id = uid()
        _create_membership(target_wt, viewer_id, "viewer")

        with self.assertRaises(PermissionError):
            services.fork_package(
                source_package=self.pkg,
                target_namespace="fk-target3", target_name="viewer-fork",
                target_organization_id=target_wt,
                user_id=viewer_id,
            )


# ---------------------------------------------------------------------------
# 7. 读操作不受权限影响
# ---------------------------------------------------------------------------

class ReadOperationsUnaffectedTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        apply_eventbus_mock(self)
        apply_oss_mocks(self)
        apply_using_db_mock(self)
        self.user_id = uid()
        self.wt_id = _create_organization(self.user_id)
        _create_membership(self.wt_id, self.user_id, "owner")
        self.pkg = services.create_package(
            namespace="read-perm", name="test",
            organization_id=self.wt_id, created_by=self.user_id,
        )
        sha = "2" * 64
        init = services.init_version(
            package=self.pkg,
            files=[{"path": "r.py", "sha256": sha, "size": 10}],
            manifest={}, version_label=None, user_id=self.user_id,
        )
        v = PackageVersion.objects.get(id=init["version_id"])
        bundle = compute_bundle([("r.py", sha)])
        services.finalize_version(
            package=self.pkg, version=v,
            bundle_sha256=bundle,
            init_files=[{"path": "r.py", "sha256": sha, "size": 10}],
            user_id=self.user_id,
        )

    def test_list_versions_no_permission_needed(self):
        result = services.list_versions(package=self.pkg)
        self.assertEqual(len(result["items"]), 1)

    def test_get_version_files_no_permission_needed(self):
        result = services.get_version_files(package=self.pkg, version_seq=1)
        self.assertEqual(len(result["files"]), 1)

    def test_lookup_package_no_permission_needed(self):
        pkg = services.lookup_package(namespace="read-perm", name="test")
        self.assertEqual(str(pkg.id), str(self.pkg.id))


# ---------------------------------------------------------------------------
# 8. 完整发布流程权限测试（端到端）
# ---------------------------------------------------------------------------

class FullPublishPermissionE2ETest(TransactionTestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        apply_eventbus_mock(self)
        apply_oss_mocks(self)
        apply_using_db_mock(self)

    def test_complete_publish_by_editor(self):
        """editor 可以完成完整 create → init → finalize 流程。"""
        user_id = uid()
        wt_id = _create_organization(user_id)
        _create_membership(wt_id, user_id, "editor")

        pkg = services.create_package(
            namespace="e2e-perm", name="full",
            organization_id=wt_id, created_by=user_id,
        )
        sha = "3" * 64
        init = services.init_version(
            package=pkg,
            files=[{"path": "main.py", "sha256": sha, "size": 50}],
            manifest={"type": "skill"}, version_label="1.0",
            user_id=user_id,
        )
        v = PackageVersion.objects.get(id=init["version_id"])
        bundle = compute_bundle([("main.py", sha)])
        result = services.finalize_version(
            package=pkg, version=v,
            bundle_sha256=bundle,
            init_files=[{"path": "main.py", "sha256": sha, "size": 50}],
            user_id=user_id,
        )
        self.assertEqual(result["version_seq"], 1)

    def test_viewer_blocked_at_create(self):
        """viewer 在 create 阶段就被拒绝。"""
        user_id = uid()
        wt_id = _create_organization(user_id)
        _create_membership(wt_id, user_id, "viewer")

        with self.assertRaises(PermissionError):
            services.create_package(
                namespace="e2e-perm2", name="blocked",
                organization_id=wt_id, created_by=user_id,
            )

    def test_editor_yank_blocked_admin_yank_allowed(self):
        """editor 不能 yank，admin 可以 yank。"""
        admin_id = uid()
        editor_id = uid()
        wt_id = _create_organization(admin_id)
        _create_membership(wt_id, admin_id, "admin")
        _create_membership(wt_id, editor_id, "editor")

        pkg = services.create_package(
            namespace="e2e-yank", name="role-test",
            organization_id=wt_id, created_by=admin_id,
        )
        sha = "4" * 64
        init = services.init_version(
            package=pkg,
            files=[{"path": "m.py", "sha256": sha, "size": 10}],
            manifest={}, version_label=None, user_id=editor_id,
        )
        v = PackageVersion.objects.get(id=init["version_id"])
        bundle = compute_bundle([("m.py", sha)])
        services.finalize_version(
            package=pkg, version=v,
            bundle_sha256=bundle,
            init_files=[{"path": "m.py", "sha256": sha, "size": 10}],
            user_id=editor_id,
        )

        with self.assertRaises(PermissionError):
            services.yank_version(
                package=pkg, version_seq=1, reason="nope",
                user_id=editor_id,
            )

        result = services.yank_version(
            package=pkg, version_seq=1, reason="ok",
            user_id=admin_id,
        )
        self.assertIn("yanked_at", result)
