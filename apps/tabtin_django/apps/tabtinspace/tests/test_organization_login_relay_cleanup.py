import uuid

from django.contrib.auth import get_user_model
from django.test import TransactionTestCase

from apps.login_relay.models import LoginRelayPackage
from apps.tabtinspace.models import Device, Organization, Workspace
from apps.tabtinspace.services.organization_service import OrganizationService


User = get_user_model()


class OrganizationLoginRelayCleanupTests(TransactionTestCase):
    def test_deleting_workspace_removes_login_relay_packages_first(self):
        suffix = uuid.uuid4().hex[:10]
        user = User.objects.create_user(
            username=f"organization_relay_cleanup_{suffix}",
            email=f"organization_relay_cleanup_{suffix}@example.com",
            password="test-pass-123",
        )
        organization = Organization.objects.create(
            name=f"Relay cleanup {suffix}",
            owner=user,
        )
        device = Device.objects.create(
            organization=organization,
            user=user,
            name="Relay cleanup device",
            fingerprint=f"relay-cleanup-device-{suffix}",
            status="online",
        )
        workspace = Workspace.objects.create(
            organization=organization,
            device=device,
            name="Relay cleanup workspace",
            working_dir=f"/tmp/relay-cleanup-{suffix}",
            normalized_working_dir=f"/tmp/relay-cleanup-{suffix}",
            created_by=user,
        )
        package = LoginRelayPackage.objects.create(
            user=user,
            space=workspace,
            target_device=device,
            domain="login.example.com",
            encrypted_payload=[],
        )

        OrganizationService._delete_space_rows([workspace.id])

        self.assertFalse(Workspace.objects.filter(id=workspace.id).exists())
        self.assertFalse(LoginRelayPackage.objects.filter(id=package.id).exists())
