from uuid import uuid4

from django.test import SimpleTestCase

from apps.tabchat.api import legacy_message_router
from apps.tabchat.api import router as public_im_router
from apps.tabchat.schemas import CreateAgentMentionRequest


class AgentMentionIngressTests(SimpleTestCase):
    def test_django_message_routes_are_public(self):
        message_path = "/conversations/{conversation_id}/messages"
        self.assertIn(message_path, public_im_router.path_operations)
        self.assertIn(message_path, legacy_message_router.path_operations)

    def test_source_sequence_is_optional_for_older_clients(self):
        payload = CreateAgentMentionRequest(
            organization_id=str(uuid4()),
            conversation_ref=str(uuid4()),
            message_ref=str(uuid4()),
            content="@助手 继续",
            mentioned_agent_ids=[str(uuid4())],
        )

        self.assertIsNone(payload.source_message_seq)
        self.assertIsNone(payload.referenced_message)
