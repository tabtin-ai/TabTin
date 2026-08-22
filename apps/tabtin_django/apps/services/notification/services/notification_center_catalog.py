"""通知中心产品场景目录。

产品文档把通知中心限定为四个辅助类别：自动化、协作、组织、账户。
这里同时提供 QuerySet 过滤条件和单条通知分类，避免列表筛选、未读数、
序列化标签各自维护一套字符串规则。
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from django.db.models import Q, QuerySet


CENTER_CATEGORIES = ("automation", "collaboration", "organization", "account")

AUTOMATION_NOTIFICATION_TYPES = frozenset(
    {
        "tracker.run.completed",
        "tracker.run.failed",
        "tracker.health_alert",
    }
)
AUTOMATION_SYSTEM_EVENTS = frozenset({"waiting_device", "waiting_timeout"})

COLLABORATION_NOTIFICATION_TYPES = frozenset(
    {
        "resource_access_request",
        "tabdoc.comment.mention",
        "tabdata.comment.mention",
        "tabdata.record.user_assigned",
    }
)
COLLABORATION_RESOURCE_ACTIONS = frozenset(
    {
        "invited",
        "permission_changed",
        "removed",
        "auto_removed",
        "auto_removed_summary",
        "owner_reassigned_summary",
    }
)

ORGANIZATION_NOTIFICATION_TYPES = frozenset(
    {
        "organization.invitation",
        "organization.invitation.responded",
        "organization.invitation.cancelled",
        "organization.invitation.sync",
        "organization.invitation.external_contact",
        "organization.invitation.external_contact.rejected",
        # 旧客户端时期的同义事件仍需归入组织，不要求回填历史数据。
        "invite_received",
        "invite_accepted",
        "member_added",
        "member_removed",
        "role_changed",
        "ownership_transfer",
    }
)

ACCOUNT_EVENT_NAMES = frozenset(
    {
        "balance_low",
        "budget_warning",
        "budget_critical",
        "billing_blocked",
        "degradation_alert",
        "credits_recharged",
        "cash_recharged",
        "membership_expiring",
        "membership_expired",
        "auto_renew_failed",
        "membership_downgraded_overlimit",
        "invoice_refunded",
        "platform_refund_completed",
        "invoice_collection_succeeded",
        "invoice_collection_failed",
        "platform_refund_failed",
        "refund_partial_failure",
        "storage_warning",
        "storage_critical",
        "storage_package_expiring",
        "storage_auto_renew_failed",
        "member_budget_warning",
        "member_budget_exhausted",
    }
)
ACCOUNT_NOTIFICATION_TYPES = frozenset(
    {
        *(f"account.{event_name}" for event_name in ACCOUNT_EVENT_NAMES),
        *(f"billing.{event_name}" for event_name in ACCOUNT_EVENT_NAMES),
        # 早期无命名空间事件。
        "balance_low",
        "cash_recharged",
        "quota_warning",
    }
)


def _category_query(category: str) -> Q:
    if category == "automation":
        return Q(type__in=AUTOMATION_NOTIFICATION_TYPES) | (
            Q(type="system") & Q(metadata__event__in=AUTOMATION_SYSTEM_EVENTS)
        )
    if category == "collaboration":
        return Q(type__in=COLLABORATION_NOTIFICATION_TYPES) | (
            Q(type="resource_shared")
            & Q(metadata__action__in=COLLABORATION_RESOURCE_ACTIONS)
        )
    if category == "organization":
        return Q(type__in=ORGANIZATION_NOTIFICATION_TYPES)
    if category == "account":
        return Q(type__in=ACCOUNT_NOTIFICATION_TYPES)
    return Q(pk__isnull=True)


def notification_center_query(category: str = "") -> Q:
    """返回通知中心场景过滤条件；未知类别返回空结果条件。"""
    normalized = category.strip().lower()
    if normalized:
        return _category_query(normalized)

    query = Q(pk__isnull=True)
    for center_category in CENTER_CATEGORIES:
        query |= _category_query(center_category)
    return query


def filter_notification_center_queryset(
    queryset: QuerySet,
    category: str = "",
) -> QuerySet:
    return queryset.filter(notification_center_query(category))


def resolve_notification_center_category(
    notification_type: str,
    metadata: Mapping[str, Any] | None = None,
) -> str | None:
    """把一条已落库事件解析为四类产品类别；非通知中心事件返回 ``None``。"""
    event_type = str(notification_type or "").strip()
    meta = metadata or {}

    if event_type in AUTOMATION_NOTIFICATION_TYPES or (
        event_type == "system" and meta.get("event") in AUTOMATION_SYSTEM_EVENTS
    ):
        return "automation"
    if event_type in COLLABORATION_NOTIFICATION_TYPES or (
        event_type == "resource_shared"
        and meta.get("action") in COLLABORATION_RESOURCE_ACTIONS
    ):
        return "collaboration"
    if event_type in ORGANIZATION_NOTIFICATION_TYPES:
        return "organization"
    if event_type in ACCOUNT_NOTIFICATION_TYPES:
        return "account"
    return None


__all__ = [
    "ACCOUNT_EVENT_NAMES",
    "CENTER_CATEGORIES",
    "filter_notification_center_queryset",
    "notification_center_query",
    "resolve_notification_center_category",
]
