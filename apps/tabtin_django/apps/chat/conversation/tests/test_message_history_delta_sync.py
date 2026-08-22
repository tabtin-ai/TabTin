import asyncio
from datetime import timedelta
import uuid
from urllib.parse import urlencode
from unittest.mock import AsyncMock, MagicMock, patch

from django.contrib.auth import get_user_model
from django.db import connections
from django.db.models.signals import post_save
from django.test import RequestFactory, TransactionTestCase
from django.utils import timezone

from apps.chat.conversation.api.message import get_messages
from apps.chat.conversation.models import ChatMessage, ChatSession
from apps.services.agent_execution.chat_service import ChatService
from apps.services.common.agent_protocol.constants import AgentStreamEvent
from apps.services.common.chat_stream_publisher import ChatStreamPublisher
from apps.services.common.agent_protocol.namespace import stream_topic
from apps.services.common.ws.handlers.chat_send_message import (
    CHAT_SEND_MESSAGE_OK,
    create_chat_send_message_handler,
)
from apps.tabtinspace.signals import create_default_organization


User = get_user_model()


class MessageHistoryDeltaSyncTestCase(TransactionTestCase):
    """Local multi-device protocol probes for missed/replayed chat history."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        post_save.disconnect(create_default_organization, sender=User)

    @classmethod
    def tearDownClass(cls):
        post_save.connect(create_default_organization, sender=User)
        super().tearDownClass()

    def setUp(self):
        self.user = User.objects.create_user(
            username="delta_sync_user",
            email="delta-sync@example.com",
            password="testpass123",
        )
        self.session = ChatSession.objects.create(
            user=self.user,
            organization_id="delta-sync-organization",
            title="delta sync test",
        )
        self.factory = RequestFactory()

    def _get_messages(self, **params):
        query = urlencode(params)
        suffix = f"?{query}" if query else ""
        request = self.factory.get(f"/api/chat/sessions/{self.session.id}/messages{suffix}")
        request.auth = self.user
        response = get_messages(
            request,
            session_id=str(self.session.id),
            limit=int(params.get("limit", 50)),
        )
        self.assertTrue(response["success"], response)
        return response["data"]

    def test_observer_can_fetch_user_message_missed_from_live_stream(self):
        first_page = self._get_messages()
        watermark = first_page["server_timestamp"]
        client_event_id = uuid.uuid4()
        full_text = "mobile sent a prompt " * 20

        ChatMessage.objects.create(
            session=self.session,
            role="user",
            client_event_id=client_event_id,
            text_summary=full_text[:200],
            content_blocks_json=[{"type": "text", "text": full_text}],
        )

        delta = self._get_messages(updated_after=watermark)

        self.assertEqual(len(delta["messages"]), 1)
        msg = delta["messages"][0]
        self.assertEqual(msg["role"], "user")
        self.assertEqual(msg["client_event_id"], str(client_event_id))
        self.assertEqual(msg["content"], full_text)
        self.assertIsNotNone(delta["server_timestamp"])

    def test_observer_can_fetch_existing_assistant_message_after_late_update(self):
        assistant = ChatMessage.objects.create(
            session=self.session,
            role="assistant",
            text_summary="partial",
            content_blocks_json=[{"type": "text", "text": "partial"}],
        )
        first_page = self._get_messages()
        watermark = first_page["server_timestamp"]

        assistant.text_summary = "final answer"
        assistant.content_blocks_json = [{"type": "text", "text": "final answer"}]
        assistant.save(update_fields=["text_summary", "content_blocks_json", "updated_at"])

        delta = self._get_messages(updated_after=watermark)

        self.assertEqual([m["id"] for m in delta["messages"]], [str(assistant.id)])
        self.assertEqual(delta["messages"][0]["content_blocks_json"], [{"type": "text", "text": "final answer"}])

    def test_updated_before_keeps_paginated_delta_on_a_fixed_snapshot(self):
        updated_after = (timezone.now() - timedelta(seconds=5)).isoformat()
        ids = []
        for index in range(3):
            msg = ChatMessage.objects.create(
                session=self.session,
                role="assistant",
                text_summary=f"snapshot-{index}",
                content_blocks_json=[{"type": "text", "text": f"snapshot-{index}"}],
            )
            ids.append(str(msg.id))

        first_page = self._get_messages(updated_after=updated_after, limit=2)
        sync_watermark = first_page["server_timestamp"]

        late = ChatMessage.objects.create(
            session=self.session,
            role="assistant",
            text_summary="late-update",
            content_blocks_json=[{"type": "text", "text": "late-update"}],
        )

        second_page = self._get_messages(
            updated_after=updated_after,
            updated_before=sync_watermark,
            offset=2,
            limit=2,
        )

        first_ids = [m["id"] for m in first_page["messages"]]
        second_ids = [m["id"] for m in second_page["messages"]]
        self.assertEqual(first_ids, ids[:2])
        self.assertEqual(second_ids, ids[2:])
        self.assertNotIn(str(late.id), first_ids + second_ids)

    def test_ws_send_message_publishes_user_stream_and_returns_ack(self):
        thread_id = f"chat-session-{self.session.id}"
        client_event_id = uuid.uuid4()
        user_text = "hello from mobile over ws"
        call_order: list[str] = []

        consumer = MagicMock()
        consumer.role = "mobile"
        consumer.user = self.user
        consumer.user_id = str(self.user.id)

        async def _record_envelope(envelope):
            call_order.append(envelope["type"])

        consumer._send_envelope = AsyncMock(side_effect=_record_envelope)
        consumer._send_error = AsyncMock()

        handler = create_chat_send_message_handler(consumer)
        envelope = {
            "v": 1,
            "type": "chat.send_message",
            "request_id": "req-ws-user-stream",
            "ts": 1,
            "device_id": "ios-test-device",
            "role": "mobile",
            "payload": {
                "session_id": str(self.session.id),
                "message": user_text,
                "client_event_id": str(client_event_id),
                # task profile keeps the test focused on send/stream sync and
                # avoids unrelated title-generation side effects.
                "execution_profile": "task",
            },
        }

        prep = ChatService._PrepareResult(
            model_instance=None,
            model_fell_back=False,
            final_model_id=None,
            user_selected_model=False,
            resolved_agent_name="tin",
            effective_thread_id=thread_id,
            config={"configurable": {"thread_id": thread_id}},
            ws_id="test-organization",
            uid=str(self.user.id),
        )

        def _invoke_through_ingest(**kwargs):
            try:
                session = ChatSession.objects.get(id=self.session.id)
                user = User.objects.get(id=self.user.id)
                return ChatService._process_message_sync_core(
                    session=session,
                    user=user,
                    messages=[kwargs["message"]],
                    model_id=kwargs["model_id"],
                    thread_id=thread_id,
                    blocks=kwargs["blocks"],
                    attachments=kwargs["attachments"],
                    client_type=kwargs["client_type"],
                    execution_profile=kwargs["execution_profile"],
                    app_context=kwargs["app_context"],
                    agent_mode=kwargs["agent_mode"],
                    client_message_id=kwargs["client_message_id"],
                )
            finally:
                connections.close_all()

        def _route_ok(**kwargs):
            return {
                "message_id": str(kwargs["ingest"].user_message_ids_list[0]),
                "reply": "",
                "model_id": None,
                "model_name": None,
                "trace_id": None,
            }

        def _record_publish(published_thread_id, event_type, payload):
            call_order.append(f"agent.stream.{event_type}")
            self.assertEqual(published_thread_id, thread_id)
            self.assertEqual(event_type, AgentStreamEvent.USER)
            self.assertEqual(payload["client_event_id"], str(client_event_id))
            self.assertEqual(payload["content"], user_text)
            self.assertEqual(payload["content_blocks_json"], [{"type": "text", "text": user_text}])

        with patch(
            "apps.services.common.ws.handlers.chat_send_message._resolve_session",
            new=AsyncMock(return_value=self.session),
        ), patch(
            "apps.services.common.ws.handlers.chat_send_message._invoke_chat_service_sync",
            side_effect=_invoke_through_ingest,
        ), patch.object(
            ChatService, "_stage_prepare", return_value=prep,
        ), patch.object(
            ChatService, "_stage_contextualize", return_value={},
        ), patch.object(
            ChatService, "_stage_route", side_effect=_route_ok,
        ), patch.object(
            ChatStreamPublisher, "publish_ws", side_effect=_record_publish,
        ) as publish_ws:
            asyncio.run(handler(envelope))

        persisted = ChatMessage.objects.get(session=self.session, client_event_id=client_event_id)
        self.assertEqual(persisted.role, "user")
        self.assertEqual(persisted.content_blocks_json, [{"type": "text", "text": user_text}])
        self.assertEqual(publish_ws.call_count, 1)
        self.assertEqual(call_order, [f"agent.stream.{AgentStreamEvent.USER}", CHAT_SEND_MESSAGE_OK])

    def test_two_clients_realtime_stream_then_history_catch_up_after_disconnect(self):
        """Protocol E2E probe: sender, observer, live stream, disconnect, history catch-up."""
        thread_id = f"chat-session-{self.session.id}"
        topic = stream_topic(thread_id)
        first_page = self._get_messages()
        watermark = first_page["server_timestamp"]
        client_event_id = uuid.uuid4()
        user_text = "mobile client sends while electron observes"
        assistant_text = "final answer persisted after observer dropped"
        observer_online = {"value": True}
        observed_events: list[dict] = []
        sender_acks: list[str] = []

        def _deliver_to_observer(published_topic, envelope):
            self.assertEqual(published_topic, topic)
            if observer_online["value"]:
                observed_events.append(envelope)
            return True

        def _deliver_reliable_to_observer(published_topic, envelope):
            _deliver_to_observer(published_topic, envelope)

        consumer = MagicMock()
        consumer.role = "mobile"
        consumer.user = self.user
        consumer.user_id = str(self.user.id)

        async def _record_ack(envelope):
            sender_acks.append(envelope["type"])

        consumer._send_envelope = AsyncMock(side_effect=_record_ack)
        consumer._send_error = AsyncMock()

        handler = create_chat_send_message_handler(consumer)
        envelope = {
            "v": 1,
            "type": "chat.send_message",
            "request_id": "req-ws-e2e",
            "ts": 1,
            "device_id": "ios-test-device",
            "role": "mobile",
            "payload": {
                "session_id": str(self.session.id),
                "message": user_text,
                "client_event_id": str(client_event_id),
                "execution_profile": "task",
            },
        }

        prep = ChatService._PrepareResult(
            model_instance=None,
            model_fell_back=False,
            final_model_id=None,
            user_selected_model=False,
            resolved_agent_name="tin",
            effective_thread_id=thread_id,
            config={"configurable": {"thread_id": thread_id}},
            ws_id="test-organization",
            uid=str(self.user.id),
        )

        def _invoke_through_ingest(**kwargs):
            try:
                session = ChatSession.objects.get(id=self.session.id)
                user = User.objects.get(id=self.user.id)
                return ChatService._process_message_sync_core(
                    session=session,
                    user=user,
                    messages=[kwargs["message"]],
                    model_id=kwargs["model_id"],
                    thread_id=thread_id,
                    blocks=kwargs["blocks"],
                    attachments=kwargs["attachments"],
                    client_type=kwargs["client_type"],
                    execution_profile=kwargs["execution_profile"],
                    app_context=kwargs["app_context"],
                    agent_mode=kwargs["agent_mode"],
                    client_message_id=kwargs["client_message_id"],
                )
            finally:
                connections.close_all()

        def _route_with_live_ai_then_disconnect(**kwargs):
            assistant_message_id = str(uuid.uuid4())
            ChatStreamPublisher.publish_ws(
                thread_id,
                AgentStreamEvent.MESSAGE_START,
                {
                    "message_id": assistant_message_id,
                    "message_kind": "assistant_message",
                    "role": "assistant",
                },
            )
            ChatStreamPublisher.publish_ws(
                thread_id,
                AgentStreamEvent.CONTENT_BLOCK_DELTA,
                {
                    "message_id": assistant_message_id,
                    "index": 0,
                    "delta": {"type": "text_delta", "text": "partial answer"},
                },
            )

            # The observer has seen the user bubble and AI begin streaming, then
            # loses the socket before terminal events / final DB state land.
            observer_online["value"] = False
            ChatMessage.objects.create(
                session=self.session,
                role="assistant",
                text_summary=assistant_text,
                content_blocks_json=[{"type": "text", "text": assistant_text}],
            )
            ChatStreamPublisher.publish_ws(
                thread_id,
                AgentStreamEvent.MESSAGE_STOP,
                {"message_id": assistant_message_id, "stop_reason": "end"},
            )
            ChatStreamPublisher.publish_ws(
                thread_id,
                AgentStreamEvent.DONE,
                {"message_id": assistant_message_id, "stop_reason": "end"},
            )
            return {
                "message_id": str(kwargs["ingest"].user_message_ids_list[0]),
                "reply": "",
                "model_id": None,
                "model_name": None,
                "trace_id": None,
            }

        with patch(
            "apps.services.common.ws.handlers.chat_send_message._resolve_session",
            new=AsyncMock(return_value=self.session),
        ), patch(
            "apps.services.common.ws.handlers.chat_send_message._invoke_chat_service_sync",
            side_effect=_invoke_through_ingest,
        ), patch.object(
            ChatService, "_stage_prepare", return_value=prep,
        ), patch.object(
            ChatService, "_stage_contextualize", return_value={},
        ), patch.object(
            ChatService, "_stage_route", side_effect=_route_with_live_ai_then_disconnect,
        ), patch(
            "apps.services.common.chat_stream_publisher.publish_ws_event",
            side_effect=_deliver_to_observer,
        ), patch(
            "apps.services.common.chat_stream_publisher.publish_ws_event_reliable",
            side_effect=_deliver_reliable_to_observer,
        ):
            asyncio.run(handler(envelope))

        observed_types = [event["type"] for event in observed_events]
        self.assertIn(f"agent.stream.{AgentStreamEvent.USER}", observed_types)
        self.assertIn(f"agent.stream.{AgentStreamEvent.MESSAGE_START}", observed_types)
        self.assertIn(f"agent.stream.{AgentStreamEvent.CONTENT_BLOCK_DELTA}", observed_types)
        self.assertNotIn(f"agent.stream.{AgentStreamEvent.MESSAGE_STOP}", observed_types)
        self.assertNotIn(f"agent.stream.{AgentStreamEvent.DONE}", observed_types)
        self.assertEqual(sender_acks, [CHAT_SEND_MESSAGE_OK])

        delta = self._get_messages(updated_after=watermark)
        roles = [msg["role"] for msg in delta["messages"]]
        self.assertEqual(roles, ["user", "assistant"])
        self.assertEqual(delta["messages"][0]["client_event_id"], str(client_event_id))
        self.assertEqual(delta["messages"][0]["content"], user_text)
        self.assertEqual(delta["messages"][1]["content_blocks_json"], [{"type": "text", "text": assistant_text}])

    def test_joining_session_mid_turn_uses_history_snapshot_then_delta_for_final_answer(self):
        """A second device opens the same session after a turn started but before it settles."""
        thread_id = f"chat-session-{self.session.id}"
        user_text = "question sent before observer opened the session"
        assistant_text = "complete answer after observer joined"
        client_event_id = uuid.uuid4()

        ChatMessage.objects.create(
            session=self.session,
            role="user",
            client_event_id=client_event_id,
            text_summary=user_text,
            content_blocks_json=[{"type": "text", "text": user_text}],
        )
        ChatStreamPublisher.publish_ws(
            thread_id,
            AgentStreamEvent.MESSAGE_START,
            {
                "message_id": str(uuid.uuid4()),
                "message_kind": "assistant_message",
                "role": "assistant",
            },
        )

        # The late-opening device cannot reconstruct missed early stream frames,
        # so its first source of truth must be the latest persisted snapshot.
        mid_join_page = self._get_messages(before="00000000-0000-0000-0000-000000000000")
        mid_join_watermark = mid_join_page["server_timestamp"]
        self.assertEqual([m["role"] for m in mid_join_page["messages"]], ["user"])
        self.assertEqual(mid_join_page["messages"][0]["client_event_id"], str(client_event_id))

        ChatMessage.objects.create(
            session=self.session,
            role="assistant",
            text_summary=assistant_text,
            content_blocks_json=[{"type": "text", "text": assistant_text}],
        )

        delta = self._get_messages(updated_after=mid_join_watermark)
        self.assertEqual([m["role"] for m in delta["messages"]], ["assistant"])
        self.assertEqual(delta["messages"][0]["content"], assistant_text)
        self.assertEqual(delta["messages"][0]["content_blocks_json"], [{"type": "text", "text": assistant_text}])

    def test_repeated_history_delta_after_weak_network_is_stable_and_mergeable(self):
        """Weak clients may retry the same delta request; response identity must stay stable."""
        first_page = self._get_messages()
        watermark = first_page["server_timestamp"]
        user_text = "weak network duplicate delta guard"
        assistant_text = "same final answer should be mergeable"
        client_event_id = uuid.uuid4()
        user = ChatMessage.objects.create(
            session=self.session,
            role="user",
            client_event_id=client_event_id,
            text_summary=user_text,
            content_blocks_json=[{"type": "text", "text": user_text}],
        )
        assistant = ChatMessage.objects.create(
            session=self.session,
            role="assistant",
            text_summary=assistant_text,
            content_blocks_json=[{"type": "text", "text": assistant_text}],
        )

        first_delta = self._get_messages(updated_after=watermark)
        second_delta = self._get_messages(updated_after=watermark)

        expected_ids = [str(user.id), str(assistant.id)]
        self.assertEqual([m["id"] for m in first_delta["messages"]], expected_ids)
        self.assertEqual([m["id"] for m in second_delta["messages"]], expected_ids)
        self.assertEqual(second_delta["messages"][0]["client_event_id"], str(client_event_id))

    def test_runtime_route_failure_after_ingest_keeps_user_fact_recoverable(self):
        """If the execution device path fails after ingest, user message is still a durable fact."""
        thread_id = f"chat-session-{self.session.id}"
        first_page = self._get_messages()
        watermark = first_page["server_timestamp"]
        client_event_id = uuid.uuid4()
        user_text = "runtime offline after user ingest"
        call_order: list[str] = []

        consumer = MagicMock()
        consumer.role = "mobile"
        consumer.user = self.user
        consumer.user_id = str(self.user.id)

        async def _record_envelope(envelope):
            call_order.append(envelope["type"])

        consumer._send_envelope = AsyncMock(side_effect=_record_envelope)
        consumer._send_error = AsyncMock()
        handler = create_chat_send_message_handler(consumer)
        envelope = {
            "v": 1,
            "type": "chat.send_message",
            "request_id": "req-runtime-offline",
            "ts": 1,
            "device_id": "ios-test-device",
            "role": "mobile",
            "payload": {
                "session_id": str(self.session.id),
                "message": user_text,
                "client_event_id": str(client_event_id),
                "execution_profile": "task",
            },
        }
        prep = ChatService._PrepareResult(
            model_instance=None,
            model_fell_back=False,
            final_model_id=None,
            user_selected_model=False,
            resolved_agent_name="tin",
            effective_thread_id=thread_id,
            config={"configurable": {"thread_id": thread_id}},
            ws_id="test-organization",
            uid=str(self.user.id),
        )

        def _invoke_through_ingest(**kwargs):
            try:
                session = ChatSession.objects.get(id=self.session.id)
                user = User.objects.get(id=self.user.id)
                return ChatService._process_message_sync_core(
                    session=session,
                    user=user,
                    messages=[kwargs["message"]],
                    model_id=kwargs["model_id"],
                    thread_id=thread_id,
                    blocks=kwargs["blocks"],
                    attachments=kwargs["attachments"],
                    client_type=kwargs["client_type"],
                    execution_profile=kwargs["execution_profile"],
                    app_context=kwargs["app_context"],
                    agent_mode=kwargs["agent_mode"],
                    client_message_id=kwargs["client_message_id"],
                )
            finally:
                connections.close_all()

        def _route_device_offline(**_kwargs):
            return {
                "message_id": None,
                "reply": "No runtime device online for this session",
                "error_category": "device_offline",
            }

        def _record_publish(published_thread_id, event_type, payload):
            call_order.append(f"agent.stream.{event_type}")
            self.assertEqual(published_thread_id, thread_id)
            self.assertEqual(event_type, AgentStreamEvent.USER)
            self.assertEqual(payload["client_event_id"], str(client_event_id))
            self.assertEqual(payload["content"], user_text)

        with patch(
            "apps.services.common.ws.handlers.chat_send_message._resolve_session",
            new=AsyncMock(return_value=self.session),
        ), patch(
            "apps.services.common.ws.handlers.chat_send_message._invoke_chat_service_sync",
            side_effect=_invoke_through_ingest,
        ), patch.object(
            ChatService, "_stage_prepare", return_value=prep,
        ), patch.object(
            ChatService, "_stage_contextualize", return_value={},
        ), patch.object(
            ChatService, "_stage_route", side_effect=_route_device_offline,
        ), patch.object(
            ChatStreamPublisher, "publish_ws", side_effect=_record_publish,
        ):
            asyncio.run(handler(envelope))

        self.assertEqual(call_order, [f"agent.stream.{AgentStreamEvent.USER}", "chat.send_message.nak"])
        persisted = ChatMessage.objects.get(session=self.session, client_event_id=client_event_id)
        self.assertEqual(persisted.role, "user")
        delta = self._get_messages(updated_after=watermark)
        self.assertEqual([m["id"] for m in delta["messages"]], [str(persisted.id)])
        self.assertEqual(delta["messages"][0]["content"], user_text)
