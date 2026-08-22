"""
#6688：relay / topic 广播跳过发送方连接。

验证：
  1. publish_ws_event 把 exclude_channel 放在 channel-layer event（非 envelope）
  2. broadcast_message 对本连接 channel_name 匹配时不投递
  3. 其它连接仍投递
  4. relay deferred publish 透传 consumer.channel_name
"""
from __future__ import annotations

import asyncio
import os
import sys
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402

if not getattr(django.apps, "apps_ready", False):
    django.setup()

from django.test import SimpleTestCase  # noqa: E402

from apps.services.common.ws.bus import (  # noqa: E402
    _broadcast_layer_payload,
    publish_ws_event,
)
from apps.services.common.ws.gateway import GatewayConsumer  # noqa: E402
from apps.services.common.ws.handlers import relay_handler  # noqa: E402


class BroadcastExcludeChannelTests(SimpleTestCase):
    def test_broadcast_layer_payload_keeps_exclude_off_envelope(self):
        envelope = {"type": "agent.stream.delta", "payload": {"x": 1}}
        layer = _broadcast_layer_payload(envelope, exclude_channel="ch.sender")
        self.assertEqual(layer["type"], "broadcast_message")
        self.assertIs(layer["message"], envelope)
        self.assertEqual(layer["exclude_channel"], "ch.sender")
        self.assertNotIn("exclude_channel", envelope)

    def test_publish_ws_event_passes_exclude_channel(self):
        envelope = {"type": "agent.stream.delta", "payload": {}}
        with (
            patch("apps.services.common.ws.bus._append_to_buffer", return_value=None),
            patch("apps.services.common.ws.bus._group_send_with_retry") as mock_send,
        ):
            mock_send.return_value = True
            ok = publish_ws_event("chat-session-s1", envelope, exclude_channel="ch.abc")

        self.assertTrue(ok)
        mock_send.assert_called_once()
        layer_event = mock_send.call_args.args[1]
        self.assertEqual(layer_event["exclude_channel"], "ch.abc")
        self.assertEqual(layer_event["message"]["type"], "agent.stream.delta")
        self.assertNotIn("exclude_channel", layer_event["message"])

    def test_publish_ws_event_omits_exclude_when_absent(self):
        envelope = {"type": "agent.stream.delta", "payload": {}}
        with (
            patch("apps.services.common.ws.bus._append_to_buffer", return_value=None),
            patch("apps.services.common.ws.bus._group_send_with_retry") as mock_send,
        ):
            mock_send.return_value = True
            publish_ws_event("chat-session-s1", envelope)

        layer_event = mock_send.call_args.args[1]
        self.assertNotIn("exclude_channel", layer_event)

    def test_broadcast_message_skips_excluded_sender(self):
        consumer = MagicMock(spec=GatewayConsumer)
        consumer.channel_name = "specific.channel.sender"
        consumer.connection_scope = "session"
        consumer._send_envelope = AsyncMock()

        async def _run() -> None:
            await GatewayConsumer.broadcast_message(
                consumer,
                {
                    "type": "broadcast_message",
                    "message": {"type": "agent.stream.delta", "payload": {"t": "self"}},
                    "exclude_channel": "specific.channel.sender",
                },
            )
            consumer._send_envelope.assert_not_called()

            await GatewayConsumer.broadcast_message(
                consumer,
                {
                    "type": "broadcast_message",
                    "message": {"type": "agent.stream.delta", "payload": {"t": "peer"}},
                    "exclude_channel": "other.channel",
                },
            )
            consumer._send_envelope.assert_awaited_once()
            sent = consumer._send_envelope.await_args.args[0]
            self.assertEqual(sent["payload"]["t"], "peer")

        asyncio.run(_run())

    def test_spawn_deferred_publishes_forwards_exclude_channel(self):
        mock_publish = AsyncMock()

        async def _run() -> None:
            with patch.object(relay_handler, "_async_publish_ws", mock_publish):
                relay_handler._spawn_deferred_publishes(
                    "chat-session-s1",
                    [("delta", {"text": "hi"})],
                    exclude_channel="ch.sender",
                )
                pending = [
                    t for t in relay_handler._DEFERRED_PUBLISH_TASKS if not t.done()
                ]
                if pending:
                    await asyncio.gather(*pending)

        asyncio.run(_run())
        mock_publish.assert_awaited_once_with(
            "chat-session-s1",
            "delta",
            {"text": "hi"},
            exclude_channel="ch.sender",
        )


if __name__ == "__main__":
    unittest.main()
