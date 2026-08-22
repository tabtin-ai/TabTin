"""HITL security utilities — migrated from engine/hitl_security.py (M5).

Provides TTL checks, argument hash verification for HITL approval flows.
"""

from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Tuple

from django.conf import settings

logger = logging.getLogger(__name__)


def get_approval_ttl() -> int:
    """Return the configured HITL approval TTL in seconds."""
    return getattr(settings, "HITL_APPROVAL_TTL_SECONDS", 900)


def check_approval_ttl(
    interrupted_at: Optional[str],
    ttl_seconds: Optional[int] = None,
) -> Tuple[bool, str]:
    """Check whether an approval request is still within the TTL window.

    Returns (is_valid, reason).
    """
    if not interrupted_at:
        return True, ""

    ttl = ttl_seconds or get_approval_ttl()
    try:
        ts = datetime.fromisoformat(interrupted_at.replace("Z", "+00:00"))
        elapsed = (datetime.now(timezone.utc) - ts).total_seconds()
        if elapsed > ttl:
            return False, f"Approval expired: {elapsed:.0f}s > {ttl}s TTL"
    except (ValueError, TypeError) as exc:
        logger.warning("[hitl_security] Invalid interrupted_at: %s (%s)", interrupted_at, exc)
        return False, f"Invalid timestamp: {interrupted_at}"

    return True, ""


def check_ask_user_ttl(
    interrupted_at: Optional[str],
    ttl_seconds: Optional[int] = None,
) -> Tuple[bool, str]:
    """Check whether an ask-user request is still within the TTL window."""
    return check_approval_ttl(interrupted_at, ttl_seconds)


def compute_args_hash(args: Any) -> str:
    """Compute a deterministic hash of tool arguments for integrity verification."""
    if args is None:
        args = {}
    canonical = json.dumps(args, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def verify_args_integrity(
    original_hash: Optional[str],
    current_args: Any,
) -> Tuple[bool, str]:
    """Verify that tool arguments haven't been tampered with since the HITL request."""
    if not original_hash:
        return True, ""
    current_hash = compute_args_hash(current_args)
    if current_hash != original_hash:
        return False, f"Args hash mismatch: expected {original_hash}, got {current_hash}"
    return True, ""
