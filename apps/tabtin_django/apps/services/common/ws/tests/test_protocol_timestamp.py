from __future__ import annotations

from unittest.mock import patch

from django.test import SimpleTestCase

from apps.services.common.ws.protocol import (
    ERROR_SCHEMA_INVALID,
    MAX_TS_DRIFT_SECONDS,
    EnvelopeValidationError,
    validate_envelope,
)


class GatewayEnvelopeTimestampValidationTests(SimpleTestCase):
    def _envelope(self, ts: int) -> dict:
        return {
            "v": 1,
            "type": "relay_events",
            "request_id": "req_ts_drift",
            "ts": ts,
            "device_id": "electron-test",
            "role": "electron",
            "payload": {},
        }

    def test_timestamp_drift_error_includes_client_and_server_clock(self):
        server_ts = 1_800_000_000
        client_ts = server_ts + MAX_TS_DRIFT_SECONDS + 1

        with patch("apps.services.common.ws.protocol.time.time", return_value=server_ts):
            with self.assertRaises(EnvelopeValidationError) as raised:
                validate_envelope(self._envelope(client_ts))

        self.assertEqual(raised.exception.code, ERROR_SCHEMA_INVALID)
        self.assertEqual(raised.exception.message, "ts out of acceptable range")
        self.assertEqual(raised.exception.details, {
            "field": "ts",
            "client_ts": client_ts,
            "client_created_at": client_ts,
            "server_ts": server_ts,
            "server_received_at": server_ts,
            "drift_seconds": client_ts - server_ts,
            "max_drift_seconds": MAX_TS_DRIFT_SECONDS,
        })

    def test_timestamp_drift_preserves_direction_when_client_clock_is_behind(self):
        server_ts = 1_800_000_000
        client_ts = server_ts - MAX_TS_DRIFT_SECONDS - 1

        with patch("apps.services.common.ws.protocol.time.time", return_value=server_ts):
            with self.assertRaises(EnvelopeValidationError) as raised:
                validate_envelope(self._envelope(client_ts))

        self.assertEqual(raised.exception.details["client_ts"], client_ts)
        self.assertEqual(raised.exception.details["server_ts"], server_ts)
        self.assertEqual(raised.exception.details["server_received_at"], server_ts)
        self.assertEqual(raised.exception.details["drift_seconds"], client_ts - server_ts)

    def test_receive_time_prevents_server_queue_wait_from_rejecting_timestamp(self):
        received_at = 1_800_000_000
        client_ts = received_at
        later_processing_time = received_at + MAX_TS_DRIFT_SECONDS + 30

        with patch("apps.services.common.ws.protocol.time.time", return_value=later_processing_time):
            envelope = validate_envelope(self._envelope(client_ts), received_at=received_at)

        self.assertEqual(envelope["ts"], client_ts)

    def test_real_client_clock_skew_is_still_rejected_against_receive_time(self):
        received_at = 1_800_000_000
        client_ts = received_at - MAX_TS_DRIFT_SECONDS - 1

        with self.assertRaises(EnvelopeValidationError) as raised:
            validate_envelope(self._envelope(client_ts), received_at=received_at)

        self.assertEqual(raised.exception.code, ERROR_SCHEMA_INVALID)
        self.assertEqual(raised.exception.details["server_received_at"], received_at)
        self.assertEqual(raised.exception.details["drift_seconds"], client_ts - received_at)

