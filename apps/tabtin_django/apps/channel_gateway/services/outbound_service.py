"""Channel outbound outbox & retry service."""

from __future__ import annotations

import logging
from datetime import timedelta
from decimal import Decimal
from typing import Optional

from django.conf import settings
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from apps.channel_gateway.models import ChannelOutboundMessageRecord
from apps.channel_gateway.schemas import ChannelOutboundAckMessage, ChannelOutboundMessage
from apps.services.common.ws.bus import publish_ws_event
from apps.services.common.ws.protocol import build_envelope, new_event_id

logger = logging.getLogger(__name__)


class ChannelOutboundService:
    def __init__(self):
        self.max_attempts = int(getattr(settings, "CHANNEL_GATEWAY_OUTBOUND_MAX_ATTEMPTS", 5))
        self.retry_base = int(getattr(settings, "CHANNEL_GATEWAY_OUTBOUND_RETRY_BASE_SECONDS", 30))
        self.ack_timeout = int(getattr(settings, "CHANNEL_GATEWAY_OUTBOUND_ACK_TIMEOUT_SECONDS", 45))

    def publish(self, outbound: ChannelOutboundMessage) -> ChannelOutboundMessageRecord:
        if not outbound.organization_id:
            raise ValueError("channel.outbound requires organization_id")
        account_id = (outbound.account_id or "default").strip() or "default"
        payload = outbound.model_dump(exclude_none=True)

        with transaction.atomic():
            record = ChannelOutboundMessageRecord.objects.create(
                channel=outbound.channel,
                account_id=account_id,
                organization_id=outbound.organization_id,
                peer_id=outbound.to,
                payload=payload,
                idempotency_key=outbound.idempotency_key,
                status="pending",
                attempts=0,
            )

            outbound_payload = dict(record.payload or {})
            if not outbound_payload.get("outbox_id"):
                outbound_payload["outbox_id"] = str(record.id)
            if not outbound_payload.get("message_id"):
                outbound_payload["message_id"] = str(record.id)
            if outbound_payload != record.payload:
                record.payload = outbound_payload
                record.updated_at = timezone.now()
                record.save(update_fields=["payload", "updated_at"])
            transaction.on_commit(
                lambda outbox_id=str(record.id): self._enqueue_immediate_delivery(outbox_id)
            )

        self._notify_ws(record)
        return record

    def _enqueue_immediate_delivery(self, outbox_id: str) -> None:
        if not getattr(settings, "CHANNEL_GATEWAY_IMMEDIATE_DELIVERY_ENABLED", False):
            return
        try:
            from apps.channel_gateway.tasks import deliver_one_outbox
            deliver_one_outbox.apply_async(
                args=[outbox_id],
                queue="realtime_delivery",
                expires=120,
            )
        except Exception:
            logger.warning(
                "[ChannelOutbound] immediate delivery enqueue failed outbox=%s; fallback sweep will retry",
                outbox_id,
                exc_info=True,
            )

    def _notify_ws(self, record: ChannelOutboundMessageRecord) -> None:
        """Push a WS notification for real-time UI updates (non-blocking)."""
        try:
            event_id = new_event_id()
            envelope = build_envelope(
                "channel.outbound",
                event_id,
                record.payload,
                event_id=event_id,
                organization_id=record.organization_id,
                session_id=record.payload.get("session_id"),
                thread_id=record.payload.get("thread_id"),
            )
            publish_ws_event("channel.outbound", envelope)
        except Exception:
            pass

    @transaction.atomic
    def _attempt_send(self, record: ChannelOutboundMessageRecord) -> None:
        record = ChannelOutboundMessageRecord.objects.select_for_update().get(id=record.id)
        now = timezone.now()
        record.attempts += 1
        record.updated_at = now
        record.save(update_fields=["attempts", "updated_at"])

        event_id = new_event_id()
        envelope = build_envelope(
            "channel.outbound",
            event_id,
            record.payload,
            event_id=event_id,
            organization_id=record.organization_id,
            session_id=record.payload.get("session_id"),
            thread_id=record.payload.get("thread_id"),
        )
        try:
            published = publish_ws_event("channel.outbound", envelope)
            if not published:
                raise RuntimeError("channel outbound publish returned false")
            record.status = "dispatched"
            record.sent_at = None
            record.last_error = None
            record.next_retry_at = now + timedelta(seconds=self.ack_timeout)
        except Exception as exc:  # pragma: no cover - channel layer failure
            record.sent_at = None
            record.status = "failed" if record.attempts >= self.max_attempts else "pending"
            record.last_error = str(exc)
            record.next_retry_at = self._next_retry_time(record.attempts)
        record.save(update_fields=["status", "sent_at", "last_error", "next_retry_at", "updated_at"])

    def retry_pending(self, *, organization_id: Optional[str] = None, limit: int = 50) -> int:
        """Reset timed-out dispatched records back to pending.

        The actual delivery is handled exclusively by ``deliver_outbox``
        (Celery adapter path).  This method only resets stale records so
        they can be picked up by the next ``deliver_outbox`` cycle.
        """
        now = timezone.now()
        qs = ChannelOutboundMessageRecord.objects.filter(
            status="dispatched",
        ).filter(
            Q(next_retry_at__isnull=True) | Q(next_retry_at__lte=now),
        )
        if organization_id:
            qs = qs.filter(organization_id=organization_id)
        qs = qs.order_by("next_retry_at", "created_at")[:limit]
        retried = 0
        for record in qs:
            if record.attempts >= self.max_attempts:
                record.status = "failed"
                record.last_error = record.last_error or "max attempts exceeded"
                record.next_retry_at = None
                record.updated_at = now
                record.save(update_fields=["status", "last_error", "next_retry_at", "updated_at"])
                continue
            record.status = "pending"
            record.last_error = record.last_error or "delivery ack timeout"
            record.updated_at = now
            record.save(update_fields=["status", "last_error", "updated_at"])
            retried += 1
        return retried

    @transaction.atomic
    def ack(self, ack: ChannelOutboundAckMessage) -> Optional[ChannelOutboundMessageRecord]:
        if not ack.organization_id:
            raise ValueError("channel.outbound.ack requires organization_id")

        account_id = (ack.account_id or "default").strip() or "default"
        qs = ChannelOutboundMessageRecord.objects.select_for_update().filter(
            channel=ack.channel,
            account_id=account_id,
            organization_id=ack.organization_id,
        )

        if ack.outbox_id:
            try:
                qs = qs.filter(id=ack.outbox_id)
            except Exception:
                return None
        elif ack.message_id:
            qs = qs.filter(payload__message_id=ack.message_id)
        else:
            return None

        record = qs.first()
        if not record:
            return None

        # 允许重复的成功 ACK 幂等通过，但忽略“已成功后再失败”的回执。
        if record.status == "sent" and ack.status == "failed":
            return record

        was_sent = record.status == "sent"
        now = timezone.now()
        update_fields = ["status", "sent_at", "last_error", "next_retry_at", "updated_at"]
        record.updated_at = now

        if ack.status == "delivered":
            record.status = "sent"
            record.sent_at = now
            record.last_error = None
            record.next_retry_at = None
        else:
            record.sent_at = None
            record.last_error = ack.error or "channel adapter delivery failed"
            if record.attempts >= self.max_attempts:
                record.status = "failed"
                record.next_retry_at = None
            else:
                record.status = "pending"
                record.next_retry_at = self._next_retry_time(record.attempts)

        payload = dict(record.payload or {})
        if ack.provider_message_id:
            payload["provider_message_id"] = ack.provider_message_id
        if payload != record.payload:
            record.payload = payload
            update_fields.append("payload")

        record.save(update_fields=update_fields)
        if ack.status == "delivered" and not was_sent:
            _record_channel_billing_event(record)
        return record

    def mark_delivered(
        self,
        record: ChannelOutboundMessageRecord,
        *,
        provider_message_id: str | None = None,
    ) -> None:
        """Mark an outbox record as successfully delivered (Celery path).

        Increments ``attempts`` so the count always reflects total send tries.
        """
        from django.db.models import F

        update_kwargs: dict = {
            "status": "sent",
            "sent_at": timezone.now(),
            "last_error": None,
            "next_retry_at": None,
            "attempts": F("attempts") + 1,
        }
        if provider_message_id:
            p = dict(record.payload or {})
            p["provider_message_id"] = provider_message_id
            update_kwargs["payload"] = p

        updated = ChannelOutboundMessageRecord.objects.filter(
            id=record.id,
            status="dispatched",
        ).update(**update_kwargs)
        if updated == 0:
            return

        _record_channel_billing_event(record)

    def mark_send_failed(
        self,
        record: ChannelOutboundMessageRecord,
        error: str,
    ) -> None:
        """Mark an outbox record as delivery-failed with retry/final logic (Celery path).

        Atomically increments ``attempts`` via ``F()`` to avoid race conditions,
        then decides retry vs final failure based on the new count.
        """
        from django.db.models import F

        updated = ChannelOutboundMessageRecord.objects.filter(
            id=record.id,
            status="dispatched",
        ).update(
            attempts=F("attempts") + 1,
        )
        if updated == 0:
            return
        record.refresh_from_db(fields=["attempts"])

        if record.attempts >= self.max_attempts:
            record.status = "failed"
            record.last_error = error
            record.next_retry_at = None
        else:
            record.status = "pending"
            record.last_error = error
            record.next_retry_at = self._next_retry_time(record.attempts)
        record.save(update_fields=[
            "status", "last_error", "next_retry_at", "updated_at",
        ])

    def _next_retry_time(self, attempts: int) -> Optional[timezone.datetime]:
        if attempts >= self.max_attempts:
            return None
        backoff = self.retry_base * (2 ** max(attempts - 1, 0))
        return timezone.now() + timedelta(seconds=backoff)


def _record_channel_billing_event(record: ChannelOutboundMessageRecord) -> None:
    """宪法 §3: 出站消息成功投递后写 channel.message.count 计费事件（异步聚合）。"""
    try:
        from apps.services.billing.services.pricing_service import MeterPricingService
        from apps.services.billing.services.usage_service import BillingUsageService

        organization_id = record.organization_id
        if not organization_id:
            return

        meter_key = "channel.message.count"
        unit_price = MeterPricingService.get_unit_price(
            meter_key,
            organization_id=organization_id,
            default_price=Decimal("0"),
        ) or Decimal("0")
        quantity = Decimal("1")
        amount = unit_price * quantity

        # Channel 出站无直接 user 上下文，从 payload 取 identity_user_id。
        payload = record.payload or {}
        user_id = payload.get("identity_user_id") or ""

        BillingUsageService.record_event(
            organization_id=organization_id,
            user_id=user_id,
            meter_key=meter_key,
            quantity=quantity,
            unit="count",
            unit_price=unit_price,
            amount=amount,
            biz_type="channel_message",
            biz_id=str(record.id),
            idempotency_key=f"channel_message:{record.id}",
            charge_status="pending",
            metadata={
                "channel": record.channel,
                "account_id": record.account_id,
                "peer_id": record.peer_id,
            },
        )
    except Exception:
        logger.warning(
            "[ChannelOutbound] billing event write failed for outbox=%s",
            record.id,
            exc_info=True,
        )
