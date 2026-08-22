"""TabChat Centrifugo 持久 Outbox。"""

from __future__ import annotations

import logging
import uuid
from datetime import timedelta
from typing import Any

from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from apps.services.common.db_router import postgres_app_db_alias
from apps.tabchat.models import Conversation, IMEventOutbox, Message

logger = logging.getLogger(__name__)


OUTBOX_EVENT_NAMESPACE = uuid.UUID("0710fd72-8d61-42d8-a3a6-9bba58b4ead5")
OUTBOX_LEASE_SECONDS = 30
OUTBOX_MAX_ATTEMPTS = 8


class IMOutboxService:
    @staticmethod
    def enqueue(
        *,
        organization_id: str,
        event_type: str,
        target_channels: list[str],
        data: dict[str, Any],
        conversation: Conversation | None = None,
        message: Message | None = None,
        domain_event_id: uuid.UUID | None = None,
    ) -> IMEventOutbox:
        channels = sorted({str(channel) for channel in target_channels if channel})
        if not channels:
            raise ValueError("IM Outbox target_channels 不能为空")

        domain_id = domain_event_id or uuid.uuid4()
        event_key = f"{domain_id}:{event_type}:{','.join(channels)}"
        event_id = uuid.uuid5(OUTBOX_EVENT_NAMESPACE, event_key)
        payload = {
            "type": event_type,
            "event_id": str(event_id),
            "domain_event_id": str(domain_id),
            "data": data,
        }
        record = IMEventOutbox.objects.create(
            domain_event_id=domain_id,
            event_id=event_id,
            event_type=event_type,
            organization_id=str(organization_id),
            conversation=conversation,
            message=message,
            target_channels=channels,
            payload=payload,
        )

        transaction.on_commit(
            lambda record_id=str(record.id): IMOutboxService._enqueue_delivery(record_id),
            using=postgres_app_db_alias(),
            robust=True,
        )
        return record

    @staticmethod
    def _enqueue_delivery(record_id: str) -> None:
        from django.conf import settings

        if getattr(settings, "RUNNING_TESTS", False):
            return

        from apps.tabchat.tasks import deliver_im_outbox_sweep

        try:
            deliver_im_outbox_sweep.apply_async(
                kwargs={"limit": 100},
                queue="realtime_delivery",
            )
        except Exception:
            logger.exception(
                "[tabchat.outbox] immediate enqueue failed; sweep will retry record=%s",
                record_id,
            )

    @staticmethod
    def recover_expired_leases(now=None) -> int:
        now = now or timezone.now()
        expired = IMEventOutbox.objects.filter(
            status=IMEventOutbox.Status.PUBLISHING,
            lease_expires_at__lt=now,
        )
        dead_count = expired.filter(attempts__gte=OUTBOX_MAX_ATTEMPTS).update(
            status=IMEventOutbox.Status.DEAD,
            claim_token=None,
            lease_expires_at=None,
            next_retry_at=None,
            last_error="publish lease expired after maximum attempts",
            updated_at=now,
        )
        retry_count = expired.filter(attempts__lt=OUTBOX_MAX_ATTEMPTS).update(
            status=IMEventOutbox.Status.RETRY,
            claim_token=None,
            lease_expires_at=None,
            next_retry_at=now,
            last_error="publish lease expired",
            updated_at=now,
        )
        return dead_count + retry_count

    @staticmethod
    def claim(record_id: str | None = None) -> tuple[IMEventOutbox, uuid.UUID] | None:
        now = timezone.now()
        with transaction.atomic(using=postgres_app_db_alias()):
            queryset = (
                IMEventOutbox.objects
                .select_for_update(skip_locked=True)
                .filter(status__in=[IMEventOutbox.Status.PENDING, IMEventOutbox.Status.RETRY])
                .filter(Q(next_retry_at__isnull=True) | Q(next_retry_at__lte=now))
            )
            if record_id is not None:
                queryset = queryset.filter(id=record_id)
            record = queryset.order_by("created_at").first()
            if record is None:
                return None

            claim_token = uuid.uuid4()
            record.status = IMEventOutbox.Status.PUBLISHING
            record.claim_token = claim_token
            record.lease_expires_at = now + timedelta(seconds=OUTBOX_LEASE_SECONDS)
            record.attempts += 1
            record.save(
                update_fields=[
                    "status",
                    "claim_token",
                    "lease_expires_at",
                    "attempts",
                    "updated_at",
                ]
            )
            return record, claim_token

    @staticmethod
    def deliver_claimed(record: IMEventOutbox, claim_token: uuid.UUID) -> bool:
        from apps.tabchat.services.centrifugo_service import get_centrifugo_service

        try:
            service = get_centrifugo_service()
            channels = list(record.target_channels or [])
            if len(channels) == 1:
                result = service.publish_sync(channels[0], record.payload)
            else:
                result = service.broadcast_sync(channels, record.payload)
            if not result or result.get("error"):
                raise RuntimeError(f"Centrifugo publish rejected: {result!r}")
        except Exception as exc:
            IMOutboxService._mark_failed(record, claim_token, exc)
            return False

        updated = IMEventOutbox.objects.filter(
            id=record.id,
            status=IMEventOutbox.Status.PUBLISHING,
            claim_token=claim_token,
        ).update(
            status=IMEventOutbox.Status.DELIVERED,
            delivered_at=timezone.now(),
            claim_token=None,
            lease_expires_at=None,
            last_error="",
            updated_at=timezone.now(),
        )
        return updated == 1

    @staticmethod
    def _mark_failed(
        record: IMEventOutbox,
        claim_token: uuid.UUID,
        exc: Exception,
    ) -> None:
        is_dead = record.attempts >= OUTBOX_MAX_ATTEMPTS
        delay_seconds = min(300, 2 ** min(record.attempts, 8))
        IMEventOutbox.objects.filter(
            id=record.id,
            status=IMEventOutbox.Status.PUBLISHING,
            claim_token=claim_token,
        ).update(
            status=(
                IMEventOutbox.Status.DEAD
                if is_dead
                else IMEventOutbox.Status.RETRY
            ),
            next_retry_at=(
                None
                if is_dead
                else timezone.now() + timedelta(seconds=delay_seconds)
            ),
            claim_token=None,
            lease_expires_at=None,
            last_error=str(exc)[:2000],
            updated_at=timezone.now(),
        )

    @staticmethod
    def retry_dead(record_id: str) -> bool:
        updated = IMEventOutbox.objects.filter(
            id=record_id,
            status=IMEventOutbox.Status.DEAD,
        ).update(
            status=IMEventOutbox.Status.RETRY,
            attempts=0,
            next_retry_at=timezone.now(),
            claim_token=None,
            lease_expires_at=None,
            last_error="",
            updated_at=timezone.now(),
        )
        return updated == 1
