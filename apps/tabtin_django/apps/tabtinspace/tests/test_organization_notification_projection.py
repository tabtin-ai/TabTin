"""PR1B: Organization mutation notification projection contracts."""

from __future__ import annotations

from unittest.mock import patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models.signals import post_save
from django.http import HttpResponse
from django.test import RequestFactory, TransactionTestCase

from apps.services.notification.models import Notification
from apps.services.notification.services.notification_service import NotificationService
from apps.services.notification.services.organization_notification_projection import (
    OrganizationMemberAddedFact,
    project_organization_notification,
)
from apps.tabtinspace.admin_api import (
    AdminMemberAddRequest,
    AdminMemberRoleUpdateRequest,
    AdminOrganizationTransferOwnershipRequest,
    AdminSensitiveReasonRequest,
    admin_add_organization_member,
    admin_remove_organization_member,
    admin_transfer_organization_ownership,
    admin_update_organization_member_role,
)
from apps.tabtinspace.models import Organization, OrganizationMember
from apps.tabtinspace.routers.membership import (
    add_organization_member,
    remove_organization_member,
    update_organization_member,
)
from apps.tabtinspace.routers.organization import transfer_ownership
from apps.tabtinspace.schemas.membership import (
    OrganizationMemberAdd,
    OrganizationMemberUpdate,
)
from apps.tabtinspace.schemas.organization import OwnershipTransferRequest
from apps.tabtinspace.services.base import BaseService
from apps.tabtinspace.services.organization_service import OrganizationService
from apps.tabtinspace.signals import create_default_organization
from apps.services.common.db_router import postgres_app_db_alias


class OrganizationNotificationProjectionTests(TransactionTestCase):
    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        post_save.disconnect(create_default_organization, sender=get_user_model())

    @classmethod
    def tearDownClass(cls):
        post_save.connect(create_default_organization, sender=get_user_model())
        super().tearDownClass()

    def setUp(self):
        self.factory = RequestFactory()
        self.staff = self._create_user("projection-staff", is_staff=True, is_superuser=True)
        self.owner = self._create_user("projection-owner")
        self.member = self._create_user("projection-member")
        self.organization = Organization.objects.create(
            name="Projection Team",
            owner=self.owner,
            type=Organization.OrganizationType.TEAM,
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.owner,
            role="owner",
        )
        self.membership = OrganizationMember.objects.create(
            organization=self.organization,
            user=self.member,
            role="viewer",
        )

    @staticmethod
    def _create_user(name: str, *, is_staff: bool = False, is_superuser: bool = False):
        return get_user_model().objects.create_user(
            phone=f"+86138{uuid4().int % 100000000:08d}",
            password="test-password",
            nickname=name,
            is_staff=is_staff,
            is_superuser=is_superuser,
        )

    def _admin_request(self, method: str = "put"):
        request = getattr(self.factory, method)("/api/auth/admin/organizations/x/members/y")
        request.auth = self.staff
        request.headers = {}
        request.META["REMOTE_ADDR"] = "127.0.0.1"
        request.META["HTTP_USER_AGENT"] = "pr1b-test"
        return request

    def _public_request(self, method: str = "put"):
        request = getattr(self.factory, method)("/api/organizations/x/members/y")
        request.auth = self.owner
        request.headers = {}
        request.META["REMOTE_ADDR"] = "127.0.0.1"
        request.META["HTTP_USER_AGENT"] = "pr1b-test"
        return request

    @patch.object(BaseService, "broadcast_permission_changed")
    def test_admin_role_change_projects_notification(self, _mock_broadcast):
        response = admin_update_organization_member_role(
            self._admin_request(),
            self.organization.id,
            str(self.member.id),
            AdminMemberRoleUpdateRequest(
                role="editor",
                reason="PR1B role projection",
                ticket_id="PR1B-ROLE",
            ),
        )

        self.assertNotIsInstance(response, HttpResponse)
        self.assertTrue(response["success"])
        notification = Notification.objects.get(
            organization_id=str(self.organization.id),
            user_id=str(self.member.id),
            type="role_changed",
        )
        self.assertEqual(notification.title, "你在「Projection Team」的角色已变更")
        self.assertEqual(notification.body, "角色已由“查看者”调整为“编辑者”。")
        self.assertEqual(notification.category, "organization")
        self.assertEqual(notification.metadata["behavior"], "notification_only")

    @patch.object(BaseService, "broadcast_permission_changed")
    def test_public_role_change_projects_exactly_one_notification(self, _mock_broadcast):
        response = update_organization_member(
            self._public_request(),
            self.organization.id,
            str(self.member.id),
            OrganizationMemberUpdate(role="editor"),
        )

        self.assertTrue(response["success"])
        notifications = Notification.objects.filter(
            organization_id=str(self.organization.id),
            user_id=str(self.member.id),
            type="role_changed",
        )
        self.assertEqual(notifications.count(), 1)
        notification = notifications.get()
        self.assertEqual(notification.category, "organization")
        self.assertEqual(notification.metadata["behavior"], "notification_only")

    @patch(
        "apps.services.billing.services.seat_billing_service.SeatBillingService.check_seat_quota",
        return_value=True,
    )
    def test_add_member_domain_mutation_projects_notification(self, _mock_seat):
        target = self._create_user("projection-added")

        membership = OrganizationService(user=self.owner).add_member(
            self.organization.id,
            str(target.id),
            role="editor",
        )

        notification = Notification.objects.get(
            organization_id=str(self.organization.id),
            user_id=str(target.id),
            type="member_added",
        )
        self.assertEqual(notification.title, "projection-added已加入「Projection Team」")
        self.assertEqual(notification.body, "projection-owner已将该成员添加为“编辑者”。")
        self.assertEqual(
            notification.source_event_id,
            f"organization:member:added:{membership.id}",
        )

    @patch(
        "apps.services.billing.services.seat_billing_service.SeatBillingService.check_seat_quota",
        return_value=True,
    )
    def test_public_add_member_projects_exactly_one_notification(self, _mock_seat):
        target = self._create_user("projection-public-added")

        response = add_organization_member(
            self._public_request("post"),
            self.organization.id,
            OrganizationMemberAdd(user_id=str(target.id), role="editor"),
        )

        self.assertEqual(response[0], 201)
        notification = Notification.objects.get(
            organization_id=str(self.organization.id),
            user_id=str(target.id),
            type="member_added",
        )
        self.assertEqual(notification.category, "organization")
        self.assertEqual(notification.metadata["behavior"], "notification_only")
        self.assertEqual(notification.channels_delivered, ["center"])

    @patch(
        "apps.services.billing.services.seat_billing_service.SeatBillingService.check_seat_quota",
        return_value=True,
    )
    def test_admin_add_member_projects_exactly_one_notification(self, _mock_seat):
        target = self._create_user("projection-admin-added")

        response = admin_add_organization_member(
            self._admin_request("post"),
            self.organization.id,
            AdminMemberAddRequest(
                user_id=str(target.id),
                reason="PR1B admin add",
                ticket_id="PR1B-ADD",
            ),
        )

        self.assertEqual(response[0], 201)
        notification = Notification.objects.get(
            organization_id=str(self.organization.id),
            user_id=str(target.id),
            type="member_added",
        )
        self.assertEqual(notification.title, "projection-admin-added已加入「Projection Team」")
        self.assertEqual(notification.body, "projection-staff已将该成员添加为“编辑者”。")
        self.assertEqual(notification.channels_delivered, ["center"])

    def test_remove_member_domain_mutation_projects_from_deleted_membership_snapshot(self):
        membership_id = str(self.membership.id)

        OrganizationService(user=self.owner).remove_member(
            self.organization.id,
            str(self.member.id),
        )

        self.assertFalse(
            OrganizationMember.objects.filter(id=membership_id).exists()
        )
        notification = Notification.objects.get(
            organization_id=str(self.organization.id),
            user_id=str(self.member.id),
            type="member_removed",
        )
        self.assertEqual(notification.title, "你已被移出「Projection Team」")
        self.assertEqual(notification.body, "你将无法继续访问该组织及其组织资源。")
        self.assertEqual(
            notification.source_event_id,
            f"organization:member:removed:{membership_id}",
        )

    def test_public_remove_member_projects_exactly_one_notification(self):
        response = remove_organization_member(
            self._public_request("delete"),
            self.organization.id,
            str(self.member.id),
        )

        self.assertTrue(response["success"])
        notification = Notification.objects.get(
            organization_id=str(self.organization.id),
            user_id=str(self.member.id),
            type="member_removed",
        )
        self.assertEqual(notification.metadata["desktop_delivery"], "always")

    def test_admin_remove_member_projects_exactly_one_notification(self):
        response = admin_remove_organization_member(
            self._admin_request("post"),
            self.organization.id,
            str(self.member.id),
            AdminSensitiveReasonRequest(
                reason="PR1B admin remove",
                ticket_id="PR1B-REMOVE",
            ),
        )

        self.assertTrue(response["success"])
        notification = Notification.objects.get(
            organization_id=str(self.organization.id),
            user_id=str(self.member.id),
            type="member_removed",
        )
        self.assertEqual(notification.metadata["desktop_delivery"], "always")

    @patch.object(BaseService, "broadcast_permission_changed")
    def test_transfer_ownership_domain_mutation_preserves_public_recipients(
        self,
        _mock_broadcast,
    ):
        observer = self._create_user("projection-observer")
        OrganizationMember.objects.create(
            organization=self.organization,
            user=observer,
            role="editor",
        )

        OrganizationService(user=self.owner).transfer_ownership(
            self.organization.id,
            str(self.member.id),
        )

        notifications = Notification.objects.filter(
            organization_id=str(self.organization.id),
            type="ownership_transfer",
        )
        self.assertEqual(notifications.count(), 3)
        self.assertEqual(
            set(notifications.values_list("user_id", flat=True)),
            {str(self.owner.id), str(self.member.id), str(observer.id)},
        )
        self.assertEqual(
            notifications.get(user_id=str(self.member.id)).title,
            "「Projection Team」的所有权已转移",
        )
        self.assertEqual(
            notifications.get(user_id=str(self.owner.id)).title,
            "「Projection Team」的所有权已转移",
        )

    @patch.object(BaseService, "broadcast_permission_changed")
    def test_public_transfer_ownership_projects_exactly_once_per_recipient(
        self,
        _mock_broadcast,
    ):
        response = transfer_ownership(
            self._public_request("post"),
            self.organization.id,
            OwnershipTransferRequest(new_owner_user_id=str(self.member.id)),
        )

        self.assertTrue(response["success"])
        notifications = Notification.objects.filter(
            organization_id=str(self.organization.id),
            type="ownership_transfer",
        )
        self.assertEqual(notifications.count(), 2)
        self.assertEqual(
            set(notifications.values_list("user_id", flat=True)),
            {str(self.owner.id), str(self.member.id)},
        )
        self.assertEqual(
            notifications.get(user_id=str(self.member.id)).title,
            "「Projection Team」的所有权已转移",
        )
        self.assertEqual(
            notifications.get(user_id=str(self.owner.id)).title,
            "「Projection Team」的所有权已转移",
        )
        self.assertEqual(notifications.values("source_event_id").distinct().count(), 1)

    @patch.object(BaseService, "broadcast_permission_changed")
    def test_admin_transfer_ownership_projects_exactly_once_per_recipient(
        self,
        _mock_broadcast,
    ):
        response = admin_transfer_organization_ownership(
            self._admin_request("post"),
            self.organization.id,
            AdminOrganizationTransferOwnershipRequest(
                new_owner_user_id=str(self.member.id),
                reason="PR1B admin transfer",
                ticket_id="PR1B-OWNERSHIP",
            ),
        )

        self.assertTrue(response["success"])
        notifications = Notification.objects.filter(
            organization_id=str(self.organization.id),
            type="ownership_transfer",
        )
        self.assertEqual(notifications.count(), 2)
        self.assertEqual(
            set(notifications.values_list("user_id", flat=True)),
            {str(self.owner.id), str(self.member.id)},
        )
        self.assertEqual(
            notifications.get(user_id=str(self.member.id)).title,
            "「Projection Team」的所有权已转移",
        )
        self.assertEqual(
            notifications.get(user_id=str(self.owner.id)).title,
            "「Projection Team」的所有权已转移",
        )
        self.assertEqual(notifications.values("source_event_id").distinct().count(), 1)

    @patch.object(BaseService, "broadcast_permission_changed")
    def test_role_change_rollback_creates_no_notification(self, _mock_broadcast):
        with self.assertRaisesRegex(RuntimeError, "force rollback"):
            with transaction.atomic(using=postgres_app_db_alias()):
                OrganizationService(user=self.owner).update_member_role(
                    self.organization.id,
                    str(self.member.id),
                    "editor",
                )
                raise RuntimeError("force rollback")

        self.membership.refresh_from_db()
        self.assertEqual(self.membership.role, "viewer")
        self.assertFalse(Notification.objects.filter(type="role_changed").exists())

    def test_remove_member_rollback_creates_no_notification(self):
        with self.assertRaisesRegex(RuntimeError, "force rollback"):
            with transaction.atomic(using=postgres_app_db_alias()):
                OrganizationService(user=self.owner).remove_member(
                    self.organization.id,
                    str(self.member.id),
                )
                raise RuntimeError("force rollback")

        self.assertTrue(OrganizationMember.objects.filter(id=self.membership.id).exists())
        self.assertFalse(Notification.objects.filter(type="member_removed").exists())

    @patch.object(NotificationService, "notify", side_effect=RuntimeError("projection down"))
    @patch.object(BaseService, "broadcast_permission_changed")
    def test_role_projection_failure_does_not_fail_public_mutation(
        self,
        _mock_broadcast,
        mock_notify,
    ):
        response = update_organization_member(
            self._public_request(),
            self.organization.id,
            str(self.member.id),
            OrganizationMemberUpdate(role="editor"),
        )

        self.assertTrue(response["success"])
        self.membership.refresh_from_db()
        self.assertEqual(self.membership.role, "editor")
        self.assertEqual(mock_notify.call_count, 1)

    @patch.object(NotificationService, "notify", side_effect=RuntimeError("projection down"))
    def test_remove_projection_failure_does_not_restore_membership(self, mock_notify):
        response = remove_organization_member(
            self._public_request("delete"),
            self.organization.id,
            str(self.member.id),
        )

        self.assertTrue(response["success"])
        self.assertFalse(OrganizationMember.objects.filter(id=self.membership.id).exists())
        self.assertEqual(mock_notify.call_count, 1)

    @patch.object(NotificationService, "notify", side_effect=RuntimeError("projection down"))
    @patch(
        "apps.services.billing.services.seat_billing_service.SeatBillingService.check_seat_quota",
        return_value=True,
    )
    def test_add_projection_failure_does_not_remove_created_membership(
        self,
        _mock_seat,
        mock_notify,
    ):
        target = self._create_user("projection-add-failure")

        response = add_organization_member(
            self._public_request("post"),
            self.organization.id,
            OrganizationMemberAdd(user_id=str(target.id), role="editor"),
        )

        self.assertEqual(response[0], 201)
        self.assertTrue(OrganizationMember.objects.filter(
            organization=self.organization,
            user=target,
        ).exists())
        self.assertEqual(mock_notify.call_count, 1)

    @patch.object(NotificationService, "notify", side_effect=RuntimeError("projection down"))
    @patch.object(BaseService, "broadcast_permission_changed")
    def test_ownership_projection_failure_does_not_rollback_transfer(
        self,
        _mock_broadcast,
        mock_notify,
    ):
        response = transfer_ownership(
            self._public_request("post"),
            self.organization.id,
            OwnershipTransferRequest(new_owner_user_id=str(self.member.id)),
        )

        self.assertTrue(response["success"])
        self.organization.refresh_from_db()
        self.assertEqual(str(self.organization.owner_id), str(self.member.id))
        self.assertEqual(mock_notify.call_count, 1)

    @patch.object(NotificationService, "_push_ws")
    def test_duplicate_projection_reuses_one_canonical_notification(self, mock_push):
        fact = OrganizationMemberAddedFact(
            organization_id=str(self.organization.id),
            organization_name=self.organization.name,
            actor_id=str(self.owner.id),
            actor_name=self.owner.get_display_name(),
            affected_user_id=str(self.member.id),
            affected_user_name=self.member.get_display_name(),
            role="viewer",
            membership_id=str(self.membership.id),
            operation_id=str(self.membership.id),
        )

        project_organization_notification(fact)
        first = Notification.objects.get(type="member_added")
        project_organization_notification(fact)
        second = Notification.objects.get(type="member_added")

        self.assertEqual(first.id, second.id)
        self.assertEqual(first.source_event_id, second.source_event_id)
        self.assertEqual(Notification.objects.filter(type="member_added").count(), 1)
        self.assertEqual(mock_push.call_count, 1)
