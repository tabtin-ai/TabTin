from __future__ import annotations

from asgiref.sync import async_to_sync
from django.test import SimpleTestCase
from unittest.mock import AsyncMock, patch

from apps.services.common.ws import metrics
from apps.services.common.ws.handlers import relay_handler
from apps.services.common.ws.handlers.relay_handler import create_relay_events_handler


class _FakeConsumer:
    organization_ctx = object()
    user_id = "user-secret-raw"
    device_fingerprint = "device-test"
    _ws_client_version = "0.0-test"

    def __init__(self) -> None:
        self.sent: list[dict] = []
        self.errors: list[tuple[str, str, str]] = []

    async def _send_envelope(self, envelope: dict) -> None:
        self.sent.append(envelope)

    async def _send_error(self, request_id: str, code: str, message: str, details: dict | None = None) -> None:
        self.errors.append((request_id, code, message))


class RelayBackpressureObservabilityTests(SimpleTestCase):
    def _envelope(self) -> dict:
        return {
            "v": 1,
            "type": "relay_events",
            "request_id": "request-secret-raw",
            "ts": 1_800_000_000,
            "device_id": "electron-test",
            "role": "electron",
            "_server_received_at": 1_800_000_001.25,
            "_payload_bytes": 2048,
            "_legacy_protocol": True,
            "payload": {
                "session_id": "session-secret-raw",
                "events": [
                    {
                        "type": "agent.stream.step",
                        "payload": {
                            "title": "secret message body must not be logged",
                        },
                    },
                    {
                        "type": "unknown.event",
                        "payload": {"token": "secret-token"},
                    },
                ],
            },
        }

    def test_relay_batch_logs_timing_and_hashes_without_payload_body(self):
        consumer = _FakeConsumer()
        handler = create_relay_events_handler(consumer)

        with patch(
            "apps.services.common.ws.handlers.relay_handler._verify_session_in_organizations",
            new=AsyncMock(return_value=True),
        ), patch(
            "apps.services.common.ws.handlers.relay_handler._async_publish_ws",
            new=AsyncMock(),
        ), patch(
            "apps.services.common.ws.handlers.relay_handler._spawn_background_trace_write",
        ), patch(
            "apps.services.common.ws.handlers.relay_handler.record_relay_batch_received",
        ) as record_received, patch(
            "apps.services.common.ws.handlers.relay_handler.record_relay_batch_processed",
        ) as record_processed, patch(
            "apps.services.common.ws.handlers.relay_handler.time.time",
            side_effect=[
                1_800_000_001.50,
                1_800_000_001.50,
                1_800_000_001.75,
                *([1_800_000_001.75] * 20),
            ],
        ), self.assertLogs(
            "apps.services.common.ws.handlers.relay_handler",
            level="INFO",
        ) as logs:
            async_to_sync(handler)(self._envelope())

        self.assertFalse(consumer.errors)
        self.assertEqual(consumer.sent[-1]["type"], "relay_events.ok")

        record_received.assert_called_once_with(
            protocol_version="1",
            event_count=2,
            payload_bytes=2048,
            network_delay_ms=1250,
        )
        record_processed.assert_called_once()
        processed_kwargs = record_processed.call_args.kwargs
        self.assertEqual(processed_kwargs["server_queue_wait_ms"], 250)
        self.assertEqual(processed_kwargs["processing_duration_ms"], 250)
        self.assertEqual(processed_kwargs["skipped_reasons"], {"invalid_type": 1})

        rendered = "\n".join(logs.output)
        self.assertIn("event=relay_batch_received", rendered)
        self.assertIn("legacy_protocol=True", rendered)
        self.assertIn("payload_bytes=2048", rendered)
        self.assertNotIn("session-secret-raw", rendered)
        self.assertNotIn("request-secret-raw", rendered)
        self.assertNotIn("secret message body must not be logged", rendered)
        self.assertNotIn("secret-token", rendered)

    def test_relay_legacy_error_logs_hash_session_ids(self):
        relay_handler.reset_rejected_trace_write_count()

        with patch.object(relay_handler, "_MAX_BACKGROUND_TASKS", 0), self.assertLogs(
            "apps.services.common.ws.handlers.relay_handler",
            level="WARNING",
        ) as logs:
            spawned = relay_handler._spawn_background_trace_write(
                session_id="session-secret-raw",
                thread_id="chat-session-session-secret-raw",
                events=[],
            )

        self.assertFalse(spawned)
        rendered = "\n".join(logs.output)
        self.assertIn("session_hash=", rendered)
        self.assertNotIn("session-secret-raw", rendered)

    def test_relay_metrics_do_not_use_high_cardinality_identity_labels(self):
        high_cardinality_labels = {"session_id", "request_id", "batch_id", "user_id"}
        collectors = [
            metrics.relay_batches_received_total,
            metrics.relay_events_received_total,
            metrics.relay_sync_failed_total,
            metrics.relay_events_skipped_total,
            metrics.relay_nak_total,
            metrics.relay_ws_timestamp_rejected_total,
        ]

        for collector in collectors:
            self.assertTrue(
                high_cardinality_labels.isdisjoint(set(collector._labelnames)),
                f"{collector._name} has high-cardinality labels: {collector._labelnames}",
            )

    def test_relay_metric_reason_values_are_low_cardinality(self):
        self.assertEqual(
            metrics.normalize_relay_metric_reason("db_write_error for 11111111-1111-4111-8111-111111111111"),
            "db_write_error",
        )
        self.assertEqual(
            metrics.normalize_relay_metric_reason("persist_message_write_error for 22222222-2222-4222-8222-222222222222"),
            "persist_message_write_error",
        )
        self.assertEqual(
            metrics.normalize_relay_metric_reason("state_snapshot_write_error for chat-session-33333333"),
            "state_snapshot_write_error",
        )
        self.assertEqual(
            metrics.normalize_relay_metric_reason("unclassified 44444444-4444-4444-8444-444444444444"),
            "other",
        )
