from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase

from apps.services.common.ws.handlers.chat_send_message import (
    _validate_execution_target_sync,
)


class ChatSendExecutionTargetTests(SimpleTestCase):
    def _session(self, *, device_id="device-1", target_device_id=None):
        return SimpleNamespace(
            workspace=SimpleNamespace(device_id=device_id),
            target_device_id=target_device_id,
        )

    def _validate(self, session, target):
        with patch(
            "apps.chat.conversation.models.ChatSession.objects.select_related",
        ) as select_related:
            select_related.return_value.filter.return_value.first.return_value = session
            return _validate_execution_target_sync("session-1", target)

    def test_matching_binding_is_accepted(self):
        self.assertIsNone(self._validate(self._session(), {
            "kind": "bound_device",
            "device_identity_key": "device-1",
        }))

    def test_changed_device_is_rejected_as_stale(self):
        self.assertEqual(self._validate(self._session(device_id="device-2"), {
            "kind": "bound_device",
            "device_identity_key": "device-1",
        }), "binding_stale")

    def test_legacy_frozen_target_is_accepted_after_workspace_rebind(self):
        self.assertIsNone(self._validate(self._session(
            device_id="device-2",
            target_device_id="device-1",
        ), {
            "kind": "bound_device",
            "device_identity_key": "device-1",
        }))

    def test_legacy_frozen_target_rejects_current_workspace_device(self):
        self.assertEqual(self._validate(self._session(
            device_id="device-2",
            target_device_id="device-1",
        ), {
            "kind": "bound_device",
            "device_identity_key": "device-2",
        }), "binding_stale")
