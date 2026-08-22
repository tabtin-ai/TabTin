"""Channel runtime status cache service."""

from __future__ import annotations

from typing import Any, Dict

from apps.channel_gateway.models import ChannelRuntimeStatus
from apps.channel_gateway.schemas import ChannelStatusMessage


class ChannelRuntimeStatusService:
    def upsert_from_status(self, data: ChannelStatusMessage) -> ChannelRuntimeStatus:
        if not data.organization_id:
            raise ValueError("channel.status requires organization_id")
        details: Dict[str, Any] = data.details or {}
        qr = None
        if isinstance(details, dict):
            qr = details.get("qr")
        values = {
            "status": data.status,
            "last_error": data.last_error,
            "details": details or {},
            "qr": qr,
        }
        obj, _ = ChannelRuntimeStatus.objects.update_or_create(
            channel=data.channel,
            account_id=(data.account_id or "default").strip() or "default",
            organization_id=data.organization_id or "",
            defaults=values,
        )
        return obj
