"""System-owned references for admin operations.

These references identify an operation in transactions, entitlements, and
audit logs. They are not external approval tickets and must never be supplied
by an AdminDash form.
"""

from __future__ import annotations

from enum import StrEnum
from uuid import uuid4


class AdminOperationKind(StrEnum):
    CASH_RECHARGE = "CASH-RECHARGE"
    CASH_PURCHASE_CREDIT = "CASH-PURCHASE-CREDIT"
    CASH_PURCHASE_ADDON = "CASH-PURCHASE-ADDON"
    CREDITS_RECHARGE = "CREDITS-RECHARGE"
    QUOTA_GRANT = "QUOTA-GRANT"


def generate_admin_operation_reference(kind: AdminOperationKind) -> str:
    """Return a readable, globally unique reference for one admin operation."""

    return f"{kind.value}-{uuid4()}"
