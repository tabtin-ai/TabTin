"""Device/session governance guard used by auth entry points."""

from __future__ import annotations

from uuid import UUID

from django.db.models import Q

from apps.tabtinspace.models import Device


def resolve_device_identifier(raw: str | None) -> str:
    return str(raw or "").strip()


def is_device_blocked(device_identifier: str | None) -> bool:
    value = resolve_device_identifier(device_identifier)
    if not value:
        return False
    query = Q(fingerprint=value)
    try:
        query |= Q(id=UUID(value))
    except ValueError:
        pass
    return Device.objects.filter(control_status="blocked").filter(query).exists()
