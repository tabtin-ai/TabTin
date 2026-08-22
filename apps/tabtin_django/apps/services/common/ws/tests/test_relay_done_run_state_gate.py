"""Relay DONE 与服务端运行终态的 ACK 门禁回归测试。"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

from apps.services.common.ws.handlers.relay_handler import (
    create_relay_events_handler,
    drain_deferred_relay_side_effects_for_tests,
)
from apps.services.common.ws.handlers.relay_message_writer import SyncWriteResult


def test_done_returns_nak_when_terminal_run_state_is_not_confirmed():
    """DONE 已落消息但运行终态未收敛时不得 ACK。"""
    consumer = MagicMock()
    consumer.organization_ctx = object()
    consumer.user_id = "user-1"
    consumer.device_fingerprint = "device-1"
    consumer._send_error = AsyncMock()
    consumer._send_envelope = AsyncMock()
    handler = create_relay_events_handler(consumer)

    envelope = {
        "request_id": "req-done-run-state",
        "payload": {
            "session_id": "11111111-1111-4111-8111-111111111111",
            "events": [{
                "type": "agent.stream.done",
                "payload": {
                    "run_id": "22222222-2222-4222-8222-222222222222",
                    "content": "done",
                    "error": False,
                },
            }],
        },
    }

    async def run_handler() -> None:
        await handler(envelope)
        await drain_deferred_relay_side_effects_for_tests()

    with patch(
        "apps.services.common.ws.handlers.relay_handler._verify_session_in_organizations",
        new=AsyncMock(return_value=True),
    ), patch(
        "apps.services.common.ws.handlers.relay_handler.sync_write_critical_events",
        new=AsyncMock(return_value=SyncWriteResult(success=True)),
    ), patch(
        "apps.services.common.ws.handlers.relay_handler._async_write_runtime_result_from_relay_done",
        new=AsyncMock(),
    ) as runtime_result_mock, patch(
        "apps.services.common.ws.handlers.relay_handler._async_apply_run_state_events",
        new=AsyncMock(return_value=False),
    ), patch(
        "apps.services.common.ws.handlers.relay_handler._async_publish_ws",
        new=AsyncMock(),
    ) as publish_mock:
        asyncio.run(run_handler())

    publish_mock.assert_not_called()
    runtime_result_mock.assert_not_called()
    consumer._send_error.assert_not_called()
    consumer._send_envelope.assert_called_once()
    response = consumer._send_envelope.call_args.args[0]
    assert response["type"] == "relay_events.nak"
    assert response["payload"]["error_code"] == "run_state_terminal_not_confirmed"
