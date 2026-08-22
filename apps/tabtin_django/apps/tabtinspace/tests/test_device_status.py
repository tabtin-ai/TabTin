from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import Mock, patch

from django.test import SimpleTestCase

from apps.services.common.ws.device_broadcast import _broadcast_device_status
from apps.tabtinspace.services.device_service import DeviceService, HeartbeatCache


class DeviceStatusBroadcastTests(SimpleTestCase):
    def test_broadcast_targets_owner_user_group_and_includes_owner_metadata(self):
        device = SimpleNamespace(
            id="device-1",
            user_id="user-1",
            fingerprint="fp-1",
            name="Owner Mac",
            device_type="daemon",
            role="control",
            capabilities=["terminal_execute"],
            organization_id="ws-1",
        )
        channel_layer = SimpleNamespace(group_send=Mock())

        with patch("channels.layers.get_channel_layer", return_value=channel_layer), patch(
            "asgiref.sync.async_to_sync",
            side_effect=lambda fn: fn,
        ):
            _broadcast_device_status(device, "busy")

        channel_layer.group_send.assert_called_once()
        group_name, event = channel_layer.group_send.call_args.args
        self.assertEqual(group_name, "user.user-1")

        message = event["message"]
        self.assertEqual(message["type"], "device.status")
        self.assertEqual(message["organization_id"], "ws-1")
        self.assertEqual(message["payload"]["device_id"], "device-1")
        self.assertEqual(message["payload"]["user_id"], "user-1")
        self.assertEqual(message["payload"]["role"], "control")
        self.assertEqual(message["payload"]["status"], "busy")


class DeviceStatusChangeFlagsTests(SimpleTestCase):
    def test_same_status_marks_status_changed_false(self):
        device = SimpleNamespace(status="online", last_heartbeat_at=None, save=Mock())

        with patch(
            "apps.tabtinspace.services.device_service.Device.objects.get",
            return_value=device,
        ):
            device = DeviceService().update_device_status(
                "fp-online",
                "online",
                user_id="user-1",
            )

        self.assertIsNotNone(device)
        self.assertFalse(getattr(device, "_status_changed"))
        self.assertEqual(getattr(device, "_previous_status"), "online")
        device.save.assert_called_once()

    def test_status_transition_marks_status_changed_true(self):
        device = SimpleNamespace(status="offline", last_heartbeat_at=None, save=Mock())

        with patch(
            "apps.tabtinspace.services.device_service.Device.objects.get",
            return_value=device,
        ):
            device = DeviceService().update_device_status(
                "fp-offline",
                "online",
                user_id="user-1",
            )

        self.assertIsNotNone(device)
        self.assertTrue(getattr(device, "_status_changed"))
        self.assertEqual(getattr(device, "_previous_status"), "offline")
        self.assertEqual(device.status, "online")
        self.assertIsNotNone(device.last_heartbeat_at)
        device.save.assert_called_once()


class DeviceBusyTransitionTests(SimpleTestCase):
    def test_mark_busy_only_updates_online_devices(self):
        filter_qs = Mock()
        filter_qs.update.return_value = 1
        select_related_qs = Mock()
        select_related_qs.get.return_value = SimpleNamespace(id="device-1", organization_id="ws-1")

        with patch(
            "apps.tabtinspace.services.device_service.Device.objects.filter",
            return_value=filter_qs,
        ) as mock_filter, patch(
            "apps.tabtinspace.services.device_service.Device.objects.select_related",
            return_value=select_related_qs,
        ), patch(
            "apps.services.common.ws.device_broadcast._broadcast_device_status",
        ) as mock_broadcast:
            updated = DeviceService.mark_busy("device-1")

        self.assertTrue(updated)
        mock_filter.assert_called_once_with(id="device-1", status="online")
        mock_broadcast.assert_called_once()

    def test_mark_busy_does_not_broadcast_when_device_already_busy(self):
        filter_qs = Mock()
        filter_qs.update.return_value = 0

        with patch(
            "apps.tabtinspace.services.device_service.Device.objects.filter",
            return_value=filter_qs,
        ), patch(
            "apps.tabtinspace.services.device_service.Device.objects.select_related",
        ) as mock_select_related, patch(
            "apps.services.common.ws.device_broadcast._broadcast_device_status",
        ) as mock_broadcast:
            updated = DeviceService.mark_busy("device-1")

        self.assertFalse(updated)
        mock_select_related.assert_not_called()
        mock_broadcast.assert_not_called()


class DeviceHeartbeatCapabilityFlagTests(SimpleTestCase):
    def test_heartbeat_marks_capabilities_changed_when_capability_updates(self):
        device = SimpleNamespace(
            status="online",
            last_heartbeat_at=None,
            device_type="daemon",
            capabilities=["terminal_execute"],
            organization_id="ws-1",
            os_info={},
            save=Mock(),
        )
        cache = SimpleNamespace(should_write_db=Mock(return_value=True))

        with patch(
            "apps.tabtinspace.services.device_service.HeartbeatCache.get",
            return_value=cache,
        ), patch(
            "apps.tabtinspace.services.device_service.Device.objects.get",
            return_value=device,
        ), patch(
            "apps.services.common.ws.device_broadcast._broadcast_device_status",
        ) as mock_broadcast:
            updated = DeviceService(user=SimpleNamespace(id="user-1")).heartbeat(
                "fp-1",
                capabilities=["terminal_execute", "git"],
            )

        self.assertIs(updated, device)
        self.assertTrue(getattr(device, "_capabilities_changed"))
        mock_broadcast.assert_called_once_with(device, "online")

    def test_heartbeat_marks_capabilities_changed_false_when_capability_unchanged(self):
        device = SimpleNamespace(
            status="busy",
            last_heartbeat_at=None,
            device_type="daemon",
            capabilities=["git", "terminal_execute"],
            organization_id="ws-1",
            os_info={},
            save=Mock(),
        )
        cache = SimpleNamespace(should_write_db=Mock(return_value=True))

        with patch(
            "apps.tabtinspace.services.device_service.HeartbeatCache.get",
            return_value=cache,
        ), patch(
            "apps.tabtinspace.services.device_service.Device.objects.get",
            return_value=device,
        ), patch(
            "apps.services.common.ws.device_broadcast._broadcast_device_status",
        ) as mock_broadcast:
            updated = DeviceService(user=SimpleNamespace(id="user-1")).heartbeat(
                "fp-1",
                capabilities=["terminal_execute", "git"],
            )

        self.assertIs(updated, device)
        self.assertFalse(getattr(device, "_capabilities_changed"))
        mock_broadcast.assert_not_called()

    def test_heartbeat_persists_host_runtime_snapshot_under_runtime_os_info(self):
        device = SimpleNamespace(
            status="online",
            last_heartbeat_at=None,
            device_type="electron",
            capabilities=["browser", "file"],
            organization_id="ws-1",
            os_info={},
            save=Mock(),
        )
        cache = SimpleNamespace(should_write_db=Mock(return_value=True))

        with patch(
            "apps.tabtinspace.services.device_service.HeartbeatCache.get",
            return_value=cache,
        ), patch(
            "apps.tabtinspace.services.device_service.Device.objects.get",
            return_value=device,
        ), patch(
            "apps.services.common.ws.device_broadcast._broadcast_device_status",
        ):
            updated = DeviceService(user=SimpleNamespace(id="user-1")).heartbeat(
                "fp-1",
                capabilities=["browser", "file"],
                system_info={
                    "host_runtime_snapshot": {
                        "source": "daemon",
                        "reported_at": "2026-03-09T00:00:00Z",
                        "runtime_tools": ["execute_in_terminal", "read_file"],
                        "mcp_server": {
                            "running": True,
                            "tools": ["tabtin_table_list"],
                        },
                    },
                },
            )

        self.assertIs(updated, device)
        self.assertEqual(
            device.os_info["runtime"]["host_runtime_snapshot"]["runtime_tools"],
            ["execute_in_terminal", "read_file"],
        )
        self.assertTrue(device.os_info["runtime"]["host_runtime_snapshot"]["mcp_server"]["running"])


class HeartbeatCacheRuntimeSnapshotTests(SimpleTestCase):
    def test_runtime_snapshot_change_bypasses_debounce(self):
        cache = HeartbeatCache()

        first = cache.should_write_db(
            "fp-1",
            "user-1",
            ["file"],
            {
                "host_runtime_snapshot": {
                    "source": "daemon",
                    "reported_at": "2026-03-09T00:00:00Z",
                    "runtime_tools": ["read_file"],
                    "mcp_server": {"running": False, "tools": []},
                },
            },
        )
        second = cache.should_write_db(
            "fp-1",
            "user-1",
            ["file"],
            {
                "host_runtime_snapshot": {
                    "source": "daemon",
                    "reported_at": "2026-03-09T00:00:05Z",
                    "runtime_tools": ["read_file"],
                    "mcp_server": {"running": True, "tools": ["tabtin_table_list"]},
                },
            },
        )

        self.assertTrue(first)
        self.assertTrue(second)
