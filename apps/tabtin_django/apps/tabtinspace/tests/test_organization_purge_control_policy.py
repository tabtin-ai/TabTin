import uuid
from unittest.mock import Mock, patch

from django.test import SimpleTestCase

from apps.tabtinspace.services.organization_service import OrganizationService


class OrganizationPurgeControlPolicyTests(SimpleTestCase):
    def test_space_row_delete_removes_login_relay_before_raw_workspace_delete(self):
        workspace_id = uuid.uuid4()
        order: list[str] = []

        def manager_with_delete(name: str) -> Mock:
            manager = Mock()
            manager.filter.return_value.delete.side_effect = (
                lambda: order.append(name) or (1, {})
            )
            return manager

        memberships = manager_with_delete("memberships")
        app_settings = manager_with_delete("app_settings")
        context_items = manager_with_delete("context_items")
        collections = manager_with_delete("collections")
        permissions = manager_with_delete("permissions")
        relay_packages = manager_with_delete("relay_packages")
        workspaces = Mock()
        workspaces.filter.return_value._raw_delete.side_effect = (
            lambda _alias: order.append("workspaces")
        )

        with patch("apps.tabtinspace.models.SpaceMembership.objects", memberships), \
             patch("apps.tabtinspace.models.SpaceAppSettings.objects", app_settings), \
             patch("apps.tabtinspace.models.ContextItem.objects", context_items), \
             patch("apps.tabtinspace.models.Collection.objects", collections), \
             patch("apps.tabtinspace.models.SpacePermission.objects", permissions), \
             patch("apps.login_relay.models.LoginRelayPackage.objects", relay_packages), \
             patch("apps.tabtinspace.services.organization_service.Workspace.objects", workspaces), \
             patch("apps.tabtinspace.services.organization_service.postgres_app_db_alias", return_value="default"):
            OrganizationService._delete_space_rows([workspace_id])

        relay_packages.filter.assert_called_once_with(space_id__in=[workspace_id])
        self.assertLess(order.index("relay_packages"), order.index("workspaces"))

    def test_core_row_delete_removes_control_policy_and_keeps_organization_tombstone(self):
        organization_id = uuid.uuid4()
        order: list[str] = []

        def delete_step(name: str):
            def _delete():
                order.append(name)
                return (1, {})
            return _delete

        def manager_with_delete(name: str) -> Mock:
            manager = Mock()
            manager.filter.return_value.delete.side_effect = delete_step(name)
            return manager

        members = manager_with_delete("members")
        installs = manager_with_delete("installs")
        invitations = manager_with_delete("invitations")
        control_policies = manager_with_delete("control_policy")
        credentials = manager_with_delete("credentials")
        agents = manager_with_delete("agents")
        devices = manager_with_delete("devices")

        organizations = Mock()
        with patch("apps.tabtinspace.models.OrganizationMember.objects", members), \
             patch("apps.tabtinspace.models.OrganizationAppInstall.objects", installs), \
             patch("apps.tabtinspace.models.OrganizationInvitation.objects", invitations), \
             patch("apps.tabtinspace.models.OrganizationControlPolicy.objects", control_policies), \
             patch("apps.tabtinspace.models.SecureCredential.objects", credentials), \
             patch("apps.tabtinspace.models.Device.objects", devices), \
             patch("apps.tabtinspace.services.organization_service.Agent.objects", agents), \
             patch("apps.tabtinspace.services.organization_service.Organization.objects", organizations), \
             patch("apps.tabtinspace.services.organization_service.postgres_app_db_alias", return_value="default"):
            OrganizationService._delete_organization_rows(organization_id)

        control_policies.filter.assert_called_once_with(organization_id=organization_id)
        self.assertLess(order.index("control_policy"), order.index("devices"))
        organizations.filter.assert_not_called()
