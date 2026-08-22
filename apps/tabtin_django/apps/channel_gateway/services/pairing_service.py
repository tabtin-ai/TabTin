"""Channel pairing request workflow."""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from datetime import timedelta
from typing import Tuple

from django.conf import settings
from django.utils import timezone

from apps.channel_gateway.models import ChannelPairingRequest, ChannelAllowlistEntry
from apps.channel_gateway.schemas import ChannelInboundMessage


@dataclass(frozen=True)
class PairingResult:
    request: ChannelPairingRequest
    created: bool


class ChannelPairingService:
    def __init__(self):
        self.ttl_seconds = int(getattr(settings, "CHANNEL_GATEWAY_PAIRING_TTL_SECONDS", 3600))
        self.max_pending = int(getattr(settings, "CHANNEL_GATEWAY_PAIRING_MAX_PENDING", 3))

    def create_or_get_pending(self, data: ChannelInboundMessage) -> PairingResult:
        account_id = (data.account_id or "default").strip() or "default"
        now = timezone.now()
        pending = ChannelPairingRequest.objects.filter(
            organization_id=data.organization_id,
            channel=data.channel,
            account_id=account_id,
            peer_id=data.peer_id,
            status="pending",
        ).first()
        if pending and pending.expires_at > now:
            return PairingResult(request=pending, created=False)

        pending_count = ChannelPairingRequest.objects.filter(
            organization_id=data.organization_id,
            channel=data.channel,
            account_id=account_id,
            status="pending",
        ).count()
        if pending_count >= self.max_pending:
            raise ValueError("pairing pending limit reached")

        code = self._generate_code()
        expires_at = now + timedelta(seconds=self.ttl_seconds)
        request = ChannelPairingRequest.objects.create(
            channel=data.channel,
            account_id=account_id,
            peer_kind=data.peer_kind,
            peer_id=data.peer_id,
            organization_id=data.organization_id,
            code=code,
            status="pending",
            expires_at=expires_at,
        )
        return PairingResult(request=request, created=True)

    def approve(self, request: ChannelPairingRequest, resolved_by: str) -> ChannelPairingRequest:
        request.status = "approved"
        request.resolved_at = timezone.now()
        request.resolved_by = resolved_by
        request.save(update_fields=["status", "resolved_at", "resolved_by", "updated_at"])
        ChannelAllowlistEntry.objects.update_or_create(
            organization_id=request.organization_id,
            channel=request.channel,
            account_id=request.account_id,
            peer_kind=request.peer_kind,
            peer_id=request.peer_id,
            defaults={"allow": True},
        )
        return request

    def reject(self, request: ChannelPairingRequest, resolved_by: str) -> ChannelPairingRequest:
        request.status = "rejected"
        request.resolved_at = timezone.now()
        request.resolved_by = resolved_by
        request.save(update_fields=["status", "resolved_at", "resolved_by", "updated_at"])
        return request

    def _generate_code(self) -> str:
        value = secrets.randbelow(10**6)
        return f"{value:06d}"
