"""Relay 恢复/回填只补事实，不制造迟到的实时提醒。"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

from django.test import SimpleTestCase

from apps.services.common.ws.handlers.relay_handler import (
    create_relay_events_handler,
    drain_deferred_relay_side_effects_for_tests,
)
from apps.services.common.ws.handlers.relay_message_writer import SyncWriteResult


async def _deliver_done(
    *,
    delivery_mode: str | None,
    arrival_seq: int | None = None,
    server_received_at: float | None = None,
) -> tuple[AsyncMock, AsyncMock, AsyncMock, AsyncMock, MagicMock]:
    consumer = MagicMock()
    consumer.organization_ctx = object()
    consumer.user_id = "user-1"
    consumer.device_fingerprint = "device-1"
    consumer.channel_name = "channel.sender"
    consumer._ws_client_version = "1.1.2-beta.58"
    consumer._send_error = AsyncMock()
    consumer._send_envelope = AsyncMock()

    done_payload = {
        "run_id": "22222222-2222-4222-8222-222222222222",
        "trace_id": "trace-recovered",
        "content": "历史任务完成",
        "error": False,
    }
    if arrival_seq is not None:
        done_payload["arrival_seq"] = arrival_seq
    relay_payload = {
        "session_id": "11111111-1111-4111-8111-111111111111",
        "events": [{
            "type": "agent.stream.done",
            "payload": done_payload,
        }],
    }
    if delivery_mode is not None:
        relay_payload.update({
            "delivery_mode": delivery_mode,
            **({
                "original_created_at_ms": 1_786_200_000_000,
            } if delivery_mode == "recover" else {}),
        })
    envelope = {
        "v": 1,
        "request_id": "req-recovered-done",
        "payload": relay_payload,
    }
    if server_received_at is not None:
        envelope["_server_received_at"] = server_received_at

    sync_write = AsyncMock(return_value=SyncWriteResult(success=True))
    runtime_result = AsyncMock()
    push = AsyncMock()
    notify = AsyncMock()
    with patch(
        "apps.services.common.ws.handlers.relay_handler._verify_session_in_organizations",
        new=AsyncMock(return_value=True),
    ), patch(
        "apps.services.common.ws.handlers.relay_handler.sync_write_critical_events",
        new=sync_write,
    ), patch(
        "apps.services.common.ws.handlers.relay_handler._async_apply_run_state_events",
        new=AsyncMock(return_value=True),
    ), patch(
        "apps.services.common.ws.handlers.relay_handler._async_write_runtime_result_from_relay_done",
        new=runtime_result,
    ), patch(
        "apps.services.common.ws.handlers.relay_handler._async_schedule_agent_done_push",
        new=push,
    ), patch(
        "apps.services.common.ws.handlers.relay_handler._async_notify_agent_task_from_done",
        new=notify,
    ), patch(
        "apps.services.common.ws.handlers.relay_handler._async_publish_ws",
        new=AsyncMock(),
    ), patch(
        "apps.services.common.ws.handlers.relay_handler._spawn_background_trace_write",
        new=MagicMock(return_value=True),
    ):
        await create_relay_events_handler(consumer)(envelope)
        await drain_deferred_relay_side_effects_for_tests()

    return sync_write, runtime_result, push, notify, consumer


class RelayDeliveryFreshnessTests(SimpleTestCase):
    def test_recovered_done_is_persisted_without_realtime_notifications(self) -> None:
        async def verify() -> None:
            sync_write, runtime_result, push, notify, consumer = await _deliver_done(
                delivery_mode="recover",
            )

            sync_write.assert_awaited_once()
            runtime_result.assert_awaited_once()
            push.assert_not_awaited()
            notify.assert_not_awaited()
            ack = consumer._send_envelope.await_args.args[0]
            self.assertEqual(ack["type"], "relay_events.ok")

        asyncio.run(verify())

    def test_legacy_stale_done_is_persisted_without_realtime_notifications(self) -> None:
        """旧客户端无 delivery_mode 时，明显陈旧的 arrival_seq 仍应抑制提醒。"""
        async def verify() -> None:
            server_received_at = 1_786_208_000.0
            old_arrival_seq = int((server_received_at - 3_601) * 1_000_000)
            sync_write, runtime_result, push, notify, consumer = await _deliver_done(
                delivery_mode=None,
                arrival_seq=old_arrival_seq,
                server_received_at=server_received_at,
            )

            sync_write.assert_awaited_once()
            runtime_result.assert_awaited_once()
            push.assert_not_awaited()
            notify.assert_not_awaited()
            ack = consumer._send_envelope.await_args.args[0]
            self.assertEqual(ack["type"], "relay_events.ok")

        asyncio.run(verify())

    def test_backfill_done_is_persisted_without_realtime_notifications(self) -> None:
        async def verify() -> None:
            sync_write, runtime_result, push, notify, _ = await _deliver_done(
                delivery_mode="backfill",
            )

            sync_write.assert_awaited_once()
            runtime_result.assert_awaited_once()
            push.assert_not_awaited()
            notify.assert_not_awaited()

        asyncio.run(verify())

    def test_fresh_live_done_keeps_realtime_notifications(self) -> None:
        async def verify() -> None:
            server_received_at = 1_786_208_000.0
            fresh_arrival_seq = int((server_received_at - 5) * 1_000_000)
            sync_write, runtime_result, push, notify, _ = await _deliver_done(
                delivery_mode=None,
                arrival_seq=fresh_arrival_seq,
                server_received_at=server_received_at,
            )

            sync_write.assert_awaited_once()
            runtime_result.assert_awaited_once()
            push.assert_awaited_once()
            notify.assert_awaited_once()

        asyncio.run(verify())
