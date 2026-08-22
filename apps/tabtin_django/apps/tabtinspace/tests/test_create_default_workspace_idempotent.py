"""#4512：创建「默认 Workspace」对本机设备必须幂等。"""

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import TestCase

from apps.tabtinspace.models import Device, Organization, OrganizationMember, Space
from apps.tabtinspace.services.onboarding_defaults import DEFAULT_ONBOARDING_SPACE_NAME
from apps.tabtinspace.services.space_service import SpaceService
from apps.tabtinspace.signals import create_default_organization

User = get_user_model()


class _DisconnectDefaultOrganizationSignal:
    def __enter__(self):
        post_save.disconnect(receiver=create_default_organization, sender=User)
        return self

    def __exit__(self, exc_type, exc, tb):
        post_save.connect(receiver=create_default_organization, sender=User)


class CreateDefaultLocalWorkspaceIdempotentTests(TestCase):
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
        self.owner = User.objects.create_user(
            username="idem_owner",
            email="idem-owner@test.com",
            password="testpass123",
        )
        self.organization = Organization.objects.create(
            name="Idempotent Org",
            owner_id=self.owner.id,
            is_default=False,
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.owner,
            role="owner",
        )
        self.device = Device.objects.create(
            organization=self.organization,
            user=self.owner,
            name="Owner Device",
            device_type="electron",
            role="control",
            fingerprint="idem-owner-fp",
        )
        self.service = SpaceService(user=self.owner)

    def test_second_default_workspace_reuses_existing_local_home(self):
        first = self.service.create_space(
            organization_id=self.organization.id,
            name=DEFAULT_ONBOARDING_SPACE_NAME,
            device_id=self.device.id,
            working_dir="/Users/me/TabTin/Idempotent Org/默认 Workspace",
            working_dir_type="mixed",
        )
        second = self.service.create_space(
            organization_id=self.organization.id,
            name=DEFAULT_ONBOARDING_SPACE_NAME,
            device_id=self.device.id,
            working_dir="/Users/me/TabTin/Idempotent Org/默认 Workspace-2",
            working_dir_type="mixed",
        )

        self.assertEqual(first.id, second.id)
        self.assertEqual(
            Space.objects.filter(
                organization=self.organization,
                control_device=self.device,
                name=DEFAULT_ONBOARDING_SPACE_NAME,
                is_archived=False,
            ).count(),
            1,
        )

    def test_named_workspace_still_creates_alongside_default_home(self):
        home = self.service.create_space(
            organization_id=self.organization.id,
            name=DEFAULT_ONBOARDING_SPACE_NAME,
            device_id=self.device.id,
            working_dir="/Users/me/TabTin/Idempotent Org/默认 Workspace",
            working_dir_type="mixed",
        )
        other = self.service.create_space(
            organization_id=self.organization.id,
            name="市场专家",
            device_id=self.device.id,
            working_dir="/Users/me/TabTin/Idempotent Org/市场专家",
            working_dir_type="mixed",
        )

        self.assertNotEqual(home.id, other.id)
        self.assertEqual(
            Space.objects.filter(
                organization=self.organization,
                control_device=self.device,
                is_archived=False,
                type=Space.SpaceType.WORKSPACE,
                project_id__isnull=True,
            ).count(),
            2,
        )
