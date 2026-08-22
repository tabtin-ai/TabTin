"""
TabtinSpace 后台治理 API

说明：
- 读接口：仅 staff 可访问
- 写接口：仅 superuser 可执行
- 路由挂载到 /api/auth/admin/*
"""

from __future__ import annotations

import logging
from datetime import date
from typing import Any, Optional
from uuid import UUID

from django.contrib.auth import get_user_model
from django.core.exceptions import ObjectDoesNotExist
from django.db import IntegrityError, transaction
from django.db.models import (
    BigIntegerField,
    CharField,
    Count,
    OuterRef,
    Q,
    Subquery,
    Sum,
    Value,
)
from django.db.models.functions import Cast, Coalesce
from ninja import Router
from ninja.errors import HttpError
from ninja import Schema

from decimal import Decimal, InvalidOperation
from dateutil.relativedelta import relativedelta
from django.utils import timezone

from apps.services.common.app_registry import list_apps
from apps.i18n import _
from apps.i18n.response import error_response_with_status as error_response, not_found_response, success_response
from apps.users.wallet.models import CreditPackage, OrganizationWallet, WalletTransaction
from apps.users.wallet.services.organization_cash_wallet_service import (
    DuplicateCashTransactionOrder,
    InsufficientCashBalance,
    OrganizationCashWalletService,
)
from apps.tabtinspace.services.admin_operation_reference import (
    AdminOperationKind,
    generate_admin_operation_reference,
)
from apps.services.billing.models import AddonPackage, OrganizationAddonEntitlement
from apps.services.billing.services.addon_entitlement_service import AddonEntitlementService
from apps.users.membership.services.quota_service import QuotaService
from apps.tabtinspace.models import (
    Agent,
    ContextItem,
    Project,
    SpaceAppSettings,
    SpaceAdminActionLog,
    SpaceMembership,
    Organization,
    OrganizationControlPolicy,
    OrganizationMember,
    Workspace,
)
from apps.tabtinspace.services.host_resolver import (
    host_exists,
    lock_host_for_update,
    resolve_host,
)
from apps.tabtinspace.schemas.common import ErrorResponse
from apps.tabtinspace.services.base import ServiceError
from apps.tabtinspace.services.organization_service import OrganizationService
from apps.tabdata.models import Table
from apps.services.common.constants import VALID_SPACE_STATUSES as SPACE_STATUS_SET
from apps.users.auth.admin_audit import record_admin_sensitive_action
from apps.users.auth.permissions import AdminPermissionAuth, StaffAuth, SuperuserAuth
from apps.services.common.db_router import postgres_app_db_alias
from apps.services.oss.services.public_assets import build_public_asset_url

User = get_user_model()
logger = logging.getLogger(__name__)

router = Router(tags=["TabtinSpace Admin"], auth=StaffAuth())

class AdminOrganizationDeleteRequest(Schema):
    dry_run: bool = False
    force: bool = False
    reason: str | None = None
    ticket_id: str | None = ""

class AdminSpaceDeleteRequest(Schema):
    dry_run: bool = False
    force: bool = False

class AdminOrganizationCreateRequest(Schema):
    name: str
    description: str | None = None
    icon: str | None = None
    settings: dict | None = None

class AdminOrganizationUpdateRequest(Schema):
    name: str | None = None
    description: str | None = None
    icon: str | None = None
    settings: dict | None = None
    reason: str | None = None
    ticket_id: str | None = ""


class AdminOrganizationTransferOwnershipRequest(Schema):
    new_owner_user_id: str
    reason: str
    ticket_id: str | None = ""


class AdminOrganizationControlPolicyUpdateRequest(Schema):
    is_suspended: bool | None = None
    is_readonly: bool | None = None
    ai_disabled: bool | None = None
    resource_write_disabled: bool | None = None
    app_tool_disabled: bool | None = None
    invite_disabled: bool | None = None
    member_join_disabled: bool | None = None
    metadata_json: dict | None = None
    reason: str
    ticket_id: str | None = ""
    idempotency_key: str | None = ""


class AdminSensitiveReasonRequest(Schema):
    reason: str
    ticket_id: str | None = ""


class AdminMemberRoleUpdateRequest(Schema):
    role: str
    reason: str
    ticket_id: str | None = ""


class AdminMemberAddRequest(Schema):
    # Admin direct-add: registered user only, no accept step
    user_id: str | None = ""
    phone: str | None = ""
    role: str = "editor"
    reason: str
    ticket_id: str | None = ""


class AdminInvitationPhoneCreateRequest(Schema):
    phone: str
    role: str = "editor"
    expires_hours: int = 72
    reason: str
    ticket_id: str | None = ""


class AdminInvitationLinkCreateRequest(Schema):
    role: str = "editor"
    max_uses: int = -1
    expires_hours: int = 168
    reason: str
    ticket_id: str | None = ""


class AdminInvitationDirectCreateRequest(Schema):
    user_id: str
    role: str = "editor"
    expires_hours: int = 72
    reason: str
    ticket_id: str | None = ""


class AdminSpaceCreateRequest(Schema):
    organization_id: str
    name: str
    description: str | None = None
    icon: str | None = None
    color: str | None = None
    status: str | None = "active"
    order: int | None = 0

class AdminSpaceUpdateRequest(Schema):
    name: str | None = None
    description: str | None = None
    icon: str | None = None
    color: str | None = None
    status: str | None = None
    order: int | None = None
    start_date: str | None = None
    end_date: str | None = None
    is_archived: bool | None = None

class AdminOrganizationWalletRechargeRequest(Schema):
    amount: int
    description: str = "管理员充值"


class AdminOrganizationQuotaGrantRequest(Schema):
    quota_key: str
    quota_value: int
    period_months: int = 1200
    reason: str


class AdminOrganizationCashRechargeRequest(Schema):
    amount_cny: str
    reason: str


class AdminOrganizationCashPurchaseRequest(Schema):
    package_id: str
    reason: str = ""

def _parse_uuid_or_http_error(raw_value: str, field_name: str) -> UUID:
    try:
        return UUID(str(raw_value).strip())
    except (TypeError, ValueError) as exc:
        raise HttpError(400, f"{field_name} 非法，必须是 UUID") from exc

def _try_parse_uuid(raw_value: str) -> UUID | None:
    value = str(raw_value).strip()
    if not value:
        return None
    try:
        return UUID(value)
    except (TypeError, ValueError):
        return None

def _parse_optional_date(raw_value: str | None, field_name: str) -> date | None:
    if raw_value is None:
        return None
    value = str(raw_value).strip()
    if not value:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise HttpError(400, f"{field_name} 非法，必须为 YYYY-MM-DD") from exc

def _build_owner_name_map(owner_ids: list[str]) -> dict[str, str]:
    """批量获取用户展示名，委托给共享的 build_user_info_map 保证逻辑统一。"""
    if not owner_ids:
        return {}
    from apps.services.billing.services import build_user_info_map
    info_map = build_user_info_map(owner_ids)
    return {uid: info["display_name"] for uid, info in info_map.items()}


def _build_owner_keyword_filter(keyword: str) -> Q:
    normalized_keyword = keyword.strip()
    username_keyword = normalized_keyword.removeprefix("@")
    filters = (
        Q(username__icontains=normalized_keyword)
        | Q(nickname__icontains=normalized_keyword)
        | Q(email__icontains=normalized_keyword)
        | Q(phone__icontains=normalized_keyword)
    )
    if username_keyword and username_keyword != normalized_keyword:
        filters |= Q(username__icontains=username_keyword)
    return filters


def _extract_request_meta(request) -> tuple[str | None, str]:
    from apps.users.auth.utils import get_client_ip
    client_ip = get_client_ip(request)
    meta = getattr(request, "META", {}) or {}
    user_agent = str(meta.get("HTTP_USER_AGENT", "")).strip()
    return (client_ip or None), user_agent

def _extract_trace_id(request) -> str:
    headers = getattr(request, "headers", None)
    trace_id = ""
    if headers is not None:
        trace_id = (
            str(headers.get("X-Trace-Id") or "")
            or str(headers.get("X-Request-Id") or "")
        ).strip()
    if trace_id:
        return trace_id[:128]

    meta = getattr(request, "META", {}) or {}
    trace_id = (
        str(meta.get("HTTP_X_TRACE_ID") or "")
        or str(meta.get("HTTP_X_REQUEST_ID") or "")
    ).strip()
    return trace_id[:128]

def _record_admin_action(
    *,
    request,
    action_type: str,
    target_type: str,
    target_id: UUID,
    organization_id: UUID | None = None,
    space_id: UUID | None = None,
    dry_run: bool = False,
    success: bool = True,
    message: str = "",
    error_message: str = "",
    request_payload: dict | None = None,
    result_payload: dict | None = None,
) -> None:
    """记录后台治理操作审计日志（委托 AuditService.log）。"""
    from apps.tabtinspace.services.audit_service import AuditService

    ip_address, user_agent = _extract_request_meta(request)
    AuditService.log(
        action_type,
        target_type,
        target_id,
        organization_id=organization_id,
        space_id=space_id,
        operator=request.auth,
        dry_run=dry_run,
        success=success,
        message=message,
        error_message=error_message,
        request_payload=request_payload,
        result_payload=result_payload,
        trace_id=_extract_trace_id(request),
        ip_address=ip_address,
        user_agent=user_agent,
    )

def _serialize_admin_action_item(item: SpaceAdminActionLog) -> dict:
    return {
        "id": str(item.id),
        "action_type": item.action_type,
        "target_type": item.target_type,
        "target_id": str(item.target_id),
        "organization_id": str(item.organization_id) if item.organization_id else None,
        "space_id": str(item.space_id) if item.space_id else None,
        "operator_id": item.operator_id or "",
        "operator_name": item.operator_name or "",
        "dry_run": item.dry_run,
        "success": item.success,
        "message": item.message or "",
        "error_message": item.error_message or "",
        "request_payload": item.request_payload or {},
        "result_payload": item.result_payload or {},
        "trace_id": item.trace_id or "",
        "created_at": item.created_at.isoformat(),
    }

def _build_organization_stats(
    organization_ids: list[str],
) -> tuple[dict[str, int], dict[str, int]]:
    if not organization_ids:
        return {}, {}

    active_space_count_map: dict[str, int] = {}
    for row in (
        Workspace.objects.filter(organization_id__in=organization_ids)
        .values("organization_id")
        .annotate(count=Count("id"))
    ):
        active_space_count_map[str(row["organization_id"])] = int(row["count"])
    for row in (
        Project.objects.filter(organization_id__in=organization_ids, is_archived=False)
        .values("organization_id")
        .annotate(count=Count("id"))
    ):
        key = str(row["organization_id"])
        active_space_count_map[key] = active_space_count_map.get(key, 0) + int(row["count"])

    organization_table_rows = (
        Table.objects.filter(organization_id__in=organization_ids, is_archived=False)
        .values("organization_id")
        .annotate(count=Count("id"))
    )
    active_table_count_map = {
        str(row["organization_id"]): int(row["count"])
        for row in organization_table_rows
    }

    return active_space_count_map, active_table_count_map


def _batch_get_organization_member_counts(organization_ids: list[str]) -> dict[str, int]:
    """按 OrganizationMember 实表聚合成员数，避免读到滞后的非规范化字段。

    Organization.member_count 由 signal 维护，偏差依赖定时 reconcile 修正；
    后台列表/详情若直接读冗余字段，会出现「用户刚加入/退出后总人数仍旧」
    。admin 读路径用一次 GROUP BY 取实数即可。
    """
    if not organization_ids:
        return {}

    rows = (
        OrganizationMember.objects.filter(organization_id__in=organization_ids)
        .values("organization_id")
        .annotate(count=Count("id"))
    )
    return {str(row["organization_id"]): int(row["count"]) for row in rows}


def _batch_get_organization_space_counts(organization_ids: list[str]) -> dict[str, int]:
    """按 Workspace + Project 聚合，避免读到滞后的 Organization.space_count。

    ：与 signal 口径一致；active_space_count 另见 _build_organization_stats。
    """
    if not organization_ids:
        return {}

    count_map: dict[str, int] = {}
    for row in (
        Workspace.objects.filter(organization_id__in=organization_ids)
        .values("organization_id")
        .annotate(count=Count("id"))
    ):
        count_map[str(row["organization_id"])] = int(row["count"])
    for row in (
        Project.objects.filter(organization_id__in=organization_ids)
        .values("organization_id")
        .annotate(count=Count("id"))
    ):
        key = str(row["organization_id"])
        count_map[key] = count_map.get(key, 0) + int(row["count"])
    return count_map


def _serialize_organization_item(
    organization: Organization,
    *,
    owner_name_map: dict[str, str],
    active_space_count_map: dict[str, int],
    active_table_count_map: dict[str, int],
    wallet_balance_map: dict[str, int] | None = None,
    member_count_map: dict[str, int] | None = None,
    space_count_map: dict[str, int] | None = None,
) -> dict:
    owner_id = str(organization.owner_id)
    organization_id = str(organization.id)
    settings = organization.settings or {}
    logo_ref = settings.get("logo_url")
    if isinstance(logo_ref, str) and logo_ref.strip():
        settings = {**settings, "logo_url": build_public_asset_url(logo_ref)}
    if member_count_map is not None:
        # 未出现在聚合结果中的组织视为 0 人（刚清空成员时冗余字段可能仍 > 0）
        member_count = member_count_map.get(organization_id, 0)
    else:
        member_count = organization.member_count
    if space_count_map is not None:
        space_count = space_count_map.get(organization_id, 0)
    else:
        space_count = organization.space_count
    result = {
        "id": organization_id,
        "name": organization.name,
        "description": organization.description or "",
        "icon": organization.icon or "",
        "owner_id": owner_id,
        "owner_name": owner_name_map.get(owner_id, owner_id),
        "is_default": organization.is_default,
        "type": getattr(organization, "type", "team"),
        # 生命周期状态（active / deleting），勿与 settings 混用
        "status": getattr(organization, "status", None) or Organization.Status.ACTIVE,
        "settings": settings,
        "space_count": space_count,
        "member_count": member_count,
        "table_count": organization.table_count,
        "active_space_count": active_space_count_map.get(organization_id, 0),
        "active_table_count": active_table_count_map.get(organization_id, 0),
        "created_at": organization.created_at.isoformat(),
        "updated_at": organization.updated_at.isoformat(),
    }
    if wallet_balance_map is not None:
        result["wallet_credits"] = wallet_balance_map.get(organization_id)
    return result


def _serialize_organization_control_policy(policy: OrganizationControlPolicy) -> dict:
    updated_by = getattr(policy, "updated_by_admin_account", None)
    return {
        "id": str(policy.id),
        "organization_id": str(policy.organization_id),
        "is_suspended": bool(policy.is_suspended),
        "is_readonly": bool(policy.is_readonly),
        "ai_disabled": bool(policy.ai_disabled),
        "resource_write_disabled": bool(policy.resource_write_disabled),
        "app_tool_disabled": bool(policy.app_tool_disabled),
        "invite_disabled": bool(policy.invite_disabled),
        "member_join_disabled": bool(policy.member_join_disabled),
        "reason_snapshot": policy.reason_snapshot or "",
        "metadata_json": policy.metadata_json or {},
        "updated_by_admin_account_id": str(policy.updated_by_admin_account_id) if policy.updated_by_admin_account_id else "",
        "updated_by_admin_account_name": getattr(updated_by, "display_name", "") if updated_by else "",
        "created_at": policy.created_at.isoformat(),
        "updated_at": policy.updated_at.isoformat(),
    }


def _build_space_resource_count_map(
    space_ids: list[str],
) -> dict[str, dict[str, int]]:
    """统计 Space-local 关系的 space 维度计数。

    返回 {count_label: {space_id_str: count}}。
    仅统计 count_label 不为 None 且 as_field 不为 None 的注册项。

    注意：Table/Document/Slide/Canvas/Memo 等云资源归 Organization，不再归 Space；
    即使旧数据仍带 space_id，也不能在这里当作 Space 删除影响面展示。
    """
    from apps.tabtinspace.services.organization_service import _get_organization_resource_models

    if not space_ids:
        return {}

    result: dict[str, dict[str, int]] = {}

    for b in _get_organization_resource_models():
        if not b.count_label or not b.as_field:
            continue
        qs = b.model.objects.filter(**{f'{b.as_field}__in': space_ids})
        if b.count_filter:
            qs = qs.filter(**b.count_filter)
        rows = qs.values(b.as_field).annotate(count=Count("id"))
        result[b.count_label] = {str(r[b.as_field]): int(r["count"]) for r in rows}

    return result

def _serialize_space_item(
    space,
    *,
    organization_name_map: dict[str, str],
    resource_counts: dict[str, dict[str, int]],
) -> dict:
    """序列化 Workspace/Project 为 admin API 响应。

    resource_counts: _build_space_resource_count_map 的返回值，
    格式为 {count_label: {space_id_str: count}}。
    """
    as_id = str(space.id)
    wt_id = str(space.organization_id)

    def _rc(label: str, fallback: int = 0) -> int:
        return resource_counts.get(label, {}).get(as_id, fallback)

    # ：Workspace/Project 宿主不再挂执行 Agent。
    return {
        "id": as_id,
        "organization_id": wt_id,
        "organization_name": organization_name_map.get(wt_id),
        # ：宿主为 Workspace/Project，字段用 getattr 兜底（无 Space.type）。
        "name": getattr(space, "name", "") or "",
        "description": getattr(space, "description", "") or "",
        "icon": getattr(space, "icon", "") or "",
        "avatar": build_public_asset_url(getattr(space, "avatar", "") or ""),
        "color": getattr(space, "color", "") or "",
        "status": getattr(space, "status", "active") or "active",
        "agent_id": None,
        "agent": None,
        "table_count": _rc("table_count"),
        "total_records": _rc("total_records"),
        "document_count": _rc("document_count"),
        "ppt_count": _rc("ppt_count"),
        "resource_count": sum(
            _rc(label)
            for label in (
                "table_count",
                "document_count",
                "ppt_count",
                "code_count",
                "video_count",
                "context_item_count",
            )
        ),
        "code_count": _rc("code_count"),
        "video_count": _rc("video_count"),
        "context_item_count": _rc("context_item_count"),
        "member_count": (
            space.memberships.filter(is_active=True).count()
            if hasattr(space, "memberships")
            else 0
        ),
        "app_authorization_status": "customized"
        if SpaceAppSettings.objects.filter(workspace_id=space.id).exists()
        else "default",
        "order": getattr(space, "order", 0) or 0,
        # Workspace 无归档/默认/活动期字段；仅 Project 有。统一 getattr，避免列表 500。
        "is_archived": bool(getattr(space, "is_archived", False)),
        "is_default": bool(getattr(space, "is_default", False)),
        "last_activity_at": (
            space.last_activity_at.isoformat()
            if getattr(space, "last_activity_at", None)
            else None
        ),
        "start_date": (
            space.start_date.isoformat() if getattr(space, "start_date", None) else None
        ),
        "end_date": space.end_date.isoformat() if getattr(space, "end_date", None) else None,
        "created_at": space.created_at.isoformat(),
        "updated_at": space.updated_at.isoformat(),
    }

def _build_pagination(total: int, page: int, page_size: int) -> dict:
    total_pages = (total + page_size - 1) // page_size if total else 0
    normalized_page = page
    if total_pages and normalized_page > total_pages:
        normalized_page = total_pages
    return {
        "total": total,
        "page": normalized_page,
        "page_size": page_size,
        "total_pages": total_pages,
        "offset": (normalized_page - 1) * page_size if total else 0,
    }

def _get_organization_wallet(organization_id: str) -> OrganizationWallet | None:
    return OrganizationWallet.objects.filter(organization_id=str(organization_id)).first()

def _batch_get_organization_wallet_balances(organization_ids: list[str]) -> dict[str, int]:
    if not organization_ids:
        return {}
    wallets = OrganizationWallet.objects.filter(
        organization_id__in=organization_ids
    ).values_list("organization_id", "credits")
    return {str(wt_id): int(credits) for wt_id, credits in wallets}

def _serialize_wallet_info(wallet: OrganizationWallet) -> dict:
    return {
        "wallet_id": wallet.id,
        "organization_id": wallet.organization_id,
        "credits": wallet.credits,
        "credits_precise": str(wallet.credits_precise),
        "credits_frozen": wallet.credits_frozen,
        "credits_frozen_precise": str(wallet.credits_frozen_precise),
        "available_credits": wallet.get_available_credits(),
        "created_at": wallet.created_at.isoformat(),
        "updated_at": wallet.updated_at.isoformat(),
    }

def _serialize_wallet_transaction(tx: WalletTransaction, operator_name_map: dict[str, str] | None = None) -> dict:
    op_map = operator_name_map or {}
    return {
        "id": tx.id,
        "transaction_type": tx.transaction_type,
        "amount": tx.amount,
        "amount_precise": str(tx.amount_precise),
        "balance_before": tx.balance_before,
        "balance_before_precise": str(tx.balance_before_precise),
        "balance_after": tx.balance_after,
        "balance_after_precise": str(tx.balance_after_precise),
        "organization_id": tx.organization_id or "",
        "operator_user_id": tx.operator_user_id or "",
        "operator_display_name": op_map.get(tx.operator_user_id, "") if tx.operator_user_id else "",
        "description": tx.description or "",
        "related_order_id": tx.related_order_id or "",
        "created_at": tx.created_at.isoformat(),
    }


def _serialize_cash_wallet(wallet) -> dict:
    if wallet is None:
        return None
    return {
        "wallet_id": wallet.id,
        "organization_id": wallet.organization_id,
        "balance_cny": str(wallet.balance_cny),
        "frozen_cny": str(wallet.frozen_cny),
        "available_cny": str(wallet.get_available_cny()),
        "created_at": wallet.created_at.isoformat() if wallet.created_at else None,
        "updated_at": wallet.updated_at.isoformat() if wallet.updated_at else None,
    }


_MEMBERSHIP_CASH_TX_TYPES = {
    "membership_payment",
    "membership_upgrade_payment",
    "membership_lifecycle_payment",
}

_MEMBERSHIP_CHANGE_TYPE_LABELS = {
    "new": "首次订阅",
    "upgrade": "升级套餐",
    "renewal": "续费",
    "renew": "续费",
    "switch": "切换套餐",
    "downgrade": "降级",
}

_BILLING_CYCLE_LABELS = {
    "monthly": "按月",
    "yearly": "按年",
    "annual": "按年",
}


def _build_membership_cash_summary(order=None, metadata: Optional[dict] = None) -> Optional[dict]:
    """从支付订单 / 流水 metadata 拼装套餐相关摘要，供账单中心展示。"""
    meta = dict(metadata or {})
    business = dict(getattr(order, "business_data", None) or {})
    snapshot = dict(business.get("pricing_snapshot") or meta.get("pricing_snapshot") or {})
    change_plan = dict(business.get("change_plan") or meta.get("change_plan") or {})
    change_type = (
        meta.get("change_type")
        or business.get("change_type")
        or change_plan.get("change_type")
        or ""
    )
    billing_cycle = (
        meta.get("billing_cycle")
        or business.get("billing_cycle")
        or change_plan.get("billing_cycle")
        or snapshot.get("billing_cycle")
        or ""
    )
    target_tier_name = (
        meta.get("target_tier_name")
        or snapshot.get("target_tier_name")
        or change_plan.get("to_tier_name")
        or business.get("tier_name")
        or ""
    )
    from_tier_name = (
        meta.get("from_tier_name")
        or snapshot.get("from_tier_name")
        or change_plan.get("from_tier_name")
        or ""
    )
    order_no = meta.get("order_no") or getattr(order, "order_no", "") or ""
    payable = (
        meta.get("payable_amount")
        or snapshot.get("payable_amount")
        or snapshot.get("target_effective_period_price")
        or (str(order.amount) if order is not None and order.amount is not None else "")
    )
    if not any([change_type, target_tier_name, order_no, from_tier_name]):
        return None
    return {
        "change_type": change_type,
        "change_type_label": _MEMBERSHIP_CHANGE_TYPE_LABELS.get(str(change_type), str(change_type) or ""),
        "billing_cycle": billing_cycle,
        "billing_cycle_label": _BILLING_CYCLE_LABELS.get(str(billing_cycle), str(billing_cycle) or ""),
        "target_tier_name": target_tier_name,
        "from_tier_name": from_tier_name,
        "from_tier_id": change_plan.get("from_tier_id") or snapshot.get("from_tier_id") or "",
        "to_tier_id": (
            change_plan.get("to_tier_id")
            or snapshot.get("target_tier_id")
            or business.get("tier_id")
            or ""
        ),
        "order_no": order_no,
        "payable_amount": str(payable) if payable not in (None, "") else "",
        "remaining_ratio": str(snapshot.get("remaining_ratio") or change_plan.get("remaining_ratio") or ""),
        "current_period_credit": str(
            snapshot.get("current_period_credit")
            or snapshot.get("current_value")
            or ""
        ),
        "target_period_charge": str(
            snapshot.get("target_period_charge")
            or snapshot.get("target_value")
            or snapshot.get("target_effective_period_price")
            or ""
        ),
        "payment_status": getattr(order, "status", "") or "",
        "benefit_status": getattr(order, "benefit_status", "") or "",
    }


def _serialize_cash_transaction(
    tx,
    operator_display_name: str = "",
    membership_summary: Optional[dict] = None,
) -> dict:
    summary = membership_summary
    if summary is None and tx.transaction_type in _MEMBERSHIP_CASH_TX_TYPES:
        summary = _build_membership_cash_summary(metadata=tx.metadata or {})
    return {
        "id": tx.id,
        "transaction_type": tx.transaction_type,
        "amount_cny": str(tx.amount_cny),
        "balance_before_cny": str(tx.balance_before_cny),
        "balance_after_cny": str(tx.balance_after_cny),
        "organization_id": tx.organization_id,
        "operator_user_id": tx.operator_user_id or "",
        "operator_display_name": operator_display_name or "",
        "description": tx.description or "",
        "related_order_id": tx.related_order_id or "",
        "related_wallet_transaction_id": tx.related_wallet_transaction_id or "",
        "related_addon_entitlement_id": tx.related_addon_entitlement_id or "",
        "metadata": tx.metadata or {},
        "membership_summary": summary,
        "created_at": tx.created_at.isoformat() if tx.created_at else None,
    }


QUOTA_GRANT_KEYS = {
    "max_documents": "文档数量",
    "max_tables": "表格数量",
    "max_groups": "群组数量",
    "storage_quota_bytes": "存储容量",
    "max_members": "成员席位",
}

# storage 以字节入库；单次上限 100 TiB，其余类型沿用 1_000_000
_QUOTA_GRANT_MAX_VALUE = {
    "storage_quota_bytes": 100 * 1024 * 1024 * 1024 * 1024,
}

# 后台权益摘要展示键：顺序与标签对齐 Electron membership.entitlements（点券额度一并展示）
ENTITLEMENT_SUMMARY_KEYS = {
    "max_tables": "表格",
    "max_documents": "文档",
    "max_groups": "群组",
    "max_members": "成员",
    "included_storage_bytes": "存储",
    "included_llm_credits_monthly": "点券",
}


def _serialize_addon_entitlement(item: OrganizationAddonEntitlement) -> dict:
    return {
        "id": str(item.id),
        "organization_id": item.organization_id,
        "quota_key": item.quota_key,
        "quota_label": QUOTA_GRANT_KEYS.get(item.quota_key, item.quota_key),
        "quota_value": int(item.quota_value or 0),
        "starts_at": item.starts_at.isoformat() if item.starts_at else None,
        "expires_at": item.expires_at.isoformat() if item.expires_at else None,
        "status": item.status,
        "purchased_by": item.purchased_by or "",
        "metadata": item.metadata or {},
        "created_at": item.created_at.isoformat() if item.created_at else None,
        "updated_at": item.updated_at.isoformat() if item.updated_at else None,
    }


def _get_admin_grant_package(quota_key: str) -> AddonPackage:
    label = QUOTA_GRANT_KEYS.get(quota_key, quota_key)
    package, _created = AddonPackage.objects.update_or_create(
        addon_code=f"admin_grant_{quota_key}",
        defaults={
            "addon_name": f"运营发放{label}扩容",
            "description": "管理后台手动发放的团队扩容权益占位包。",
            "price": Decimal("0.01"),
            "quota_key": quota_key,
            "quota_value": 1,
            "period_months": 1,
            "is_active": True,
            "metadata": {"source": "admin_grant_placeholder"},
        },
    )
    return package


def _llm_monthly_credit_usage(organization_id: str) -> tuple[int, int]:
    """返回本月 (已消耗点券, 自动补充点券)。"""
    try:
        from apps.services.billing.models import OrganizationLlmMonthlyBudget

        cycle_month = timezone.now().date().replace(day=1)
        budget = (
            OrganizationLlmMonthlyBudget.objects
            .filter(organization_id=str(organization_id), cycle_month=cycle_month)
            .only("consumed_credits", "topup_credits")
            .first()
        )
        if budget is None:
            return 0, 0
        consumed = int(Decimal(str(budget.consumed_credits or 0)))
        topup = int(Decimal(str(budget.topup_credits or 0)))
        return max(consumed, 0), max(topup, 0)
    except Exception:
        logger.warning(
            "load llm monthly credit usage failed: organization=%s",
            organization_id,
            exc_info=True,
        )
        return 0, 0


def _build_entitlement_summary(organization_id: str) -> dict:
    quota_service = QuotaService()
    tier, source = quota_service.get_effective_tier(organization_id=organization_id)
    quota_usage = quota_service.get_usage_stats(organization_id=organization_id) if tier else {}
    addon_quotas = AddonEntitlementService.get_addon_quotas(organization_id)
    active_addons = [
        _serialize_addon_entitlement(item)
        for item in AddonEntitlementService.get_active_addons(organization_id).order_by("-expires_at", "-created_at")
    ]
    member_count = OrganizationMember.objects.filter(organization_id=organization_id).count()
    llm_consumed, llm_topup = _llm_monthly_credit_usage(organization_id)
    limits = {}
    for key, label in ENTITLEMENT_SUMMARY_KEYS.items():
        raw_plan_limit = getattr(tier, key, 0) if tier else 0
        try:
            plan_limit = int(Decimal(str(raw_plan_limit or 0)))
        except (InvalidOperation, TypeError, ValueError):
            plan_limit = 0
        # 套餐字段是 included_storage_bytes，扩容包键是 storage_quota_bytes
        addon_key = "storage_quota_bytes" if key == "included_storage_bytes" else key
        addon_limit = int(addon_quotas.get(addon_key) or 0)
        if key == "included_llm_credits_monthly":
            # 自动补充计入扩容侧，便于运营看清「套餐额度 + 补充」
            addon_limit = llm_topup
        effective_limit = -1 if plan_limit == -1 else plan_limit + addon_limit
        current = (quota_usage.get(key) or {}).get("current")
        # QuotaService 对 max_members 的 current 故意留空，这里补齐以便与客户端一致
        if key == "max_members" and current is None:
            current = member_count
        if key == "included_storage_bytes" and current is None:
            current = 0
        if key == "included_llm_credits_monthly":
            current = llm_consumed
        limits[key] = {
            "label": label,
            "plan_limit": plan_limit,
            "addon_limit": addon_limit,
            "effective_limit": effective_limit,
            "current": current,
        }
    return {
        "organization_id": organization_id,
        "tier": {
            "id": str(getattr(tier, "id", "") or ""),
            "tier_type": getattr(tier, "tier_type", "") if tier else "",
            "name": getattr(tier, "name", "") if tier else "",
            "source": source,
        },
        "limits": limits,
        "active_addons": active_addons,
    }

def _count_organization_impact(organization_id: UUID) -> dict:
    """统计 organization 删除的影响范围（遍历注册表 + 结构性计数）。

    优先使用 wt_field 统计（因为兜底删除覆盖全部），
    仅 wt_field 为 None 的模型 fallback 到 as_field 统计。
    """
    from apps.tabtinspace.services.organization_service import _get_organization_resource_models

    space_ids = list(
        Workspace.objects.filter(organization_id=organization_id).values_list("id", flat=True)
    ) + list(
        Project.objects.filter(organization_id=organization_id).values_list("id", flat=True)
    )

    result: dict = {
        "space_count": len(space_ids),
        "member_count": OrganizationMember.objects.filter(organization_id=organization_id).count(),
    }

    total = 0
    for b in _get_organization_resource_models():
        if not b.count_label:
            continue
        if b.ws_field:
            val = b.ws_transform(organization_id) if b.ws_transform else organization_id
            count = b.model.objects.filter(**{b.ws_field: val}).count()
        elif b.as_field and space_ids:
            count = b.model.objects.filter(**{f'{b.as_field}__in': space_ids}).count()
        else:
            count = 0
        result[b.count_label] = count
        total += count

    result["total_resources"] = total
    return result

def _count_space_impact(space_id: UUID) -> dict:
    """统计 space 删除的影响范围（遍历注册表）。"""
    from apps.tabtinspace.services.organization_service import _get_organization_resource_models

    result: dict = {}
    total = 0
    for b in _get_organization_resource_models():
        if b.as_field and b.count_label:
            count = b.model.objects.filter(**{b.as_field: space_id}).count()
            result[b.count_label] = count
            total += count

    result["total_resources"] = total
    return result

@router.get(
    "/organizations",
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse},
    auth=StaffAuth(),
    tags=["后台空间治理"],
    summary="后台组织列表",
)
def admin_list_organizations(
    request,
    keyword: str = "",
    owner_id: str = "",
    owner_keyword: str = "",
    is_default: bool | None = None,
    type: str = "",
    sort: str = "updated_desc",
    page: int = 1,
    page_size: int = 20,
):

    page = max(page, 1)
    page_size = max(1, min(page_size, 100))

    queryset = Organization.objects.all()

    normalized_keyword = keyword.strip()
    if normalized_keyword:
        keyword_filter = Q(name__icontains=normalized_keyword) | Q(description__icontains=normalized_keyword)
        keyword_uuid = _try_parse_uuid(normalized_keyword)
        if keyword_uuid is not None:
            keyword_filter |= Q(id=keyword_uuid)
        queryset = queryset.filter(keyword_filter)

    normalized_owner_id = owner_id.strip()
    if normalized_owner_id:
        queryset = queryset.filter(owner_id=normalized_owner_id)

    normalized_owner_keyword = owner_keyword.strip()
    if normalized_owner_keyword:
        owner_uuid = _try_parse_uuid(normalized_owner_keyword)
        if owner_uuid is not None:
            queryset = queryset.filter(owner_id=owner_uuid)
        else:
            owner_ids = list(
                User.objects.filter(_build_owner_keyword_filter(normalized_owner_keyword))
                .values_list("id", flat=True)[:200]
            )
            if owner_ids:
                queryset = queryset.filter(owner_id__in=owner_ids)
            else:
                queryset = queryset.none()

    if is_default is not None:
        queryset = queryset.filter(is_default=is_default)

    normalized_type = type.strip()
    if normalized_type:
        queryset = queryset.filter(type=normalized_type)

    normalized_sort = sort.strip() or "updated_desc"
    if normalized_sort in {"wallet_desc", "wallet_asc"}:
        empty_wallet_sort_value = (
            -1 if normalized_sort == "wallet_desc" else 9_223_372_036_854_775_807
        )
        wallet_credits = OrganizationWallet.objects.filter(
            organization_id=Cast(OuterRef("id"), output_field=CharField())
        ).values("credits")[:1]
        queryset = queryset.annotate(
            wallet_credits_sort=Coalesce(
                Subquery(wallet_credits, output_field=BigIntegerField()),
                Value(empty_wallet_sort_value, output_field=BigIntegerField()),
                output_field=BigIntegerField(),
            )
        )

    # member/space 排序必须 annotate 实表，避免读滞后的非规范化字段（ review）
    if normalized_sort == "member_desc":
        queryset = queryset.annotate(live_member_count=Count("members", distinct=True))
    elif normalized_sort == "space_desc":
        queryset = queryset.annotate(live_space_count=Count("spaces", distinct=True))

    sort_map = {
        "updated_desc": ("-updated_at",),
        "updated_asc": ("updated_at",),
        "created_desc": ("-created_at",),
        "created_asc": ("created_at",),
        "name_asc": ("name",),
        "name_desc": ("-name",),
        "space_desc": ("-live_space_count", "-updated_at"),
        "member_desc": ("-live_member_count", "-updated_at"),
        "wallet_desc": ("-wallet_credits_sort", "-updated_at"),
        "wallet_asc": ("wallet_credits_sort", "-updated_at"),
    }
    queryset = queryset.order_by(*sort_map.get(normalized_sort, sort_map["updated_desc"]))
    total = queryset.count()
    pagination = _build_pagination(total, page, page_size)
    organizations = list(
        queryset[pagination["offset"]: pagination["offset"] + page_size]
    )

    owner_name_map = _build_owner_name_map([str(item.owner_id) for item in organizations])
    organization_ids = [str(item.id) for item in organizations]
    active_space_count_map, active_table_count_map = _build_organization_stats(organization_ids)
    member_count_map = _batch_get_organization_member_counts(organization_ids)
    space_count_map = _batch_get_organization_space_counts(organization_ids)
    wallet_balance_map = _batch_get_organization_wallet_balances(organization_ids)

    items = [
        _serialize_organization_item(
            organization,
            owner_name_map=owner_name_map,
            active_space_count_map=active_space_count_map,
            active_table_count_map=active_table_count_map,
            wallet_balance_map=wallet_balance_map,
            member_count_map=member_count_map,
            space_count_map=space_count_map,
        )
        for organization in organizations
    ]

    wt_stats = Organization.objects.aggregate(
        total_organizations=Count("id"),
        default_organizations=Count("id", filter=Q(is_default=True)),
        non_default_organizations=Count("id", filter=Q(is_default=False)),
    )
    # 「有 Space 的组织数」按 Space 实表去重，不读 Organization.space_count
    wt_stats["organizations_with_spaces"] = (
        len(
            set(Workspace.objects.order_by().values_list("organization_id", flat=True))
            | set(Project.objects.order_by().values_list("organization_id", flat=True))
        )
    )
    summary = {
        "filtered_organizations": total,
        **wt_stats,
    }

    return success_response(
        data={
            "organizations": items,
            "total": total,
            "pagination": {
                "page": pagination["page"],
                "page_size": page_size,
                "total_pages": pagination["total_pages"],
            },
            "summary": summary,
        }
    )

@router.get(
    "/organizations/{organization_id}",
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=StaffAuth(),
    tags=["后台空间治理"],
    summary="后台组织详情",
)
def admin_get_organization_detail(request, organization_id: UUID):

    organization = Organization.objects.filter(id=organization_id).first()
    if not organization:
        return not_found_response(_("tabtinspace.organization_not_found"))

    wt_id = str(organization.id)
    owner_name_map = _build_owner_name_map([str(organization.owner_id)])
    active_space_count_map, active_table_count_map = _build_organization_stats([wt_id])
    member_count_map = _batch_get_organization_member_counts([wt_id])
    space_count_map = _batch_get_organization_space_counts([wt_id])
    wallet_balance_map = _batch_get_organization_wallet_balances([wt_id])
    item = _serialize_organization_item(
        organization,
        owner_name_map=owner_name_map,
        active_space_count_map=active_space_count_map,
        active_table_count_map=active_table_count_map,
        wallet_balance_map=wallet_balance_map,
        member_count_map=member_count_map,
        space_count_map=space_count_map,
    )
    return success_response(data=item)


@router.get(
    "/organizations/{organization_id}/control-policy",
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=AdminPermissionAuth("organization:view"),
    tags=["后台空间治理"],
    summary="后台 Organization 控制策略",
)
def admin_get_organization_control_policy(request, organization_id: UUID):
    organization = Organization.objects.filter(id=organization_id).first()
    if not organization:
        return not_found_response(_("tabtinspace.organization_not_found"))

    policy, _ = OrganizationControlPolicy.objects.get_or_create(organization=organization)
    return success_response(data=_serialize_organization_control_policy(policy))


@router.patch(
    "/organizations/{organization_id}/control-policy",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=AdminPermissionAuth("organization:disable"),
    tags=["后台空间治理"],
    summary="更新 Organization 控制策略",
)
def admin_update_organization_control_policy(
    request,
    organization_id: UUID,
    data: AdminOrganizationControlPolicyUpdateRequest,
):
    reason = (data.reason or "").strip()
    if not reason:
        return error_response("VALIDATION_ERROR", "更新团队控制策略必须填写原因", status_code=400)

    with transaction.atomic(using=postgres_app_db_alias()):
        organization = Organization.objects.select_for_update().filter(id=organization_id).first()
        if not organization:
            return not_found_response(_("tabtinspace.organization_not_found"))

        policy, _ = OrganizationControlPolicy.objects.select_for_update().get_or_create(
            organization=organization,
        )
        before_json = _serialize_organization_control_policy(policy)

        field_names = [
            "is_suspended",
            "is_readonly",
            "ai_disabled",
            "resource_write_disabled",
            "app_tool_disabled",
            "invite_disabled",
            "member_join_disabled",
        ]
        update_fields = []
        for field_name in field_names:
            value = getattr(data, field_name)
            if value is not None and getattr(policy, field_name) != value:
                setattr(policy, field_name, value)
                update_fields.append(field_name)

        if data.metadata_json is not None:
            policy.metadata_json = data.metadata_json
            update_fields.append("metadata_json")

        policy.reason_snapshot = reason
        policy.updated_by_admin_account = getattr(request, "admin_account", None)
        update_fields.extend(["reason_snapshot", "updated_by_admin_account", "updated_at"])
        policy.save(update_fields=list(dict.fromkeys(update_fields)))
        after_json = _serialize_organization_control_policy(policy)

        record_admin_sensitive_action(
            request,
            permission_code="organization:disable",
            action="organization.control_policy.update",
            target_type="organization",
            target_id=str(organization_id),
            reason=reason,
            ticket_id=(data.ticket_id or "").strip(),
            before_json=before_json,
            after_json=after_json,
        )
        _record_admin_action(
            request=request,
            action_type="organization_control_policy_update",
            target_type="organization",
            target_id=organization_id,
            organization_id=organization_id,
            message="Organization 控制策略已更新",
            request_payload={
                "reason": reason,
                "ticket_id": (data.ticket_id or "").strip(),
                "idempotency_key": (data.idempotency_key or "").strip(),
            },
            result_payload=after_json,
        )

    return success_response(data=after_json, message="Organization 控制策略已更新")


@router.get(
    "/organizations/{organization_id}/members",
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=StaffAuth(),
    tags=["后台空间治理"],
    summary="后台组织成员列表",
)
def admin_list_organization_members(
    request,
    organization_id: UUID,
    page: int = 1,
    page_size: int = 20,
):

    organization = Organization.objects.filter(id=organization_id).first()
    if not organization:
        return not_found_response(_("tabtinspace.organization_not_found"))

    page = max(page, 1)
    page_size = max(1, min(page_size, 100))
    queryset = OrganizationMember.objects.select_related("user").filter(organization_id=organization_id).order_by("-joined_at")
    total = queryset.count()
    pagination = _build_pagination(total, page, page_size)
    members = list(
        queryset[pagination["offset"]: pagination["offset"] + page_size]
    )
    user_name_map = _build_owner_name_map([str(item.user_id) for item in members])

    member_data = [
        {
            "id": str(member.id),
            "organization_id": str(member.organization_id),
            "user_id": str(member.user_id),
            "user_name": user_name_map.get(str(member.user_id), str(member.user_id)),
            "user_username": getattr(member.user, "username", "") or "",
            "user_email": getattr(member.user, "email", "") or "",
            "user_phone": getattr(member.user, "phone", "") or "",
            "user_status": "active" if getattr(member.user, "is_active", False) else "inactive",
            "role": member.role,
            "joined_at": member.joined_at.isoformat(),
            "invite_source": "",
        }
        for member in members
    ]

    return success_response(
        data={
            "members": member_data,
            "total": total,
            "pagination": {
                "page": pagination["page"],
                "page_size": page_size,
                "total_pages": pagination["total_pages"],
            },
        }
    )


def _admin_organization_or_404(organization_id: UUID) -> Organization | None:
    return Organization.objects.select_related("owner").filter(id=organization_id).first()


def _admin_act_as_owner(organization: Organization):
    """以组织 Owner 身份调用成员/邀请领域服务（运维代操作）。"""
    owner = getattr(organization, "owner", None)
    if owner is None:
        owner = User.objects.filter(id=organization.owner_id).first()
    if owner is None:
        raise HttpError(400, "组织所有者不存在，无法代操作")
    return owner


def _can_expose_invitation_secrets(request) -> bool:
    """仅超级管理员可读取邀请 bearer token / 入组链接。"""
    user = getattr(request, "auth", None)
    return bool(user and getattr(user, "is_superuser", False))


def _serialize_admin_invitation(invitation, *, include_invite_secrets: bool = False) -> dict:
    invite_url = ""
    token = ""
    if include_invite_secrets:
        token = invitation.token or ""
        try:
            from apps.tabtinspace.services.invitation_service import build_invitation_bridge_url

            invite_url = build_invitation_bridge_url(invitation.token)
        except Exception:
            logger.warning(
                "build invitation bridge url failed: invitation=%s",
                getattr(invitation, "id", ""),
                exc_info=True,
            )
    return {
        "id": str(invitation.id),
        "organization_id": str(invitation.organization_id),
        "invited_by": invitation.invited_by or "",
        "invite_type": invitation.invite_type,
        "email": invitation.email or "",
        "invited_user_id": invitation.invited_user_id or "",
        "invite_phone": getattr(invitation, "invite_phone", "") or "",
        "role": invitation.role,
        "token": token,
        "status": invitation.status,
        "expires_at": invitation.expires_at.isoformat() if invitation.expires_at else None,
        "max_uses": invitation.max_uses,
        "use_count": invitation.use_count,
        "created_at": invitation.created_at.isoformat() if invitation.created_at else None,
        "invite_url": invite_url,
    }


@router.post(
    "/organizations/{organization_id}/members",
    response={201: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=SuperuserAuth(),
    tags=["后台空间治理"],
    summary="后台直接添加组织成员（无需对方同意）",
)
def admin_add_organization_member(
    request,
    organization_id: UUID,
    data: AdminMemberAddRequest,
):
    """将已注册用户直接写入 OrganizationMember；未注册不可添加（也不创建邀请）。"""
    from apps.services.common.constants import ORGANIZATION_ASSIGNABLE_ROLES
    from apps.users.auth.validators import is_phone_number
    from apps.tabtinspace.schemas.membership import OrganizationMemberOut

    reason = _ensure_admin_sensitive_reason(data.reason)
    ticket_id = (data.ticket_id or "").strip()
    role = (data.role or "editor").strip() or "editor"
    user_id = (data.user_id or "").strip()
    phone = (data.phone or "").strip()

    organization = _admin_organization_or_404(organization_id)
    if not organization:
        return not_found_response(_("tabtinspace.organization_not_found"))

    if role not in ORGANIZATION_ASSIGNABLE_ROLES:
        return error_response(
            "INVALID_ROLE",
            f"角色 {role} 不合法，可选: {', '.join(sorted(ORGANIZATION_ASSIGNABLE_ROLES))}",
        )

    if bool(user_id) == bool(phone):
        return error_response(
            "INVALID_REQUEST",
            "请提供用户 ID 或手机号之一（不可同时为空或同时填写）",
            status_code=400,
        )

    if phone:
        if not is_phone_number(phone):
            return error_response("INVALID_PHONE", "手机号格式不正确", status_code=400)
        from apps.users.auth.phone import resolve_user_by_phone

        target = resolve_user_by_phone(phone, active_only=True)
        if target is None:
            return error_response(
                "USER_NOT_FOUND_BY_PHONE",
                "该手机号未注册 TabTin，无法直接添加",
                status_code=404,
            )
        user_id = str(target.id)

    owner = _admin_act_as_owner(organization)
    try:
        member = OrganizationService(user=owner).add_member(
            organization_id=organization_id,
            user_id=user_id,
            role=role,
            notification_actor=request.auth,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    payload = OrganizationMemberOut.from_orm(member).dict()
    _record_admin_action(
        request=request,
        action_type="member_add",
        target_type="member",
        target_id=member.id,
        organization_id=organization_id,
        message=f"后台直接添加成员 {user_id} 为 {role}",
        request_payload={
            "user_id": user_id,
            "phone": phone or None,
            "role": role,
            "reason": reason,
            "ticket_id": ticket_id,
        },
        result_payload=payload,
    )
    try:
        record_admin_sensitive_action(
            request,
            permission_code="team_member:add",
            action="organization.member.add",
            target_type="organization_member",
            target_id=str(member.id),
            reason=reason,
            ticket_id=ticket_id,
            before_json=None,
            after_json={"user_id": user_id, "role": role},
        )
    except Exception:
        logger.warning("record_admin_sensitive_action failed for member add", exc_info=True)

    return 201, success_response(data=payload, message="成员已添加")


@router.put(
    "/organizations/{organization_id}/members/{user_id}",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=SuperuserAuth(),
    tags=["后台空间治理"],
    summary="后台更改组织成员角色",
)
def admin_update_organization_member_role(
    request,
    organization_id: UUID,
    user_id: str,
    data: AdminMemberRoleUpdateRequest,
):
    from apps.services.common.constants import ORGANIZATION_ASSIGNABLE_ROLES

    reason = _ensure_admin_sensitive_reason(data.reason)
    ticket_id = (data.ticket_id or "").strip()
    role = (data.role or "").strip()
    target_user_id = (user_id or "").strip()

    organization = _admin_organization_or_404(organization_id)
    if not organization:
        return not_found_response(_("tabtinspace.organization_not_found"))
    # 与 OrganizationService.update_member_role 一致：组织成员新写入仅 editor
    if role not in ORGANIZATION_ASSIGNABLE_ROLES:
        return error_response(
            "INVALID_ROLE",
            f"角色 {role} 不合法，可选: {', '.join(sorted(ORGANIZATION_ASSIGNABLE_ROLES))}",
        )
    if str(organization.owner_id) == target_user_id:
        return error_response("CANNOT_CHANGE_OWNER", "不能变更所有者的角色", status_code=403)

    member = OrganizationMember.objects.filter(
        organization_id=organization_id,
        user_id=target_user_id,
    ).first()
    if not member:
        return not_found_response("成员不存在")

    before_role = member.role
    if before_role == "owner":
        return error_response("CANNOT_CHANGE_OWNER", "不能变更所有者的角色", status_code=403)

    # 复用领域服务：落库 + collab 降权 + on_commit 权限广播 / 预算缓存清理
    owner = _admin_act_as_owner(organization)
    try:
        OrganizationService(user=owner).update_member_role(
            organization_id=organization_id,
            user_id=target_user_id,
            role=role,
            notification_actor=request.auth,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    _record_admin_action(
        request=request,
        action_type="member_role_change",
        target_type="member",
        target_id=member.id,
        organization_id=organization_id,
        message=f"后台变更成员 {target_user_id} 角色 {before_role} → {role}",
        request_payload={
            "user_id": target_user_id,
            "old_role": before_role,
            "new_role": role,
            "reason": reason,
            "ticket_id": ticket_id,
        },
        result_payload={"user_id": target_user_id, "role": role},
    )
    try:
        record_admin_sensitive_action(
            request,
            permission_code="team_member:update_role",
            action="organization.member.role_update",
            target_type="organization_member",
            target_id=str(member.id),
            reason=reason,
            ticket_id=ticket_id,
            before_json={"user_id": target_user_id, "role": before_role},
            after_json={"user_id": target_user_id, "role": role},
        )
    except Exception:
        logger.warning("record_admin_sensitive_action failed for member role update", exc_info=True)

    return success_response(
        data={"user_id": target_user_id, "role": role},
        message="成员角色已更新",
    )


@router.post(
    "/organizations/{organization_id}/members/{user_id}/remove",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=SuperuserAuth(),
    tags=["后台空间治理"],
    summary="后台移除组织成员",
)
def admin_remove_organization_member(
    request,
    organization_id: UUID,
    user_id: str,
    data: AdminSensitiveReasonRequest,
):
    reason = _ensure_admin_sensitive_reason(data.reason)
    ticket_id = (data.ticket_id or "").strip()
    target_user_id = (user_id or "").strip()

    organization = _admin_organization_or_404(organization_id)
    if not organization:
        return not_found_response(_("tabtinspace.organization_not_found"))
    if str(organization.owner_id) == target_user_id:
        return error_response("CANNOT_REMOVE_OWNER", "不能移除所有者", status_code=403)

    member = OrganizationMember.objects.filter(
        organization_id=organization_id,
        user_id=target_user_id,
    ).first()
    if not member:
        return not_found_response("成员不存在")

    before = {"user_id": target_user_id, "role": member.role, "member_id": str(member.id)}
    owner = _admin_act_as_owner(organization)
    service = OrganizationService(user=owner)
    try:
        service.remove_member(
            organization_id=organization_id,
            user_id=target_user_id,
            notification_actor=request.auth,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    _record_admin_action(
        request=request,
        action_type="member_remove",
        target_type="member",
        target_id=organization_id,
        organization_id=organization_id,
        message=f"后台移除成员 {target_user_id}",
        request_payload={
            "user_id": target_user_id,
            "reason": reason,
            "ticket_id": ticket_id,
        },
        result_payload=before,
    )
    try:
        record_admin_sensitive_action(
            request,
            permission_code="team_member:remove",
            action="organization.member.remove",
            target_type="organization_member",
            target_id=before["member_id"],
            reason=reason,
            ticket_id=ticket_id,
            before_json=before,
            after_json={"removed": True},
        )
    except Exception:
        logger.warning("record_admin_sensitive_action failed for member remove", exc_info=True)

    return success_response(data={"user_id": target_user_id, "removed": True}, message="成员已移除")


@router.get(
    "/organizations/{organization_id}/invitations",
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=SuperuserAuth(),
    tags=["后台空间治理"],
    summary="后台待处理邀请列表",
)
def admin_list_organization_invitations(request, organization_id: UUID):
    # 与创建/取消一致：bearer token / invite_url 仅超管可读，避免普通 staff 转发入组链接。
    if not _can_expose_invitation_secrets(request):
        return error_response(
            "ADMIN_SUPERUSER_REQUIRED",
            "仅超级管理员可查看邀请 token 与链接",
            status_code=403,
        )

    organization = _admin_organization_or_404(organization_id)
    if not organization:
        return not_found_response(_("tabtinspace.organization_not_found"))

    from apps.tabtinspace.services.invitation_service import InvitationService

    owner = _admin_act_as_owner(organization)
    try:
        invitations = InvitationService(user=owner).list_invitations(organization_id)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    data = [
        _serialize_admin_invitation(inv, include_invite_secrets=True)
        for inv in invitations
    ]
    return success_response(data={"invitations": data, "total": len(data)})


@router.post(
    "/organizations/{organization_id}/invitations/phone",
    response={201: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=SuperuserAuth(),
    tags=["后台空间治理"],
    summary="后台手机号邀请成员",
)
def admin_create_phone_invitation(
    request,
    organization_id: UUID,
    data: AdminInvitationPhoneCreateRequest,
):
    reason = _ensure_admin_sensitive_reason(data.reason)
    ticket_id = (data.ticket_id or "").strip()
    organization = _admin_organization_or_404(organization_id)
    if not organization:
        return not_found_response(_("tabtinspace.organization_not_found"))

    from apps.tabtinspace.services.invitation_service import InvitationService

    owner = _admin_act_as_owner(organization)
    try:
        invitation = InvitationService(user=owner).create_phone_invitation(
            organization_id=organization_id,
            phone=(data.phone or "").strip(),
            role=(data.role or "editor").strip() or "editor",
            expires_hours=int(data.expires_hours or 72),
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    payload = _serialize_admin_invitation(invitation, include_invite_secrets=True)
    _record_admin_action(
        request=request,
        action_type="invitation_create",
        target_type="invitation",
        target_id=invitation.id,
        organization_id=organization_id,
        message=f"后台手机号邀请 {data.phone} 为 {payload['role']}",
        request_payload={
            "invite_type": "phone",
            "phone": (data.phone or "").strip(),
            "role": payload["role"],
            "reason": reason,
            "ticket_id": ticket_id,
        },
        result_payload=payload,
    )
    return 201, success_response(data=payload, message="邀请已发送")


@router.post(
    "/organizations/{organization_id}/invitations/link",
    response={201: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=SuperuserAuth(),
    tags=["后台空间治理"],
    summary="后台创建邀请链接",
)
def admin_create_link_invitation(
    request,
    organization_id: UUID,
    data: AdminInvitationLinkCreateRequest,
):
    reason = _ensure_admin_sensitive_reason(data.reason)
    ticket_id = (data.ticket_id or "").strip()
    organization = _admin_organization_or_404(organization_id)
    if not organization:
        return not_found_response(_("tabtinspace.organization_not_found"))

    from apps.tabtinspace.services.invitation_service import InvitationService

    owner = _admin_act_as_owner(organization)
    try:
        invitation = InvitationService(user=owner).create_link_invitation(
            organization_id=organization_id,
            role=(data.role or "editor").strip() or "editor",
            max_uses=int(data.max_uses if data.max_uses is not None else -1),
            expires_hours=int(data.expires_hours or 168),
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    payload = _serialize_admin_invitation(invitation, include_invite_secrets=True)
    _record_admin_action(
        request=request,
        action_type="invitation_create",
        target_type="invitation",
        target_id=invitation.id,
        organization_id=organization_id,
        message=f"后台创建邀请链接 (角色: {payload['role']})",
        request_payload={
            "invite_type": "link",
            "role": payload["role"],
            "reason": reason,
            "ticket_id": ticket_id,
        },
        result_payload=payload,
    )
    return 201, success_response(data=payload, message="邀请链接已创建")


@router.post(
    "/organizations/{organization_id}/invitations/direct",
    response={201: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=SuperuserAuth(),
    tags=["后台空间治理"],
    summary="后台用户 ID 直邀成员",
)
def admin_create_direct_invitation(
    request,
    organization_id: UUID,
    data: AdminInvitationDirectCreateRequest,
):
    reason = _ensure_admin_sensitive_reason(data.reason)
    ticket_id = (data.ticket_id or "").strip()
    organization = _admin_organization_or_404(organization_id)
    if not organization:
        return not_found_response(_("tabtinspace.organization_not_found"))

    from apps.tabtinspace.services.invitation_service import InvitationService

    owner = _admin_act_as_owner(organization)
    try:
        invitation = InvitationService(user=owner).create_direct_invitation(
            organization_id=organization_id,
            target_user_id=(data.user_id or "").strip(),
            role=(data.role or "editor").strip() or "editor",
            expires_hours=int(data.expires_hours or 72),
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    payload = _serialize_admin_invitation(invitation, include_invite_secrets=True)
    _record_admin_action(
        request=request,
        action_type="invitation_create",
        target_type="invitation",
        target_id=invitation.id,
        organization_id=organization_id,
        message=f"后台直邀用户 {data.user_id} 为 {payload['role']}",
        request_payload={
            "invite_type": "direct",
            "user_id": (data.user_id or "").strip(),
            "role": payload["role"],
            "reason": reason,
            "ticket_id": ticket_id,
        },
        result_payload=payload,
    )
    return 201, success_response(data=payload, message="邀请已发送")


@router.post(
    "/organizations/{organization_id}/invitations/{invitation_id}/cancel",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=SuperuserAuth(),
    tags=["后台空间治理"],
    summary="后台取消邀请",
)
def admin_cancel_organization_invitation(
    request,
    organization_id: UUID,
    invitation_id: UUID,
    data: AdminSensitiveReasonRequest,
):
    reason = _ensure_admin_sensitive_reason(data.reason)
    ticket_id = (data.ticket_id or "").strip()
    organization = _admin_organization_or_404(organization_id)
    if not organization:
        return not_found_response(_("tabtinspace.organization_not_found"))

    from apps.tabtinspace.services.invitation_service import InvitationService

    owner = _admin_act_as_owner(organization)
    try:
        InvitationService(user=owner).cancel_invitation(organization_id, invitation_id)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    _record_admin_action(
        request=request,
        action_type="invitation_cancel",
        target_type="invitation",
        target_id=invitation_id,
        organization_id=organization_id,
        message=f"后台取消邀请 {invitation_id}",
        request_payload={"invitation_id": str(invitation_id), "reason": reason, "ticket_id": ticket_id},
        result_payload={"cancelled": True},
    )
    return success_response(data={"invitation_id": str(invitation_id), "cancelled": True}, message="邀请已取消")


@router.get(
    "/organizations/{organization_id}/audit-logs",
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=StaffAuth(),
    tags=["后台空间治理"],
    summary="后台组织治理记录",
)
def admin_list_organization_audit_logs(
    request,
    organization_id: UUID,
    action_type: str = "",
    target_type: str = "",
    operator_id: str = "",
    operator_keyword: str = "",
    start_at: str = "",
    end_at: str = "",
    success: bool | None = None,
    page: int = 1,
    page_size: int = 20,
):

    organization = Organization.objects.filter(id=organization_id).first()
    if not organization:
        return not_found_response(_("tabtinspace.organization_not_found"))

    page = max(page, 1)
    page_size = max(1, min(page_size, 100))

    queryset = SpaceAdminActionLog.objects.filter(organization_id=organization_id)
    normalized_action = action_type.strip()
    if normalized_action and normalized_action != "all":
        queryset = queryset.filter(action_type=normalized_action)
    normalized_target = target_type.strip()
    if normalized_target and normalized_target != "all":
        queryset = queryset.filter(target_type=normalized_target)
    normalized_operator = operator_id.strip()
    if normalized_operator:
        queryset = queryset.filter(operator_id=normalized_operator)
    normalized_operator_keyword = operator_keyword.strip()
    if normalized_operator_keyword:
        queryset = queryset.filter(
            Q(operator_id__icontains=normalized_operator_keyword)
            | Q(operator_name__icontains=normalized_operator_keyword)
        )
    if start_at.strip():
        queryset = queryset.filter(created_at__gte=start_at.strip())
    if end_at.strip():
        queryset = queryset.filter(created_at__lte=end_at.strip())
    if success is not None:
        queryset = queryset.filter(success=success)

    queryset = queryset.order_by("-created_at")
    total = queryset.count()
    pagination = _build_pagination(total, page, page_size)
    items = [
        _serialize_admin_action_item(item)
        for item in queryset[pagination["offset"]: pagination["offset"] + page_size]
    ]

    log_stats = SpaceAdminActionLog.objects.filter(
        organization_id=organization_id,
    ).aggregate(
        total_logs=Count("id"),
        success_logs=Count("id", filter=Q(success=True)),
        failed_logs=Count("id", filter=Q(success=False)),
        dry_run_logs=Count("id", filter=Q(dry_run=True)),
    )
    summary = {
        "filtered_logs": total,
        **log_stats,
    }

    return success_response(
        data={
            "items": items,
            "total": total,
            "pagination": {
                "page": pagination["page"],
                "page_size": page_size,
                "total_pages": pagination["total_pages"],
            },
            "summary": summary,
        }
    )

@router.get(
    "/spaces/{space_id}/audit-logs",
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=StaffAuth(),
    tags=["后台空间治理"],
    summary="后台 Space 治理记录",
)
def admin_list_space_audit_logs(
    request,
    space_id: UUID,
    action_type: str = "",
    success: bool | None = None,
    page: int = 1,
    page_size: int = 20,
):

    space = resolve_host(space_id)
    if not space:
        return not_found_response("Space")

    page = max(page, 1)
    page_size = max(1, min(page_size, 100))

    queryset = SpaceAdminActionLog.objects.filter(space_id=space_id)
    normalized_action = action_type.strip()
    if normalized_action and normalized_action != "all":
        queryset = queryset.filter(action_type=normalized_action)
    if success is not None:
        queryset = queryset.filter(success=success)

    queryset = queryset.order_by("-created_at")
    total = queryset.count()
    pagination = _build_pagination(total, page, page_size)
    items = [
        _serialize_admin_action_item(item)
        for item in queryset[pagination["offset"]: pagination["offset"] + page_size]
    ]

    base_summary_qs = SpaceAdminActionLog.objects.filter(space_id=space_id)
    summary = {
        "total_logs": base_summary_qs.count(),
        "filtered_logs": total,
        "success_logs": base_summary_qs.filter(success=True).count(),
        "failed_logs": base_summary_qs.filter(success=False).count(),
        "dry_run_logs": base_summary_qs.filter(dry_run=True).count(),
    }

    return success_response(
        data={
            "items": items,
            "total": total,
            "pagination": {
                "page": pagination["page"],
                "page_size": page_size,
                "total_pages": pagination["total_pages"],
            },
            "summary": summary,
        }
    )

def _list_spaces_core(
    *,
    organization_id: UUID | None = None,
    keyword: str = "",
    status: str = "",
    is_archived: bool | None = None,
    page: int = 1,
    page_size: int = 20,
) -> dict:
    page = max(page, 1)
    page_size = max(1, min(page_size, 100))

    # ：后台列表改查 Workspace（个人执行现场）；status/is_archived 仅 Project 有，忽略于 Workspace。
    queryset = Workspace.objects.select_related("organization").all()
    if organization_id is not None:
        queryset = queryset.filter(organization_id=organization_id)

    normalized_status = status.strip()
    if normalized_status and normalized_status not in SPACE_STATUS_SET:
        raise HttpError(400, "status 参数不合法")

    normalized_keyword = keyword.strip()
    if normalized_keyword:
        # Workspace 不再挂 agent FK；关键词只扫宿主自身与组织名。
        keyword_filter = (
            Q(name__icontains=normalized_keyword)
            | Q(working_dir__icontains=normalized_keyword)
            | Q(organization__name__icontains=normalized_keyword)
        )
        keyword_uuid = _try_parse_uuid(normalized_keyword)
        if keyword_uuid is not None:
            keyword_filter |= Q(id=keyword_uuid) | Q(organization_id=keyword_uuid)
        queryset = queryset.filter(keyword_filter)

    queryset = queryset.order_by("-created_at")

    total = queryset.count()
    pagination = _build_pagination(total, page, page_size)
    spaces = list(queryset[pagination["offset"]: pagination["offset"] + page_size])

    organization_name_map = {
        str(item.id): item.name
        for item in Organization.objects.filter(
            id__in={str(item.organization_id) for item in spaces}
        )
    }
    space_ids = [str(item.id) for item in spaces]
    resource_counts = _build_space_resource_count_map(space_ids)

    space_data = [
        _serialize_space_item(
            s,
            organization_name_map=organization_name_map,
            resource_counts=resource_counts,
        )
        for s in spaces
    ]

    ws_total = Workspace.objects.count()
    pj_agg = Project.objects.aggregate(
        total=Count("id"),
        active=Count("id", filter=Q(is_archived=False)),
        archived=Count("id", filter=Q(is_archived=True)),
    )
    space_stats = {
        "total_spaces": ws_total + int(pj_agg["total"] or 0),
        "active_spaces": ws_total + int(pj_agg["active"] or 0),
        "archived_spaces": int(pj_agg["archived"] or 0),
        "status_active_spaces": ws_total + int(pj_agg["active"] or 0),
        "status_paused_spaces": 0,
        "status_completed_spaces": 0,
    }
    summary = {
        "filtered_spaces": total,
        **space_stats,
    }

    return {
        "spaces": space_data,
        "total": total,
        "pagination": {
            "page": pagination["page"],
            "page_size": page_size,
            "total_pages": pagination["total_pages"],
        },
        "summary": summary,
    }

@router.get(
    "/organizations/{organization_id}/spaces",
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=StaffAuth(),
    tags=["后台空间治理"],
    summary="后台组织 Space 列表",
)
def admin_list_organization_spaces(
    request,
    organization_id: UUID,
    keyword: str = "",
    status: str = "",
    is_archived: bool | None = None,
    page: int = 1,
    page_size: int = 20,
):

    organization = Organization.objects.filter(id=organization_id).first()
    if not organization:
        return not_found_response(_("tabtinspace.organization_not_found"))

    return success_response(
        data=_list_spaces_core(
            organization_id=organization_id,
            keyword=keyword,
            status=status,
            is_archived=is_archived,
            page=page,
            page_size=page_size,
        )
    )


def _extract_context_item_file_size_bytes(ci: ContextItem) -> int | None:
    """从 metadata / TabFiles 尽力解析文件大小；没有则返回 None。"""
    metadata = ci.metadata if isinstance(ci.metadata, dict) else {}
    for key in ("file_size", "size", "content_size", "storage_bytes", "bytes"):
        value = metadata.get(key)
        if value is None or value == "":
            continue
        try:
            size = int(value)
        except (TypeError, ValueError):
            continue
        if size >= 0:
            return size

    item_type = (ci.item_type or "").strip().lower()
    if item_type in {"tabfiles", "file"} and ci.resource_id:
        try:
            from apps.tabtinspace.services.tabfiles_service import TabFilesService

            size = TabFilesService.get_file_size(UUID(str(ci.resource_id).strip()))
            if size is not None and int(size) >= 0:
                return int(size)
        except Exception:
            logger.debug(
                "resolve context item file size failed: id=%s resource_id=%s",
                getattr(ci, "id", ""),
                ci.resource_id,
                exc_info=True,
            )
    return None


# 与 Electron ContextHome 资源浏览器对齐的类型桶（含历史别名）
# 注意：仅收录能经 ResourceBridge / SpaceService 真正 trash→restore 的类型。
# cloud_file / tabfolder 无 registry 模型映射，不得出现在可删列表或删除路由。
_ADMIN_RESOURCE_TYPE_ALIASES: dict[str, tuple[str, ...]] = {
    "tabdata": ("tabdata",),
    "tabdoc": ("tabdoc", "document"),
    "tabslide": ("tabslide",),
    "tabvideo": ("tabvideo",),
    "tabfiles": ("tabfiles", "file"),
}

# 无可靠 trash/restore 路径的类型：组织资源列表直接排除，避免运维点删假成功
_ADMIN_NON_DELETABLE_ITEM_TYPES = frozenset({"cloud_file", "tabfolder"})


def _admin_resource_type_filter(item_type: str) -> Q | None:
    from apps.tabtinspace.schemas.common import normalize_legacy_item_type

    normalized = normalize_legacy_item_type(item_type.strip()) if item_type.strip() else ""
    if not normalized:
        return None
    aliases = _ADMIN_RESOURCE_TYPE_ALIASES.get(normalized)
    if aliases:
        return Q(item_type__in=aliases)
    return Q(item_type=normalized)


def _canonicalize_context_item_type_for_bridge(ci: ContextItem) -> str:
    """将 ContextItem.item_type 规范为 ResourceBridge 查找用的规范名。

    历史行可能仍是 ``document``，而 ``Document.get_context_type()`` 返回 ``tabdoc``。
    若不先改写，``ResourceBridge.on_trash/on_restore`` 会 miss 该行，导致文档本体
    已进回收站、列表 ContextItem 仍活跃（或无法恢复）。
    """
    from apps.tabtinspace.schemas.common import normalize_legacy_item_type

    raw = (ci.item_type or "").strip()
    canonical = normalize_legacy_item_type(raw) or raw
    if canonical and canonical != raw:
        ci.item_type = canonical
        ci.save(update_fields=["item_type", "updated_at"])
    return canonical


@router.get(
    "/organizations/{organization_id}/resources",
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=StaffAuth(),
    tags=["后台空间治理"],
    summary="后台组织资源列表（活跃 ContextItem）",
)
def admin_list_organization_resources(
    request,
    organization_id: UUID,
    item_type: str = "",
    keyword: str = "",
    space_id: str = "",
    created_by: str = "",
    include_archived: bool = False,
    page: int = 1,
    page_size: int = 50,
):
    """列出组织下未进回收站的全部资源（文档 / 表格 / 文件等），供 AdminDash「资源与资产」明细表。"""
    from apps.tabtinspace.constants import REMOVED_CONTEXT_ITEM_TYPES

    organization = Organization.objects.filter(id=organization_id).first()
    if not organization:
        return not_found_response(_("tabtinspace.organization_not_found"))

    if page < 1:
        page = 1
    if page_size < 1 or page_size > 200:
        raise HttpError(400, "page_size 必须在 1-200 之间")

    qs = (
        ContextItem.objects.filter(
            Q(workspace__organization_id=organization_id)
            | Q(project__organization_id=organization_id),
            trashed_at__isnull=True,
        )
        .exclude(status="trashed")
        .exclude(item_type__in=REMOVED_CONTEXT_ITEM_TYPES)
        .exclude(item_type__in=_ADMIN_NON_DELETABLE_ITEM_TYPES)
    )
    if not include_archived:
        qs = qs.filter(is_archived=False)

    # 筛选项：取当前组织活跃资源上出现过的空间 / 创建人（不受列表筛选影响）
    facet_qs = qs
    workspace_rows = list(
        facet_qs.exclude(workspace_id__isnull=True)
        .values("workspace_id", "workspace__name")
        .annotate(count=Count("id"))
        .order_by("workspace__name")
    )
    project_rows = list(
        facet_qs.exclude(project_id__isnull=True)
        .values("project_id", "project__name")
        .annotate(count=Count("id"))
        .order_by("project__name")
    )
    creator_rows = list(
        facet_qs.exclude(created_by_id__isnull=True)
        .values("created_by_id")
        .annotate(count=Count("id"))
        .order_by("-count")
    )
    creator_ids = [str(row["created_by_id"]) for row in creator_rows if row.get("created_by_id")]
    creator_name_map = _build_owner_name_map(creator_ids)
    filter_options = {
        "spaces": [
            {
                "id": str(row["workspace_id"]),
                "name": row.get("workspace__name") or str(row["workspace_id"]),
                "count": int(row.get("count") or 0),
            }
            for row in workspace_rows
            if row.get("workspace_id")
        ] + [
            {
                "id": str(row["project_id"]),
                "name": row.get("project__name") or str(row["project_id"]),
                "count": int(row.get("count") or 0),
            }
            for row in project_rows
            if row.get("project_id")
        ],
        "creators": [
            {
                "id": str(row["created_by_id"]),
                "name": creator_name_map.get(str(row["created_by_id"]), "")
                or str(row["created_by_id"])[:8],
                "count": int(row.get("count") or 0),
            }
            for row in creator_rows
            if row.get("created_by_id")
        ],
    }

    keyword_normalized = keyword.strip()
    if keyword_normalized:
        qs = qs.filter(title__icontains=keyword_normalized)

    space_uuid = _try_parse_uuid(space_id)
    if space_id.strip() and space_uuid is None:
        raise HttpError(400, "space_id 非法，必须是 UUID")
    if space_uuid is not None:
        qs = qs.filter(Q(workspace_id=space_uuid) | Q(project_id=space_uuid))

    created_by_uuid = _try_parse_uuid(created_by)
    if created_by.strip() and created_by_uuid is None:
        raise HttpError(400, "created_by 非法，必须是 UUID")
    if created_by_uuid is not None:
        qs = qs.filter(created_by_id=created_by_uuid)

    # 类型 Tab 计数：受关键词 / 空间 / 创建人影响，不受当前类型 Tab 影响
    by_type_raw = list(
        qs.values("item_type")
        .annotate(count=Count("id"))
        .order_by("-count", "item_type")
    )
    by_type_map: dict[str, int] = {}
    for row in by_type_raw:
        raw_type = (row.get("item_type") or "").strip()
        count = int(row.get("count") or 0)
        bucket = raw_type
        for canonical, aliases in _ADMIN_RESOURCE_TYPE_ALIASES.items():
            if raw_type in aliases or raw_type == canonical:
                bucket = canonical
                break
        by_type_map[bucket] = by_type_map.get(bucket, 0) + count
    by_type = [
        {"item_type": key, "count": value}
        for key, value in sorted(by_type_map.items(), key=lambda item: (-item[1], item[0]))
    ]

    type_filter = _admin_resource_type_filter(item_type)
    if type_filter is not None:
        qs = qs.filter(type_filter)

    total = qs.count()
    offset = (page - 1) * page_size
    items = list(
        qs.select_related("workspace", "project", "created_by", "updated_by").order_by("-updated_at", "-created_at")[
            offset : offset + page_size
        ]
    )

    name_ids: list[str] = []
    for ci in items:
        if ci.created_by_id:
            name_ids.append(str(ci.created_by_id))
        if ci.updated_by_id:
            name_ids.append(str(ci.updated_by_id))
    name_map = _build_owner_name_map(name_ids)

    result = []
    for ci in items:
        host = ci.workspace or ci.project
        host_id = ci.workspace_id or ci.project_id
        created_by_id = str(ci.created_by_id) if ci.created_by_id else None
        updated_by_id = str(ci.updated_by_id) if ci.updated_by_id else None
        file_size_bytes = _extract_context_item_file_size_bytes(ci)
        result.append(
            {
                "id": str(ci.id),
                "resource_id": ci.resource_id or None,
                "item_type": ci.item_type,
                "title": ci.title or "",
                "space_id": str(host_id) if host_id else None,
                "space_name": getattr(host, "name", None) or None,
                "organization_id": str(organization_id),
                "is_archived": bool(ci.is_archived),
                "status": ci.status or "",
                "created_by": created_by_id,
                "created_by_name": name_map.get(created_by_id or "", "") or None,
                "updated_by": updated_by_id,
                "updated_by_name": name_map.get(updated_by_id or "", "") or None,
                "created_at": ci.created_at.isoformat() if ci.created_at else None,
                "updated_at": ci.updated_at.isoformat() if ci.updated_at else None,
                "file_size_bytes": file_size_bytes,
            }
        )

    return success_response(
        data={
            "items": result,
            "total": total,
            "page": page,
            "page_size": page_size,
            "by_type": by_type,
            "filter_options": filter_options,
        }
    )

@router.get(
    "/spaces",
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse},
    auth=StaffAuth(),
    tags=["后台空间治理"],
    summary="后台 Space 列表",
)
def admin_list_spaces(
    request,
    organization_id: str = "",
    keyword: str = "",
    status: str = "",
    is_archived: bool | None = None,
    page: int = 1,
    page_size: int = 20,
):

    organization_uuid = None
    if organization_id.strip():
        organization_uuid = _parse_uuid_or_http_error(organization_id, "organization_id")

    return success_response(
        data=_list_spaces_core(
            organization_id=organization_uuid,
            keyword=keyword,
            status=status,
            is_archived=is_archived,
            page=page,
            page_size=page_size,
        )
    )

@router.get(
    "/spaces/{space_id}",
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=StaffAuth(),
    tags=["后台空间治理"],
    summary="后台 Space 详情",
)
def admin_get_space_detail(request, space_id: UUID):

    space = resolve_host(space_id)
    if not space:
        return not_found_response("Space")

    organization_name_map = {
        str(space.organization_id): Organization.objects.filter(id=space.organization_id)
        .values_list("name", flat=True)
        .first()
    }
    resource_counts = _build_space_resource_count_map([str(space.id)])

    return success_response(
        data=_serialize_space_item(
            space,
            organization_name_map=organization_name_map,
            resource_counts=resource_counts,
        )
    )

@router.get(
    "/spaces/{space_id}/stats",
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=StaffAuth(),
    tags=["后台空间治理"],
    summary="后台 Space 统计",
)
def admin_get_space_stats(request, space_id: UUID):

    space = resolve_host(space_id)
    if not space:
        return not_found_response("Space")

    context_item_count = ContextItem.objects.filter(
        Q(workspace_id=space_id) | Q(project_id=space_id)
    ).count()
    active_context_item_count = ContextItem.objects.filter(
        Q(workspace_id=space_id) | Q(project_id=space_id),
        is_archived=False,
        trashed_at__isnull=True,
    ).count()

    return success_response(
        data={
            "space_id": str(space.id),
            "space_name": space.name,
            "status": getattr(space, "status", "active") or "active",
            "is_archived": bool(getattr(space, "is_archived", False)),
            "table_count": 0,
            "active_table_count": 0,
            "total_records": 0,
            "context_item_count": context_item_count,
            "active_context_item_count": active_context_item_count,
            "created_at": space.created_at.isoformat(),
            "updated_at": space.updated_at.isoformat(),
        }
    )

@router.get(
    "/spaces/{space_id}/apps",
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=StaffAuth(),
    tags=["后台空间治理"],
    summary="后台 Space 应用开关",
)
def admin_get_space_apps(request, space_id: UUID):

    space = resolve_host(space_id)
    if not space:
        return not_found_response("Space")

    all_settings = SpaceAppSettings.objects.filter(workspace_id=space_id)
    user_count = all_settings.count()
    disabled_counter: dict[str, int] = {}
    for s in all_settings:
        for app_id in (s.disabled_apps or []):
            disabled_counter[app_id] = disabled_counter.get(app_id, 0) + 1

    apps = [
        {
            "id": app.id,
            "name": app.name,
            "icon": app.icon,
            "can_create": app.can_create,
            "searchable": app.searchable,
            "enabled": app.id not in disabled_counter,
            "disabled_by_count": disabled_counter.get(app.id, 0),
            "order": app.order,
        }
        for app in list_apps()
    ]

    return success_response(
        data={
            "apps": apps,
            "disabled_apps": list(disabled_counter.keys()),
            "user_settings_count": user_count,
        }
    )

@router.post(
    "/organizations",
    response={201: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse},
    auth=SuperuserAuth(),
    tags=["后台空间治理"],
    summary="后台创建组织",
)
def admin_create_organization(request, data: AdminOrganizationCreateRequest):

    name = (data.name or "").strip()
    if not name:
        return error_response("VALIDATION_ERROR", "组织名称不能为空")

    service = OrganizationService(user=request.auth)
    try:
        organization = service.create_organization(
            name=name,
            description=data.description,
            icon=data.icon,
            settings=data.settings,
            enforce_owner_limit=False,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    org_id = str(organization.id)
    owner_name_map = _build_owner_name_map([str(organization.owner_id)])
    active_space_count_map, active_table_count_map = _build_organization_stats([org_id])
    organization_data = _serialize_organization_item(
        organization,
        owner_name_map=owner_name_map,
        active_space_count_map=active_space_count_map,
        active_table_count_map=active_table_count_map,
        member_count_map=_batch_get_organization_member_counts([org_id]),
        space_count_map=_batch_get_organization_space_counts([org_id]),
    )
    _record_admin_action(
        request=request,
        action_type="organization_create",
        target_type="organization",
        target_id=organization.id,
        organization_id=organization.id,
        message=_("ws_admin.organization_created"),
        request_payload={
            "name": name,
            "description": data.description,
            "icon": data.icon,
            "settings": data.settings,
        },
        result_payload={"organization_id": str(organization.id)},
    )
    return 201, success_response(data=organization_data, message=_("ws_admin.organization_created"))

@router.put(
    "/organizations/{organization_id}",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=SuperuserAuth(),
    tags=["后台空间治理"],
    summary="后台更新组织",
)
def admin_update_organization(request, organization_id: UUID, data: AdminOrganizationUpdateRequest):
    organization = Organization.objects.filter(id=organization_id).first()
    if not organization:
        return not_found_response(_("tabtinspace.organization_not_found"))

    reason = (data.reason or "").strip()
    if not reason:
        return error_response("VALIDATION_ERROR", "更新组织必须填写原因", status_code=400)
    ticket_id = (data.ticket_id or "").strip()

    if data.name is not None:
        try:
            organization.name = OrganizationService.assert_organization_name_available(
                data.name,
                exclude_id=organization.id,
            )
        except ServiceError as e:
            _record_admin_action(
                request=request,
                action_type="organization_update",
                target_type="organization",
                target_id=organization_id,
                organization_id=organization_id,
                success=False,
                message=_("ws_admin.organization_update_failed"),
                error_message=e.message,
                request_payload={"name": data.name, "reason": reason, "ticket_id": ticket_id},
            )
            return error_response(e.code, e.message, status_code=e.status)
    if data.description is not None:
        organization.description = data.description
    if data.icon is not None:
        organization.icon = data.icon
    if data.settings is not None:
        try:
            # settings 整包替换会冲掉未提交键；后台代操作按合并语义写入
            merged_settings = {**(organization.settings or {}), **(data.settings or {})}
            organization.settings = OrganizationService._normalize_public_logo_settings(merged_settings)
        except ServiceError as e:
            return error_response(e.code, e.message, status_code=e.status)

    organization.save()

    def _notify_organization_updated() -> None:
        OrganizationService.broadcast_organization_updated(organization)

    transaction.on_commit(_notify_organization_updated, using=postgres_app_db_alias())

    org_id = str(organization.id)
    owner_name_map = _build_owner_name_map([str(organization.owner_id)])
    active_space_count_map, active_table_count_map = _build_organization_stats([org_id])
    organization_data = _serialize_organization_item(
        organization,
        owner_name_map=owner_name_map,
        active_space_count_map=active_space_count_map,
        active_table_count_map=active_table_count_map,
        member_count_map=_batch_get_organization_member_counts([org_id]),
        space_count_map=_batch_get_organization_space_counts([org_id]),
    )
    _record_admin_action(
        request=request,
        action_type="organization_update",
        target_type="organization",
        target_id=organization.id,
        organization_id=organization.id,
        message=_("ws_admin.organization_updated"),
        request_payload={
            "name": data.name,
            "description": data.description,
            "icon": data.icon,
            "settings": data.settings,
            "reason": reason,
            "ticket_id": ticket_id,
        },
        result_payload={"organization_id": str(organization.id)},
    )
    return success_response(data=organization_data, message=_("ws_admin.organization_updated"))

@router.post(
    "/organizations/{organization_id}/delete",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=SuperuserAuth(),
    tags=["后台空间治理"],
    summary="后台删除组织（支持 dry run）",
)
def admin_delete_organization(request, organization_id: UUID, data: AdminOrganizationDeleteRequest):
    organization = Organization.objects.filter(id=organization_id).first()
    if not organization:
        return not_found_response(_("tabtinspace.organization_not_found"))
    if organization.is_default or getattr(organization, 'type', None) == 'personal':
        _record_admin_action(
            request=request,
            action_type="organization_delete",
            target_type="organization",
            target_id=organization_id,
            organization_id=organization_id,
            success=False,
            dry_run=data.dry_run,
            message=_("ws_admin.organization_delete_failed"),
            error_message=_("ws_admin.default_organization_no_delete"),
        )
        return error_response("VALIDATION_ERROR", "个人身份不允许删除")

    reason = (data.reason or "").strip()
    ticket_id = (data.ticket_id or "").strip()
    if not data.dry_run and not reason:
        return error_response("VALIDATION_ERROR", "解散组织必须填写原因", status_code=400)

    impact = _count_organization_impact(organization_id)
    if data.dry_run:
        _record_admin_action(
            request=request,
            action_type="organization_delete",
            target_type="organization",
            target_id=organization_id,
            organization_id=organization_id,
            dry_run=True,
            message=_("ws_admin.organization_delete_precheck_done"),
            request_payload={"force": data.force, "reason": reason, "ticket_id": ticket_id},
            result_payload={"impact": impact},
        )
        return success_response(
            data={
                "dry_run": True,
                "organization_id": str(organization_id),
                "impact": impact,
            },
            message=_("ws_admin.organization_delete_precheck_done"),
        )

    if (not data.force) and (impact["space_count"] > 0 or impact["total_resources"] > 0):
        _record_admin_action(
            request=request,
            action_type="organization_delete",
            target_type="organization",
            target_id=organization_id,
            organization_id=organization_id,
            success=False,
            message=_("ws_admin.organization_delete_failed"),
            error_message=_("ws_admin.organization_has_resources_no_force"),
            request_payload={"force": data.force, "reason": reason, "ticket_id": ticket_id},
            result_payload={"impact": impact},
        )
        return error_response(
            "VALIDATION_ERROR",
            "组织下仍有 Space 或资源，请先执行 dry_run 确认影响后传 force=true",
            status_code=400,
            data=impact,
        )

    with transaction.atomic(using=postgres_app_db_alias()):
        OrganizationService.force_delete_organization(organization)

    _record_admin_action(
        request=request,
        action_type="organization_delete",
        target_type="organization",
        target_id=organization_id,
        organization_id=organization_id,
        dry_run=False,
        message=_("ws_admin.organization_deleted"),
        request_payload={"force": data.force, "reason": reason, "ticket_id": ticket_id},
        result_payload={"impact": impact},
    )

    return success_response(
        data={
            "organization_id": str(organization_id),
            "force": data.force,
            "impact": impact,
        },
        message=_("ws_admin.organization_deleted"),
    )


@router.post(
    "/organizations/{organization_id}/transfer-ownership",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=SuperuserAuth(),
    tags=["后台空间治理"],
    summary="后台代转让组织 Owner",
)
def admin_transfer_organization_ownership(
    request,
    organization_id: UUID,
    data: AdminOrganizationTransferOwnershipRequest,
):
    reason = (data.reason or "").strip()
    if not reason:
        return error_response("VALIDATION_ERROR", "转让 Owner 必须填写原因", status_code=400)
    ticket_id = (data.ticket_id or "").strip()
    new_owner_user_id = (data.new_owner_user_id or "").strip()
    if not new_owner_user_id:
        return error_response("VALIDATION_ERROR", "必须指定新 Owner 用户 ID", status_code=400)

    organization = Organization.objects.filter(id=organization_id).first()
    if not organization:
        return not_found_response(_("tabtinspace.organization_not_found"))

    previous_owner_id = str(organization.owner_id)
    service = OrganizationService(user=request.auth)
    try:
        service.transfer_ownership(
            organization_id,
            new_owner_user_id,
            as_staff=True,
            notification_actor=request.auth,
        )
    except ServiceError as e:
        _record_admin_action(
            request=request,
            action_type="ownership_transfer",
            target_type="organization",
            target_id=organization_id,
            organization_id=organization_id,
            success=False,
            message="后台代转让 Owner 失败",
            error_message=e.message,
            request_payload={
                "new_owner_user_id": new_owner_user_id,
                "previous_owner_id": previous_owner_id,
                "reason": reason,
                "ticket_id": ticket_id,
            },
        )
        return error_response(e.code, e.message, status_code=e.status)

    organization.refresh_from_db()
    owner_name_map = _build_owner_name_map([str(organization.owner_id)])
    active_space_count_map, active_table_count_map = _build_organization_stats([str(organization.id)])
    organization_data = _serialize_organization_item(
        organization,
        owner_name_map=owner_name_map,
        active_space_count_map=active_space_count_map,
        active_table_count_map=active_table_count_map,
    )
    _record_admin_action(
        request=request,
        action_type="ownership_transfer",
        target_type="organization",
        target_id=organization_id,
        organization_id=organization_id,
        message="后台代转让 Owner 成功",
        request_payload={
            "new_owner_user_id": new_owner_user_id,
            "previous_owner_id": previous_owner_id,
            "reason": reason,
            "ticket_id": ticket_id,
        },
        result_payload={
            "organization_id": str(organization_id),
            "owner_id": str(organization.owner_id),
        },
    )
    return success_response(data=organization_data, message="组织 Owner 已转让")

@router.post(
    "/spaces",
    response={201: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=SuperuserAuth(),
    tags=["后台空间治理"],
    summary="后台创建 Space",
)
def admin_create_space(request, data: AdminSpaceCreateRequest):
    organization_uuid = _parse_uuid_or_http_error(data.organization_id, "organization_id")
    organization = Organization.objects.filter(id=organization_uuid).first()
    if not organization:
        return not_found_response(_("tabtinspace.organization_not_found"))

    name = (data.name or "").strip()
    if not name:
        return error_response("VALIDATION_ERROR", "Space 名称不能为空")

    if data.status and data.status not in SPACE_STATUS_SET:
        return error_response("VALIDATION_ERROR", "Space 状态不合法")

    try:
        from apps.tabtinspace.services.agent_service import AgentService
        with transaction.atomic(using=postgres_app_db_alias()):
            agent = Agent.objects.create(
                organization=organization,
                owner_user=organization.owner,
                name=name,
                type='bot',
                agent_config=AgentService.DEFAULT_AGENT_CONFIG,
            )
            from apps.tabtinspace.models import Device
            device = (
                Device.objects.filter(
                    organization=organization,
                    user_id=organization.owner_id,
                )
                .order_by("-updated_at", "-created_at")
                .first()
            )
            if device is None:
                device = Device.objects.create(
                    organization=organization,
                    user_id=organization.owner_id,
                    name=f"admin-provision-{organization.id}",
                    device_type="electron",
                    fingerprint=f"admin-{organization.id}-{agent.id}",
                )
            # ：现场不挂 Agent FK；Admin 创建后写 SpaceMembership
            space = Workspace.objects.create(
                organization=organization,
                device=device,
                name=name,
                working_dir=f"/tmp/tabtin-admin/{organization.id}/{agent.id}",
                normalized_working_dir=f"/tmp/tabtin-admin/{organization.id}/{agent.id}",
                kind=Workspace.Kind.STANDARD,
                created_by_id=organization.owner_id,
            )
            # ：用户 owner membership 是 check_space_permission 真源；
            # 仅挂 Agent membership 无法让组织 owner 通过写操作权限。
            from apps.tabtinspace.services.membership_utils import ensure_user_membership
            ensure_user_membership(space, organization.owner_id, "owner")
            SpaceMembership.objects.get_or_create(
                workspace_id=space.id,
                agent_id=agent.id,
                defaults={"role": "owner", "is_active": True, "permissions": {}},
            )
    except IntegrityError:
        return error_response("VALIDATION_ERROR", "同一组织下 Space 名称不能重复")

    organization_name_map = {str(organization.id): organization.name}
    resource_counts = _build_space_resource_count_map([str(space.id)])

    space_data = _serialize_space_item(
        space,
        organization_name_map=organization_name_map,
        resource_counts=resource_counts,
    )
    _record_admin_action(
        request=request,
        action_type="space_create",
        target_type="space",
        target_id=space.id,
        organization_id=space.organization_id,
        space_id=space.id,
        message="Space 创建成功",
        request_payload={
            "organization_id": str(organization.id),
            "name": name,
            "description": data.description,
            "status": data.status,
            "order": data.order,
        },
        result_payload={"space_id": str(space.id)},
    )

    return 201, success_response(
        data=space_data,
        message="Space 创建成功",
    )

@router.put(
    "/spaces/{space_id}",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=SuperuserAuth(),
    tags=["后台空间治理"],
    summary="后台更新 Space",
)
def admin_update_space(request, space_id: UUID, data: AdminSpaceUpdateRequest):
    space = resolve_host(space_id)
    if not space:
        return not_found_response("Space")

    if data.name is not None:
        normalized_name = data.name.strip()
        if not normalized_name:
            _record_admin_action(
                request=request,
                action_type="space_update",
                target_type="space",
                target_id=space_id,
                organization_id=space.organization_id,
                space_id=space.id,
                success=False,
                message="Space 更新失败",
                error_message="Space 名称不能为空",
                request_payload={"name": data.name},
            )
            return error_response("VALIDATION_ERROR", "Space 名称不能为空")
        space.name = normalized_name
    # ：Workspace/Project 字段子集不同，只写宿主实际存在的字段
    for attr, value in (
        ("description", data.description),
        ("icon", data.icon),
        ("color", data.color),
        ("order", data.order),
        ("is_archived", data.is_archived),
    ):
        if value is not None and hasattr(space, attr):
            setattr(space, attr, value)
    if data.status is not None:
        if data.status not in SPACE_STATUS_SET:
            _record_admin_action(
                request=request,
                action_type="space_update",
                target_type="space",
                target_id=space_id,
                organization_id=space.organization_id,
                space_id=space.id,
                success=False,
                message="Space 更新失败",
                error_message="Space 状态不合法",
                request_payload={"status": data.status},
            )
            return error_response("VALIDATION_ERROR", "Space 状态不合法")
        if hasattr(space, "status"):
            space.status = data.status
    if data.start_date is not None and hasattr(space, "start_date"):
        space.start_date = _parse_optional_date(data.start_date, "start_date")
    if data.end_date is not None and hasattr(space, "end_date"):
        space.end_date = _parse_optional_date(data.end_date, "end_date")

    try:
        space.save()
    except IntegrityError:
        _record_admin_action(
            request=request,
            action_type="space_update",
            target_type="space",
            target_id=space_id,
            organization_id=space.organization_id,
            space_id=space.id,
            success=False,
            message="Space 更新失败",
            error_message=_("ws_admin.space_name_duplicate"),
        )
        return error_response("VALIDATION_ERROR", "同一组织下 Space 名称不能重复")

    organization_name_map = {
        str(space.organization_id): Organization.objects.filter(id=space.organization_id)
        .values_list("name", flat=True)
        .first()
    }
    resource_counts = _build_space_resource_count_map([str(space.id)])
    space_data = _serialize_space_item(
        space,
        organization_name_map=organization_name_map,
        resource_counts=resource_counts,
    )
    _record_admin_action(
        request=request,
        action_type="space_update",
        target_type="space",
        target_id=space.id,
        organization_id=space.organization_id,
        space_id=space.id,
        message="Space 更新成功",
        request_payload={
            "name": data.name,
            "description": data.description,
            "status": data.status,
            "is_archived": data.is_archived,
            "order": data.order,
        },
        result_payload={"space_id": str(space.id)},
    )
    return success_response(
        data=space_data,
        message="Space 更新成功",
    )

@router.post(
    "/spaces/{space_id}/archive",
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=SuperuserAuth(),
    tags=["后台空间治理"],
    summary="后台归档 Space",
)
def admin_archive_space(request, space_id: UUID):
    space = resolve_host(space_id)
    if not space:
        return not_found_response("Space")

    if not hasattr(space, "is_archived"):
        return error_response("VALIDATION_ERROR", "该宿主不支持归档（Workspace 无归档态）")
    space.is_archived = True
    space.save(update_fields=["is_archived", "updated_at"])
    _record_admin_action(
        request=request,
        action_type="space_archive",
        target_type="space",
        target_id=space.id,
        organization_id=space.organization_id,
        space_id=space.id,
        message="Space 已归档",
    )
    return success_response(message="Space 已归档")

@router.post(
    "/spaces/{space_id}/restore",
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=SuperuserAuth(),
    tags=["后台空间治理"],
    summary="后台恢复 Space",
)
def admin_restore_space(request, space_id: UUID):
    space = resolve_host(space_id)
    if not space:
        return not_found_response("Space")

    if not hasattr(space, "is_archived"):
        return error_response("VALIDATION_ERROR", "该宿主不支持恢复归档（Workspace 无归档态）")
    space.is_archived = False
    space.save(update_fields=["is_archived", "updated_at"])
    _record_admin_action(
        request=request,
        action_type="space_restore",
        target_type="space",
        target_id=space.id,
        organization_id=space.organization_id,
        space_id=space.id,
        message="Space 已恢复",
    )
    return success_response(message="Space 已恢复")

@router.post(
    "/spaces/{space_id}/delete",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=SuperuserAuth(),
    tags=["后台空间治理"],
    summary="后台删除 Space（支持 dry run）",
)
def admin_delete_space(request, space_id: UUID, data: AdminSpaceDeleteRequest):
    space = resolve_host(space_id)
    if not space:
        return not_found_response("Space")

    impact = _count_space_impact(space_id)
    if data.dry_run:
        _record_admin_action(
            request=request,
            action_type="space_delete",
            target_type="space",
            target_id=space.id,
            organization_id=space.organization_id,
            space_id=space.id,
            dry_run=True,
            message="Space 删除预检完成",
            request_payload={"force": data.force},
            result_payload={"impact": impact},
        )
        return success_response(
            data={
                "dry_run": True,
                "space_id": str(space_id),
                "impact": impact,
            },
            message="Space 删除预检完成",
        )

    with transaction.atomic(using=postgres_app_db_alias()):
        OrganizationService.delete_space_resources([space_id])
        Workspace.objects.filter(id=space_id).delete()
        Project.objects.filter(id=space_id).delete()

    _record_admin_action(
        request=request,
        action_type="space_delete",
        target_type="space",
        target_id=space.id,
        organization_id=space.organization_id,
        space_id=space.id,
        dry_run=False,
        message="Space 删除成功",
        request_payload={"force": data.force},
        result_payload={"impact": impact},
    )

    return success_response(
        data={
            "space_id": str(space_id),
            "force": data.force,
            "impact": impact,
        },
        message="Space 删除成功",
    )

# ==================== 组织钱包管理（Admin） ====================

@router.get(
    "/organizations/{organization_id}/wallet",
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=StaffAuth(),
    tags=["后台空间治理"],
    summary="后台组织钱包详情",
)
def admin_get_organization_wallet(request, organization_id: UUID):

    organization = Organization.objects.filter(id=organization_id).first()
    if not organization:
        return not_found_response(_("tabtinspace.organization_not_found"))

    # 与客户端 / cash-wallet 一致：未开通时 get_or_create，避免后台显示「—」而客户端显示 0
    from apps.users.wallet.services.organization_wallet_service import OrganizationWalletService

    wallet = OrganizationWalletService().get_or_create_wallet(str(organization_id))
    return success_response(
        data={"wallet": _serialize_wallet_info(wallet), "organization_id": str(organization_id)}
    )


@router.get(
    "/organizations/{organization_id}/cash-wallet",
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=StaffAuth(),
    tags=["后台空间治理"],
    summary="后台组织人民币钱包详情",
)
def admin_get_organization_cash_wallet(request, organization_id: UUID):
    organization = Organization.objects.filter(id=organization_id).first()
    if not organization:
        return not_found_response(_("tabtinspace.organization_not_found"))
    service = OrganizationCashWalletService()
    wallet = service.get_or_create_wallet(str(organization_id))
    txs = list(wallet.transactions.order_by("-created_at")[:20])
    op_ids = {tx.operator_user_id for tx in txs if tx.operator_user_id}
    op_map: dict[str, str] = {}
    if op_ids:
        for u in User.objects.filter(id__in=op_ids).only("id", "nickname", "username", "phone"):
            op_map[str(u.id)] = u.nickname or u.username or u.phone or str(u.id)[:8]
    return success_response(data={
        "wallet": _serialize_cash_wallet(wallet),
        "transactions": [
            _serialize_cash_transaction(tx, op_map.get(tx.operator_user_id or "", ""))
            for tx in txs
        ],
    })


@router.get(
    "/organizations/{organization_id}/cash-wallet/transactions",
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=StaffAuth(),
    tags=["后台空间治理"],
    summary="后台组织人民币钱包流水（分页）",
)
def admin_list_organization_cash_wallet_transactions(
    request,
    organization_id: UUID,
    transaction_type: Optional[str] = None,
    limit: int = 20,
    offset: int = 0,
):
    """对齐 Electron 账单中心「现金钱包」流水。"""
    organization = Organization.objects.filter(id=organization_id).first()
    if not organization:
        return not_found_response(_("tabtinspace.organization_not_found"))

    limit = min(max(int(limit or 20), 1), 100)
    offset = max(int(offset or 0), 0)
    type_filter = (transaction_type or "").strip() or None

    from apps.users.wallet.models import CashWalletTransaction

    service = OrganizationCashWalletService()
    wallet = service.get_or_create_wallet(str(organization_id))
    qs = CashWalletTransaction.objects.filter(organization_id=str(organization_id))
    if type_filter:
        qs = qs.filter(transaction_type=type_filter)
    total = qs.count()
    txs = list(qs.order_by("-created_at")[offset : offset + limit])
    op_ids = {tx.operator_user_id for tx in txs if tx.operator_user_id}
    op_map: dict[str, str] = {}
    if op_ids:
        for u in User.objects.filter(id__in=op_ids).only("id", "nickname", "username", "phone"):
            op_map[str(u.id)] = u.nickname or u.username or u.phone or str(u.id)[:8]

    membership_order_ids = {
        str(tx.related_order_id)
        for tx in txs
        if tx.transaction_type in _MEMBERSHIP_CASH_TX_TYPES and tx.related_order_id
    }
    membership_orders: dict[str, Any] = {}
    if membership_order_ids:
        from apps.services.payment.models import PaymentOrder

        membership_orders = {
            str(order.id): order
            for order in PaymentOrder.objects.filter(id__in=membership_order_ids)
        }

    serialized_txs = []
    for tx in txs:
        membership_summary = None
        if tx.transaction_type in _MEMBERSHIP_CASH_TX_TYPES:
            membership_summary = _build_membership_cash_summary(
                order=membership_orders.get(str(tx.related_order_id or "")),
                metadata=tx.metadata or {},
            )
        serialized_txs.append(
            _serialize_cash_transaction(
                tx,
                op_map.get(tx.operator_user_id or "", ""),
                membership_summary=membership_summary,
            )
        )

    return success_response(
        data={
            "organization_id": str(organization_id),
            "wallet": _serialize_cash_wallet(wallet),
            "balance_cny": str(wallet.balance_cny),
            "frozen_cny": str(wallet.frozen_cny),
            "available_cny": str(wallet.get_available_cny()),
            "total": total,
            "transactions": serialized_txs,
        }
    )


@router.post(
    "/organizations/{organization_id}/cash-wallet/recharge",
    response={
        200: dict,
        400: ErrorResponse,
        401: ErrorResponse,
        403: ErrorResponse,
        404: ErrorResponse,
        409: ErrorResponse,
    },
    auth=SuperuserAuth(),
    tags=["后台空间治理"],
    summary="后台组织人民币钱包充值",
)
def admin_recharge_organization_cash_wallet(
    request,
    organization_id: UUID,
    data: AdminOrganizationCashRechargeRequest,
):
    organization = Organization.objects.filter(id=organization_id).first()
    if not organization:
        return not_found_response(_("tabtinspace.organization_not_found"))
    reason = (data.reason or "").strip()
    ticket_id = generate_admin_operation_reference(AdminOperationKind.CASH_RECHARGE)
    if not reason:
        return error_response("VALIDATION_ERROR", "请填写充值原因")
    try:
        amount_cny = Decimal(str(data.amount_cny))
    except Exception:
        return error_response("VALIDATION_ERROR", "充值金额格式非法")
    if amount_cny <= 0:
        return error_response("VALIDATION_ERROR", "充值金额必须大于 0")
    if amount_cny > Decimal("1000000.00"):
        return error_response("VALIDATION_ERROR", "单次充值不得超过 1,000,000 元")
    service = OrganizationCashWalletService()
    try:
        tx = service.recharge(
            organization_id=str(organization_id),
            amount_cny=amount_cny,
            description=reason,
            operator_user_id=str(request.auth.id),
            related_order_id=ticket_id,
            reject_duplicate=True,
        )
    except DuplicateCashTransactionOrder:
        return error_response(
            "DUPLICATE_TICKET_ID",
            "系统生成的充值单号发生冲突，请重试",
            status_code=409,
        )
    _record_admin_action(
        request=request,
        action_type="organization_cash_wallet_recharge",
        target_type="organization",
        target_id=organization_id,
        organization_id=organization_id,
        message=f"已充值人民币钱包 ¥{tx.amount_cny}",
        request_payload={"amount_cny": str(amount_cny), "reason": reason, "ticket_id": ticket_id},
        result_payload={"transaction": _serialize_cash_transaction(tx)},
    )
    return success_response(data={
        "wallet": _serialize_cash_wallet(tx.cash_wallet),
        "transaction": _serialize_cash_transaction(tx),
    }, message="人民币钱包充值成功")


@router.post(
    "/organizations/{organization_id}/cash-wallet/purchase-credit-package",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=SuperuserAuth(),
    tags=["后台空间治理"],
    summary="后台用人民币钱包购买点券包",
)
def admin_purchase_credit_package_with_cash_wallet(
    request,
    organization_id: UUID,
    data: AdminOrganizationCashPurchaseRequest,
):
    organization = Organization.objects.filter(id=organization_id).first()
    if not organization:
        return not_found_response(_("tabtinspace.organization_not_found"))
    package = CreditPackage.objects.filter(id=data.package_id, is_active=True).first()
    if not package:
        return not_found_response("点券包不存在或已下架")
    reason = (data.reason or f"购买点券包 {package.name}").strip()
    ticket_id = generate_admin_operation_reference(AdminOperationKind.CASH_PURCHASE_CREDIT)
    try:
        with transaction.atomic():
            cash_tx = OrganizationCashWalletService().spend(
                organization_id=str(organization_id),
                amount_cny=package.price,
                transaction_type="purchase_credit_package",
                description=reason,
                operator_user_id=str(request.auth.id),
                related_order_id=ticket_id,
                metadata={"package_id": str(package.id), "package_name": package.name},
            )
            if cash_tx.related_wallet_transaction_id:
                credit_tx = WalletTransaction.objects.get(id=cash_tx.related_wallet_transaction_id)
            else:
                from apps.users.wallet.services.organization_wallet_service import OrganizationWalletService
                credit_tx = OrganizationWalletService().grant_credits(
                    organization_id=str(organization_id),
                    credits_amount=Decimal(package.total_credits),
                    description=f"购买点券包：{package.name}",
                    user_id=str(request.auth.id),
                )
                cash_tx.related_wallet_transaction_id = str(credit_tx.id)
                cash_tx.save(update_fields=["related_wallet_transaction_id"])
    except InsufficientCashBalance as exc:
        return error_response("INSUFFICIENT_CASH_BALANCE", str(exc))
    _record_admin_action(
        request=request,
        action_type="organization_cash_purchase_credit_package",
        target_type="organization",
        target_id=organization_id,
        organization_id=organization_id,
        message=f"已用人民币钱包购买点券包 {package.name}",
        request_payload={"package_id": str(package.id), "reason": reason, "ticket_id": ticket_id},
        result_payload={
            "cash_transaction": _serialize_cash_transaction(cash_tx),
            "credit_transaction_id": str(credit_tx.id),
            "credits": package.total_credits,
        },
    )
    return success_response(data={
        "cash_transaction": _serialize_cash_transaction(cash_tx),
        "credit_transaction_id": str(credit_tx.id),
        "credits": package.total_credits,
    }, message="点券包购买成功")


@router.post(
    "/organizations/{organization_id}/cash-wallet/purchase-addon-package",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=SuperuserAuth(),
    tags=["后台空间治理"],
    summary="后台用人民币钱包购买权益扩容包",
)
def admin_purchase_addon_package_with_cash_wallet(
    request,
    organization_id: UUID,
    data: AdminOrganizationCashPurchaseRequest,
):
    organization = Organization.objects.filter(id=organization_id).first()
    if not organization:
        return not_found_response(_("tabtinspace.organization_not_found"))
    package = AddonPackage.objects.filter(id=data.package_id, is_active=True).first()
    if not package:
        return not_found_response("权益扩容包不存在或已下架")
    reason = (data.reason or f"购买扩容包 {package.addon_name}").strip()
    ticket_id = generate_admin_operation_reference(AdminOperationKind.CASH_PURCHASE_ADDON)
    try:
        with transaction.atomic():
            cash_tx = OrganizationCashWalletService().spend(
                organization_id=str(organization_id),
                amount_cny=package.price,
                transaction_type="purchase_addon_package",
                description=reason,
                operator_user_id=str(request.auth.id),
                related_order_id=ticket_id,
                metadata={"package_id": str(package.id), "addon_code": package.addon_code},
            )
            if cash_tx.related_addon_entitlement_id:
                entitlement = OrganizationAddonEntitlement.objects.get(id=cash_tx.related_addon_entitlement_id)
            else:
                entitlement = AddonEntitlementService.grant_addon(
                    organization_id=str(organization_id),
                    addon_package_id=str(package.id),
                    purchased_by=str(request.auth.id),
                )
                cash_tx.related_addon_entitlement_id = str(entitlement.id)
                cash_tx.save(update_fields=["related_addon_entitlement_id"])
    except InsufficientCashBalance as exc:
        return error_response("INSUFFICIENT_CASH_BALANCE", str(exc))
    _record_admin_action(
        request=request,
        action_type="organization_cash_purchase_addon_package",
        target_type="entitlement",
        target_id=entitlement.id,
        organization_id=organization_id,
        message=f"已用人民币钱包购买扩容包 {package.addon_name}",
        request_payload={"package_id": str(package.id), "reason": reason, "ticket_id": ticket_id},
        result_payload={
            "cash_transaction": _serialize_cash_transaction(cash_tx),
            "entitlement": _serialize_addon_entitlement(entitlement),
        },
    )
    return success_response(data={
        "cash_transaction": _serialize_cash_transaction(cash_tx),
        "entitlement": _serialize_addon_entitlement(entitlement),
    }, message="扩容包购买成功")

@router.post(
    "/organizations/{organization_id}/wallet/recharge",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=SuperuserAuth(),
    tags=["后台空间治理"],
    summary="后台组织钱包充值",
)
def admin_recharge_organization_wallet(
    request,
    organization_id: UUID,
    data: AdminOrganizationWalletRechargeRequest,
):

    organization = Organization.objects.filter(id=organization_id).first()
    if not organization:
        return not_found_response(_("tabtinspace.organization_not_found"))

    if not data.amount or data.amount <= 0:
        return error_response("VALIDATION_ERROR", "充值金额必须大于 0")

    if data.amount > 10_000_000:
        return error_response("VALIDATION_ERROR", "单次充值不得超过 10,000,000")

    admin_user_id = str(request.auth.id)
    description = (data.description or "").strip() or "管理员充值"
    ticket_id = generate_admin_operation_reference(AdminOperationKind.CREDITS_RECHARGE)

    from apps.users.wallet.services.organization_wallet_service import OrganizationWalletService
    wt_wallet_service = OrganizationWalletService()

    wt_wallet_service.get_or_create_wallet(str(organization_id))

    tx = wt_wallet_service.grant_credits(
        organization_id=str(organization_id),
        credits_amount=Decimal(data.amount),
        description=description,
        user_id=admin_user_id,
    )

    wallet = _get_organization_wallet(str(organization_id))

    _record_admin_action(
        request=request,
        action_type="organization_wallet_recharge",
        target_type="organization",
        target_id=organization_id,
        organization_id=organization_id,
        message=f"已调整组织 credits +{data.amount}",
        request_payload={"amount": data.amount, "description": description, "ticket_id": ticket_id},
        result_payload={
            "transaction_id": tx.id,
            "balance_after": wallet.credits if wallet else None,
        },
    )

    return success_response(
        data={
            "transaction_id": tx.id,
            "amount": data.amount,
            "balance_after": wallet.credits if wallet else None,
            "balance_after_precise": str(wallet.credits_precise) if wallet else None,
        },
        message=f"已调整组织 credits +{data.amount}",
    )

@router.get(
    "/organizations/{organization_id}/wallet/transactions",
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=StaffAuth(),
    tags=["后台空间治理"],
    summary="后台组织钱包交易记录",
)
def admin_list_organization_wallet_transactions(
    request,
    organization_id: UUID,
    transaction_type: str = "",
    page: int = 1,
    page_size: int = 20,
):

    organization = Organization.objects.filter(id=organization_id).first()
    if not organization:
        return not_found_response(_("tabtinspace.organization_not_found"))

    wallet = _get_organization_wallet(str(organization_id))
    if not wallet:
        return success_response(data={
            "transactions": [],
            "total": 0,
            "pagination": {"page": 1, "page_size": page_size, "total_pages": 0},
            "wallet": None,
        })

    page = max(page, 1)
    page_size = max(1, min(page_size, 100))

    tx_qs = WalletTransaction.objects.filter(organization_wallet=wallet).order_by("-created_at")
    normalized_type = transaction_type.strip()
    if normalized_type and normalized_type != "all":
        tx_qs = tx_qs.filter(transaction_type=normalized_type)

    total = tx_qs.count()
    pagination = _build_pagination(total, page, page_size)
    items = list(tx_qs[pagination["offset"]: pagination["offset"] + page_size])

    operator_ids = {tx.operator_user_id for tx in items if tx.operator_user_id}
    operator_name_map = _build_owner_name_map(list(operator_ids)) if operator_ids else {}

    transactions = [
        _serialize_wallet_transaction(tx, operator_name_map)
        for tx in items
    ]

    return success_response(data={
        "transactions": transactions,
        "total": total,
        "pagination": {
            "page": pagination["page"],
            "page_size": page_size,
            "total_pages": pagination["total_pages"],
        },
        "wallet": _serialize_wallet_info(wallet),
    })


# ==================== 组织权益与扩容（Admin） ====================

@router.get(
    "/organizations/{organization_id}/entitlements",
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=StaffAuth(),
    tags=["后台空间治理"],
    summary="后台组织权益与扩容摘要",
)
def admin_get_organization_entitlements(request, organization_id: UUID):
    organization = Organization.objects.filter(id=organization_id).first()
    if not organization:
        return not_found_response(_("tabtinspace.organization_not_found"))
    return success_response(data=_build_entitlement_summary(str(organization_id)))


@router.post(
    "/organizations/{organization_id}/entitlements/grant",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=SuperuserAuth(),
    tags=["后台空间治理"],
    summary="后台发放组织扩容权益",
)
def admin_grant_organization_entitlement(
    request,
    organization_id: UUID,
    data: AdminOrganizationQuotaGrantRequest,
):
    organization = Organization.objects.filter(id=organization_id).first()
    if not organization:
        return not_found_response(_("tabtinspace.organization_not_found"))

    quota_key = (data.quota_key or "").strip()
    if quota_key not in QUOTA_GRANT_KEYS:
        return error_response(
            "VALIDATION_ERROR",
            "扩容类型仅支持文档、表格、群组、存储容量、成员席位",
        )
    quota_value = int(data.quota_value or 0)
    if quota_value <= 0:
        return error_response("VALIDATION_ERROR", "扩容数量必须大于 0")
    max_quota_value = _QUOTA_GRANT_MAX_VALUE.get(quota_key, 1_000_000)
    if quota_value > max_quota_value:
        return error_response("VALIDATION_ERROR", "单次扩容数量过大")
    if int(data.period_months or 0) <= 0:
        return error_response("VALIDATION_ERROR", "有效期月份必须大于 0")
    reason = (data.reason or "").strip()
    if not reason:
        return error_response("VALIDATION_ERROR", "请填写扩容原因")
    ticket_id = generate_admin_operation_reference(AdminOperationKind.QUOTA_GRANT)

    package = _get_admin_grant_package(quota_key)
    entitlement = AddonEntitlementService.grant_addon(
        organization_id=str(organization_id),
        addon_package_id=str(package.id),
        purchased_by=str(request.auth.id),
        quota_key=quota_key,
        quota_value=quota_value,
        period_months=int(data.period_months),
        addon_code=f"admin_grant_{quota_key}",
        addon_name=f"运营发放{QUOTA_GRANT_KEYS[quota_key]}扩容",
        allow_inactive_package=True,
    )
    metadata = dict(entitlement.metadata or {})
    metadata.update({
        "source": "admin_grant",
        "reason": reason,
        "ticket_id": ticket_id,
        "operator_id": str(request.auth.id),
    })
    entitlement.metadata = metadata
    entitlement.save(update_fields=["metadata", "updated_at"])

    result_payload = {
        "entitlement": _serialize_addon_entitlement(entitlement),
        "summary": _build_entitlement_summary(str(organization_id)),
    }
    _record_admin_action(
        request=request,
        action_type="organization_quota_grant",
        target_type="entitlement",
        target_id=entitlement.id,
        organization_id=organization_id,
        message=f"已发放{QUOTA_GRANT_KEYS[quota_key]}扩容 +{quota_value}",
        request_payload={
            "quota_key": quota_key,
            "quota_value": quota_value,
            "period_months": int(data.period_months),
            "reason": reason,
            "ticket_id": ticket_id,
        },
        result_payload=result_payload,
    )
    return success_response(data=result_payload, message="扩容权益已发放")

# ==================== 成员消费统计（Admin） ====================

@router.get(
    "/organizations/{organization_id}/member-usage",
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=StaffAuth(),
    tags=["后台空间治理"],
    summary="后台组织成员消费统计",
)
def admin_get_organization_member_usage(
    request,
    organization_id: UUID,
    days: int = 30,
):

    organization = Organization.objects.filter(id=organization_id).first()
    if not organization:
        return not_found_response(_("tabtinspace.organization_not_found"))

    from apps.services.billing.api_utils import safe_decimal
    from apps.services.billing.services import aggregate_member_usage, build_member_list, build_user_info_map

    wt_id = str(organization_id)
    member_agg, meter_by_user, total_credits, period_days = aggregate_member_usage(
        wt_id, period_days=int(days or 30)
    )

    user_ids = [row["user_id"] for row in member_agg if row["user_id"]]
    user_info_map = build_user_info_map(user_ids)

    members = build_member_list(member_agg, meter_by_user, total_credits, user_info_map)

    return success_response(data={
        "organization_id": wt_id,
        "period_days": period_days,
        "total_credits": str(safe_decimal(total_credits)),
        "member_count": len(members),
        "members": members,
    })

# ==================== 回收站管理（Admin） ====================


def _ensure_admin_sensitive_reason(reason: str) -> str:
    normalized = (reason or "").strip()
    if not normalized:
        raise HttpError(400, "reason 不能为空")
    return normalized


def _serialize_context_item_snapshot(ci: ContextItem) -> dict:
    host = ci.workspace or ci.project
    host_id = ci.workspace_id or ci.project_id
    return {
        "context_item_id": str(ci.id),
        "resource_id": ci.resource_id,
        "item_type": ci.item_type,
        "title": ci.title,
        "space_id": str(host_id) if host_id else "",
        "organization_id": str(getattr(host, "organization_id", "") or ""),
        "trashed_at": ci.trashed_at.isoformat() if ci.trashed_at else None,
        "trashed_by": str(ci.trashed_by) if ci.trashed_by else "",
        "previous_status": ci.previous_status or "",
    }


@router.get(
    "/trash/overview",
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse},
    auth=AdminPermissionAuth("trash:list"),
    summary="回收站全局概览（Admin）"
)
def admin_trash_overview(request):
    """获取全平台回收站概览统计：按类型分组的数量、总存储占用等。"""

    from django.db.models import Count
    from django.utils import timezone
    from datetime import timedelta

    now = timezone.now()

    type_stats = list(
        ContextItem.objects
        .filter(trashed_at__isnull=False)
        .values('item_type')
        .annotate(count=Count('id'))
        .order_by('-count')
    )

    total_trashed = sum(s['count'] for s in type_stats)

    expiring_soon = ContextItem.objects.filter(
        trashed_at__isnull=False,
        trashed_at__lt=now - timedelta(days=27),
    ).count()

    trashed_spaces = Project.objects.filter(
        trashed_at__isnull=False,
    ).count()

    return success_response({
        "total_trashed_resources": total_trashed,
        "trashed_spaces": trashed_spaces,
        "expiring_soon_3_days": expiring_soon,
        "by_type": type_stats,
    })

@router.get(
    "/trash/resources",
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse},
    auth=AdminPermissionAuth("trash:list"),
    summary="回收站资源列表（Admin）"
)
def admin_list_trashed_resources(request):
    """列出全平台回收站资源（分页）。"""

    item_type = request.GET.get('item_type')
    attention = request.GET.get('attention', '')
    organization_id = request.GET.get('organization_id')
    try:
        page = int(request.GET.get('page', '1'))
        page_size = int(request.GET.get('page_size', '50'))
    except (ValueError, TypeError):
        raise HttpError(400, "page 和 page_size 必须为整数")
    if page < 1:
        page = 1
    if page_size < 1 or page_size > 200:
        raise HttpError(400, "page_size 必须在 1-200 之间")

    qs = ContextItem.objects.filter(trashed_at__isnull=False).order_by('-trashed_at')

    if item_type:
        type_filter = _admin_resource_type_filter(item_type)
        if type_filter is not None:
            qs = qs.filter(type_filter)
    if attention == 'expiring':
        from django.utils import timezone
        from datetime import timedelta

        qs = qs.filter(trashed_at__lt=timezone.now() - timedelta(days=27))
    if organization_id:
        qs = qs.filter(
            Q(workspace__organization_id=organization_id)
            | Q(project__organization_id=organization_id)
        )

    total = qs.count()
    offset = (page - 1) * page_size
    items = list(
        qs.select_related("workspace", "project", "created_by")[offset:offset + page_size]
    )

    name_ids: list[str] = []
    for ci in items:
        if ci.created_by_id:
            name_ids.append(str(ci.created_by_id))
        if ci.trashed_by:
            name_ids.append(str(ci.trashed_by))
    name_map = _build_owner_name_map(name_ids)

    result = []
    for ci in items:
        host = ci.workspace or ci.project
        host_id = ci.workspace_id or ci.project_id
        created_by_id = str(ci.created_by_id) if ci.created_by_id else None
        trashed_by_id = str(ci.trashed_by) if ci.trashed_by else None
        result.append({
            "id": str(ci.id),
            "resource_id": ci.resource_id,
            "item_type": ci.item_type,
            "title": ci.title,
            "space_id": str(host_id) if host_id else None,
            "organization_id": str(getattr(host, "organization_id", "") or "") or None,
            "trashed_at": ci.trashed_at.isoformat() if ci.trashed_at else None,
            "trashed_by": trashed_by_id,
            "trashed_by_name": name_map.get(trashed_by_id or "", "") or None,
            "created_by": created_by_id,
            "created_by_name": name_map.get(created_by_id or "", "") or None,
            "previous_status": ci.previous_status,
            "created_at": ci.created_at.isoformat() if ci.created_at else None,
        })

    return success_response({
        "items": result,
        "total": total,
        "page": page,
        "page_size": page_size,
    })

@router.post(
    "/trash/force-cleanup",
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse},
    auth=AdminPermissionAuth("trash:cleanup"),
    summary="手动触发回收站清理（Admin）"
)
def admin_force_trash_cleanup(request, data: AdminSensitiveReasonRequest):
    """管理员手动触发回收站过期资源清理（异步执行）。"""

    reason = _ensure_admin_sensitive_reason(data.reason)
    from apps.tabtinspace.tasks import cleanup_expired_trashed_resources
    from django.utils import timezone
    from datetime import timedelta

    now = timezone.now()
    cleanup_expired_trashed_resources.delay()
    before_json = {
        "default_30_day_candidate_count": ContextItem.objects.filter(
            trashed_at__isnull=False,
            trashed_at__lt=now - timedelta(days=30),
        ).count(),
        "total_trashed_resource_count": ContextItem.objects.filter(trashed_at__isnull=False).count(),
    }
    record_admin_sensitive_action(
        request,
        permission_code="trash:cleanup",
        action="trash.force_cleanup",
        target_type="system",
        target_id="trash",
        reason=reason,
        ticket_id=(data.ticket_id or "").strip(),
        before_json=before_json,
        after_json={"cleanup_task_submitted": True},
    )
    _record_admin_action(
        request=request,
        action_type="resource_delete",
        target_type="system",
        target_id=None,
        message="手动触发回收站清理",
        request_payload={"reason": reason, "ticket_id": (data.ticket_id or "").strip()},
    )
    return success_response({
        "message": "清理任务已提交，将在后台执行",
    })

@router.delete(
    "/trash/resources/{context_item_id}",
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=AdminPermissionAuth("trash:delete"),
    summary="管理员永久删除回收站资源"
)
def admin_permanent_delete_trashed_resource(request, context_item_id: UUID, data: AdminSensitiveReasonRequest):
    """管理员直接永久删除回收站中的指定资源。"""

    reason = _ensure_admin_sensitive_reason(data.reason)
    ci = ContextItem.objects.select_related("workspace", "project").filter(
        id=context_item_id, trashed_at__isnull=False,
    ).first()
    if not ci:
        return not_found_response(_("tabtinspace.trash_resource_not_found"))
    before_json = _serialize_context_item_snapshot(ci)

    from apps.tabtinspace.services.trash_cleaner import TrashCleaner
    TrashCleaner.permanent_delete_trashed_items(
        ContextItem.objects.filter(id=context_item_id),
        user=request.auth,
        include_dead_letters=True,
    )
    record_admin_sensitive_action(
        request,
        permission_code="trash:delete",
        action="trash.resource.delete",
        target_type="context_item",
        target_id=str(context_item_id),
        reason=reason,
        ticket_id=(data.ticket_id or "").strip(),
        before_json=before_json,
        after_json={**before_json, "permanently_deleted": True},
    )
    _record_admin_action(
        request=request,
        action_type="resource_delete",
        target_type="context_item",
        target_id=context_item_id,
        space_id=ci.workspace_id or ci.project_id,
        message=f"永久删除回收站资源: {ci.title}",
        request_payload={
            "context_item_id": str(context_item_id),
            "item_type": ci.item_type,
            "reason": reason,
            "ticket_id": (data.ticket_id or "").strip(),
        },
    )
    return success_response(message=_("ws_admin.resource_permanently_deleted", title=ci.title))


@router.post(
    "/resources/{context_item_id}/trash",
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=AdminPermissionAuth("trash:delete"),
    summary="管理员将活跃资源移入回收站",
)
def admin_trash_active_resource(request, context_item_id: UUID, data: AdminSensitiveReasonRequest):
    """运维代删：按 ContextItem 类型路由到各模块 trash，进入回收站（可恢复）。"""
    reason = _ensure_admin_sensitive_reason(data.reason)
    ci = (
        ContextItem.objects.select_related("workspace", "project")
        .filter(id=context_item_id, trashed_at__isnull=True)
        .exclude(status="trashed")
        .first()
    )
    if not ci:
        return not_found_response(_("tabtinspace.trash_resource_not_found"))

    before_json = _serialize_context_item_snapshot(ci)
    user = request.auth
    item_type = (ci.item_type or "").strip()
    resource_id = ci.resource_id

    try:
        if item_type in {"tabdoc", "document"}:
            from apps.tabdoc.models import Document
            from apps.tabtinspace.services.resource_bridge import ResourceBridge

            # legacy document → tabdoc，保证 ResourceBridge 能命中同一 ContextItem
            item_type = _canonicalize_context_item_type_for_bridge(ci)
            doc = Document.objects.get(id=resource_id)
            if getattr(doc, "trashed_at", None):
                raise ValueError("文档已在回收站中")
            doc.trash(user_id=getattr(user, "id", None), save=False)
            if hasattr(doc, "updated_by"):
                doc.updated_by = user
            doc.save(
                update_fields=[
                    "status",
                    "trashed_at",
                    "trashed_by",
                    "previous_status",
                    "updated_by",
                    "updated_at",
                ]
            )
            ResourceBridge.on_trash(doc, user=user)
        elif item_type == "tabslide":
            from apps.tabslide.services.slide_service import SlideService

            SlideService(user=user).trash_project(str(resource_id))
        elif item_type == "tabdata":
            from apps.tabdata.constants import TABDATA_DB_ALIAS
            from apps.tabdata.services.schema_version_token import bump_table_schema_version_token
            from apps.tabtinspace.services.resource_bridge import ResourceBridge

            table = Table.objects.using(TABDATA_DB_ALIAS).get(id=resource_id)
            if getattr(table, "is_system_table", False):
                raise HttpError(400, "系统表不可删除")
            if getattr(table, "trashed_at", None):
                raise ValueError("表格已在回收站中")
            with transaction.atomic(using=TABDATA_DB_ALIAS):
                table.trash(user_id=getattr(user, "id", None))
                bump_table_schema_version_token(table.id, reason="trash", user=user)
                ResourceBridge.on_trash(table, user=user)
        elif item_type == "tabmemo":
            from apps.tabmemo.services.memo_service import MemoService

            MemoService(user=user).trash_memo(str(resource_id))
        elif item_type in {"tabfiles", "file"}:
            from apps.tabtinspace.services.space_service import SpaceService

            # file → tabfiles，与 registry / ResourceBridge 查找对齐
            item_type = _canonicalize_context_item_type_for_bridge(ci)
            SpaceService(user=user)._trash_child_resource(
                ci,
                timezone.now(),
                getattr(user, "id", None),
            )
            ci.refresh_from_db()
            if ci.trashed_at is None:
                # _trash_child_resource 在无模型映射时会静默 return；禁止假成功
                raise HttpError(400, "文件资源移入回收站失败：源模型不可 trash 或资源不存在")
        else:
            return not_found_response(
                _("tabtinspace.unsupported_resource_type", item_type=item_type)
            )

        record_admin_sensitive_action(
            request,
            permission_code="trash:delete",
            action="trash.resource.move",
            target_type="context_item",
            target_id=str(context_item_id),
            reason=reason,
            ticket_id=(data.ticket_id or "").strip(),
            before_json=before_json,
            after_json={**before_json, "moved_to_trash": True},
        )
        _record_admin_action(
            request=request,
            action_type="resource_trash",
            target_type="context_item",
            target_id=context_item_id,
            space_id=ci.workspace_id or ci.project_id,
            message=f"移入回收站: {ci.title}",
            request_payload={
                "context_item_id": str(context_item_id),
                "item_type": ci.item_type,
                "reason": reason,
                "ticket_id": (data.ticket_id or "").strip(),
            },
        )
        return success_response(message=f"「{ci.title or '无标题'}」已移入回收站")
    except ObjectDoesNotExist:
        return not_found_response(_("tabtinspace.related_resource_not_found"))
    except ServiceError as exc:
        raise HttpError(exc.status or 400, exc.message or str(exc)) from exc
    except HttpError:
        raise
    except Exception as exc:
        logger.warning("Admin 移入回收站失败: ci=%s, err=%s", context_item_id, exc)
        raise HttpError(400, f"移入回收站失败: {exc}") from exc


@router.post(
    "/spaces/{space_id}/trash",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=AdminPermissionAuth("trash:delete"),
    tags=["后台空间治理"],
    summary="管理员将 Space 移入回收站",
)
def admin_trash_active_space(request, space_id: UUID, data: AdminSensitiveReasonRequest):
    """运维代删：将协作宿主移入回收站（可恢复），并级联 trash 子资源。

     / ：Space 表已 DROP；可回收站宿主仅为 Project（Workspace 无 trash 字段）。
    """
    reason = _ensure_admin_sensitive_reason(data.reason)
    host = resolve_host(space_id)
    if host is None:
        return not_found_response("Space")
    if isinstance(host, Workspace):
        raise HttpError(400, "Workspace 不支持回收站；请删除或归档个人现场")
    if not isinstance(host, Project) or host.trashed_at is not None:
        return not_found_response("Space")
    space = host

    before_json = {
        "space_id": str(space.id),
        "name": space.name,
        "organization_id": str(space.organization_id),
        "status": space.status,
        "type": "team_space",
    }

    from apps.tabtinspace.services.space_service import SpaceService

    try:
        ok = SpaceService.admin_trash_space(space_id, actor=request.auth)
    except ServiceError as exc:
        raise HttpError(exc.status or 400, exc.message or str(exc)) from exc
    if not ok:
        raise HttpError(400, "Space 移入回收站失败")

    record_admin_sensitive_action(
        request,
        permission_code="trash:delete",
        action="trash.space.move",
        target_type="space",
        target_id=str(space_id),
        reason=reason,
        ticket_id=(data.ticket_id or "").strip(),
        before_json=before_json,
        after_json={**before_json, "moved_to_trash": True},
    )
    _record_admin_action(
        request=request,
        action_type="space_trash",
        target_type="space",
        target_id=space_id,
        organization_id=space.organization_id,
        space_id=space_id,
        message=f"移入回收站 Space: {space.name}",
        request_payload={
            "space_id": str(space_id),
            "reason": reason,
            "ticket_id": (data.ticket_id or "").strip(),
        },
    )
    return success_response(message=f"Space「{space.name}」已移入回收站")


@router.post(
    "/trash/resources/{context_item_id}/restore",
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=AdminPermissionAuth("trash:restore"),
    summary="管理员恢复回收站资源"
)
def admin_restore_trashed_resource(request, context_item_id: UUID, data: AdminSensitiveReasonRequest):
    """管理员从回收站恢复指定资源，按 item_type 路由到各模块 Service。"""

    reason = _ensure_admin_sensitive_reason(data.reason)
    ci = ContextItem.objects.select_related("workspace", "project").filter(id=context_item_id, trashed_at__isnull=False).first()
    if not ci:
        return not_found_response(_("tabtinspace.trash_resource_not_found"))
    before_json = _serialize_context_item_snapshot(ci)

    user = request.auth
    item_type = (ci.item_type or "").strip()
    resource_id = ci.resource_id

    try:
        if item_type in {"tabdoc", "document"}:
            from apps.tabdoc.models import Document
            from apps.tabtinspace.services.resource_bridge import ResourceBridge

            # 与 trash 对称：先规范 item_type，再走 Document + ResourceBridge
            item_type = _canonicalize_context_item_type_for_bridge(ci)
            doc = Document.objects.get(id=resource_id)
            if not getattr(doc, "trashed_at", None):
                raise ValueError("文档不在回收站中")
            ResourceBridge.check_restore_quota(doc)
            with transaction.atomic(using="postgresql"):
                doc.restore_from_trash(save=False)
                if hasattr(doc, "updated_by"):
                    doc.updated_by = user
                doc.save(update_fields=[
                    "status", "trashed_at", "trashed_by", "previous_status",
                    "updated_by", "updated_at",
                ])
                ResourceBridge.on_restore(doc, user=user)
        elif item_type == "tabslide":
            from apps.tabslide.services.slide_service import SlideService
            svc = SlideService(user=user)
            svc.restore_project(str(resource_id))
        elif item_type == "tabdata":
            from apps.tabdata.constants import TABDATA_DB_ALIAS
            from apps.tabdata.models import TableField
            from apps.tabdata.services.schema_version_token import bump_table_schema_version_token
            from apps.tabdata.services.table_service import TableService
            from apps.tabtinspace.services.resource_bridge import ResourceBridge
            from apps.users.membership.services.quota_service import QuotaService

            table = Table.objects.using(TABDATA_DB_ALIAS).get(id=resource_id)
            if not getattr(table, "trashed_at", None):
                raise ValueError("表格不在回收站中")
            svc = TableService(user=user)
            with transaction.atomic(using=TABDATA_DB_ALIAS):
                if table.space_id:
                    lock_host_for_update(table.space_id, using=TABDATA_DB_ALIAS)
                QuotaService().check_quota(
                    quota_type="max_tables",
                    increment=1,
                    organization_id=str(table.organization_id) if table.organization_id else None,
                    actor=user,
                )
                ResourceBridge.check_restore_quota(table)
                table.restore_from_trash()
                bump_table_schema_version_token(table.id, reason="restore", user=user)
                fields = list(TableField.objects.using(TABDATA_DB_ALIAS).filter(
                    table_id=table.id,
                    is_deleted=False,
                ))
                svc._native_ensure_table(table.space_id, table.id, fields)
                ResourceBridge.on_restore(table, user=user)
        elif item_type == "tabmemo":
            from apps.tabmemo.services.memo_service import MemoService
            svc = MemoService(user=user)
            svc.restore_memo_from_trash(str(resource_id))
        elif item_type in {"tabfiles", "file"}:
            from apps.tabtinspace.services.space_service import SpaceService

            item_type = _canonicalize_context_item_type_for_bridge(ci)
            SpaceService(user=user)._restore_child_resource(ci)
            ci.refresh_from_db()
            if ci.trashed_at is not None:
                raise HttpError(400, "文件资源恢复失败：源模型不可 restore 或资源不存在")
        # 单根契约（docs/single-root-space-prd.md §2.7）：tabcode 资源类型已废弃，
        # 不再有 admin restore 路径；老数据若仍存在 ContextItem 走 unsupported 分支。
        # cloud_file / tabfolder：无 registry 映射，不提供 admin trash/restore。
        else:
            return not_found_response(_("tabtinspace.unsupported_resource_type", item_type=item_type))

        _record_admin_action(
            request=request,
            action_type="resource_restore",
            target_type="context_item",
            target_id=context_item_id,
            space_id=ci.workspace_id or ci.project_id,
            message=f"恢复回收站资源: {ci.title}",
            request_payload={
                "context_item_id": str(context_item_id),
                "item_type": ci.item_type,
                "reason": reason,
                "ticket_id": (data.ticket_id or "").strip(),
            },
        )
        record_admin_sensitive_action(
            request,
            permission_code="trash:restore",
            action="trash.resource.restore",
            target_type="context_item",
            target_id=str(context_item_id),
            reason=reason,
            ticket_id=(data.ticket_id or "").strip(),
            before_json=before_json,
            after_json={**before_json, "restored": True},
        )
        return success_response(message=_("ws_admin.resource_restored", title=ci.title))
    except ObjectDoesNotExist:
        return not_found_response(_("tabtinspace.related_resource_not_found"))
    except HttpError:
        raise
    except Exception as exc:
        logger.warning("Admin 恢复资源失败: ci=%s, err=%s", context_item_id, exc)
        raise HttpError(400, _("ws_admin.restore_failed", error=str(exc)))


@router.get(
    "/trash/spaces",
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse},
    auth=AdminPermissionAuth("trash:list"),
    summary="组织已删除 Space 列表（Admin）",
)
def admin_list_trashed_spaces(request):
    """按组织列出已移入回收站的 Space，供运维代操作（Electron 侧栏当前关闭）。"""
    organization_id = (request.GET.get("organization_id") or "").strip()
    if not organization_id:
        raise HttpError(400, "organization_id 不能为空")
    organization = Organization.objects.filter(id=organization_id).first()
    if not organization:
        return not_found_response(_("tabtinspace.organization_not_found"))

    try:
        page = int(request.GET.get("page", "1"))
        page_size = int(request.GET.get("page_size", "20"))
    except (ValueError, TypeError):
        raise HttpError(400, "page 和 page_size 必须为整数")
    if page < 1:
        page = 1
    if page_size < 1 or page_size > 100:
        raise HttpError(400, "page_size 必须在 1-100 之间")

    # ：回收站宿主列表读 Project（Workspace 无 trashed_at）
    qs = (
        Project.objects.filter(organization_id=organization_id, trashed_at__isnull=False)
        .only(
            "id",
            "name",
            "description",
            "status",
            "trashed_at",
            "trashed_by",
            "previous_status",
            "created_at",
            "avatar",
        )
        .order_by("-trashed_at")
    )
    total = qs.count()
    offset = (page - 1) * page_size
    spaces = list(qs[offset : offset + page_size])
    name_map = _build_owner_name_map(
        [str(space.trashed_by) for space in spaces if space.trashed_by]
    )
    items = [
        {
            "id": str(space.id),
            "name": space.name,
            "icon": getattr(space, "avatar", "") or "",
            "description": space.description,
            "status": space.status,
            "type": "team_space",
            "organization_id": organization_id,
            "trashed_at": space.trashed_at.isoformat() if space.trashed_at else None,
            "trashed_by": str(space.trashed_by) if space.trashed_by else None,
            "trashed_by_name": (
                name_map.get(str(space.trashed_by), "") or None
                if space.trashed_by
                else None
            ),
            # Project 无 created_by；创建人暂不可得
            "created_by": None,
            "created_by_name": None,
            "previous_status": space.previous_status,
            "created_at": space.created_at.isoformat() if space.created_at else None,
        }
        for space in spaces
    ]
    return success_response(
        {
            "items": items,
            "total": total,
            "page": page,
            "page_size": page_size,
        }
    )


@router.post(
    "/trash/spaces/{space_id}/restore",
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=AdminPermissionAuth("trash:restore"),
    summary="管理员恢复已删除 Space",
)
def admin_restore_trashed_space(request, space_id: UUID, data: AdminSensitiveReasonRequest):
    reason = _ensure_admin_sensitive_reason(data.reason)
    space = Project.objects.filter(id=space_id, trashed_at__isnull=False).first()
    if not space:
        return not_found_response("Space")

    before_json = {
        "space_id": str(space.id),
        "name": space.name,
        "organization_id": str(space.organization_id),
        "trashed_at": space.trashed_at.isoformat() if space.trashed_at else None,
        "previous_status": space.previous_status or "",
    }

    from apps.tabtinspace.services.space_service import SpaceService

    ok = SpaceService.admin_restore_space_from_trash(space_id, actor=request.auth)
    if not ok:
        raise HttpError(400, "Space 恢复失败")

    record_admin_sensitive_action(
        request,
        permission_code="trash:restore",
        action="trash.space.restore",
        target_type="space",
        target_id=str(space_id),
        reason=reason,
        ticket_id=(data.ticket_id or "").strip(),
        before_json=before_json,
        after_json={**before_json, "restored": True},
    )
    _record_admin_action(
        request=request,
        action_type="space_restore",
        target_type="space",
        target_id=space_id,
        organization_id=space.organization_id,
        space_id=space_id,
        message=f"从回收站恢复 Space: {space.name}",
        request_payload={
            "space_id": str(space_id),
            "reason": reason,
            "ticket_id": (data.ticket_id or "").strip(),
        },
    )
    return success_response(message=f"Space「{space.name}」已从回收站恢复")


@router.delete(
    "/trash/spaces/{space_id}",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=AdminPermissionAuth("trash:delete"),
    summary="管理员永久删除已删除 Space",
)
def admin_permanent_delete_trashed_space(request, space_id: UUID, data: AdminSensitiveReasonRequest):
    reason = _ensure_admin_sensitive_reason(data.reason)
    space = Project.objects.filter(id=space_id, trashed_at__isnull=False).first()
    if not space:
        return not_found_response("Space")

    before_json = {
        "space_id": str(space.id),
        "name": space.name,
        "organization_id": str(space.organization_id),
        "trashed_at": space.trashed_at.isoformat() if space.trashed_at else None,
    }
    space_name = space.name
    organization_id = space.organization_id

    from apps.tabtinspace.services.space_service import SpaceService

    try:
        # 复用绑定校验；跳过 owner 成员权限，由 trash:delete 承担运维授权
        SpaceService(user=request.auth)._assert_not_execution_binding_target(space_id)
        deleted = SpaceService.purge_trashed_spaces([space_id])
    except ServiceError as exc:
        return error_response(exc.code, exc.message, status_code=exc.status)

    if deleted <= 0:
        raise HttpError(400, "Space 永久删除失败")

    record_admin_sensitive_action(
        request,
        permission_code="trash:delete",
        action="trash.space.delete",
        target_type="space",
        target_id=str(space_id),
        reason=reason,
        ticket_id=(data.ticket_id or "").strip(),
        before_json=before_json,
        after_json={**before_json, "permanently_deleted": True},
    )
    _record_admin_action(
        request=request,
        action_type="space_delete",
        target_type="space",
        target_id=space_id,
        organization_id=organization_id,
        space_id=space_id,
        message=f"永久删除回收站 Space: {space_name}",
        request_payload={
            "space_id": str(space_id),
            "reason": reason,
            "ticket_id": (data.ticket_id or "").strip(),
        },
    )
    return success_response(message=f"Space「{space_name}」已永久删除")


@router.post(
    "/trash/organizations/{organization_id}/empty",
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=AdminPermissionAuth("trash:cleanup"),
    summary="清空组织资源回收站（Admin）",
)
def admin_empty_organization_resource_trash(request, organization_id: UUID, data: AdminSensitiveReasonRequest):
    """永久删除指定组织回收站中的全部 ContextItem（不含 Space）。"""
    reason = _ensure_admin_sensitive_reason(data.reason)
    organization = Organization.objects.filter(id=organization_id).first()
    if not organization:
        return not_found_response(_("tabtinspace.organization_not_found"))

    # ：ContextItem 宿主为 workspace / project，不再有 space FK
    qs = ContextItem.objects.filter(
        Q(workspace__organization_id=organization_id)
        | Q(project__organization_id=organization_id),
        trashed_at__isnull=False,
    )
    candidate_count = qs.count()
    from apps.tabtinspace.services.trash_cleaner import TrashCleaner

    TrashCleaner.permanent_delete_trashed_items(
        qs, user=request.auth, include_dead_letters=True,
    )
    remaining = ContextItem.objects.filter(
        Q(workspace__organization_id=organization_id)
        | Q(project__organization_id=organization_id),
        trashed_at__isnull=False,
    ).count()
    deleted_count = max(candidate_count - remaining, 0)

    record_admin_sensitive_action(
        request,
        permission_code="trash:cleanup",
        action="trash.organization.empty",
        target_type="organization",
        target_id=str(organization_id),
        reason=reason,
        ticket_id=(data.ticket_id or "").strip(),
        before_json={"candidate_count": candidate_count},
        after_json={"deleted_count": deleted_count, "remaining": remaining},
    )
    _record_admin_action(
        request=request,
        action_type="resource_delete",
        target_type="organization",
        target_id=organization_id,
        organization_id=organization_id,
        message=f"清空组织资源回收站: deleted={deleted_count}",
        request_payload={
            "organization_id": str(organization_id),
            "reason": reason,
            "ticket_id": (data.ticket_id or "").strip(),
            "candidate_count": candidate_count,
            "deleted_count": deleted_count,
        },
    )
    return success_response(
        data={"deleted_count": deleted_count, "remaining": remaining},
        message=f"已清空本组织资源回收站（删除 {deleted_count} 条）",
    )


# ==================== 分享链接治理（Admin） ====================


def _parse_bool_query(value: str | None) -> bool | None:
    if value is None or value == "":
        return None
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "active"}:
        return True
    if normalized in {"0", "false", "no", "inactive"}:
        return False
    raise HttpError(400, "active 必须为 true 或 false")


def _serialize_admin_share_item(*, resource_type: str, share, resource, organization_id: str, space_id: str) -> dict:
    creator = getattr(share, "created_by", None)
    normalized_organization_id = "" if organization_id in {"", "None"} else organization_id
    normalized_space_id = "" if space_id in {"", "None"} else space_id
    return {
        "id": str(share.id),
        "resource_type": resource_type,
        "resource_id": str(resource.id),
        "resource_title": getattr(resource, "title", None) or getattr(resource, "name", "") or "",
        "share_id": share.share_id,
        "share_type": share.share_type,
        "permission": share.permission,
        "is_active": bool(getattr(share, "is_active", True)),
        "has_password": bool(getattr(share, "has_password", False)),
        "organization_id": normalized_organization_id,
        "space_id": normalized_space_id,
        "created_by_id": str(getattr(creator, "id", "") or "") or None,
        "created_by_name": (
            creator.get_display_name()
            if creator and hasattr(creator, "get_display_name")
            else (getattr(creator, "username", "") or getattr(creator, "email", "") or "")
        ),
        "created_at": share.created_at.isoformat() if getattr(share, "created_at", None) else None,
        "updated_at": share.updated_at.isoformat() if getattr(share, "updated_at", None) else None,
        "expire_at": share.expire_at.isoformat() if getattr(share, "expire_at", None) else None,
        "visit_count": int(getattr(share, "visit_count", 0) or 0),
    }


@router.get(
    "/shares",
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse},
    auth=AdminPermissionAuth("share:list"),
    summary="后台分享链接列表",
)
def admin_list_shares(request):
    from apps.tabdoc.models import DocumentShare
    from apps.tabdata.models import TableShare

    resource_type = (request.GET.get("resource_type") or "all").strip()
    if resource_type not in {"all", "doc", "table"}:
        raise HttpError(400, "resource_type 仅支持 all/doc/table")
    resource_id = (request.GET.get("resource_id") or "").strip()
    organization_id = (request.GET.get("organization_id") or "").strip()
    active_filter = _parse_bool_query(request.GET.get("active"))
    try:
        page = max(1, int(request.GET.get("page", "1")))
        page_size = int(request.GET.get("page_size", "20"))
    except (TypeError, ValueError) as exc:
        raise HttpError(400, "page 和 page_size 必须为整数") from exc
    if page_size < 1 or page_size > 100:
        raise HttpError(400, "page_size 必须在 1-100 之间")

    items: list[dict] = []
    slice_limit = page * page_size
    total = 0
    if resource_type in {"all", "doc"}:
        doc_qs = DocumentShare.objects.select_related("document", "created_by").filter(
            document__trashed_at__isnull=True,
        ).exclude(document__status="trashed")
        if resource_id:
            doc_qs = doc_qs.filter(document_id=resource_id)
        if organization_id:
            doc_qs = doc_qs.filter(document__organization_id=organization_id)
        if active_filter is not None:
            doc_qs = doc_qs.filter(is_active=active_filter)
        total += doc_qs.count()
        for share in doc_qs.order_by("-created_at")[:slice_limit]:
            document = share.document
            items.append(
                _serialize_admin_share_item(
                    resource_type="doc",
                    share=share,
                    resource=document,
                    organization_id=str(document.organization_id),
                    space_id=str(document.space_id),
                )
            )

    if resource_type in {"all", "table"}:
        table_qs = TableShare.objects.select_related("table", "created_by").filter(
            table__trashed_at__isnull=True,
        )
        if resource_id:
            table_qs = table_qs.filter(table_id=resource_id)
        if organization_id:
            table_qs = table_qs.filter(table__organization_id=organization_id)
        # TableShare 没有 is_active 字段；active=false 时不返回，active=true/all 视为有效。
        if active_filter is not False:
            total += table_qs.count()
            for share in table_qs.order_by("-created_at")[:slice_limit]:
                table = share.table
                items.append(
                    _serialize_admin_share_item(
                        resource_type="table",
                        share=share,
                        resource=table,
                        organization_id=str(table.organization_id),
                        space_id=str(table.space_id) if table.space_id else "",
                    )
                )

    items.sort(key=lambda item: item.get("created_at") or "", reverse=True)
    offset = (page - 1) * page_size
    return success_response(
        {
            "items": items[offset:offset + page_size],
            "total": total,
            "page": page,
            "page_size": page_size,
        }
    )


@router.post(
    "/shares/{resource_type}/{share_id}/revoke",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    auth=AdminPermissionAuth("share:revoke"),
    summary="后台撤销分享链接",
)
def admin_revoke_share(request, resource_type: str, share_id: UUID, data: AdminSensitiveReasonRequest):
    from apps.tabdoc.models import DocumentShare
    from apps.tabdata.models import TableShare

    reason = _ensure_admin_sensitive_reason(data.reason)
    ticket_id = (data.ticket_id or "").strip()
    if resource_type == "doc":
        share = DocumentShare.objects.select_related("document").filter(id=share_id).first()
        if not share:
            return not_found_response("DocumentShare")
        document = share.document
        before_json = _serialize_admin_share_item(
            resource_type="doc",
            share=share,
            resource=document,
            organization_id=str(document.organization_id),
            space_id=str(document.space_id),
        )
        share.is_active = False
        share.save(update_fields=["is_active", "updated_at"])
        after_json = {**before_json, "is_active": False, "revoked": True}
        target_id = str(share.id)
    elif resource_type == "table":
        share = TableShare.objects.select_related("table").filter(id=share_id).first()
        if not share:
            return not_found_response("TableShare")
        table = share.table
        before_json = _serialize_admin_share_item(
            resource_type="table",
            share=share,
            resource=table,
            organization_id=str(table.organization_id),
            space_id=str(table.space_id) if table.space_id else "",
        )
        target_id = str(share.id)
        share.delete()
        after_json = {**before_json, "deleted": True, "revoked": True}
    else:
        raise HttpError(400, "resource_type 仅支持 doc/table")

    record_admin_sensitive_action(
        request,
        permission_code="share:revoke",
        action="share.revoke",
        target_type=f"{resource_type}_share",
        target_id=target_id,
        reason=reason,
        ticket_id=ticket_id,
        before_json=before_json,
        after_json=after_json,
    )
    return success_response({"share_id": target_id, "resource_type": resource_type}, message="分享链接已撤销")
