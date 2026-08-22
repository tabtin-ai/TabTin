from django.test import SimpleTestCase

from apps.tabchat.services.agent_message_reference import (
    deliver_agent_mention_reaction,
    deliver_agent_message_reference,
)


class AgentMessageReferenceTests(SimpleTestCase):
    def test_reaction_delivery_is_local_noop(self):
        result = deliver_agent_mention_reaction(
            organization_id="org-1",
            conversation_ref="conv-1",
            message_ref="msg-1",
            source_user_id="user-1",
            agent=None,
            source_message_seq=1,
        )
        self.assertFalse(result.delivered)
        self.assertEqual(result.context, ())

    def test_message_reference_delivery_is_local_noop(self):
        self.assertFalse(deliver_agent_message_reference("job-1"))
