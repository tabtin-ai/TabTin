from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.core.cache import cache
from django.test import SimpleTestCase
from django.utils import timezone

from apps.tabchat.services.agent_message_projection import (
    ERROR_EVENT_TYPE,
    FINAL_EVENT_TYPE,
    STREAM_EVENT_TYPE,
    project_agent_stream_events,
    publish_agent_message_error,
    publish_agent_message_final,
    register_agent_message_stream,
)


class AgentMessageProjectionTests(SimpleTestCase):
    def setUp(self):
        cache.clear()
        self.job = SimpleNamespace(
            id=uuid.uuid4(),
            session_id=uuid.uuid4(),
            conversation_id=uuid.uuid4(),
            source_message_id=123,
        )
        self.agent = SimpleNamespace(
            id=uuid.uuid4(),
            name="文档助手",
            settings={"avatar_url": "https://cdn.example.com/agent.png"},
        )
        self.thread_id = f"chat-session-{self.job.session_id}"
        register_agent_message_stream(
            thread_id=self.thread_id,
            job=self.job,
            conversation_id=str(self.job.conversation_id),
            agent=self.agent,
        )

    @patch(
        "apps.tabchat.services.agent_message_projection.get_centrifugo_service"
    )
    def test_stream_forwards_only_assistant_text_deltas(self, get_service):
        service = MagicMock()
        get_service.return_value = service
        assistant_message_id = str(uuid.uuid4())
        user_message_id = str(uuid.uuid4())

        published = project_agent_stream_events(
            self.thread_id,
            [
                {
                    "type": "agent.stream.message_start",
                    "payload": {"message_id": user_message_id, "role": "user"},
                },
                {
                    "type": "agent.stream.content_block_delta",
                    "payload": {
                        "message_id": user_message_id,
                        "delta": {"type": "text_delta", "text": "用户文本"},
                    },
                },
                {
                    "type": "agent.stream.message_start",
                    "payload": {
                        "message_id": assistant_message_id,
                        "role": "assistant",
                    },
                },
                {
                    "type": "agent.stream.content_block_delta",
                    "payload": {
                        "message_id": assistant_message_id,
                        "delta": {"type": "thinking_delta", "thinking": "内部思考"},
                    },
                },
                {
                    "type": "agent.stream.content_block_delta",
                    "payload": {
                        "message_id": assistant_message_id,
                        "delta": {"type": "text_delta", "text": "你好"},
                    },
                },
                {
                    "type": "agent.stream.content_block_delta",
                    "payload": {
                        "message_id": assistant_message_id,
                        "delta": {
                            "type": "connector_text_delta",
                            "connector_text": "，世界",
                        },
                    },
                },
                {
                    "type": "agent.stream.content_block_delta",
                    "payload": {
                        "message_id": assistant_message_id,
                        "subagent_run_id": "subagent-1",
                        "delta": {"type": "text_delta", "text": "子 Agent"},
                    },
                },
            ],
        )

        self.assertTrue(published)
        channel, event = service.publish.call_args.args
        self.assertEqual(channel, f"chat:{self.job.conversation_id}")
        self.assertEqual(set(event), {"type", "data"})
        self.assertEqual(event["type"], STREAM_EVENT_TYPE)
        self.assertEqual(
            set(event["data"]),
            {
                "conversation_id",
                "message_ref",
                "agent_session_ref",
                "sender_id",
                "sender_name",
                "sender_avatar",
                "delta",
                "stream_seq",
                "created_at",
            },
        )
        self.assertEqual(event["data"]["delta"], "你好，世界")
        self.assertEqual(event["data"]["stream_seq"], 1)
        self.assertEqual(event["data"]["message_ref"], str(self.job.id))
        self.assertEqual(event["data"]["agent_session_ref"], str(self.job.session_id))

        project_agent_stream_events(
            self.thread_id,
            [
                {
                    "type": "content_block_delta",
                    "payload": {
                        "message_id": assistant_message_id,
                        "delta": {"type": "text_delta", "text": "！"},
                    },
                }
            ],
        )
        self.assertEqual(service.publish.call_args.args[1]["data"]["stream_seq"], 2)

    @patch(
        "apps.tabchat.services.agent_message_projection.get_centrifugo_service"
    )
    @patch("apps.tabchat.services.agent_message_projection._load_agent")
    def test_final_contract_has_no_local_ordering_fields(self, load_agent, get_service):
        load_agent.return_value = self.agent
        service = MagicMock()
        get_service.return_value = service
        message = SimpleNamespace(
            id=9_007_199_254_740_993,
            content="完整最终正文",
            message_type=1,
            metadata={
                "message_ref": str(self.job.id),
                "agent_session_ref": str(self.job.session_id),
                "source_message_id": "123",
                "kind": "tabtin_ref",
            },
            created_at=timezone.now(),
        )

        self.assertTrue(publish_agent_message_final(self.job, message))
        channel, event = service.publish.call_args.args
        self.assertEqual(channel, f"chat:{self.job.conversation_id}")
        self.assertEqual(event["type"], FINAL_EVENT_TYPE)
        self.assertEqual(set(event), {"type", "data"})
        self.assertEqual(
            set(event["data"]),
            {
                "conversation_id",
                "message_ref",
                "agent_session_ref",
                "sender_id",
                "sender_name",
                "sender_avatar",
                "content",
                "message_type",
                "metadata",
                "created_at",
            },
        )
        self.assertNotIn("tabtin_message_id", event["data"])
        self.assertNotIn("id", event["data"])
        self.assertNotIn("seq", event["data"])
        self.assertNotIn("stream_seq", event["data"])

    @patch(
        "apps.tabchat.services.agent_message_projection.get_centrifugo_service"
    )
    @patch("apps.tabchat.services.agent_message_projection._load_agent")
    def test_error_contract_contains_only_correlation_and_agent(self, load_agent, get_service):
        load_agent.return_value = self.agent
        service = MagicMock()
        get_service.return_value = service

        self.assertTrue(publish_agent_message_error(self.job))
        channel, event = service.publish.call_args.args
        self.assertEqual(channel, f"chat:{self.job.conversation_id}")
        self.assertEqual(event["type"], ERROR_EVENT_TYPE)
        self.assertEqual(
            set(event["data"]),
            {
                "conversation_id",
                "message_ref",
                "agent_session_ref",
                "sender_id",
                "sender_name",
                "sender_avatar",
            },
        )
        self.assertFalse(
            project_agent_stream_events(
                self.thread_id,
                [
                    {
                        "type": "agent.stream.message_start",
                        "payload": {"message_id": "late", "role": "assistant"},
                    },
                    {
                        "type": "agent.stream.content_block_delta",
                        "payload": {
                            "message_id": "late",
                            "delta": {"type": "text_delta", "text": "迟到内容"},
                        },
                    },
                ],
            )
        )
        service.publish.assert_called_once()
