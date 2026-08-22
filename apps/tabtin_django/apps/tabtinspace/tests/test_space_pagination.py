from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import Mock, patch
from uuid import uuid4

from django.test import RequestFactory, SimpleTestCase

from apps.tabtinspace.models import OrganizationMember
from apps.tabtinspace.services.base import ServiceError


class SpaceListPaginationTests(SimpleTestCase):
    def setUp(self):
        self.factory = RequestFactory()

    @patch("apps.tabtinspace.routers.space._build_share_info_map", return_value={})
    @patch("apps.tabtinspace.routers.space.SpaceService")
    def test_list_spaces_caps_page_size(self, mock_service_cls, _mock_share_info):
        from apps.tabtinspace.routers.space import list_spaces

        request = self.factory.get("/api/context/spaces?page=0&page_size=9999")
        request.auth = SimpleNamespace(id="user-1")
        mock_service_cls.return_value.list_spaces.return_value = ([], 0)

        response = list_spaces(request)

        self.assertTrue(response["success"])
        mock_service_cls.return_value.list_spaces.assert_called_once()
        kwargs = mock_service_cls.return_value.list_spaces.call_args.kwargs
        self.assertEqual(kwargs["page"], 1)
        self.assertEqual(kwargs["page_size"], 200)

    @patch("apps.tabtinspace.routers.space._build_share_info_map", return_value={})
    @patch("apps.tabtinspace.routers.space.SpaceService")
    def test_list_spaces_uses_default_page_size_for_invalid_value(self, mock_service_cls, _mock_share_info):
        from apps.tabtinspace.routers.space import list_spaces

        request = self.factory.get("/api/context/spaces?page=bad&page_size=bad")
        request.auth = SimpleNamespace(id="user-1")
        mock_service_cls.return_value.list_spaces.return_value = ([], 0)

        list_spaces(request)

        kwargs = mock_service_cls.return_value.list_spaces.call_args.kwargs
        self.assertEqual(kwargs["page"], 1)
        self.assertEqual(kwargs["page_size"], 100)

    @patch("apps.tabtinspace.routers.context_item.ContextItemService")
    def test_list_context_items_caps_page_size(self, mock_service_cls):
        from apps.tabtinspace.routers.context_item import list_context_items

        request = self.factory.get("/api/context/spaces/space-1/context-items?page=0&page_size=9999")
        request.auth = SimpleNamespace(id="user-1")
        mock_service_cls.return_value.list_items.return_value = ([], 0)

        list_context_items(request, uuid4())

        kwargs = mock_service_cls.return_value.list_items.call_args.kwargs
        self.assertEqual(kwargs["page"], 1)
        self.assertEqual(kwargs["page_size"], 200)

    @patch("apps.tabtinspace.routers.context_item.ContextItemService")
    def test_list_trashed_items_caps_page_size(self, mock_service_cls):
        from apps.tabtinspace.routers.context_item import list_trashed_items

        request = self.factory.get("/api/context/spaces/space-1/trash")
        request.auth = SimpleNamespace(id="user-1")
        mock_service_cls.return_value.list_trashed_items.return_value = ([], 0)

        list_trashed_items(request, uuid4(), page=0, page_size=9999)

        kwargs = mock_service_cls.return_value.list_trashed_items.call_args.kwargs
        self.assertEqual(kwargs["page"], 1)
        self.assertEqual(kwargs["page_size"], 200)

    @patch("django.contrib.auth.get_user_model")
    @patch("apps.tabtinspace.routers.membership.OrganizationService")
    def test_list_organization_members_caps_explicit_limit(self, mock_service_cls, mock_get_user_model):
        from apps.tabtinspace.routers.membership import list_organization_members

        request = self.factory.get("/api/context/organizations/wt/members")
        request.auth = SimpleNamespace(id="user-1")
        mock_service_cls.return_value.list_members.return_value = ([], 0)
        mock_get_user_model.return_value.objects.filter.return_value.values.return_value = []

        list_organization_members(request, uuid4(), offset=-10, limit=9999)

        kwargs = mock_service_cls.return_value.list_members.call_args.kwargs
        self.assertEqual(kwargs["offset"], 0)
        self.assertEqual(kwargs["limit"], 200)

    @patch("django.contrib.auth.get_user_model")
    @patch("apps.tabtinspace.routers.membership.OrganizationService")
    def test_list_organization_members_preserves_default_unlimited_semantics(self, mock_service_cls, mock_get_user_model):
        from apps.tabtinspace.routers.membership import list_organization_members

        request = self.factory.get("/api/context/organizations/wt/members")
        request.auth = SimpleNamespace(id="user-1")
        mock_service_cls.return_value.list_members.return_value = ([], 0)
        mock_get_user_model.return_value.objects.filter.return_value.values.return_value = []

        list_organization_members(request, uuid4())

        kwargs = mock_service_cls.return_value.list_members.call_args.kwargs
        self.assertEqual(kwargs["offset"], 0)
        self.assertEqual(kwargs["limit"], 0)

    @patch("apps.tabtinspace.routers.membership.NotificationService.notify")
    @patch("apps.tabtinspace.routers.membership._audit")
    @patch("apps.tabtinspace.models.OrganizationMember")
    @patch("apps.tabtinspace.routers.membership.OrganizationService")
    def test_remove_organization_member_retry_is_idempotent(
        self,
        mock_service_cls,
        mock_member_model,
        mock_audit,
        mock_notify,
    ):
        from apps.tabtinspace.routers.membership import remove_organization_member

        request = self.factory.delete("/api/context/organizations/wt/members/user-2")
        request.auth = SimpleNamespace(id="owner-1")
        mock_member_model.objects.filter.return_value.values_list.return_value.first.return_value = None
        mock_service_cls.return_value.remove_member.side_effect = ServiceError(
            "MEMBER_NOT_FOUND",
            "成员不存在",
            404,
        )

        response = remove_organization_member(request, uuid4(), "user-2")

        self.assertTrue(response["success"])
        mock_audit.assert_not_called()
        mock_notify.assert_not_called()

    @patch("apps.tabtinspace.services.organization_service.OrganizationMember.objects.select_for_update")
    @patch("apps.tabtinspace.services.organization_service.Organization.objects.get")
    def test_remove_organization_member_locks_retry_and_runs_revocation_once(
        self,
        mock_organization_get,
        mock_select_for_update,
    ):
        from apps.tabtinspace.services.organization_service import OrganizationService

        organization_id = uuid4()
        mock_organization_get.return_value = SimpleNamespace(owner_id="owner-1")
        member = SimpleNamespace(role="editor", delete=Mock())
        mock_select_for_update.return_value.get.side_effect = [
            member,
            OrganizationMember.DoesNotExist,
        ]
        service = OrganizationService(user=SimpleNamespace(id="admin-1"))

        with (
            patch.object(service, "_get_operator_role", return_value="admin"),
            patch.object(service, "_sync_im_dm_revoke") as mock_im_revoke,
            patch.object(service, "_sync_session_share_revoke") as mock_share_revoke,
            patch.object(service, "_snapshot_departing_member_identity"),
            patch.object(service, "_sync_collab_revoke"),
            patch("apps.tabtinspace.services.invitation_service.InvitationService.stamp_user_on_pending_link_invitations"),
            patch("apps.tabtinspace.services.organization_service.Device.objects.filter"),
            patch("apps.tabtinspace.services.organization_service.transaction.on_commit"),
        ):
            self.assertTrue(OrganizationService.remove_member.__wrapped__(
                service,
                organization_id,
                "user-2",
            ))
            with self.assertRaises(ServiceError) as raised:
                OrganizationService.remove_member.__wrapped__(
                    service,
                    organization_id,
                    "user-2",
                )

        self.assertEqual(raised.exception.code, "MEMBER_NOT_FOUND")
        self.assertEqual(mock_select_for_update.call_count, 2)
        mock_im_revoke.assert_called_once_with("user-2", str(organization_id))
        mock_share_revoke.assert_called_once_with("user-2", str(organization_id))
        member.delete.assert_called_once_with()

    @patch("django.contrib.auth.get_user_model")
    @patch("apps.tabtinspace.routers.membership.OrganizationService")
    def test_list_organization_members_masks_other_phones_for_editor(
        self,
        mock_service_cls,
        mock_get_user_model,
    ):
        from apps.tabtinspace.routers.membership import list_organization_members

        organization_id = uuid4()
        owner_id = "owner-1"
        editor_id = "editor-1"
        joined_at = datetime.now(timezone.utc)
        members = [
            SimpleNamespace(
                id=uuid4(),
                organization_id=organization_id,
                user_id=owner_id,
                role="owner",
                joined_at=joined_at,
            ),
            SimpleNamespace(
                id=uuid4(),
                organization_id=organization_id,
                user_id=editor_id,
                role="editor",
                joined_at=joined_at,
            ),
        ]
        mock_service_cls.return_value.list_members.return_value = (members, 2)
        mock_service_cls.return_value.get_member_role.return_value = "editor"
        mock_get_user_model.return_value.objects.filter.return_value.values.return_value = [
            {
                "id": owner_id,
                "nickname": "Owner",
                "username": "owner",
                "email": "",
                "phone": "+8613800000001",
                "avatar": "",
            },
            {
                "id": editor_id,
                "nickname": "Editor",
                "username": "editor",
                "email": "",
                "phone": "+8613800000002",
                "avatar": "",
            },
        ]
        request = self.factory.get(
            f"/api/context/organizations/{organization_id}/members"
        )
        request.auth = SimpleNamespace(id=editor_id)

        response = list_organization_members(request, organization_id)
        members_by_user_id = {
            item["user_id"]: item for item in response["data"]["members"]
        }

        self.assertEqual(
            members_by_user_id[editor_id]["user"]["phone"],
            "13800000002",
        )
        self.assertEqual(
            members_by_user_id[owner_id]["user"]["phone"],
            "138****0001",
        )
