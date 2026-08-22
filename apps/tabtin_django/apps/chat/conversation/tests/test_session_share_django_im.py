"""开源线共享任务走 Django IM 私聊发卡。"""

from __future__ import annotations

from django.contrib.auth import get_user_model
from django.test import TestCase

from apps.agent.models import Agent
from apps.chat.conversation.models import ChatSession
from apps.chat.conversation.services import (
    session_share_card_service,
    session_share_service,
)
from apps.tabchat.constants import IMEventType
from apps.tabchat.models import Conversation, IMEventOutbox, Message
from apps.tabchat.services.message_service import _validate_card_metadata
from apps.tabtinspace.models import (
    Device,
    Organization,
    OrganizationMember,
    Workspace,
)

User = get_user_model()


class SessionShareDjangoImIntegrationTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self) -> None:
        self.owner = User.objects.create_user(
            username="django_im_share_owner",
            email="django-im-share-owner@test.com",
            password="pass123",
        )
        self.grantee = User.objects.create_user(
            username="django_im_share_grantee",
            email="django-im-share-grantee@test.com",
            password="pass123",
        )
        self.outsider = User.objects.create_user(
            username="django_im_share_outsider",
            email="django-im-share-outsider@test.com",
            password="pass123",
        )
        self.organization = Organization.objects.create(
            name="Django IM Share Org",
            owner=self.owner,
        )
        OrganizationMember.objects.create(
            organization=self.organization, user=self.owner, role="owner",
        )
        OrganizationMember.objects.create(
            organization=self.organization, user=self.grantee, role="editor",
        )
        other_org = Organization.objects.create(
            name="Django IM Other Org",
            owner=self.outsider,
        )
        OrganizationMember.objects.create(
            organization=other_org, user=self.outsider, role="owner",
        )
        agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.owner,
            name="Django IM Owner Agent",
        )
        device = Device.objects.create(
            organization=self.organization,
            user=self.owner,
            name="Django IM Owner Device",
            device_type="electron",
            role="control",
            fingerprint="django-im-share-owner-ws",
            status="online",
        )
        workspace = Workspace.objects.create(
            organization=self.organization,
            device=device,
            created_by=self.owner,
            name="Django IM Owner WS",
            working_dir="/tmp/django-im-share-owner-ws",
            normalized_working_dir="/tmp/django-im-share-owner-ws",
            kind=Workspace.Kind.STANDARD,
        )
        self.session = ChatSession.objects.create(
            user=self.owner,
            organization_id=str(self.organization.id),
            agent=agent,
            workspace=workspace,
            title="数据管道排查",
        )

    def test_share_and_send_card_writes_django_dm_and_card(self):
        client_request_id = "019fcaa1-3333-7333-8333-333333333333"

        result = session_share_card_service.share_and_send_card(
            actor_user=self.owner,
            session_id=str(self.session.id),
            grantee_user_id=str(self.grantee.id),
            card_contract="session_share_v2",
            client_request_id=client_request_id,
        )

        conversation = Conversation.objects.get(id=result["conversation_id"])
        message = Message.objects.get(
            conversation=conversation,
            client_request_id=client_request_id,
        )
        self.assertEqual(conversation.member_count, 2)
        self.assertEqual(result["delivery_status"], "confirmed")
        self.assertEqual(result["status"], "pending")
        self.assertEqual(result["message_ref"], client_request_id)
        self.assertEqual(int(result["message_id"]), message.seq)
        self.assertEqual(message.metadata["card"]["type"], "session_share_v2")
        self.assertEqual(message.metadata["card"]["object_id"], result["id"])
        self.assertEqual(
            IMEventOutbox.objects.filter(
                event_type=IMEventType.SESSION_SHARE_UPDATE,
                conversation=conversation,
            ).count(),
            1,
        )

    def test_retry_reuses_the_same_django_message(self):
        client_request_id = "019fcaa1-4444-7444-8444-444444444444"
        first = session_share_card_service.share_and_send_card(
            actor_user=self.owner,
            session_id=str(self.session.id),
            grantee_user_id=str(self.grantee.id),
            card_contract="session_share_v2",
            client_request_id=client_request_id,
        )
        second = session_share_card_service.share_and_send_card(
            actor_user=self.owner,
            session_id=str(self.session.id),
            grantee_user_id=str(self.grantee.id),
            card_contract="session_share_v2",
            client_request_id=client_request_id,
        )

        self.assertEqual(first["id"], second["id"])
        self.assertEqual(
            Message.objects.filter(client_request_id=client_request_id).count(),
            1,
        )

    def test_v2_card_validation_rebuilds_stable_object_reference(self):
        share = session_share_service.create_or_update_share(
            session_id=str(self.session.id),
            owner_user=self.owner,
            grantee_user_id=str(self.grantee.id),
            card_contract="session_share_v2",
            status="pending",
        )

        validated = _validate_card_metadata(
            {
                "card": {
                    "type": "session_share_v2",
                    "object_id": str(share.id),
                    "version": 99,
                    "title_snapshot": "伪造标题",
                },
            },
            str(self.owner.id),
            str(self.organization.id),
        )

        self.assertEqual(validated["card"]["object_id"], str(share.id))
        self.assertEqual(validated["card"]["title_snapshot"], "数据管道排查")
        self.assertEqual(validated["card"]["sender_id"], str(self.owner.id))
        self.assertEqual(validated["card"]["recipient_id"], str(self.grantee.id))
        self.assertEqual(validated["card"]["version"], 1)

    def test_outsider_is_rejected_before_django_delivery(self):
        with self.assertRaises(ValueError):
            session_share_card_service.share_and_send_card(
                actor_user=self.owner,
                session_id=str(self.session.id),
                grantee_user_id=str(self.outsider.id),
                card_contract="session_share_v2",
                client_request_id="019fcaa1-5555-7555-8555-555555555555",
            )
        self.assertFalse(
            Conversation.objects.filter(organization_id=str(self.organization.id)).exists()
        )
        self.assertFalse(
            Message.objects.filter(
                conversation__organization_id=str(self.organization.id),
            ).exists()
        )
