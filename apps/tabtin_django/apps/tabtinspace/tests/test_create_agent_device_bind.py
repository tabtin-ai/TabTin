"""#890 B：创建路径设备绑定的 user-level 口径回归测试。

直接测 ``AgentService._prepare_agent_creation``（不走完整 create_agent_workspace，
避免触发与本特性无关的「规划 Collection.created_by 跨库 FK」测试环境问题）。

断言：
- 用户级设备（electron）即便注册在「另一个」organization，也能在创建时被绑定，
  且 runtime_type 同步锁定为 electron（与 bind_agent_device 首绑一致）。
- 非用户级设备（daemon）跨 organization 时**不**绑定，返回 device_bind_warning。
- 同 organization 的普通绑定不受影响（向后兼容）。
"""
from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import TestCase

from apps.tabtinspace.models import Device, Organization, OrganizationMember
from apps.tabtinspace.services.agent_service import AgentService
from apps.tabtinspace.signals import create_default_organization

User = get_user_model()


class CreateAgentDeviceBindTests(TestCase):
    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        post_save.disconnect(receiver=create_default_organization, sender=User)

    @classmethod
    def tearDownClass(cls):
        post_save.connect(receiver=create_default_organization, sender=User)
        super().tearDownClass()

    def setUp(self):
        user_manager = User.objects.db_manager("default")
        self.user = user_manager.create_user(
            username="dev_bind_owner",
            email="dev-bind@test.com",
            password="testpass123",
        )
        # 设备注册团队
        self.device_wt = Organization.objects.create(
            name="Device Home Team", owner_id=self.user.id, is_default=False,
        )
        OrganizationMember.objects.create(organization=self.device_wt, user=self.user, role="owner")
        # 另一个团队：助手将建在这里（跨团队）
        self.other_wt = Organization.objects.create(
            name="Other Team", owner_id=self.user.id, is_default=False,
        )
        OrganizationMember.objects.create(organization=self.other_wt, user=self.user, role="owner")

        self.electron = Device.objects.create(
            organization=self.device_wt, user=self.user,
            name="My Mac", device_type="electron", role="control",
            fingerprint="electron-test-fp-001", status="online",
        )
        self.svc = AgentService(user=self.user)

    def test_user_level_device_binds_cross_organization_at_creation(self):
        prepared = self._prepare(self.other_wt.id, "electron-test-fp-001")
        self.assertIsNotNone(prepared)
        self.assertEqual(prepared["control_device"], self.electron)
        self.assertEqual(prepared["bound_device"], self.electron)
        self.assertEqual(prepared["runtime_type"], "electron")
        self.assertIsNone(prepared["device_bind_warning"])

    def test_user_level_device_binds_same_organization(self):
        prepared = self._prepare(self.device_wt.id, "electron-test-fp-001")
        self.assertEqual(prepared["control_device"], self.electron)
        self.assertEqual(prepared["runtime_type"], "electron")
        self.assertIsNone(prepared["device_bind_warning"])

    def test_non_user_level_device_rejected_cross_organization(self):
        daemon = Device.objects.create(
            organization=self.device_wt, user=self.user,
            name="Server", device_type="daemon", role="control",
            fingerprint="daemon-test-fp-001", status="online",
        )
        prepared = self._prepare(self.other_wt.id, daemon.fingerprint)
        self.assertIsNone(prepared["bound_device"])
        self.assertEqual(prepared["runtime_type"], "")
        self.assertIsNotNone(prepared["device_bind_warning"])

    def test_non_user_level_device_binds_same_organization(self):
        daemon = Device.objects.create(
            organization=self.device_wt, user=self.user,
            name="Server2", device_type="daemon", role="control",
            fingerprint="daemon-test-fp-002", status="online",
        )
        prepared = self._prepare(self.device_wt.id, daemon.fingerprint)
        self.assertEqual(prepared["bound_device"], daemon)
        self.assertEqual(prepared["runtime_type"], "daemon")
        self.assertIsNone(prepared["device_bind_warning"])

    def test_unknown_fingerprint_no_bind_with_warning(self):
        prepared = self._prepare(self.other_wt.id, "nonexistent-fp")
        self.assertIsNone(prepared["bound_device"])
        self.assertEqual(prepared["runtime_type"], "")
        self.assertIsNotNone(prepared["device_bind_warning"])

    def _prepare(self, organization_id, device_fingerprint):
        return self.svc._prepare_agent_creation(
            organization_id, "Bind Test Bot", "bot",
            device_fingerprint=device_fingerprint,
            raise_on_error=True,
        )
