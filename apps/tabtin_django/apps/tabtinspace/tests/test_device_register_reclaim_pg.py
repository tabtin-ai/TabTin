"""#5415 reclaim：PostgreSQL 真库验证唯一约束、跨组织归属、主键保留。"""

from __future__ import annotations

from uuid import uuid4

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import TestCase

from apps.tabtinspace.models import Device, OrganizationMember, Workspace
from apps.tabtinspace.services.device_service import DeviceService
from apps.tabtinspace.signals import create_default_organization
from apps.tabtinspace.tests.fixtures import (
    create_test_agent,
    create_test_bot_space,
    create_test_organization,
)

User = get_user_model()


class DeviceRegisterReclaimPgTests(TestCase):
    databases = {"default"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        post_save.disconnect(receiver=create_default_organization, sender=User)

    @classmethod
    def tearDownClass(cls):
        post_save.connect(receiver=create_default_organization, sender=User)
        super().tearDownClass()

    def setUp(self):
        suffix = uuid4().hex[:8]
        self.owner = User.objects.create_user(
            username=f"reclaim_{suffix}",
            email=f"reclaim-{suffix}@tabtin.test",
            password="TabtinTest#2026",
        )
        self.org_a = create_test_organization(owner=self.owner, prefix=f"reclaim_a_{suffix}")
        self.org_b = create_test_organization(owner=self.owner, prefix=f"reclaim_b_{suffix}")
        for org in (self.org_a, self.org_b):
            OrganizationMember.objects.get_or_create(
                organization=org,
                user_id=self.owner.id,
                defaults={"role": "owner"},
            )
        self.old_fp = f"electron-legacy-{suffix}"
        self.new_fp = "electron-" + ("c" * 32)
        self.machine_key = "c" * 32
        self.device = Device.objects.create(
            organization=self.org_a,
            user=self.owner,
            name="Owner Laptop",
            device_type="electron",
            role="control",
            fingerprint=self.old_fp,
            status="offline",
        )
        self.service = DeviceService(user=self.owner)

    def test_previous_fingerprint_reclaim_keeps_id_and_organization(self):
        self.device.machine_key = self.machine_key
        self.device.save(update_fields=["machine_key"])

        result = self.service.register_device(
            organization_id=self.org_b.id,
            fingerprint=self.new_fp,
            device_type="electron",
            name="Owner Laptop (win32)",
            machine_key=self.machine_key,
            previous_fingerprint=self.old_fp,
        )
        self.assertIsNotNone(result)
        self.assertEqual(result.id, self.device.id)
        self.assertEqual(result.fingerprint, self.new_fp)
        self.assertEqual(result.machine_key, self.machine_key)
        # 跨 org 注册不迁移归属
        self.assertEqual(result.organization_id, self.org_a.id)
        self.assertEqual(Device.objects.filter(fingerprint=self.old_fp).count(), 0)
        self.assertEqual(Device.objects.filter(fingerprint=self.new_fp).count(), 1)

    def test_previous_fingerprint_reclaims_an_offline_legacy_device_without_machine_key(self):
        result = self.service.register_device(
            organization_id=self.org_a.id,
            fingerprint=self.new_fp,
            device_type="electron",
            name="Reinstalled Legacy Laptop",
            machine_key=self.machine_key,
            previous_fingerprint=self.old_fp,
        )

        self.assertEqual(result.id, self.device.id)
        self.assertEqual(result.fingerprint, self.new_fp)
        self.assertEqual(result.machine_key, self.machine_key)
        self.assertEqual(Device.objects.filter(user=self.owner, device_type="electron").count(), 1)

    def test_previous_fingerprint_refuses_an_online_legacy_device(self):
        self.device.status = "online"
        self.device.save(update_fields=["status"])

        result = self.service.register_device(
            organization_id=self.org_a.id,
            fingerprint=self.new_fp,
            device_type="electron",
            name="Reinstalled Legacy Laptop",
            machine_key=self.machine_key,
            previous_fingerprint=self.old_fp,
        )

        self.assertNotEqual(result.id, self.device.id)
        self.device.refresh_from_db()
        self.assertEqual(self.device.fingerprint, self.old_fp)
        self.assertEqual(self.device.status, "online")
        self.assertEqual(Device.objects.filter(user=self.owner, device_type="electron").count(), 2)

    def test_recovery_fingerprint_refuses_an_online_legacy_device(self):
        self.device.machine_key = self.machine_key
        self.device.status = "online"
        self.device.save(update_fields=["machine_key", "status"])

        result = self.service.register_device(
            organization_id=self.org_a.id,
            fingerprint=self.new_fp,
            device_type="electron",
            name="Reinstalled Laptop",
            machine_key=self.machine_key,
            recovery_fingerprints=[self.old_fp],
        )

        self.assertNotEqual(result.id, self.device.id)
        self.device.refresh_from_db()
        self.assertEqual(self.device.fingerprint, self.old_fp)
        self.assertEqual(self.device.status, "online")
        self.assertEqual(Device.objects.filter(user=self.owner, device_type="electron").count(), 2)

    def test_recovery_fingerprint_refuses_a_different_runtime_profile(self):
        self.device.machine_key = "different-runtime-profile"
        self.device.save(update_fields=["machine_key"])

        result = self.service.register_device(
            organization_id=self.org_a.id,
            fingerprint=self.new_fp,
            device_type="electron",
            name="Reinstalled Laptop",
            machine_key=self.machine_key,
            recovery_fingerprints=[self.old_fp],
        )

        self.assertNotEqual(result.id, self.device.id)
        self.device.refresh_from_db()
        self.assertEqual(self.device.fingerprint, self.old_fp)
        self.assertEqual(Device.objects.filter(user=self.owner, device_type="electron").count(), 2)

    def test_machine_key_reclaim_updates_fingerprint_without_dup_row(self):
        self.device.machine_key = self.machine_key
        self.device.save(update_fields=["machine_key"])
        result = self.service.register_device(
            organization_id=self.org_b.id,
            fingerprint=self.new_fp,
            device_type="electron",
            name="Owner Laptop (win32)",
            machine_key=self.machine_key,
        )
        self.assertEqual(result.id, self.device.id)
        self.assertEqual(Device.objects.filter(user=self.owner, device_type="electron").count(), 1)
        self.assertEqual(result.organization_id, self.org_a.id)

    def test_machine_key_reclaim_refuses_an_online_legacy_device(self):
        self.device.machine_key = self.machine_key
        self.device.status = "online"
        self.device.save(update_fields=["machine_key", "status"])

        result = self.service.register_device(
            organization_id=self.org_a.id,
            fingerprint=self.new_fp,
            device_type="electron",
            name="Reinstalled Laptop",
            machine_key=self.machine_key,
        )

        self.assertNotEqual(result.id, self.device.id)
        self.device.refresh_from_db()
        self.assertEqual(self.device.fingerprint, self.old_fp)
        self.assertEqual(self.device.status, "online")
        self.assertEqual(Device.objects.filter(user=self.owner, device_type="electron").count(), 2)

    def test_machine_key_reclaim_refuses_ambiguous_online_and_offline_legacy_devices(self):
        self.device.machine_key = self.machine_key
        self.device.save(update_fields=["machine_key"])
        online_device = Device.objects.create(
            organization=self.org_a,
            user=self.owner,
            name="Still Running Laptop",
            device_type="electron",
            role="control",
            fingerprint=f"electron-online-{uuid4().hex[:8]}",
            machine_key=self.machine_key,
            status="online",
        )

        result = self.service.register_device(
            organization_id=self.org_a.id,
            fingerprint=self.new_fp,
            device_type="electron",
            name="Reinstalled Laptop",
            machine_key=self.machine_key,
        )

        self.assertNotIn(result.id, {self.device.id, online_device.id})
        self.device.refresh_from_db()
        online_device.refresh_from_db()
        self.assertEqual(self.device.fingerprint, self.old_fp)
        self.assertEqual(online_device.status, "online")
        self.assertEqual(Device.objects.filter(user=self.owner, device_type="electron").count(), 3)

    def test_machine_key_reclaim_refuses_multiple_offline_legacy_devices(self):
        self.device.machine_key = self.machine_key
        self.device.save(update_fields=["machine_key"])
        second_offline_device = Device.objects.create(
            organization=self.org_a,
            user=self.owner,
            name="Other Offline Installation",
            device_type="electron",
            role="control",
            fingerprint=f"electron-offline-{uuid4().hex[:8]}",
            machine_key=self.machine_key,
            status="offline",
        )

        result = self.service.register_device(
            organization_id=self.org_a.id,
            fingerprint=self.new_fp,
            device_type="electron",
            name="Reinstalled Laptop",
            machine_key=self.machine_key,
        )

        self.assertNotIn(result.id, {self.device.id, second_offline_device.id})
        self.device.refresh_from_db()
        second_offline_device.refresh_from_db()
        self.assertEqual(self.device.fingerprint, self.old_fp)
        self.assertEqual(second_offline_device.status, "offline")
        self.assertEqual(Device.objects.filter(user=self.owner, device_type="electron").count(), 3)

    def test_reclaim_merges_already_created_anchored_duplicate_and_its_bindings(self):
        self.device.machine_key = self.machine_key
        self.device.save(update_fields=["machine_key"])
        duplicate = Device.objects.create(
            organization=self.org_a,
            user=self.owner,
            name="Owner Laptop (anchored)",
            device_type="electron",
            role="control",
            fingerprint=self.new_fp,
            machine_key=self.machine_key,
            status="online",
        )
        agent = create_test_agent(
            organization=self.org_a,
            name="Auto-created Agent",
            prefix="reclaim_duplicate_agent",
            owner_user=self.owner,
        )
        space = create_test_bot_space(
            organization=self.org_a,
            agent=agent,
            name="Auto-created Workspace",
            device=duplicate,
            working_dir="/Users/owner/new-space",
            working_dir_type="mixed",
        )
        workspace = Workspace.objects.create(
            organization=self.org_a,
            device=duplicate,
            name="Auto-created Workspace",
            working_dir="/Users/owner/new-workspace",
            normalized_working_dir="/Users/owner/new-workspace",
            working_dir_type="mixed",
            created_by=self.owner,
        )

        reclaimed = self.service.register_device(
            organization_id=self.org_a.id,
            fingerprint=self.new_fp,
            device_type="electron",
            name="Owner Laptop (anchored)",
            machine_key=self.machine_key,
            previous_fingerprint=self.old_fp,
        )

        space.refresh_from_db()
        workspace.refresh_from_db()
        self.assertEqual(reclaimed.id, self.device.id)
        self.assertFalse(Device.objects.filter(id=duplicate.id).exists())
        self.assertEqual(workspace.device_id, self.device.id)
        self.assertEqual(space.device_id, self.device.id)

    def test_upgrade_preserves_execution_bindings_and_new_heartbeat(self):
        self.device.machine_key = self.machine_key
        self.device.save(update_fields=["machine_key"])
        agent = create_test_agent(
            organization=self.org_a,
            name="Upgrade Agent",
            prefix="reclaim_upgrade_agent",
            owner_user=self.owner,
        )
        space = create_test_bot_space(
            organization=self.org_a,
            agent=agent,
            name="Upgrade Space",
            device=self.device,
            working_dir="/Users/owner/project",
            working_dir_type="code",
        )
        workspace = Workspace.objects.create(
            organization=self.org_a,
            device=self.device,
            name="Upgrade Workspace",
            working_dir="/Users/owner/project-workspace",
            normalized_working_dir="/Users/owner/project-workspace",
            working_dir_type="code",
            created_by=self.owner,
        )

        upgraded = self.service.register_device(
            organization_id=self.org_a.id,
            fingerprint=self.new_fp,
            device_type="electron",
            name="Owner Laptop (win32)",
            machine_key=self.machine_key,
            previous_fingerprint=self.old_fp,
        )

        space.refresh_from_db()
        workspace.refresh_from_db()
        self.assertEqual(upgraded.id, self.device.id)
        self.assertEqual(workspace.device_id, self.device.id)
        self.assertEqual(space.device_id, self.device.id)
        self.assertEqual(space.device.fingerprint, self.new_fp)

        heartbeat_device = self.service.heartbeat(self.new_fp)
        self.assertIsNotNone(heartbeat_device)
        self.assertEqual(heartbeat_device.id, self.device.id)
        self.assertEqual(heartbeat_device.status, "online")
        self.assertIsNone(self.service.heartbeat(self.old_fp))
