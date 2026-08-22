"""：组织详情成员写/邀请 staff API。"""

from __future__ import annotations

import json
import uuid
from datetime import timedelta
from unittest.mock import patch

from django.http import HttpResponse
from django.test import RequestFactory, TestCase
from django.utils import timezone

from apps.services.common.db_router import postgres_app_db_alias
from apps.services.notification.models import Notification
from apps.tabtinspace.admin_api import (
    AdminInvitationDirectCreateRequest,
    AdminInvitationLinkCreateRequest,
    AdminMemberAddRequest,
    AdminMemberRoleUpdateRequest,
    AdminSensitiveReasonRequest,
    _serialize_admin_invitation,
    admin_add_organization_member,
    admin_cancel_organization_invitation,
    admin_create_direct_invitation,
    admin_create_link_invitation,
    admin_list_organization_invitations,
    admin_remove_organization_member,
    admin_update_organization_member_role,
)
from apps.tabtinspace.models import Organization, OrganizationInvitation, OrganizationMember
from apps.tabtinspace.services.base import BaseService
from apps.users.auth.models import User


def _payload(response):
    """解析 success_response(dict) 或 error_response(JsonResponse)。"""
    if isinstance(response, HttpResponse):
        return json.loads(response.content.decode())
    return response


class AdminOrganizationMembersOpsTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.factory = RequestFactory()
        self.admin = User.objects.create_user(
            username="members_ops_admin",
            email="members-ops-admin@test.com",
            password="test-pass-123",
            is_staff=True,
            is_superuser=True,
        )
        self.owner = User.objects.create_user(
            username="members_ops_owner",
            email="members-ops-owner@test.com",
            password="test-pass-123",
        )
        self.member_user = User.objects.create_user(
            username="members_ops_member",
            email="members-ops-member@test.com",
            password="test-pass-123",
        )
        self.organization = Organization.objects.create(
            name="Members Ops Org",
            owner=self.owner,
            type=Organization.OrganizationType.TEAM,
        )
        OrganizationMember.objects.get_or_create(
            organization=self.organization,
            user=self.owner,
            defaults={"role": "owner"},
        )
        # 存量 admin：组织写路径现仅允许改为 editor（ORGANIZATION_ASSIGNABLE_ROLES）
        self.member = OrganizationMember.objects.create(
            organization=self.organization,
            user=self.member_user,
            role="admin",
        )

    def _request(self, method="post"):
        request = getattr(self.factory, method)("/api/auth/admin/organizations/x/members")
        request.auth = self.admin
        request.headers = {}
        request.META = {
            "REMOTE_ADDR": "127.0.0.1",
            "HTTP_USER_AGENT": "pytest",
        }
        return request

    def test_update_legacy_admin_role_to_editor(self):
        response = admin_update_organization_member_role(
            self._request("put"),
            self.organization.id,
            str(self.member_user.id),
            AdminMemberRoleUpdateRequest(
                role="editor",
                reason="ops normalize role",
                ticket_id="OPS-ROLE-1",
            ),
        )
        payload = _payload(response)
        assert payload["data"]["role"] == "editor"
        self.member.refresh_from_db()
        assert self.member.role == "editor"

    def test_cannot_change_owner_role(self):
        response = admin_update_organization_member_role(
            self._request("put"),
            self.organization.id,
            str(self.owner.id),
            AdminMemberRoleUpdateRequest(role="editor", reason="should fail"),
        )
        assert getattr(response, "status_code", None) == 403
        payload = _payload(response)
        assert payload.get("success") is False
        assert payload.get("code") == "CANNOT_CHANGE_OWNER"

    @patch.object(BaseService, "broadcast_permission_changed")
    def test_update_member_role_broadcasts_permission_changed(self, mock_broadcast):
        """后台改角色须走领域服务 on_commit，向在线成员广播权限变更。"""
        with self.captureOnCommitCallbacks(
            execute=True,
            using=postgres_app_db_alias(),
        ):
            response = admin_update_organization_member_role(
                self._request("put"),
                self.organization.id,
                str(self.member_user.id),
                AdminMemberRoleUpdateRequest(
                    role="editor",
                    reason="ops demote for broadcast",
                    ticket_id="OPS-ROLE-BCAST",
                ),
            )
        payload = _payload(response)
        assert payload["data"]["role"] == "editor"
        self.member.refresh_from_db()
        assert self.member.role == "editor"
        mock_broadcast.assert_called_once_with(
            str(self.member_user.id),
            str(self.organization.id),
        )

    def test_remove_member(self):
        response = admin_remove_organization_member(
            self._request("post"),
            self.organization.id,
            str(self.member_user.id),
            AdminSensitiveReasonRequest(reason="ops remove", ticket_id="OPS-RM-1"),
        )
        assert response["data"]["removed"] is True
        assert not OrganizationMember.objects.filter(
            organization=self.organization,
            user=self.member_user,
        ).exists()

    @patch(
        "apps.tabtinspace.services.organization_member_im_sync."
        "revoke_organization_member_dm_access"
    )
    def test_remove_member_revokes_im_before_deleting_membership(self, mock_revoke):
        mock_revoke.side_effect = lambda **_kwargs: self.assertTrue(
            OrganizationMember.objects.filter(
                organization=self.organization,
                user=self.member_user,
            ).exists()
        ) or 1

        response = admin_remove_organization_member(
            self._request("post"),
            self.organization.id,
            str(self.member_user.id),
            AdminSensitiveReasonRequest(reason="ops remove", ticket_id="OPS-RM-IM"),
        )

        assert response["data"]["removed"] is True
        mock_revoke.assert_called_once_with(
            organization_id=str(self.organization.id),
            user_id=str(self.member_user.id),
            successor_admin_user_ids=[],
            successor_member_user_ids=[str(self.owner.id)],
        )

    @patch(
        "apps.tabtinspace.services.organization_member_im_sync."
        "revoke_organization_member_dm_access"
    )
    def test_remove_member_prefers_one_active_admin_successor(self, mock_revoke):
        successor_admin = User.objects.create_user(
            username="members_ops_successor_admin",
            email="members-ops-successor-admin@test.com",
            password="test-pass-123",
        )
        inactive_admin = User.objects.create_user(
            username="members_ops_inactive_admin",
            email="members-ops-inactive-admin@test.com",
            password="test-pass-123",
            is_active=False,
        )
        editor = User.objects.create_user(
            username="members_ops_successor_editor",
            email="members-ops-successor-editor@test.com",
            password="test-pass-123",
        )
        later_admin = User.objects.create_user(
            username="members_ops_later_admin",
            email="members-ops-later-admin@test.com",
            password="test-pass-123",
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=successor_admin,
            role="admin",
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=inactive_admin,
            role="admin",
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=editor,
            role="editor",
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=later_admin,
            role="admin",
        )

        response = admin_remove_organization_member(
            self._request("post"),
            self.organization.id,
            str(self.member_user.id),
            AdminSensitiveReasonRequest(reason="ops remove", ticket_id="OPS-RM-IM-ADMIN"),
        )

        assert response["data"]["removed"] is True
        mock_revoke.assert_called_once_with(
            organization_id=str(self.organization.id),
            user_id=str(self.member_user.id),
            successor_admin_user_ids=[str(successor_admin.id)],
            successor_member_user_ids=[],
        )

    @patch("apps.tabchat.centrifugo_proxy.unsubscribe_centrifugo_user_from_organization")
    @patch("apps.services.common.ws.bus.publish_to_user")
    def test_remove_member_pushes_membership_changed_before_organization_channel_revoke(
        self,
        mock_publish_to_user,
        mock_unsubscribe_centrifugo,
    ):
        """被移除用户先收到组织变更，再仅撤销该组织的群频道。"""
        fallback_organization = Organization.objects.create(
            name="Members Ops Fallback Org",
            owner=self.member_user,
            type=Organization.OrganizationType.TEAM,
        )
        OrganizationMember.objects.get_or_create(
            organization=fallback_organization,
            user=self.member_user,
            defaults={"role": "owner"},
        )
        call_order = []
        mock_publish_to_user.side_effect = lambda *_args, **_kwargs: call_order.append("publish") or True
        mock_unsubscribe_centrifugo.side_effect = lambda *_args, **_kwargs: call_order.append("unsubscribe")

        with self.captureOnCommitCallbacks(
            execute=True,
            using=postgres_app_db_alias(),
        ):
            response = admin_remove_organization_member(
                self._request("post"),
                self.organization.id,
                str(self.member_user.id),
                AdminSensitiveReasonRequest(reason="ops remove", ticket_id="OPS-RM-BCAST"),
            )

        assert response["data"]["removed"] is True
        assert mock_publish_to_user.call_count == 2
        membership_call, notification_call = mock_publish_to_user.call_args_list
        pushed_user_id, envelope = membership_call.args
        assert pushed_user_id == str(self.member_user.id)
        assert envelope["type"] == "organization.membership_changed"
        assert envelope["payload"]["removed"] == [str(self.organization.id)]
        assert str(self.organization.id) not in envelope["payload"]["all_ids"]
        assert str(fallback_organization.id) in envelope["payload"]["all_ids"]
        assert envelope["payload"]["reason"] == "removed_from_organization"
        assert notification_call.args[0] == str(self.member_user.id)
        assert notification_call.args[1]["type"] == "agent.user.notification.new"
        assert notification_call.args[1]["payload"]["type"] == "member_removed"
        mock_unsubscribe_centrifugo.assert_called_once_with(
            str(self.member_user.id),
            str(self.organization.id),
            synchronous=True,
        )
        assert call_order.index("publish") < call_order.index("unsubscribe")

    @patch(
        "apps.tabtinspace.services.invitation_service.build_invitation_bridge_url",
        return_value="https://web.example/invite/token",
    )
    def test_create_link_and_list_and_cancel(self, _mock_url):
        created = admin_create_link_invitation(
            self._request("post"),
            self.organization.id,
            AdminInvitationLinkCreateRequest(reason="ops link", ticket_id="OPS-INV-1"),
        )
        assert created[0] == 201
        invitation_id = created[1]["data"]["id"]
        assert created[1]["data"]["invite_url"]
        assert created[1]["data"]["token"]

        listed = admin_list_organization_invitations(self._request("get"), self.organization.id)
        assert listed["data"]["total"] >= 1
        matched = next(
            item for item in listed["data"]["invitations"] if item["id"] == invitation_id
        )
        assert matched["invite_url"] == "https://web.example/invite/token"
        assert matched["token"]

        cancelled = admin_cancel_organization_invitation(
            self._request("post"),
            self.organization.id,
            uuid.UUID(invitation_id),
            AdminSensitiveReasonRequest(reason="ops cancel"),
        )
        assert cancelled["data"]["cancelled"] is True
        inv = OrganizationInvitation.objects.get(id=invitation_id)
        assert inv.status == "cancelled"

    @patch(
        "apps.tabtinspace.services.invitation_service.build_invitation_bridge_url",
        return_value="https://web.example/invite/leaked",
    )
    def test_list_invitations_denied_for_non_superuser_staff(self, _mock_url):
        """普通 staff 不能读取 bearer token / 入组链接（权限绕过负向）。"""
        created = admin_create_link_invitation(
            self._request("post"),
            self.organization.id,
            AdminInvitationLinkCreateRequest(reason="ops link for deny", ticket_id="OPS-INV-DENY"),
        )
        assert created[0] == 201
        secret_token = created[1]["data"]["token"]
        assert secret_token

        staff = User.objects.create_user(
            username="members_ops_staff_only",
            email="members-ops-staff-only@test.com",
            password="test-pass-123",
            is_staff=True,
            is_superuser=False,
        )
        request = self._request("get")
        request.auth = staff
        response = admin_list_organization_invitations(request, self.organization.id)
        assert getattr(response, "status_code", None) == 403
        payload = _payload(response)
        assert payload.get("success") is False
        assert payload.get("code") == "ADMIN_SUPERUSER_REQUIRED"
        body = json.dumps(payload, ensure_ascii=False)
        assert secret_token not in body
        assert "https://web.example/invite/leaked" not in body

    def test_serialize_admin_invitation_redacts_secrets_by_default(self):
        inv = OrganizationInvitation.objects.create(
            organization=self.organization,
            invited_by=str(self.owner.id),
            invite_type="link",
            role="editor",
            token="secret-invite-token-5702",
            status="pending",
            expires_at=timezone.now() + timedelta(days=1),
            max_uses=-1,
        )
        redacted = _serialize_admin_invitation(inv)
        assert redacted["token"] == ""
        assert redacted["invite_url"] == ""
        exposed = _serialize_admin_invitation(inv, include_invite_secrets=True)
        assert exposed["token"] == "secret-invite-token-5702"

    def test_create_direct_invitation(self):
        target = User.objects.create_user(
            username="members_ops_invitee",
            email="members-ops-invitee@test.com",
            password="test-pass-123",
        )
        created = admin_create_direct_invitation(
            self._request("post"),
            self.organization.id,
            AdminInvitationDirectCreateRequest(
                user_id=str(target.id),
                reason="ops direct",
            ),
        )
        assert created[0] == 201
        assert created[1]["data"]["invited_user_id"] == str(target.id)

    @patch(
        "apps.services.billing.services.seat_billing_service.SeatBillingService.check_seat_quota",
        return_value=True,
    )
    def test_admin_direct_add_member_by_user_id(self, _mock_seat):
        target = User.objects.create_user(
            username="members_ops_direct_add",
            email="members-ops-direct-add@test.com",
            password="test-pass-123",
        )
        with self.captureOnCommitCallbacks(
            execute=True,
            using=postgres_app_db_alias(),
        ):
            created = admin_add_organization_member(
                self._request("post"),
                self.organization.id,
                AdminMemberAddRequest(
                    user_id=str(target.id),
                    reason="ops direct add ",
                    ticket_id="OPS-ADD-1",
                ),
            )
        assert created[0] == 201
        payload = created[1]["data"]
        assert payload["user_id"] == str(target.id)
        assert payload["role"] == "editor"
        assert OrganizationMember.objects.filter(
            organization_id=self.organization.id,
            user_id=target.id,
        ).exists()
        notification = Notification.objects.get(
            user_id=str(target.id),
            organization_id=str(self.organization.id),
            type="member_added",
        )
        assert notification.title == "@members_ops_direct_add已加入「Members Ops Org」"
        assert notification.body == "@members_ops_admin已将该成员添加为“编辑者”。"

    @patch(
        "apps.services.billing.services.seat_billing_service.SeatBillingService.check_seat_quota",
        return_value=True,
    )
    def test_admin_direct_add_member_by_phone(self, _mock_seat):
        target = User.objects.create_user(
            username="members_ops_phone_add",
            email="members-ops-phone-add@test.com",
            password="test-pass-123",
            phone="13800138001",
        )
        created = admin_add_organization_member(
            self._request("post"),
            self.organization.id,
            AdminMemberAddRequest(
                phone="13800138001",
                reason="ops phone add ",
            ),
        )
        assert created[0] == 201
        assert created[1]["data"]["user_id"] == str(target.id)

    def test_admin_direct_add_rejects_unregistered_phone(self):
        response = admin_add_organization_member(
            self._request("post"),
            self.organization.id,
            AdminMemberAddRequest(
                phone="13900139000",
                reason="should fail unregistered",
            ),
        )
        assert getattr(response, "status_code", None) == 404
        payload = _payload(response)
        assert payload.get("success") is False
        assert payload.get("code") == "USER_NOT_FOUND_BY_PHONE"

    def test_admin_direct_add_rejects_already_member(self):
        response = admin_add_organization_member(
            self._request("post"),
            self.organization.id,
            AdminMemberAddRequest(
                user_id=str(self.member_user.id),
                reason="already member",
            ),
        )
        payload = _payload(response)
        assert payload.get("success") is False
        assert payload.get("code") == "ALREADY_MEMBER"

    def test_admin_direct_add_requires_exactly_one_identifier(self):
        both = admin_add_organization_member(
            self._request("post"),
            self.organization.id,
            AdminMemberAddRequest(
                user_id=str(self.member_user.id),
                phone="13800138001",
                reason="both provided",
            ),
        )
        assert getattr(both, "status_code", None) == 400
        neither = admin_add_organization_member(
            self._request("post"),
            self.organization.id,
            AdminMemberAddRequest(reason="neither provided"),
        )
        assert getattr(neither, "status_code", None) == 400
