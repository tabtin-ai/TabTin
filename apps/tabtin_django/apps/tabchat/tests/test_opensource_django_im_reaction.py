"""开源 Django IM：表情反应同时接受消息 id 和 metadata.message_ref。"""

from unittest.mock import patch

from django.test import TestCase

from apps.tabchat.constants import IMEventType, MessageType
from apps.tabchat.models import MessageReaction
from apps.tabchat.services.conversation_service import ConversationService
from apps.tabchat.services.message_service import MessageService
from apps.tabtinspace.models import Organization, OrganizationMember
from apps.tabtinspace.tests.fixtures import create_test_user


class OpensourceDjangoImReactionTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self) -> None:
        self.owner = create_test_user(prefix="os-im-react-owner")
        self.peer = create_test_user(prefix="os-im-react-peer")
        self.organization = Organization.objects.create(name="OS IM React", owner=self.owner)
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.owner,
            role="owner",
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.peer,
            role="member",
        )
        self.conversation = ConversationService.create_dm(
            organization_id=str(self.organization.id),
            creator_id=str(self.owner.id),
            other_user_id=str(self.peer.id),
        )
        self.message = MessageService.send_message(
            conversation_id=str(self.conversation.id),
            sender_id=str(self.owner.id),
            content="你好",
            message_type=MessageType.TEXT,
            metadata={"message_ref": "019f0000-0000-7000-8000-000000000042"},
        )

    def test_resolve_visible_message_id_accepts_pk_and_message_ref(self) -> None:
        conversation_id = str(self.conversation.id)
        self.assertEqual(
            MessageService.resolve_visible_message_id(conversation_id, self.message.id),
            self.message.id,
        )
        self.assertEqual(
            MessageService.resolve_visible_message_id(
                conversation_id,
                "019f0000-0000-7000-8000-000000000042",
            ),
            self.message.id,
        )

    def test_add_reaction_by_message_ref(self) -> None:
        resolved_id = MessageService.resolve_visible_message_id(
            str(self.conversation.id),
            "019f0000-0000-7000-8000-000000000042",
        )
        created = MessageService.add_reaction(
            str(self.conversation.id),
            resolved_id,
            str(self.peer.id),
            "👍",
        )
        self.assertTrue(created)
        self.assertTrue(
            MessageReaction.objects.filter(
                message_id=self.message.id,
                user_id=self.peer.id,
                emoji="👍",
            ).exists()
        )

    @patch("apps.tabchat.services.message_service.IMOutboxService.enqueue")
    def test_remove_reaction_event_includes_message_ref(self, enqueue) -> None:
        conversation_id = str(self.conversation.id)
        MessageService.add_reaction(conversation_id, self.message.id, str(self.peer.id), "👍")
        enqueue.reset_mock()

        removed = MessageService.remove_reaction(
            conversation_id,
            self.message.id,
            str(self.peer.id),
            "👍",
        )

        self.assertTrue(removed)
        removed_events = [
            call
            for call in enqueue.call_args_list
            if call.kwargs.get("event_type") == IMEventType.REACTION_REMOVED
        ]
        self.assertEqual(len(removed_events), 1)
        self.assertEqual(
            removed_events[0].kwargs["data"]["message_ref"],
            "019f0000-0000-7000-8000-000000000042",
        )
