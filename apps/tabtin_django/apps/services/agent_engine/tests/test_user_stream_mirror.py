from types import SimpleNamespace
from unittest.mock import patch
import uuid

from django.test import SimpleTestCase

from apps.services.agent_engine.services.persistence_pipeline import (
    publish_user_messages_to_stream,
)
from apps.services.common.agent_protocol.constants import AgentStreamEvent
from apps.services.common.chat_stream_publisher import ChatStreamPublisher


class UserStreamMirrorTests(SimpleTestCase):
    def test_user_messages_publish_standard_stream_payload(self):
        client_event_id = uuid.uuid4()
        message_id = uuid.uuid4()
        msg = SimpleNamespace(
            id=message_id,
            client_event_id=client_event_id,
            text_summary="hello from mobile",
            content_blocks_json=[{"type": "text", "text": "hello from mobile"}],
            attachments_json=[],
            metadata={"client_message_id": str(client_event_id)},
        )

        with patch.object(ChatStreamPublisher, "publish_ws") as publish_ws:
            publish_user_messages_to_stream("chat-session-s1", [msg])

        publish_ws.assert_called_once()
        thread_id, event_type, payload = publish_ws.call_args.args
        assert thread_id == "chat-session-s1"
        assert event_type == AgentStreamEvent.USER
        assert payload == {
            "message_id": str(message_id),
            "client_event_id": str(client_event_id),
            "content": "hello from mobile",
            "blocks_json": [{"type": "text", "text": "hello from mobile"}],
            "content_blocks_json": [{"type": "text", "text": "hello from mobile"}],
        }

    def test_user_messages_publish_full_text_not_summary(self):
        client_event_id = uuid.uuid4()
        message_id = uuid.uuid4()
        full_text = "x" * 260
        msg = SimpleNamespace(
            id=message_id,
            client_event_id=client_event_id,
            text_summary=full_text[:200],
            content_blocks_json=[{"type": "text", "text": full_text}],
            attachments_json=[],
            metadata={},
        )

        with patch.object(ChatStreamPublisher, "publish_ws") as publish_ws:
            publish_user_messages_to_stream("chat-session-s1", [msg])

        payload = publish_ws.call_args.args[2]
        assert payload["content"] == full_text

    def test_user_stream_events_are_reliable(self):
        assert AgentStreamEvent.USER in ChatStreamPublisher._CRITICAL_EVENTS
