from __future__ import annotations

from unittest.mock import patch

from django.test import SimpleTestCase, override_settings

from apps.channel_gateway.services.outbound_service import ChannelOutboundService


class ChannelGatewayImmediateDeliveryTests(SimpleTestCase):
    @override_settings(CHANNEL_GATEWAY_IMMEDIATE_DELIVERY_ENABLED=False)
    def test_flag_off_does_not_enqueue_immediate_delivery(self):
        with patch("apps.channel_gateway.tasks.deliver_one_outbox.apply_async") as apply_async:
            ChannelOutboundService()._enqueue_immediate_delivery("outbox-1")

        apply_async.assert_not_called()

    @override_settings(CHANNEL_GATEWAY_IMMEDIATE_DELIVERY_ENABLED=True)
    def test_flag_on_enqueues_realtime_delivery(self):
        with patch("apps.channel_gateway.tasks.deliver_one_outbox.apply_async") as apply_async:
            ChannelOutboundService()._enqueue_immediate_delivery("outbox-1")

        apply_async.assert_called_once()
        self.assertEqual(apply_async.call_args.kwargs["queue"], "realtime_delivery")

