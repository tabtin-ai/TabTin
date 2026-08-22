"""
计费管理 Admin API — 钱包管理、计费事件查询、预算策略 CRUD、定价 CRUD、会员管理。
仅限超级管理员访问。
"""

import csv
import hashlib
import io
import json
import logging
import uuid
from datetime import date, datetime, time, timedelta
from decimal import Decimal, InvalidOperation
from typing import Optional

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import DatabaseError, transaction as db_transaction
from django.db.models import ProtectedError
from django.db.models import CharField, Q, Sum, Count
from django.db.models.functions import Cast, Coalesce, TruncDate
from django.http import HttpResponse
from django.utils import timezone
from django.utils.dateparse import parse_date, parse_datetime
from ninja import Router, Schema
from ninja.errors import HttpError

from apps.i18n import _
from apps.i18n.response import error_response_with_status, success_response
from apps.users.auth.admin_audit import record_admin_sensitive_action
from apps.users.auth.utils import get_client_ip
from apps.tabtinspace.models import Organization
from apps.users.auth.permissions import AdminPermissionAuth, JWTAuth
from apps.services.payment.models import PaymentOrder
from apps.users.membership.exceptions import MembershipLifecycleError
from apps.users.membership.models import MembershipTier, OrganizationMembership
from apps.users.membership.services.membership_change_classifier import MembershipChangeAction
from apps.users.membership.services.membership_payment_service import (
    MembershipPaymentError,
    MembershipPaymentService,
)
from apps.users.membership.services.membership_purchase_guard import (
    classify_organization_membership_change,
)
from apps.users.membership.services.organization_membership_service import (
    OrganizationMembershipService,
    _clear_guard_cache_safe,
)
from apps.users.membership.services.subscription_catalog_service import SubscriptionCatalogService
from apps.users.membership.services.subscription_order_service import (
    MembershipUpgradeBalanceError,
    SubscriptionOrderService,
)
from apps.users.membership.services.subscription_pricing_service import SubscriptionPricingService
from apps.users.wallet.models import OrganizationWallet, WalletTransaction
from apps.users.wallet.services.organization_cash_wallet_service import OrganizationCashWalletService

from .api_utils import apply_ordering, billing_api_errors, record_billing_audit, safe_decimal
from .models import (
    MEMBER_BUDGET_SENTINEL,
    AddonPackage, BillingBudgetPolicy, BillingInvoice, BillingInvoiceLine, BillingUsageEvent,
    MeterPricing, OrganizationAddonEntitlement, OrganizationBillingEntitlement, OrganizationBillingPolicy,
    OrganizationCreditLedger, OrganizationLifecycleCleanupJob, OrganizationStorageUsage, OrganizationLlmMonthlyBudget,
    BillingReconciliationReport, MemberLlmBudgetPolicy, MemberLlmUsageCounter,
    BillingAdminAuditLog, ProviderCreditCampaign, ProviderCreditGrant, ProviderCreditTransaction,
    normalize_provider_credit_membership_plan_codes, normalize_provider_credit_model_ids,
    normalize_provider_credit_provider_key,
)
from .services import StatementService
from .services.real_recharge_report_service import (
    queue_recharge_report,
    resolve_recharge_period,
    save_delivery_config,
    serialize_delivery_config,
    get_delivery_account,
    test_delivery,
)

logger = logging.getLogger(__name__)

router = Router(tags=["Admin 计费管理"], auth=AdminPermissionAuth())

jwt_auth = JWTAuth()

# ── 排序白名单 ──
_WS_WALLET_SORT = frozenset({"updated_at", "created_at", "credits"})
_EVENT_SORT = frozenset({"occurred_at", "created_at", "amount", "quantity"})
_BUDGET_SORT = frozenset({"updated_at", "created_at", "organization_id"})
_PRICING_SORT = frozenset({"updated_at", "created_at", "unit_price", "priority"})
_MEMBERSHIP_SORT = frozenset({"updated_at", "created_at", "end_date", "start_date", "status"})
_AUDIT_SORT = frozenset({"created_at", "action", "target_type"})
_ANOMALY_SORT = frozenset({"created_at", "severity"})
_RECONCILIATION_SORT = frozenset({"created_at", "report_date"})
_STORAGE_WS_SORT = frozenset({"active_storage_bytes", "active_file_count", "updated_at"})
_CLEANUP_JOB_SORT = frozenset({"updated_at", "created_at", "next_retry_at", "attempt_count", "status"})

_PROVIDER_CREDIT_PERMISSION_LEVELS = {
    "view": {
        "provider_credit:view",
        "provider_credit:operate",
        "provider_credit:admin",
    },
    "operate": {"provider_credit:operate", "provider_credit:admin"},
    "admin": {"provider_credit:admin"},
}


# ── 工具函数 ──────────────────────────────────────────────────────


def _uuid_org_ids(raw_ids) -> set[str]:
    """从软引用 ID 集合中筛出可查 Organization 的合法 UUID。

    对账报告等审计类行可能写入哨兵值（如 ``__storage_reconcile__``），
    直接 ``id__in`` 会触发 UUIDField ValidationError。
    """
    valid: set[str] = set()
    for raw in raw_ids or ():
        if not raw:
            continue
        try:
            valid.add(str(uuid.UUID(str(raw))))
        except (TypeError, ValueError, AttributeError):
            continue
    return valid


def _require_admin(request):
    permissions = getattr(request, "admin_permissions", set())
    if "*" in permissions:
        return

    path = request.path.lower()
    method = request.method.upper()
    required = "billing_dashboard:view"

    if "/wallet" in path:
        if method == "GET":
            required = "wallet:view_transactions" if "/transactions" in path else "wallet:list"
        elif "recharge" in path:
            required = "wallet:recharge"
        else:
            required = "wallet:adjust"
    # /member-budget 必须在 /budget 之前：写接口不能落到默认 billing_dashboard:view。
    elif "/member-budget" in path:
        required = (
            "team_member:view_budget" if method == "GET" else "team_member:update_budget"
        )
    elif "/budget" in path:
        required = "budget_policy:list" if method == "GET" else "budget_policy:update"
    elif "/policy" in path or "/low-balance-config" in path:
        # 组织计费策略（自动补充）与低余额阈值：读写对齐 budget_policy 权限
        required = "budget_policy:list" if method == "GET" else "budget_policy:update"
    elif "/pricing" in path:
        required = "pricing_rule:list" if method == "GET" else "pricing_rule:update"
    elif "/provider-credit" in path:
        if method == "GET":
            _ensure_provider_credit_permission(request, "view")
        elif (
            (method == "POST" and path.endswith("/campaigns"))
            or (method == "POST" and path.endswith("/grants"))
            or path.endswith("/adjust")
        ):
            _ensure_provider_credit_permission(request, "operate")
        else:
            _ensure_provider_credit_permission(request, "admin")
        return
    elif "/membership" in path or "/tiers" in path:
        required = "plan:list" if method == "GET" else "plan:update"
    elif "/credit-packages" in path:
        if method == "GET":
            required = "credit_package:list"
        elif method == "POST":
            required = "credit_package:create"
        else:
            required = "credit_package:update"
    elif "/credit-ledger" in path:
        if method == "GET":
            required = "credit_ledger:view"
        else:
            # POST /credit-ledger/adjust 的细粒度权限由
            # admin_adjust_organization_credit_ledger 内部 action 映射校验。
            required = None
    elif "/addon-packages" in path:
        required = "addon_package:list" if method == "GET" else "addon_package:update"
    elif "/organization-cleanup" in path:
        required = "organization_cleanup:list" if method == "GET" else "organization_cleanup:retry"
    elif "/storage" in path:
        required = "storage_billing:list" if method == "GET" else "entitlement:update"
    elif "/events" in path:
        if "export" in path:
            required = "billing_event:export"
        elif method == "GET":
            required = "billing_event:list"
        else:
            required = "billing_event:retry"
    elif "/usage" in path:
        required = "usage_event:export" if "export" in path else "usage_event:list"
    elif "/invoice" in path or "/invoices" in path:
        if "refund" in path:
            required = "invoice:refund"
        elif "export" in path:
            required = "invoice:export"
        else:
            required = "invoice:list"
    elif "/payment-orders" in path:
        # 支付订单列表挂在「账单与对账」下，复用 invoice:list
        required = "invoice:list"
    elif "/reconciliation" in path:
        required = "reconciliation:list"
    elif "/anomal" in path:
        required = "anomaly_alert:resolve" if method != "GET" else "anomaly_alert:list"
    elif "/cost" in path:
        required = "cost_analysis:view"
    elif "/runtime-config" in path:
        required = "billing_runtime_config:update" if method != "GET" else "billing_runtime_config:view"
    elif "/audit" in path:
        required = "audit_log:list"

    if required and required not in permissions:
        raise HttpError(
            403,
            {
                "code": "ADMIN_PERMISSION_DENIED",
                "message": "缺少后台计费权限",
                "missing_permission": required,
            },
        )


def _ensure_admin_permission(request, permission_code: str) -> None:
    permissions = getattr(request, "admin_permissions", set())
    if "*" in permissions:
        return
    if permission_code not in permissions:
        raise HttpError(
            403,
            {
                "code": "ADMIN_PERMISSION_DENIED",
                "message": "缺少后台计费权限",
                "missing_permission": permission_code,
            },
        )


def _ensure_provider_credit_permission(request, level: str) -> None:
    permissions = getattr(request, "admin_permissions", set()) or set()
    if "*" in permissions:
        return
    allowed = _PROVIDER_CREDIT_PERMISSION_LEVELS[level]
    if not permissions.intersection(allowed):
        required = f"provider_credit:{level}"
        raise HttpError(
            403,
            {
                "code": "ADMIN_PERMISSION_DENIED",
                "message": "缺少 Provider Credit 后台权限",
                "missing_permission": required,
                "accepted_permissions": sorted(allowed),
            },
        )


def _record_provider_credit_write_audit(
    request,
    *,
    action: str,
    target_type: str,
    target_id: str,
    organization_id: str = "",
    detail: dict | None = None,
) -> BillingAdminAuditLog:
    """强保证写审计；调用方须把本函数放在业务 transaction.atomic 内。"""
    return BillingAdminAuditLog.objects.create(
        admin_user_id=str(getattr(getattr(request, "auth", None), "id", "")),
        action=action,
        target_type=target_type,
        target_id=str(target_id),
        organization_id=str(organization_id or ""),
        detail=detail or {},
        ip_address=get_client_ip(request) or "",
    )


from tabtin.pagination import paginate_queryset as _paginate


def _parse_time_range(qs, start_time: Optional[str], end_time: Optional[str], field: str = "occurred_at"):
    """对 QuerySet 应用时间范围过滤。"""
    if start_time:
        dt = parse_datetime(start_time)
        if dt:
            qs = qs.filter(**{f"{field}__gte": dt})
    if end_time:
        dt = parse_datetime(end_time)
        if dt:
            qs = qs.filter(**{f"{field}__lte": dt})
    return qs


def _serialize_organization_cleanup_job(job: OrganizationLifecycleCleanupJob) -> dict:
    return {
        "id": str(job.id),
        "organization_id": job.organization_id,
        "trigger_source": job.trigger_source,
        "status": job.status,
        "attempt_count": int(job.attempt_count or 0),
        "max_attempts": int(job.max_attempts or 0),
        "last_error": job.last_error,
        "next_retry_at": job.next_retry_at.isoformat() if job.next_retry_at else None,
        "started_at": job.started_at.isoformat() if job.started_at else None,
        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
        "last_success_summary": job.last_success_summary or {},
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "updated_at": job.updated_at.isoformat() if job.updated_at else None,
    }


def _serialize_provider_credit_campaign(campaign: ProviderCreditCampaign) -> dict:
    return {
        "id": str(campaign.id),
        "code": campaign.code,
        "name": campaign.name,
        "provider_key": campaign.provider_key,
        "eligible_model_ids": campaign.eligible_model_ids or [],
        "grant_credits": str(campaign.credits_amount),
        "credits_amount": str(campaign.credits_amount),
        "total_budget_credits": str(campaign.total_budget_credits),
        "granted_credits": str(campaign.granted_credits),
        "enabled": campaign.enabled,
        "trigger_type": campaign.trigger_type,
        "membership_plan_codes": campaign.membership_plan_codes or [],
        "status": campaign.status,
        "start_at": campaign.start_at.isoformat() if campaign.start_at else None,
        "end_at": campaign.end_at.isoformat() if campaign.end_at else None,
        "expire_days": campaign.expire_days,
        "metadata": campaign.metadata or {},
        "created_at": campaign.created_at.isoformat() if campaign.created_at else None,
        "updated_at": campaign.updated_at.isoformat() if campaign.updated_at else None,
    }


def _serialize_provider_credit_grant(grant: ProviderCreditGrant) -> dict:
    return {
        "id": str(grant.id),
        "organization": {
            "id": str(grant.organization_id),
            "name": getattr(getattr(grant, "organization", None), "name", ""),
        },
        "organization_id": str(grant.organization_id),
        "campaign": {
            "id": str(grant.campaign_id),
            "code": grant.campaign.code,
            "name": grant.campaign.name,
        },
        "campaign_id": str(grant.campaign_id),
        "campaign_code": grant.campaign.code,
        "provider_key": grant.provider_key,
        "eligible_model_ids": grant.eligible_model_ids or [],
        "total_credits": str(grant.total_credits),
        "consumed_credits": str(grant.consumed_credits),
        "remaining_credits": str(grant.remaining_credits),
        "status": grant.status,
        "grant_source": grant.grant_source,
        "trigger_type": grant.trigger_type,
        "effective_at": grant.effective_at.isoformat() if grant.effective_at else None,
        "expire_at": grant.expire_at.isoformat() if grant.expire_at else None,
        "metadata": grant.metadata or {},
        "created_at": grant.created_at.isoformat() if grant.created_at else None,
        "updated_at": grant.updated_at.isoformat() if grant.updated_at else None,
    }


def _serialize_provider_credit_transaction(
    credit_transaction: ProviderCreditTransaction,
) -> dict:
    organization = getattr(credit_transaction, "organization", None)
    campaign = getattr(getattr(credit_transaction, "grant", None), "campaign", None)
    return {
        "id": str(credit_transaction.id),
        "grant_id": str(credit_transaction.grant_id),
        "grant": {
            "id": str(credit_transaction.grant_id),
            "campaign_code": getattr(campaign, "code", "") or "",
            "campaign_name": getattr(campaign, "name", "") or "",
            "provider_key": credit_transaction.grant.provider_key,
        },
        "organization": {
            "id": str(credit_transaction.organization_id),
            "name": getattr(organization, "name", "") or "",
        },
        "organization_id": str(credit_transaction.organization_id),
        "transaction_type": credit_transaction.transaction_type,
        "amount": str(credit_transaction.amount),
        "balance_after": str(credit_transaction.balance_after),
        "reference_type": credit_transaction.reference_type,
        "reference_id": credit_transaction.reference_id,
        "idempotency_key": credit_transaction.idempotency_key,
        "metadata": credit_transaction.metadata or {},
        "created_at": (
            credit_transaction.created_at.isoformat()
            if credit_transaction.created_at
            else None
        ),
    }


def _build_organization_cleanup_job_stats() -> dict:
    now = timezone.now()
    stuck_running_cutoff = _get_organization_cleanup_stuck_running_cutoff(now)
    qs = OrganizationLifecycleCleanupJob.objects.all()
    counts = qs.aggregate(
        total=Count("id"),
        pending=Count("id", filter=Q(status="pending")),
        running=Count("id", filter=Q(status="running")),
        failed=Count("id", filter=Q(status="failed")),
        permanently_failed=Count("id", filter=Q(status="permanently_failed")),
        succeeded=Count("id", filter=Q(status="succeeded")),
        due_retry_jobs=Count(
            "id",
            filter=Q(status__in=["pending", "failed"])
            & (Q(next_retry_at__isnull=True) | Q(next_retry_at__lte=now)),
        ),
        stuck_running_jobs=Count(
            "id",
            filter=Q(status="running") & Q(started_at__lte=stuck_running_cutoff),
        ),
    )
    trigger_sources = {
        item["trigger_source"] or "unknown": item["count"]
        for item in qs.values("trigger_source").annotate(count=Count("id")).order_by("trigger_source")
    }
    recent_failed_jobs = [
        _serialize_organization_cleanup_job(job)
        for job in qs.filter(status__in=["failed", "permanently_failed"]).order_by("-updated_at")[:5]
    ]
    recent_succeeded_jobs = [
        _serialize_organization_cleanup_job(job)
        for job in qs.filter(status="succeeded").order_by("-updated_at")[:5]
    ]
    deleted_rows_last_7d = 0
    for job in qs.filter(status="succeeded", finished_at__gte=now - timedelta(days=7)):
        summary = job.last_success_summary or {}
        deleted_rows_last_7d += int(summary.get("total_deleted", 0) or 0)

    return {
        "counts": {key: int(value or 0) for key, value in counts.items()},
        "trigger_sources": trigger_sources,
        "recent_failed_jobs": recent_failed_jobs,
        "recent_succeeded_jobs": recent_succeeded_jobs,
        "deleted_rows_last_7d": deleted_rows_last_7d,
    }


def _get_organization_cleanup_stuck_running_cutoff(now=None):
    from .services import OrganizationLifecycleCleanupService

    now = now or timezone.now()
    return now - timedelta(minutes=OrganizationLifecycleCleanupService.STUCK_RUNNING_MINUTES)


def _apply_organization_cleanup_job_filters(
    qs,
    *,
    status: Optional[str] = None,
    organization_id: Optional[str] = None,
    trigger_source: Optional[str] = None,
    keyword: Optional[str] = None,
    due_only: bool = False,
    stuck_only: bool = False,
):
    now = timezone.now()
    if status:
        qs = qs.filter(status=status)
    if organization_id:
        qs = qs.filter(organization_id__icontains=organization_id.strip())
    if trigger_source:
        qs = qs.filter(trigger_source__icontains=trigger_source.strip())
    if due_only:
        qs = qs.filter(status__in=["pending", "failed"]).filter(
            Q(next_retry_at__isnull=True) | Q(next_retry_at__lte=now)
        )
    if stuck_only:
        qs = qs.filter(
            status="running",
            started_at__isnull=False,
            started_at__lte=_get_organization_cleanup_stuck_running_cutoff(now),
        )
    if keyword:
        keyword = keyword.strip()
        if keyword:
            qs = qs.filter(
                Q(id__icontains=keyword)
                | Q(organization_id__icontains=keyword)
                | Q(trigger_source__icontains=keyword)
                | Q(last_error__icontains=keyword)
            )
    return qs


def _build_organization_cleanup_job_list_summary(qs) -> dict:
    now = timezone.now()
    stuck_running_cutoff = _get_organization_cleanup_stuck_running_cutoff(now)
    counts = qs.aggregate(
        total=Count("id"),
        pending=Count("id", filter=Q(status="pending")),
        running=Count("id", filter=Q(status="running")),
        failed=Count("id", filter=Q(status="failed")),
        permanently_failed=Count("id", filter=Q(status="permanently_failed")),
        succeeded=Count("id", filter=Q(status="succeeded")),
        due_retry_jobs=Count(
            "id",
            filter=Q(status__in=["pending", "failed"])
            & (Q(next_retry_at__isnull=True) | Q(next_retry_at__lte=now)),
        ),
        stuck_running_jobs=Count(
            "id",
            filter=Q(status="running") & Q(started_at__lte=stuck_running_cutoff),
        ),
    )
    organization_count = qs.values("organization_id").exclude(organization_id="").distinct().count()
    trigger_sources = {
        item["trigger_source"] or "unknown": item["count"]
        for item in qs.values("trigger_source").annotate(count=Count("id")).order_by("trigger_source")
    }
    latest_job = qs.order_by("-updated_at").first()
    return {
        "counts": {key: int(value or 0) for key, value in counts.items()},
        "organization_count": int(organization_count or 0),
        "trigger_sources": trigger_sources,
        "latest_updated_at": latest_job.updated_at.isoformat() if latest_job and latest_job.updated_at else None,
    }


class OrganizationCleanupJobRunDueRequest(Schema):
    limit: int = 50
    recover_stuck: bool = True


class OrganizationCleanupJobRetryRequest(Schema):
    reason: str
    ticket_id: str = ""


# ── 钱包管理 ──────────────────────────────────────────────────────


@router.get("/admin/wallets/organizations")
@billing_api_errors
def admin_list_organization_wallets(
    request,
    keyword: Optional[str] = None,
    order_by: Optional[str] = None,
    page: int = 1,
    page_size: int = 50,
):
    _require_admin(request)

    qs = OrganizationWallet.objects.all()
    qs = apply_ordering(qs, order_by, _WS_WALLET_SORT)
    if keyword:
        qs = qs.filter(Q(organization_id=keyword) | Q(id__icontains=keyword))

    wallets, meta = _paginate(qs, page, page_size)

    items = []
    for w in wallets:
        items.append({
            "id": str(w.id),
            "organization_id": w.organization_id,
            "credits": w.credits,
            "credits_precise": str(safe_decimal(w.credits_precise)),
            "credits_frozen": w.credits_frozen,
            "credits_frozen_precise": str(safe_decimal(w.credits_frozen_precise)),
            "updated_at": w.updated_at.isoformat() if w.updated_at else None,
        })

    return success_response(data={"wallets": items, **meta})


@router.get("/admin/wallets/{wallet_id}")
@billing_api_errors
def admin_get_wallet_detail(
    request,
    wallet_id: str,
    tx_page: int = 1,
    tx_page_size: int = 30,
    transaction_type: Optional[str] = None,
):
    _require_admin(request)

    organization_wallet = OrganizationWallet.objects.filter(id=wallet_id).first()
    if not organization_wallet:
        raise HttpError(404, _("billing.wallet_not_found"))

    info = {
        "id": str(organization_wallet.id),
        "type": "organization",
        "organization_id": organization_wallet.organization_id,
        "credits": organization_wallet.credits,
        "credits_precise": str(safe_decimal(organization_wallet.credits_precise)),
        "credits_frozen": organization_wallet.credits_frozen,
        "credits_frozen_precise": str(safe_decimal(organization_wallet.credits_frozen_precise)),
        "created_at": organization_wallet.created_at.isoformat() if organization_wallet.created_at else None,
        "updated_at": organization_wallet.updated_at.isoformat() if organization_wallet.updated_at else None,
    }

    tx_qs = WalletTransaction.objects.filter(organization_wallet=organization_wallet).order_by("-created_at")
    if transaction_type:
        tx_qs = tx_qs.filter(transaction_type=transaction_type)

    transactions, tx_meta = _paginate(tx_qs, tx_page, tx_page_size, max_size=100)

    from apps.users.auth.models import User as AuthUser
    operator_ids = {tx.operator_user_id for tx in transactions if tx.operator_user_id}
    operator_name_map: dict[str, str] = {}
    if operator_ids:
        for u in AuthUser.objects.filter(id__in=operator_ids).only("id", "nickname", "username"):
            operator_name_map[str(u.id)] = u.nickname or u.username or str(u.id)[:8]

    tx_items = []
    for tx in transactions:
        tx_items.append({
            "id": str(tx.id),
            "transaction_type": tx.transaction_type,
            "amount": tx.amount,
            "amount_precise": str(safe_decimal(tx.amount_precise)),
            "balance_before": tx.balance_before,
            "balance_before_precise": str(safe_decimal(tx.balance_before_precise)),
            "balance_after": tx.balance_after,
            "balance_after_precise": str(safe_decimal(tx.balance_after_precise)),
            "description": tx.description,
            "operator_user_id": tx.operator_user_id,
            "operator_display_name": operator_name_map.get(tx.operator_user_id, ""),
            "related_order_id": tx.related_order_id,
            "organization_id": tx.organization_id,
            "created_at": tx.created_at.isoformat() if tx.created_at else None,
        })

    return success_response(data={
        "wallet": info,
        "transactions": {"items": tx_items, **tx_meta},
    })


@router.get("/admin/billing/organizations/{organization_id}/usage-dashboard")
@billing_api_errors
def admin_get_organization_usage_dashboard(
    request,
    organization_id: str,
    days: int = 30,
):
    """只读：对齐 Electron「用量中心」仪表盘。"""
    _require_admin(request)

    normalized_organization_id = (organization_id or "").strip()
    if not normalized_organization_id:
        raise HttpError(400, "organization_id required")

    from .services.usage_dashboard_builder import build_organization_usage_dashboard_data

    return success_response(
        data=build_organization_usage_dashboard_data(
            normalized_organization_id,
            days=days,
        )
    )


@router.get("/admin/billing/organizations/{organization_id}/service-catalog")
@billing_api_errors
def admin_get_organization_service_catalog(request, organization_id: str):
    """只读：对齐 Electron「计费规则」服务目录价目。"""
    _require_admin(request)

    normalized_organization_id = (organization_id or "").strip()
    if not normalized_organization_id:
        raise HttpError(400, "organization_id required")

    from .api_service_catalog import build_service_catalog_data

    return success_response(data=build_service_catalog_data(normalized_organization_id))


def _serialize_admin_member_budget_policy(policy: MemberLlmBudgetPolicy) -> dict:
    return {
        "id": str(policy.id),
        "organization_id": policy.organization_id,
        "user_id": None if policy.user_id == MEMBER_BUDGET_SENTINEL else policy.user_id,
        "target_role": None if policy.target_role == MEMBER_BUDGET_SENTINEL else policy.target_role,
        "monthly_credits_limit": (
            str(safe_decimal(policy.monthly_credits_limit))
            if policy.monthly_credits_limit is not None
            else None
        ),
        "daily_credits_limit": (
            str(safe_decimal(policy.daily_credits_limit))
            if policy.daily_credits_limit is not None
            else None
        ),
        "max_model_tier": policy.max_model_tier,
        "is_active": policy.is_active,
        "created_at": policy.created_at.isoformat() if policy.created_at else None,
        "updated_at": policy.updated_at.isoformat() if policy.updated_at else None,
    }


class AdminMemberBudgetUpsertIn(Schema):
    user_id: Optional[str] = None
    target_role: Optional[str] = None
    monthly_credits_limit: Optional[Decimal] = None
    daily_credits_limit: Optional[Decimal] = None
    max_model_tier: str = "enterprise"
    is_active: bool = True
    reason: str
    ticket_id: Optional[str] = ""


class AdminMemberBudgetExemptRolesIn(Schema):
    exempt_roles: list[str]
    reason: str
    ticket_id: Optional[str] = ""


class AdminMemberBudgetDeleteIn(Schema):
    reason: str
    ticket_id: Optional[str] = ""


@router.get("/admin/billing/organizations/{organization_id}/member-budget")
@billing_api_errors
def admin_get_organization_member_budget(request, organization_id: str):
    """对齐 Electron「成员与额度」：默认策略 + 豁免角色 + 全部策略列表。"""
    _require_admin(request)

    normalized_organization_id = (organization_id or "").strip()
    if not normalized_organization_id:
        raise HttpError(400, "organization_id required")

    policies = list(
        MemberLlmBudgetPolicy.objects.filter(
            organization_id=normalized_organization_id,
        ).order_by("-updated_at")
    )
    default_policy = next(
        (
            p
            for p in policies
            if p.user_id == MEMBER_BUDGET_SENTINEL and p.target_role == MEMBER_BUDGET_SENTINEL
        ),
        None,
    )

    billing_policy = OrganizationBillingPolicy.objects.filter(
        organization_id=normalized_organization_id,
    ).first()
    exempt_roles = []
    if billing_policy and billing_policy.metadata:
        raw = billing_policy.metadata.get("member_budget_exempt_roles", [])
        if isinstance(raw, list):
            exempt_roles = [str(r) for r in raw if r]

    default_payload = None
    if default_policy is not None:
        default_payload = {
            "id": str(default_policy.id),
            "monthly_credits_limit": (
                str(safe_decimal(default_policy.monthly_credits_limit))
                if default_policy.monthly_credits_limit is not None
                else None
            ),
            "daily_credits_limit": (
                str(safe_decimal(default_policy.daily_credits_limit))
                if default_policy.daily_credits_limit is not None
                else None
            ),
            "max_model_tier": default_policy.max_model_tier,
            "is_active": default_policy.is_active,
            "updated_at": (
                default_policy.updated_at.isoformat() if default_policy.updated_at else None
            ),
        }

    return success_response(
        data={
            "organization_id": normalized_organization_id,
            "default_policy": default_payload,
            "exempt_roles": exempt_roles,
            # 与客户端一致：Owner+Admin 均豁免时视为「管理员豁免」开启
            "admin_exempt": ("owner" in exempt_roles and "admin" in exempt_roles),
            "policies": [_serialize_admin_member_budget_policy(p) for p in policies],
        }
    )


@router.put("/admin/billing/organizations/{organization_id}/member-budget")
@billing_api_errors
def admin_upsert_organization_member_budget(
    request,
    organization_id: str,
    data: AdminMemberBudgetUpsertIn,
):
    """写入默认/个人成员预算策略（运维代操作）。"""
    _require_admin(request)
    _ensure_admin_permission(request, "team_member:update_budget")
    reason = (data.reason or "").strip()
    if not reason:
        raise HttpError(400, "reason 不能为空")
    ticket_id = (data.ticket_id or "").strip()

    normalized_organization_id = (organization_id or "").strip()
    if not normalized_organization_id:
        raise HttpError(400, "organization_id required")

    if data.user_id and data.target_role:
        raise HttpError(400, "不能同时指定 user_id 和 target_role")

    valid_roles = {r[0] for r in MemberLlmBudgetPolicy.ROLE_CHOICES}
    if data.target_role and data.target_role not in valid_roles:
        raise HttpError(400, f"无效的角色: {data.target_role}")

    valid_tiers = {t[0] for t in MemberLlmBudgetPolicy.MODEL_TIER_CHOICES}
    if data.max_model_tier not in valid_tiers:
        raise HttpError(400, f"无效的模型等级: {data.max_model_tier}")

    if data.monthly_credits_limit is not None and data.monthly_credits_limit < 0:
        raise HttpError(400, "monthly_credits_limit 不能为负")
    if data.daily_credits_limit is not None and data.daily_credits_limit < 0:
        raise HttpError(400, "daily_credits_limit 不能为负")
    if (
        data.daily_credits_limit is not None
        and data.monthly_credits_limit is not None
        and data.daily_credits_limit > 0
        and data.monthly_credits_limit > 0
        and data.daily_credits_limit > data.monthly_credits_limit
    ):
        raise HttpError(400, "日额度不能大于月额度")

    from apps.services.billing.services.member_budget_service import MemberBudgetService

    policy = MemberBudgetService.upsert_policy(
        organization_id=normalized_organization_id,
        user_id=data.user_id,
        target_role=data.target_role,
        monthly_credits_limit=data.monthly_credits_limit,
        daily_credits_limit=data.daily_credits_limit,
        max_model_tier=data.max_model_tier,
        is_active=data.is_active,
    )
    payload = _serialize_admin_member_budget_policy(policy)
    record_admin_sensitive_action(
        request,
        permission_code="team_member:update_budget",
        action="organization.member_budget.upsert",
        target_type="member_budget_policy",
        target_id=str(policy.id),
        reason=reason,
        ticket_id=ticket_id,
        after_json=payload,
    )
    return success_response(data=payload, message="成员预算策略已保存")


@router.patch("/admin/billing/organizations/{organization_id}/member-budget/exempt-roles")
@billing_api_errors
def admin_patch_organization_member_budget_exempt_roles(
    request,
    organization_id: str,
    data: AdminMemberBudgetExemptRolesIn,
):
    """更新成员预算豁免角色。"""
    _require_admin(request)
    _ensure_admin_permission(request, "team_member:update_budget")
    reason = (data.reason or "").strip()
    if not reason:
        raise HttpError(400, "reason 不能为空")
    ticket_id = (data.ticket_id or "").strip()

    normalized_organization_id = (organization_id or "").strip()
    if not normalized_organization_id:
        raise HttpError(400, "organization_id required")

    valid_roles = {r[0] for r in MemberLlmBudgetPolicy.ROLE_CHOICES}
    normalized: list[str] = []
    seen: set[str] = set()
    for role in data.exempt_roles or []:
        r = str(role or "").strip()
        if not r:
            raise HttpError(400, "exempt_roles 含空项")
        if r not in valid_roles:
            raise HttpError(400, f"无效的角色: {r}")
        if r not in seen:
            seen.add(r)
            normalized.append(r)

    from apps.services.billing.services.member_budget_service import MemberBudgetService

    with db_transaction.atomic():
        policy = (
            OrganizationBillingPolicy.objects.select_for_update()
            .filter(organization_id=normalized_organization_id)
            .first()
        )
        before = []
        if policy and policy.metadata:
            raw = policy.metadata.get("member_budget_exempt_roles", [])
            if isinstance(raw, list):
                before = [str(r) for r in raw if r]
        md = dict(policy.metadata) if policy and policy.metadata else {}
        md["member_budget_exempt_roles"] = normalized
        if policy:
            policy.metadata = md
            policy.save(update_fields=["metadata", "updated_at"])
        else:
            OrganizationBillingPolicy.objects.create(
                organization_id=normalized_organization_id,
                metadata=md,
            )

        wt = normalized_organization_id

        def _on_commit():
            MemberBudgetService._invalidate_policy_caches(wt, MEMBER_BUDGET_SENTINEL)
            MemberBudgetService._publish_member_budget_resolved(
                wt, MEMBER_BUDGET_SENTINEL, action="exempt_roles_updated",
            )

        db_transaction.on_commit(_on_commit)

    payload = {
        "organization_id": normalized_organization_id,
        "exempt_roles": normalized,
        "admin_exempt": ("owner" in normalized and "admin" in normalized),
    }
    record_admin_sensitive_action(
        request,
        permission_code="team_member:update_budget",
        action="organization.member_budget.exempt_roles",
        target_type="organization",
        target_id=normalized_organization_id,
        reason=reason,
        ticket_id=ticket_id,
        before_json={"exempt_roles": before},
        after_json=payload,
    )
    return success_response(data=payload, message="豁免角色已更新")


@router.post("/admin/billing/organizations/{organization_id}/member-budget/policies/{policy_id}/delete")
@billing_api_errors
def admin_delete_organization_member_budget_policy(
    request,
    organization_id: str,
    policy_id: str,
    data: AdminMemberBudgetDeleteIn,
):
    """删除个人/角色预算策略（重置为默认）。"""
    _require_admin(request)
    _ensure_admin_permission(request, "team_member:update_budget")
    reason = (data.reason or "").strip()
    if not reason:
        raise HttpError(400, "reason 不能为空")
    ticket_id = (data.ticket_id or "").strip()

    normalized_organization_id = (organization_id or "").strip()
    policy = MemberLlmBudgetPolicy.objects.filter(
        id=policy_id,
        organization_id=normalized_organization_id,
    ).first()
    if not policy:
        raise HttpError(404, "策略不存在")

    before = _serialize_admin_member_budget_policy(policy)
    from apps.services.billing.services.member_budget_service import MemberBudgetService

    MemberBudgetService.delete_policy(str(policy.id))
    record_admin_sensitive_action(
        request,
        permission_code="team_member:update_budget",
        action="organization.member_budget.delete",
        target_type="member_budget_policy",
        target_id=str(policy_id),
        reason=reason,
        ticket_id=ticket_id,
        before_json=before,
        after_json={"deleted": True},
    )
    return success_response(data=before, message="成员预算策略已删除")


class AdminOrganizationAutoTopupPolicyIn(Schema):
    """Staff 代配：仅写入自动补充相关字段（对齐 Electron Owner AI 成本）。"""

    auto_topup_enabled: Optional[bool] = None
    auto_topup_spend_yuan: Optional[Decimal] = None
    auto_topup_threshold_credits: Optional[Decimal] = None
    auto_topup_monthly_cap_yuan: Optional[Decimal] = None
    reason: str
    ticket_id: str = ""


class AdminLowBalanceConfigIn(Schema):
    warning_credits: Optional[Decimal] = None
    critical_credits: Optional[Decimal] = None
    email_enabled: Optional[bool] = None
    reason: str
    ticket_id: str = ""


def _admin_auto_topup_spent_yuan(organization_id: str) -> str:
    from datetime import date as date_cls

    from .services.llm_topup_service import LlmQuotaTopupService

    today = timezone.localdate()
    cycle_month = date_cls(today.year, today.month, 1)
    return str(LlmQuotaTopupService._current_month_auto_topup_yuan(organization_id, cycle_month))


@router.get("/admin/billing/organizations/{organization_id}/policy")
@billing_api_errors
def admin_get_organization_billing_policy(request, organization_id: str):
    """Staff 只读：组织计费策略（含 auto_topup_*）+ 本月已补充现金。"""
    _require_admin(request)

    normalized_organization_id = (organization_id or "").strip()
    if not normalized_organization_id:
        raise HttpError(400, "organization_id required")

    from .api import _serialize_policy

    policy = OrganizationBillingPolicy.objects.filter(
        organization_id=normalized_organization_id,
    ).first()
    payload = _serialize_policy(policy, normalized_organization_id)
    payload["auto_topup_spent_yuan"] = _admin_auto_topup_spent_yuan(normalized_organization_id)
    return success_response(data=payload)


@router.put("/admin/billing/organizations/{organization_id}/policy")
@billing_api_errors
def admin_update_organization_billing_policy(
    request,
    organization_id: str,
    data: AdminOrganizationAutoTopupPolicyIn,
):
    """Staff 代写：更新组织自动补充策略（原因必填，进敏感操作审计）。"""
    _require_admin(request)

    normalized_organization_id = (organization_id or "").strip()
    if not normalized_organization_id:
        raise HttpError(400, "organization_id required")

    reason = (data.reason or "").strip()
    if not reason:
        raise HttpError(400, {"code": "REASON_REQUIRED", "message": "reason 不能为空"})

    for field_name in (
        "auto_topup_spend_yuan",
        "auto_topup_threshold_credits",
        "auto_topup_monthly_cap_yuan",
    ):
        value = getattr(data, field_name)
        if value is not None and value < 0:
            raise HttpError(400, f"{field_name} 不能为负数")

    from .api import _serialize_policy
    from .services.policy_service import OrganizationBillingPolicyService

    existing = OrganizationBillingPolicy.objects.filter(
        organization_id=normalized_organization_id,
    ).first()
    before_json = _serialize_policy(existing, normalized_organization_id)

    def _pick(field_name: str, service_default):
        value = getattr(data, field_name)
        if value is not None:
            return value
        return getattr(existing, field_name) if existing else service_default

    defaults = {
        "storage_billing_mode": (
            existing.storage_billing_mode
            if existing
            else OrganizationBillingPolicyService.DEFAULT_STORAGE_BILLING_MODE
        ),
        "llm_billing_mode": (
            existing.llm_billing_mode
            if existing
            else OrganizationBillingPolicyService.DEFAULT_LLM_BILLING_MODE
        ),
        "currency": (
            existing.currency if existing else OrganizationBillingPolicyService.DEFAULT_CURRENCY
        ),
        "is_active": existing.is_active if existing else True,
        "metadata": existing.metadata if existing else {},
        "auto_topup_enabled": bool(
            _pick("auto_topup_enabled", OrganizationBillingPolicyService.DEFAULT_AUTO_TOPUP_ENABLED)
        ),
        "auto_topup_spend_yuan": _pick(
            "auto_topup_spend_yuan",
            OrganizationBillingPolicyService.DEFAULT_AUTO_TOPUP_SPEND_YUAN,
        ),
        "auto_topup_threshold_credits": _pick(
            "auto_topup_threshold_credits",
            OrganizationBillingPolicyService.DEFAULT_AUTO_TOPUP_THRESHOLD_CREDITS,
        ),
        "auto_topup_monthly_cap_yuan": _pick(
            "auto_topup_monthly_cap_yuan",
            OrganizationBillingPolicyService.DEFAULT_AUTO_TOPUP_MONTHLY_CAP_YUAN,
        ),
    }
    policy, _created = OrganizationBillingPolicy.objects.update_or_create(
        organization_id=normalized_organization_id,
        defaults=defaults,
    )
    after_json = _serialize_policy(policy, normalized_organization_id)
    after_json["auto_topup_spent_yuan"] = _admin_auto_topup_spent_yuan(normalized_organization_id)

    record_admin_sensitive_action(
        request,
        permission_code="budget_policy:update",
        action="billing.organization_policy.auto_topup.update",
        target_type="organization",
        target_id=normalized_organization_id,
        reason=reason,
        ticket_id=(data.ticket_id or "").strip(),
        before_json=before_json,
        after_json=after_json,
    )
    return success_response(data=after_json)


@router.get("/admin/billing/organizations/{organization_id}/low-balance-config")
@billing_api_errors
def admin_get_organization_low_balance_config(request, organization_id: str):
    """Staff 只读：低余额预警阈值。"""
    _require_admin(request)

    normalized_organization_id = (organization_id or "").strip()
    if not normalized_organization_id:
        raise HttpError(400, "organization_id required")

    from .api import _low_balance_config_payload
    from .services.low_balance_alert_service import LowBalanceAlertService

    thresholds = LowBalanceAlertService.get_thresholds(normalized_organization_id)
    return success_response(
        data=_low_balance_config_payload(normalized_organization_id, thresholds),
    )


@router.put("/admin/billing/organizations/{organization_id}/low-balance-config")
@billing_api_errors
def admin_update_organization_low_balance_config(
    request,
    organization_id: str,
    data: AdminLowBalanceConfigIn,
):
    """Staff 代写：更新低余额预警阈值（原因必填，进敏感操作审计）。"""
    _require_admin(request)

    normalized_organization_id = (organization_id or "").strip()
    if not normalized_organization_id:
        raise HttpError(400, "organization_id required")

    reason = (data.reason or "").strip()
    if not reason:
        raise HttpError(400, {"code": "REASON_REQUIRED", "message": "reason 不能为空"})

    if data.warning_credits is not None and data.warning_credits < 0:
        raise HttpError(400, "warning_credits 不能为负数")
    if data.critical_credits is not None and data.critical_credits < 0:
        raise HttpError(400, "critical_credits 不能为负数")
    if (
        data.warning_credits is not None
        and data.critical_credits is not None
        and data.critical_credits >= data.warning_credits
    ):
        raise HttpError(400, "critical_credits 必须小于 warning_credits")

    from .api import _low_balance_config_payload
    from .services.low_balance_alert_service import LowBalanceAlertService

    before_thresholds = LowBalanceAlertService.get_thresholds(
        normalized_organization_id,
    )
    before = _low_balance_config_payload(
        normalized_organization_id,
        before_thresholds,
    )
    thresholds = LowBalanceAlertService.set_thresholds(
        normalized_organization_id,
        warning_credits=data.warning_credits,
        critical_credits=data.critical_credits,
        email_enabled=data.email_enabled,
    )
    after = _low_balance_config_payload(normalized_organization_id, thresholds)

    # 仅 warning/critical 绝对值真变时补检；同值保存或只改邮件不清去重、不重复通知
    if LowBalanceAlertService.did_credit_thresholds_change(
        before_thresholds,
        thresholds,
    ):
        try:
            LowBalanceAlertService.recheck_after_threshold_change(
                normalized_organization_id,
            )
        except Exception:
            logger.warning(
                "admin low-balance-config 保存后补检失败（配置已保存）: organization_id=%s",
                normalized_organization_id,
                exc_info=True,
            )

    record_admin_sensitive_action(
        request,
        permission_code="budget_policy:update",
        action="billing.organization_low_balance_config.update",
        target_type="organization",
        target_id=normalized_organization_id,
        reason=reason,
        ticket_id=(data.ticket_id or "").strip(),
        before_json=before,
        after_json=after,
    )
    return success_response(data=after)


_CREDIT_EXPLANATION_LIMIT_DEFAULT = 50
_CREDIT_EXPLANATION_LIMIT_MAX = 100


def _credit_explanation_month_bounds(month: Optional[str]):
    today = timezone.localdate()
    if month and len(month) != 7:
        raise HttpError(400, "month must be YYYY-MM")
    month_date = parse_date(f"{month}-01") if month else None
    if month and month_date is None:
        raise HttpError(400, "month must be YYYY-MM")
    cycle_month = (month_date or today).replace(day=1)
    period_start = datetime.combine(cycle_month, time.min, tzinfo=timezone.get_current_timezone())
    if cycle_month.month == 12:
        next_month = cycle_month.replace(year=cycle_month.year + 1, month=1)
    else:
        next_month = cycle_month.replace(month=cycle_month.month + 1)
    period_end = datetime.combine(next_month, time.min, tzinfo=timezone.get_current_timezone())
    return cycle_month, period_start, period_end


def _clamp_credit_explanation_limit(limit: Optional[int]) -> int:
    try:
        value = int(limit) if limit is not None else _CREDIT_EXPLANATION_LIMIT_DEFAULT
    except (TypeError, ValueError):
        value = _CREDIT_EXPLANATION_LIMIT_DEFAULT
    return max(1, min(value, _CREDIT_EXPLANATION_LIMIT_MAX))


def _wallet_tx_organization_id(tx: WalletTransaction) -> str:
    if getattr(tx, "organization_id", None):
        return str(tx.organization_id)
    wallet = getattr(tx, "organization_wallet", None)
    if wallet is not None and getattr(wallet, "organization_id", None):
        return str(wallet.organization_id)
    return ""


def _serialize_credit_explanation_transaction(tx: WalletTransaction) -> dict:
    org_id = _wallet_tx_organization_id(tx)
    return {
        "id": str(tx.id),
        "organization_id": org_id,
        "transaction_type": tx.transaction_type,
        "amount_precise": str(safe_decimal(tx.amount_precise)),
        "balance_after_precise": str(safe_decimal(tx.balance_after_precise)),
        "description": tx.description,
        "related_order_id": tx.related_order_id,
        "operator_user_id": tx.operator_user_id,
        "usage_event_id": getattr(tx, "usage_event_id", "") or "",
        "created_at": tx.created_at.isoformat() if tx.created_at else None,
        "trace_hints": {
            "related_order_id": tx.related_order_id,
            "description": tx.description,
        },
    }


def _serialize_credit_explanation_usage_event(event: BillingUsageEvent) -> dict:
    return {
        "id": str(event.id),
        "organization_id": event.organization_id,
        "user_id": event.user_id,
        "meter_key": event.meter_key,
        "amount": str(safe_decimal(event.amount)),
        "provider_key": event.provider_key,
        "model_name": event.model_name,
        "biz_type": event.biz_type,
        "biz_id": event.biz_id,
        "scene_key": event.scene_key,
        "scene_label": _scene_label(event.scene_key),
        "occurred_at": event.occurred_at.isoformat() if event.occurred_at else None,
    }


def _build_credit_explanation(
    *,
    organization_id: Optional[str] = None,
    month: Optional[str] = None,
    limit: Optional[int] = None,
) -> dict:
    """只读聚合 credits 解释链；organization_id 为空时跨组织列表。"""
    normalized_organization_id = (organization_id or "").strip()
    list_limit = _clamp_credit_explanation_limit(limit)
    cycle_month, period_start, period_end = _credit_explanation_month_bounds(month)

    wallet_data = None
    recent_transactions: list[dict] = []
    if normalized_organization_id:
        wallet = OrganizationWallet.objects.filter(organization_id=normalized_organization_id).first()
        if wallet:
            wallet_data = {
                "id": str(wallet.id),
                "organization_id": wallet.organization_id,
                "credits_precise": str(safe_decimal(wallet.credits_precise)),
                "credits_frozen_precise": str(safe_decimal(wallet.credits_frozen_precise)),
                "updated_at": wallet.updated_at.isoformat() if wallet.updated_at else None,
            }
            tx_qs = (
                WalletTransaction.objects.filter(organization_wallet=wallet)
                .select_related("organization_wallet", "organization")
                .order_by("-created_at")[:list_limit]
            )
            recent_transactions = [_serialize_credit_explanation_transaction(tx) for tx in tx_qs]
    else:
        tx_qs = (
            WalletTransaction.objects.select_related("organization_wallet", "organization")
            .order_by("-created_at")[:list_limit]
        )
        recent_transactions = [_serialize_credit_explanation_transaction(tx) for tx in tx_qs]

    usage_qs = BillingUsageEvent.objects.filter(
        occurred_at__gte=period_start,
        occurred_at__lt=period_end,
    )
    if normalized_organization_id:
        usage_qs = usage_qs.filter(organization_id=normalized_organization_id)
    usage_summary = usage_qs.aggregate(
        total_events=Count("id"),
        total_amount=Coalesce(Sum("amount"), Decimal("0")),
    )
    recent_usage_events = [
        _serialize_credit_explanation_usage_event(event)
        for event in usage_qs.order_by("-occurred_at")[:list_limit]
    ]

    llm_budget = None
    entitlement = None
    member_policy_count = 0
    member_usage_count = 0
    if normalized_organization_id:
        llm_budget = OrganizationLlmMonthlyBudget.objects.filter(
            organization_id=normalized_organization_id,
            cycle_month=cycle_month,
        ).first()
        entitlement = OrganizationBillingEntitlement.objects.filter(
            organization_id=normalized_organization_id,
        ).order_by("-updated_at").first()
        member_policy_count = MemberLlmBudgetPolicy.objects.filter(
            organization_id=normalized_organization_id,
            is_active=True,
        ).count()
        member_usage_count = MemberLlmUsageCounter.objects.filter(
            organization_id=normalized_organization_id,
            cycle_date=cycle_month,
            cycle_type="monthly",
        ).count()

    invoice_qs = BillingInvoice.objects.order_by("-created_at")
    if normalized_organization_id:
        invoice_qs = invoice_qs.filter(organization_id=normalized_organization_id)
    invoices = [
        {
            "id": str(invoice.id),
            "organization_id": invoice.organization_id,
            "invoice_no": invoice.invoice_no,
            "status": invoice.status,
            "total_amount": str(safe_decimal(invoice.total_amount)),
            "issued_at": invoice.issued_at.isoformat() if invoice.issued_at else None,
            "period_start": invoice.period_start.isoformat() if invoice.period_start else None,
            "period_end": invoice.period_end.isoformat() if invoice.period_end else None,
        }
        for invoice in invoice_qs[:list_limit]
    ]

    reconciliation_qs = BillingReconciliationReport.objects.order_by("-created_at")
    if normalized_organization_id:
        reconciliation_qs = reconciliation_qs.filter(organization_id=normalized_organization_id)
    reconciliations = [
        {
            "id": str(report.id),
            "organization_id": report.organization_id,
            "report_date": report.report_date.isoformat() if report.report_date else None,
            "status": report.status,
            "billing_total": str(safe_decimal(report.billing_total)),
            "wallet_total": str(safe_decimal(report.wallet_total)),
            "diff_amount": str(safe_decimal(report.diff_amount)),
            "detail_json": report.detail_json or {},
        }
        for report in reconciliation_qs[:list_limit]
    ]

    payment_order_status = "ok"
    payment_orders = []
    try:
        order_qs = PaymentOrder.objects.order_by("-created_at")
        if normalized_organization_id:
            order_qs = order_qs.filter(organization_id=normalized_organization_id)
        for order in order_qs[:list_limit]:
            payment_orders.append({
                "id": str(order.id),
                "organization_id": order.organization_id,
                "order_no": order.order_no,
                "order_type": order.order_type,
                "status": order.status,
                "payment_method": order.payment_method,
                "payment_amount_cash": str(safe_decimal(order.amount)),
                "paid_amount_cash": str(safe_decimal(order.paid_amount)),
                "paid_at": order.paid_at.isoformat() if order.paid_at else None,
                "created_at": order.created_at.isoformat() if order.created_at else None,
            })
    except Exception:
        payment_order_status = "degraded"
        logger.warning("[BillingAdmin] payment order explanation degraded", exc_info=True)

    gaps = [
        "WalletTransaction 是当前credits账本；OrganizationCreditLedger 独立表不存在。",
        "PaymentOrder 可查但尚未形成完整 Admin 处理闭环。",
        "成员 AI limit 运行时模型存在，本页只读摘要，Admin 修改入口未接入。",
    ]
    if not normalized_organization_id:
        gaps.append("当前为全组织列表；组织级余额/套餐摘要需填写 Organization ID 后查看。")
    if payment_order_status == "degraded":
        gaps.append("PaymentOrder 查询降级，当前列表不能代表真实无订单。")

    monthly_budget = None
    if llm_budget:
        monthly_budget = {
            "id": str(llm_budget.id),
            "cycle_month": llm_budget.cycle_month.isoformat() if llm_budget.cycle_month else None,
            "included_credits": str(safe_decimal(llm_budget.included_credits)),
            "consumed_credits": str(safe_decimal(llm_budget.consumed_credits)),
            "overflow_credits": str(safe_decimal(llm_budget.overflow_credits)),
        }

    return {
        "organization_id": normalized_organization_id or None,
        "scope": "organization" if normalized_organization_id else "all",
        "month": cycle_month.strftime("%Y-%m"),
        "limit": list_limit,
        "copy": {
            "wallet_kind": "credits 钱包，不是人民币余额",
            "cash_wallet_status": "当前未接入 Cash Wallet",
        },
        "wallet": wallet_data,
        "entitlement": {
            "id": str(entitlement.id) if entitlement else None,
            "included_llm_credits_monthly": (
                str(safe_decimal(entitlement.included_llm_credits_monthly)) if entitlement else "0"
            ),
            "updated_at": entitlement.updated_at.isoformat() if entitlement and entitlement.updated_at else None,
        },
        "monthly_budget": monthly_budget,
        "usage_summary": {
            "total_events": int(usage_summary.get("total_events") or 0),
            "total_amount": str(safe_decimal(usage_summary.get("total_amount") or Decimal("0"))),
        },
        "member_ai_limit_summary": {
            "active_policy_count": member_policy_count,
            "usage_counter_count": member_usage_count,
            "admin_write_status": "not_connected",
        },
        "recent_transactions": recent_transactions,
        "recent_usage_events": recent_usage_events,
        "recent_invoices": invoices,
        "recent_reconciliations": reconciliations,
        "recent_payment_orders": payment_orders,
        "payment_order_status": payment_order_status,
        "gaps": gaps,
    }


@router.get("/admin/billing/credit-explanation")
@billing_api_errors
def admin_get_credit_explanation(
    request,
    organization_id: Optional[str] = None,
    month: Optional[str] = None,
    limit: int = _CREDIT_EXPLANATION_LIMIT_DEFAULT,
):
    """Organization credits 解释链（可选组织；缺省为全组织最近流水）。"""
    _require_admin(request)
    return success_response(
        data=_build_credit_explanation(
            organization_id=organization_id,
            month=month,
            limit=limit,
        )
    )


@router.get("/admin/billing/organizations/{organization_id}/credit-explanation")
@billing_api_errors
def admin_get_organization_credit_explanation(
    request,
    organization_id: str,
    month: Optional[str] = None,
    limit: int = _CREDIT_EXPLANATION_LIMIT_DEFAULT,
):
    """Organization credits解释链。

    只读聚合，不引入 Cash Wallet，也不把 credits 显示成人民币余额。
    """
    _require_admin(request)

    normalized_organization_id = (organization_id or "").strip()
    if not normalized_organization_id:
        raise HttpError(400, "organization_id required")

    return success_response(
        data=_build_credit_explanation(
            organization_id=normalized_organization_id,
            month=month,
            limit=limit,
        )
    )


def _count_by_organization_id(qs, *, field: str = "organization_id") -> dict[str, int]:
    return {
        str(row[field]): int(row["c"])
        for row in qs.values(field).annotate(c=Count("id"))
        if row.get(field) not in (None, "")
    }


@router.get("/admin/billing/credit-explanation/organizations")
@billing_api_errors
def admin_list_credit_explanation_organizations(
    request,
    month: Optional[str] = None,
    keyword: Optional[str] = None,
    organization_id: Optional[str] = None,
    page: int = 1,
    page_size: int = 20,
):
    """组织维度 credits 解释链列表：每行一个组织，板块计数供前端点开弹框。"""
    _require_admin(request)

    cycle_month, period_start, period_end = _credit_explanation_month_bounds(month)
    # organization_id / keyword 统一为「组织 ID 或组织名」模糊搜索
    search = (organization_id or keyword or "").strip()

    qs = Organization.objects.all().order_by("-created_at")
    if search:
        qs = qs.filter(Q(name__icontains=search) | Q(id__icontains=search))

    organizations, meta = _paginate(qs, page, page_size, max_size=100)
    org_ids = [str(org.id) for org in organizations]
    if not org_ids:
        return success_response(
            data={
                "month": cycle_month.strftime("%Y-%m"),
                "organizations": [],
                **meta,
            }
        )

    wallet_map = {
        str(wallet.organization_id): wallet
        for wallet in OrganizationWallet.objects.filter(organization_id__in=org_ids)
    }
    tx_counts = _count_by_organization_id(
        WalletTransaction.objects.filter(organization_wallet__organization_id__in=org_ids),
        field="organization_wallet__organization_id",
    )
    usage_counts = _count_by_organization_id(
        BillingUsageEvent.objects.filter(
            organization_id__in=org_ids,
            occurred_at__gte=period_start,
            occurred_at__lt=period_end,
        )
    )
    invoice_counts = _count_by_organization_id(
        BillingInvoice.objects.filter(organization_id__in=org_ids)
    )
    reconciliation_counts = _count_by_organization_id(
        BillingReconciliationReport.objects.filter(organization_id__in=org_ids)
    )
    member_policy_counts = _count_by_organization_id(
        MemberLlmBudgetPolicy.objects.filter(organization_id__in=org_ids, is_active=True)
    )
    member_usage_counts = _count_by_organization_id(
        MemberLlmUsageCounter.objects.filter(
            organization_id__in=org_ids,
            cycle_date=cycle_month,
            cycle_type="monthly",
        )
    )

    payment_counts: dict[str, int] = {}
    payment_order_status = "ok"
    try:
        payment_counts = _count_by_organization_id(
            PaymentOrder.objects.filter(organization_id__in=org_ids)
        )
    except Exception:
        payment_order_status = "degraded"
        logger.warning(
            "[BillingAdmin] credit-explanation organizations payment count degraded",
            exc_info=True,
        )

    rows = []
    for org in organizations:
        org_id = str(org.id)
        wallet = wallet_map.get(org_id)
        rows.append(
            {
                "organization_id": org_id,
                "organization_name": (org.name or "").strip() or org_id,
                "credits_precise": (
                    str(safe_decimal(wallet.credits_precise)) if wallet else None
                ),
                "credits_frozen_precise": (
                    str(safe_decimal(wallet.credits_frozen_precise)) if wallet else None
                ),
                "transaction_count": tx_counts.get(org_id, 0),
                "usage_event_count": usage_counts.get(org_id, 0),
                "payment_order_count": payment_counts.get(org_id, 0),
                "invoice_count": invoice_counts.get(org_id, 0),
                "reconciliation_count": reconciliation_counts.get(org_id, 0),
                "member_ai_limit": {
                    "active_policy_count": member_policy_counts.get(org_id, 0),
                    "usage_counter_count": member_usage_counts.get(org_id, 0),
                    "admin_write_status": "not_connected",
                },
                "payment_order_status": payment_order_status,
            }
        )

    return success_response(
        data={
            "month": cycle_month.strftime("%Y-%m"),
            "organizations": rows,
            **meta,
        }
    )


_WALLET_ADJUST_MAX = Decimal("100000")


class WalletAdjustIn(Schema):
    amount: str
    amount_unit: str = "points"
    description: str = ""
    reason: str = ""
    ticket_id: str = ""
    related_billing_event_id: str = ""
    related_wallet_transaction_id: str = ""


_CREDIT_LEDGER_MUTATION_TYPES = {
    "system_gift",
    "compensation",
    "manual_adjust",
    "refund_reverse",
}


def _serialize_credit_ledger_item(item: OrganizationCreditLedger, *, source: str = "ledger") -> dict:
    return {
        "id": str(item.id),
        "organization_id": item.organization_id,
        "user_id": item.user_id or "",
        "ledger_type": item.ledger_type,
        "amount_points": str(safe_decimal(item.amount_points)),
        "balance_after_points": (
            str(safe_decimal(item.balance_after_points))
            if item.balance_after_points is not None
            else None
        ),
        "related_usage_event_id": item.related_usage_event_id or "",
        "related_billing_event_id": item.related_billing_event_id or "",
        "related_wallet_transaction_id": item.related_wallet_transaction_id or "",
        "related_order_id": item.related_order_id or "",
        "related_invoice_id": item.related_invoice_id or "",
        "operator_admin_account_id": item.operator_admin_account_id or "",
        "operator_user_id": item.operator_user_id or "",
        "reason": item.reason or "",
        "ticket_id": item.ticket_id or "",
        "metadata_json": item.metadata_json or {},
        "source": source,
        "created_at": item.created_at.isoformat() if item.created_at else None,
    }


def _append_legacy_derived_entries(
    *,
    organization_id: str,
    page_size: int,
    start_time: Optional[str] = None,
    end_time: Optional[str] = None,
) -> list[dict]:
    first_ledger_created_at = (
        OrganizationCreditLedger.objects.filter(organization_id=organization_id)
        .order_by("created_at")
        .values_list("created_at", flat=True)
        .first()
    )
    wallet_qs = WalletTransaction.objects.filter(organization_id=organization_id).exclude(organization_id__isnull=True)
    wallet_qs = wallet_qs.exclude(transaction_type__in=["freeze", "unfreeze"])
    wallet_qs = _parse_time_range(wallet_qs, start_time, end_time, field="created_at")
    if first_ledger_created_at:
        wallet_qs = wallet_qs.filter(created_at__lt=first_ledger_created_at)
    wallet_txs = list(wallet_qs.order_by("-created_at")[:page_size])
    derived: list[dict] = []
    for tx in wallet_txs:
        derived.append(
            {
                "id": f"legacy-{tx.id}",
                "organization_id": str(tx.organization_id or ""),
                "user_id": "",
                "ledger_type": "legacy_derived",
                "amount_points": str(safe_decimal(tx.amount_precise)),
                "balance_after_points": str(safe_decimal(tx.balance_after_precise)),
                "related_usage_event_id": tx.usage_event_id or "",
                "related_billing_event_id": "",
                "related_wallet_transaction_id": str(tx.id),
                "related_order_id": tx.related_order_id or "",
                "related_invoice_id": "",
                "operator_admin_account_id": "",
                "operator_user_id": tx.operator_user_id or "",
                "reason": tx.description or "历史钱包流水兼容映射",
                "ticket_id": "",
                "metadata_json": {"legacy_tx_type": tx.transaction_type},
                "source": "legacy_derived",
                "created_at": tx.created_at.isoformat() if tx.created_at else None,
            }
        )
    return derived


def _record_credit_ledger(
    *,
    request,
    organization_id: str,
    ledger_type: str,
    amount_points: Decimal,
    balance_after_points: Optional[Decimal],
    reason: str,
    ticket_id: str = "",
    related_usage_event_id: str = "",
    related_billing_event_id: str = "",
    related_wallet_transaction_id: str = "",
    related_order_id: str = "",
    related_invoice_id: str = "",
    metadata_json: Optional[dict] = None,
) -> OrganizationCreditLedger:
    account = getattr(request, "admin_account", None)
    ledger = OrganizationCreditLedger.objects.create(
        organization_id=organization_id,
        user_id="",
        ledger_type=ledger_type,
        amount_points=amount_points,
        balance_after_points=balance_after_points,
        related_usage_event_id=related_usage_event_id.strip(),
        related_billing_event_id=related_billing_event_id.strip(),
        related_wallet_transaction_id=related_wallet_transaction_id.strip(),
        related_order_id=related_order_id.strip(),
        related_invoice_id=related_invoice_id.strip(),
        operator_admin_account_id=str(account.id) if account else "",
        operator_user_id=str(request.auth.id) if getattr(request, "auth", None) else "",
        reason=reason.strip(),
        ticket_id=ticket_id.strip(),
        metadata_json=metadata_json or {},
    )
    return ledger


@router.post("/admin/wallets/{wallet_id}/adjust")
@billing_api_errors
def admin_adjust_wallet(request, wallet_id: str, data: WalletAdjustIn):
    _require_admin(request)
    amount_unit = (data.amount_unit or "points").strip().lower()
    if amount_unit != "points":
        return error_response_with_status(
            "UNSUPPORTED_AMOUNT_UNIT",
            message="钱包调账仅支持 credits 单位（points）；金额（元）请走专用财务流程",
            status_code=400,
        )

    try:
        adj = Decimal(data.amount)
    except (InvalidOperation, TypeError, ValueError):
        return error_response_with_status("INVALID_AMOUNT", message=_("billing.invalid_amount"), status_code=400)
    if abs(adj) > _WALLET_ADJUST_MAX:
        return error_response_with_status(
            "AMOUNT_EXCEEDS_LIMIT",
            message=_("billing.adjust_amount_max", max=_WALLET_ADJUST_MAX),
            status_code=400,
        )
    amount = adj
    reason = (data.reason or data.description or "").strip()
    if not reason:
        return error_response_with_status(
            "ADJUST_REASON_REQUIRED",
            message="钱包人工调整必须填写原因",
            status_code=400,
        )
    description_parts = [
        f"原因：{reason}",
        f"工单：{data.ticket_id.strip()}" if data.ticket_id.strip() else "",
        f"Billing Event：{data.related_billing_event_id.strip()}" if data.related_billing_event_id.strip() else "",
        f"Wallet Transaction：{data.related_wallet_transaction_id.strip()}" if data.related_wallet_transaction_id.strip() else "",
    ]
    description = "；".join(part for part in description_parts if part)

    with db_transaction.atomic():
        organization_wallet = OrganizationWallet.objects.select_for_update().filter(id=wallet_id).first()
        if not organization_wallet:
            raise HttpError(404, _("billing.wallet_not_found"))

        wallet = organization_wallet
        balance_before = safe_decimal(wallet.credits_precise)
        new_balance = balance_before + amount
        if new_balance < 0:
            raise HttpError(400, _("billing.balance_cannot_negative"))

        from apps.users.wallet.models import AbstractWallet
        _to_display = AbstractWallet.to_display_credits

        wallet.credits_precise = new_balance
        wallet.sync_display_balances()
        wallet.save(update_fields=["credits", "credits_precise", "updated_at"])

        display_before = _to_display(balance_before)
        display_after = wallet.credits
        tx_type = "grant" if amount >= 0 else "consume"
        wallet_tx = WalletTransaction.objects.create(
            organization_wallet=organization_wallet,
            transaction_type=tx_type,
            amount=display_after - display_before,
            amount_precise=amount,
            balance_before=display_before,
            balance_before_precise=balance_before,
            balance_after=display_after,
            balance_after_precise=new_balance,
            description=description,
            operator_user_id=str(request.auth.id),
            organization_id=organization_wallet.organization_id,
        )

    record_billing_audit(
        request, action="wallet_adjust", target_type="wallet", target_id=wallet_id,
        organization_id=getattr(wallet, "organization_id", ""),
        detail={
            "amount": str(amount),
            "balance_before": str(balance_before),
            "balance_after": str(new_balance),
            "reason": reason,
            "ticket_id": data.ticket_id.strip(),
            "related_billing_event_id": data.related_billing_event_id.strip(),
            "related_wallet_transaction_id": data.related_wallet_transaction_id.strip(),
        },
    )
    record_admin_sensitive_action(
        request,
        permission_code="wallet:adjust",
        action="wallet.adjust",
        target_type="wallet",
        target_id=wallet_id,
        reason=reason,
        ticket_id=data.ticket_id.strip(),
        related_billing_event_id=data.related_billing_event_id.strip(),
        related_wallet_transaction_id=str(wallet_tx.id),
        before_json={"balance_before_points": str(balance_before)},
        after_json={"balance_after_points": str(new_balance)},
    )

    return success_response(data={
        "wallet_id": wallet_id,
        "balance_before": str(balance_before),
        "balance_after": str(new_balance),
        "adjustment": str(amount),
    }, message=_("billing.wallet_adjusted"))


class CreditLedgerAdjustIn(Schema):
    action: str = ""
    ledger_type: str = ""
    amount_points: str
    reason: str
    ticket_id: str = ""
    related_usage_event_id: str = ""
    related_billing_event_id: str = ""
    related_wallet_transaction_id: str = ""
    related_order_id: str = ""
    related_invoice_id: str = ""
    metadata_json: dict = {}


_CREDIT_ACTION_MAP = {
    "grant": {
        "ledger_type": "system_gift",
        "permission": "credit:grant",
        "audit_action": "credit_ledger.grant",
        "sign": "positive",
    },
    "deduct": {
        "ledger_type": "manual_adjust",
        "permission": "credit:deduct",
        "audit_action": "credit_ledger.deduct",
        "sign": "negative",
    },
    "reverse": {
        "ledger_type": "refund_reverse",
        "permission": "credit:reverse",
        "audit_action": "credit_ledger.reverse",
        "sign": "positive",
    },
    "compensate": {
        "ledger_type": "compensation",
        "permission": "compensation:create",
        "audit_action": "credit_ledger.compensate",
        "sign": "positive",
    },
    "manual_adjust": {
        "ledger_type": "manual_adjust",
        "permission": "credit:adjust",
        "audit_action": "credit_ledger.manual_adjust",
        "sign": "both",
    },
}


def _resolve_credit_action_config(action: str, ledger_type: str) -> dict:
    action_key = (action or "").strip().lower()
    ledger_type_key = (ledger_type or "").strip().lower()
    if action_key:
        config = _CREDIT_ACTION_MAP.get(action_key)
        if config is None:
            raise HttpError(400, {"code": "INVALID_ACTION", "message": "无效 action"})
        if ledger_type_key and ledger_type_key != config["ledger_type"]:
            raise HttpError(
                400,
                {
                    "code": "ACTION_LEDGER_TYPE_MISMATCH",
                    "message": "action 与 ledger_type 不匹配",
                },
            )
        return {"action": action_key, **config}

    if not ledger_type_key:
        raise HttpError(
            400,
            {"code": "ACTION_OR_LEDGER_TYPE_REQUIRED", "message": "必须提供 action 或 ledger_type"},
        )
    if ledger_type_key == "system_gift":
        return {"action": "grant", **_CREDIT_ACTION_MAP["grant"]}
    if ledger_type_key == "compensation":
        return {"action": "compensate", **_CREDIT_ACTION_MAP["compensate"]}
    if ledger_type_key == "refund_reverse":
        return {"action": "reverse", **_CREDIT_ACTION_MAP["reverse"]}
    if ledger_type_key == "manual_adjust":
        return {"action": "manual_adjust", **_CREDIT_ACTION_MAP["manual_adjust"]}
    raise HttpError(400, {"code": "INVALID_LEDGER_TYPE", "message": "不支持的 ledger_type"})


def _ensure_admin_permission(request, permission_code: str) -> None:
    permissions = getattr(request, "admin_permissions", set()) or set()
    if "*" in permissions:
        return
    if permission_code not in permissions:
        raise HttpError(
            403,
            {
                "code": "ADMIN_PERMISSION_DENIED",
                "message": "缺少后台计费权限",
                "missing_permission": permission_code,
            },
        )


class ProviderCreditCampaignCreateIn(Schema):
    code: str
    name: str
    provider_key: str
    eligible_model_ids: list[str] = []
    grant_credits: Decimal
    total_budget_credits: Decimal
    expire_days: int = 30
    trigger_type: str = ProviderCreditCampaign.TriggerType.MANUAL
    membership_plan_codes: list[str] = []
    start_at: Optional[datetime] = None
    end_at: Optional[datetime] = None
    enabled: bool = True


class ProviderCreditCampaignUpdateIn(Schema):
    code: Optional[str] = None
    name: Optional[str] = None
    provider_key: Optional[str] = None
    eligible_model_ids: Optional[list[str]] = None
    grant_credits: Optional[Decimal] = None
    total_budget_credits: Optional[Decimal] = None
    expire_days: Optional[int] = None
    trigger_type: Optional[str] = None
    membership_plan_codes: Optional[list[str]] = None
    start_at: Optional[datetime] = None
    end_at: Optional[datetime] = None
    enabled: Optional[bool] = None


class ProviderCreditGrantIn(Schema):
    organization_id: str
    campaign_code: str
    reason: str


class ProviderCreditGrantAdjustmentIn(Schema):
    amount: Decimal
    reason: str
    idempotency_key: Optional[str] = None


class ProviderCreditGrantRevokeIn(Schema):
    reason: str


def _provider_credit_validation_error(exc: ValidationError, *, code: str) -> HttpError:
    return HttpError(
        400,
        {
            "code": code,
            "message": "; ".join(exc.messages),
        },
    )


@router.post("/admin/billing/provider-credit/campaigns")
@billing_api_errors
def admin_create_provider_credit_campaign(
    request,
    data: ProviderCreditCampaignCreateIn,
):
    """创建活动；Operator 可执行，活动编码由创建时永久确定。"""
    _require_admin(request)
    from .services.provider_credit_service import ProviderCreditService

    try:
        with db_transaction.atomic():
            campaign = ProviderCreditService.create_campaign(
                code=data.code,
                name=data.name,
                provider_key=data.provider_key,
                eligible_model_ids=data.eligible_model_ids,
                credits_amount=data.grant_credits,
                total_budget_credits=data.total_budget_credits,
                expire_days=data.expire_days,
                trigger_type=data.trigger_type,
                membership_plan_codes=data.membership_plan_codes,
                start_at=data.start_at,
                end_at=data.end_at,
                enabled=data.enabled,
            )
            _record_provider_credit_write_audit(
                request,
                action="provider_credit_campaign_create",
                target_type="provider_credit_campaign",
                target_id=str(campaign.id),
                detail={
                    "code": campaign.code,
                    "provider_key": campaign.provider_key,
                    "eligible_model_ids": campaign.eligible_model_ids,
                    "grant_credits": str(campaign.credits_amount),
                    "total_budget_credits": str(campaign.total_budget_credits),
                    "enabled": campaign.enabled,
                },
            )
    except ValidationError as exc:
        raise _provider_credit_validation_error(
            exc,
            code="PROVIDER_CREDIT_CAMPAIGN_INVALID",
        ) from exc

    return success_response(data={"campaign": _serialize_provider_credit_campaign(campaign)})


@router.get("/admin/billing/provider-credit/campaigns/{campaign_code}")
@billing_api_errors
def admin_get_provider_credit_campaign(request, campaign_code: str):
    _require_admin(request)
    campaign = ProviderCreditCampaign.objects.filter(code=campaign_code.strip()).first()
    if campaign is None:
        raise HttpError(
            404,
            {
                "code": "PROVIDER_CREDIT_CAMPAIGN_NOT_FOUND",
                "message": "Provider Credit Campaign 不存在",
            },
        )
    return success_response(data={"campaign": _serialize_provider_credit_campaign(campaign)})


@router.put("/admin/billing/provider-credit/campaigns/{campaign_code}")
@billing_api_errors
def admin_update_provider_credit_campaign(
    request,
    campaign_code: str,
    data: ProviderCreditCampaignUpdateIn,
):
    """修改活动配置；产生 Grant 后 provider/model 匹配口径冻结。"""
    _require_admin(request)
    updates = data.dict(exclude_unset=True)
    normalized_code = campaign_code.strip()

    try:
        with db_transaction.atomic():
            campaign = (
                ProviderCreditCampaign.objects.select_for_update()
                .filter(code=normalized_code)
                .first()
            )
            if campaign is None:
                raise HttpError(
                    404,
                    {
                        "code": "PROVIDER_CREDIT_CAMPAIGN_NOT_FOUND",
                        "message": "Provider Credit Campaign 不存在",
                    },
                )
            if "code" in updates and str(updates["code"] or "").strip() != campaign.code:
                raise HttpError(
                    409,
                    {
                        "code": "PROVIDER_CREDIT_CAMPAIGN_CODE_IMMUTABLE",
                        "message": "Campaign 创建后 code 不可修改",
                    },
                )

            has_grants = ProviderCreditGrant.objects.filter(campaign=campaign).exists()
            next_provider = (
                normalize_provider_credit_provider_key(updates["provider_key"])
                if "provider_key" in updates
                else campaign.provider_key
            )
            next_models = (
                normalize_provider_credit_model_ids(updates["eligible_model_ids"])
                if "eligible_model_ids" in updates
                else list(campaign.eligible_model_ids or [])
            )
            if has_grants and (
                next_provider != campaign.provider_key
                or next_models != list(campaign.eligible_model_ids or [])
            ):
                raise HttpError(
                    409,
                    {
                        "code": "PROVIDER_CREDIT_CAMPAIGN_SCOPE_IMMUTABLE",
                        "message": "Campaign 已产生 Grant，provider_key 和 eligible_model_ids 不可修改",
                    },
                )

            before = _serialize_provider_credit_campaign(campaign)
            field_map = {
                "name": "name",
                "provider_key": "provider_key",
                "eligible_model_ids": "eligible_model_ids",
                "grant_credits": "credits_amount",
                "total_budget_credits": "total_budget_credits",
                "expire_days": "expire_days",
                "trigger_type": "trigger_type",
                "membership_plan_codes": "membership_plan_codes",
                "start_at": "start_at",
                "end_at": "end_at",
                "enabled": "enabled",
            }
            for input_field, model_field in field_map.items():
                if input_field in updates:
                    setattr(campaign, model_field, updates[input_field])
            campaign.full_clean()
            campaign.save()
            after = _serialize_provider_credit_campaign(campaign)
            _record_provider_credit_write_audit(
                request,
                action="provider_credit_campaign_update",
                target_type="provider_credit_campaign",
                target_id=str(campaign.id),
                detail={"before": before, "after": after},
            )
    except ValidationError as exc:
        raise _provider_credit_validation_error(
            exc,
            code="PROVIDER_CREDIT_CAMPAIGN_INVALID",
        ) from exc

    return success_response(data={"campaign": _serialize_provider_credit_campaign(campaign)})


@router.post("/admin/billing/provider-credit/grants")
@billing_api_errors
def admin_grant_provider_credit(request, data: ProviderCreditGrantIn):
    """按 Campaign 手工发放 Provider Credit；不接受余额覆盖参数。"""
    _require_admin(request)
    organization_id = str(data.organization_id or "").strip()
    campaign_code = str(data.campaign_code or "").strip()
    reason = str(data.reason or "").strip()
    if not organization_id:
        raise HttpError(400, {"code": "ORGANIZATION_ID_REQUIRED", "message": "organization_id 不能为空"})
    if not campaign_code:
        raise HttpError(400, {"code": "CAMPAIGN_CODE_REQUIRED", "message": "campaign_code 不能为空"})
    if not reason:
        raise HttpError(400, {"code": "REASON_REQUIRED", "message": "管理员赠送必须填写原因"})

    from .services.provider_credit_service import ProviderCreditService

    operator_id = str(getattr(request.auth, "id", ""))
    metadata = {
        "operator": operator_id,
        "reason": reason,
        "source": "admin",
    }
    try:
        with db_transaction.atomic():
            grant = ProviderCreditService.grant_credit_from_campaign(
                organization=organization_id,
                campaign_code=campaign_code,
                source="admin",
                metadata=metadata,
            )
            if grant.grant_source != ProviderCreditGrant.GrantSource.ADMIN:
                raise HttpError(
                    409,
                    {
                        "code": "PROVIDER_CREDIT_GRANT_ALREADY_EXISTS",
                        "message": "该组织已通过其他来源获得此 Campaign，不能改写为 Admin 赠送",
                    },
                )
            _record_provider_credit_write_audit(
                request,
                action="provider_credit_grant",
                target_type="provider_credit_grant",
                target_id=str(grant.id),
                organization_id=organization_id,
                detail={
                    "campaign_code": campaign_code,
                    "provider_key": grant.provider_key,
                    "credits": str(grant.total_credits),
                    "operator": operator_id,
                    "reason": reason,
                    "source": "admin",
                },
            )
            record_admin_sensitive_action(
                request,
                permission_code="provider_credit:operate",
                action="provider_credit.grant",
                target_type="provider_credit_grant",
                target_id=str(grant.id),
                reason=reason,
                before_json={},
                after_json={
                    "organization_id": organization_id,
                    "campaign_code": campaign_code,
                    "provider_key": grant.provider_key,
                    "credits": str(grant.total_credits),
                },
            )
    except ProviderCreditCampaign.DoesNotExist as exc:
        raise HttpError(
            404,
            {"code": "PROVIDER_CREDIT_CAMPAIGN_NOT_FOUND", "message": "Provider Credit Campaign 不存在"},
        ) from exc
    except Organization.DoesNotExist as exc:
        raise HttpError(
            404,
            {"code": "ORGANIZATION_NOT_FOUND", "message": "Organization 不存在"},
        ) from exc
    except ValidationError as exc:
        raise HttpError(
            400,
            {
                "code": "PROVIDER_CREDIT_GRANT_INVALID",
                "message": "; ".join(exc.messages),
            },
        ) from exc

    return success_response(data={"grant": _serialize_provider_credit_grant(grant)})


@router.get("/admin/billing/provider-credit/campaigns")
@billing_api_errors
def admin_list_provider_credit_campaigns(
    request,
    provider_key: str = "",
    status: str = "",
    code: str = "",
    page: int = 1,
    page_size: int = 50,
):
    """只读查询 Provider Credit 活动定义。"""
    _require_admin(request)
    qs = ProviderCreditCampaign.objects.all().order_by("-created_at")
    if provider_key:
        qs = qs.filter(provider_key=provider_key.strip().lower())
    if status:
        qs = qs.filter(status=status.strip())
    keyword = code.strip()
    if keyword:
        # 兼容旧参数名 code：按活动编码或活动名称模糊匹配
        qs = qs.filter(Q(code__icontains=keyword) | Q(name__icontains=keyword))

    campaigns, meta = _paginate(qs, page, page_size, max_size=200)
    items = [_serialize_provider_credit_campaign(campaign) for campaign in campaigns]
    record_billing_audit(
        request,
        action="provider_credit_campaign_list",
        target_type="provider_credit_campaign",
        target_id=keyword or "*",
        detail={
            "provider_key": provider_key.strip().lower(),
            "status": status.strip(),
            "code": keyword,
            "page": page,
            "page_size": page_size,
            "result_count": len(items),
        },
    )
    return success_response(data={"items": items, **meta})


@router.get("/admin/billing/provider-credit/grants")
@billing_api_errors
def admin_list_provider_credit_grants(
    request,
    organization_id: str = "",
    provider_key: str = "",
    campaign_code: str = "",
    status: str = "",
    expire_at: str = "",
    expire_before: str = "",
    expire_after: str = "",
    page: int = 1,
    page_size: int = 50,
):
    """跨组织查询 Grant，并支持到期日/到期范围过滤。"""
    _require_admin(request)
    qs = ProviderCreditGrant.objects.select_related(
        "campaign",
        "organization",
    ).order_by("expire_at", "created_at")
    if organization_id:
        qs = qs.filter(organization_id=organization_id.strip())
    if provider_key:
        qs = qs.filter(provider_key=provider_key.strip().lower())
    if campaign_code:
        qs = qs.filter(campaign__code=campaign_code.strip())
    if status:
        qs = qs.filter(status=status.strip())
    if expire_at:
        target_date = parse_date(expire_at.strip())
        if target_date is None:
            raise HttpError(400, {"code": "INVALID_EXPIRE_AT", "message": "expire_at 必须是 YYYY-MM-DD"})
        qs = qs.filter(expire_at__date=target_date)
    if expire_before:
        boundary = parse_datetime(expire_before.strip())
        if boundary is None:
            raise HttpError(400, {"code": "INVALID_EXPIRE_BEFORE", "message": "expire_before 必须是 ISO 8601"})
        qs = qs.filter(expire_at__lte=boundary)
    if expire_after:
        boundary = parse_datetime(expire_after.strip())
        if boundary is None:
            raise HttpError(400, {"code": "INVALID_EXPIRE_AFTER", "message": "expire_after 必须是 ISO 8601"})
        qs = qs.filter(expire_at__gte=boundary)

    grants, meta = _paginate(qs, page, page_size, max_size=200)
    return success_response(
        data={
            "items": [_serialize_provider_credit_grant(grant) for grant in grants],
            **meta,
        }
    )


@router.get("/admin/billing/organizations/{organization_id}/provider-credit/grants")
@billing_api_errors
def admin_list_organization_provider_credit_grants(
    request,
    organization_id: str,
    provider_key: str = "",
    status: str = "",
    campaign_id: str = "",
    page: int = 1,
    page_size: int = 50,
):
    """只读查询某个组织获得的 Provider Credit 批次。"""
    _require_admin(request)
    qs = (
        ProviderCreditGrant.objects.select_related("campaign", "organization")
        .filter(organization_id=organization_id)
        .order_by("expire_at", "created_at")
    )
    if provider_key:
        qs = qs.filter(provider_key=provider_key.strip().lower())
    if status:
        qs = qs.filter(status=status.strip())
    if campaign_id:
        qs = qs.filter(campaign_id=campaign_id.strip())

    grants, meta = _paginate(qs, page, page_size, max_size=200)
    items = [_serialize_provider_credit_grant(grant) for grant in grants]
    record_billing_audit(
        request,
        action="provider_credit_grant_list",
        target_type="provider_credit_grant",
        target_id=organization_id,
        organization_id=organization_id,
        detail={
            "provider_key": provider_key.strip().lower(),
            "status": status.strip(),
            "campaign_id": campaign_id.strip(),
            "page": page,
            "page_size": page_size,
            "result_count": len(items),
        },
    )
    return success_response(data={"items": items, **meta})


@router.get("/admin/billing/provider-credit/transactions")
@billing_api_errors
def admin_list_provider_credit_transactions(
    request,
    organization_id: str = "",
    grant_id: str = "",
    transaction_type: str = "",
    idempotency_key: str = "",
    start_time: str = "",
    end_time: str = "",
    page: int = 1,
    page_size: int = 50,
):
    """只读查询 Provider Credit 余额流水。"""
    _require_admin(request)
    qs = ProviderCreditTransaction.objects.select_related(
        "organization",
        "grant",
        "grant__campaign",
    ).order_by("-created_at")
    if organization_id:
        qs = qs.filter(organization_id=organization_id.strip())
    if grant_id:
        qs = qs.filter(grant_id=grant_id.strip())
    if transaction_type:
        qs = qs.filter(transaction_type=transaction_type.strip())
    if idempotency_key:
        qs = qs.filter(idempotency_key=idempotency_key.strip())
    qs = _parse_time_range(qs, start_time, end_time, field="created_at")

    transactions, meta = _paginate(qs, page, page_size, max_size=200)
    items = [
        _serialize_provider_credit_transaction(credit_transaction)
        for credit_transaction in transactions
    ]
    record_billing_audit(
        request,
        action="provider_credit_transaction_list",
        target_type="provider_credit_transaction",
        target_id=grant_id.strip() or organization_id.strip() or "*",
        organization_id=organization_id.strip(),
        detail={
            "grant_id": grant_id.strip(),
            "transaction_type": transaction_type.strip(),
            "idempotency_key": idempotency_key.strip(),
            "start_time": start_time,
            "end_time": end_time,
            "page": page,
            "page_size": page_size,
            "result_count": len(items),
        },
    )
    return success_response(data={"items": items, **meta})


@router.post("/admin/billing/provider-credit/grants/{grant_id}/adjust")
@billing_api_errors
def admin_adjust_provider_credit_grant(
    request,
    grant_id: str,
    data: ProviderCreditGrantAdjustmentIn,
):
    """调整 Grant；余额变化与流水、两类审计在同一事务中提交。"""
    _require_admin(request)
    from .services.provider_credit_service import ProviderCreditService

    operator_id = str(getattr(request.auth, "id", ""))
    idempotency_key = str(data.idempotency_key or "").strip() or (
        f"provider-credit-admin-adjust:{grant_id}:{uuid.uuid4()}"
    )
    try:
        with db_transaction.atomic():
            before_grant = ProviderCreditGrant.objects.select_related("campaign").get(pk=grant_id)
            before = _serialize_provider_credit_grant(before_grant)
            credit_transaction = ProviderCreditService.adjust_grant(
                grant=grant_id,
                amount=data.amount,
                reason=data.reason,
                operator_id=operator_id,
                idempotency_key=idempotency_key,
            )
            grant = ProviderCreditGrant.objects.select_related(
                "campaign",
                "organization",
            ).get(pk=grant_id)
            after = _serialize_provider_credit_grant(grant)
            _record_provider_credit_write_audit(
                request,
                action="provider_credit_grant_adjust",
                target_type="provider_credit_grant",
                target_id=str(grant.id),
                organization_id=str(grant.organization_id),
                detail={
                    "amount": str(data.amount),
                    "reason": data.reason.strip(),
                    "transaction_id": str(credit_transaction.id),
                    "before": before,
                    "after": after,
                },
            )
            record_admin_sensitive_action(
                request,
                permission_code="provider_credit:operate",
                action="provider_credit.grant.adjust",
                target_type="provider_credit_grant",
                target_id=str(grant.id),
                reason=data.reason,
                before_json=before,
                after_json=after,
            )
    except ProviderCreditGrant.DoesNotExist as exc:
        raise HttpError(
            404,
            {"code": "PROVIDER_CREDIT_GRANT_NOT_FOUND", "message": "Provider Credit Grant 不存在"},
        ) from exc
    except ValidationError as exc:
        raise _provider_credit_validation_error(
            exc,
            code="PROVIDER_CREDIT_ADJUSTMENT_INVALID",
        ) from exc

    return success_response(
        data={
            "grant": after,
            "transaction": _serialize_provider_credit_transaction(credit_transaction),
        }
    )


@router.post("/admin/billing/provider-credit/grants/{grant_id}/revoke")
@billing_api_errors
def admin_revoke_provider_credit_grant(
    request,
    grant_id: str,
    data: ProviderCreditGrantRevokeIn,
):
    """撤销 Grant；不删除历史，剩余余额以负 adjust 流水核销。"""
    _require_admin(request)
    from .services.provider_credit_service import ProviderCreditService

    operator_id = str(getattr(request.auth, "id", ""))
    idempotency_key = f"provider-credit-admin-revoke:{grant_id}"
    try:
        with db_transaction.atomic():
            before_grant = ProviderCreditGrant.objects.select_related("campaign").get(pk=grant_id)
            before = _serialize_provider_credit_grant(before_grant)
            credit_transaction = ProviderCreditService.revoke_grant(
                grant=grant_id,
                reason=data.reason,
                operator_id=operator_id,
                idempotency_key=idempotency_key,
            )
            grant = ProviderCreditGrant.objects.select_related(
                "campaign",
                "organization",
            ).get(pk=grant_id)
            after = _serialize_provider_credit_grant(grant)
            _record_provider_credit_write_audit(
                request,
                action="provider_credit_grant_revoke",
                target_type="provider_credit_grant",
                target_id=str(grant.id),
                organization_id=str(grant.organization_id),
                detail={
                    "reason": data.reason.strip(),
                    "transaction_id": (
                        str(credit_transaction.id) if credit_transaction else None
                    ),
                    "before": before,
                    "after": after,
                },
            )
            record_admin_sensitive_action(
                request,
                permission_code="provider_credit:admin",
                action="provider_credit.grant.revoke",
                target_type="provider_credit_grant",
                target_id=str(grant.id),
                reason=data.reason,
                before_json=before,
                after_json=after,
            )
    except ProviderCreditGrant.DoesNotExist as exc:
        raise HttpError(
            404,
            {"code": "PROVIDER_CREDIT_GRANT_NOT_FOUND", "message": "Provider Credit Grant 不存在"},
        ) from exc
    except ValidationError as exc:
        raise _provider_credit_validation_error(
            exc,
            code="PROVIDER_CREDIT_REVOKE_INVALID",
        ) from exc

    return success_response(
        data={
            "grant": after,
            "transaction": (
                _serialize_provider_credit_transaction(credit_transaction)
                if credit_transaction
                else None
            ),
        }
    )


@router.get("/admin/billing/provider-credit/reports/campaign/{campaign_code}")
@billing_api_errors
def admin_get_provider_credit_campaign_report(request, campaign_code: str):
    _require_admin(request)
    from .services.provider_credit_analytics import ProviderCreditAnalyticsService

    try:
        report = ProviderCreditAnalyticsService.campaign_report(campaign_code)
    except ProviderCreditCampaign.DoesNotExist as exc:
        raise HttpError(
            404,
            {
                "code": "PROVIDER_CREDIT_CAMPAIGN_NOT_FOUND",
                "message": "Provider Credit Campaign 不存在",
            },
        ) from exc
    serialized = {
        key: str(value) if isinstance(value, Decimal) else value
        for key, value in report.items()
    }
    return success_response(data=serialized)


@router.get("/admin/billing/organizations/{organization_id}/credit-ledger")
@billing_api_errors
def admin_list_organization_credit_ledger(
    request,
    organization_id: str,
    ledger_type: str = "",
    include_legacy_derived: bool = True,
    start_time: Optional[str] = None,
    end_time: Optional[str] = None,
    page: int = 1,
    page_size: int = 50,
):
    _require_admin(request)
    qs = OrganizationCreditLedger.objects.filter(organization_id=organization_id).order_by("-created_at")
    qs = _parse_time_range(qs, start_time, end_time, field="created_at")
    if ledger_type:
        qs = qs.filter(ledger_type=ledger_type.strip())

    items, meta = _paginate(qs, page, page_size, max_size=200)
    serialized = [_serialize_credit_ledger_item(item) for item in items]
    if include_legacy_derived and page == 1 and not ledger_type:
        serialized.extend(
            _append_legacy_derived_entries(
                organization_id=organization_id,
                page_size=min(page_size, 50),
                start_time=start_time,
                end_time=end_time,
            )
        )
        serialized.sort(key=lambda row: row.get("created_at") or "", reverse=True)
        serialized = serialized[:page_size]

    return success_response(
        data={
            "items": serialized,
            **meta,
        }
    )


@router.post("/admin/billing/organizations/{organization_id}/credit-ledger/adjust")
@billing_api_errors
def admin_adjust_organization_credit_ledger(request, organization_id: str, data: CreditLedgerAdjustIn):
    _require_admin(request)
    action_config = _resolve_credit_action_config(data.action, data.ledger_type)
    ledger_type = action_config["ledger_type"]
    _ensure_admin_permission(request, action_config["permission"])
    reason = (data.reason or "").strip()
    if not reason:
        raise HttpError(400, {"code": "REASON_REQUIRED", "message": "credits 人工操作必须填写原因"})
    try:
        amount_points = Decimal(data.amount_points)
    except (InvalidOperation, TypeError, ValueError):
        raise HttpError(400, {"code": "INVALID_AMOUNT", "message": "amount_points 非法"})
    if amount_points == 0:
        raise HttpError(400, {"code": "INVALID_AMOUNT", "message": "amount_points 不能为 0"})
    sign_rule = action_config["sign"]
    if sign_rule == "positive" and amount_points < 0:
        raise HttpError(400, {"code": "INVALID_AMOUNT_SIGN", "message": "该操作要求 amount_points 为正数"})
    if sign_rule == "negative" and amount_points > 0:
        raise HttpError(400, {"code": "INVALID_AMOUNT_SIGN", "message": "该操作要求 amount_points 为负数"})

    with db_transaction.atomic():
        wallet = OrganizationWallet.objects.select_for_update().filter(organization_id=organization_id).first()
        if wallet is None:
            wallet = OrganizationWallet.objects.create(organization_id=organization_id)

        balance_before = safe_decimal(wallet.credits_precise)
        balance_after = balance_before + amount_points
        if balance_after < 0:
            raise HttpError(400, {"code": "INSUFFICIENT_CREDITS", "message": "余额不足，无法扣减"})

        from apps.users.wallet.models import AbstractWallet

        wallet.credits_precise = balance_after
        wallet.sync_display_balances()
        wallet.save(update_fields=["credits", "credits_precise", "updated_at"])

        tx_type = "grant" if amount_points >= 0 else "consume"
        wallet_tx = WalletTransaction.objects.create(
            organization_wallet=wallet,
            transaction_type=tx_type,
            amount=wallet.credits - AbstractWallet.to_display_credits(balance_before),
            amount_precise=amount_points,
            balance_before=AbstractWallet.to_display_credits(balance_before),
            balance_before_precise=balance_before,
            balance_after=wallet.credits,
            balance_after_precise=balance_after,
            description=f"{ledger_type}: {reason}",
            operator_user_id=str(request.auth.id),
            organization_id=organization_id,
            related_order_id=(data.related_order_id or "").strip(),
            billing_metadata={
                "ledger_type": ledger_type,
                "ticket_id": (data.ticket_id or "").strip(),
            },
            usage_event_id=(data.related_usage_event_id or "").strip(),
        )

        ledger = _record_credit_ledger(
            request=request,
            organization_id=organization_id,
            ledger_type=ledger_type,
            amount_points=amount_points,
            balance_after_points=balance_after,
            reason=reason,
            ticket_id=data.ticket_id,
            related_usage_event_id=data.related_usage_event_id,
            related_billing_event_id=data.related_billing_event_id,
            related_wallet_transaction_id=str(wallet_tx.id),
            related_order_id=data.related_order_id,
            related_invoice_id=data.related_invoice_id,
            metadata_json=data.metadata_json or {},
        )

    record_admin_sensitive_action(
        request,
        permission_code=action_config["permission"],
        action=action_config["audit_action"],
        target_type="organization",
        target_id=organization_id,
        reason=reason,
        ticket_id=(data.ticket_id or "").strip(),
        related_billing_event_id=(data.related_billing_event_id or "").strip(),
        related_wallet_transaction_id=str(wallet_tx.id),
        before_json={"balance_before_points": str(balance_before)},
        after_json={
            "balance_after_points": str(balance_after),
            "ledger_id": str(ledger.id),
        },
    )
    return success_response(
        data={
            "ledger": _serialize_credit_ledger_item(ledger),
            "wallet": {
                "organization_id": organization_id,
                "balance_before_points": str(balance_before),
                "balance_after_points": str(balance_after),
            },
        }
    )


# ── scene_key（活类型）分类标签 ────────────────────────────────────
#
# 子 Agent 计费收尾（2026-05）：BillingUsageEvent.scene_key 与 LLMUsageFact.scene_key
# 同源同值，让财务能按「钱花在哪类活上」下钻。这里给 4 个 system scene + 空值映射
# 友好中文标签；其余业务 scene（title_generation/summarization/embedding...）回退原
# scene_key 本身，非 LLM 事件（存储/短信/搜索等）scene_key 为空 → 归「未分类」。
_SCENE_KEY_LABELS = {
    "": "未分类（非 LLM / 历史数据）",
    "_main_chat": "主管对话",
    "_sub_agent": "子 Agent",
    "_compact": "后台压缩",
    "_summary_judge": "摘要评判",
}


def _scene_label(scene_key: Optional[str]) -> str:
    key = (scene_key or "").strip()
    if key in _SCENE_KEY_LABELS:
        return _SCENE_KEY_LABELS[key]
    # 业务 scene（title_generation / summarization / embedding 等）回退 SCENES 注册表
    # 的中文 display_name，一次覆盖全量、永不漂移；注册表不可用或未命中时回退原 key
    # （_scene_label 永不抛错，保证报表不因冒出新 scene 而崩）。
    try:
        from apps.services.llm.scenes.registry import SCENES
        spec = SCENES.get(key)
        display_name = getattr(spec, "display_name", "") if spec is not None else ""
        if display_name:
            return display_name
    except Exception:
        pass
    return key


# ── 统一计费概览 ──────────────────────────────────────────────────


@router.get("/admin/billing/overview")
@billing_api_errors
def admin_billing_overview(request, days: int = 30):
    """基于 BillingUsageEvent 的全量计费概览，按 meter_key + scene_key（活类型）聚合。"""
    _require_admin(request)

    if days < 1 or days > 365:
        raise HttpError(400, "days 参数范围: 1-365")

    period_start = timezone.now() - timedelta(days=days)
    period_end = timezone.now()

    qs = BillingUsageEvent.objects.filter(occurred_at__gte=period_start, occurred_at__lt=period_end)

    totals = qs.aggregate(
        total_events=Count("id"),
        total_amount=Sum("amount"),
    )
    total_events = totals["total_events"] or 0
    total_amount = safe_decimal(totals["total_amount"])

    by_meter_qs = (
        qs.values("meter_key")
        .annotate(
            event_count=Count("id"),
            sum_quantity=Sum("quantity"),
            sum_amount=Sum("amount"),
        )
        .order_by("-sum_amount")
    )

    by_meter = []
    for row in by_meter_qs:
        by_meter.append({
            "meter_key": row["meter_key"],
            "total_events": row["event_count"],
            "total_quantity": str(safe_decimal(row["sum_quantity"])),
            "total_amount": str(safe_decimal(row["sum_amount"])),
        })

    # 子 Agent 计费收尾：按 scene_key（活类型）切分 —— 主管对话 / 子 Agent / 压缩 /
    # 摘要 / 未分类各花了多少。每条事件恰好归一个 scene_key 桶（含空值），故
    # Σ(by_scene.total_amount) == total_amount，纯切分不改总数、不重复计。
    by_scene_qs = (
        qs.values("scene_key")
        .annotate(
            event_count=Count("id"),
            sum_quantity=Sum("quantity"),
            sum_amount=Sum("amount"),
        )
        .order_by("-sum_amount")
    )

    by_scene = []
    for row in by_scene_qs:
        by_scene.append({
            "scene_key": row["scene_key"] or "",
            "scene_label": _scene_label(row["scene_key"]),
            "total_events": row["event_count"],
            "total_quantity": str(safe_decimal(row["sum_quantity"])),
            "total_amount": str(safe_decimal(row["sum_amount"])),
        })

    trends_qs = (
        qs.annotate(day=TruncDate("occurred_at"))
        .values("day")
        .annotate(
            day_events=Count("id"),
            day_amount=Sum("amount"),
        )
        .order_by("day")
    )
    trends = []
    for row in trends_qs:
        trends.append({
            "date": str(row["day"]),
            "events": row["day_events"],
            "amount": str(safe_decimal(row["day_amount"])),
        })

    return success_response(data={
        "total_events": total_events,
        "total_amount": str(total_amount),
        "by_meter": by_meter,
        "by_scene": by_scene,
        "trends": trends,
        "period_start": period_start.isoformat(),
        "period_end": period_end.isoformat(),
    })


# ── 计费事件查询 ──────────────────────────────────────────────────


def _filter_billing_events(
    organization_id: Optional[str] = None,
    user_id: Optional[str] = None,
    meter_key: Optional[str] = None,
    model_name: Optional[str] = None,
    biz_type: Optional[str] = None,
    start_time: Optional[str] = None,
    end_time: Optional[str] = None,
    scene_key: Optional[str] = None,
    charge_status: Optional[str] = None,
    has_charge: Optional[bool] = None,
):
    """构建 BillingUsageEvent 的通用筛选 QuerySet（列表与导出共用）。"""
    qs = BillingUsageEvent.objects.all().order_by("-occurred_at")
    if organization_id:
        qs = qs.filter(organization_id=organization_id)
    if user_id:
        qs = qs.filter(user_id=user_id)
    if meter_key:
        qs = qs.filter(meter_key=meter_key)
    if model_name:
        qs = qs.filter(model_name__icontains=model_name)
    if biz_type:
        from apps.services.billing.usage_event_filters import resolve_usage_event_biz_types

        biz_types = resolve_usage_event_biz_types(biz_type)
        if len(biz_types) == 1:
            qs = qs.filter(biz_type=biz_types[0])
        elif biz_types:
            qs = qs.filter(biz_type__in=biz_types)
    if scene_key is not None:
        # 子 Agent 计费收尾：支持按「活类型」过滤（含空字符串 = 未分类桶）。
        qs = qs.filter(scene_key=scene_key)
    status = (charge_status or "").strip().lower()
    if status:
        qs = qs.filter(charge_status=status)
    # 扣费列表：真实产生金额；用量列表：0 点审计/未实扣事件。
    if has_charge is True:
        qs = qs.filter(amount__gt=0)
    elif has_charge is False:
        qs = qs.filter(amount__lte=0)
    return _parse_time_range(qs, start_time, end_time)


@router.get("/admin/billing/events")
@billing_api_errors
def admin_list_billing_events(
    request,
    organization_id: Optional[str] = None,
    user_id: Optional[str] = None,
    meter_key: Optional[str] = None,
    model_name: Optional[str] = None,
    biz_type: Optional[str] = None,
    scene_key: Optional[str] = None,
    charge_status: Optional[str] = None,
    has_charge: Optional[bool] = None,
    start_time: Optional[str] = None,
    end_time: Optional[str] = None,
    order_by: Optional[str] = None,
    page: int = 1,
    page_size: int = 50,
):
    _require_admin(request)

    qs = _filter_billing_events(
        organization_id, user_id, meter_key, model_name, biz_type,
        start_time, end_time, scene_key=scene_key, charge_status=charge_status,
        has_charge=has_charge,
    )
    qs = apply_ordering(qs, order_by, _EVENT_SORT, default="-occurred_at")
    events, meta = _paginate(qs, page, page_size)

    org_ids = {e.organization_id for e in events if e.organization_id}
    user_ids = {e.user_id for e in events if e.user_id}

    org_name_map: dict[str, str] = {}
    if org_ids:
        for org in Organization.objects.filter(id__in=org_ids).only("id", "name"):
            org_name_map[str(org.id)] = (org.name or "").strip()

    user_name_map: dict[str, str] = {}
    if user_ids:
        from apps.users.auth.models import User as AuthUser

        for user in AuthUser.objects.filter(id__in=user_ids).only("id", "nickname", "username"):
            user_name_map[str(user.id)] = (
                (user.nickname or "").strip()
                or (user.username or "").strip()
            )

    items = []
    for e in events:
        metadata = e.metadata or {}
        organization_id = e.organization_id or ""
        user_id = e.user_id or ""
        items.append({
            "id": str(e.id),
            "organization_id": organization_id,
            "organization_name": org_name_map.get(str(organization_id), ""),
            "user_id": user_id,
            "username": user_name_map.get(str(user_id), ""),
            "meter_key": e.meter_key,
            "quantity": str(safe_decimal(e.quantity)),
            "unit": e.unit,
            "unit_price": str(safe_decimal(e.unit_price)),
            "amount": str(safe_decimal(e.amount)),
            "currency": e.currency,
            "provider_key": e.provider_key,
            "model_name": e.model_name,
            "biz_type": e.biz_type,
            "biz_id": e.biz_id,
            "charge_source": (
                metadata.get("charge_source")
                or metadata.get("credits_remaining_source")
                or ""
            ),
            "charge_status": e.charge_status,
            "wallet_transaction_id": metadata.get("wallet_transaction_id") or "",
            "credit_ledger_id": metadata.get("credit_ledger_id") or "",
            "request_id": metadata.get("request_id") or e.idempotency_key,
            "metadata": metadata,
            "scene_key": e.scene_key,
            "scene_label": _scene_label(e.scene_key),
            "occurred_at": e.occurred_at.isoformat() if e.occurred_at else None,
            "created_at": e.created_at.isoformat() if e.created_at else None,
        })

    return success_response(data={"events": items, **meta})


@router.get("/admin/billing/events/export")
@billing_api_errors
def admin_export_billing_events(
    request,
    organization_id: Optional[str] = None,
    user_id: Optional[str] = None,
    meter_key: Optional[str] = None,
    model_name: Optional[str] = None,
    biz_type: Optional[str] = None,
    scene_key: Optional[str] = None,
    has_charge: Optional[bool] = None,
    start_time: Optional[str] = None,
    end_time: Optional[str] = None,
):
    """导出计费事件为 CSV（基于 BillingUsageEvent，含 scene_key 活类型分类）。"""
    _require_admin(request)

    qs = _filter_billing_events(
        organization_id, user_id, meter_key, model_name, biz_type,
        start_time, end_time, scene_key=scene_key, has_charge=has_charge,
    )[:10000]

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([
        "id", "organization_id", "user_id", "meter_key", "quantity", "unit",
        "unit_price", "amount", "currency", "provider_key", "model_name",
        "biz_type", "biz_id", "charge_source", "charge_status",
        "scene_key", "scene_label", "occurred_at",
    ])
    for e in qs.iterator(chunk_size=500):
        metadata = e.metadata or {}
        writer.writerow([
            str(e.id), e.organization_id, e.user_id, e.meter_key,
            str(safe_decimal(e.quantity)), e.unit,
            str(safe_decimal(e.unit_price)), str(safe_decimal(e.amount)),
            e.currency, e.provider_key, e.model_name,
            e.biz_type, e.biz_id,
            metadata.get("charge_source") or metadata.get("credits_remaining_source") or "",
            e.charge_status,
            e.scene_key, _scene_label(e.scene_key),
            e.occurred_at.isoformat() if e.occurred_at else "",
        ])

    response = HttpResponse(buf.getvalue(), content_type="text/csv; charset=utf-8")
    response["Content-Disposition"] = 'attachment; filename="billing_events_export.csv"'
    return response


# ── biz_type 列表 ──────────────────────────────────────────────────


@router.get("/admin/billing/biz-types")
@billing_api_errors
def admin_list_biz_types(request):
    """从 BillingUsageEvent 中动态获取已使用的 biz_type 列表。"""
    _require_admin(request)
    types = (
        BillingUsageEvent.objects
        .exclude(biz_type="")
        .values_list("biz_type", flat=True)
        .distinct()
        .order_by("biz_type")
    )
    return success_response(data={"biz_types": list(types)})


@router.get("/admin/billing/meter-keys")
@billing_api_errors
def admin_list_meter_keys(request):
    """从 BillingUsageEvent 中动态获取已使用的 meter_key 列表。"""
    _require_admin(request)
    keys = (
        BillingUsageEvent.objects
        .exclude(meter_key="")
        .values_list("meter_key", flat=True)
        .distinct()
        .order_by("meter_key")
    )
    return success_response(data={"meter_keys": list(keys)})


@router.get("/admin/billing/model-names")
@billing_api_errors
def admin_list_model_names(request):
    """从 BillingUsageEvent 中动态获取已使用的 model_name 列表。"""
    _require_admin(request)
    names = list(
        BillingUsageEvent.objects
        .exclude(model_name="")
        .values_list("model_name", flat=True)
        .distinct()
        .order_by("model_name")[:500]
    )
    return success_response(data={"model_names": names})


# ── 预算策略管理 ──────────────────────────────────────────────────


@router.get("/admin/billing/budget-policies")
@billing_api_errors
def admin_list_budget_policies(
    request,
    organization_id: Optional[str] = None,
    is_active: Optional[bool] = None,
    order_by: Optional[str] = None,
    page: int = 1,
    page_size: int = 50,
):
    _require_admin(request)

    _BUDGET_SORT = frozenset({"updated_at", "created_at", "organization_id"})
    qs = BillingBudgetPolicy.objects.all()
    qs = apply_ordering(qs, order_by, _BUDGET_SORT)
    if organization_id:
        qs = qs.filter(organization_id=organization_id)
    if is_active is not None:
        qs = qs.filter(is_active=is_active)

    policies, meta = _paginate(qs, page, page_size)

    items = []
    for p in policies:
        items.append({
            "id": str(p.id),
            "organization_id": p.organization_id,
            "warning_threshold_percent": float(p.warning_threshold_percent),
            "critical_threshold_percent": float(p.critical_threshold_percent),
            "block_on_critical": p.block_on_critical,
            "is_active": p.is_active,
            "created_at": p.created_at.isoformat() if p.created_at else None,
            "updated_at": p.updated_at.isoformat() if p.updated_at else None,
        })

    return success_response(data={"policies": items, **meta})


class BudgetPolicyIn(Schema):
    organization_id: str
    warning_threshold_percent: float = 80.0
    critical_threshold_percent: float = 100.0
    block_on_critical: bool = False
    is_active: bool = True


@router.post("/admin/billing/budget-policies")
@billing_api_errors
def admin_create_budget_policy(request, data: BudgetPolicyIn):
    _require_admin(request)

    if data.critical_threshold_percent < data.warning_threshold_percent:
        raise HttpError(400, "critical_threshold 不能小于 warning_threshold")

    policy, created = BillingBudgetPolicy.objects.update_or_create(
        organization_id=data.organization_id,
        defaults={
            "warning_threshold_percent": Decimal(str(data.warning_threshold_percent)),
            "critical_threshold_percent": Decimal(str(data.critical_threshold_percent)),
            "block_on_critical": data.block_on_critical,
            "is_active": data.is_active,
        },
    )

    record_billing_audit(
        request, action="budget_create" if created else "budget_update",
        target_type="budget_policy", target_id=str(policy.id),
        organization_id=data.organization_id,
        detail={"warning": str(data.warning_threshold_percent), "critical": str(data.critical_threshold_percent)},
    )

    return success_response(
        data={
            "id": str(policy.id),
            "organization_id": policy.organization_id,
            "warning_threshold_percent": float(policy.warning_threshold_percent),
            "critical_threshold_percent": float(policy.critical_threshold_percent),
            "block_on_critical": policy.block_on_critical,
            "is_active": policy.is_active,
        },
        message=_("billing.budget_policy_created") if created else _("billing.budget_policy_updated"),
    )


@router.put("/admin/billing/budget-policies/{policy_id}")
@billing_api_errors
def admin_update_budget_policy(request, policy_id: str, data: BudgetPolicyIn):
    _require_admin(request)

    policy = BillingBudgetPolicy.objects.filter(id=policy_id).first()
    if not policy:
        raise HttpError(404, _("billing.policy_not_found"))

    if data.critical_threshold_percent < data.warning_threshold_percent:
        raise HttpError(400, "critical_threshold 不能小于 warning_threshold")

    before = {"warning": str(policy.warning_threshold_percent), "critical": str(policy.critical_threshold_percent)}

    policy.warning_threshold_percent = Decimal(str(data.warning_threshold_percent))
    policy.critical_threshold_percent = Decimal(str(data.critical_threshold_percent))
    policy.block_on_critical = data.block_on_critical
    policy.is_active = data.is_active
    policy.save()

    record_billing_audit(
        request, action="budget_update", target_type="budget_policy", target_id=policy_id,
        organization_id=policy.organization_id,
        detail={"before": before, "after": {"warning": str(data.warning_threshold_percent), "critical": str(data.critical_threshold_percent)}},
    )

    return success_response(data={
        "id": str(policy.id),
        "organization_id": policy.organization_id,
        "warning_threshold_percent": float(policy.warning_threshold_percent),
        "critical_threshold_percent": float(policy.critical_threshold_percent),
        "block_on_critical": policy.block_on_critical,
        "is_active": policy.is_active,
    }, message=_("billing.budget_policy_update_success"))


@router.delete("/admin/billing/budget-policies/{policy_id}")
@billing_api_errors
def admin_delete_budget_policy(request, policy_id: str):
    _require_admin(request)

    policy = BillingBudgetPolicy.objects.filter(id=policy_id).first()
    if not policy:
        raise HttpError(404, _("billing.policy_not_found"))

    ws_id = policy.organization_id
    policy.delete()

    record_billing_audit(
        request, action="budget_delete", target_type="budget_policy", target_id=policy_id,
        organization_id=ws_id,
    )

    return success_response(data={"deleted": True}, message=_("billing.budget_policy_deleted"))


# ── 定价管理 ──────────────────────────────────────────────────────


@router.get("/admin/billing/pricing")
@billing_api_errors
def admin_list_pricing(
    request,
    meter_key: Optional[str] = None,
    scope: Optional[str] = None,
    is_active: Optional[bool] = None,
    order_by: Optional[str] = None,
    page: int = 1,
    page_size: int = 50,
):
    _require_admin(request)

    qs = MeterPricing.objects.all()
    qs = apply_ordering(qs, order_by, _PRICING_SORT)
    if meter_key:
        qs = qs.filter(meter_key__icontains=meter_key)
    if scope:
        qs = qs.filter(scope=scope)
    if is_active is not None:
        qs = qs.filter(is_active=is_active)

    rows, meta = _paginate(qs, page, page_size)

    items = []
    for p in rows:
        items.append({
            "id": str(p.id),
            "meter_key": p.meter_key,
            "scope": p.scope,
            "organization_id": p.organization_id or "",
            "provider_key": p.provider_key,
            "model_name": p.model_name,
            "unit": p.unit,
            "unit_price": str(safe_decimal(p.unit_price)),
            "currency": p.currency,
            "precision": p.precision,
            "is_active": p.is_active,
            "priority": p.priority,
            "effective_from": p.effective_from.isoformat() if p.effective_from else None,
            "effective_to": p.effective_to.isoformat() if p.effective_to else None,
            "created_at": p.created_at.isoformat() if p.created_at else None,
            "updated_at": p.updated_at.isoformat() if p.updated_at else None,
        })

    return success_response(data={"pricing_rules": items, **meta})


class PricingIn(Schema):
    meter_key: str
    scope: str = "global"
    organization_id: Optional[str] = None
    provider_key: str = ""
    model_name: str = ""
    unit: str = "unit"
    unit_price: str = "0"
    currency: str = "CNY"
    precision: int = 4
    is_active: bool = True
    priority: int = 0
    effective_from: Optional[str] = None
    effective_to: Optional[str] = None


@router.post("/admin/billing/pricing")
@billing_api_errors
def admin_create_pricing(request, data: PricingIn):
    _require_admin(request)

    valid_scopes = {c[0] for c in MeterPricing.SCOPE_CHOICES}
    if data.scope not in valid_scopes:
        raise HttpError(400, _("billing.invalid_scope", scope=data.scope, valid=str(sorted(valid_scopes))))

    try:
        unit_price = Decimal(data.unit_price)
    except (InvalidOperation, ValueError):
        raise HttpError(400, "unit_price 格式无效")

    effective_from = timezone.now()
    if data.effective_from:
        dt = parse_datetime(data.effective_from)
        if dt:
            effective_from = dt

    effective_to = None
    if data.effective_to:
        effective_to = parse_datetime(data.effective_to)

    pricing = MeterPricing.objects.create(
        meter_key=data.meter_key,
        scope=data.scope,
        organization_id=data.organization_id or None,
        provider_key=data.provider_key,
        model_name=data.model_name,
        unit=data.unit,
        unit_price=unit_price,
        currency=data.currency,
        precision=data.precision,
        is_active=data.is_active,
        priority=data.priority,
        effective_from=effective_from,
        effective_to=effective_to,
    )

    record_billing_audit(
        request, action="pricing_create", target_type="pricing_rule", target_id=str(pricing.id),
        detail={"meter_key": data.meter_key, "unit_price": str(unit_price), "scope": data.scope},
    )

    return success_response(data={"id": str(pricing.id)}, message=_("billing.pricing_created"))


@router.put("/admin/billing/pricing/{pricing_id}")
@billing_api_errors
def admin_update_pricing(request, pricing_id: str, data: PricingIn):
    _require_admin(request)

    pricing = MeterPricing.objects.filter(id=pricing_id).first()
    if not pricing:
        raise HttpError(404, _("billing.pricing_not_found"))

    valid_scopes = {c[0] for c in MeterPricing.SCOPE_CHOICES}
    if data.scope not in valid_scopes:
        raise HttpError(400, _("billing.invalid_scope", scope=data.scope, valid=str(sorted(valid_scopes))))

    try:
        unit_price = Decimal(data.unit_price)
    except (InvalidOperation, ValueError):
        raise HttpError(400, "unit_price 格式无效")

    pricing.meter_key = data.meter_key
    pricing.scope = data.scope
    pricing.organization_id = data.organization_id or None
    pricing.provider_key = data.provider_key
    pricing.model_name = data.model_name
    pricing.unit = data.unit
    pricing.unit_price = unit_price
    pricing.currency = data.currency
    pricing.precision = data.precision
    pricing.is_active = data.is_active
    pricing.priority = data.priority

    if data.effective_from is not None:
        dt = parse_datetime(data.effective_from)
        if dt:
            pricing.effective_from = dt
    if data.effective_to is not None:
        if data.effective_to == "":
            pricing.effective_to = None
        else:
            pricing.effective_to = parse_datetime(data.effective_to)

    pricing.save()

    record_billing_audit(
        request, action="pricing_update", target_type="pricing_rule", target_id=pricing_id,
        detail={"meter_key": data.meter_key, "unit_price": str(unit_price), "scope": data.scope},
    )

    return success_response(data={"id": str(pricing.id)}, message=_("billing.pricing_updated"))


@router.delete("/admin/billing/pricing/{pricing_id}")
@billing_api_errors
def admin_delete_pricing(request, pricing_id: str, reason: str = "", ticket_id: str = ""):
    _require_admin(request)
    _ensure_admin_permission(request, "pricing_rule:update")
    normalized_reason = (reason or "").strip()
    if not normalized_reason:
        raise HttpError(400, "reason 不能为空")

    pricing = MeterPricing.objects.filter(id=pricing_id).first()
    if not pricing:
        raise HttpError(404, _("billing.pricing_not_found"))

    detail = {
        "meter_key": pricing.meter_key,
        "unit_price": str(pricing.unit_price),
        "provider_key": pricing.provider_key,
        "model_name": pricing.model_name,
    }
    before_json = {
        "pricing_rule_id": str(pricing.id),
        "service_type": pricing.meter_key,
        "rule_scope": pricing.scope,
        "provider_key": pricing.provider_key or "",
        "model_name": pricing.model_name or "",
        "unit_price": str(pricing.unit_price),
        "status": "active" if pricing.is_active else "inactive",
    }
    pricing.delete()

    record_billing_audit(
        request, action="pricing_delete", target_type="pricing_rule", target_id=pricing_id,
        detail=detail,
    )
    record_admin_sensitive_action(
        request,
        permission_code="pricing_rule:update",
        action="pricing_rule.delete",
        target_type="pricing_rule",
        target_id=pricing_id,
        reason=normalized_reason,
        ticket_id=(ticket_id or "").strip(),
        before_json=before_json,
        after_json={
            "pricing_rule_id": pricing_id,
            "status": "deleted",
        },
    )

    return success_response(data={"deleted": True}, message=_("billing.pricing_deleted"))


# ── 会员管理 ──────────────────────────────────────────────────────


@router.get("/admin/membership/tiers")
@billing_api_errors
def admin_list_membership_tiers(request):
    _require_admin(request)

    tiers = list(MembershipTier.objects.all().order_by("sort_order", "created_at"))
    items = []
    for t in tiers:
        item = {
            "id": str(t.id),
            "tier_type": t.tier_type,
            "name": t.name,
            "description": t.description,
            "price": str(safe_decimal(t.price)),
            "duration_months": t.duration_months,
            "included_llm_credits_monthly": str(safe_decimal(t.included_llm_credits_monthly)),
            "included_storage_bytes": t.included_storage_bytes,
            "included_media_monthly": t.included_media_monthly,
            "included_search_monthly": t.included_search_monthly,
            "included_tts_monthly": t.included_tts_monthly,
            "max_tables": t.max_tables,
            "max_records_per_table": t.max_records_per_table,
            "max_members": t.max_members,
            "base_seats": t.base_seats,
            "trash_retention_days": t.trash_retention_days,
            "features": t.features or {},
            "is_active": t.is_active,
            "sort_order": t.sort_order,
            "display_order": t.sort_order,
            "tier_level": t.tier_level,
            "updated_at": t.updated_at.isoformat() if t.updated_at else None,
        }
        if hasattr(t, "max_documents"):
            item["max_documents"] = getattr(t, "max_documents")
        if hasattr(t, "max_groups"):
            item["max_groups"] = getattr(t, "max_groups")
        items.append(item)

    return success_response(data={"tiers": items, "total": len(items)})


def _serialize_organization_membership(membership: OrganizationMembership, organization: Organization | None = None) -> dict:
    owner = getattr(organization, "owner", None) if organization else None
    owner_name = owner.get_display_name() if owner and hasattr(owner, "get_display_name") else ""
    return {
        "id": str(membership.id),
        "user_id": str(getattr(owner, "id", "") or ""),
        "organization_id": membership.organization_id,
        "username": getattr(organization, "name", "") if organization else membership.organization_id,
        "email": getattr(owner, "email", "") or owner_name,
        "tier_type": membership.tier.tier_type,
        "tier_name": membership.tier.name,
        "status": membership.status,
        "start_date": membership.start_date.isoformat() if membership.start_date else None,
        "end_date": membership.end_date.isoformat() if membership.end_date else None,
        "auto_renew": membership.auto_renew,
        "updated_at": membership.updated_at.isoformat() if membership.updated_at else None,
    }


@router.get("/admin/membership/users")
@billing_api_errors
def admin_list_memberships(
    request,
    keyword: Optional[str] = None,
    status: Optional[str] = None,
    order_by: Optional[str] = None,
    page: int = 1,
    page_size: int = 50,
):
    """列出组织会员。

    AdminDash 历史路径叫 ``membership/users``，但当前计费主体已经收敛到
    Organization。这里保持前端字段名兼容，列表内容展示团队名和 owner 邮箱。
    """
    _require_admin(request)

    qs = OrganizationMembership.objects.select_related("tier").all()
    if status:
        qs = qs.filter(status=status)
    if keyword:
        keyword = keyword.strip()
        if keyword:
            matching_organization_ids = list(
                Organization.objects.filter(
                    Q(name__icontains=keyword)
                    | Q(owner__email__icontains=keyword)
                    | Q(owner__username__icontains=keyword)
                ).values_list("id", flat=True)[:500]
            )
            try:
                matching_organization_ids.append(uuid.UUID(keyword))
            except ValueError:
                pass
            matching_organization_id_strings = [str(organization_id) for organization_id in matching_organization_ids]
            qs = qs.filter(
                Q(id__icontains=keyword)
                | Q(organization_id__icontains=keyword)
                | Q(tier__name__icontains=keyword)
                | Q(tier__tier_type__icontains=keyword)
                | Q(organization_id__in=matching_organization_id_strings)
            )

    qs = apply_ordering(qs, order_by, _MEMBERSHIP_SORT)
    memberships, meta = _paginate(qs, page, page_size)
    organization_ids = []
    for item in memberships:
        try:
            organization_ids.append(uuid.UUID(item.organization_id))
        except ValueError:
            continue
    organization_map = {
        str(organization.id): organization
        for organization in Organization.objects.filter(id__in=organization_ids).select_related("owner")
    }
    items = [
        _serialize_organization_membership(membership, organization_map.get(membership.organization_id))
        for membership in memberships
    ]
    return success_response(data={"memberships": items, **meta})


class TierUpdateIn(Schema):
    name: Optional[str] = None
    description: Optional[str] = None
    price: Optional[str] = None
    duration_months: Optional[int] = None
    included_storage_bytes: Optional[int] = None
    included_llm_credits_monthly: Optional[str] = None
    included_media_monthly: Optional[int] = None
    included_search_monthly: Optional[int] = None
    included_tts_monthly: Optional[int] = None
    max_tables: Optional[int] = None
    max_documents: Optional[int] = None
    max_groups: Optional[int] = None
    max_records_per_table: Optional[int] = None
    max_members: Optional[int] = None
    base_seats: Optional[int] = None
    trash_retention_days: Optional[int] = None
    is_active: Optional[bool] = None
    sort_order: Optional[int] = None


class MembershipUpdateIn(Schema):
    status: Optional[str] = None
    tier_type: Optional[str] = None
    auto_renew: Optional[bool] = None
    end_date: Optional[str] = None
    reason: Optional[str] = None
    ticket_id: Optional[str] = None


class MembershipUpgradePreviewIn(Schema):
    target_tier_id: str
    billing_cycle: str = "monthly"


class MembershipUpgradeOrderIn(MembershipUpgradePreviewIn):
    quote_token: str


class MembershipUpgradeWalletPayIn(Schema):
    reason: str
    ticket_id: str = ""


class MembershipPurchaseIn(Schema):
    target_tier_id: str
    billing_cycle: str = "monthly"


class MembershipPaymentMethodSwitchIn(Schema):
    payment_method: str  # alipay | wechat


def _membership_upgrade_error(error: MembershipLifecycleError):
    status_code = 402 if isinstance(error, MembershipUpgradeBalanceError) else 400
    data = getattr(error, "data", None)
    code = getattr(error, "error_code", "MEMBERSHIP_UPGRADE_FAILED")
    return error_response_with_status(code, message=str(error), status_code=status_code, data=data)


def _ensure_admin_current_period_price_snapshot(membership: OrganizationMembership) -> Optional[dict]:
    """
    管理端升级专用：运营开通 / 测试灌数时可能没有本周期成交价快照，
    此时按当前套餐标价补录，避免 AdminDash 无法生成升级报价。

    Electron 用户侧报价仍走严格快照校验，不会调用本函数。
    """
    if membership.current_actual_paid_period_price is not None:
        return None
    tier = membership.tier
    if tier is None:
        raise HttpError(400, "当前套餐不存在，无法补录成交价快照")
    try:
        price = Decimal(str(tier.price or 0)).quantize(Decimal("0.01"))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise HttpError(400, "当前套餐标价无效，无法补录成交价快照") from exc
    if price < 0:
        raise HttpError(400, "当前套餐标价无效，无法补录成交价快照")

    membership.current_actual_paid_period_price = price
    membership.save(update_fields=["current_actual_paid_period_price", "updated_at"])
    logger.info(
        "admin backfilled membership period price snapshot org=%s membership=%s price=%s",
        membership.organization_id,
        membership.id,
        price,
    )
    return {
        "backfilled": True,
        "current_actual_paid_period_price": format(price, "f"),
        "source": "membership_tier.price",
        "note": "缺少本周期成交价快照，已按当前套餐标价补录后报价",
    }


def _membership_payment_error(error: MembershipPaymentError):
    status_code = 402 if error.code == "ORGANIZATION_BALANCE_INSUFFICIENT" else 400
    if error.code.endswith("NOT_FOUND"):
        status_code = 404
    elif error.code in {
        "PAYMENT_SWITCH_NOT_ALLOWED",
        "PAYMENT_SWITCH_UNCONFIRMED",
        "PAYMENT_STATUS_CHANGED",
    }:
        status_code = 409
    return error_response_with_status(
        error.code,
        message=str(error),
        status_code=status_code,
        data=error.data,
    )


def _serialize_admin_membership_purchase_order(order: PaymentOrder) -> dict:
    """把新购会员订单整理成与运营侧 / Electron 相近的视图。"""
    options = MembershipPaymentService().payment_options(
        organization_id=str(order.organization_id),
        order_id=str(order.id),
    )
    business = dict(order.business_data or {})
    snapshot = dict(business.get("pricing_snapshot") or {})
    available = Decimal(str(options.get("wallet_balance") or 0)).quantize(Decimal("0.01"))
    amount = Decimal(str(options.get("order_amount") or order.amount or 0)).quantize(Decimal("0.01"))
    shortage = Decimal(str(options.get("shortage_amount") or 0)).quantize(Decimal("0.01"))
    allowed = dict(options.get("allowed_actions") or {})
    return {
        "order_id": str(order.id),
        "order_no": order.order_no,
        "action": business.get("change_type") or MembershipChangeAction.NEW.value,
        "target_plan": snapshot.get("target_tier_name") or order.subject,
        "payment_status": options.get("payment_status") or order.status,
        "benefit_status": options.get("benefit_status") or order.benefit_status or "pending",
        "payable_amount": format(amount, ".2f"),
        "currency": "CNY",
        "payment_method": options.get("payment_method") or order.payment_method,
        "payment_data": options.get("payment_data"),
        "wallet": {
            "available_cny": format(available, ".2f"),
            "available_balance": format(available, ".2f"),
            "shortage_amount": format(shortage, ".2f"),
            "sufficient": shortage <= 0,
            "recommended_recharge_amount": format(shortage, ".2f") if shortage > 0 else "0.00",
        },
        "allowed_actions": {
            "pay_with_wallet": bool(allowed.get("organization_wallet")),
            "pay_with_alipay": bool(allowed.get("alipay")),
            "pay_with_wechat": bool(allowed.get("wechat")),
            "organization_wallet": bool(allowed.get("organization_wallet")),
            "alipay": bool(allowed.get("alipay")),
            "wechat": bool(allowed.get("wechat")),
            "recharge": shortage > 0,
            "refresh": True,
            "close": True,
        },
        "created_at": order.created_at.isoformat() if order.created_at else None,
        "paid_at": order.paid_at.isoformat() if order.paid_at else None,
        "expired_at": order.expired_at.isoformat() if order.expired_at else None,
    }


def _admin_get_membership_purchase_order(organization_id: str, order_id: str) -> PaymentOrder:
    order = PaymentOrder.objects.filter(
        id=order_id,
        organization_id=organization_id,
        order_type="membership",
    ).first()
    if order is None:
        raise HttpError(404, "订阅订单不存在")
    change_type = (order.business_data or {}).get("change_type") or ""
    if change_type != MembershipChangeAction.NEW.value:
        raise HttpError(
            400,
            {
                "code": "MEMBERSHIP_ACTION_MISMATCH",
                "message": "该订单不是首次订阅订单",
            },
        )
    return order


def _admin_pay_existing_membership_order(
    *,
    organization_id: str,
    order_id: str,
    payment_method: str,
):
    """Admin 代发起第三方扫码支付，逻辑对齐会员侧 `_pay_existing_membership_order`。"""
    with db_transaction.atomic():
        order = (
            PaymentOrder.objects.select_for_update()
            .filter(id=str(order_id), organization_id=str(organization_id), order_type="membership")
            .first()
        )
        if not order:
            return error_response_with_status(
                "MEMBERSHIP_ORDER_NOT_FOUND",
                message="会员订单不存在",
                status_code=404,
            )
        if order.payment_method == "organization_wallet" and order.status == "paid":
            return error_response_with_status(
                "PAYMENT_METHOD_CONFLICT",
                message="订单已使用组织余额支付",
                status_code=409,
            )
        business_data = dict(order.business_data or {})
        if (business_data.get("change_type") or "") != MembershipChangeAction.NEW.value:
            return error_response_with_status(
                "MEMBERSHIP_ACTION_MISMATCH",
                message="该订单不是首次订阅订单",
                status_code=400,
            )
        existing = business_data.get("third_party_payment")
        if order.status == "pending" and order.is_expired():
            order.status = "expired"
            order.save(update_fields=["status", "updated_at"])
            return error_response_with_status(
                "MEMBERSHIP_ORDER_EXPIRED",
                message="订单已过期，请重新创建订单",
                status_code=400,
            )
        if existing and order.payment_method == payment_method and order.status in {
            "pending",
            "paying",
        }:
            return success_response(data=existing)
        if order.status == "paying" and order.payment_method != payment_method:
            channel = "支付宝" if order.payment_method == "alipay" else "微信"
            return error_response_with_status(
                "PAYMENT_METHOD_LOCKED",
                message=f"订单已发起{channel}扫码支付，请继续使用原支付方式或先更换支付方式",
                status_code=409,
            )
        if order.status != "pending":
            return error_response_with_status(
                "MEMBERSHIP_ORDER_STATUS_INVALID",
                message="订单状态不允许支付",
                status_code=400,
            )
        from apps.services.payment.services.factory import PaymentServiceFactory

        result = PaymentServiceFactory.get_service(payment_method).create_payment(
            order_no=order.order_no,
            amount=order.amount,
            subject=order.subject,
            description=order.description,
            extra_params={"payment_type": "qr" if payment_method == "alipay" else "native"},
        )
        data = {
            "order_id": str(order.id),
            "order_no": order.order_no,
            "payment_method": payment_method,
            "amount": str(order.amount),
            "pay_url": result.get("pay_url"),
            "qr_code": result.get("qr_code"),
            "form_html": result.get("form_html"),
            "expired_at": order.expired_at.isoformat() if order.expired_at else None,
        }
        order.payment_method = payment_method
        order.third_party_order_no = result.get("third_party_order_no", "")
        order.status = "paying"
        order.business_data = {
            **business_data,
            "payment_source": {"method": payment_method, "channel": "third_party"},
            "third_party_payment": data,
        }
        order.save(
            update_fields=[
                "payment_method",
                "third_party_order_no",
                "status",
                "business_data",
                "updated_at",
            ]
        )
        return success_response(data=data)


@router.get("/admin/membership/organizations/{organization_id}/subscription")
@billing_api_errors
def admin_get_organization_subscription(request, organization_id: str):
    """返回组织订阅、套餐点券、现金点券和权益的统一快照。"""
    _require_admin(request)
    if not Organization.objects.filter(id=organization_id).exists():
        raise HttpError(404, "组织不存在")
    return success_response(data=SubscriptionCatalogService().get_overview(organization_id))


@router.get("/admin/membership/organizations/{organization_id}/plans")
@billing_api_errors
def admin_get_organization_subscription_plans(request, organization_id: str):
    """返回可售套餐及服务端判定的套餐变更动作。"""
    _require_admin(request)
    if not Organization.objects.filter(id=organization_id).exists():
        raise HttpError(404, "组织不存在")
    return success_response(data=SubscriptionCatalogService().get_plans(organization_id))


@router.post("/admin/membership/organizations/{organization_id}/upgrade-preview")
@billing_api_errors
def admin_preview_organization_membership_upgrade(
    request,
    organization_id: str,
    data: MembershipUpgradePreviewIn,
):
    """生成与 Electron 相同口径的按剩余周期折算升级报价。"""
    _require_admin(request)
    membership = (
        OrganizationMembership.objects
        .select_related("tier")
        .filter(organization_id=organization_id)
        .first()
    )
    if membership is None:
        raise HttpError(404, "组织会员记录不存在")
    target_tier = MembershipTier.objects.filter(id=data.target_tier_id, is_active=True).first()
    if target_tier is None:
        raise HttpError(404, "目标套餐不存在或未启用")
    try:
        backfill = _ensure_admin_current_period_price_snapshot(membership)
        if backfill:
            record_billing_audit(
                request,
                action="membership_period_price_snapshot_backfill",
                target_type="organization_membership",
                target_id=str(membership.id),
                organization_id=organization_id,
                detail=backfill,
            )
        pricing = SubscriptionPricingService()
        quote = pricing.calculate_upgrade_quote(
            organization_id=organization_id,
            membership=membership,
            target_tier=target_tier,
            target_billing_cycle=data.billing_cycle or "monthly",
        )
        quote_token = pricing.create_quote_token(quote)
        preview = quote.to_preview_data(
            current_tier=membership.tier,
            target_tier=target_tier,
            quote_token=quote_token,
        )
        if backfill:
            notes = list(preview.get("notes") or [])
            notes.append(backfill["note"])
            preview["notes"] = notes
            preview["admin_price_snapshot_backfilled"] = True
        return success_response(data=preview)
    except MembershipLifecycleError as error:
        return _membership_upgrade_error(error)


@router.post("/admin/membership/organizations/{organization_id}/upgrade")
@billing_api_errors
def admin_create_organization_membership_upgrade_order(
    request,
    organization_id: str,
    data: MembershipUpgradeOrderIn,
):
    """创建组织钱包支付的升级订单；此步骤不扣款、不变更权益。"""
    _require_admin(request)
    try:
        membership = (
            OrganizationMembership.objects
            .select_related("tier")
            .filter(organization_id=organization_id)
            .first()
        )
        if membership is not None:
            backfill = _ensure_admin_current_period_price_snapshot(membership)
            if backfill:
                record_billing_audit(
                    request,
                    action="membership_period_price_snapshot_backfill",
                    target_type="organization_membership",
                    target_id=str(membership.id),
                    organization_id=organization_id,
                    detail=backfill,
                )
        order = SubscriptionOrderService().create_upgrade_order(
            user=request.auth,
            organization_id=organization_id,
            target_tier_id=data.target_tier_id,
            billing_cycle=data.billing_cycle or "monthly",
            quote_token=data.quote_token,
            bypass_feature_gates=True,
        )
        record_billing_audit(
            request,
            action="membership_upgrade_order_create",
            target_type="organization",
            target_id=organization_id,
            organization_id=organization_id,
            detail={"order_id": order.get("order_id"), "order_no": order.get("order_no")},
        )
        return success_response(data=order)
    except MembershipLifecycleError as error:
        return _membership_upgrade_error(error)


@router.get("/admin/membership/organizations/{organization_id}/upgrade-orders/active")
@billing_api_errors
def admin_get_active_organization_membership_upgrade_order(request, organization_id: str):
    """恢复组织当前未完成的升级订单，与 Electron 使用相同订单状态。"""
    _require_admin(request)
    if not Organization.objects.filter(id=organization_id).exists():
        raise HttpError(404, "组织不存在")
    return success_response(
        data=SubscriptionOrderService().get_active_upgrade_order(
            organization_id=organization_id,
        )
    )


@router.get("/admin/membership/organizations/{organization_id}/upgrade-orders/{order_id}")
@billing_api_errors
def admin_get_organization_membership_upgrade_order(
    request,
    organization_id: str,
    order_id: str,
):
    """查询组织升级订单状态，与 Electron 使用相同订单状态。"""
    _require_admin(request)
    try:
        return success_response(
            data=SubscriptionOrderService().get_upgrade_order(
                organization_id=organization_id,
                order_id=order_id,
            )
        )
    except PaymentOrder.DoesNotExist:
        return error_response_with_status(
            "MEMBERSHIP_UPGRADE_ORDER_NOT_FOUND",
            message="会员升级订单不存在",
            status_code=404,
        )


@router.post(
    "/admin/membership/organizations/{organization_id}/upgrade-orders/{order_id}/wallet-pay"
)
@billing_api_errors
def admin_pay_organization_membership_upgrade_order(
    request,
    organization_id: str,
    order_id: str,
    data: MembershipUpgradeWalletPayIn,
):
    """由运营人员确认后，从组织现金钱包扣款并应用套餐权益。"""
    _require_admin(request)
    reason = data.reason.strip()
    if not reason:
        raise HttpError(400, {"code": "REASON_REQUIRED", "message": "升级套餐必须填写操作原因"})
    try:
        order = SubscriptionOrderService().wallet_pay_upgrade_order(
            user=request.auth,
            organization_id=organization_id,
            order_id=order_id,
            bypass_feature_gates=True,
        )
        record_billing_audit(
            request,
            action="membership_upgrade_wallet_pay",
            target_type="organization",
            target_id=organization_id,
            organization_id=organization_id,
            detail={
                "order_id": order.get("order_id"),
                "order_no": order.get("order_no"),
                "payable_amount": order.get("payable_amount"),
                "payment_status": order.get("payment_status"),
                "benefit_status": order.get("benefit_status"),
                "reason": reason,
                "ticket_id": data.ticket_id.strip(),
            },
        )
        record_admin_sensitive_action(
            request,
            permission_code="plan:update",
            action="billing.membership.upgrade.wallet_pay",
            target_type="organization",
            target_id=organization_id,
            reason=reason,
            ticket_id=data.ticket_id,
            after_json={
                "order_id": order.get("order_id"),
                "order_no": order.get("order_no"),
                "payable_amount": order.get("payable_amount"),
                "payment_status": order.get("payment_status"),
                "benefit_status": order.get("benefit_status"),
            },
        )
        return success_response(data=order)
    except PaymentOrder.DoesNotExist:
        raise HttpError(404, "升级订单不存在")
    except MembershipLifecycleError as error:
        return _membership_upgrade_error(error)


@router.post("/admin/membership/organizations/{organization_id}/purchase")
@billing_api_errors
def admin_create_organization_membership_purchase_order(
    request,
    organization_id: str,
    data: MembershipPurchaseIn,
):
    """为免费组织创建首次订阅订单（钱包支付，不扣款）。"""
    _require_admin(request)
    if not Organization.objects.filter(id=organization_id).exists():
        raise HttpError(404, "组织不存在")
    target_tier = MembershipTier.objects.filter(id=data.target_tier_id, is_active=True).first()
    if target_tier is None:
        raise HttpError(404, "目标套餐不存在或未启用")
    billing_cycle = (data.billing_cycle or "monthly").strip().lower()
    change_type, _state = classify_organization_membership_change(
        organization_id=organization_id,
        target_tier=target_tier,
        target_billing_cycle=billing_cycle,
    )
    if change_type != MembershipChangeAction.NEW.value:
        raise HttpError(
            400,
            {
                "code": "MEMBERSHIP_ACTION_MISMATCH",
                "message": f"该套餐动作是 {change_type}，不能走首次订阅",
                "correct_action": change_type,
            },
        )
    snapshot = {
        "target_tier_id": str(target_tier.id),
        "target_tier_name": target_tier.name,
        "target_tier_level": target_tier.tier_level,
        "target_effective_period_price": str(target_tier.price),
        "billing_cycle": billing_cycle,
        "currency": "CNY",
    }
    quote_hash = hashlib.sha256(
        json.dumps(snapshot, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    existing = (
        PaymentOrder.objects.filter(
            organization_id=organization_id,
            order_type="membership",
            status__in=["pending", "paying"],
            business_data__quote_hash=quote_hash,
        )
        .order_by("-created_at")
        .first()
    )
    if existing and existing.status == "pending" and existing.is_expired():
        existing.status = "expired"
        existing.save(update_fields=["status", "updated_at"])
        existing = None
    # paying 但扫码单已过期时也不复用，避免运营被卡在失效订单上。
    if existing and existing.status == "paying" and existing.is_expired():
        existing.status = "expired"
        existing.save(update_fields=["status", "updated_at"])
        existing = None
    if existing:
        return success_response(data=_serialize_admin_membership_purchase_order(existing))

    order = PaymentOrder.objects.create(
        user_id=str(request.auth.id),
        organization_id=organization_id,
        order_type="membership",
        subject=f"购买会员：{target_tier.name}",
        description=f"{target_tier.name} - {billing_cycle}",
        amount=Decimal(str(target_tier.price)),
        payment_method="organization_wallet",
        status="pending",
        expired_at=timezone.now() + timedelta(minutes=settings.ORDER_EXPIRE_MINUTES),
        business_data={
            "tier_id": str(target_tier.id),
            "organization_id": organization_id,
            "change_type": MembershipChangeAction.NEW.value,
            "billing_cycle": billing_cycle,
            "pricing_snapshot": snapshot,
            "quote_hash": quote_hash,
        },
    )
    record_billing_audit(
        request,
        action="membership_purchase_order_create",
        target_type="organization",
        target_id=organization_id,
        organization_id=organization_id,
        detail={"order_id": str(order.id), "order_no": order.order_no, "tier_id": str(target_tier.id)},
    )
    return success_response(data=_serialize_admin_membership_purchase_order(order))


@router.get("/admin/membership/organizations/{organization_id}/purchase-orders/active")
@billing_api_errors
def admin_get_active_organization_membership_purchase_order(request, organization_id: str):
    """恢复组织当前未完成的首次订阅订单。"""
    _require_admin(request)
    if not Organization.objects.filter(id=organization_id).exists():
        raise HttpError(404, "组织不存在")
    order = (
        PaymentOrder.objects.filter(
            organization_id=organization_id,
            order_type="membership",
            status__in=["pending", "paying", "paid"],
            business_data__change_type=MembershipChangeAction.NEW.value,
        )
        .exclude(benefit_status="completed")
        .order_by("-created_at")
        .first()
    )
    if order and order.status in {"pending", "paying"} and order.is_expired():
        order.status = "expired"
        order.save(update_fields=["status", "updated_at"])
        return success_response(data=None)
    return success_response(
        data=_serialize_admin_membership_purchase_order(order) if order else None
    )


@router.get(
    "/admin/membership/organizations/{organization_id}/purchase-orders/{order_id}"
)
@billing_api_errors
def admin_get_organization_membership_purchase_order(
    request,
    organization_id: str,
    order_id: str,
):
    """查询首次订阅订单状态。"""
    _require_admin(request)
    order = PaymentOrder.objects.filter(
        id=order_id,
        organization_id=organization_id,
        order_type="membership",
    ).first()
    if order is None:
        return error_response_with_status(
            "MEMBERSHIP_PURCHASE_ORDER_NOT_FOUND",
            message="会员订阅订单不存在",
            status_code=404,
        )
    return success_response(data=_serialize_admin_membership_purchase_order(order))


@router.post(
    "/admin/membership/organizations/{organization_id}/purchase-orders/{order_id}/wallet-pay"
)
@billing_api_errors
def admin_pay_organization_membership_purchase_order(
    request,
    organization_id: str,
    order_id: str,
    data: MembershipUpgradeWalletPayIn,
):
    """运营确认后，从组织现金钱包支付首次订阅订单。"""
    _require_admin(request)
    reason = data.reason.strip()
    if not reason:
        raise HttpError(400, {"code": "REASON_REQUIRED", "message": "订阅套餐必须填写操作原因"})
    order = PaymentOrder.objects.filter(
        id=order_id,
        organization_id=organization_id,
        order_type="membership",
    ).first()
    if order is None:
        raise HttpError(404, "订阅订单不存在")
    change_type = (order.business_data or {}).get("change_type") or ""
    if change_type != MembershipChangeAction.NEW.value:
        raise HttpError(
            400,
            {
                "code": "MEMBERSHIP_ACTION_MISMATCH",
                "message": "该订单不是首次订阅订单",
            },
        )
    try:
        paid = MembershipPaymentService().pay_with_wallet(
            user=request.auth,
            organization_id=organization_id,
            order_id=order_id,
        )
        refreshed = PaymentOrder.objects.filter(id=paid.get("order_id") or order_id).first()
        payload = (
            _serialize_admin_membership_purchase_order(refreshed)
            if refreshed
            else {
                "order_id": paid.get("order_id"),
                "payment_status": paid.get("status"),
                "benefit_status": paid.get("benefit_status"),
            }
        )
        record_billing_audit(
            request,
            action="membership_purchase_wallet_pay",
            target_type="organization",
            target_id=organization_id,
            organization_id=organization_id,
            detail={
                "order_id": payload.get("order_id"),
                "order_no": payload.get("order_no"),
                "payable_amount": payload.get("payable_amount"),
                "payment_status": payload.get("payment_status"),
                "benefit_status": payload.get("benefit_status"),
                "reason": reason,
                "ticket_id": data.ticket_id.strip(),
            },
        )
        record_admin_sensitive_action(
            request,
            permission_code="plan:update",
            action="billing.membership.purchase.wallet_pay",
            target_type="organization",
            target_id=organization_id,
            reason=reason,
            ticket_id=data.ticket_id,
            after_json={
                "order_id": payload.get("order_id"),
                "order_no": payload.get("order_no"),
                "payable_amount": payload.get("payable_amount"),
                "payment_status": payload.get("payment_status"),
                "benefit_status": payload.get("benefit_status"),
            },
        )
        return success_response(data=payload)
    except MembershipPaymentError as error:
        return _membership_payment_error(error)


@router.get(
    "/admin/membership/organizations/{organization_id}/purchase-orders/{order_id}/payment-options"
)
@billing_api_errors
def admin_get_organization_membership_purchase_payment_options(
    request,
    organization_id: str,
    order_id: str,
):
    """返回与 Electron 相同的三种支付能力快照。"""
    _require_admin(request)
    order = _admin_get_membership_purchase_order(organization_id, order_id)
    return success_response(data=_serialize_admin_membership_purchase_order(order))


@router.post(
    "/admin/membership/organizations/{organization_id}/purchase-orders/{order_id}/alipay-pay"
)
@billing_api_errors
def admin_pay_organization_membership_purchase_with_alipay(
    request,
    organization_id: str,
    order_id: str,
):
    """运营代发起支付宝扫码支付。"""
    _require_admin(request)
    _admin_get_membership_purchase_order(organization_id, order_id)
    try:
        response = _admin_pay_existing_membership_order(
            organization_id=organization_id,
            order_id=order_id,
            payment_method="alipay",
        )
        if getattr(response, "status_code", 200) < 400:
            record_billing_audit(
                request,
                action="membership_purchase_alipay_pay",
                target_type="organization",
                target_id=organization_id,
                organization_id=organization_id,
                detail={"order_id": order_id, "payment_method": "alipay"},
            )
        return response
    except Exception as exc:
        logger.exception(
            "[BillingAdmin] purchase alipay-pay failed org=%s order=%s",
            organization_id,
            order_id,
        )
        return error_response_with_status(
            "PAYMENT_CREATE_FAILED",
            message=str(exc),
            status_code=400,
        )


@router.post(
    "/admin/membership/organizations/{organization_id}/purchase-orders/{order_id}/wechat-pay"
)
@billing_api_errors
def admin_pay_organization_membership_purchase_with_wechat(
    request,
    organization_id: str,
    order_id: str,
):
    """运营代发起微信扫码支付。"""
    _require_admin(request)
    _admin_get_membership_purchase_order(organization_id, order_id)
    try:
        response = _admin_pay_existing_membership_order(
            organization_id=organization_id,
            order_id=order_id,
            payment_method="wechat",
        )
        if getattr(response, "status_code", 200) < 400:
            record_billing_audit(
                request,
                action="membership_purchase_wechat_pay",
                target_type="organization",
                target_id=organization_id,
                organization_id=organization_id,
                detail={"order_id": order_id, "payment_method": "wechat"},
            )
        return response
    except Exception as exc:
        logger.exception(
            "[BillingAdmin] purchase wechat-pay failed org=%s order=%s",
            organization_id,
            order_id,
        )
        return error_response_with_status(
            "PAYMENT_CREATE_FAILED",
            message=str(exc),
            status_code=400,
        )


@router.post(
    "/admin/membership/organizations/{organization_id}/purchase-orders/{order_id}/switch-payment-method"
)
@billing_api_errors
def admin_switch_organization_membership_purchase_payment_method(
    request,
    organization_id: str,
    order_id: str,
    data: MembershipPaymentMethodSwitchIn,
):
    """安全关闭原扫码订单后，切换到支付宝或微信。"""
    _require_admin(request)
    method = (data.payment_method or "").strip().lower()
    if method not in {"alipay", "wechat"}:
        raise HttpError(400, {"code": "PAYMENT_METHOD_INVALID", "message": "仅支持支付宝或微信"})
    _admin_get_membership_purchase_order(organization_id, order_id)
    try:
        replacement = MembershipPaymentService().switch_third_party_method(
            organization_id=organization_id,
            order_id=order_id,
            target_method=method,
        )
        response = _admin_pay_existing_membership_order(
            organization_id=organization_id,
            order_id=str(replacement.id),
            payment_method=method,
        )
        if getattr(response, "status_code", 200) < 400:
            record_billing_audit(
                request,
                action="membership_purchase_switch_payment",
                target_type="organization",
                target_id=organization_id,
                organization_id=organization_id,
                detail={
                    "from_order_id": order_id,
                    "to_order_id": str(replacement.id),
                    "payment_method": method,
                },
            )
        return response
    except MembershipPaymentError as error:
        return _membership_payment_error(error)
    except Exception as exc:
        logger.exception(
            "[BillingAdmin] purchase switch-payment failed org=%s order=%s",
            organization_id,
            order_id,
        )
        return error_response_with_status(
            "PAYMENT_CREATE_FAILED",
            message=str(exc),
            status_code=400,
        )


@router.put("/admin/membership/users/{membership_id}")
@billing_api_errors
def admin_update_membership(request, membership_id: str, data: MembershipUpdateIn):
    """更新组织会员状态、等级、自动续费或到期日。

    关闭自动续费（auto_renew=false）属敏感操作：原因必填，并写入
    AdminSensitiveActionLog；billing audit detail 同步落 reason / ticket_id。
    """
    _require_admin(request)

    membership = OrganizationMembership.objects.select_related("tier").filter(id=membership_id).first()
    if not membership:
        raise HttpError(404, _("billing.membership_not_found"))

    reason = (data.reason or "").strip()
    ticket_id = (data.ticket_id or "").strip()
    was_auto_renew = bool(membership.auto_renew)
    # 仅「开启 → 关闭」视为敏感操作；已是关闭时再传 false 不强制原因
    closing_auto_renew = data.auto_renew is False and was_auto_renew
    if closing_auto_renew and not reason:
        raise HttpError(400, {"code": "REASON_REQUIRED", "message": "关闭自动续费必须填写原因"})

    before_json = {
        "status": membership.status,
        "tier_type": getattr(membership.tier, "tier_type", None),
        "auto_renew": membership.auto_renew,
        "end_date": membership.end_date.isoformat() if membership.end_date else None,
        "organization_id": membership.organization_id,
    }

    update_fields = []
    if data.status is not None:
        valid_statuses = {choice[0] for choice in OrganizationMembership.STATUS_CHOICES}
        if data.status not in valid_statuses:
            raise HttpError(400, _("billing.invalid_membership_status"))
        membership.status = data.status
        update_fields.append("status")

    if data.tier_type is not None:
        tier = MembershipTier.objects.filter(tier_type=data.tier_type).first()
        if not tier:
            raise HttpError(404, _("billing.tier_not_found"))
        membership.tier = tier
        update_fields.append("tier")

    if data.auto_renew is not None:
        membership.auto_renew = data.auto_renew
        update_fields.append("auto_renew")

    if data.end_date is not None:
        parsed_dt = parse_datetime(data.end_date)
        if parsed_dt is None:
            parsed_date = parse_date(data.end_date)
            if parsed_date is None:
                raise HttpError(400, _("billing.invalid_end_date"))
            parsed_dt = datetime.combine(parsed_date, time.max)
        if timezone.is_naive(parsed_dt):
            parsed_dt = timezone.make_aware(parsed_dt, timezone.get_current_timezone())
        membership.end_date = parsed_dt
        update_fields.append("end_date")

    if update_fields:
        membership.save(update_fields=update_fields + ["updated_at"])
        if {"tier", "status", "end_date"} & set(update_fields):
            OrganizationMembershipService()._sync_entitlement(
                membership.organization_id,
                membership.tier,
                end_date=membership.end_date,
            )
            db_transaction.on_commit(
                lambda organization_id=membership.organization_id: _clear_guard_cache_safe(organization_id)
            )
        audit_detail = {
            "fields": update_fields,
            "reason": reason,
            "ticket_id": ticket_id,
        }
        record_billing_audit(
            request,
            action="membership_update",
            target_type="organization_membership",
            target_id=membership_id,
            organization_id=membership.organization_id,
            detail=audit_detail,
        )
        if closing_auto_renew:
            after_json = {
                "status": membership.status,
                "tier_type": getattr(membership.tier, "tier_type", None),
                "auto_renew": membership.auto_renew,
                "end_date": membership.end_date.isoformat() if membership.end_date else None,
                "organization_id": membership.organization_id,
                "fields": update_fields,
            }
            record_admin_sensitive_action(
                request,
                permission_code="plan:update",
                action="billing.membership.auto_renew.cancel",
                target_type="organization_membership",
                target_id=membership_id,
                reason=reason,
                ticket_id=ticket_id,
                before_json=before_json,
                after_json=after_json,
            )

    organization = Organization.objects.filter(id=membership.organization_id).select_related("owner").first()
    return success_response(data=_serialize_organization_membership(membership, organization))


@router.put("/admin/membership/tiers/{tier_id}")
@billing_api_errors
def admin_update_membership_tier(request, tier_id: str, data: TierUpdateIn):
    """编辑会员等级配置（权益参数）。"""
    _require_admin(request)

    tier = MembershipTier.objects.filter(id=tier_id).first()
    if not tier:
        raise HttpError(404, _("billing.tier_not_found"))

    update_fields = []
    for field_name in (
        "name", "description", "duration_months",
        "included_storage_bytes", "included_media_monthly",
        "included_search_monthly", "included_tts_monthly", "max_tables",
        "max_documents", "max_groups",
        "max_records_per_table", "max_members", "base_seats",
        "trash_retention_days", "is_active", "sort_order",
    ):
        value = getattr(data, field_name, None)
        if value is not None:
            setattr(tier, field_name, value)
            update_fields.append(field_name)

    if data.price is not None:
        tier.price = Decimal(data.price)
        update_fields.append("price")
    if data.included_llm_credits_monthly is not None:
        tier.included_llm_credits_monthly = Decimal(data.included_llm_credits_monthly)
        update_fields.append("included_llm_credits_monthly")

    if not update_fields:
        return success_response(data={"id": tier_id}, message=_("billing.no_change"))

    tier.save(update_fields=update_fields + ["updated_at"])

    return success_response(data={"id": tier_id}, message=_("billing.tier_updated"))


# ── 预算告警 ──────────────────────────────────────────────────────


@router.get("/admin/billing/budget-alerts")
@billing_api_errors
def admin_budget_alerts(request):
    """遍历活跃 BillingBudgetPolicy，检测当月用量是否超过预算阈值。"""
    _require_admin(request)

    policies = list(BillingBudgetPolicy.objects.filter(is_active=True))
    if not policies:
        return success_response(data={
            "alerts": [],
            "summary": {"total_alerts": 0, "critical_alerts": 0, "warning_alerts": 0},
        }, message=_("billing.no_active_budget_policy"))

    current_month_start = timezone.now().replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    organization_ids = [p.organization_id for p in policies]

    monthly_costs = dict(
        BillingUsageEvent.objects.filter(
            organization_id__in=organization_ids,
            occurred_at__gte=current_month_start,
        ).values("organization_id").annotate(total=Sum("amount")).values_list("organization_id", "total")
    )

    wallet_balances = dict(
        OrganizationWallet.objects.filter(
            organization_id__in=organization_ids,
        ).values_list("organization_id", "credits_precise")
    )

    try:
        from apps.users.wallet.services.credits_service import CreditsService
        get_budget = CreditsService.get_organization_monthly_budget
    except ImportError:
        get_budget = None

    alerts: list[dict] = []

    for policy in policies:
        ws_id = policy.organization_id
        monthly_cost = monthly_costs.get(ws_id, Decimal("0")) or Decimal("0")

        budget_limit = None
        if get_budget:
            try:
                budget_limit = get_budget(ws_id)
            except Exception:
                pass

        if not budget_limit or budget_limit <= 0:
            # 无正式预算配置时，以"钱包当前余额 + 已消费"作为等效预算上限
            wallet_balance = wallet_balances.get(ws_id) or Decimal("0")
            effective_budget = safe_decimal(wallet_balance) + monthly_cost
            if effective_budget <= 0:
                continue
            budget_limit = effective_budget

        usage_percent = float((monthly_cost / budget_limit) * 100)

        severity = None
        if usage_percent >= float(policy.critical_threshold_percent):
            severity = "critical"
        elif usage_percent >= float(policy.warning_threshold_percent):
            severity = "warning"

        if severity:
            alerts.append({
                "organization_id": ws_id,
                "severity": severity,
                "usage_percent": round(usage_percent, 2),
                "monthly_cost": str(monthly_cost),
                "budget_limit": str(budget_limit),
                "warning_threshold": float(policy.warning_threshold_percent),
                "critical_threshold": float(policy.critical_threshold_percent),
                "block_on_critical": policy.block_on_critical,
                "message": f"当月用量 {usage_percent:.1f}% 已{'超过' if severity == 'critical' else '达到'}{'严重' if severity == 'critical' else '预警'}阈值",
            })

    alerts.sort(key=lambda a: (0 if a["severity"] == "critical" else 1, -a["usage_percent"]))

    return success_response(data={
        "alerts": alerts,
        "summary": {
            "total_alerts": len(alerts),
            "critical_alerts": sum(1 for a in alerts if a["severity"] == "critical"),
            "warning_alerts": sum(1 for a in alerts if a["severity"] == "warning"),
        },
    }, message=_("billing.budget_alert_done"))


# ── 审计日志 ──────────────────────────────────────────────────────


@router.get("/admin/billing/audit-logs")
@billing_api_errors
def admin_list_audit_logs(
    request,
    action: Optional[str] = None,
    target_type: Optional[str] = None,
    admin_user_id: Optional[str] = None,
    organization_id: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    order_by: Optional[str] = None,
    page: int = 1,
    page_size: int = 50,
):
    """管理员审计日志列表。

    start_date / end_date 接受 ISO 8601 格式，例如 ``2025-03-06T00:00:00``
    或带时区 ``2025-03-06T00:00:00+08:00``。
    order_by 支持字段：created_at, action, target_type（前缀 ``-`` 表示降序）。
    organization_id 可选，按组织过滤（组织详情审计 Tab 使用）。
    """
    _require_admin(request)

    from .models import BillingAdminAuditLog

    qs = BillingAdminAuditLog.objects.all()
    qs = apply_ordering(qs, order_by, _AUDIT_SORT, default="-created_at")
    if action:
        qs = qs.filter(action=action)
    if target_type:
        qs = qs.filter(target_type=target_type)
    if admin_user_id:
        qs = qs.filter(admin_user_id=admin_user_id)
    if organization_id:
        qs = qs.filter(organization_id=organization_id)
    if start_date:
        dt = parse_datetime(start_date)
        if dt:
            qs = qs.filter(created_at__gte=dt)
    if end_date:
        dt = parse_datetime(end_date)
        if dt:
            qs = qs.filter(created_at__lte=dt)

    logs, meta = _paginate(qs, page, page_size)

    org_ids = _uuid_org_ids(log.organization_id for log in logs)
    admin_ids = {log.admin_user_id for log in logs if log.admin_user_id}

    org_name_map: dict[str, str] = {}
    if org_ids:
        for org in Organization.objects.filter(id__in=org_ids).only("id", "name"):
            org_name_map[str(org.id)] = (org.name or "").strip()

    admin_name_map: dict[str, str] = {}
    if admin_ids:
        from apps.users.auth.models import User as AuthUser

        for user in AuthUser.objects.filter(id__in=admin_ids).only("id", "nickname", "username"):
            admin_name_map[str(user.id)] = (
                (user.nickname or "").strip()
                or (user.username or "").strip()
            )

    items = []
    for log in logs:
        organization_id = log.organization_id or ""
        admin_user_id = log.admin_user_id or ""
        items.append({
            "id": str(log.id),
            "admin_user_id": admin_user_id,
            "admin_user_name": admin_name_map.get(admin_user_id, ""),
            "action": log.action,
            "target_type": log.target_type,
            "target_id": log.target_id,
            "organization_id": organization_id,
            "organization_name": org_name_map.get(organization_id, ""),
            "detail": log.detail,
            "ip_address": log.ip_address,
            "created_at": log.created_at.isoformat() if log.created_at else None,
        })

    return success_response(data={"audit_logs": items, **meta})


# ── 对账管理 ──────────────────────────────────────────────────────


@router.get("/admin/billing/reconciliation/reports")
@billing_api_errors
def admin_list_reconciliation_reports(request, page: int = 1, page_size: int = 20,
                                       start_date: str = "", end_date: str = "",
                                       status: str = "", order_by: Optional[str] = None):
    """对账报告列表"""
    _require_admin(request)
    from apps.services.billing.models import BillingReconciliationReport
    qs = BillingReconciliationReport.objects.all()
    qs = apply_ordering(qs, order_by, _RECONCILIATION_SORT, default="-report_date")
    if start_date:
        qs = qs.filter(report_date__gte=start_date)
    if end_date:
        qs = qs.filter(report_date__lte=end_date)
    if status:
        qs = qs.filter(status=status)

    rows, meta = _paginate(qs, page, page_size)

    org_ids = _uuid_org_ids(r.organization_id for r in rows)
    org_name_map: dict[str, str] = {}
    if org_ids:
        for org in Organization.objects.filter(id__in=org_ids).only("id", "name"):
            org_name_map[str(org.id)] = (org.name or "").strip()

    items = []
    for r in rows:
        organization_id = r.organization_id or ""
        items.append({
            "id": str(r.id), "report_date": str(r.report_date),
            "organization_id": organization_id,
            "organization_name": org_name_map.get(organization_id, ""),
            "billing_total": float(r.billing_total), "wallet_total": float(r.wallet_total),
            "diff_amount": float(r.diff_amount), "diff_pct": float(r.diff_pct),
            "status": r.status, "detail_json": r.detail_json,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        })
    return success_response({"items": items, **meta})


class ReconciliationRunIn(Schema):
    target_date: str = ""


@router.post("/admin/billing/reconciliation/run")
@billing_api_errors
def admin_run_reconciliation(request, data: ReconciliationRunIn):
    """保留旧接口契约；后台对账任务已下线。"""
    _require_admin(request)
    target_date = data.target_date

    record_billing_audit(
        request,
        action="reconciliation_run_disabled",
        target_type="reconciliation",
        target_id="",
        detail={"target_date": target_date or "yesterday"},
    )

    return success_response({
        "task_id": "",
        "target_date": target_date or "yesterday",
        "disabled": True,
        "reason": "task_governance_offline",
    })


@router.post("/admin/billing/storage/reconcile")
@billing_api_errors
def admin_run_storage_reconcile(request):
    """保留旧接口契约；全量存储对账任务已下线。"""
    _require_admin(request)

    record_billing_audit(
        request,
        action="storage_reconcile_run_disabled",
        target_type="storage",
        target_id="",
        detail={},
    )

    return success_response({
        "task_id": "",
        "disabled": True,
        "reason": "task_governance_offline",
    })


# ── 运营大盘 ──────────────────────────────────────────────────────


@router.get("/admin/billing/dashboard/realtime")
@billing_api_errors
def admin_dashboard_realtime(request):
    """今日实时数据"""
    _require_admin(request)
    from django.db.models import Sum, Count
    from django.db.models.functions import Coalesce

    now = timezone.now()
    today_start = timezone.make_aware(datetime.combine(timezone.localdate(), datetime.min.time()))
    yesterday_start = today_start - timedelta(days=1)

    today_qs = BillingUsageEvent.objects.filter(occurred_at__gte=today_start, occurred_at__lt=now)
    yesterday_qs = BillingUsageEvent.objects.filter(occurred_at__gte=yesterday_start, occurred_at__lt=today_start)

    today_stats = today_qs.aggregate(
        call_count=Count("id"),
        total_amount=Coalesce(Sum("amount"), Decimal("0")),
        active_users=Count("user_id", distinct=True),
    )
    yesterday_stats = yesterday_qs.aggregate(
        call_count=Count("id"),
        total_amount=Coalesce(Sum("amount"), Decimal("0")),
        active_users=Count("user_id", distinct=True),
    )

    return success_response({
        "today_events": today_stats["call_count"],
        "today_amount": str(today_stats["total_amount"]),
        "today_active_users": today_stats["active_users"],
        "yesterday_events": yesterday_stats["call_count"],
        "yesterday_amount": str(yesterday_stats["total_amount"]),
    })


@router.get("/admin/billing/dashboard/top-consumers")
@billing_api_errors
def admin_dashboard_top_consumers(request, days: int = 7, limit: int = 10, group_by: str = "user"):
    """Top N 消费排行"""
    _require_admin(request)
    if days < 1 or days > 365:
        raise HttpError(400, "days 参数范围: 1-365")
    if limit < 1 or limit > 100:
        raise HttpError(400, "limit 参数范围: 1-100")
    if group_by not in ("user", "organization"):
        raise HttpError(400, "group_by 参数仅支持 user / organization")
    from django.db.models import Sum, Count

    since = timezone.now() - timedelta(days=days)
    group_field = "user_id" if group_by == "user" else "organization_id"

    qs = BillingUsageEvent.objects.filter(
        occurred_at__gte=since,
    ).exclude(**{group_field: ""}).values(group_field).annotate(
        total_amount=Sum("amount"),
        total_events=Count("id"),
    ).order_by("-total_amount")[:limit]

    user_ids = [row[group_field] for row in qs] if group_by == "user" else []
    user_map: dict[str, dict] = {}
    if user_ids:
        try:
            from apps.users.auth.models import User
            for u in User.objects.filter(id__in=user_ids).values("id", "username", "email"):
                user_map[str(u["id"])] = {"username": u["username"] or "", "email": u["email"] or ""}
        except Exception:
            pass

    consumers = []
    for row in qs:
        uid = str(row[group_field])
        info = user_map.get(uid, {})
        consumers.append({
            "user_id": uid,
            "username": info.get("username", ""),
            "email": info.get("email", ""),
            "total_amount": str(row["total_amount"]),
            "total_events": row["total_events"],
        })

    return success_response({"consumers": consumers, "days": days, "group_by": group_by})


@router.get("/admin/billing/dashboard/model-distribution")
@billing_api_errors
def admin_dashboard_model_distribution(request, days: int = 30):
    """模型使用分布"""
    _require_admin(request)
    if days < 1 or days > 365:
        raise HttpError(400, "days 参数范围: 1-365")
    from django.db.models import Sum, Count

    since = timezone.now() - timedelta(days=days)
    qs = BillingUsageEvent.objects.filter(
        occurred_at__gte=since,
    ).exclude(model_name="").values("model_name").annotate(
        total_amount=Sum("amount"),
        total_events=Count("id"),
    ).order_by("-total_amount")

    rows = list(qs)
    distribution = []
    grand_total = sum(float(r["total_amount"]) for r in rows)
    for row in rows:
        amt = float(row["total_amount"])
        distribution.append({
            "model_name": row["model_name"],
            "total_amount": str(amt),
            "total_events": row["total_events"],
            "percentage": round(amt / grand_total * 100, 1) if grand_total > 0 else 0,
        })

    return success_response({"distribution": distribution, "days": days})


# ── 异常告警 ──────────────────────────────────────────────────────


@router.get("/admin/billing/anomaly/alerts")
@billing_api_errors
def admin_list_anomaly_alerts(request, page: int = 1, page_size: int = 20,
                               severity: str = "", is_resolved: str = "",
                               alert_type: str = "",
                               organization_id: str = "",
                               start_date: str = "", end_date: str = "",
                               order_by: Optional[str] = None):
    """异常告警列表；传 organization_id 时仅返回该组织告警。"""
    _require_admin(request)
    from apps.services.billing.models import BillingAnomalyAlert
    qs = BillingAnomalyAlert.objects.all()
    qs = apply_ordering(qs, order_by, _ANOMALY_SORT, default="-created_at")
    org_id = (organization_id or "").strip()
    if org_id:
        qs = qs.filter(organization_id=org_id)
    if severity:
        qs = qs.filter(severity=severity)
    if is_resolved in ("true", "false"):
        qs = qs.filter(is_resolved=is_resolved == "true")
    if alert_type:
        qs = qs.filter(alert_type=alert_type)
    if start_date:
        qs = qs.filter(created_at__date__gte=start_date)
    if end_date:
        qs = qs.filter(created_at__date__lte=end_date)

    rows, meta = _paginate(qs, page, page_size)
    items = []
    for a in rows:
        items.append({
            "id": str(a.id), "alert_type": a.alert_type, "severity": a.severity,
            "organization_id": a.organization_id, "user_id": a.user_id,
            "metric_name": a.metric_name,
            "current_value": float(a.current_value), "baseline_value": float(a.baseline_value),
            "threshold_ratio": float(a.threshold_ratio),
            "message": a.message, "is_resolved": a.is_resolved,
            "resolved_at": a.resolved_at.isoformat() if a.resolved_at else None,
            "created_at": a.created_at.isoformat() if a.created_at else None,
        })
    return success_response({"items": items, **meta})


class ResolveAnomalyAlertIn(Schema):
    reason: str = ""
    ticket_id: str = ""


@router.put("/admin/billing/anomaly/alerts/{alert_id}/resolve")
@billing_api_errors
def admin_resolve_anomaly_alert(request, alert_id: str, data: ResolveAnomalyAlertIn):
    """标记告警为已处理；填写原因时写入敏感操作审计。"""
    _require_admin(request)
    from apps.services.billing.models import BillingAnomalyAlert
    try:
        alert = BillingAnomalyAlert.objects.get(id=alert_id)
    except BillingAnomalyAlert.DoesNotExist:
        return error_response_with_status("NOT_FOUND", message=_("llm.alert_not_found"), status_code=404)

    if alert.is_resolved:
        return success_response({"id": str(alert.id), "is_resolved": True})

    reason = (data.reason or "").strip()
    ticket_id = (data.ticket_id or "").strip()
    before_json = {
        "is_resolved": alert.is_resolved,
        "resolved_at": alert.resolved_at.isoformat() if alert.resolved_at else None,
        "severity": alert.severity,
        "alert_type": alert.alert_type,
        "organization_id": alert.organization_id or "",
        "message": alert.message,
    }

    alert.is_resolved = True
    alert.resolved_at = timezone.now()
    alert.save(update_fields=["is_resolved", "resolved_at"])

    if alert.organization_id:
        try:
            from apps.services.billing.services.guard_service import BillingGuardService
            BillingGuardService.clear_guard_cache(alert.organization_id)
        except Exception:
            logger.warning("[AdminAPI] clear_guard_cache failed for alert %s", alert_id)

    record_billing_audit(
        request,
        action="anomaly_alert_resolve",
        target_type="anomaly_alert",
        target_id=str(alert.id),
        organization_id=alert.organization_id or "",
        detail={
            "reason": reason,
            "ticket_id": ticket_id,
            "severity": alert.severity,
            "alert_type": alert.alert_type,
        },
    )
    if reason:
        record_admin_sensitive_action(
            request,
            permission_code="anomaly_alert:resolve",
            action="anomaly_alert.resolve",
            target_type="anomaly_alert",
            target_id=str(alert.id),
            reason=reason,
            ticket_id=ticket_id,
            before_json=before_json,
            after_json={
                "is_resolved": True,
                "resolved_at": alert.resolved_at.isoformat() if alert.resolved_at else None,
                "organization_id": alert.organization_id or "",
            },
        )

    return success_response({"id": str(alert.id), "is_resolved": True})


# ── 成本分析 ──────────────────────────────────────────────────────


@router.get("/admin/billing/cost-analysis")
@billing_api_errors
def admin_cost_analysis(request, days: int = 30, group_by: str = "model"):
    """成本分析：供应商成本 vs 用户消耗对比"""
    _require_admin(request)
    if days < 1 or days > 365:
        raise HttpError(400, "days 参数范围: 1-365")
    if group_by not in ("model", "biz_type"):
        raise HttpError(400, "group_by 参数仅支持 model / biz_type")
    from django.db.models import Sum, Count, Avg
    from apps.services.llm.models import LLMUsageFact

    since = timezone.now() - timedelta(days=days)

    # LLMUsageFact 与 BillingUsageEvent 共用字段名的维度
    shared_fields = {"model": "model_name", "user": "user_id", "organization": "organization_id"}

    if group_by == "biz_type":
        # biz_type 仅 BillingUsageEvent 有，无法与 LLMUsageFact 交叉对比
        billing_qs = BillingUsageEvent.objects.filter(
            occurred_at__gte=since,
        ).exclude(biz_type="").values("biz_type").annotate(
            total_amount=Sum("amount"), call_count=Count("id"),
        ).order_by("-total_amount")
        items = []
        for row in billing_qs:
            amt = float(row["total_amount"])
            items.append({
                "group_key": row["biz_type"],
                "group_by": "biz_type",
                "total_cost": 0,
                "total_revenue": amt,
                "margin_rate": 0,
                "call_count": row["call_count"],
                "avg_latency_ms": 0,
            })
        return success_response({"items": items, "days": days, "group_by": group_by})

    fact_group = shared_fields.get(group_by, "model_name")

    cost_qs = LLMUsageFact.objects.filter(
        occurred_at__gte=since,
    ).exclude(**{fact_group: ""}).values(fact_group).annotate(
        total_cost=Sum("total_cost"),
        call_count=Count("id"),
        avg_latency=Avg("latency_ms"),
    ).order_by("-total_cost")

    revenue_qs = BillingUsageEvent.objects.filter(
        occurred_at__gte=since,
    ).exclude(**{fact_group: ""}).values(fact_group).annotate(
        total_amount=Sum("amount"),
    )
    revenue_map = {row[fact_group]: float(row["total_amount"]) for row in revenue_qs}

    items = []
    for row in cost_qs:
        key = row[fact_group]
        cost = float(row["total_cost"] or 0)
        revenue = revenue_map.get(key, 0)
        margin = round((revenue - cost) / revenue * 100, 1) if revenue > 0 else 0
        items.append({
            "group_key": key,
            "group_by": group_by,
            "total_cost": cost,
            "total_revenue": revenue,
            "margin_rate": margin,
            "call_count": row["call_count"],
            "avg_latency_ms": round(row["avg_latency"] or 0),
        })

    return success_response({"items": items, "days": days, "group_by": group_by})


# ── 存储计费管理 ──────────────────────────────────────────────────


@router.get("/admin/billing/storage/overview")
@billing_api_errors
def admin_storage_overview(request):
    """存储计费总览：聚合容量、费用、Top organization、增长趋势。"""
    _require_admin(request)

    agg = OrganizationStorageUsage.objects.aggregate(
        total_bytes=Coalesce(Sum("active_storage_bytes"), 0),
        total_files=Coalesce(Sum("active_file_count"), 0),
        organization_count=Count("id"),
    )

    now = timezone.now()
    thirty_days_ago = now - timedelta(days=30)

    cost_agg = BillingUsageEvent.objects.filter(
        meter_key__startswith="storage.",
        occurred_at__gte=thirty_days_ago,
        occurred_at__lt=now,
    ).aggregate(total_cost=Coalesce(Sum("amount"), Decimal("0")))

    top_organizations_qs = (
        OrganizationStorageUsage.objects
        .order_by("-active_storage_bytes")[:20]
    )
    top_organizations = []
    for ws in top_organizations_qs:
        top_organizations.append({
            "organization_id": ws.organization_id,
            "active_storage_bytes": ws.active_storage_bytes,
            "active_file_count": ws.active_file_count,
        })

    growth_qs = (
        BillingUsageEvent.objects
        .filter(meter_key__startswith="storage.", occurred_at__gte=thirty_days_ago, occurred_at__lt=now)
        .annotate(day=TruncDate("occurred_at"))
        .values("day")
        .annotate(day_quantity=Sum("quantity"))
        .order_by("day")
    )
    growth_trend = [
        {"date": str(row["day"]), "quantity": str(safe_decimal(row["day_quantity"]))}
        for row in growth_qs
    ]

    return success_response(data={
        "total_active_storage_bytes": agg["total_bytes"],
        "total_active_file_count": agg["total_files"],
        "organization_count": agg["organization_count"],
        "recent_30d_cost": str(safe_decimal(cost_agg["total_cost"])),
        "top_organizations": top_organizations,
        "growth_trend": growth_trend,
    })


@router.get("/admin/billing/storage/organizations")
@billing_api_errors
def admin_storage_organizations(
    request,
    search: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: str = "desc",
    page: int = 1,
    page_size: int = 50,
):
    """组织存储明细列表。

    search 同时匹配组织名（模糊）与组织 ID（文本模糊），由服务端过滤后再分页。
    """
    _require_admin(request)

    qs = OrganizationStorageUsage.objects.select_related("organization").all()
    keyword = (search or "").strip()
    if keyword:
        # organization_id 是 UUID：直接 icontains 中文会让 PG 500。
        # ID 片段 Cast 成文本后再模糊匹配；名称走 organization.name。
        qs = qs.annotate(
            _organization_id_text=Cast("organization_id", CharField(max_length=64))
        ).filter(
            Q(_organization_id_text__icontains=keyword)
            | Q(organization__name__icontains=keyword)
        )

    order_field = sort_by if sort_by in _STORAGE_WS_SORT else "active_storage_bytes"
    if sort_order == "asc":
        qs = qs.order_by(order_field)
    else:
        qs = qs.order_by(f"-{order_field}")

    rows, meta = _paginate(qs, page, page_size)

    ws_ids = [r.organization_id for r in rows]
    entitlements = {
        e.organization_id: e
        for e in OrganizationBillingEntitlement.objects.filter(organization_id__in=ws_ids)
    }
    policies = {
        p.organization_id: p
        for p in OrganizationBillingPolicy.objects.filter(organization_id__in=ws_ids)
    }
    org_name_map: dict[str, str] = {}
    if ws_ids:
        for org in Organization.objects.filter(id__in=ws_ids).only("id", "name"):
            org_name_map[str(org.id)] = (org.name or "").strip()

    items = []
    for r in rows:
        ent = entitlements.get(r.organization_id)
        pol = policies.get(r.organization_id)
        organization_id = str(r.organization_id or "")

        included = int(ent.included_storage_bytes) if ent else 0
        purchased = int(ent.purchased_storage_bytes) if ent else 0
        total_package = included + purchased
        usage_rate = round(r.active_storage_bytes / total_package * 100, 2) if total_package > 0 else 0

        items.append({
            "organization_id": organization_id,
            "organization_name": org_name_map.get(organization_id, ""),
            "active_storage_bytes": r.active_storage_bytes,
            "active_file_count": r.active_file_count,
            "total_uploaded_bytes": r.total_uploaded_bytes,
            "total_released_bytes": r.total_released_bytes,
            "included_storage_bytes": included,
            "purchased_storage_bytes": purchased,
            "total_storage_package_bytes": total_package,
            "storage_billing_mode": pol.storage_billing_mode if pol else "",
            "usage_rate_percent": usage_rate,
            "updated_at": r.updated_at.isoformat() if r.updated_at else None,
        })

    return success_response(data={"organizations": items, **meta})


@router.get("/admin/billing/storage/pricing")
@billing_api_errors
def admin_storage_pricing(
    request,
    order_by: Optional[str] = None,
    page: int = 1,
    page_size: int = 50,
):
    """存储定价列表（meter_key 以 storage. 开头）。"""
    _require_admin(request)

    qs = MeterPricing.objects.filter(meter_key__startswith="storage.")
    qs = apply_ordering(qs, order_by, _PRICING_SORT)

    rows, meta = _paginate(qs, page, page_size)

    items = []
    for p in rows:
        items.append({
            "id": str(p.id),
            "meter_key": p.meter_key,
            "scope": p.scope,
            "organization_id": p.organization_id or "",
            "unit": p.unit,
            "unit_price": str(safe_decimal(p.unit_price)),
            "currency": p.currency,
            "precision": p.precision,
            "is_active": p.is_active,
            "priority": p.priority,
            "effective_from": p.effective_from.isoformat() if p.effective_from else None,
            "effective_to": p.effective_to.isoformat() if p.effective_to else None,
            "created_at": p.created_at.isoformat() if p.created_at else None,
            "updated_at": p.updated_at.isoformat() if p.updated_at else None,
        })

    return success_response(data={"pricing_rules": items, **meta})


class StorageEntitlementUpdateIn(Schema):
    purchased_storage_bytes: int


@router.put("/admin/billing/storage/organization/{organization_id}/entitlement")
@billing_api_errors
def admin_update_storage_entitlement(request, organization_id: str, data: StorageEntitlementUpdateIn):
    """调整组织存储配额（purchased_storage_bytes）。"""
    _require_admin(request)

    if data.purchased_storage_bytes < 0:
        raise HttpError(400, "purchased_storage_bytes 不能为负数")

    ent = OrganizationBillingEntitlement.objects.filter(organization_id=organization_id).first()
    if not ent:
        raise HttpError(404, _("billing.entitlement_not_found"))

    before = int(ent.purchased_storage_bytes)
    ent.purchased_storage_bytes = data.purchased_storage_bytes
    ent.save(update_fields=["purchased_storage_bytes", "updated_at"])

    record_billing_audit(
        request,
        action="storage_entitlement_update",
        target_type="organization_billing_entitlement",
        target_id=str(ent.id),
        organization_id=organization_id,
        detail={
            "before_purchased_storage_bytes": before,
            "after_purchased_storage_bytes": data.purchased_storage_bytes,
        },
    )

    return success_response(data={
        "organization_id": organization_id,
        "purchased_storage_bytes": data.purchased_storage_bytes,
        "total_storage_package_bytes": ent.total_storage_package_bytes,
    }, message=_("billing.storage_quota_adjusted"))


# ── 支付订单 ──────────────────────────────────────────────────────


_PAYMENT_ORDER_SORT = frozenset({"created_at", "paid_at", "amount", "status"})


def _serialize_payment_order_item(order: PaymentOrder, organization_name: str = "") -> dict:
    user = getattr(order, "user", None)
    operator_user_id = str(getattr(order, "user_id", "") or getattr(user, "id", "") or "")
    operator_name = ""
    if user is not None:
        get_display_name = getattr(user, "get_display_name", None)
        if callable(get_display_name):
            operator_name = (get_display_name() or "").strip()
        if not operator_name:
            operator_name = (
                getattr(user, "nickname", None)
                or getattr(user, "username", None)
                or getattr(user, "phone", None)
                or getattr(user, "email", None)
                or ""
            )
        operator_name = str(operator_name or "").strip()
    return {
        "id": str(order.id),
        "organization_id": order.organization_id or "",
        "organization_name": organization_name or "",
        "order_no": order.order_no,
        "order_type": order.order_type,
        "subject": order.subject or "",
        "status": order.status,
        "payment_method": order.payment_method or "",
        "amount": str(safe_decimal(order.amount)),
        "paid_amount": str(safe_decimal(order.paid_amount)),
        "paid_at": order.paid_at.isoformat() if order.paid_at else None,
        "created_at": order.created_at.isoformat() if order.created_at else None,
        "expired_at": order.expired_at.isoformat() if order.expired_at else None,
        "user_id": operator_user_id,
        "operator_user_id": operator_user_id,
        "operator_name": operator_name,
    }


@router.get("/admin/billing/payment-orders")
@billing_api_errors
def admin_list_payment_orders(
    request,
    order_no: Optional[str] = None,
    organization: Optional[str] = None,
    organization_id: Optional[str] = None,
    keyword: Optional[str] = None,
    operator: Optional[str] = None,
    status: Optional[str] = None,
    order_type: Optional[str] = None,
    payment_method: Optional[str] = None,
    month: Optional[str] = None,
    order_by: Optional[str] = None,
    page: int = 1,
    page_size: int = 50,
):
    """管理员支付订单列表（跨组织）。

    筛选：
    - order_no：订单号
    - organization / organization_id / keyword：组织名或组织 ID（keyword 仅兼容旧入口）
    - order_type / payment_method / status
    - operator：操作人昵称或用户 ID
    """
    _require_admin(request)

    qs = PaymentOrder.objects.select_related("user").all()

    order_no_value = (order_no or "").strip()
    if order_no_value:
        qs = qs.filter(order_no__icontains=order_no_value)

    org_query = (organization or organization_id or keyword or "").strip()
    if org_query:
        # Organization.id 是 UUID：中文/非 UUID 片段直接 icontains 会在 PG 上 500。
        matched_org_ids = [
            str(org_id)
            for org_id in Organization.objects.annotate(
                _id_text=Cast("id", CharField(max_length=64))
            )
            .filter(Q(_id_text__icontains=org_query) | Q(name__icontains=org_query))
            .values_list("id", flat=True)[:200]
        ]
        # PaymentOrder.organization_id 是 CharField，可直接模糊匹配。
        org_filter = Q(organization_id__icontains=org_query)
        if matched_org_ids:
            org_filter |= Q(organization_id__in=matched_org_ids)
        qs = qs.filter(org_filter)

    operator_value = (operator or "").strip()
    if operator_value:
        qs = qs.annotate(
            _user_id_text=Cast("user_id", CharField(max_length=64))
        ).filter(
            Q(_user_id_text__icontains=operator_value)
            | Q(user__nickname__icontains=operator_value)
            | Q(user__username__icontains=operator_value)
            | Q(user__phone__icontains=operator_value)
            | Q(user__email__icontains=operator_value)
        )

    if status:
        qs = qs.filter(status=status.strip())
    if order_type:
        qs = qs.filter(order_type=order_type.strip())
    if payment_method:
        qs = qs.filter(payment_method=payment_method.strip())

    month_value = (month or "").strip()
    if month_value:
        _cycle_month, period_start, period_end = _credit_explanation_month_bounds(month_value)
        qs = qs.filter(created_at__gte=period_start, created_at__lt=period_end)

    qs = apply_ordering(qs, order_by, _PAYMENT_ORDER_SORT, default="-created_at")
    orders, meta = _paginate(qs, page, page_size, max_size=100)

    org_ids = _uuid_org_ids([order.organization_id for order in orders])
    org_name_map = {
        str(org.id): (org.name or "").strip()
        for org in Organization.objects.filter(id__in=org_ids).only("id", "name")
    }

    items = [
        _serialize_payment_order_item(
            order,
            organization_name=org_name_map.get(str(order.organization_id or ""), ""),
        )
        for order in orders
    ]
    return success_response(data={"items": items, **meta})


class RealRechargeDeliveryConfigIn(Schema):
    enabled: bool = False
    name: str = "真实充值报表"
    webhook_url: str = ""
    provider: str = "feishu"
    delivery_mode: str = "manual"
    daily_time: str = "09:00"
    schedule_timezone: str = "Asia/Shanghai"


class RealRechargeReportPeriodIn(Schema):
    period_key: str = "current_month"
    start_date: Optional[date] = None
    end_date: Optional[date] = None


def _resolve_real_recharge_period(payload: RealRechargeReportPeriodIn):
    try:
        return resolve_recharge_period(
            payload.period_key,
            start_date=payload.start_date,
            end_date=payload.end_date,
        )
    except ValueError as exc:
        raise HttpError(400, str(exc)) from exc


@router.get("/admin/billing/payment-orders/report-delivery")
@billing_api_errors
def admin_get_real_recharge_delivery(request):
    """读取平台真实充值报表的 IM 投递配置，不返回密钥。"""
    _require_admin(request)
    return success_response(data=serialize_delivery_config(get_delivery_account()))


@router.put("/admin/billing/payment-orders/report-delivery")
@billing_api_errors
def admin_update_real_recharge_delivery(request, payload: RealRechargeDeliveryConfigIn):
    """保存平台级飞书投递目标，密钥落入 channel_gateway 加密字段。"""
    _require_admin(request)
    _ensure_admin_permission(request, "billing_runtime_config:update")
    try:
        account = save_delivery_config(
            enabled=payload.enabled,
            name=payload.name,
            webhook_url=payload.webhook_url,
            provider=payload.provider,
            delivery_mode=payload.delivery_mode,
            daily_time=payload.daily_time,
            schedule_timezone=payload.schedule_timezone,
        )
    except ValueError as exc:
        raise HttpError(400, str(exc)) from exc
    record_billing_audit(
        request,
        action="real_recharge_delivery_config_update",
        target_type="channel_account",
        target_id=str(account.id),
        detail={
            "provider": (account.config or {}).get("provider", account.channel),
            "enabled": account.enabled,
            "webhook_configured": bool((account.config or {}).get("webhook_url")),
            "delivery_mode": (account.config or {}).get("delivery_mode", "manual"),
        },
    )
    return success_response(data=serialize_delivery_config(account), message="报表投递配置已保存")


@router.post("/admin/billing/payment-orders/report-delivery/test")
@billing_api_errors
def admin_test_real_recharge_delivery(request):
    """同步发送一条测试消息，便于保存配置后立即确认群聊可达。"""
    _require_admin(request)
    _ensure_admin_permission(request, "billing_runtime_config:update")
    try:
        result = test_delivery()
    except ValueError as exc:
        raise HttpError(400, str(exc)) from exc
    account = get_delivery_account()
    record_billing_audit(
        request,
        action="real_recharge_delivery_test",
        target_type="channel_account",
        target_id=str(account.id) if account else "billing-real-recharge",
        detail={
            "provider": (account.config or {}).get("provider", account.channel) if account else "",
            "provider_message_id": result.get("provider_message_id"),
        },
    )
    return success_response(data=result, message="测试消息已发送")


@router.post("/admin/billing/payment-orders/report-delivery/send")
@billing_api_errors
def admin_send_real_recharge_report(request, payload: RealRechargeReportPeriodIn):
    """按服务端真实订单重新汇总，并进入可靠出站队列。"""
    _require_admin(request)
    _ensure_admin_permission(request, "billing_runtime_config:update")
    period = _resolve_real_recharge_period(payload)
    try:
        result = queue_recharge_report(period)
    except ValueError as exc:
        raise HttpError(400, str(exc)) from exc
    account = get_delivery_account()
    record_billing_audit(
        request,
        action="real_recharge_report_send",
        target_type="channel_outbox",
        target_id=result["outbox_id"],
        detail={
            "provider": (account.config or {}).get("provider", account.channel) if account else "",
            "period_key": period.key,
            "period_label": period.label,
            "summary": result["summary"],
        },
    )
    return success_response(data=result, message="充值报表已进入发送队列")


# ── 账单管理 ──────────────────────────────────────────────────────


_INVOICE_SORT = frozenset({"created_at", "period_start", "total_amount", "status", "issued_at", "paid_at"})


def _serialize_invoice_item(inv: BillingInvoice) -> dict:
    collection = dict((inv.metadata or {}).get("collection") or {})
    return {
        "id": str(inv.id),
        "invoice_no": inv.invoice_no,
        "organization_id": inv.organization_id,
        "period_start": str(inv.period_start),
        "period_end": str(inv.period_end),
        "status": inv.status,
        "total_amount": str(safe_decimal(inv.total_amount)),
        "refunded_amount": str(safe_decimal(inv.refunded_amount)),
        "collection_attempt_count": getattr(inv, "collection_attempt_count", 0) or int(collection.get("attempt_count") or 0),
        "last_error": str(collection.get("last_error") or ""),
        "issued_at": inv.issued_at.isoformat() if inv.issued_at else None,
        "paid_at": inv.paid_at.isoformat() if inv.paid_at else None,
        "refunded_at": inv.refunded_at.isoformat() if inv.refunded_at else None,
        "created_at": inv.created_at.isoformat() if inv.created_at else None,
    }


@router.get("/admin/billing/statements/monthly")
@billing_api_errors
def admin_get_monthly_statement(request, organization_id: str, month: Optional[str] = None):
    """管理员查看月度消费对账单。只读，不生成 invoice，不触发扣款。"""
    _require_admin(request)
    try:
        statement = StatementService.get_statement_detail(organization_id=organization_id, month=month)
    except ValueError as exc:
        raise HttpError(400, str(exc))
    return success_response(data=statement)


@router.get("/admin/billing/invoices")
@billing_api_errors
def admin_list_invoices(
    request,
    status: Optional[str] = None,
    organization_id: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    order_by: Optional[str] = None,
    page: int = 1,
    page_size: int = 50,
):
    """管理员账单列表"""
    _require_admin(request)

    qs = BillingInvoice.objects.all()
    if status:
        qs = qs.filter(status=status)
    if organization_id:
        qs = qs.filter(organization_id=organization_id)
    if start_date:
        dt = parse_datetime(start_date)
        if dt:
            qs = qs.filter(period_start__gte=dt.date() if hasattr(dt, "date") else dt)
    if end_date:
        dt = parse_datetime(end_date)
        if dt:
            qs = qs.filter(period_end__lte=dt.date() if hasattr(dt, "date") else dt)

    qs = apply_ordering(qs, order_by, _INVOICE_SORT, default="-created_at")
    invoices, meta = _paginate(qs, page, page_size)

    items = [_serialize_invoice_item(inv) for inv in invoices]
    return success_response(data={"invoices": items, **meta})


# ⚠️ 路由顺序：``GET /admin/billing/invoices/{invoice_id}`` 通配符必须在
# ``/invoices/export`` 字面量 GET 和 ``/invoices/batch-collect`` POST 之后注册——
# 否则 ``export`` 会被当成 invoice_id 命中详情 handler（CRITICAL same-method），
# ``batch-collect`` POST 也会 405。本装饰器在文件末尾延后注册（搜 RR-LATE）。
def admin_get_invoice_detail(request, invoice_id: str):
    """管理员账单详情"""
    _require_admin(request)

    inv = BillingInvoice.objects.filter(id=invoice_id).first()
    if not inv:
        raise HttpError(404, _("billing.invoice_not_found"))

    collection = dict((inv.metadata or {}).get("collection") or {})
    lines = list(BillingInvoiceLine.objects.filter(invoice=inv).order_by("created_at"))
    line_items = []
    for line in lines:
        line_items.append({
            "id": str(line.id),
            "meter_key": line.meter_key,
            "description": line.description,
            "quantity": str(safe_decimal(line.quantity)),
            "unit": line.unit,
            "unit_price": str(safe_decimal(line.unit_price)),
            "amount": str(safe_decimal(line.amount)),
            "metadata": line.metadata or {},
            "created_at": line.created_at.isoformat() if line.created_at else None,
        })

    data = {
        **_serialize_invoice_item(inv),
        "currency": inv.currency,
        "subtotal_amount": str(safe_decimal(inv.subtotal_amount)),
        "discount_amount": str(safe_decimal(inv.discount_amount)),
        "lines": line_items,
        "collection": collection,
    }
    return success_response(data=data)


@router.post("/admin/billing/invoices/{invoice_id}/collect")
@billing_api_errors
def admin_collect_invoice(request, invoice_id: str):
    """历史 invoice 不再作为扣款入口。"""
    _require_admin(request)

    inv = BillingInvoice.objects.filter(id=invoice_id).first()
    if not inv:
        raise HttpError(404, _("billing.invoice_not_found"))
    record_billing_audit(
        request,
        action="invoice_collect_disabled",
        target_type="invoice",
        target_id=invoice_id,
        organization_id=inv.organization_id,
        detail={"reason": "monthly statement is read-only; invoice collection disabled"},
    )
    raise HttpError(410, "月度账单已改为只读消费对账单，当前阶段不支持 invoice 手动扣款")


class BatchCollectIn(Schema):
    invoice_ids: list[str]


@router.post("/admin/billing/invoices/batch-collect")
@billing_api_errors
def admin_batch_collect_invoices(request, data: BatchCollectIn):
    """历史 invoice 不再作为批量扣款入口。"""
    _require_admin(request)

    ids = list(dict.fromkeys(data.invoice_ids))[:50]
    if not ids:
        raise HttpError(400, "invoice_ids 不能为空")

    record_billing_audit(
        request,
        action="invoice_batch_collect_disabled",
        target_type="invoice",
        target_id="batch",
        detail={"count": len(ids), "reason": "monthly statement is read-only; invoice collection disabled"},
    )
    raise HttpError(410, "月度账单已改为只读消费对账单，当前阶段不支持 invoice 批量扣款")


@router.get("/admin/billing/invoices/export")
@billing_api_errors
def admin_export_invoices(
    request,
    status: Optional[str] = None,
    organization_id: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
):
    """导出账单为 CSV"""
    _require_admin(request)

    qs = BillingInvoice.objects.all().order_by("-created_at")
    if status:
        qs = qs.filter(status=status)
    if organization_id:
        qs = qs.filter(organization_id=organization_id)
    if start_date:
        dt = parse_datetime(start_date)
        if dt:
            qs = qs.filter(period_start__gte=dt.date() if hasattr(dt, "date") else dt)
    if end_date:
        dt = parse_datetime(end_date)
        if dt:
            qs = qs.filter(period_end__lte=dt.date() if hasattr(dt, "date") else dt)

    qs = qs[:10000]

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([
        "invoice_no", "organization_id", "period_start", "period_end",
        "status", "total_amount", "currency", "collection_attempt_count",
        "issued_at", "paid_at", "created_at",
    ])
    for inv in qs.iterator(chunk_size=500):
        collection = dict((inv.metadata or {}).get("collection") or {})
        writer.writerow([
            inv.invoice_no, inv.organization_id, str(inv.period_start), str(inv.period_end),
            inv.status, str(safe_decimal(inv.total_amount)), inv.currency,
            getattr(inv, "collection_attempt_count", 0) or int(collection.get("attempt_count") or 0),
            inv.issued_at.isoformat() if inv.issued_at else "",
            inv.paid_at.isoformat() if inv.paid_at else "",
            inv.created_at.isoformat() if inv.created_at else "",
        ])

    response = HttpResponse(buf.getvalue(), content_type="text/csv; charset=utf-8")
    response["Content-Disposition"] = 'attachment; filename="invoices_export.csv"'
    return response


class RefundInvoiceIn(Schema):
    amount: Optional[str] = None
    reason: str = ""


@router.post("/admin/billing/invoices/{invoice_id}/refund")
@billing_api_errors
def admin_refund_invoice(request, invoice_id: str, data: RefundInvoiceIn):
    """
    管理员对已支付账单执行退款。

    D10 退款流程：
    - 全额退款且有关联支付订单 → 先发起支付平台退款（支付宝同步/微信异步）
    - 微信退款返回 status=refunding，需通过 refund-status 接口轮询或等 WS 通知
    - 支付宝退款或无真实支付 → 立即完成，返回 status=refunded/partially_refunded
    """
    _require_admin(request)

    inv = BillingInvoice.objects.filter(id=invoice_id).first()
    if not inv:
        raise HttpError(404, _("billing.invoice_not_found"))

    refund_amount = None
    if data.amount is not None and data.amount.strip():
        try:
            refund_amount = Decimal(data.amount)
        except (InvalidOperation, TypeError, ValueError):
            return error_response_with_status("INVALID_AMOUNT", message=_("billing.refund_amount_invalid"), status_code=400)

    from .services.refund_service import BillingRefundService

    try:
        result = BillingRefundService.refund_invoice(
            invoice_id=str(inv.id),
            amount=refund_amount,
            reason=data.reason,
            operator_user_id=str(request.auth.id),
        )
    except ValueError as exc:
        return error_response_with_status("REFUND_ERROR", message=str(exc), status_code=400)

    result_status = result.get("status", "")

    audit_detail = {
        "refund_amount": result.get("refund_amount", "0"),
        "reason": data.reason,
        "status": result_status,
    }
    if result_status in ("refunded", "partially_refunded"):
        audit_detail["refund_tx_id"] = result.get("refund_tx_id", "")
    if result.get("platform_refund"):
        audit_detail["platform_refund"] = result["platform_refund"]
    if result_status == "refunding":
        audit_detail["refund_record_id"] = result.get("refund_record_id", "")
        audit_detail["payment_method"] = result.get("payment_method", "")
    if result_status == "refund_failed":
        audit_detail["platform_refund_error"] = result.get("platform_refund_error", "")
    if result_status == "partial_failure":
        audit_detail["error"] = result.get("error", "")
        audit_detail["refund_record_id"] = result.get("refund_record_id", "")

    record_billing_audit(
        request,
        action="invoice_refund",
        target_type="invoice",
        target_id=invoice_id,
        organization_id=inv.organization_id,
        detail=audit_detail,
    )

    if result_status == "refund_failed":
        return error_response_with_status(
            "PLATFORM_REFUND_FAILED",
            message=result.get("platform_refund_error", "支付平台退款失败"),
            status_code=400,
            data=result,
        )

    if result_status == "refunding":
        return success_response(data=result, message=_("billing.refund_processing"))

    if result_status == "partial_failure":
        return 202, success_response(
            data=result,
            message=_("billing.refund_partial_failure"),
        )

    return success_response(data=result, message=_("billing.refund_done"))


@router.get("/admin/billing/invoices/{invoice_id}/refund-status")
@billing_api_errors
def admin_get_refund_status(request, invoice_id: str):
    """
    查询账单关联的支付平台退款状态。

    用于微信异步退款场景：管理员发起退款后轮询此接口获取退款进度。
    """
    _require_admin(request)

    inv = BillingInvoice.objects.filter(id=invoice_id).first()
    if not inv:
        raise HttpError(404, _("billing.invoice_not_found"))

    from .services.refund_service import BillingRefundService
    status_data = BillingRefundService.get_refund_status(invoice_id)

    status_data["invoice_status"] = inv.status
    status_data["invoice_no"] = inv.invoice_no
    status_data["refunded_amount"] = str(safe_decimal(inv.refunded_amount))
    status_data["total_amount"] = str(safe_decimal(inv.total_amount))

    return success_response(data=status_data)


@router.get("/admin/billing/organization-cleanup-jobs")
@billing_api_errors
def admin_list_organization_cleanup_jobs(
    request,
    status: Optional[str] = None,
    organization_id: Optional[str] = None,
    trigger_source: Optional[str] = None,
    keyword: Optional[str] = None,
    due_only: bool = False,
    stuck_only: bool = False,
    order_by: Optional[str] = None,
    page: int = 1,
    page_size: int = 50,
):
    _require_admin(request)

    qs = OrganizationLifecycleCleanupJob.objects.all()
    qs = _apply_organization_cleanup_job_filters(
        qs,
        status=status,
        organization_id=organization_id,
        trigger_source=trigger_source,
        keyword=keyword,
        due_only=due_only,
        stuck_only=stuck_only,
    )
    qs = apply_ordering(qs, order_by, _CLEANUP_JOB_SORT)
    summary = _build_organization_cleanup_job_list_summary(qs)

    jobs, meta = _paginate(qs, page, page_size)
    items = [_serialize_organization_cleanup_job(job) for job in jobs]
    return success_response(data={"jobs": items, "summary": summary, **meta})


@router.get("/admin/billing/organization-cleanup-jobs/stats")
@billing_api_errors
def admin_organization_cleanup_job_stats(request):
    _require_admin(request)
    return success_response(data=_build_organization_cleanup_job_stats())


@router.post("/admin/billing/organization-cleanup-jobs/retry-due")
@billing_api_errors
def admin_retry_due_organization_cleanup_jobs(request, payload: OrganizationCleanupJobRunDueRequest):
    _require_admin(request)

    from .services import OrganizationLifecycleCleanupService

    result = OrganizationLifecycleCleanupService.process_due_jobs(
        limit=max(1, int(payload.limit or 50)),
        recover_stuck=bool(payload.recover_stuck),
    )

    record_billing_audit(
        request,
        action="organization_cleanup_retry_due",
        target_type="organization_cleanup_job",
        target_id="batch",
        detail=result,
    )

    return success_response(
        data=result,
        message="organization cleanup due jobs 已执行",
    )


@router.post("/admin/billing/organization-cleanup-jobs/{job_id}/retry")
@billing_api_errors
def admin_retry_organization_cleanup_job(
    request,
    job_id: str,
    payload: OrganizationCleanupJobRetryRequest,
):
    _require_admin(request)
    _ensure_admin_permission(request, "organization_cleanup:retry")
    reason = (payload.reason or "").strip()
    if not reason:
        raise HttpError(400, "reason 不能为空")

    job = OrganizationLifecycleCleanupJob.objects.filter(id=job_id).first()
    if not job:
        raise HttpError(404, "cleanup job 不存在")
    before_status = job.status
    before_attempt_count = int(job.attempt_count or 0)
    before_error = (job.last_error or "")[:200]

    from .services import OrganizationLifecycleCleanupService

    updated = OrganizationLifecycleCleanupService.run_cleanup_job(job_id=str(job.id), force=True)

    record_billing_audit(
        request,
        action="organization_cleanup_retry",
        target_type="organization_cleanup_job",
        target_id=str(job.id),
        organization_id=job.organization_id,
        detail={
            "status": updated.status,
            "attempt_count": updated.attempt_count,
        },
    )
    record_admin_sensitive_action(
        request,
        permission_code="organization_cleanup:retry",
        action="organization_cleanup.retry",
        target_type="organization_cleanup_job",
        target_id=str(job.id),
        reason=reason,
        ticket_id=(payload.ticket_id or "").strip(),
        before_json={
            "job_id": str(job.id),
            "organization_id": job.organization_id,
            "status": before_status,
            "attempt_count": before_attempt_count,
            "error_summary": before_error,
        },
        after_json={
            "job_id": str(updated.id),
            "organization_id": updated.organization_id,
            "status": updated.status,
            "attempt_count": int(updated.attempt_count or 0),
            "error_summary": (updated.last_error or "")[:200],
        },
    )

    return success_response(
        data=_serialize_organization_cleanup_job(updated),
        message="organization cleanup job 已重试",
    )


# ── 运行时配置管理 ──────────────────────────────────────────────────


class RuntimeConfigUpdateSchema(Schema):
    credits_per_yuan: Optional[int] = None
    min_balance_threshold: Optional[str] = None
    freeze_fallback_credits: Optional[str] = None
    freeze_est_input_tokens: Optional[int] = None
    freeze_est_output_tokens: Optional[int] = None
    precheck_fail_threshold: Optional[int] = None
    failopen_max_credits: Optional[str] = None
    precheck_fail_window: Optional[int] = None
    balance_recheck_interval: Optional[int] = None
    stale_freeze_threshold_minutes: Optional[int] = None
    pricing_cache_ttl: Optional[int] = None
    cache_discount_config: Optional[dict] = None
    show_per_message_cost: Optional[bool] = None
    sync_charge_threshold_credits: Optional[int] = None
    fail_open_24h_block_threshold: Optional[int] = None
    internal_llm_call_balance_guard_pct: Optional[int] = None
    internal_llm_call_balance_guard_floor: Optional[int] = None
    large_charge_review_threshold_credits: Optional[int] = None
    degradation_window_seconds: Optional[int] = None
    degradation_alert_threshold: Optional[int] = None


def _serialize_runtime_config(config: dict) -> dict:
    """将 runtime config 序列化为前端期望的格式（Decimal → str）。"""
    result = {}
    for key, value in config.items():
        if isinstance(value, Decimal):
            result[key] = str(value)
        else:
            result[key] = value
    return result


@router.get("/admin/runtime-config")
@billing_api_errors
def admin_get_runtime_config(request):
    """读取计费运行时配置（单例）。"""
    _require_admin(request)

    from .models import BillingRuntimeConfig
    from .services.runtime_config_service import BillingConfigService

    config = BillingConfigService.get_all()
    instance = BillingRuntimeConfig.get_instance()

    data = _serialize_runtime_config(config)
    data["updated_at"] = instance.updated_at.isoformat() if instance.updated_at else ""
    data["updated_by"] = instance.updated_by or ""

    return success_response(data=data)


_RUNTIME_CONFIG_INT_FIELDS = (
    "freeze_est_input_tokens", "freeze_est_output_tokens",
    "precheck_fail_threshold", "precheck_fail_window",
    "stale_freeze_threshold_minutes", "pricing_cache_ttl",
)
_RUNTIME_CONFIG_POSITIVE_INT_FIELDS = (
    "credits_per_yuan", "balance_recheck_interval",
    "sync_charge_threshold_credits", "fail_open_24h_block_threshold",
    "internal_llm_call_balance_guard_pct", "internal_llm_call_balance_guard_floor",
    "large_charge_review_threshold_credits",
    "degradation_window_seconds", "degradation_alert_threshold",
)

from .services.runtime_config_service import DECIMAL_FIELDS as _RUNTIME_CONFIG_DECIMAL_FIELDS


@router.put("/admin/runtime-config")
@billing_api_errors
def admin_update_runtime_config(request, payload: RuntimeConfigUpdateSchema):
    """更新计费运行时配置（部分更新）。"""
    _require_admin(request)

    from .services.runtime_config_service import BillingConfigService

    data = payload.dict(exclude_unset=True)
    if not data:
        return error_response_with_status(
            "NO_CHANGES", message="未提供任何更新字段", status_code=400,
        )

    errors = []

    for field in _RUNTIME_CONFIG_POSITIVE_INT_FIELDS:
        if field in data and data[field] is not None and data[field] <= 0:
            errors.append(f"{field} 必须大于 0")

    for field in _RUNTIME_CONFIG_INT_FIELDS:
        if field in data and data[field] is not None and data[field] < 0:
            errors.append(f"{field} 不能为负数")

    for field in _RUNTIME_CONFIG_DECIMAL_FIELDS:
        if field in data and data[field] is not None:
            try:
                val = Decimal(str(data[field]))
                if val < 0:
                    errors.append(f"{field} 不能为负数")
            except (InvalidOperation, TypeError, ValueError):
                errors.append(f"{field} 格式无效")

    if errors:
        return error_response_with_status(
            "VALIDATION_ERROR", message="; ".join(errors), status_code=400,
        )

    old_config = BillingConfigService.get_all()
    old_values = {k: str(old_config.get(k)) for k in data if k in old_config}

    config = BillingConfigService.update_partial(
        data=data,
        updated_by=str(request.auth.id),
    )

    new_values = {k: str(config.get(k)) for k in data if k in config}
    record_billing_audit(
        request,
        action="runtime_config_update",
        target_type="runtime_config",
        target_id="singleton",
        detail={"updated_fields": list(data.keys()), "old": old_values, "new": new_values},
    )

    return success_response(data=_serialize_runtime_config(config))


# ── RR-LATE: admin_get_invoice_detail ─────────────────────────────
# 必须在所有字面量 ``/admin/billing/invoices/<literal>`` endpoint 之后注册（详见
# admin_get_invoice_detail 函数定义处的注释）。
router.get("/admin/billing/invoices/{invoice_id}")(billing_api_errors(admin_get_invoice_detail))


# ── W5-2: CreditPackage CRUD ──────────────────────────────────────


class CreditPackageIn(Schema):
    name: str
    description: str = ""
    price: str
    credits_amount: int
    bonus_credits: int = 0
    sort_order: int = 0
    is_active: bool = True


class AddonPackageIn(Schema):
    addon_code: str
    addon_name: str
    description: str = ""
    price: str
    quota_key: str
    quota_value: int
    period_months: int = 1
    sort_order: int = 0
    is_active: bool = True
    metadata: Optional[dict] = None


def _serialize_addon_package_admin(pkg: AddonPackage) -> dict:
    return {
        "id": str(pkg.id),
        "addon_code": pkg.addon_code,
        "addon_name": pkg.addon_name,
        "description": pkg.description,
        "price": str(pkg.price),
        "quota_key": pkg.quota_key,
        "quota_label": pkg.get_quota_key_display(),
        "quota_value": int(pkg.quota_value or 0),
        "period_months": int(pkg.period_months or 0),
        "sort_order": int(pkg.sort_order or 0),
        "is_active": bool(pkg.is_active),
        "metadata": pkg.metadata or {},
        "active_entitlement_count": int(
            OrganizationAddonEntitlement.objects.filter(addon_package=pkg, status="active").count()
        ),
        "created_at": pkg.created_at.isoformat() if pkg.created_at else None,
        "updated_at": pkg.updated_at.isoformat() if pkg.updated_at else None,
    }


def _apply_addon_package_input(pkg: AddonPackage, data: AddonPackageIn) -> AddonPackage:
    valid_quota_keys = {choice[0] for choice in AddonPackage.QUOTA_KEY_CHOICES}
    if data.quota_key not in valid_quota_keys:
        raise HttpError(400, "不支持的增值包权益类型")
    try:
        price = Decimal(data.price)
    except (InvalidOperation, TypeError, ValueError):
        raise HttpError(400, "增值包价格格式不正确")
    if not price.is_finite() or price <= 0:
        raise HttpError(400, "增值包价格必须大于 0")
    if int(data.quota_value) <= 0:
        raise HttpError(400, "增值包额度必须大于 0")
    if int(data.period_months) <= 0:
        raise HttpError(400, "增值包有效期必须大于 0")

    pkg.addon_code = data.addon_code.strip()
    pkg.addon_name = data.addon_name.strip()
    pkg.description = data.description
    pkg.price = price
    pkg.quota_key = data.quota_key
    pkg.quota_value = int(data.quota_value)
    pkg.period_months = int(data.period_months)
    pkg.sort_order = int(data.sort_order)
    pkg.is_active = bool(data.is_active)
    pkg.metadata = data.metadata or {}
    if not pkg.addon_code or not pkg.addon_name:
        raise HttpError(400, "增值包编码和名称不能为空")
    return pkg


@router.get("/admin/billing/credit-packages")
@billing_api_errors
def admin_list_credit_packages(request, active_only: Optional[str] = None):
    _require_admin(request)
    from apps.users.wallet.models import CreditPackage

    qs = CreditPackage.objects.all().order_by("sort_order", "-created_at")
    if active_only == "true":
        qs = qs.filter(is_active=True)

    items = []
    for p in qs:
        items.append({
            "id": str(p.id),
            "name": p.name,
            "description": p.description,
            "price": str(p.price),
            "credits_amount": p.credits_amount,
            "bonus_credits": p.bonus_credits,
            "total_credits": p.total_credits,
            "discount_percentage": p.get_discount_percentage(),
            "sort_order": p.sort_order,
            "is_active": p.is_active,
            "created_at": p.created_at.isoformat() if p.created_at else None,
            "updated_at": p.updated_at.isoformat() if p.updated_at else None,
        })
    return success_response(data={"packages": items})


@router.post("/admin/billing/credit-packages")
@billing_api_errors
def admin_create_credit_package(request, data: CreditPackageIn):
    _require_admin(request)
    from apps.users.wallet.models import CreditPackage

    pkg = CreditPackage.objects.create(
        name=data.name,
        description=data.description,
        price=Decimal(data.price),
        credits_amount=data.credits_amount,
        bonus_credits=data.bonus_credits,
        sort_order=data.sort_order,
        is_active=data.is_active,
    )
    record_billing_audit(
        request, action="credit_package_create", target_type="credit_package",
        target_id=str(pkg.id), detail={"name": pkg.name},
    )
    return success_response(data={"id": str(pkg.id)}, message=_("billing.credit_package_created"))


@router.put("/admin/billing/credit-packages/{package_id}")
@billing_api_errors
def admin_update_credit_package(request, package_id: str, data: CreditPackageIn):
    _require_admin(request)
    from apps.users.wallet.models import CreditPackage

    pkg = CreditPackage.objects.filter(id=package_id).first()
    if not pkg:
        raise HttpError(404, _("billing.credit_package_not_found"))

    pkg.name = data.name
    pkg.description = data.description
    pkg.price = Decimal(data.price)
    pkg.credits_amount = data.credits_amount
    pkg.bonus_credits = data.bonus_credits
    pkg.sort_order = data.sort_order
    pkg.is_active = data.is_active
    pkg.save()

    record_billing_audit(
        request, action="credit_package_update", target_type="credit_package",
        target_id=str(pkg.id), detail={"name": pkg.name, "is_active": pkg.is_active},
    )
    return success_response(data={"id": str(pkg.id)}, message=_("billing.credit_package_updated"))


@router.delete("/admin/billing/credit-packages/{package_id}")
@billing_api_errors
def admin_delete_credit_package(request, package_id: str, reason: str = "", ticket_id: str = ""):
    _require_admin(request)
    _ensure_admin_permission(request, "credit_package:update")
    normalized_reason = (reason or "").strip()
    if not normalized_reason:
        raise HttpError(400, "reason 不能为空")
    from apps.users.wallet.models import CreditPackage

    pkg = CreditPackage.objects.filter(id=package_id).first()
    if not pkg:
        raise HttpError(404, _("billing.credit_package_not_found"))
    before_json = {
        "package_id": str(pkg.id),
        "name": pkg.name,
        "credits_amount": int(pkg.credits_amount or 0),
        "price": str(pkg.price),
        "status": "active" if pkg.is_active else "inactive",
    }

    pkg.delete()
    record_billing_audit(
        request, action="credit_package_delete", target_type="credit_package",
        target_id=package_id, detail={"name": pkg.name},
    )
    record_admin_sensitive_action(
        request,
        permission_code="credit_package:update",
        action="credit_package.delete",
        target_type="credit_package",
        target_id=package_id,
        reason=normalized_reason,
        ticket_id=(ticket_id or "").strip(),
        before_json=before_json,
        after_json={
            "package_id": package_id,
            "status": "deleted",
        },
    )
    return success_response(message=_("billing.credit_package_deleted"))


# ── AddonPackage CRUD ──────────────────────────────────────────────


@router.get("/admin/billing/addon-packages")
@billing_api_errors
def admin_list_addon_packages(request, active_only: Optional[str] = None):
    _require_admin(request)
    qs = AddonPackage.objects.all().order_by("sort_order", "-created_at")
    if active_only == "true":
        qs = qs.filter(is_active=True)
    return success_response(data={"packages": [_serialize_addon_package_admin(pkg) for pkg in qs]})


@router.post("/admin/billing/addon-packages")
@billing_api_errors
def admin_create_addon_package(request, data: AddonPackageIn):
    _require_admin(request)
    pkg = _apply_addon_package_input(AddonPackage(), data)
    pkg.save()
    record_billing_audit(
        request,
        action="addon_package_create",
        target_type="addon_package",
        target_id=str(pkg.id),
        detail={"addon_code": pkg.addon_code, "quota_key": pkg.quota_key, "quota_value": pkg.quota_value},
    )
    return success_response(data={"id": str(pkg.id)}, message="增值包已创建")


@router.put("/admin/billing/addon-packages/{package_id}")
@billing_api_errors
def admin_update_addon_package(request, package_id: str, data: AddonPackageIn):
    _require_admin(request)
    pkg = AddonPackage.objects.filter(id=package_id).first()
    if not pkg:
        raise HttpError(404, "增值包不存在")
    pkg = _apply_addon_package_input(pkg, data)
    pkg.save()
    record_billing_audit(
        request,
        action="addon_package_update",
        target_type="addon_package",
        target_id=str(pkg.id),
        detail={"addon_code": pkg.addon_code, "is_active": pkg.is_active},
    )
    return success_response(data={"id": str(pkg.id)}, message="增值包已更新")


@router.delete("/admin/billing/addon-packages/{package_id}")
@billing_api_errors
def admin_delete_addon_package(request, package_id: str, reason: str = "", ticket_id: str = ""):
    _require_admin(request)
    _ensure_admin_permission(request, "addon_package:update")
    normalized_reason = (reason or "").strip()
    if not normalized_reason:
        raise HttpError(400, "reason 不能为空")
    pkg = AddonPackage.objects.filter(id=package_id).first()
    if not pkg:
        raise HttpError(404, "增值包不存在")
    before_json = {
        "package_id": str(pkg.id),
        "addon_name": pkg.addon_name,
        "quota_key": pkg.quota_key,
        "quota_delta": int(pkg.quota_value or 0),
        "price": str(pkg.price),
        "status": "active" if pkg.is_active else "inactive",
    }
    name = pkg.addon_name
    try:
        pkg.delete()
    except ProtectedError:
        pkg.is_active = False
        pkg.save(update_fields=["is_active", "updated_at"])
        record_admin_sensitive_action(
            request,
            permission_code="addon_package:update",
            action="addon_package.delete",
            target_type="addon_package",
            target_id=package_id,
            reason=normalized_reason,
            ticket_id=(ticket_id or "").strip(),
            before_json=before_json,
            after_json={
                "package_id": package_id,
                "status": "inactive",
            },
        )
        return success_response(message="已有购买记录，已改为下架")
    record_billing_audit(
        request,
        action="addon_package_delete",
        target_type="addon_package",
        target_id=package_id,
        detail={"addon_name": name},
    )
    record_admin_sensitive_action(
        request,
        permission_code="addon_package:update",
        action="addon_package.delete",
        target_type="addon_package",
        target_id=package_id,
        reason=normalized_reason,
        ticket_id=(ticket_id or "").strip(),
        before_json=before_json,
        after_json={
            "package_id": package_id,
            "status": "deleted",
        },
    )
    return success_response(message="增值包已删除")


# ── W5-4: BillingDispute 申诉工单 ─────────────────────────────────


@router.get("/admin/billing/disputes")
@billing_api_errors
def admin_list_disputes(
    request,
    status: Optional[str] = None,
    page: int = 1,
    page_size: int = 50,
):
    _require_admin(request)
    from .models import BillingDispute

    qs = BillingDispute.objects.all().order_by("-created_at")
    if status:
        qs = qs.filter(status=status)

    disputes, meta = _paginate(qs, page, page_size)

    items = []
    for d in disputes:
        items.append({
            "id": str(d.id),
            "transaction_id": str(d.transaction_id) if d.transaction_id else "",
            "organization_id": d.organization_id,
            "user_id": d.user_id,
            "reason": d.reason,
            "status": d.status,
            "admin_notes": d.admin_notes,
            "sla_deadline": d.sla_deadline.isoformat() if d.sla_deadline else None,
            "resolved_at": d.resolved_at.isoformat() if d.resolved_at else None,
            "created_at": d.created_at.isoformat() if d.created_at else None,
        })
    return success_response(data={"disputes": items, **meta})


class DisputeResolveIn(Schema):
    status: str
    admin_notes: str = ""


@router.put("/admin/billing/disputes/{dispute_id}/resolve")
@billing_api_errors
def admin_resolve_dispute(request, dispute_id: str, data: DisputeResolveIn):
    _require_admin(request)
    from .models import BillingDispute

    dispute = BillingDispute.objects.filter(id=dispute_id).first()
    if not dispute:
        raise HttpError(404, _("billing.dispute_not_found"))

    if data.status not in ("resolved", "rejected"):
        raise HttpError(400, _("billing.dispute_invalid_status"))

    dispute.status = data.status
    dispute.admin_notes = data.admin_notes
    dispute.resolved_at = timezone.now()
    dispute.save(update_fields=["status", "admin_notes", "resolved_at", "updated_at"])

    record_billing_audit(
        request, action="dispute_resolve", target_type="billing_dispute",
        target_id=dispute_id, detail={"status": data.status},
    )
    return success_response(data={"id": dispute_id, "status": data.status})


# ── W5-5: BYOK 毛利分列增强 ──────────────────────────────────────


@router.get("/admin/billing/cost-analysis-byok")
@billing_api_errors
def admin_cost_analysis_byok(request, days: int = 30):
    _require_admin(request)
    from apps.services.llm.models import LLMUsageFact

    days = max(1, min(days, 365))
    since = timezone.now() - timedelta(days=days)

    platform_agg = (
        LLMUsageFact.objects
        .filter(created_at__gte=since, cost_status="platform_paid")
        .aggregate(
            total_cost=Coalesce(Sum("total_cost"), Decimal("0")),
            call_count=Coalesce(Count("id"), 0),
        )
    )
    byok_agg = (
        LLMUsageFact.objects
        .filter(created_at__gte=since, cost_status="byok_self_paid")
        .aggregate(
            total_cost=Coalesce(Sum("total_cost"), Decimal("0")),
            call_count=Coalesce(Count("id"), 0),
        )
    )

    platform_revenue = (
        BillingUsageEvent.objects
        .filter(
            meter_key__startswith="llm.",
            occurred_at__gte=since,
        )
        .aggregate(total=Coalesce(Sum("amount"), Decimal("0")))
    )

    return success_response(data={
        "days": days,
        "platform": {
            "total_cost": str(safe_decimal(platform_agg["total_cost"])),
            "call_count": platform_agg["call_count"],
            "total_revenue": str(safe_decimal(platform_revenue["total"])),
        },
        "byok": {
            "total_cost": str(safe_decimal(byok_agg["total_cost"])),
            "call_count": byok_agg["call_count"],
        },
    })
