"""#3791 根因 1：设备删除对 workspace 绑定的保护。

设备是某些活跃 workspace 的执行设备时，直接删除会把绑定静默清空（SET_NULL），
随后其他设备的开箱即用自愈会无声接管、目录被换成别处路径。删除前拦截：

- 未 force：删除绑定着活跃 workspace 的设备 → DEVICE_BOUND_TO_WORKSPACE(409)，设备仍在。
- force=True：显式确认后允许删除。
- 未绑定任何 workspace 的设备：正常删除，不受影响。
"""
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import TestCase

from apps.tabtinspace.models import Device, OrganizationMember
from apps.tabtinspace.services.base import ServiceError
from apps.tabtinspace.services.device_service import DeviceService
from apps.tabtinspace.signals import create_default_organization
from apps.tabtinspace.tests.fixtures import (
    create_test_agent,
    create_test_bot_space,
    create_test_organization,
)

User = get_user_model()


class DeleteDeviceGuardTests(TestCase):
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
        suffix = uuid4().hex[:8]
        self.owner = user_manager.create_user(
            username=f"devdel_{suffix}",
            email=f"devdel-{suffix}@tabtin.test",
            password="TabtinTest#2026",
        )
        User.objects.db_manager("postgresql").create_user(
            id=self.owner.id,
            username=f"devdel_{suffix}",
            email=f"devdel-{suffix}@tabtin.test",
            password="TabtinTest#2026",
        )
        self.organization = create_test_organization(owner=self.owner, prefix="devdel")
        OrganizationMember.objects.get_or_create(
            organization=self.organization,
            user_id=self.owner.id,
            defaults={"role": "owner"},
        )
        self.device = Device.objects.create(
            organization=self.organization,
            user=self.owner,
            name="Owner Mac",
            device_type="electron",
            role="control",
            fingerprint=f"devdel-{uuid4().hex[:8]}",
        )
        self.service = DeviceService(user=self.owner)

    def _bind_workspace(self):
        agent = create_test_agent(
            organization=self.organization,
            name="Bound Agent",
            prefix="devdel_agent",
            owner_user=self.owner,
            working_dir="/Users/me/proj",
            working_dir_type="code",
            control_device=self.device,
            bound_device=self.device,
        )
        return create_test_bot_space(
            organization=self.organization,
            agent=agent,
            name="Bound Space",
            control_device=self.device,
            bound_device=self.device,
            working_dir="/Users/me/proj",
            normalized_working_dir="/Users/me/proj",
            working_dir_type="code",
        )

    def test_delete_bound_device_without_force_rejected(self):
        self._bind_workspace()
        with self.assertRaises(ServiceError) as ctx:
            self.service.delete_device(self.device.id)
        self.assertEqual(ctx.exception.code, "DEVICE_BOUND_TO_WORKSPACE")
        self.assertEqual(ctx.exception.status, 409)
        self.assertTrue(Device.objects.filter(id=self.device.id).exists())

    def test_delete_bound_device_with_force_allowed(self):
        self._bind_workspace()
        result = self.service.delete_device(self.device.id, force=True)
        self.assertTrue(result)
        self.assertFalse(Device.objects.filter(id=self.device.id).exists())

    def test_delete_unbound_device_allowed(self):
        result = self.service.delete_device(self.device.id)
        self.assertTrue(result)
        self.assertFalse(Device.objects.filter(id=self.device.id).exists())
