"""#6857：后台直接添加成员 — 不依赖完整 migrate 的轻量单测。"""

from __future__ import annotations

import json
import uuid
from unittest.mock import MagicMock, patch

from django.http import HttpResponse
from django.test import RequestFactory, SimpleTestCase

from apps.tabtinspace.admin_api import AdminMemberAddRequest, admin_add_organization_member
from apps.tabtinspace.services.base import ServiceError


def _payload(response):
    if isinstance(response, HttpResponse):
        return json.loads(response.content.decode())
    if isinstance(response, tuple):
        return response[1]
    return response


class AdminDirectAddMemberUnitTests(SimpleTestCase):
    def setUp(self):
        self.factory = RequestFactory()
        self.org_id = uuid.uuid4()
        self.admin = MagicMock(id="admin-1", is_superuser=True, is_staff=True)

    def _request(self):
        request = self.factory.post("/api/auth/admin/organizations/x/members")
        request.auth = self.admin
        request.headers = {}
        request.META = {"REMOTE_ADDR": "127.0.0.1", "HTTP_USER_AGENT": "pytest"}
        return request

    @patch("apps.tabtinspace.admin_api._admin_organization_or_404")
    def test_requires_exactly_one_identifier(self, mock_org):
        mock_org.return_value = MagicMock(id=self.org_id, owner_id="owner-1")
        both = admin_add_organization_member(
            self._request(),
            self.org_id,
            AdminMemberAddRequest(
                user_id="u1",
                phone="13800138001",
                reason="ops",
            ),
        )
        assert getattr(both, "status_code", None) == 400
        assert _payload(both).get("code") == "INVALID_REQUEST"

        neither = admin_add_organization_member(
            self._request(),
            self.org_id,
            AdminMemberAddRequest(reason="ops"),
        )
        assert getattr(neither, "status_code", None) == 400

    @patch("apps.tabtinspace.admin_api._admin_organization_or_404")
    def test_unregistered_phone_rejected(self, mock_org):
        mock_org.return_value = MagicMock(id=self.org_id, owner_id="owner-1")
        with patch("apps.tabtinspace.admin_api.User") as mock_user:
            mock_user.objects.filter.return_value.first.return_value = None
            response = admin_add_organization_member(
                self._request(),
                self.org_id,
                AdminMemberAddRequest(phone="13900139000", reason="ops"),
            )
        assert getattr(response, "status_code", None) == 404
        assert _payload(response).get("code") == "USER_NOT_FOUND_BY_PHONE"

    @patch("apps.tabtinspace.admin_api.record_admin_sensitive_action")
    @patch("apps.tabtinspace.admin_api._record_admin_action")
    @patch("apps.tabtinspace.admin_api._admin_act_as_owner")
    @patch("apps.tabtinspace.admin_api.OrganizationService")
    @patch("apps.tabtinspace.admin_api._admin_organization_or_404")
    def test_direct_add_by_user_id_success(
        self,
        mock_org,
        mock_service_cls,
        mock_act_as,
        mock_record,
        mock_sensitive,
    ):
        mock_org.return_value = MagicMock(id=self.org_id, owner_id="owner-1")
        mock_act_as.return_value = MagicMock()
        member = MagicMock()
        member.id = uuid.uuid4()
        member.organization_id = self.org_id
        member.user_id = "user-xyz"
        member.role = "editor"
        member.joined_at = None
        mock_service_cls.return_value.add_member.return_value = member

        with patch(
            "apps.tabtinspace.schemas.membership.OrganizationMemberOut"
        ) as mock_out:
            mock_out.from_orm.return_value.dict.return_value = {
                "id": str(member.id),
                "organization_id": str(self.org_id),
                "user_id": "user-xyz",
                "role": "editor",
            }
            with patch(
                "apps.services.notification.services.notification_service.NotificationService.notify"
            ) as mock_notify:
                created = admin_add_organization_member(
                    self._request(),
                    self.org_id,
                    AdminMemberAddRequest(
                        user_id="user-xyz",
                        reason="ops direct add",
                        ticket_id="T-1",
                    ),
                )

        assert created[0] == 201
        assert created[1]["data"]["user_id"] == "user-xyz"
        mock_service_cls.return_value.add_member.assert_called_once()
        mock_record.assert_called_once()
        mock_sensitive.assert_called_once()
        mock_notify.assert_called_once()
        notify_kwargs = mock_notify.call_args.kwargs
        assert notify_kwargs["type"] == "member_added"
        assert notify_kwargs.get("body", "") == ""
        assert notify_kwargs["metadata"]["category"] == "organization"

    @patch("apps.tabtinspace.admin_api._admin_organization_or_404")
    def test_already_member_propagates(self, mock_org):
        mock_org.return_value = MagicMock(id=self.org_id, owner_id="owner-1")
        with patch("apps.tabtinspace.admin_api._admin_act_as_owner", return_value=MagicMock()):
            with patch("apps.tabtinspace.admin_api.OrganizationService") as mock_svc:
                mock_svc.return_value.add_member.side_effect = ServiceError(
                    "ALREADY_MEMBER", "该用户已是组织成员", 400
                )
                response = admin_add_organization_member(
                    self._request(),
                    self.org_id,
                    AdminMemberAddRequest(user_id="existing", reason="ops"),
                )
        assert _payload(response).get("code") == "ALREADY_MEMBER"
