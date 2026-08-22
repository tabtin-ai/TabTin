"""update_agent working_dir 变更校验。

覆盖：
  - 同 Team + 同执行设备下，变更到已绑定目录 → WORKING_DIR_CONFLICT
  - 变更到未占用目录 → Agent + Space 同步 normalized_working_dir
  - 路径尾部斜杠归一化后与已有 Space 冲突
"""
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import TestCase

from apps.tabtinspace.models import Device, Space, OrganizationMember
from apps.tabtinspace.services.agent_service import AgentService
from apps.tabtinspace.services.base import ServiceError
from apps.tabtinspace.services.space_service import SpaceService
from apps.tabtinspace.signals import create_default_organization
from apps.tabtinspace.tests.fixtures import (
    create_test_agent,
    create_test_bot_space,
    create_test_organization,
)

User = get_user_model()


class _DisconnectDefaultOrganizationSignal:
    def __enter__(self):
        post_save.disconnect(receiver=create_default_organization, sender=User)
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        post_save.connect(receiver=create_default_organization, sender=User)
        return False


class UpdateAgentWorkingDirTests(TestCase):
    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls._signal_guard = _DisconnectDefaultOrganizationSignal()
        cls._signal_guard.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls._signal_guard.__exit__(None, None, None)
        super().tearDownClass()

    def setUp(self):
        user_manager = User.objects.db_manager("default")
        suffix = uuid4().hex[:8]
        self.owner = user_manager.create_user(
            username=f"wd_upd_{suffix}",
            email=f"wd-upd-{suffix}@tabtin.test",
            password="TabtinTest#2026",
        )
        User.objects.db_manager("postgresql").create_user(
            id=self.owner.id,
            username=f"wd_upd_{suffix}",
            email=f"wd-upd-{suffix}@tabtin.test",
            password="TabtinTest#2026",
        )
        self.organization = create_test_organization(owner=self.owner, prefix="wd_upd")
        self.device = Device.objects.create(
            organization=self.organization,
            user=self.owner,
            name="Owner Mac",
            device_type="electron",
            role="control",
            fingerprint=f"wd-upd-{uuid4().hex[:8]}",
        )
        OrganizationMember.objects.get_or_create(
            organization=self.organization,
            user_id=self.owner.id,
            defaults={"role": "owner"},
        )
        self.agent_a = create_test_agent(
            organization=self.organization,
            name="Agent A",
            prefix="wd_upd_a",
            owner_user=self.owner,
            working_dir="/Users/me/proj-a",
            working_dir_type="code",
            control_device=self.device,
            bound_device=self.device,
        )
        self.space_a = create_test_bot_space(
            organization=self.organization,
            agent=self.agent_a,
            name="Space A",
            control_device=self.device,
            bound_device=self.device,
            working_dir="/Users/me/proj-a",
            normalized_working_dir="/Users/me/proj-a",
            working_dir_type="code",
        )
        self.agent_b = create_test_agent(
            organization=self.organization,
            name="Agent B",
            prefix="wd_upd_b",
            owner_user=self.owner,
            working_dir="/Users/me/proj-b",
            working_dir_type="mixed",
            control_device=self.device,
            bound_device=self.device,
        )
        self.space_b = create_test_bot_space(
            organization=self.organization,
            agent=self.agent_b,
            name="Space B",
            control_device=self.device,
            bound_device=self.device,
            working_dir="/Users/me/proj-b",
            normalized_working_dir="/Users/me/proj-b",
            working_dir_type="mixed",
        )
        self.service = AgentService(user=self.owner)

    def test_update_to_available_dir_syncs_space(self):
        updated = self.service.update_agent(
            self.agent_b.id,
            working_dir="/Users/me/proj-c",
            working_dir_type="doc",
            device_fingerprint=self.device.fingerprint,
        )
        self.assertEqual(updated.working_dir, "/Users/me/proj-c")
        self.space_b.refresh_from_db()
        self.assertEqual(self.space_b.working_dir, "/Users/me/proj-c")
        self.assertEqual(self.space_b.normalized_working_dir, "/Users/me/proj-c")
        self.assertEqual(self.space_b.working_dir_type, "doc")

    def test_update_to_bound_dir_raises_conflict(self):
        with self.assertRaises(ServiceError) as ctx:
            self.service.update_agent(
                self.agent_b.id,
                working_dir="/Users/me/proj-a",
                working_dir_type="mixed",
                device_fingerprint=self.device.fingerprint,
            )
        self.assertEqual(ctx.exception.code, "WORKING_DIR_CONFLICT")
        self.agent_b.refresh_from_db()
        self.assertEqual(self.agent_b.working_dir, "/Users/me/proj-b")

    def test_update_with_trailing_slash_conflicts_with_existing(self):
        with self.assertRaises(ServiceError) as ctx:
            self.service.update_agent(
                self.agent_b.id,
                working_dir="/Users/me/proj-a/",
                device_fingerprint=self.device.fingerprint,
            )
        self.assertEqual(ctx.exception.code, "WORKING_DIR_CONFLICT")

    def test_canonical_normalization_on_update(self):
        updated = self.service.update_agent(
            self.agent_b.id,
            working_dir="/Users/me/new-dir/",
            working_dir_type="code",
            device_fingerprint=self.device.fingerprint,
        )
        self.assertEqual(updated.working_dir, "/Users/me/new-dir")
        self.space_b.refresh_from_db()
        self.assertEqual(
            self.space_b.normalized_working_dir,
            SpaceService._canonical_working_dir("/Users/me/new-dir/"),
        )

    # ──  根因 3：working_dir 变更的服务端设备校验 ──────────────────

    def test_change_working_dir_without_fingerprint_rejected(self):
        """已绑定执行设备的 workspace，不带设备身份的目录变更 → 403 MISMATCH。"""
        with self.assertRaises(ServiceError) as ctx:
            self.service.update_agent(
                self.agent_b.id,
                working_dir="/Users/me/proj-elsewhere",
                working_dir_type="code",
            )
        self.assertEqual(ctx.exception.code, "WORKSPACE_DEVICE_MISMATCH")
        self.assertEqual(ctx.exception.status, 403)
        self.agent_b.refresh_from_db()
        self.assertEqual(self.agent_b.working_dir, "/Users/me/proj-b")

    def test_change_working_dir_from_other_device_rejected(self):
        """非 control 设备（不同 fingerprint）改目录 → 403，目录不动。"""
        other_device = Device.objects.create(
            organization=self.organization,
            user=self.owner,
            name="Owner Second Mac",
            device_type="electron",
            role="control",
            fingerprint=f"wd-upd-other-{uuid4().hex[:8]}",
        )
        with self.assertRaises(ServiceError) as ctx:
            self.service.update_agent(
                self.agent_b.id,
                working_dir="/Users/me/proj-elsewhere",
                working_dir_type="code",
                device_fingerprint=other_device.fingerprint,
            )
        self.assertEqual(ctx.exception.code, "WORKSPACE_DEVICE_MISMATCH")
        self.agent_b.refresh_from_db()
        self.assertEqual(self.agent_b.working_dir, "/Users/me/proj-b")

    def test_change_working_dir_from_control_device_allowed(self):
        """绑定设备本机（fingerprint 匹配）改目录 → 放行并同步 Space。"""
        updated = self.service.update_agent(
            self.agent_b.id,
            working_dir="/Users/me/proj-moved",
            working_dir_type="code",
            device_fingerprint=self.device.fingerprint,
        )
        self.assertEqual(updated.working_dir, "/Users/me/proj-moved")
        self.space_b.refresh_from_db()
        self.assertEqual(self.space_b.working_dir, "/Users/me/proj-moved")

    def test_non_working_dir_update_does_not_require_fingerprint(self):
        """只改名字等非目录字段，不受设备校验影响（不需要 fingerprint）。"""
        updated = self.service.update_agent(
            self.agent_b.id,
            name="Agent B Renamed",
        )
        self.assertEqual(updated.name, "Agent B Renamed")
        self.agent_b.refresh_from_db()
        self.assertEqual(self.agent_b.working_dir, "/Users/me/proj-b")
