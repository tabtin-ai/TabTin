"""Workspace 独立表（ PR2）：约束、供给原语、迁移 id 复用验证。

覆盖四层：
1. DB 约束——(organization, user, device, normalized_working_dir) 目录身份约束
   + 每组织每用户每设备一个 home partial unique，并发供给的最终护栏。
2. WorkspaceService.create_workspace / ensure_home_workspace——独立创建入口
   （不隐式建 Agent）与主场幂等供给（home-workspace-p1 §3.4）。
3. 迁移 0097 forwards——workspace 型 Space → Workspace 的 id 复用、未绑定
   占位行丢弃（M-6）、(device, dir) 冲突消解、git_status 归位。
4. 迁移 0060 回填 SQL——workspace_id = space_id 同值拷贝（靠 id 复用）。

风格对齐 test_backfill_agent_id_migration.py：不走 MigrationExecutor 重放，
直接以真实 app registry + schema_editor 调迁移函数。
"""

import importlib
import uuid
from types import SimpleNamespace
from unittest.mock import patch

from django.apps import apps as global_apps
from django.contrib.auth import get_user_model
from django.db import IntegrityError, connections, transaction
from django.db.models.signals import post_save
from django.test import TestCase, TransactionTestCase, override_settings

from apps.services.common.db_router import postgres_app_db_alias
from apps.tabtinspace.signals import create_default_organization
from apps.tabtinspace.tests.fixtures import create_test_user, create_test_organization

User = get_user_model()

_workspace_backfill = importlib.import_module(
    "apps.tabtinspace.migrations.0097_workspace_backfill_from_space_3266"
).forwards


def _make_device(organization, user, prefix="ws-tbl"):
    from apps.tabtinspace.models import Device

    return Device.objects.create(
        organization=organization,
        user=user,
        name=f"{prefix} device",
        device_type="electron",
        role="control",
        fingerprint=f"{prefix}-{uuid.uuid4().hex[:10]}",
        status="online",
    )


class WorkspaceConstraintTests(TestCase):
    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        post_save.disconnect(create_default_organization, sender=User)

    @classmethod
    def tearDownClass(cls):
        post_save.connect(create_default_organization, sender=User)
        super().tearDownClass()

    def setUp(self):
        self.owner = create_test_user(prefix="ws-con")
        self.organization = create_test_organization(owner=self.owner, prefix="ws-con")
        self.device = _make_device(self.organization, self.owner, prefix="ws-con")

    def _create(self, working_dir, **extra):
        from apps.tabtinspace.models import Workspace

        return Workspace.objects.create(
            organization=self.organization,
            device=extra.pop("device", self.device),
            working_dir=working_dir,
            normalized_working_dir=working_dir,
            created_by=extra.pop("created_by", self.owner),
            **extra,
        )

    def test_workspace_dir_unique_per_organization_user_and_device(self):
        from apps.tabtinspace.models import Workspace

        self._create("/Users/me/proj")
        with self.assertRaises(IntegrityError), transaction.atomic(
            using=postgres_app_db_alias()
        ):
            self._create("/Users/me/proj")

        other_user = create_test_user(prefix="ws-con-other-user-dir")
        self._create("/Users/me/proj", created_by=other_user)

        other_organization = create_test_organization(
            owner=self.owner, prefix="ws-con-other-dir",
        )
        Workspace.objects.create(
            organization=other_organization,
            device=self.device,
            working_dir="/Users/me/proj",
            normalized_working_dir="/Users/me/proj",
            created_by=self.owner,
        )

    def test_device_home_unique_per_organization_and_user(self):
        from apps.tabtinspace.models import Workspace

        self._create("/Users/me/TabTin/Home", kind=Workspace.Kind.HOME)
        with self.assertRaises(IntegrityError), transaction.atomic(
            using=postgres_app_db_alias()
        ):
            self._create("/Users/me/TabTin/Home-дifferent", kind=Workspace.Kind.HOME)

        # 同一 Organization、同一设备切换用户后，新用户可拥有独立主场。
        other_user = create_test_user(prefix="ws-con-other-user")
        self._create(
            "/Users/me/TabTin/Home-2",
            kind=Workspace.Kind.HOME,
            created_by=other_user,
        )

        # 无创建者的极旧数据不参与用户级主场约束，留给异常数据巡检。
        self._create(
            "/Users/me/TabTin/Legacy-Home",
            kind=Workspace.Kind.HOME,
            created_by=None,
        )
        self._create(
            "/Users/me/TabTin/Legacy-Home-2",
            kind=Workspace.Kind.HOME,
            created_by=None,
        )

        # Electron 是用户级设备，同一设备可为另一个自有 Organization 建主场。
        other_organization = create_test_organization(
            owner=self.owner, prefix="ws-con-other",
        )
        Workspace.objects.create(
            organization=other_organization,
            device=self.device,
            working_dir="/Users/me/TabTin/Other/Home",
            normalized_working_dir="/Users/me/TabTin/Other/Home",
            kind=Workspace.Kind.HOME,
            created_by=self.owner,
        )

        # 同一 Organization 的另一台设备也可有自己的主场。
        other_device = _make_device(self.organization, self.owner, prefix="ws-con2")
        self._create(
            "/Users/me/TabTin/Home", kind=Workspace.Kind.HOME, device=other_device,
        )


class WorkspaceServiceTests(TestCase):
    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        post_save.disconnect(create_default_organization, sender=User)

    @classmethod
    def tearDownClass(cls):
        post_save.connect(create_default_organization, sender=User)
        super().tearDownClass()

    def setUp(self):
        from apps.tabtinspace.services.workspace_service import WorkspaceService

        self.owner = create_test_user(prefix="ws-svc")
        self.organization = create_test_organization(owner=self.owner, prefix="ws-svc")
        self.device = _make_device(self.organization, self.owner, prefix="ws-svc")
        self.service = WorkspaceService(user=self.owner)
        self.feature_patch = patch(
            "apps.platform_config.services.PlatformRuntimeConfigService.evaluate_feature",
            return_value=SimpleNamespace(enabled=True),
        )
        self.feature_patch.start()
        self.addCleanup(self.feature_patch.stop)

    def test_create_workspace_standalone(self):
        from apps.tabtinspace.models import SpaceMembership, Workspace

        ws = self.service.create_workspace(
            organization_id=self.organization.id,
            device_id=self.device.id,
            working_dir="/Users/me/dev/proj/",
            working_dir_type="code",
            name="proj",
        )
        self.assertEqual(ws.kind, Workspace.Kind.STANDARD)
        # 目录规范化（去尾斜杠）
        self.assertEqual(ws.normalized_working_dir, "/Users/me/dev/proj")
        # 用户主动开目录 = 隐式信任
        self.assertEqual(ws.trust_status, Workspace.TrustStatus.TRUSTED)
        self.assertEqual(ws.trust_source, Workspace.TrustSource.USER_CONFIRMED)
        self.assertEqual(ws.created_by_id, self.owner.id)
        # ：创建即写 owner membership，与 check_space_permission 对齐
        membership = SpaceMembership.objects.get(
            workspace_id=ws.id, user_id=self.owner.id, is_active=True,
        )
        self.assertEqual(membership.role, "owner")
        self.assertTrue(self.service.check_space_permission(str(ws.id), "editor"))
        # 独立入口不隐式建 Agent
        from apps.tabtinspace.models import Agent

        self.assertFalse(
            Agent.objects.filter(organization=self.organization).exists()
        )

    @override_settings(DAEMON_CONTROL_ENABLED=True)
    @patch("apps.services.daemon_control.client.resolve_device_by_installation")
    def test_create_remote_daemon_workspace_from_account_device(
        self, resolve_device,
    ):
        """账号级 Daemon 可以在当前 Organization 创建 Workspace。"""
        from apps.tabtinspace.models import Device
        installed_organization = create_test_organization(
            owner=self.owner, prefix="ws-daemon-installed",
        )
        daemon = Device.objects.create(
            organization=installed_organization,
            user=self.owner,
            name="Home Daemon",
            device_type="daemon",
            role="control",
            fingerprint="daemon-account-installation",
            status="online",
        )
        resolve_device.return_value = {
            "device_id": "control-plane-device",
            "owner_user_id": str(self.owner.id),
            "installation_id": daemon.fingerprint,
        }

        workspace = self.service.create_workspace(
            organization_id=self.organization.id,
            device_id=None,
            device_installation_id=daemon.fingerprint,
            working_dir="/srv/tabtin/projects/../demo",
            working_dir_type="code",
            name="Remote demo",
        )

        self.assertEqual(workspace.organization_id, self.organization.id)
        self.assertEqual(workspace.device_id, daemon.id)
        self.assertEqual(workspace.working_dir, "/srv/tabtin/demo")
        self.assertEqual(workspace.normalized_working_dir, "/srv/tabtin/demo")
        resolve_device.assert_called_once_with(
            owner_user_id=str(self.owner.id),
            installation_id=daemon.fingerprint,
        )

    @override_settings(DAEMON_CONTROL_ENABLED=True)
    @patch("apps.services.daemon_control.client.resolve_device_by_installation")
    def test_remote_workspace_requires_organization_feature(self, resolve_device):
        from apps.tabtinspace.services.base import ServiceError

        with patch(
            "apps.platform_config.services.PlatformRuntimeConfigService.evaluate_feature",
            return_value=SimpleNamespace(enabled=False),
        ), self.assertRaises(ServiceError) as ctx:
            self.service.create_workspace(
                organization_id=self.organization.id,
                device_id=None,
                device_installation_id="daemon-account-installation",
                working_dir="/srv/tabtin/demo",
            )

        self.assertEqual(ctx.exception.code, "DAEMON_CONTROL_DISABLED")
        resolve_device.assert_not_called()

    @override_settings(DAEMON_CONTROL_ENABLED=True)
    @patch("apps.services.daemon_control.client.resolve_device_by_installation")
    def test_create_remote_electron_workspace_from_account_device(
        self, resolve_device,
    ):
        """同账号 active Electron 执行设备与 Daemon 复用同一创建链路。"""
        from apps.tabtinspace.models import Device

        installed_organization = create_test_organization(
            owner=self.owner, prefix="ws-electron-installed",
        )
        electron = Device.objects.create(
            organization=installed_organization,
            user=self.owner,
            name="Office Mac",
            device_type="electron",
            role="control",
            control_status="active",
            fingerprint="electron-account-installation",
            status="online",
        )
        resolve_device.return_value = {
            "device_id": "control-plane-electron",
            "owner_user_id": str(self.owner.id),
            "installation_id": electron.fingerprint,
        }

        workspace = self.service.create_workspace(
            organization_id=self.organization.id,
            device_id=None,
            device_installation_id=electron.fingerprint,
            working_dir="/Users/me/projects/demo",
            working_dir_type="code",
            name="Remote Electron demo",
        )

        self.assertEqual(workspace.organization_id, self.organization.id)
        self.assertEqual(workspace.device_id, electron.id)
        self.assertEqual(workspace.working_dir, "/Users/me/projects/demo")
        resolve_device.assert_called_once_with(
            owner_user_id=str(self.owner.id),
            installation_id=electron.fingerprint,
        )

    @override_settings(DAEMON_CONTROL_ENABLED=True)
    @patch("apps.services.daemon_control.client.resolve_device_by_installation")
    def test_remote_workspace_rejects_unsupported_projection(self, resolve_device):
        from apps.tabtinspace.models import Device
        from apps.tabtinspace.services.base import ServiceError

        cloud = Device.objects.create(
            organization=self.organization,
            user=self.owner,
            name="Cloud runtime",
            device_type="cloud",
            role="control",
            fingerprint="cloud-installation",
        )
        resolve_device.return_value = {
            "device_id": "control-plane-cloud",
            "owner_user_id": str(self.owner.id),
            "installation_id": cloud.fingerprint,
        }

        with self.assertRaises(ServiceError) as ctx:
            self.service.create_workspace(
                organization_id=self.organization.id,
                device_id=None,
                device_installation_id=cloud.fingerprint,
                working_dir="/srv/tabtin/projects/demo",
            )

        self.assertEqual(ctx.exception.code, "DEVICE_PROJECTION_NOT_READY")

    @override_settings(DAEMON_CONTROL_ENABLED=True)
    @patch("apps.services.daemon_control.client.resolve_device_by_installation")
    def test_remote_daemon_workspace_requires_non_root_absolute_path(
        self, resolve_device,
    ):
        from apps.tabtinspace.services.base import ServiceError

        for invalid_path in (
            "relative/project",
            "~/project",
            "/",
            "/..",
            "/tmp/..",
            "C:\\\\",
            "C:\\foo\\..",
            "\\\\server\\share\\folder\\..",
        ):
            with self.subTest(path=invalid_path), self.assertRaises(ServiceError) as ctx:
                self.service.create_workspace(
                    organization_id=self.organization.id,
                    device_id=None,
                    device_installation_id="daemon-account-installation",
                    working_dir=invalid_path,
                )
            self.assertEqual(ctx.exception.code, "REMOTE_WORKING_DIR_INVALID")
        resolve_device.assert_not_called()

    def test_ensure_home_writes_and_heals_owner_membership(self):
        """#6360：ensure-home 新建写 membership；复用路径自愈历史缺口。"""
        from apps.tabtinspace.models import SpaceMembership, Workspace

        ws, created = self.service.ensure_home_workspace(
            organization_id=self.organization.id,
            device_id=self.device.id,
            working_dir="/Users/me/TabTin/HomeHeal",
        )
        self.assertTrue(created)
        self.assertTrue(
            SpaceMembership.objects.filter(
                workspace_id=ws.id,
                user_id=self.owner.id,
                role="owner",
                is_active=True,
            ).exists()
        )

        # 模拟历史缺口：删掉 membership 后再次 ensure 应自愈
        SpaceMembership.objects.filter(workspace_id=ws.id).delete()
        self.assertFalse(self.service.check_space_permission(str(ws.id), "viewer"))

        healed, created_again = self.service.ensure_home_workspace(
            organization_id=self.organization.id,
            device_id=self.device.id,
            working_dir="/Users/me/TabTin/HomeHeal",
        )
        self.assertFalse(created_again)
        self.assertEqual(healed.id, ws.id)
        self.assertTrue(
            SpaceMembership.objects.filter(
                workspace_id=ws.id,
                user_id=self.owner.id,
                role="owner",
                is_active=True,
            ).exists()
        )
        # 新实例清 permission cache
        from apps.tabtinspace.services.workspace_service import WorkspaceService

        fresh = WorkspaceService(user=self.owner)
        self.assertTrue(fresh.check_space_permission(str(ws.id), "editor"))
        self.assertEqual(Workspace.objects.filter(id=ws.id).count(), 1)

    def test_list_workspaces_uses_membership_not_created_by_alone(self):
        """#6360：仅有 created_by、无 membership 时不应出现在列表。"""
        from apps.tabtinspace.models import Workspace

        orphan = Workspace.objects.create(
            organization=self.organization,
            device=self.device,
            name="orphan-no-ms",
            working_dir="/Users/me/orphan-no-ms",
            normalized_working_dir="/Users/me/orphan-no-ms",
            kind=Workspace.Kind.STANDARD,
            created_by=self.owner,
        )
        listed_ids = {str(row.id) for row in self.service.list_workspaces()}
        self.assertNotIn(str(orphan.id), listed_ids)

        ws = self.service.create_workspace(
            organization_id=self.organization.id,
            device_id=self.device.id,
            working_dir="/Users/me/with-ms",
            name="with-ms",
        )
        listed_ids = {str(row.id) for row in self.service.list_workspaces()}
        self.assertIn(str(ws.id), listed_ids)

    def test_update_workspace_heals_missing_owner_membership_for_creator(self):
        """#7536：写路径对 created_by 自愈缺 owner membership；非创建者仍 403。"""
        from apps.tabtinspace.models import OrganizationMember, SpaceMembership
        from apps.tabtinspace.services.base import ServiceError
        from apps.tabtinspace.services.workspace_service import WorkspaceService

        ws = self.service.create_workspace(
            organization_id=self.organization.id,
            device_id=self.device.id,
            working_dir="/Users/me/heal-on-update",
            name="before",
        )
        SpaceMembership.objects.filter(workspace_id=ws.id).delete()
        self.assertFalse(self.service.check_space_permission(str(ws.id), "owner"))

        updated = WorkspaceService(user=self.owner).update_workspace(
            ws.id, name="after-heal",
        )
        self.assertEqual(updated.name, "after-heal")
        self.assertTrue(
            SpaceMembership.objects.filter(
                workspace_id=ws.id,
                user_id=self.owner.id,
                role="owner",
                is_active=True,
            ).exists()
        )

        other = create_test_user(prefix="ws-svc-other")
        OrganizationMember.objects.create(
            organization=self.organization,
            user=other,
            role="editor",
        )
        with self.assertRaises(ServiceError) as ctx:
            WorkspaceService(user=other).update_workspace(ws.id, name="hijack")
        self.assertEqual(ctx.exception.code, "PERMISSION_DENIED")
        self.assertEqual(ctx.exception.status, 403)

    def test_create_workspace_dir_conflict(self):
        from apps.tabtinspace.services.base import ServiceError

        self.service.create_workspace(
            organization_id=self.organization.id,
            device_id=self.device.id,
            working_dir="/Users/me/dup",
        )
        with self.assertRaises(ServiceError) as ctx:
            self.service.create_workspace(
                organization_id=self.organization.id,
                device_id=self.device.id,
                working_dir="/Users/me/dup",
            )
        self.assertEqual(ctx.exception.code, "WORKING_DIR_CONFLICT")
        self.assertEqual(ctx.exception.status, 409)

    def test_create_workspace_dir_is_isolated_per_user(self):
        """同一设备切换账号后，各账号可以为同一路径建立私有 Workspace。"""
        from apps.tabtinspace.models import OrganizationMember
        from apps.tabtinspace.services.workspace_service import WorkspaceService

        working_dir = "/Users/me/shared-project"
        owner_workspace = self.service.create_workspace(
            organization_id=self.organization.id,
            device_id=self.device.id,
            working_dir=working_dir,
        )

        next_user = create_test_user(prefix="ws-svc-next-user")
        OrganizationMember.objects.create(
            organization=self.organization,
            user=next_user,
            role="editor",
        )
        self.device.user = next_user
        self.device.save(update_fields=["user", "updated_at"])

        next_workspace = WorkspaceService(user=next_user).create_workspace(
            organization_id=self.organization.id,
            device_id=self.device.id,
            working_dir=working_dir,
        )

        self.assertNotEqual(next_workspace.id, owner_workspace.id)
        self.assertEqual(next_workspace.created_by_id, next_user.id)
        self.assertEqual(next_workspace.normalized_working_dir, working_dir)

    def test_create_agent_workspace_dir_is_isolated_per_user(self):
        """兼容的 Agent + Workspace 创建入口遵守相同的账号隔离规则。"""
        from apps.tabtinspace.models import OrganizationMember
        from apps.tabtinspace.services.agent_service import AgentService

        working_dir = "/Users/me/shared-agent-project"
        owner_workspace = self.service.create_workspace(
            organization_id=self.organization.id,
            device_id=self.device.id,
            working_dir=working_dir,
        )

        next_user = create_test_user(prefix="ws-agent-next-user")
        OrganizationMember.objects.create(
            organization=self.organization,
            user=next_user,
            role="editor",
        )
        self.device.user = next_user
        self.device.save(update_fields=["user", "updated_at"])

        _agent, next_workspace, _warning = AgentService(
            user=next_user,
        ).create_agent_workspace(
            organization_id=self.organization.id,
            name="Next user's Workspace",
            device_fingerprint=self.device.fingerprint,
            working_dir=working_dir,
        )

        self.assertNotEqual(next_workspace.id, owner_workspace.id)
        self.assertEqual(next_workspace.created_by_id, next_user.id)
        self.assertEqual(next_workspace.normalized_working_dir, working_dir)

    def test_delete_workspace_cleans_space_checkpoint_by_space_id(self):
        """#6607：SpaceCheckpoint 字段仍是 space_id，删除不得误查 workspace_id。"""
        from apps.collab.models import SpaceCheckpoint
        from apps.tabtinspace.models import Workspace

        ws = self.service.create_workspace(
            organization_id=self.organization.id,
            device_id=self.device.id,
            working_dir="/Users/me/delete-cp",
            name="delete-cp",
        )
        SpaceCheckpoint.objects.create(
            organization_id=self.organization.id,
            space_id=ws.id,
            name="before delete",
        )

        self.service.delete_workspace(ws.id, acting_device_id=self.device.id)

        self.assertFalse(Workspace.objects.filter(id=ws.id).exists())
        self.assertFalse(SpaceCheckpoint.objects.filter(space_id=ws.id).exists())

    def test_ensure_home_idempotent(self):
        from apps.tabtinspace.models import Workspace

        ws1, created1 = self.service.ensure_home_workspace(
            organization_id=self.organization.id,
            device_id=self.device.id,
            working_dir="/Users/me/TabTin/Home",
        )
        ws2, created2 = self.service.ensure_home_workspace(
            organization_id=self.organization.id,
            device_id=self.device.id,
            working_dir="/Users/me/TabTin/Home",
        )
        self.assertTrue(created1)
        self.assertFalse(created2)
        self.assertEqual(ws1.id, ws2.id)
        self.assertEqual(
            Workspace.objects.filter(
                device=self.device, kind=Workspace.Kind.HOME,
            ).count(),
            1,
        )
        # 系统自建默认受信（M-3）：首次进入不弹 Trust 确认
        self.assertEqual(ws1.trust_status, Workspace.TrustStatus.TRUSTED)
        self.assertEqual(ws1.trust_source, Workspace.TrustSource.SYSTEM_PROVISIONED)
        self.assertIsNotNone(ws1.trusted_at)

    def test_ensure_home_is_scoped_to_user_after_device_transfer(self):
        """#9839：同一设备换账号后，新用户不能复用旧用户的主场。"""
        from apps.tabtinspace.models import OrganizationMember, SpaceMembership
        from apps.tabtinspace.services.workspace_service import WorkspaceService

        owner_home, owner_created = self.service.ensure_home_workspace(
            organization_id=self.organization.id,
            device_id=self.device.id,
            working_dir="/Users/me/TabTin/Home",
        )
        self.assertTrue(owner_created)

        next_user = create_test_user(prefix="ws-svc-next-user")
        OrganizationMember.objects.create(
            organization=self.organization,
            user=next_user,
            role="editor",
        )
        self.device.user = next_user
        self.device.save(update_fields=["user", "updated_at"])

        next_service = WorkspaceService(user=next_user)
        next_home, next_created = next_service.ensure_home_workspace(
            organization_id=self.organization.id,
            device_id=self.device.id,
            working_dir="/Users/me/TabTin/Home-2",
        )

        self.assertTrue(next_created)
        self.assertNotEqual(next_home.id, owner_home.id)
        self.assertEqual(next_home.created_by_id, next_user.id)
        self.assertTrue(
            SpaceMembership.objects.filter(
                workspace_id=next_home.id,
                user_id=next_user.id,
                role="owner",
                is_active=True,
            ).exists()
        )
        self.assertFalse(
            SpaceMembership.objects.filter(
                workspace_id=owner_home.id,
                user_id=next_user.id,
                is_active=True,
            ).exists()
        )
        self.assertEqual(
            {workspace.id for workspace in next_service.list_workspaces(self.organization.id)},
            {next_home.id},
        )

        repeated_home, repeated_created = next_service.ensure_home_workspace(
            organization_id=self.organization.id,
            device_id=self.device.id,
            working_dir="/Users/me/TabTin/Home-2",
        )
        self.assertFalse(repeated_created)
        self.assertEqual(repeated_home.id, next_home.id)

    def test_ensure_home_does_not_claim_creatorless_legacy_home(self):
        """#9839：无归属旧主场不占用账号目录，也不能被当前用户静默认领。"""
        from apps.tabtinspace.models import Workspace

        working_dir = "/Users/me/TabTin/Legacy-Home"
        legacy_home = Workspace.objects.create(
            organization=self.organization,
            device=self.device,
            name="legacy-home",
            working_dir=working_dir,
            normalized_working_dir=working_dir,
            kind=Workspace.Kind.HOME,
            created_by=None,
        )

        current_home, created = self.service.ensure_home_workspace(
            organization_id=self.organization.id,
            device_id=self.device.id,
            working_dir=working_dir,
        )

        self.assertTrue(created)
        self.assertNotEqual(current_home.id, legacy_home.id)
        self.assertEqual(current_home.created_by_id, self.owner.id)
        self.assertEqual(current_home.normalized_working_dir, working_dir)

    def test_ensure_home_dir_is_isolated_per_user(self):
        """同一设备切换账号后，各账号可用同一路径供给自己的主场。"""
        from apps.tabtinspace.models import OrganizationMember, SpaceMembership
        from apps.tabtinspace.services.workspace_service import WorkspaceService

        owner_home, _ = self.service.ensure_home_workspace(
            organization_id=self.organization.id,
            device_id=self.device.id,
            working_dir="/Users/me/TabTin/Home",
        )
        next_user = create_test_user(prefix="ws-svc-dir-conflict")
        OrganizationMember.objects.create(
            organization=self.organization,
            user=next_user,
            role="editor",
        )
        self.device.user = next_user
        self.device.save(update_fields=["user", "updated_at"])

        next_home, created = WorkspaceService(user=next_user).ensure_home_workspace(
            organization_id=self.organization.id,
            device_id=self.device.id,
            working_dir=owner_home.working_dir,
        )

        self.assertTrue(created)
        self.assertNotEqual(next_home.id, owner_home.id)
        self.assertEqual(next_home.created_by_id, next_user.id)
        self.assertEqual(
            next_home.normalized_working_dir,
            owner_home.normalized_working_dir,
        )
        self.assertTrue(
            SpaceMembership.objects.filter(
                workspace_id=next_home.id,
                user_id=next_user.id,
                role="owner",
                is_active=True,
            ).exists()
        )

    def test_ensure_home_is_idempotent_per_organization_for_user_device(self):
        other_organization = create_test_organization(
            owner=self.owner, prefix="ws-svc-other",
        )
        shared_working_dir = "/Users/me/TabTin/Shared/Home"
        home, created = self.service.ensure_home_workspace(
            organization_id=self.organization.id,
            device_id=self.device.id,
            working_dir=shared_working_dir,
        )
        other_home, other_created = self.service.ensure_home_workspace(
            organization_id=other_organization.id,
            device_id=self.device.id,
            working_dir=shared_working_dir,
        )
        repeated_other_home, repeated_other_created = self.service.ensure_home_workspace(
            organization_id=other_organization.id,
            device_id=self.device.id,
            working_dir=shared_working_dir,
        )

        self.assertTrue(created)
        self.assertTrue(other_created)
        self.assertFalse(repeated_other_created)
        self.assertNotEqual(home.id, other_home.id)
        self.assertEqual(other_home.organization_id, other_organization.id)
        self.assertEqual(repeated_other_home.id, other_home.id)

    def test_ensure_home_route_is_not_shadowed_by_workspace_detail(self):
        """字面量路由必须先于 ``/{workspace_id}``，避免 POST 返回 405。"""
        import json

        from django.test import Client, RequestFactory

        from apps.users.auth.session_manager import SessionManager
        from apps.users.auth.utils import generate_jwt_token

        session = SessionManager.create_session(self.owner, RequestFactory().get("/"))
        token = generate_jwt_token(self.owner, session_key=session.session_key)
        response = Client().post(
            "/api/context/workspaces/ensure-home",
            data=json.dumps(
                {
                    "organization_id": str(self.organization.id),
                    "device_id": str(self.device.id),
                    "working_dir": "/Users/me/TabTin/Home",
                    "working_dir_type": "mixed",
                    "name": "默认 Workspace",
                }
            ),
            content_type="application/json",
            HTTP_AUTHORIZATION=f"Bearer {token}",
        )

        self.assertEqual(response.status_code, 200, response.content)
        self.assertTrue(response.json()["success"])

    def test_ensure_home_path_occupied_by_standard(self):
        from apps.tabtinspace.services.base import ServiceError

        self.service.create_workspace(
            organization_id=self.organization.id,
            device_id=self.device.id,
            working_dir="/Users/me/TabTin/Home",
        )
        with self.assertRaises(ServiceError) as ctx:
            self.service.ensure_home_workspace(
                organization_id=self.organization.id,
                device_id=self.device.id,
                working_dir="/Users/me/TabTin/Home",
            )
        # 不自动改判 kind（不静默篡改用户已有现场）
        self.assertEqual(ctx.exception.code, "WORKING_DIR_CONFLICT")

    def test_foreign_device_rejected(self):
        from apps.tabtinspace.services.base import ServiceError

        stranger = create_test_user(prefix="ws-svc-x")
        foreign_device = _make_device(self.organization, stranger, prefix="ws-svc-x")
        with self.assertRaises(ServiceError) as ctx:
            self.service.create_workspace(
                organization_id=self.organization.id,
                device_id=foreign_device.id,
                working_dir="/Users/stranger/proj",
            )
        self.assertEqual(ctx.exception.code, "DEVICE_NOT_FOUND")

    def test_ensure_home_allows_member_for_personal_device(self):
        from apps.tabtinspace.models import OrganizationMember, Workspace

        team_owner = create_test_user(prefix="ws-team-owner")
        team = create_test_organization(owner=team_owner, prefix="ws-team")
        OrganizationMember.objects.create(
            organization=team,
            user=self.owner,
            role="viewer",
        )

        workspace, created = self.service.ensure_home_workspace(
            organization_id=team.id,
            device_id=self.device.id,
            working_dir="/Users/me/TabTin/Team/Home",
        )

        self.assertTrue(created)
        self.assertEqual(workspace.organization_id, team.id)
        self.assertEqual(workspace.created_by_id, self.owner.id)
        self.assertEqual(workspace.kind, Workspace.Kind.HOME)

    def test_workspace_access_requires_current_organization_membership(self):
        from apps.tabtinspace.models import OrganizationMember
        from apps.tabtinspace.services.base import ServiceError

        team_owner = create_test_user(prefix="ws-revoked-owner")
        team = create_test_organization(owner=team_owner, prefix="ws-revoked")
        membership = OrganizationMember.objects.create(
            organization=team,
            user=self.owner,
            role="editor",
        )
        workspace = self.service.create_workspace(
            organization_id=team.id,
            device_id=self.device.id,
            working_dir="/Users/me/team-project",
        )
        membership.delete()

        self.assertEqual(list(self.service.list_workspaces()), [])
        with self.assertRaises(ServiceError) as ctx:
            self.service.get_workspace(workspace.id)
        self.assertEqual(ctx.exception.code, "PERMISSION_DENIED")

        with self.assertRaises(ServiceError) as ctx:
            self.service.set_trust_status(workspace.id, "trusted")
        self.assertEqual(ctx.exception.code, "PERMISSION_DENIED")

        with self.assertRaises(ServiceError) as ctx:
            self.service.bind_device(workspace.id, self.device.id)
        self.assertEqual(ctx.exception.code, "PERMISSION_DENIED")

    def test_ensure_home_rejects_deleting_organization(self):
        from apps.tabtinspace.models import Organization
        from apps.tabtinspace.services.base import ServiceError

        self.organization.status = Organization.Status.DELETING
        self.organization.save(update_fields=["status"])

        with self.assertRaises(ServiceError) as ctx:
            self.service.ensure_home_workspace(
                organization_id=self.organization.id,
                device_id=self.device.id,
                working_dir="/Users/me/TabTin/Home",
            )

        self.assertEqual(ctx.exception.code, "PERMISSION_DENIED")

    def test_bind_device_uses_workspace_as_truth_and_syncs_legacy_shell(self):
        from apps.tabtinspace.models import Space

        workspace = self.service.create_workspace(
            organization_id=self.organization.id,
            device_id=self.device.id,
            working_dir="/Users/me/bind",
        )
        shell = Space.objects.create(
            id=workspace.id,
            organization=self.organization,
            type=Space.SpaceType.WORKSPACE,
            name="Legacy Shell",
            working_dir=workspace.working_dir,
            normalized_working_dir=workspace.normalized_working_dir,
        )

        result = self.service.bind_device(
            workspace.id,
            self.device.id,
            expected_version=shell.config_version,
        )

        shell.refresh_from_db()
        self.assertEqual(result.device_id, self.device.id)
        self.assertEqual(shell.control_device_id, self.device.id)
        self.assertEqual(shell.bound_device_id, self.device.id)
        self.assertEqual(shell.config_version, 1)

    def test_bind_device_rejects_silent_workspace_migration(self):
        from apps.tabtinspace.services.base import ServiceError

        workspace = self.service.create_workspace(
            organization_id=self.organization.id,
            device_id=self.device.id,
            working_dir="/Users/me/locked",
        )
        other_device = _make_device(
            self.organization,
            self.owner,
            prefix="ws-bind-other",
        )

        with self.assertRaises(ServiceError) as raised:
            self.service.bind_device(workspace.id, other_device.id)

        self.assertEqual(raised.exception.code, "WORKSPACE_DEVICE_BINDING_LOCKED")
        workspace.refresh_from_db()
        self.assertEqual(workspace.device_id, self.device.id)

    def test_bind_device_owner_can_recover_offline_binding(self):
        from apps.tabtinspace.models import Space
        from apps.tabtinspace.services.base import ServiceError

        workspace = self.service.create_workspace(
            organization_id=self.organization.id,
            device_id=self.device.id,
            working_dir="/Users/me/recover",
        )
        self.device.status = "offline"
        self.device.save(update_fields=["status"])
        online_device = _make_device(
            self.organization,
            self.owner,
            prefix="ws-bind-recover",
        )
        shell = Space.objects.create(
            id=workspace.id,
            organization=self.organization,
            type=Space.SpaceType.WORKSPACE,
            name="Legacy Shell",
            working_dir=workspace.working_dir,
            normalized_working_dir=workspace.normalized_working_dir,
            control_device=self.device,
            bound_device=self.device,
        )

        with self.assertRaises(ServiceError) as blocked:
            self.service.bind_device(workspace.id, online_device.id)
        self.assertEqual(blocked.exception.code, "WORKSPACE_DEVICE_BINDING_LOCKED")

        result = self.service.bind_device(
            workspace.id,
            online_device.id,
            expected_version=shell.config_version,
            recover_offline_binding=True,
        )
        workspace.refresh_from_db()
        shell.refresh_from_db()
        self.assertEqual(result.device_id, online_device.id)
        self.assertEqual(workspace.device_id, online_device.id)
        self.assertEqual(shell.control_device_id, online_device.id)
        self.assertEqual(shell.bound_device_id, online_device.id)


class WorkspaceBackfillMigrationTests(TransactionTestCase):
    """0097：Space→Workspace 一次性生成的口径验证（id 复用是核心断言）。"""

    databases = {"default", "postgresql"}

    def setUp(self):
        post_save.disconnect(create_default_organization, sender=User)
        self.owner = create_test_user(prefix="ws-mig")
        self.organization = create_test_organization(owner=self.owner, prefix="ws-mig")
        self.device = _make_device(self.organization, self.owner, prefix="ws-mig")

    def tearDown(self):
        from apps.tabtinspace.tests.fixtures import cleanup_test_organization

        cleanup_test_organization(self.organization, delete_user=True)
        post_save.connect(create_default_organization, sender=User)

    def _run_forwards(self):
        alias = postgres_app_db_alias()
        with connections[alias].schema_editor() as schema_editor:
            _workspace_backfill(global_apps, schema_editor)

    def _make_space(self, name, working_dir, *, device=None, agent=None, **extra):
        from apps.tabtinspace.models import Space

        return Space.objects.create(
            organization=self.organization,
            type=Space.SpaceType.WORKSPACE,
            name=name,
            status=extra.pop("status", "active"),
            control_device=device,
            working_dir=working_dir,
            normalized_working_dir=working_dir,
            working_dir_type="code" if working_dir else "",
            agent=agent,
            **extra,
        )

    def test_id_reuse_and_field_carryover(self):
        from apps.tabtinspace.models import Agent, Workspace

        agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.owner,
            name="mig agent",
            type="bot",
            is_active=True,
            agent_config={"git_status": {"is_repo": True, "branch": "main"}},
        )
        space = self._make_space("现场A", "/Users/me/proj-a", device=self.device, agent=agent)

        self._run_forwards()

        ws = Workspace.objects.get(id=space.id)  # ← id 复用
        self.assertEqual(ws.device_id, self.device.id)
        self.assertEqual(ws.normalized_working_dir, "/Users/me/proj-a")
        self.assertEqual(ws.name, "现场A")
        self.assertEqual(ws.kind, "standard")  # M-6：不转生 home
        self.assertEqual(ws.created_by_id, self.owner.id)  # agent.owner_user
        # git_status 归位（PR1 TODO 收口）
        self.assertEqual(ws.git_status, {"is_repo": True, "branch": "main"})

    def test_unbound_placeholder_dropped(self):
        from apps.tabtinspace.models import Workspace

        placeholder = self._make_space("未绑定默认", "", device=None)
        self._run_forwards()
        self.assertFalse(Workspace.objects.filter(id=placeholder.id).exists())

    def test_device_dir_conflict_prefers_active_row(self):
        from apps.tabtinspace.models import Workspace

        archived = self._make_space(
            "归档重复", "/Users/me/dup-dir", device=self.device, is_archived=True,
        )
        active = self._make_space("活跃现场", "/Users/me/dup-dir", device=self.device)

        self._run_forwards()

        self.assertTrue(Workspace.objects.filter(id=active.id).exists())
        self.assertFalse(Workspace.objects.filter(id=archived.id).exists())

    def test_chat_session_backfill_sql(self):
        """0060 回填：workspace_id = space_id 同值拷贝（id 复用使其零成本）；
        team_space / 无对应 Workspace 行的会话保持 NULL。"""
        from apps.chat.conversation.models import ChatSession
        from apps.tabtinspace.models import Agent, Space, Workspace

        agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.owner,
            name="session migration agent",
            type="bot",
        )
        space = self._make_space(
            "会话现场",
            "/Users/me/sess-dir",
            device=self.device,
            agent=agent,
        )
        duplicate_space = self._make_space(
            "归档重复现场",
            "/Users/me/sess-dir",
            device=self.device,
            agent=agent,
            is_archived=True,
        )
        team_space = Space.objects.create(
            organization=self.organization,
            type=Space.SpaceType.TEAM_SPACE,
            name="ws-mig team",
            status="active",
            execution_space=space,
        )
        self._run_forwards()
        self.assertTrue(Workspace.objects.filter(id=space.id).exists())

        ws_session = ChatSession.objects.create(
            user=self.owner,
            organization_id=str(self.organization.id),
            space_id=space.id,
            title="s1",
            status="active",
        )
        team_session = ChatSession.objects.create(
            user=self.owner,
            organization_id=str(self.organization.id),
            space_id=team_space.id,
            title="s2",
            status="active",
        )
        duplicate_session = ChatSession.objects.create(
            user=self.owner,
            organization_id=str(self.organization.id),
            space_id=duplicate_space.id,
            title="s3",
            status="active",
        )
        from apps.tracker.models import Tracker
        tracker = Tracker.objects.create(
            organization_id=self.organization.id,
            space_id=team_space.id,
            agent_id=agent.id,
            name="migration tracker",
            description="migration tracker",
            trigger_type="manual",
            trigger_config={},
            status="active",
            created_by_id=self.owner.id,
        )
        try:
            migration = importlib.import_module(
                "apps.chat.conversation.migrations.0062_agent_workspace_turn_binding"
            )
            alias = postgres_app_db_alias()
            with connections[alias].schema_editor() as schema_editor:
                migration.backfill_bindings(global_apps, schema_editor)
                tracker_migration = importlib.import_module(
                    "apps.tracker.migrations.0040_tracker_workspace_binding"
                )
                tracker_migration.backfill_workspace(global_apps, schema_editor)

            ws_session.refresh_from_db()
            team_session.refresh_from_db()
            duplicate_session.refresh_from_db()
            tracker.refresh_from_db()
            self.assertEqual(ws_session.workspace_id, space.id)
            self.assertEqual(team_session.workspace_id, space.id)
            self.assertEqual(duplicate_session.workspace_id, space.id)
            self.assertEqual(ws_session.agent_id, agent.id)
            self.assertEqual(team_session.agent_id, agent.id)
            self.assertEqual(duplicate_session.agent_id, agent.id)
            self.assertEqual(tracker.workspace_id, space.id)
        finally:
            tracker.delete()
            ChatSession.objects.filter(
                id__in=[ws_session.id, team_session.id, duplicate_session.id],
            ).delete()
            team_space.delete()
