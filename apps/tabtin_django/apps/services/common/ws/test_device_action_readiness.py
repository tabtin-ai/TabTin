import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from django.test import SimpleTestCase

from apps.services.common.ws.bus import (
    WsPublishError,
    claim_device_action_ready,
    device_action_last_seen_key,
    device_action_ready_key,
    is_device_ws_connected,
    publish_device_ws_event_exact,
    release_device_action_ready,
    renew_device_action_ready,
)
from apps.services.common.ws.gateway import GatewayConsumer
from apps.services.common.ws.handlers.subscription_validators import AgentActionDeviceValidator


class _FakeCache:
    def __init__(self) -> None:
        self._data: dict[str, object] = {}

    def get(self, key: str):
        return self._data.get(key)

    def set(self, key: str, value, timeout=None) -> None:
        self._data[key] = value

    def add(self, key: str, value, timeout=None) -> bool:
        if key in self._data:
            return False
        self._data[key] = value
        return True

    def incr(self, key: str) -> int:
        self._data[key] = int(self._data[key]) + 1
        return int(self._data[key])

    def delete(self, key: str) -> None:
        self._data.pop(key, None)


class DeviceActionReadinessTests(SimpleTestCase):
    def test_exact_device_publish_uses_the_ready_channel_not_a_group(self):
        fake_cache = _FakeCache()

        class _Layer:
            def __init__(self):
                self.sent = []

            async def send(self, channel, message):
                self.sent.append((channel, message))

        layer = _Layer()
        with (
            patch("django.core.cache.cache", fake_cache),
            patch("apps.services.common.ws.bus.get_channel_layer", return_value=layer),
        ):
            connection_generation = claim_device_action_ready("fp-1", "channel-1")
            published = publish_device_ws_event_exact(
                "fp-1", {"type": "agent.prompt.forward", "data": {}}
            )

        self.assertTrue(published)
        self.assertEqual(layer.sent[0][0], "channel-1")
        self.assertEqual(layer.sent[0][1]["type"], "broadcast_message")
        self.assertEqual(
            layer.sent[0][1]["message"]["_topic"],
            "agent.action.device.fp-1",
        )
        self.assertEqual(
            layer.sent[0][1]["device_action_generation"],
            connection_generation,
        )
        self.assertEqual(
            layer.sent[0][1]["device_action_fingerprint"],
            "fp-1",
        )

    def test_reliable_exact_publish_is_buffered_before_channel_send(self):
        fake_cache = _FakeCache()
        calls = []

        class _Buffer:
            def append_event(self, topic, envelope):
                calls.append(("buffer", topic, dict(envelope)))
                return "100-0"

        class _Layer:
            async def send(self, channel, message):
                calls.append(("send", channel, message))

        with (
            patch("django.core.cache.cache", fake_cache),
            patch("apps.services.common.ws.bus.get_channel_layer", return_value=_Layer()),
            patch("apps.services.common.ws.bus._get_event_buffer", return_value=_Buffer()),
        ):
            claim_device_action_ready("fp-reliable", "channel-stale")
            published = publish_device_ws_event_exact(
                "fp-reliable",
                {"type": "agent.prompt.forward", "payload": {}},
                reliable=True,
            )

        self.assertTrue(published)
        self.assertEqual([call[0] for call in calls], ["buffer", "send"])
        self.assertEqual(calls[0][1], "agent.action.device.fp-reliable")
        self.assertEqual(calls[1][2]["message"]["event_id"], "100-0")

    def test_reliable_exact_publish_does_not_claim_success_without_buffer(self):
        fake_cache = _FakeCache()

        class _Layer:
            sent = False

            async def send(self, channel, message):
                self.sent = True

        class _Buffer:
            def append_event(self, topic, envelope):
                return None

        layer = _Layer()
        with (
            patch("django.core.cache.cache", fake_cache),
            patch("apps.services.common.ws.bus.get_channel_layer", return_value=layer),
            patch("apps.services.common.ws.bus._get_event_buffer", return_value=_Buffer()),
        ):
            claim_device_action_ready("fp-no-buffer", "channel-stale")
            with self.assertRaises(WsPublishError):
                publish_device_ws_event_exact(
                    "fp-no-buffer",
                    {"type": "agent.prompt.forward", "payload": {}},
                    reliable=True,
                )

        self.assertFalse(layer.sent)

    def test_stale_channel_publish_is_replayed_to_reconnected_owner(self):
        fake_cache = _FakeCache()
        stored = []
        queued = []

        class _Buffer:
            def append_event(self, topic, envelope):
                stored.append(("100-0", dict(envelope)))
                return "100-0"

            def read_after_many(self, topic_cursors, limit=200):
                topic = topic_cursors[0][0]
                return {topic: list(stored)}, False

        class _StaleLayer:
            async def send(self, channel, message):
                # Redis channel-layer accepts the enqueue even though the
                # worker that owned this channel has disappeared.
                queued.append((channel, message))

        buffer = _Buffer()
        with (
            patch("django.core.cache.cache", fake_cache),
            patch("apps.services.common.ws.bus.get_channel_layer", return_value=_StaleLayer()),
            patch("apps.services.common.ws.bus._get_event_buffer", return_value=buffer),
        ):
            old_generation = claim_device_action_ready(
                "fp-recover",
                "channel-stale",
            )
            self.assertTrue(
                publish_device_ws_event_exact(
                    "fp-recover",
                    {"type": "agent.prompt.forward", "payload": {}},
                    reliable=True,
                )
            )

            old = GatewayConsumer()
            old.channel_name = "channel-stale"
            old.connection_scope = "device"
            old.device_fingerprint = "fp-recover"
            old._device_action_ready_generation = old_generation
            old._send_envelope = AsyncMock()
            old._ack_prompt_forwards = AsyncMock()
            old._record_runtime_event = AsyncMock()

            generation = claim_device_action_ready("fp-recover", "channel-new")
            reconnected = GatewayConsumer()
            reconnected.channel_name = "channel-new"
            reconnected.connection_scope = "device"
            reconnected.device_fingerprint = "fp-recover"
            reconnected._device_action_ready_generation = generation
            reconnected.subscriptions = {"agent.action.device.fp-recover"}
            reconnected._send_envelope = AsyncMock()
            reconnected._ack_prompt_forwards = AsyncMock()

            with patch(
                "apps.services.common.ws.event_buffer.get_event_buffer",
                return_value=buffer,
            ):
                asyncio.run(
                    reconnected._handle_resume(
                        {
                            "request_id": "resume-recovered",
                            "payload": {"last_event_id": "0-0"},
                        }
                    )
                )
            # The old worker wakes after the new owner has replayed the same
            # buffered event. It must not deliver the queued exact frame too.
            asyncio.run(old.broadcast_message(queued[0][1]))

        forwarded = [
            call.args[0]
            for call in reconnected._send_envelope.await_args_list
            if call.args[0].get("type") == "agent.prompt.forward"
        ]
        self.assertEqual(len(forwarded), 1)
        self.assertEqual(forwarded[0]["event_id"], "100-0")
        old._send_envelope.assert_not_awaited()
        reconnected._ack_prompt_forwards.assert_not_awaited()

    def test_live_exact_forward_is_not_acked_after_socket_send(self):
        fake_cache = _FakeCache()
        consumer = GatewayConsumer()
        consumer.channel_name = "channel-live"
        consumer.connection_scope = "device"
        consumer.device_fingerprint = "fp-live"
        consumer._device_action_ready_generation = 1
        consumer._send_envelope = AsyncMock()
        consumer._ack_prompt_forwards = AsyncMock()
        consumer._record_runtime_event = AsyncMock()
        message = {
            "type": "agent.prompt.forward",
            "event_id": "100-0",
            "_topic": "agent.action.device.fp-live",
        }

        with patch("django.core.cache.cache", fake_cache):
            generation = claim_device_action_ready("fp-live", "channel-live")
            consumer._device_action_ready_generation = generation
            asyncio.run(
                consumer.broadcast_message(
                    {
                        "type": "broadcast_message",
                        "message": message,
                        "device_action_fingerprint": "fp-live",
                        "device_action_generation": generation,
                    }
                )
            )

        consumer._send_envelope.assert_awaited_once_with(message)
        consumer._ack_prompt_forwards.assert_not_awaited()

    def test_prompt_admission_ack_deletes_only_for_current_verified_owner(self):
        consumer = GatewayConsumer()
        consumer.role = "daemon"
        consumer.user_id = "user-1"
        consumer.device_identity_verified = True
        consumer.device_fingerprint = "fp-admitted"
        consumer._send_envelope = AsyncMock()
        consumer._send_error = AsyncMock()
        consumer._is_current_device_action_receiver = AsyncMock(return_value=True)
        consumer._ack_admitted_prompt = AsyncMock(return_value="admitted")

        asyncio.run(consumer._handle_prompt_admitted({
            "request_id": "req-admitted",
            "thread_id": "chat-session-11111111-1111-4111-8111-111111111111",
            "payload": {
                "buffered_event_id": "100-0",
                "run_id": "22222222-2222-4222-8222-222222222222",
            },
        }))

        consumer._ack_admitted_prompt.assert_awaited_once_with(
            fingerprint="fp-admitted",
            stream_id="100-0",
            run_id="22222222-2222-4222-8222-222222222222",
            thread_id="chat-session-11111111-1111-4111-8111-111111111111",
        )
        response = consumer._send_envelope.await_args.args[0]
        self.assertEqual(response["type"], "agent.prompt.admitted.ok")
        self.assertEqual(response["payload"]["status"], "admitted")

    def test_prompt_admission_ack_rejects_stale_connection_without_xdel(self):
        consumer = GatewayConsumer()
        consumer.role = "electron"
        consumer.user_id = "user-1"
        consumer.device_identity_verified = True
        consumer.device_fingerprint = "fp-stale"
        consumer._send_envelope = AsyncMock()
        consumer._send_error = AsyncMock()
        consumer._is_current_device_action_receiver = AsyncMock(return_value=False)
        consumer._ack_admitted_prompt = AsyncMock()

        asyncio.run(consumer._handle_prompt_admitted({
            "request_id": "req-stale",
            "thread_id": "chat-session-11111111-1111-4111-8111-111111111111",
            "payload": {
                "buffered_event_id": "100-0",
                "run_id": "22222222-2222-4222-8222-222222222222",
            },
        }))

        consumer._ack_admitted_prompt.assert_not_awaited()
        consumer._send_error.assert_awaited_once()

    def test_prompt_admission_ack_accepts_shared_session_execution_owner(self):
        consumer = GatewayConsumer()
        consumer.user_id = "execution-owner"
        run_id = "22222222-2222-4222-8222-222222222222"
        session_id = "11111111-1111-4111-8111-111111111111"
        thread_id = f"chat-session-{session_id}"
        topic = "agent.action.device.fp-shared"
        buffered = {
            "type": "agent.prompt.forward",
            "thread_id": thread_id,
            "_topic": topic,
            "payload": {"run_id": run_id},
        }
        redis_client = MagicMock()
        redis_client.xrange.return_value = [
            ("100-0", {"e": json.dumps(buffered)}),
        ]
        redis_client.xdel.return_value = 1

        run_query = MagicMock()
        run_query.only.return_value.first.return_value = SimpleNamespace(
            user_id="execution-owner",
            metadata={"target_device_installation_id": "fp-shared"},
        )
        with (
            patch(
                "apps.services.agent_engine.models.ExecutionRun.objects.filter",
                return_value=run_query,
            ),
            patch(
                "apps.chat.conversation.models.ChatSession.objects.filter",
            ) as session_filter,
            patch(
                "django_redis.get_redis_connection",
                return_value=redis_client,
            ),
        ):
            outcome = GatewayConsumer._ack_admitted_prompt.__wrapped__(
                consumer,
                fingerprint="fp-shared",
                stream_id="100-0",
                run_id=run_id,
                thread_id=thread_id,
            )

        self.assertEqual(outcome, "admitted")
        session_filter.assert_not_called()
        redis_client.xdel.assert_called_once_with(
            "ws:evt:agent.action.device.fp-shared",
            "100-0",
        )

    def test_exact_delivery_finishes_on_selected_generation(self):
        fake_cache = _FakeCache()

        def consumer(channel_name: str, generation: int) -> GatewayConsumer:
            instance = GatewayConsumer()
            instance.channel_name = channel_name
            instance.connection_scope = "device"
            instance.device_fingerprint = "fp-race"
            instance._device_action_ready_generation = generation
            instance._send_envelope = AsyncMock()
            instance._record_runtime_event = AsyncMock()
            return instance

        with patch("django.core.cache.cache", fake_cache):
            old_generation = claim_device_action_ready("fp-race", "channel-old")
            old = consumer("channel-old", old_generation)
            new_generation = claim_device_action_ready("fp-race", "channel-new")
            new = consumer("channel-new", new_generation)

            exact_event = {
                "type": "broadcast_message",
                "message": {
                    "type": "agent.prompt.forward",
                    "_topic": "agent.action.device.fp-race",
                },
                "device_action_fingerprint": "fp-race",
                "device_action_generation": old_generation,
            }
            legacy_group_event = {
                "type": "broadcast_message",
                "message": {
                    "type": "agent.prompt.forward",
                    "_topic": "agent.action.device.fp-race",
                },
            }
            asyncio.run(old.broadcast_message(exact_event))
            asyncio.run(old.broadcast_message(legacy_group_event))
            asyncio.run(new.broadcast_message(legacy_group_event))

            old._send_envelope.assert_awaited_once_with(exact_event["message"])
            new._send_envelope.assert_awaited_once()

            old._send_envelope.reset_mock()
            old.subscriptions = {"agent.action.device.fp-race"}
            asyncio.run(old._handle_resume({
                "request_id": "resume-old",
                "payload": {"last_event_id": "1-0"},
            }))

        old._send_envelope.assert_awaited_once()
        resume_ok = old._send_envelope.await_args.args[0]
        self.assertEqual(resume_ok["type"], "resume.ok")
        self.assertEqual(resume_ok["payload"]["replayed"], 0)

    def test_device_not_ready_until_action_topic_subscribed(self):
        fake_cache = _FakeCache()
        fake_cache.set("runtime_channel:fp-1", "channel-1")
        fake_cache.set("daemon_channel:fp-1", "channel-1")

        with patch("django.core.cache.cache", fake_cache):
            self.assertFalse(is_device_ws_connected("fp-1"))
            fake_cache.set(device_action_ready_key("fp-1"), "channel-1")
            self.assertTrue(is_device_ws_connected("fp-1"))

    def test_action_device_subscription_marks_runtime_ready(self):
        fake_cache = _FakeCache()
        _tracked: list = []
        consumer = SimpleNamespace(
            device_fingerprint="fp-2",
            channel_name="channel-2",
            role="daemon",
            _track_task=lambda t: (_tracked.append(t), t.cancel()),
        )

        with patch("django.core.cache.cache", fake_cache):
            asyncio.run(AgentActionDeviceValidator().on_subscribed(
                consumer,
                "agent.action.device.fp-2",
            ))

        self.assertEqual(fake_cache.get(device_action_ready_key("fp-2")), "channel-2")
        self.assertIsInstance(
            fake_cache.get(device_action_last_seen_key("fp-2")),
            float,
        )

    def test_electron_must_own_the_device_topic_it_subscribes(self):
        consumer = SimpleNamespace(
            device_fingerprint="electron-1",
            role="electron",
            user_id="user-1",
            device_identity_verified=True,
        )
        with patch(
            "apps.services.common.ws.handlers.subscription_validators._verify_device_ownership",
            new=AsyncMock(return_value=False),
        ):
            error = asyncio.run(
                AgentActionDeviceValidator().validate(
                    consumer,
                    "agent.action.device.electron-1",
                    ["agent", "action", "device.electron-1"],
                )
            )

        self.assertEqual(error, "device not owned by current user")

    def test_unverified_electron_cannot_claim_a_device_topic(self):
        consumer = SimpleNamespace(
            device_fingerprint="electron-1",
            role="electron",
            user_id="user-1",
            device_identity_verified=False,
        )

        error = asyncio.run(
            AgentActionDeviceValidator().validate(
                consumer,
                "agent.action.device.electron-1",
                ["agent", "action", "device.electron-1"],
            )
        )

        self.assertEqual(error, "device identity is not verified")

    def test_unsubscribe_clears_only_its_own_ready_channel(self):
        fake_cache = _FakeCache()
        key = device_action_ready_key("fp-2")
        consumer = SimpleNamespace(
            device_fingerprint="fp-2",
            channel_name="channel-2",
            _device_action_ready_generation=None,
        )

        with patch("django.core.cache.cache", fake_cache):
            consumer._device_action_ready_generation = claim_device_action_ready(
                "fp-2",
                "channel-2",
            )
            asyncio.run(
                AgentActionDeviceValidator().on_unsubscribed(
                    consumer,
                    "agent.action.device.fp-2",
                )
            )

        self.assertIsNone(fake_cache.get(key))

    def test_old_connection_cannot_renew_or_delete_the_latest_subscription(self):
        fake_cache = _FakeCache()
        with patch("django.core.cache.cache", fake_cache):
            old_generation = claim_device_action_ready("fp-3", "channel-old")
            new_generation = claim_device_action_ready("fp-3", "channel-new")
            self.assertGreater(new_generation, old_generation)
            self.assertIsNone(
                renew_device_action_ready(
                    "fp-3",
                    "channel-old",
                    old_generation,
                )
            )
            self.assertFalse(
                release_device_action_ready(
                    "fp-3",
                    "channel-old",
                    old_generation,
                )
            )

        self.assertEqual(
            fake_cache.get(device_action_ready_key("fp-3")),
            "channel-new",
        )

    def test_surviving_connection_can_restore_expired_route(self):
        fake_cache = _FakeCache()
        with patch("django.core.cache.cache", fake_cache):
            old_generation = claim_device_action_ready("fp-4", "channel-old")
            new_generation = claim_device_action_ready("fp-4", "channel-new")
            fake_cache.delete(device_action_ready_key("fp-4"))
            fake_cache.delete("device_action_ready_generation:fp-4")
            recovered_generation = renew_device_action_ready(
                "fp-4",
                "channel-old",
                old_generation,
            )
            self.assertGreater(recovered_generation, new_generation)
            self.assertIsNone(
                renew_device_action_ready(
                    "fp-4",
                    "channel-new",
                    new_generation,
                )
            )

        self.assertEqual(
            fake_cache.get(device_action_ready_key("fp-4")),
            "channel-old",
        )
