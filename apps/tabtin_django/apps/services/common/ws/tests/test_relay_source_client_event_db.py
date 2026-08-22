from __future__ import annotations

import os
import sys
import uuid
from unittest.mock import patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")
if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402

django.setup()

from django.contrib.auth import get_user_model  # noqa: E402
from django.test import TestCase  # noqa: E402

from apps.chat.conversation.models import ChatMessage, ChatSession  # noqa: E402
from apps.services.common.ws.handlers.relay_message_writer import (  # noqa: E402
    _sync_write_critical_events,
)
from apps.services.agent_engine.services.agent_router import (  # noqa: E402
    RoutingDecision,
    RoutingError,
    handle_routing_decision,
)
from apps.services.agent_engine.services.message_intake import push_queue_error  # noqa: E402

User = get_user_model()


class RelaySourceClientEventPersistenceTests(TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from django.db.models.signals import post_save
        from apps.tabtinspace.signals import create_default_organization
        post_save.disconnect(create_default_organization, sender=User)

    @classmethod
    def tearDownClass(cls):
        from django.db.models.signals import post_save
        from apps.tabtinspace.signals import create_default_organization
        post_save.connect(create_default_organization, sender=User)
        super().tearDownClass()

    def setUp(self):
        self.user = User.objects.create_user(
            username="relay_source_user",
            email="relay-source@example.com",
            password="testpass123",
        )
        self.session = ChatSession.objects.create(
            user=self.user,
            organization_id="test-organization",
            title="source correlation",
        )

    @patch(
        "apps.services.common.ws.handlers.relay_message_writer."
        "_publish_message_committed"
    )
    def test_persist_message_copies_top_level_source_into_assistant_metadata(
        self,
        _publish_committed,
    ):
        source_id = str(uuid.uuid4())
        assistant_id = str(uuid.uuid4())
        result = _sync_write_critical_events(
            str(self.session.id),
            self.session.thread_id or f"chat-session-{self.session.id}",
            str(self.user.id),
            [{
                "type": "agent.stream.persist_message",
                "payload": {
                    "message_id": assistant_id,
                    "client_event_id": assistant_id,
                    "role": "assistant",
                    "blocks_json": [{"type": "text", "text": "reply"}],
                    "arrival_seq": 123,
                    "source_client_event_id": source_id,
                },
            }],
        )

        self.assertTrue(result.success)
        message = ChatMessage.objects.get(id=assistant_id)
        self.assertEqual(message.metadata["source_client_event_id"], source_id)

    @patch("apps.services.common.chat_stream_publisher.ChatStreamPublisher.publish_stream_done")
    def test_django_generated_error_assistant_keeps_source_user_identity(
        self,
        publish_done,
    ):
        source_id = uuid.uuid4()
        user_message = ChatMessage.objects.create(
            id=source_id,
            session=self.session,
            role="user",
            client_event_id=source_id,
            content_blocks_json=[{"type": "text", "text": "hello"}],
            text_summary="hello",
        )
        routing = RoutingDecision(
            target="error",
            handled=True,
            error=RoutingError(
                error_category="device_offline",
                user_message="device offline",
                retryable=True,
            ),
        )

        result = handle_routing_decision(
            routing,
            session=self.session,
            effective_thread_id=f"chat-session-{self.session.id}",
            model_instance=None,
            user_messages=[user_message],
        )

        assistant = ChatMessage.objects.get(id=result["error_message_id"])
        self.assertEqual(
            assistant.metadata["source_client_event_id"],
            str(source_id),
        )
        publish_done.assert_called_once_with(
            f"chat-session-{self.session.id}",
            "[device_offline] device offline",
            message_id=str(assistant.id),
            metadata={"error_category": "device_offline"},
            source_client_event_id=str(source_id),
        )

    @patch("apps.services.common.chat_stream_publisher.ChatStreamPublisher.publish_stream_done")
    @patch(
        "apps.services.agent_engine.observability.error_category."
        "classify_agent_error",
        return_value="internal_error",
    )
    def test_queue_error_assistant_uses_latest_persisted_user_as_source(
        self,
        _classify,
        publish_done,
    ):
        source_id = uuid.uuid4()
        ChatMessage.objects.create(
            id=source_id,
            session=self.session,
            role="user",
            client_event_id=source_id,
            content_blocks_json=[{"type": "text", "text": "queued"}],
            text_summary="queued",
        )

        result = push_queue_error(
            self.session,
            f"chat-session-{self.session.id}",
            RuntimeError("queue failed"),
        )

        assistant = ChatMessage.objects.get(id=result["error_message_id"])
        self.assertEqual(
            assistant.metadata["source_client_event_id"],
            str(source_id),
        )
        self.assertEqual(
            publish_done.call_args.kwargs["source_client_event_id"],
            str(source_id),
        )
