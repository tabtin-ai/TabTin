from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase

from apps.channel_gateway.services.inbound_service import ChannelInboundService


class ChannelInboundServiceTests(SimpleTestCase):
    def setUp(self):
        self.service = ChannelInboundService()

    def test_handle_inbound_reconciles_existing_binding_before_dispatch(self):
        data_dict = {
            "schema_version": 1,
            "type": "channel.inbound",
            "channel": "telegram",
            "account_id": "default",
            "organization_id": "ws_1",
            "peer_kind": "dm",
            "peer_id": "peer_1",
            "sender_id": "user_1",
            "message_id": "msg_1",
            "text": "hello",
            "timestamp": 0,
        }
        data = SimpleNamespace(
            organization_id="ws_1",
            message_id="msg_1",
            text="hello",
            channel="telegram",
            account_id="default",
            peer_id="peer_1",
            peer_kind="dm",
            schema_version=1,
            sender_id="user_1",
            space_id=None,
            metadata={},
            media=None,
            model_dump=lambda: data_dict,
        )
        existing_binding = SimpleNamespace(id="binding_old", status="active")
        resolved_binding = SimpleNamespace(
            id="binding_new", status="active",
            space_id=None, execution_agent_id=None, session_id="s1", thread_id="t1",
        )
        allowed = SimpleNamespace(allowed=True, pairing_required=False, reason=None)

        with patch.object(self.service, "_register_inbound", return_value=True), \
             patch.object(self.service, "_handle_bot_command", return_value=False), \
             patch.object(self.service, "_get_account", return_value=None), \
             patch.object(self.service, "_get_binding", return_value=existing_binding), \
             patch.object(self.service, "_resolve_binding", return_value=resolved_binding) as resolve_binding, \
             patch.object(self.service, "_sync_routing_context"), \
             patch.object(self.service, "_render_message_text", return_value="hello"), \
             patch.object(self.service, "_send_typing_indicator"), \
             patch.object(self.service, "_emit_extension_event"), \
             patch("apps.channel_gateway.services.inbound_service.ChannelPolicyService.evaluate", return_value=allowed), \
             patch("apps.channel_gateway.tasks.dispatch_agent_reply.delay") as mock_dispatch:
            self.service.handle_inbound(data)

        resolve_binding.assert_called_once_with(data, account=None)
        mock_dispatch.assert_called_once()
        call_kwargs = mock_dispatch.call_args.kwargs
        self.assertEqual(call_kwargs["binding_id"], "binding_new")
        self.assertEqual(call_kwargs["message_text"], "hello")
