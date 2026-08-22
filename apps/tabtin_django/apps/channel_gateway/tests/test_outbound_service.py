from __future__ import annotations

from unittest.mock import patch

from django.test import TestCase
from django.utils import timezone

from apps.channel_gateway.models import ChannelOutboundMessageRecord
from apps.channel_gateway.schemas import (
    ChannelOutboundAckMessage,
    ChannelOutboundMessage,
    ChannelOutboundPayload,
)
from apps.channel_gateway.services.outbound_service import ChannelOutboundService


class ChannelOutboundServiceTests(TestCase):
    @patch("apps.channel_gateway.services.outbound_service.publish_ws_event", return_value=True)
    def test_publish_creates_pending_record_with_outbox_identity(self, _publish):
        message = ChannelOutboundMessage(
            schema_version=1,
            type="channel.outbound",
            channel="telegram",
            account_id="default",
            organization_id="ws_123",
            to="peer_1",
            payload=ChannelOutboundPayload(text="hello"),
        )

        record = ChannelOutboundService().publish(message)
        record.refresh_from_db()

        self.assertEqual(record.status, "pending")
        self.assertEqual(record.attempts, 0)
        self.assertEqual(record.payload.get("outbox_id"), str(record.id))
        self.assertEqual(record.payload.get("message_id"), str(record.id))

    def test_ack_delivered_marks_record_sent(self):
        record = ChannelOutboundMessageRecord.objects.create(
            channel="telegram",
            account_id="default",
            organization_id="ws_123",
            peer_id="peer_1",
            payload={"message_id": "msg_1", "outbox_id": "ob_1"},
            status="dispatched",
            attempts=1,
            next_retry_at=timezone.now(),
        )

        ack = ChannelOutboundAckMessage(
            schema_version=1,
            type="channel.outbound.ack",
            channel="telegram",
            account_id="default",
            organization_id="ws_123",
            outbox_id=str(record.id),
            status="delivered",
        )

        result = ChannelOutboundService().ack(ack)
        self.assertIsNotNone(result)
        record.refresh_from_db()
        self.assertEqual(record.status, "sent")
        self.assertIsNotNone(record.sent_at)
        self.assertIsNone(record.next_retry_at)

    def test_ack_failed_returns_to_pending_when_retryable(self):
        record = ChannelOutboundMessageRecord.objects.create(
            channel="telegram",
            account_id="default",
            organization_id="ws_123",
            peer_id="peer_1",
            payload={"message_id": "msg_1", "outbox_id": "ob_1"},
            status="dispatched",
            attempts=1,
            next_retry_at=timezone.now(),
        )

        ack = ChannelOutboundAckMessage(
            schema_version=1,
            type="channel.outbound.ack",
            channel="telegram",
            account_id="default",
            organization_id="ws_123",
            outbox_id=str(record.id),
            status="failed",
            error="adapter send failed",
        )

        result = ChannelOutboundService().ack(ack)
        self.assertIsNotNone(result)
        record.refresh_from_db()
        self.assertEqual(record.status, "pending")
        self.assertEqual(record.last_error, "adapter send failed")
        self.assertIsNotNone(record.next_retry_at)
        self.assertIsNone(record.sent_at)

    # ------------------------------------------------------------------
    # mark_delivered / mark_send_failed (Celery path)
    # ------------------------------------------------------------------

    def test_mark_delivered_increments_attempts_and_sets_sent(self):
        record = ChannelOutboundMessageRecord.objects.create(
            channel="telegram",
            account_id="default",
            organization_id="ws_123",
            peer_id="peer_1",
            payload={"text": "hi"},
            status="dispatched",
            attempts=0,
        )
        ChannelOutboundService().mark_delivered(record, provider_message_id="ext_42")
        record.refresh_from_db()
        self.assertEqual(record.status, "sent")
        self.assertEqual(record.attempts, 1)
        self.assertIsNotNone(record.sent_at)
        self.assertIsNone(record.last_error)
        self.assertIsNone(record.next_retry_at)
        self.assertEqual(record.payload.get("provider_message_id"), "ext_42")

    def test_mark_send_failed_increments_attempts_and_retries(self):
        record = ChannelOutboundMessageRecord.objects.create(
            channel="telegram",
            account_id="default",
            organization_id="ws_123",
            peer_id="peer_1",
            payload={"text": "hi"},
            status="dispatched",
            attempts=0,
        )
        svc = ChannelOutboundService()
        svc.mark_send_failed(record, "timeout")
        record.refresh_from_db()
        self.assertEqual(record.status, "pending")
        self.assertEqual(record.attempts, 1)
        self.assertEqual(record.last_error, "timeout")
        self.assertIsNotNone(record.next_retry_at)

    def test_mark_send_failed_marks_final_failure_at_max_attempts(self):
        svc = ChannelOutboundService()
        record = ChannelOutboundMessageRecord.objects.create(
            channel="telegram",
            account_id="default",
            organization_id="ws_123",
            peer_id="peer_1",
            payload={"text": "hi"},
            status="dispatched",
            attempts=svc.max_attempts - 1,
        )
        svc.mark_send_failed(record, "permanent error")
        record.refresh_from_db()
        self.assertEqual(record.status, "failed")
        self.assertEqual(record.attempts, svc.max_attempts)
        self.assertIsNone(record.next_retry_at)
