"""leave_organization 后撤销离开组织下的 Centrifugo 群频道。"""
import os
import sys
import unittest
from unittest.mock import MagicMock, patch, PropertyMock
from uuid import uuid4

django_root = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir, os.pardir, os.pardir, os.pardir))
if django_root not in sys.path:
    sys.path.insert(0, django_root)
if "DJANGO_SETTINGS_MODULE" not in os.environ:
    os.environ["DJANGO_SETTINGS_MODULE"] = "tabtin.settings"

import django
from django.apps import apps
if not apps.ready:
    django.setup()


class LeaveOrganizationCentrifugoRevokeTests(unittest.TestCase):
    """离开组织后只撤销该组织的群频道，不影响其它组织。"""

    def _make_service(self, user_id="user-1"):
        from apps.tabtinspace.services.organization_service import OrganizationService
        mock_user = MagicMock()
        mock_user.id = user_id
        service = OrganizationService.__new__(OrganizationService)
        service.user = mock_user
        return service

    @patch("apps.tabtinspace.services.organization_service.transaction")
    @patch("apps.tabtinspace.services.organization_service.OrganizationMember")
    @patch("apps.tabtinspace.services.organization_service.Organization")
    def test_leave_organization_schedules_organization_channel_revoke(
        self, MockWorkspace, MockMember, mock_transaction,
    ):
        organization_id = uuid4()
        user_id = "user-1"

        mock_ws = MagicMock()
        mock_ws.owner_id = "owner-user"
        MockWorkspace.objects.get.return_value = mock_ws

        mock_member = MagicMock()
        MockMember.objects.get.return_value = mock_member

        on_commit_callbacks = []
        mock_transaction.on_commit = lambda fn, using=None: on_commit_callbacks.append(fn)
        mock_transaction.atomic = MagicMock(return_value=MagicMock(
            __enter__=MagicMock(return_value=None),
            __exit__=MagicMock(return_value=False),
        ))

        service = self._make_service(user_id)
        with patch.object(type(service), 'check_organization_permission', return_value=True):
            result = service.leave_organization(organization_id)

        self.assertTrue(result)
        mock_member.delete.assert_called_once()
        self.assertGreaterEqual(len(on_commit_callbacks), 1)

        with patch("apps.tabchat.centrifugo_proxy.unsubscribe_centrifugo_user_from_organization") as mock_unsubscribe:
            for cb in on_commit_callbacks:
                cb()
            mock_unsubscribe.assert_called_once_with(
                user_id,
                str(organization_id),
                synchronous=True,
            )

    @patch("apps.tabtinspace.services.organization_service.transaction")
    @patch("apps.tabtinspace.services.organization_service.OrganizationMember")
    @patch("apps.tabtinspace.services.organization_service.Organization")
    def test_centrifugo_channel_revoke_failure_does_not_break_leave(
        self, MockWorkspace, MockMember, mock_transaction,
    ):
        organization_id = uuid4()
        user_id = "user-2"

        mock_ws = MagicMock()
        mock_ws.owner_id = "owner-user"
        MockWorkspace.objects.get.return_value = mock_ws

        mock_member = MagicMock()
        MockMember.objects.get.return_value = mock_member

        on_commit_callbacks = []
        mock_transaction.on_commit = lambda fn, using=None: on_commit_callbacks.append(fn)
        mock_transaction.atomic = MagicMock(return_value=MagicMock(
            __enter__=MagicMock(return_value=None),
            __exit__=MagicMock(return_value=False),
        ))

        service = self._make_service(user_id)
        with patch.object(type(service), 'check_organization_permission', return_value=True):
            result = service.leave_organization(organization_id)

        self.assertTrue(result)

        with patch(
            "apps.tabchat.centrifugo_proxy.unsubscribe_centrifugo_user_from_organization",
            side_effect=Exception("Centrifugo unreachable"),
        ):
            for cb in on_commit_callbacks:
                cb()


if __name__ == "__main__":
    unittest.main(verbosity=2)
