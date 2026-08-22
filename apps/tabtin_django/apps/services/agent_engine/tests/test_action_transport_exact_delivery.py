from unittest.mock import patch

from django.test import SimpleTestCase

from apps.services.agent_engine.services.action_transport_service import (
    ActionTransportService,
)


class ActionTransportExactDeliveryTests(SimpleTestCase):
    @patch(
        "apps.services.agent_engine.services.action_transport_service."
        "publish_device_ws_event_exact",
        return_value=True,
    )
    @patch(
        "apps.services.common.ws.bus.is_device_pre_subscribed",
        return_value=False,
    )
    def test_device_actions_use_the_single_ready_gateway_channel(
        self,
        _pre_subscribed,
        publish_exact,
    ):
        envelope = {"type": "agent.action.device.execute", "payload": {}}

        published = ActionTransportService().publish_device_action(
            "electron-installation-1",
            envelope,
        )

        self.assertEqual(published, 1)
        publish_exact.assert_called_once_with(
            "electron-installation-1",
            envelope,
        )
