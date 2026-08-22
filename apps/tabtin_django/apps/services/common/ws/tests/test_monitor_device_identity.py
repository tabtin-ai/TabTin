from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from apps.services.common.agent_protocol.namespace import ACTION_CAPABILITY
from apps.services.common.ws.handlers.monitor import create_monitor_event_handler


class MonitorDeviceIdentityTests(SimpleTestCase):
    async def test_unverified_execution_device_cannot_update_monitor(self):
        consumer = MagicMock(
            role="electron",
            capabilities={ACTION_CAPABILITY},
            device_identity_verified=False,
        )
        service = MagicMock()

        with patch(
            "apps.services.common.ws.handlers.monitor._get_monitor_service",
            return_value=service,
        ):
            await create_monitor_event_handler(consumer)({
                "type": "agent.monitor.heartbeat",
                "payload": {"monitor_id": "monitor-1"},
            })

        service.update_heartbeat.assert_not_called()
