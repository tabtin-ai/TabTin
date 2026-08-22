from types import SimpleNamespace
from unittest.mock import Mock, patch
from uuid import uuid4

from django.test import SimpleTestCase

from apps.tabtinspace.services.base import ServiceError
from apps.tabtinspace.services.organization_service import OrganizationService


class OrganizationTransferOwnershipUnitTests(SimpleTestCase):
    def test_transfer_rejects_target_when_ownership_policy_is_full(self):
        organization_id = uuid4()
        owner_id = "owner-1"
        target_id = "target-1"
        organization = SimpleNamespace(
            id=organization_id,
            owner_id=owner_id,
            type="team",
            save=Mock(),
        )
        target_member = SimpleNamespace(
            user_id=target_id,
            role="editor",
            save=Mock(),
        )
        owner_member = SimpleNamespace(
            user_id=owner_id,
            role="owner",
            save=Mock(),
        )
        service = OrganizationService(user=SimpleNamespace(id=owner_id))

        with (
            patch.object(service, "assert_team_organization"),
            patch(
                "apps.tabtinspace.services.organization_service.Organization.objects.select_for_update"
            ) as organization_lock,
            patch(
                "apps.tabtinspace.services.organization_service.OrganizationMember.objects.select_for_update"
            ) as member_lock,
            patch(
                "apps.tabtinspace.services.organization_service.User.objects.using"
            ) as user_manager,
            patch(
                "apps.platform_config.services.PlatformRuntimeConfigService.get_organization_create_policy",
                return_value=SimpleNamespace(
                    allowed=False,
                    message="organization limit reached",
                ),
            ),
            patch("apps.tabtinspace.models.SpaceMembership.objects.filter"),
            patch("apps.tabtinspace.services.organization_service.transaction.on_commit"),
            self.assertRaises(ServiceError) as raised,
        ):
            organization_lock.return_value.get.return_value = organization
            member_lock.return_value.get.side_effect = [target_member, owner_member]
            user_manager.return_value.select_for_update.return_value.get.return_value = (
                SimpleNamespace(id=target_id)
            )
            OrganizationService.transfer_ownership.__wrapped__(
                service,
                organization_id,
                target_id,
            )

        self.assertEqual(raised.exception.code, "ORGANIZATION_LIMIT_EXCEEDED")
        organization.save.assert_not_called()
        target_member.save.assert_not_called()
        owner_member.save.assert_not_called()
