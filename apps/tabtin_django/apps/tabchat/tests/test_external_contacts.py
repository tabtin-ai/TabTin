from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone

from apps.services.common.db_router import postgres_app_db_alias
from apps.tabchat.models import (
    ConversationMember,
    ExternalContact,
    ExternalContactInvitation,
)
from apps.tabchat.services.conversation_access import ConversationAccessResolver
from apps.tabchat.services.conversation_service import ConversationService
from apps.tabchat.services.external_contact_service import (
    ExternalContactResolver,
    ExternalContactService,
)
from apps.tabchat.services.message_service import MessageService
from apps.tabtinspace.models import Organization, OrganizationMember


User = get_user_model()


class ExternalContactControlPlaneTests(TestCase):
    databases = ["default", "postgresql"]

    def setUp(self):
        self.alice = User.objects.create_user(
            email="external-contact-alice@example.com",
            phone="17511610001",
            password="pass123",
            nickname="Alice",
        )
        self.bob = User.objects.create_user(
            email="external-contact-bob@example.com",
            phone="17511610002",
            password="pass123",
            nickname="Bob",
        )
        self.internal = User.objects.create_user(
            email="external-contact-internal@example.com",
            phone="17511610003",
            password="pass123",
            nickname="Internal",
        )
        self.alice_org = Organization.objects.create(name="Alice Org", owner=self.alice)
        self.bob_org = Organization.objects.create(name="Bob Org", owner=self.bob)
        for organization, user, role in (
            (self.alice_org, self.alice, "owner"),
            (self.alice_org, self.internal, "editor"),
            (self.bob_org, self.bob, "owner"),
        ):
            OrganizationMember.objects.create(
                organization=organization,
                user=user,
                role=role,
            )

    def establish_contact(self):
        invitation = ExternalContactService.invite(
            str(self.alice.id),
            str(self.alice_org.id),
            str(self.bob.id),
            "一起协作",
        )
        ExternalContactService.accept(
            str(self.bob.id),
            str(self.bob_org.id),
            invitation["invitation_id"],
        )
        alice_contact = ExternalContact.objects.get(
            owner_user=self.alice,
            peer_user=self.bob,
        )
        bob_contact = ExternalContact.objects.get(
            owner_user=self.bob,
            peer_user=self.alice,
        )
        return alice_contact, bob_contact

    def test_discover_invite_accept_creates_bidirectional_friend_projection(self):
        candidate = ExternalContactService.discover(
            str(self.alice.id),
            str(self.alice_org.id),
            "+8617511610002",
        )
        self.assertEqual(candidate["user_id"], str(self.bob.id))
        self.assertEqual(candidate["relationship"], "none")

        invitation_result = ExternalContactService.invite(
            str(self.alice.id),
            str(self.alice_org.id),
            str(self.bob.id),
            "一起协作",
        )
        incoming = ExternalContactService.list_invitations(
            str(self.bob.id),
            direction="incoming",
            status="pending",
        )
        self.assertEqual([item["invitation_id"] for item in incoming], [invitation_result["invitation_id"]])

        accepted = ExternalContactService.accept(
            str(self.bob.id),
            str(self.bob_org.id),
            invitation_result["invitation_id"],
        )
        self.assertEqual(accepted["relationship"], ExternalContact.Relationship.FRIEND)
        alice_contact, bob_contact = self.established_contacts()
        self.assertEqual(alice_contact.peer_organization, self.bob_org)
        self.assertEqual(bob_contact.peer_organization, self.alice_org)

    def test_invitation_reject_cancel_and_expire_are_terminal(self):
        rejected = ExternalContactService.invite(
            str(self.alice.id),
            str(self.alice_org.id),
            str(self.bob.id),
        )
        result = ExternalContactService.resolve_invitation(
            str(self.bob.id),
            rejected["invitation_id"],
            "reject",
        )
        self.assertEqual(result["status"], ExternalContactInvitation.Status.REJECTED)

        cancelled = ExternalContactService.invite(
            str(self.alice.id),
            str(self.alice_org.id),
            str(self.bob.id),
        )
        result = ExternalContactService.resolve_invitation(
            str(self.alice.id),
            cancelled["invitation_id"],
            "cancel",
        )
        self.assertEqual(result["status"], ExternalContactInvitation.Status.CANCELLED)

        expired = ExternalContactService.invite(
            str(self.alice.id),
            str(self.alice_org.id),
            str(self.bob.id),
        )
        ExternalContactInvitation.objects.filter(id=expired["invitation_id"]).update(
            expires_at=timezone.now() - timedelta(seconds=1),
        )
        self.assertEqual(
            ExternalContactService.list_invitations(
                str(self.bob.id),
                direction="incoming",
                status="expired",
            )[0]["status"],
            ExternalContactInvitation.Status.EXPIRED,
        )

    @patch(
        "apps.services.notification.services.notification_service."
        "NotificationService.notify",
    )
    def test_invitation_notifications_are_created_by_django(self, mock_notify):
        with self.captureOnCommitCallbacks(
            using=postgres_app_db_alias(),
            execute=True,
        ):
            invited = ExternalContactService.invite(
                str(self.alice.id),
                str(self.alice_org.id),
                str(self.bob.id),
            )

        first = mock_notify.call_args_list[0].kwargs
        self.assertEqual(first["user_id"], str(self.bob.id))
        self.assertEqual(first["type"], "organization.invitation.external_contact")

        with self.captureOnCommitCallbacks(
            using=postgres_app_db_alias(),
            execute=True,
        ):
            ExternalContactService.resolve_invitation(
                str(self.bob.id),
                invited["invitation_id"],
                "reject",
            )

        second = mock_notify.call_args_list[1].kwargs
        self.assertEqual(second["user_id"], str(self.alice.id))
        self.assertEqual(
            second["type"],
            "organization.invitation.external_contact.rejected",
        )

    def test_external_dm_is_globally_reused_and_block_window_hides_messages(self):
        alice_contact, bob_contact = self.establish_contact()
        first = ConversationService.create_external_dm(
            str(self.alice_org.id),
            str(self.alice.id),
            str(alice_contact.id),
        )
        reverse = ConversationService.create_external_dm(
            str(self.bob_org.id),
            str(self.bob.id),
            str(bob_contact.id),
        )
        self.assertEqual(first.id, reverse.id)

        alice_summary = next(
            item
            for item in ConversationService.list_conversations(
                str(self.alice_org.id),
                str(self.alice.id),
            )
            if item["id"] == str(first.id)
        )
        bob_summary = next(
            item
            for item in ConversationService.list_conversations(
                str(self.bob_org.id),
                str(self.bob.id),
            )
            if item["id"] == str(first.id)
        )
        self.assertEqual(
            alice_summary["dm_peer_organization_id"],
            str(self.bob_org.id),
        )
        self.assertEqual(
            bob_summary["dm_peer_organization_id"],
            str(self.alice_org.id),
        )

        MessageService.send_message(str(first.id), str(self.bob.id), "拉黑前")
        ExternalContactService.update_contact(
            str(self.alice.id),
            str(self.alice_org.id),
            str(alice_contact.id),
            "block",
        )
        blocked_access = ConversationAccessResolver.resolve(first, str(self.alice.id))
        self.assertFalse(blocked_access.can_send)
        MessageService.send_message(str(first.id), str(self.bob.id), "拉黑期间")

        ExternalContactService.update_contact(
            str(self.alice.id),
            str(self.alice_org.id),
            str(alice_contact.id),
            "unblock",
        )
        MessageService.send_message(str(first.id), str(self.bob.id), "解除后")
        contents = {
            item["content"]
            for item in MessageService.get_messages(str(first.id), str(self.alice.id))
        }
        self.assertEqual(contents, {"拉黑前", "解除后"})

    def test_add_external_contact_converts_group_and_limits_history(self):
        alice_contact, _ = self.establish_contact()
        with patch(
            "apps.services.billing.services.entitlement_limits_service."
            "EntitlementLimitsService.check_group_limit",
        ):
            conversation = ConversationService.create_group(
                organization_id=str(self.alice_org.id),
                creator_id=str(self.alice.id),
                name="先内部后外部",
                member_ids=[str(self.internal.id)],
            )
        MessageService.send_message(
            str(conversation.id),
            str(self.alice.id),
            "加入前历史",
        )
        resolved = ExternalContactResolver.resolve_for_group(
            str(self.alice.id),
            [str(alice_contact.id)],
        )
        added = ConversationService.add_members(
            str(conversation.id),
            str(self.alice.id),
            [],
            external_contacts=resolved,
        )
        self.assertEqual(added, [str(self.bob.id)])
        conversation.refresh_from_db()
        self.assertTrue(conversation.is_external)
        bob_member = ConversationMember.objects.get(
            conversation=conversation,
            user_id=str(self.bob.id),
        )
        self.assertEqual(bob_member.participant_organization_id, str(self.bob_org.id))

        with patch(
            "apps.tabchat.services.message_service."
            "_safe_enqueue_im_message_push",
        ) as mock_push:
            with self.captureOnCommitCallbacks(
                using=postgres_app_db_alias(),
                execute=True,
            ):
                MessageService.send_message(
                    str(conversation.id),
                    str(self.alice.id),
                    "加入后消息",
                )
        push_recipients = {
            item["user_id"]: item
            for item in mock_push.call_args.args[0]["recipients"]
        }
        self.assertEqual(
            push_recipients[str(self.internal.id)]["organization_id"],
            str(self.alice_org.id),
        )
        self.assertEqual(
            push_recipients[str(self.bob.id)]["organization_id"],
            str(self.bob_org.id),
        )
        bob_contents = {
            item["content"]
            for item in MessageService.get_messages(str(conversation.id), str(self.bob.id))
        }
        self.assertNotIn("加入前历史", bob_contents)
        self.assertIn("加入后消息", bob_contents)
        self.assertIn("Bob 加入群聊", bob_contents)

    def established_contacts(self):
        return (
            ExternalContact.objects.get(owner_user=self.alice, peer_user=self.bob),
            ExternalContact.objects.get(owner_user=self.bob, peer_user=self.alice),
        )
