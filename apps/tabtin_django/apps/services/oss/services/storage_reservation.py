"""Redis-based pending storage reservation to mitigate TOCTOU race (QTA-10).

Pattern:
  1. Before upload: reserve_bytes() atomically increments pending counter
  2. assert_storage_upload_allowed(incoming_bytes + pending_for_others)
  3. After apply_storage_delta: release_bytes() decrements pending counter
  4. On failure: release_bytes() to clean up reservation

The pending counter is a conservative overestimate — it may count bytes that
end up failing, but that only means we reject borderline uploads slightly
earlier, which is the safe direction.
"""

import logging

from django.core.cache import cache as django_cache

logger = logging.getLogger(__name__)

_PENDING_KEY_PREFIX = "oss:pending_storage:"
_PENDING_TTL = 3600


def _key(organization_id: str) -> str:
    return f"{_PENDING_KEY_PREFIX}{organization_id}"


def get_pending_bytes(organization_id: str) -> int:
    if not organization_id:
        return 0
    return int(django_cache.get(_key(organization_id)) or 0)


def reserve_bytes(organization_id: str, nbytes: int) -> int:
    """Atomically reserve storage bytes. Returns new pending total."""
    if not organization_id or nbytes <= 0:
        return 0
    key = _key(organization_id)
    try:
        django_cache.add(key, 0, _PENDING_TTL)
        return django_cache.incr(key, nbytes)
    except ValueError:
        django_cache.set(key, nbytes, _PENDING_TTL)
        return nbytes


def release_bytes(organization_id: str, nbytes: int) -> None:
    """Release previously reserved bytes."""
    if not organization_id or nbytes <= 0:
        return
    key = _key(organization_id)
    try:
        val = django_cache.decr(key, nbytes)
        if val <= 0:
            django_cache.delete(key)
    except ValueError:
        django_cache.delete(key)
    except Exception:
        logger.debug("release_bytes failed for organization=%s", organization_id)


def assert_storage_with_reservation(organization_id: str, incoming_bytes: int) -> dict | None:
    """Check storage quota accounting for pending in-flight uploads.

    Returns the billing decision dict on success (contains
    ``storage_package_bytes``, ``projected_storage_bytes`` etc.),
    or ``None`` when the check is skipped.

    Raises ValueError or BillingBlockedError on failure, same as
    OrganizationStorageBillingService.assert_storage_upload_allowed.
    """
    if not organization_id or incoming_bytes <= 0:
        return None

    pending = get_pending_bytes(organization_id)
    reserve_bytes(organization_id, incoming_bytes)
    try:
        from apps.services.billing.services import OrganizationStorageBillingService
        decision = OrganizationStorageBillingService.assert_storage_upload_allowed(
            organization_id=organization_id,
            incoming_bytes=incoming_bytes + pending,
        )
        return decision
    except Exception:
        release_bytes(organization_id, incoming_bytes)
        raise
