"""开源线任务续接卡走 Django IM 私聊投递。"""

from __future__ import annotations

from django.contrib.auth import get_user_model
from django.test import TestCase

from apps.agent.models import Agent
from apps.chat.conversation.models import ChatSession, SessionContinuation
from apps.chat.conversation.services import session_continuation_service
from apps.tabchat.constants import IMEventType, MessageType
from apps.tabchat.models import Conversation, IMEventOutbox, Message
from apps.tabchat.services.conversation_service import ConversationService
from apps.tabchat.services.message_service import MessageService, _validate_card_metadata
from apps.tabtinspace.models import (
    Device,
    Organization,
    OrganizationMember,
    Workspace,
)

User = get_user_model()


class SessionContinuationDjangoImIntegrationTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self) -> None:
        self.sender = User.objects.create_user(
            username="django_im_cont_sender",
            email="django-im-cont-sender@test.com",
            password="pass123",
        )
        self.recipient = User.objects.create_user(
            username="django_im_cont_recipient",
            email="django-im-cont-recipient@test.com",
            password="pass123",
        )
        self.organization = Organization.objects.create(
            name="Django IM Continuation Org",
            owner=self.sender,
        )
        OrganizationMember.objects.create(
            organization=self.organization, user=self.sender, role="owner",
        )
        OrganizationMember.objects.create(
            organization=self.organization, user=self.recipient, role="editor",
        )
        self.other_user = User.objects.create_user(
            username="django_im_cont_other",
            email="django-im-cont-other@test.com",
            password="pass123",
        )
        OrganizationMember.objects.create(
            organization=self.organization, user=self.other_user, role="editor",
        )
        self.other_conversation = ConversationService.create_dm(
            organization_id=str(self.organization.id),
            creator_id=str(self.sender.id),
            other_user_id=str(self.other_user.id),
        )
        agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.sender,
            name="Django IM Continuation Agent",
        )
        device = Device.objects.create(
            organization=self.organization,
            user=self.sender,
            name="Django IM Continuation Device",
            device_type="electron",
            role="control",
            fingerprint="django-im-cont-sender-ws",
            status="online",
        )
        workspace = Workspace.objects.create(
            organization=self.organization,
            device=device,
            created_by=self.sender,
            name="Django IM Continuation WS",
            working_dir="/tmp/django-im-cont-sender-ws",
            normalized_working_dir="/tmp/django-im-cont-sender-ws",
            kind=Workspace.Kind.STANDARD,
        )
        self.session = ChatSession.objects.create(
            user=self.sender,
            organization_id=str(self.organization.id),
            agent=agent,
            workspace=workspace,
            title="佛手柑拼多多调研任务",
        )

    def test_create_and_send_writes_django_dm_and_card(self):
        client_request_id = "019fcaa1-6666-7666-8666-666666666666"
        decoy = MessageService.send_message(
            conversation_id=str(self.other_conversation.id),
            sender_id=str(self.sender.id),
            content="同请求号的普通消息",
            message_type=MessageType.TEXT,
            client_request_id=client_request_id,
        )

        result = session_continuation_service.create_and_send(
            sender_user=self.sender,
            source_session_id=str(self.session.id),
            recipient_user_id=str(self.recipient.id),
            client_request_id=client_request_id,
        )

        continuation = SessionContinuation.objects.get(client_request_id=client_request_id)
        conversation = Conversation.objects.get(id=continuation.card_conversation_id)
        message = Message.objects.get(
            conversation=conversation,
            client_request_id=client_request_id,
        )
        self.assertEqual(result["delivery_status"], "confirmed")
        self.assertEqual(continuation.delivery_status, "confirmed")
        self.assertEqual(conversation.member_count, 2)
        self.assertEqual(message.metadata["card"]["type"], "session_continuation")
        self.assertEqual(message.metadata["card"]["object_id"], str(continuation.id))
        self.assertIn("佛手柑拼多多调研任务", message.content)

        validated = _validate_card_metadata(
            {
                "card": {
                    "type": "session_continuation",
                    "object_id": str(continuation.id),
                    "version": 99,
                    "title_snapshot": "伪造标题",
                },
            },
            str(self.sender.id),
            str(self.organization.id),
            str(conversation.id),
        )
        self.assertEqual(validated["card"]["title_snapshot"], self.session.title)
        self.assertEqual(validated["card"]["version"], continuation.version)

        session_continuation_service._refresh_card(continuation)
        message.refresh_from_db()
        decoy.refresh_from_db()
        self.assertEqual(message.metadata["card"], validated["card"])
        self.assertEqual(decoy.content, "同请求号的普通消息")
        self.assertTrue(
            IMEventOutbox.objects.filter(
                event_type=IMEventType.MESSAGE_EDITED,
                conversation=conversation,
                message=message,
            ).exists(),
        )

        with self.assertRaises(PermissionError):
            MessageService.send_message(
                conversation_id=str(self.other_conversation.id),
                sender_id=str(self.sender.id),
                content="[任务续接] 错误会话",
                message_type=MessageType.TEXT,
                metadata={
                    "card": {
                        "type": "session_continuation",
                        "object_id": str(continuation.id),
                    },
                },
                client_request_id="019fcaa1-7777-7777-8777-777777777777",
            )

    def test_same_dm_request_id_collision_is_rejected(self):
        client_request_id = "019fcaa1-8888-7888-8888-888888888888"
        conversation = ConversationService.create_dm(
            organization_id=str(self.organization.id),
            creator_id=str(self.sender.id),
            other_user_id=str(self.recipient.id),
        )
        decoy = MessageService.send_message(
            conversation_id=str(conversation.id),
            sender_id=str(self.sender.id),
            content="同请求号的普通消息",
            message_type=MessageType.TEXT,
            client_request_id=client_request_id,
        )

        with self.assertRaises(
            session_continuation_service.SessionContinuationDeliveryError,
        ) as raised:
            session_continuation_service.create_and_send(
                sender_user=self.sender,
                source_session_id=str(self.session.id),
                recipient_user_id=str(self.recipient.id),
                client_request_id=client_request_id,
                conversation_id_hint=str(conversation.id),
            )

        decoy.refresh_from_db()
        continuation = SessionContinuation.objects.get(
            client_request_id=client_request_id,
        )
        self.assertEqual(raised.exception.code, "IM_DELIVERY_REJECTED")
        self.assertEqual(continuation.delivery_status, "rejected")
        self.assertEqual(decoy.content, "同请求号的普通消息")
        self.assertNotIn("card", decoy.metadata)
