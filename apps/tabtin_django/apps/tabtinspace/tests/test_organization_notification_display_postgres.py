from datetime import timedelta
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import TransactionTestCase
from django.utils import timezone

from apps.services.notification.models import Notification
from apps.tabtinspace.models import Organization, OrganizationInvitation, OrganizationMember
from apps.tabtinspace.services.invitation_service import InvitationService
from apps.tabtinspace.signals import create_default_organization


class OrganizationNotificationDisplayPostgresTests(TransactionTestCase):
    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        post_save.disconnect(create_default_organization, sender=get_user_model())

    @classmethod
    def tearDownClass(cls):
        post_save.connect(create_default_organization, sender=get_user_model())
        super().tearDownClass()

    @staticmethod
    def _user(name: str):
        return get_user_model().objects.create_user(
            phone=f"+86137{uuid4().int % 100000000:08d}",
            password="test-password",
            nickname=name,
        )

    def test_invitation_accepted_persists_canonical_copy_with_role_snapshot(self):
        inviter = self._user("邀请人")
        invitee = self._user("受邀人")

        InvitationService._push_invitation_response_notifications(
            inviter_id=str(inviter.id),
            responder_id=str(invitee.id),
            responder_name=invitee.nickname,
            wt_name="产品组织",
            wt_id=str(uuid4()),
            accepted=True,
            role="editor",
            invitation_id=str(uuid4()),
        )

        notification = Notification.objects.get(
            user_id=str(inviter.id),
            type="organization.invitation.responded",
        )
        self.assertEqual(notification.title, "受邀人已接受组织邀请")
        self.assertEqual(notification.body, "对方已加入「产品组织」，角色为“编辑者”。")
        self.assertEqual(notification.metadata["role"], "editor")

    def test_invitation_cancelled_persists_canonical_copy_with_actor_snapshot(self):
        owner = self._user("组织管理员")
        target = self._user("受邀成员")
        organization = Organization.objects.create(
            name="产品组织",
            owner=owner,
            type=Organization.OrganizationType.TEAM,
        )
        OrganizationMember.objects.create(
            organization=organization,
            user=owner,
            role="owner",
        )
        invitation = OrganizationInvitation.objects.create(
            organization=organization,
            invited_by=str(owner.id),
            invite_type="direct",
            invited_user_id=str(target.id),
            role="viewer",
            token=f"cancel-{uuid4()}",
            expires_at=timezone.now() + timedelta(days=1),
            max_uses=1,
        )

        InvitationService(user=owner).cancel_invitation(organization.id, invitation.id)

        notification = Notification.objects.get(
            user_id=str(target.id),
            type="organization.invitation.cancelled",
        )
        self.assertEqual(notification.title, "加入「产品组织」的邀请已取消")
        self.assertEqual(notification.body, "该邀请已由组织管理员取消，无需继续处理。")
        self.assertEqual(notification.metadata["actor_name"], "组织管理员")
