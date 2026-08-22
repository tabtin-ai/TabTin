"""
计费中心 API
"""

import csv
import io
import logging
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any, Dict, List, Optional

from django.db.models import Case, Count, IntegerField, Q, Sum, Value, When
from django.http import StreamingHttpResponse
from django.utils import timezone
from django.utils.dateparse import parse_date, parse_datetime
from ninja import Query, Router, Schema
from ninja.errors import HttpError

from apps.i18n import _, get_text
from apps.i18n.response import success_response
from apps.users.auth.permissions import JWTAuth

from django.conf import settings

logger = logging.getLogger(__name__)

from .models import (
    AddonPackage,
    BillingInvoice,
    BillingUsageDaily,
    BillingUsageEvent,
    MEMBER_BUDGET_SENTINEL,
    MemberLlmBudgetPolicy,
    MemberLlmUsageCounter,
    StoragePackagePlan,
    OrganizationStorageSubscription,
    OrganizationBillingEntitlement,
    OrganizationBillingPolicy,
    OrganizationLlmMonthlyBudget,
    OrganizationStorageUsage,
)
from .api_utils import billing_api_errors, safe_decimal, usage_event_display_credits
from .services import (
    BillingSettlementService,
    StatementService,
    OrganizationBillingPolicyService,
    OrganizationEntitlementSyncService,
    OrganizationStoragePackageService,
)
from .services.addon_entitlement_service import AddonEntitlementService
from .services.collection_service import BillingCollectionService
from .services.llm_topup_service import LlmQuotaTopupService

router = Router()

jwt_auth = JWTAuth()

if not getattr(settings, "BILLING_DISABLE_ADMIN_ROUTER", False):
    from .api_admin import router as _admin_router

    router.add_router("", _admin_router)

from .api_service_catalog import router as _service_catalog_router

router.add_router("", _service_catalog_router)

_USAGE_EVENT_SEARCH_MAX_LEN = 200
_USAGE_EVENT_ORDER_WHITELIST = frozenset({
    "-occurred_at",
    "occurred_at",
    "-created_at",
    "created_at",
    "-charged_at",
    "charged_at",
    "-amount",
    "amount",
    "-quantity",
    "quantity",
})


class OrganizationPolicyUpdateIn(Schema):
    storage_billing_mode: Optional[str] = None
    llm_billing_mode: Optional[str] = None
    currency: Optional[str] = None
    is_active: Optional[bool] = None
    metadata: Optional[Dict[str, Any]] = None
    # LLM 点券自动补充配置
    auto_topup_enabled: Optional[bool] = None
    auto_topup_spend_yuan: Optional[Decimal] = None
    auto_topup_threshold_credits: Optional[Decimal] = None
    auto_topup_monthly_cap_yuan: Optional[Decimal] = None


class OrganizationEntitlementUpdateIn(Schema):
    included_storage_bytes: Optional[int] = None
    purchased_storage_bytes: Optional[int] = None
    included_llm_credits_monthly: Optional[Decimal] = None
    effective_from: Optional[datetime] = None
    effective_to: Optional[datetime] = None
    is_active: Optional[bool] = None
    metadata: Optional[Dict[str, Any]] = None


class InvoiceGenerateIn(Schema):
    year: int
    month: int
    overwrite_draft: bool = True


class DailySettlementIn(Schema):
    usage_date: Optional[date] = None


class StoragePackagePurchaseIn(Schema):
    package_id: str
    payment_method: str
    extra_params: Optional[Dict[str, Any]] = None


class AddonPackagePurchaseIn(Schema):
    package_id: str
    payment_method: str
    extra_params: Optional[Dict[str, Any]] = None


def _check_organization_permission(request, organization_id: str, permission: str = "viewer") -> None:
    from apps.tabtinspace.services import OrganizationService

    ws_service = OrganizationService(user=request.auth)
    if not ws_service.check_organization_permission(organization_id, permission):
        raise HttpError(403, get_text("chat.organization_mismatch", organization_id=organization_id))


def _aware_dt(dt: datetime) -> datetime:
    if timezone.is_naive(dt):
        return timezone.make_aware(dt, timezone.get_current_timezone())
    return dt


def _apply_usage_event_after_filter(qs, raw: str):
    d = parse_date(raw)
    if d:
        start = timezone.make_aware(datetime.combine(d, datetime.min.time()))
        return qs.filter(occurred_at__gte=start)
    dt = parse_datetime(raw)
    if dt is None:
        raise HttpError(400, "occurred_after 格式无效")
    return qs.filter(occurred_at__gte=_aware_dt(dt))


def _apply_usage_event_before_filter(qs, raw: str):
    d = parse_date(raw)
    if d:
        next_day = d + timedelta(days=1)
        boundary = timezone.make_aware(datetime.combine(next_day, datetime.min.time()))
        return qs.filter(occurred_at__lt=boundary)
    dt = parse_datetime(raw)
    if dt is None:
        raise HttpError(400, "occurred_before 格式无效")
    return qs.filter(occurred_at__lte=_aware_dt(dt))


def _normalize_usage_event_order(order_by: Optional[str]) -> str:
    if not order_by:
        return "-occurred_at"
    key = order_by.strip()
    return key if key in _USAGE_EVENT_ORDER_WHITELIST else "-occurred_at"


def _build_usage_event_queryset(
    *,
    organization_id: str,
    user_id: Optional[str] = None,
    meter_key: Optional[str] = None,
    biz_type: Optional[str] = None,
    scene_key: Optional[str] = None,
    occurred_after: Optional[str] = None,
    occurred_before: Optional[str] = None,
    search: Optional[str] = None,
    order_by: Optional[str] = None,
):
    # funding_mode 的稳定快照复用 BillingUsageEvent 作为并发占位，但它尚未产生
    # Provider 用量，也尚未完成结算。用户账单只展示真实用量；否则会把
    # ``0 token / 0 credits / 空模型`` 误标成“已扣费”。审计后台仍可直接查原表。
    queryset = BillingUsageEvent.objects.filter(
        organization_id=organization_id,
    ).exclude(metadata__status="pending_deduction")

    if user_id and str(user_id).strip():
        queryset = queryset.filter(user_id=str(user_id).strip())

    if meter_key and str(meter_key).strip():
        queryset = queryset.filter(meter_key=str(meter_key).strip())

    if biz_type and str(biz_type).strip():
        from apps.services.billing.usage_event_filters import resolve_usage_event_biz_types

        biz_types = resolve_usage_event_biz_types(biz_type)
        if len(biz_types) == 1:
            queryset = queryset.filter(biz_type=biz_types[0])
        elif biz_types:
            queryset = queryset.filter(biz_type__in=biz_types)

    if scene_key and str(scene_key).strip():
        queryset = queryset.filter(scene_key=str(scene_key).strip())

    if occurred_after and str(occurred_after).strip():
        queryset = _apply_usage_event_after_filter(queryset, str(occurred_after).strip())

    if occurred_before and str(occurred_before).strip():
        queryset = _apply_usage_event_before_filter(queryset, str(occurred_before).strip())

    if search and str(search).strip():
        term = str(search).strip()[:_USAGE_EVENT_SEARCH_MAX_LEN]
        queryset = queryset.filter(
            Q(idempotency_key__icontains=term)
            | Q(biz_type__icontains=term)
            | Q(biz_id__icontains=term)
            | Q(meter_key__icontains=term)
            | Q(model_name__icontains=term)
            | Q(provider_key__icontains=term)
        )

    return queryset.order_by(_normalize_usage_event_order(order_by), "-created_at")


def _serialize_usage_event(event: BillingUsageEvent, task_name: str = "") -> Dict[str, Any]:
    return {
        "id": str(event.id),
        # ：任务名 = metadata.session_id 反查到的会话标题；
        # 非会话类消耗（存储 / 后台任务）与历史数据为空串。
        "task_name": task_name,
        "organization_id": event.organization_id,
        "user_id": event.user_id,
        "meter_key": event.meter_key,
        "quantity": str(event.quantity),
        "unit": event.unit,
        "unit_price": str(event.unit_price),
        "amount": str(event.amount),
        "display_credits": str(usage_event_display_credits(event)),
        "currency": event.currency,
        "provider_key": event.provider_key,
        "model_name": event.model_name,
        "scene_key": event.scene_key,
        "biz_type": event.biz_type,
        "biz_id": event.biz_id,
        "metadata": event.metadata or {},
        "charge_status": event.charge_status,
        "charged_at": event.charged_at.isoformat() if event.charged_at else None,
        "aggregation_key": event.aggregation_key,
        "occurred_at": event.occurred_at.isoformat() if event.occurred_at else None,
        "created_at": event.created_at.isoformat() if event.created_at else None,
    }


def _serialize_policy(policy: Optional[OrganizationBillingPolicy], organization_id: str) -> Dict[str, Any]:
    effective = OrganizationBillingPolicyService.get_effective_policy(organization_id)
    if not policy:
        return {
            **effective,
            "auto_topup_spend_yuan": str(safe_decimal(effective.get("auto_topup_spend_yuan"))),
            "auto_topup_threshold_credits": str(safe_decimal(effective.get("auto_topup_threshold_credits"))),
            "auto_topup_monthly_cap_yuan": str(safe_decimal(effective.get("auto_topup_monthly_cap_yuan"))),
        }
    return {
        "organization_id": organization_id,
        "storage_billing_mode": policy.storage_billing_mode,
        "llm_billing_mode": policy.llm_billing_mode,
        "currency": policy.currency,
        "auto_topup_enabled": bool(policy.auto_topup_enabled),
        "auto_topup_spend_yuan": str(safe_decimal(policy.auto_topup_spend_yuan)),
        "auto_topup_threshold_credits": str(safe_decimal(policy.auto_topup_threshold_credits)),
        "auto_topup_monthly_cap_yuan": str(safe_decimal(policy.auto_topup_monthly_cap_yuan)),
        "is_active": policy.is_active,
        "metadata": policy.metadata or {},
        "is_default": False,
        "updated_at": policy.updated_at.isoformat() if policy.updated_at else None,
    }


def _serialize_entitlement(entitlement: Optional[OrganizationBillingEntitlement], organization_id: str) -> Dict[str, Any]:
    snapshot = OrganizationBillingPolicyService.get_entitlement_snapshot(organization_id)
    base_snapshot = {
        **snapshot,
        "included_llm_credits_monthly": str(safe_decimal(snapshot.get("included_llm_credits_monthly"))),
    }
    if not entitlement:
        return {
            **base_snapshot,
            "effective_from": None,
            "effective_to": None,
            "is_active": True,
            "updated_at": None,
        }
    return {
        **base_snapshot,
        "effective_from": entitlement.effective_from.isoformat() if entitlement.effective_from else None,
        "effective_to": entitlement.effective_to.isoformat() if entitlement.effective_to else None,
        "is_active": entitlement.is_active,
        "updated_at": entitlement.updated_at.isoformat() if entitlement.updated_at else None,
    }


def _serialize_storage_package_plan(package: StoragePackagePlan) -> Dict[str, Any]:
    return {
        "id": str(package.id),
        "name": package.name,
        "description": package.description,
        "price": str(safe_decimal(package.price)),
        "storage_bytes": int(package.storage_bytes or 0),
        "bonus_storage_bytes": int(package.bonus_storage_bytes or 0),
        "total_storage_bytes": int(package.total_storage_bytes),
        "duration_months": int(package.duration_months or 0),
        "sort_order": int(package.sort_order or 0),
        "is_active": bool(package.is_active),
        "metadata": package.metadata or {},
    }


def _serialize_addon_package(package: AddonPackage) -> Dict[str, Any]:
    return {
        "id": str(package.id),
        "addon_code": package.addon_code,
        "addon_name": package.addon_name,
        "description": package.description,
        "price": str(safe_decimal(package.price)),
        "quota_key": package.quota_key,
        "quota_label": package.get_quota_key_display(),
        "quota_value": int(package.quota_value or 0),
        "period_months": int(package.period_months or 0),
        "sort_order": int(package.sort_order or 0),
        "is_active": bool(package.is_active),
        "metadata": package.metadata or {},
        "created_at": package.created_at.isoformat() if package.created_at else None,
        "updated_at": package.updated_at.isoformat() if package.updated_at else None,
    }


def _serialize_storage_subscription(subscription: OrganizationStorageSubscription) -> Dict[str, Any]:
    package = subscription.package_plan
    return {
        "id": str(subscription.id),
        "organization_id": subscription.organization_id,
        "package_id": str(subscription.package_plan_id),
        "package_name": package.name if package else "",
        "storage_bytes": int(subscription.storage_bytes or 0),
        "status": subscription.status,
        "start_at": subscription.start_at.isoformat() if subscription.start_at else None,
        "end_at": subscription.end_at.isoformat() if subscription.end_at else None,
        "auto_renew": bool(subscription.auto_renew),
        "purchased_by": subscription.purchased_by or "",
        "metadata": subscription.metadata or {},
    }


SAFE_ERROR_CODES = frozenset({
    "insufficient_credits",
    "no_wallet",
    "no_payer_configured",
    "wallet_exception",
})

_SAFE_ERROR_MESSAGES = frozenset({
    "credits 不足",
    "未配置扣款账户",
    "扣款异常，请联系技术支持",
})


def _sanitize_collection_error(collection_meta: dict) -> str:
    error_code = collection_meta.get("last_error_code", "")
    if error_code:
        if error_code in SAFE_ERROR_CODES:
            return collection_meta.get("last_error", "")
        return _("billing.charge_error_contact")

    raw = collection_meta.get("last_error", "")
    if not raw:
        return ""
    if raw in _SAFE_ERROR_MESSAGES:
        return raw
    for prefix in ("credits 不足", "未配置扣款账户"):
        if raw.startswith(prefix):
            return prefix
    return _("billing.charge_error_contact")


def _translate_line_description(description: str, meter_key: str) -> str:
    """在 API 层翻译 invoice line description（有请求上下文，_() 能正确取语言）。"""
    if not description:
        return description
    if description.startswith("billing.invoice_line.other_meter:"):
        actual_meter = description.split(":", 1)[1]
        return _("billing.invoice_line.other_meter", meter_key=actual_meter)
    if description.startswith("billing.invoice_line."):
        return _(description)
    return description


def _serialize_invoice(invoice: BillingInvoice, include_lines: bool = False) -> Dict[str, Any]:
    collection_meta = (invoice.metadata or {}).get("collection") or {}
    payload = {
        "id": str(invoice.id),
        "invoice_no": invoice.invoice_no,
        "organization_id": invoice.organization_id,
        "period_start": invoice.period_start.isoformat(),
        "period_end": invoice.period_end.isoformat(),
        "status": invoice.status,
        "currency": invoice.currency,
        "subtotal_amount": str(safe_decimal(invoice.subtotal_amount)),
        "discount_amount": str(safe_decimal(invoice.discount_amount)),
        "total_amount": str(safe_decimal(invoice.total_amount)),
        "issued_at": invoice.issued_at.isoformat() if invoice.issued_at else None,
        "paid_at": invoice.paid_at.isoformat() if invoice.paid_at else None,
        "refunded_amount": str(safe_decimal(invoice.refunded_amount)) if invoice.refunded_amount else None,
        "refunded_at": invoice.refunded_at.isoformat() if invoice.refunded_at else None,
        "metadata": {k: v for k, v in (invoice.metadata or {}).items() if k != "collection"},
        "collection": {
            "attempt_count": int(collection_meta.get("attempt_count") or 0),
            "max_attempts": BillingCollectionService.MAX_COLLECTION_ATTEMPTS,
            "last_attempt_at": collection_meta.get("last_attempt_at"),
            "last_error": _sanitize_collection_error(collection_meta),
            "last_success_at": collection_meta.get("last_success_at"),
            "last_wallet_tx_id": collection_meta.get("last_wallet_tx_id") or "",
            "payer_user_id": (invoice.metadata or {}).get("payer_user_id") or "",
        },
        "created_at": invoice.created_at.isoformat() if invoice.created_at else None,
        "updated_at": invoice.updated_at.isoformat() if invoice.updated_at else None,
    }
    if include_lines:
        payload["lines"] = [
            {
                "id": str(line.id),
                "meter_key": line.meter_key,
                "description": _translate_line_description(line.description, line.meter_key),
                "quantity": str(safe_decimal(line.quantity)),
                "unit": line.unit,
                "unit_price": str(safe_decimal(line.unit_price)),
                "amount": str(safe_decimal(line.amount)),
                "metadata": line.metadata or {},
                "created_at": line.created_at.isoformat() if line.created_at else None,
            }
            for line in invoice.lines.all().order_by("created_at")
        ]
    return payload


@router.get("/storage-packages", auth=None, tags=["存储套餐"])
@billing_api_errors
def list_storage_packages(request, active_only: bool = True):
    queryset = OrganizationStoragePackageService.list_packages(active_only=bool(active_only))
    return success_response(
        data=[_serialize_storage_package_plan(item) for item in queryset],
        message=_("billing.storage_plan_success"),
    )


@router.get("/addon-packages", auth=None, tags=["权益增值包"])
@billing_api_errors
def list_addon_packages(request, active_only: bool = True):
    queryset = AddonEntitlementService.list_packages(active_only=bool(active_only))
    return success_response(
        data=[_serialize_addon_package(item) for item in queryset],
        message="增值包列表获取成功",
    )


@router.post("/organizations/{organization_id}/addon-packages/purchase", auth=jwt_auth, tags=["权益增值包"])
@billing_api_errors
def purchase_organization_addon_package(request, organization_id: str, data: AddonPackagePurchaseIn):
    _check_organization_permission(request, organization_id, "owner")

    if data.payment_method not in ("alipay", "wechat"):
        raise HttpError(400, _("billing.errors.unsupported_payment_method"))

    from django.conf import settings
    from apps.services.payment.models import PaymentOrder
    from apps.services.payment.services.factory import PaymentServiceFactory

    package = AddonPackage.objects.filter(id=data.package_id, is_active=True).first()
    if not package:
        raise HttpError(404, "增值包不存在或已下架")

    expired_at = timezone.now() + timedelta(minutes=getattr(settings, "ORDER_EXPIRE_MINUTES", 30))

    order = PaymentOrder.objects.create(
        user_id=str(request.auth.id),
        organization_id=organization_id,
        order_type="billing_addon",
        subject=f"购买增值包：{package.addon_name}",
        description=f"{package.addon_name} - {package.period_months}个月",
        amount=package.price,
        payment_method=data.payment_method,
        business_data={
            "organization_id": organization_id,
            "addon_package_id": str(package.id),
            "addon_code": package.addon_code,
            "addon_name": package.addon_name,
            "quota_key": package.quota_key,
            "quota_value": int(package.quota_value),
            "period_months": int(package.period_months),
        },
        status="pending",
        expired_at=expired_at,
    )

    payment_service = PaymentServiceFactory.get_service(data.payment_method)
    payment_result = payment_service.create_payment(
        order_no=order.order_no,
        amount=package.price,
        subject=order.subject,
        description=order.description,
        extra_params=data.extra_params or {},
    )

    order.third_party_order_no = payment_result.get("third_party_order_no", "")
    order.status = "paying"
    order.save(update_fields=["third_party_order_no", "status", "updated_at"])

    return success_response(
        data={
            "order_no": order.order_no,
            "order_id": str(order.id),
            "package_name": package.addon_name,
            "amount": str(package.price),
            "quota_key": package.quota_key,
            "quota_value": int(package.quota_value),
            "period_months": int(package.period_months),
            "pay_url": payment_result.get("pay_url"),
            "qr_code": payment_result.get("qr_code"),
            "form_html": payment_result.get("form_html"),
            "expired_at": order.expired_at.isoformat() if order.expired_at else None,
        },
        message="增值包订单创建成功",
    )


@router.post("/organizations/{organization_id}/storage-packages/purchase", auth=jwt_auth, tags=["存储套餐"])
@billing_api_errors
def purchase_organization_storage_package(request, organization_id: str, data: StoragePackagePurchaseIn):
    _check_organization_permission(request, organization_id, "owner")

    if data.payment_method not in ("alipay", "wechat"):
        raise HttpError(400, _("billing.errors.unsupported_payment_method"))

    from django.conf import settings
    from apps.services.payment.models import PaymentOrder
    from apps.services.payment.services.factory import PaymentServiceFactory

    package = StoragePackagePlan.objects.filter(id=data.package_id, is_active=True).first()
    if not package:
        raise HttpError(404, _("billing.errors.storage_plan_not_found"))

    expired_at = timezone.now() + timedelta(minutes=getattr(settings, "ORDER_EXPIRE_MINUTES", 30))

    order = PaymentOrder.objects.create(
        user_id=str(request.auth.id),
        organization_id=organization_id,
        order_type="storage_package",
        subject=f"购买存储套餐：{package.name}",
        description=f"{package.name} - {package.duration_months}个月",
        amount=package.price,
        payment_method=data.payment_method,
        business_data={
            "organization_id": organization_id,
            "storage_package_id": str(package.id),
            "storage_bytes": int(package.total_storage_bytes),
            "duration_months": int(package.duration_months),
            "package_name": package.name,
        },
        status="pending",
        expired_at=expired_at,
    )

    payment_service = PaymentServiceFactory.get_service(data.payment_method)
    payment_result = payment_service.create_payment(
        order_no=order.order_no,
        amount=package.price,
        subject=order.subject,
        description=order.description,
        extra_params=data.extra_params or {},
    )

    order.third_party_order_no = payment_result.get("third_party_order_no", "")
    order.status = "paying"
    order.save(update_fields=["third_party_order_no", "status", "updated_at"])

    return success_response(
        data={
            "order_no": order.order_no,
            "order_id": order.id,
            "package_name": package.name,
            "storage_bytes": int(package.total_storage_bytes),
            "duration_months": int(package.duration_months),
            "amount": str(package.price),
            "pay_url": payment_result.get("pay_url"),
            "qr_code": payment_result.get("qr_code"),
            "form_html": payment_result.get("form_html"),
            "expired_at": order.expired_at.isoformat() if order.expired_at else None,
        },
        message=_("billing.storage_order_created"),
    )


@router.post(
    "/organizations/{organization_id}/storage-subscriptions/{subscription_id}/cancel",
    auth=jwt_auth,
    tags=["存储套餐"],
)
@billing_api_errors
def cancel_storage_subscription(request, organization_id: str, subscription_id: str):
    _check_organization_permission(request, organization_id, "owner")
    try:
        result = OrganizationStoragePackageService.cancel_subscription(
            organization_id=organization_id,
            subscription_id=subscription_id,
            cancelled_by=str(request.auth.id),
        )
    except (OrganizationStorageSubscription.DoesNotExist, ValueError):
        raise HttpError(404, _("billing.subscription_not_found"))
    return success_response(data=result, message=_("billing.subscription_cancel_success"))


@router.post(
    "/organizations/{organization_id}/storage-subscriptions/{subscription_id}/enable-auto-renew",
    auth=jwt_auth,
    tags=["存储套餐"],
)
@billing_api_errors
def enable_storage_auto_renew(request, organization_id: str, subscription_id: str):
    _check_organization_permission(request, organization_id, "owner")
    try:
        result = OrganizationStoragePackageService.enable_auto_renew(
            organization_id=organization_id,
            subscription_id=subscription_id,
            enabled_by=str(request.auth.id),
        )
    except (OrganizationStorageSubscription.DoesNotExist, ValueError):
        raise HttpError(404, _("billing.subscription_not_found"))
    return success_response(data=result, message=_("billing.enable_auto_renew_success"))


@router.get("/organizations/{organization_id}/summary", auth=jwt_auth, tags=["计费概览"])
@billing_api_errors
def get_organization_billing_summary(request, organization_id: str, days: int = 30, event_limit: int = 20):
    """
    获取组织计费摘要。
    """
    _check_organization_permission(request, organization_id, "viewer")

    window_days = max(1, min(int(days or 30), 180))
    limit = max(1, min(int(event_limit or 20), 100))
    window_start = timezone.now() - timedelta(days=window_days)

    storage_usage = OrganizationStorageUsage.objects.filter(organization_id=organization_id).first()
    usage_qs = BillingUsageEvent.objects.filter(
        organization_id=organization_id,
        occurred_at__gte=window_start,
    )

    llm_usage_qs = usage_qs.filter(meter_key="llm.tokens")
    storage_usage_qs = usage_qs.filter(meter_key="storage.bytes")

    llm_agg = llm_usage_qs.aggregate(
        total_tokens=Sum("quantity"),
        total_credits=Sum("amount"),
    )
    storage_agg = storage_usage_qs.aggregate(
        total_delta_bytes=Sum("quantity"),
        total_credits=Sum("amount"),
    )

    latest_events = list(
        usage_qs.order_by("-occurred_at", "-created_at")[:limit].values(
            "id",
            "meter_key",
            "quantity",
            "unit",
            "unit_price",
            "amount",
            "currency",
            "biz_type",
            "biz_id",
            "occurred_at",
            "provider_key",
            "model_name",
            "metadata",
        )
    )

    policy_obj = OrganizationBillingPolicy.objects.filter(organization_id=organization_id).first()
    entitlement_obj = OrganizationBillingEntitlement.objects.filter(organization_id=organization_id).first()
    now = timezone.now()
    current_month_budget = OrganizationLlmMonthlyBudget.objects.filter(
        organization_id=organization_id,
        cycle_month=date(now.year, now.month, 1),
    ).first()
    active_storage_packages = list(
        OrganizationStorageSubscription.objects.filter(
            organization_id=organization_id,
            status="active",
            start_at__lte=now,
            end_at__gt=now,
        )
        .select_related("package_plan")
        .order_by("end_at", "created_at")
    )

    if current_month_budget:
        _budget_included = str(safe_decimal(current_month_budget.included_credits))
        _budget_consumed = str(safe_decimal(current_month_budget.consumed_credits))
        _budget_overflow = str(safe_decimal(current_month_budget.overflow_credits))
        _budget_topup = str(safe_decimal(current_month_budget.topup_credits))
        _budget_remaining = str(safe_decimal(current_month_budget.remaining_credits))
        _budget_cycle_date = current_month_budget.cycle_month
        _budget_cycle = _budget_cycle_date.isoformat()
    else:
        _ent_snapshot = OrganizationBillingPolicyService.get_entitlement_snapshot(organization_id)
        _fallback_included = safe_decimal(_ent_snapshot.get("included_llm_credits_monthly"))
        _budget_included = str(_fallback_included)
        _budget_consumed = "0"
        _budget_overflow = "0"
        _budget_topup = "0"
        _budget_remaining = str(_fallback_included)
        _budget_cycle_date = date(now.year, now.month, 1)
        _budget_cycle = _budget_cycle_date.isoformat()

    # 本月自动补充现金花费：与月上限同口径（llm_auto_topup 流水），勿读已废弃的 topup_credits
    _auto_topup_spent_yuan = str(
        LlmQuotaTopupService._current_month_auto_topup_yuan(organization_id, _budget_cycle_date)
    )

    return success_response(
        data={
            "organization_id": organization_id,
            "window_days": window_days,
            "policy": _serialize_policy(policy_obj, organization_id),
            "entitlement": _serialize_entitlement(entitlement_obj, organization_id),
            "llm_month_budget": {
                "cycle_month": _budget_cycle,
                "included_credits": _budget_included,
                "consumed_credits": _budget_consumed,
                "overflow_credits": _budget_overflow,
                "topup_credits": _budget_topup,
                "auto_topup_spent_yuan": _auto_topup_spent_yuan,
                "remaining_credits": _budget_remaining,
            },
            "storage_snapshot": {
                "active_file_count": int(storage_usage.active_file_count) if storage_usage else 0,
                "active_storage_bytes": int(storage_usage.active_storage_bytes) if storage_usage else 0,
                "total_uploaded_bytes": int(storage_usage.total_uploaded_bytes) if storage_usage else 0,
                "total_released_bytes": int(storage_usage.total_released_bytes) if storage_usage else 0,
                "last_metered_at": storage_usage.last_metered_at.isoformat() if storage_usage and storage_usage.last_metered_at else None,
            },
            "usage_summary": {
                "llm_tokens": str(safe_decimal(llm_agg.get("total_tokens"))),
                "llm_credits": str(safe_decimal(llm_agg.get("total_credits"))),
                "storage_delta_bytes": str(safe_decimal(storage_agg.get("total_delta_bytes"))),
                "storage_credits": str(safe_decimal(storage_agg.get("total_credits"))),
            },
            "active_storage_packages": [
                _serialize_storage_subscription(item)
                for item in active_storage_packages
            ],
            "latest_events": latest_events,
        },
        message=_("billing.billing_summary_success"),
    )


@router.get("/organizations/{organization_id}/usage-events", auth=jwt_auth, tags=["用量分析"])
@billing_api_errors
def list_organization_usage_events(
    request,
    organization_id: str,
    user_id: Optional[str] = None,
    meter_key: Optional[str] = None,
    biz_type: Optional[str] = None,
    scene_key: Optional[str] = None,
    limit: int = 20,
    offset: int = 0,
    occurred_after: Optional[str] = None,
    occurred_before: Optional[str] = None,
    search: Optional[str] = None,
    order_by: Optional[str] = None,
):
    """
    查询 BillingUsageEvent 明细列表。

    用于设置页「用量中心」中的 billing 明细预览；分页只影响列表展示，CSV 导出仍沿用既有
    `/billing/export` 日期范围接口。

    展示「LLM 用量」时调用方须传 meter_key=llm.tokens，否则会混入 storage.bytes 等
    非 LLM 审计事件（如文件删除释放，）。
    """
    _check_organization_permission(request, organization_id, "viewer")
    role = _get_organization_role(request, organization_id)
    if role not in ("owner", "admin", "editor"):
        raise HttpError(403, "无明细查看权限")
    effective_user_id = str(request.auth.id) if role == "editor" else user_id
    limit = min(max(int(limit or 20), 1), 100)
    offset = max(int(offset or 0), 0)

    queryset = _build_usage_event_queryset(
        organization_id=organization_id,
        user_id=effective_user_id,
        meter_key=meter_key,
        biz_type=biz_type,
        scene_key=scene_key,
        occurred_after=occurred_after,
        occurred_before=occurred_before,
        search=search,
        order_by=order_by,
    )
    total = queryset.count()
    events = list(queryset[offset:offset + limit])

    # ：当页事件批量反查会话标题作「任务名」（一次 IN 查询，无 N+1）。
    from apps.services.billing.services.task_name_resolver import (
        resolve_task_names_for_events,
    )
    task_names = resolve_task_names_for_events(events, organization_id)

    return success_response(
        data={
            "total": total,
            "events": [
                _serialize_usage_event(event, task_name=task_names.get(str(event.id), ""))
                for event in events
            ],
        },
        message=_("billing.usage_events_success"),
    )


@router.get("/organizations/{organization_id}/policy", auth=jwt_auth, tags=["计费配置"])
@billing_api_errors
def get_organization_billing_policy(request, organization_id: str):
    _check_organization_permission(request, organization_id, "viewer")
    policy = OrganizationBillingPolicy.objects.filter(organization_id=organization_id).first()
    return success_response(data=_serialize_policy(policy, organization_id), message=_("billing.billing_policy_success"))


@router.put("/organizations/{organization_id}/policy", auth=jwt_auth, tags=["计费配置"])
@billing_api_errors
def upsert_organization_billing_policy(request, organization_id: str, data: OrganizationPolicyUpdateIn):
    _check_organization_permission(request, organization_id, "owner")

    mode_values = {item[0] for item in OrganizationBillingPolicy.STORAGE_BILLING_MODE_CHOICES}
    llm_mode_values = {item[0] for item in OrganizationBillingPolicy.LLM_BILLING_MODE_CHOICES}
    if data.storage_billing_mode and data.storage_billing_mode not in mode_values:
        raise HttpError(400, _("billing.invalid_storage_billing_mode", mode=data.storage_billing_mode))
    if data.llm_billing_mode and data.llm_billing_mode not in llm_mode_values:
        raise HttpError(400, _("billing.invalid_llm_billing_mode", mode=data.llm_billing_mode))
    for field_name in ("auto_topup_spend_yuan", "auto_topup_threshold_credits", "auto_topup_monthly_cap_yuan"):
        value = getattr(data, field_name)
        if value is not None and value < 0:
            raise HttpError(400, _("billing.errors.field_range", field=field_name, min="0", max="-"))

    existing = OrganizationBillingPolicy.objects.filter(organization_id=organization_id).first()

    def _pick(field_name: str, service_default):
        value = getattr(data, field_name)
        if value is not None:
            return value
        return getattr(existing, field_name) if existing else service_default

    defaults = {
        "storage_billing_mode": (
            data.storage_billing_mode
            or (existing.storage_billing_mode if existing else OrganizationBillingPolicyService.DEFAULT_STORAGE_BILLING_MODE)
        ),
        "llm_billing_mode": (
            data.llm_billing_mode
            or (existing.llm_billing_mode if existing else OrganizationBillingPolicyService.DEFAULT_LLM_BILLING_MODE)
        ),
        "currency": data.currency or (existing.currency if existing else OrganizationBillingPolicyService.DEFAULT_CURRENCY),
        "is_active": bool(data.is_active) if data.is_active is not None else (existing.is_active if existing else True),
        "metadata": data.metadata if data.metadata is not None else (existing.metadata if existing else {}),
        "auto_topup_enabled": bool(_pick("auto_topup_enabled", OrganizationBillingPolicyService.DEFAULT_AUTO_TOPUP_ENABLED)),
        "auto_topup_spend_yuan": _pick("auto_topup_spend_yuan", OrganizationBillingPolicyService.DEFAULT_AUTO_TOPUP_SPEND_YUAN),
        "auto_topup_threshold_credits": _pick(
            "auto_topup_threshold_credits", OrganizationBillingPolicyService.DEFAULT_AUTO_TOPUP_THRESHOLD_CREDITS,
        ),
        "auto_topup_monthly_cap_yuan": _pick(
            "auto_topup_monthly_cap_yuan", OrganizationBillingPolicyService.DEFAULT_AUTO_TOPUP_MONTHLY_CAP_YUAN,
        ),
    }
    policy, _created = OrganizationBillingPolicy.objects.update_or_create(
        organization_id=organization_id,
        defaults=defaults,
    )
    return success_response(data=_serialize_policy(policy, organization_id), message=_("billing.billing_policy_updated"))


@router.get("/organizations/{organization_id}/entitlement", auth=jwt_auth, tags=["计费配置"])
@billing_api_errors
def get_organization_billing_entitlement(request, organization_id: str):
    _check_organization_permission(request, organization_id, "viewer")
    entitlement = OrganizationBillingEntitlement.objects.filter(organization_id=organization_id).first()
    return success_response(data=_serialize_entitlement(entitlement, organization_id), message=_("billing.entitlement_success"))


@router.put("/organizations/{organization_id}/entitlement", auth=jwt_auth, tags=["计费配置"])
@billing_api_errors
def upsert_organization_billing_entitlement(request, organization_id: str, data: OrganizationEntitlementUpdateIn):
    _check_organization_permission(request, organization_id, "owner")

    if data.included_storage_bytes is not None and data.included_storage_bytes < 0:
        raise HttpError(400, _("billing.errors.field_negative", field="included_storage_bytes"))
    if data.purchased_storage_bytes is not None and data.purchased_storage_bytes < 0:
        raise HttpError(400, _("billing.errors.field_negative", field="purchased_storage_bytes"))
    if data.included_llm_credits_monthly is not None and Decimal(str(data.included_llm_credits_monthly)) < 0:
        raise HttpError(400, _("billing.errors.field_negative", field="included_llm_credits_monthly"))

    existing = OrganizationBillingEntitlement.objects.filter(organization_id=organization_id).first()
    metadata = data.metadata if data.metadata is not None else (existing.metadata if existing else {})
    metadata = dict(metadata or {})
    if data.included_storage_bytes is not None:
        metadata[OrganizationEntitlementSyncService.MANUAL_INCLUDED_STORAGE_META_KEY] = int(data.included_storage_bytes)
    if data.included_llm_credits_monthly is not None:
        metadata[OrganizationEntitlementSyncService.MANUAL_INCLUDED_LLM_META_KEY] = str(data.included_llm_credits_monthly)
    defaults = {
        "included_storage_bytes": (
            int(data.included_storage_bytes)
            if data.included_storage_bytes is not None
            else int(existing.included_storage_bytes if existing else 0)
        ),
        "purchased_storage_bytes": (
            int(data.purchased_storage_bytes)
            if data.purchased_storage_bytes is not None
            else int(existing.purchased_storage_bytes if existing else 0)
        ),
        "included_llm_credits_monthly": (
            Decimal(str(data.included_llm_credits_monthly))
            if data.included_llm_credits_monthly is not None
            else Decimal(str(existing.included_llm_credits_monthly if existing else 0))
        ),
        "effective_from": data.effective_from or (existing.effective_from if existing else timezone.now()),
        "effective_to": data.effective_to if data.effective_to is not None else (existing.effective_to if existing else None),
        "is_active": bool(data.is_active) if data.is_active is not None else (existing.is_active if existing else True),
        "metadata": metadata,
    }
    entitlement, _created = OrganizationBillingEntitlement.objects.update_or_create(
        organization_id=organization_id,
        defaults=defaults,
    )
    return success_response(data=_serialize_entitlement(entitlement, organization_id), message=_("billing.entitlement_updated"))


@router.post("/organizations/{organization_id}/settlement/daily", auth=jwt_auth, tags=["结算"])
@billing_api_errors
def run_organization_daily_settlement(request, organization_id: str, data: DailySettlementIn):
    _check_organization_permission(request, organization_id, "owner")
    usage_date = data.usage_date or timezone.localdate()
    result = BillingSettlementService.aggregate_daily_usage(
        organization_id=organization_id,
        usage_date=usage_date,
        persist=True,
    )
    return success_response(data=result, message=_("billing.daily_aggregate_done"))


@router.post("/organizations/{organization_id}/invoices/generate", auth=jwt_auth, tags=["结算"])
@billing_api_errors
def generate_organization_invoice(request, organization_id: str, data: InvoiceGenerateIn):
    _check_organization_permission(request, organization_id, "owner")
    if data.month < 1 or data.month > 12:
        raise HttpError(400, _("billing.errors.invalid_month"))

    raise HttpError(410, "月度账单已改为只读消费对账单，当前阶段不再生成 BillingInvoice")


@router.get("/organizations/{organization_id}/invoices", auth=jwt_auth, tags=["结算"])
@billing_api_errors
def list_organization_invoices(request, organization_id: str, limit: int = 30, offset: int = 0, status: str = ""):
    _check_organization_permission(request, organization_id, "viewer")
    offset = max(0, offset)
    limit = max(1, min(int(limit or 30), 100))
    qs = BillingInvoice.objects.filter(organization_id=organization_id)
    if status:
        qs = qs.filter(status=status)
    invoices = [
        _serialize_invoice(invoice, include_lines=False)
        for invoice in qs.order_by("-period_start", "-created_at")[offset:offset + limit]
    ]
    return success_response(
        data={
            "organization_id": organization_id,
            "total": qs.count(),
            "invoices": invoices,
        },
        message=_("billing.invoice_list_success"),
    )


@router.get("/organizations/{organization_id}/invoices/{invoice_id}", auth=jwt_auth, tags=["结算"])
@billing_api_errors
def get_organization_invoice_detail(request, organization_id: str, invoice_id: str):
    _check_organization_permission(request, organization_id, "viewer")
    invoice = BillingInvoice.objects.filter(id=invoice_id, organization_id=organization_id).prefetch_related("lines").first()
    if not invoice:
        raise HttpError(404, _("billing.invoice_not_found"))
    return success_response(data=_serialize_invoice(invoice, include_lines=True), message=_("billing.invoice_detail_success"))


@router.post("/organizations/{organization_id}/invoices/{invoice_id}/collect", auth=jwt_auth, tags=["结算"])
@billing_api_errors
def collect_organization_invoice(request, organization_id: str, invoice_id: str, force: bool = False):
    _check_organization_permission(request, organization_id, "owner")
    invoice = BillingInvoice.objects.filter(id=invoice_id, organization_id=organization_id).first()
    if not invoice:
        raise HttpError(404, _("billing.invoice_not_found"))

    raise HttpError(410, "月度账单已改为只读消费对账单，当前阶段不支持 invoice 手动扣款")


@router.get("/organizations/{organization_id}/statements/monthly", auth=jwt_auth, tags=["结算"])
@billing_api_errors
def get_organization_monthly_statement(request, organization_id: str, month: str = ""):
    _check_organization_permission(request, organization_id, "viewer")
    try:
        statement = StatementService.get_statement_detail(organization_id=organization_id, month=month or None)
    except ValueError as exc:
        raise HttpError(400, str(exc))
    return success_response(data=statement, message="statement generated")


@router.get("/organizations/{organization_id}/reports/invoice-overview", auth=jwt_auth, tags=["报表"])
@billing_api_errors
def get_organization_invoice_overview(request, organization_id: str, months: int = 6):
    _check_organization_permission(request, organization_id, "viewer")
    months = max(1, min(int(months or 6), 24))

    today = timezone.localdate()
    start_month = date(today.year, today.month, 1)
    year = start_month.year
    month = start_month.month - (months - 1)
    while month <= 0:
        month += 12
        year -= 1
    window_start = date(year, month, 1)

    invoices = list(
        BillingInvoice.objects.filter(
            organization_id=organization_id,
            period_start__gte=window_start,
        ).order_by("period_start", "created_at")
    )
    if not invoices:
        return success_response(
            data={
                "organization_id": organization_id,
                "months": months,
                "window_start": window_start.isoformat(),
                "totals": {
                    "invoice_count": 0,
                    "total_amount": "0",
                    "paid_amount": "0",
                    "open_amount": "0",
                    "draft_amount": "0",
                    "collection_failures": 0,
                },
                "monthly_trend": [],
            },
            message=_("billing.invoice_overview_success"),
        )

    total_amount = Decimal("0")
    paid_amount = Decimal("0")
    open_amount = Decimal("0")
    draft_amount = Decimal("0")
    collection_failures = 0
    monthly: Dict[str, Dict[str, Decimal | int]] = {}

    for invoice in invoices:
        amount = safe_decimal(invoice.total_amount)
        total_amount += amount
        if invoice.status == "paid":
            paid_amount += amount
        elif invoice.status == "open":
            open_amount += amount
        elif invoice.status == "draft":
            draft_amount += amount

        collection_meta = (invoice.metadata or {}).get("collection") or {}
        if collection_meta.get("last_error"):
            collection_failures += 1

        month_key = invoice.period_start.strftime("%Y-%m")
        row = monthly.setdefault(
            month_key,
            {
                "period": month_key,
                "invoice_count": 0,
                "total_amount": Decimal("0"),
                "paid_amount": Decimal("0"),
                "open_amount": Decimal("0"),
            },
        )
        row["invoice_count"] = int(row["invoice_count"]) + 1
        row["total_amount"] = Decimal(str(row["total_amount"])) + amount
        if invoice.status == "paid":
            row["paid_amount"] = Decimal(str(row["paid_amount"])) + amount
        elif invoice.status == "open":
            row["open_amount"] = Decimal(str(row["open_amount"])) + amount

    monthly_trend = []
    for key in sorted(monthly.keys()):
        row = monthly[key]
        monthly_trend.append(
            {
                "period": row["period"],
                "invoice_count": int(row["invoice_count"]),
                "total_amount": str(safe_decimal(row["total_amount"])),
                "paid_amount": str(safe_decimal(row["paid_amount"])),
                "open_amount": str(safe_decimal(row["open_amount"])),
            }
        )

    return success_response(
        data={
            "organization_id": organization_id,
            "months": months,
            "window_start": window_start.isoformat(),
            "totals": {
                "invoice_count": len(invoices),
                "total_amount": str(safe_decimal(total_amount)),
                "paid_amount": str(safe_decimal(paid_amount)),
                "open_amount": str(safe_decimal(open_amount)),
                "draft_amount": str(safe_decimal(draft_amount)),
                "collection_failures": collection_failures,
            },
            "monthly_trend": monthly_trend,
        },
        message=_("billing.invoice_overview_success"),
    )


@router.get("/organizations/{organization_id}/usage-dashboard", auth=jwt_auth, tags=["用量分析"])
@billing_api_errors
def get_organization_usage_dashboard(request, organization_id: str, days: int = 30):
    """
    用量仪表盘：按计量项/模型/日期维度的消费分布。

    数据来源策略：
    - 历史天（非今日）：BillingUsageDaily 日聚合表（T+1，性能好）
    - 今日：BillingUsageEvent 原始事件实时聚合（确保当天消费可见）
    - 环比与趋势图统一使用自然月口径
    """
    _check_organization_permission(request, organization_id, "viewer")

    from .services.usage_dashboard_builder import build_organization_usage_dashboard_data

    return success_response(
        data=build_organization_usage_dashboard_data(organization_id, days=days),
        message=_("billing.usage_dashboard_success"),
    )


@router.get("/organizations/{organization_id}/member-usage", auth=jwt_auth, tags=["用量分析"])
@billing_api_errors
def get_organization_member_usage(request, organization_id: str, days: int = 30):
    """
    成员消费统计：按成员聚合消费量，含各计量项明细。
    """
    _check_organization_permission(request, organization_id, "viewer")

    from .services import aggregate_member_usage, build_member_list, build_user_info_map

    member_agg, meter_by_user, total_credits, period_days = aggregate_member_usage(
        organization_id, period_days=int(days or 30)
    )

    user_ids = [row["user_id"] for row in member_agg if row["user_id"]]
    user_info_map = build_user_info_map(user_ids)

    members = build_member_list(member_agg, meter_by_user, total_credits, user_info_map)

    return success_response(
        data={
            "organization_id": organization_id,
            "period_days": period_days,
            "total_credits": str(safe_decimal(total_credits)),
            "member_count": len(members),
            "members": members,
        },
        message=_("billing.member_usage_stats_success"),
    )


# ──────────────────────────────────────────────────────────
# 成员级费用管控 CRUD API
# ──────────────────────────────────────────────────────────


class LowBalanceConfigIn(Schema):
    warning_credits: Optional[Decimal] = None
    critical_credits: Optional[Decimal] = None
    email_enabled: Optional[bool] = None


def _low_balance_config_payload(organization_id: str, thresholds) -> dict:
    from .services.low_balance_alert_service import LowBalanceAlertService

    owner = LowBalanceAlertService.resolve_owner_contact(organization_id)
    return {
        "organization_id": organization_id,
        "warning_credits": str(thresholds.warning_credits),
        "critical_credits": str(thresholds.critical_credits),
        "email_enabled": thresholds.email_enabled,
        "owner_user_id": owner["owner_user_id"],
        "owner_has_email": owner["owner_has_email"],
        "owner_email_masked": owner["owner_email_masked"],
    }


@router.get("/organizations/{organization_id}/low-balance-config", auth=jwt_auth, tags=["低余额预警"])
@billing_api_errors
def get_low_balance_config(request, organization_id: str):
    """获取团队低余额预警阈值配置。"""
    _check_organization_permission(request, organization_id, "viewer")

    from .services.low_balance_alert_service import LowBalanceAlertService

    thresholds = LowBalanceAlertService.get_thresholds(organization_id)
    return success_response(
        data=_low_balance_config_payload(organization_id, thresholds),
        message=_("billing.low_balance_config_success"),
    )


@router.put("/organizations/{organization_id}/low-balance-config", auth=jwt_auth, tags=["低余额预警"])
@billing_api_errors
def update_low_balance_config(request, organization_id: str, data: LowBalanceConfigIn):
    """更新团队低余额预警阈值配置（管理员）。"""
    _check_organization_permission(request, organization_id, "owner")

    # 绝对点券值：仅要求非负 + 严重 < 预警，不设上限
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

    from .services.low_balance_alert_service import LowBalanceAlertService

    before = LowBalanceAlertService.get_thresholds(organization_id)
    thresholds = LowBalanceAlertService.set_thresholds(
        organization_id,
        warning_credits=data.warning_credits,
        critical_credits=data.critical_credits,
        email_enabled=data.email_enabled,
    )
    # 仅 warning/critical 绝对值真变时补检；同值保存或只改邮件不清去重、不重复通知
    if LowBalanceAlertService.did_credit_thresholds_change(before, thresholds):
        try:
            LowBalanceAlertService.recheck_after_threshold_change(organization_id)
        except Exception:
            logger.warning(
                "low-balance-config 保存后补检失败（配置已保存）: organization_id=%s",
                organization_id,
                exc_info=True,
            )
    return success_response(
        data=_low_balance_config_payload(organization_id, thresholds),
        message=_("billing.low_balance_config_updated"),
    )


class MemberBudgetPolicyUpsertIn(Schema):
    organization_id: str
    user_id: Optional[str] = None
    target_role: Optional[str] = None
    monthly_credits_limit: Optional[Decimal] = None
    daily_credits_limit: Optional[Decimal] = None
    max_model_tier: str = "enterprise"
    is_active: bool = True


class MemberBudgetExemptRolesPatchIn(Schema):
    organization_id: str
    exempt_roles: list[str]


def _serialize_member_budget_policy(policy: MemberLlmBudgetPolicy) -> Dict[str, Any]:
    """将策略模型序列化为 API 响应，哨兵值转为 None。"""
    return {
        "id": str(policy.id),
        "organization_id": policy.organization_id,
        "user_id": None if policy.user_id == MEMBER_BUDGET_SENTINEL else policy.user_id,
        "target_role": None if policy.target_role == MEMBER_BUDGET_SENTINEL else policy.target_role,
        "monthly_credits_limit": (
            str(safe_decimal(policy.monthly_credits_limit))
            if policy.monthly_credits_limit is not None else None
        ),
        "daily_credits_limit": (
            str(safe_decimal(policy.daily_credits_limit))
            if policy.daily_credits_limit is not None else None
        ),
        "max_model_tier": policy.max_model_tier,
        "is_active": policy.is_active,
        "created_at": policy.created_at.isoformat() if policy.created_at else None,
        "updated_at": policy.updated_at.isoformat() if policy.updated_at else None,
    }


def _resolve_effective_policy(
    user_id: str,
    user_role: str,
    personal_policies: Dict[str, MemberLlmBudgetPolicy],
    role_policies: Dict[str, MemberLlmBudgetPolicy],
    default_policy: Optional[MemberLlmBudgetPolicy],
) -> Optional[MemberLlmBudgetPolicy]:
    """三级继承解析：个人策略 > 角色策略 > 默认策略。

    批量场景专用（一次查所有策略，内存匹配）。不检查豁免角色——调用方自行处理。
    SYNC: 继承优先级必须与 MemberBudgetService.get_effective_policy 保持一致。
    """
    if user_id in personal_policies:
        return personal_policies[user_id]
    if user_role in role_policies:
        return role_policies[user_role]
    return default_policy


def _get_exempt_roles(organization_id: str) -> list:
    """从 OrganizationBillingPolicy.metadata 读取豁免角色列表。"""
    billing_policy = OrganizationBillingPolicy.objects.filter(organization_id=organization_id).first()
    if billing_policy and billing_policy.metadata:
        return billing_policy.metadata.get("member_budget_exempt_roles", [])
    return []


def _build_policy_index(
    policies,
) -> tuple:
    """将策略列表拆分为个人/角色/默认三级索引。"""
    personal: Dict[str, MemberLlmBudgetPolicy] = {}
    by_role: Dict[str, MemberLlmBudgetPolicy] = {}
    default = None
    for p in policies:
        if p.user_id != MEMBER_BUDGET_SENTINEL:
            personal[p.user_id] = p
        elif p.target_role != MEMBER_BUDGET_SENTINEL:
            by_role[p.target_role] = p
        else:
            default = p
    return personal, by_role, default


def _format_policy_entry(
    effective: Optional[MemberLlmBudgetPolicy],
    is_exempt: bool,
) -> Dict[str, Any]:
    """提取有效策略的限额字段，豁免角色返回不限。"""
    result: Dict[str, Any] = {
        "monthly_limit": None,
        "daily_limit": None,
        "max_model_tier": "enterprise",
        "policy_source": None,
    }
    if not effective or is_exempt:
        return result
    if effective.monthly_credits_limit is not None:
        result["monthly_limit"] = str(safe_decimal(effective.monthly_credits_limit))
    if effective.daily_credits_limit is not None:
        result["daily_limit"] = str(safe_decimal(effective.daily_credits_limit))
    result["max_model_tier"] = effective.max_model_tier
    if effective.user_id != MEMBER_BUDGET_SENTINEL:
        result["policy_source"] = "personal"
    elif effective.target_role != MEMBER_BUDGET_SENTINEL:
        result["policy_source"] = "role"
    else:
        result["policy_source"] = "default"
    return result


def _get_organization_admins(organization_id: str, limit: int = 3) -> list:
    """获取团队 owner 前 N 人（供"联系管理员"CTA 使用，缓存 300s）。

    两级模型（2026-06-10）：计费管理 owner-only，存量 admin 不再是有效联系对象。
    """
    from django.core.cache import cache as _admins_cache

    cache_key = f"billing:organization_admins:{organization_id}"
    cached = _admins_cache.get(cache_key)
    if cached is not None:
        return cached

    try:
        from apps.tabtinspace.models import OrganizationMember
        members = (
            OrganizationMember.objects.filter(
                organization_id=organization_id,
                role="owner",
            )
            .order_by(
                Case(When(role="owner", then=Value(0)), default=Value(1), output_field=IntegerField()),
                "created_at",
            )
            .values_list("user_id", "role")[:limit]
        )
        from .services import build_user_info_map
        uid_list = [str(uid) for uid, _ in members]
        info_map = build_user_info_map(uid_list)
        result = []
        for uid, role in members:
            uid_str = str(uid)
            info = info_map.get(uid_str, {})
            result.append({
                "user_id": uid_str,
                "display_name": info.get("display_name", uid_str[:8]),
                "role": role,
            })
        _admins_cache.set(cache_key, result, 300)
        return result
    except Exception:
        return []


@router.get("/member-budget-policies", auth=jwt_auth, tags=["成员费用管控"])
@billing_api_errors
def list_member_budget_policies(request, organization_id: str):
    """获取团队所有成员预算策略。"""
    _check_organization_permission(request, organization_id, "owner")
    policies = MemberLlmBudgetPolicy.objects.filter(
        organization_id=organization_id,
    ).order_by("-updated_at")
    return success_response(
        data=[_serialize_member_budget_policy(p) for p in policies],
        message=_("billing.member_budget_policies_success"),
    )


@router.put("/member-budget-policies", auth=jwt_auth, tags=["成员费用管控"])
@billing_api_errors
def upsert_member_budget_policy(request, data: MemberBudgetPolicyUpsertIn):
    """创建或更新成员预算策略（upsert 语义，按 organization+user+role 唯一键匹配）。"""
    _check_organization_permission(request, data.organization_id, "owner")

    if data.user_id and data.target_role:
        raise HttpError(400, "不能同时指定 user_id 和 target_role，个人策略和角色策略互斥")

    valid_roles = {r[0] for r in MemberLlmBudgetPolicy.ROLE_CHOICES}
    if data.target_role and data.target_role not in valid_roles:
        raise HttpError(400, f"无效的角色: {data.target_role}，可选值: {', '.join(sorted(valid_roles))}")

    valid_tiers = {t[0] for t in MemberLlmBudgetPolicy.MODEL_TIER_CHOICES}
    if data.max_model_tier not in valid_tiers:
        raise HttpError(400, f"无效的模型等级: {data.max_model_tier}")

    if data.monthly_credits_limit is not None and data.monthly_credits_limit < 0:
        raise HttpError(400, _("billing.errors.field_negative", field="monthly_credits_limit"))
    if data.daily_credits_limit is not None and data.daily_credits_limit < 0:
        raise HttpError(400, _("billing.errors.field_negative", field="daily_credits_limit"))

    if (
        data.daily_credits_limit is not None
        and data.monthly_credits_limit is not None
        and data.daily_credits_limit > 0
        and data.monthly_credits_limit > 0
        and data.daily_credits_limit > data.monthly_credits_limit
    ):
        raise HttpError(400, _("billing.daily_exceeds_monthly"))

    from .services.member_budget_service import MemberBudgetService

    policy = MemberBudgetService.upsert_policy(
        organization_id=data.organization_id,
        user_id=data.user_id,
        target_role=data.target_role,
        monthly_credits_limit=data.monthly_credits_limit,
        daily_credits_limit=data.daily_credits_limit,
        max_model_tier=data.max_model_tier,
        is_active=data.is_active,
    )
    return success_response(
        data=_serialize_member_budget_policy(policy),
        message=_("billing.member_budget_policy_saved"),
    )


@router.patch("/member-budget-exempt-roles", auth=jwt_auth, tags=["成员费用管控"])
@billing_api_errors
def patch_member_budget_exempt_roles(request, data: MemberBudgetExemptRolesPatchIn):
    """更新团队 metadata 中的成员预算豁免角色列表（管理员）。"""
    _check_organization_permission(request, data.organization_id, "owner")

    valid_roles = {r[0] for r in MemberLlmBudgetPolicy.ROLE_CHOICES}
    normalized: list[str] = []
    seen: set[str] = set()
    for role in data.exempt_roles:
        r = str(role or "").strip()
        if not r:
            raise HttpError(400, "exempt_roles 含空项")
        if r not in valid_roles:
            raise HttpError(400, f"无效的角色: {r}，可选: {', '.join(sorted(valid_roles))}")
        if r not in seen:
            seen.add(r)
            normalized.append(r)

    from django.db import transaction

    from apps.services.billing.services.member_budget_service import MemberBudgetService

    with transaction.atomic():
        policy = (
            OrganizationBillingPolicy.objects.select_for_update()
            .filter(organization_id=data.organization_id)
            .first()
        )
        md: Dict[str, Any] = dict(policy.metadata) if policy and policy.metadata else {}
        md["member_budget_exempt_roles"] = normalized
        if policy:
            policy.metadata = md
            policy.save(update_fields=["metadata", "updated_at"])
        else:
            OrganizationBillingPolicy.objects.create(
                organization_id=data.organization_id,
                metadata=md,
            )

        wt = data.organization_id

        def _on_commit():
            MemberBudgetService._invalidate_policy_caches(wt, MEMBER_BUDGET_SENTINEL)
            MemberBudgetService._publish_member_budget_resolved(
                wt, MEMBER_BUDGET_SENTINEL, action="exempt_roles_updated",
            )
            try:
                from apps.services.billing.ws_events import publish_billing_event
                publish_billing_event(wt, "member_budget_policy_changed", {
                    "action": "exempt_roles_updated",
                    "exempt_roles": normalized,
                })
            except Exception as _ws_exc:
                logger.warning("[MemberBudget] exempt_roles WS publish failed: %s", _ws_exc)

        transaction.on_commit(_on_commit)

    return success_response(
        data={
            "organization_id": data.organization_id,
            "exempt_roles": normalized,
        },
        message=_("billing.member_budget_exempt_roles_updated"),
    )


@router.delete("/member-budget-policies/{policy_id}", auth=jwt_auth, tags=["成员费用管控"])
@billing_api_errors
def delete_member_budget_policy(request, policy_id: str):
    """删除成员预算策略。"""
    policy = MemberLlmBudgetPolicy.objects.filter(id=policy_id).first()
    if not policy:
        raise HttpError(404, "策略不存在")
    _check_organization_permission(request, policy.organization_id, "owner")
    policy_data = _serialize_member_budget_policy(policy)
    from .services.member_budget_service import MemberBudgetService
    MemberBudgetService.delete_policy(str(policy.id))
    return success_response(data=policy_data, message=_("billing.member_budget_policy_deleted"))


@router.get("/member-usage-summary", auth=jwt_auth, tags=["成员费用管控"])
@billing_api_errors
def get_member_usage_summary(request, organization_id: str):
    """获取团队所有成员的用量摘要（含限额进度），仅管理员可用。"""
    _check_organization_permission(request, organization_id, "owner")

    from apps.services.billing.constants import BILLING_TZ
    now = timezone.now()
    today = now.astimezone(BILLING_TZ).date()
    month_start = today.replace(day=1)

    policies = list(MemberLlmBudgetPolicy.objects.filter(
        organization_id=organization_id, is_active=True,
    ))
    personal_policies, role_policies, default_policy = _build_policy_index(policies)
    exempt_roles = _get_exempt_roles(organization_id)

    monthly_counters = {
        c.user_id: c for c in MemberLlmUsageCounter.objects.filter(
            organization_id=organization_id, cycle_date=month_start, cycle_type="monthly",
        )
    }
    daily_counters = {
        c.user_id: c for c in MemberLlmUsageCounter.objects.filter(
            organization_id=organization_id, cycle_date=today, cycle_type="daily",
        )
    }

    from apps.tabtinspace.services import OrganizationService
    ws_service = OrganizationService(user=request.auth)
    try:
        members_qs, _total = ws_service.list_members(organization_id)
        member_items = list(members_qs)
    except Exception:
        member_items = []

    from .services import build_user_info_map
    user_ids = [str(m.user_id) for m in member_items]
    user_info_map = build_user_info_map(user_ids)

    summaries = []
    for m in member_items:
        uid = str(m.user_id)
        role = m.role
        is_exempt = role in exempt_roles

        effective = _resolve_effective_policy(
            uid, role, personal_policies, role_policies, default_policy,
        )
        policy_info = _format_policy_entry(effective, is_exempt)

        monthly_counter = monthly_counters.get(uid)
        daily_counter = daily_counters.get(uid)
        monthly_used = safe_decimal(monthly_counter.consumed_credits) if monthly_counter else Decimal("0")
        daily_used = safe_decimal(daily_counter.consumed_credits) if daily_counter else Decimal("0")

        info = user_info_map.get(uid, {})
        summaries.append({
            "user_id": uid,
            "display_name": info.get("display_name", uid[:8]),
            "avatar": info.get("avatar", ""),
            "role": role,
            "is_exempt": is_exempt,
            "monthly_used": str(monthly_used),
            "daily_used": str(daily_used),
            **policy_info,
        })

    return success_response(
        data={
            "organization_id": organization_id,
            "cycle_month": month_start.isoformat(),
            "today": today.isoformat(),
            "exempt_roles": exempt_roles,
            "member_count": len(summaries),
            "members": summaries,
        },
        message=_("billing.member_usage_summary_success"),
    )


@router.get("/my-usage", auth=jwt_auth, tags=["成员费用管控"])
@billing_api_errors
def get_my_usage(request, organization_id: str):
    """获取当前用户在指定团队的用量和限额。"""
    _check_organization_permission(request, organization_id, "viewer")

    user_id = str(request.auth.id)
    from apps.services.billing.constants import BILLING_TZ
    from apps.services.billing.services.member_budget_service import MemberBudgetService
    now = timezone.now()
    today = now.astimezone(BILLING_TZ).date()
    month_start = today.replace(day=1)

    user_role = MemberBudgetService.resolve_user_role(organization_id, user_id)
    if not user_role:
        user_role = "viewer"

    exempt_roles = MemberBudgetService._get_exempt_roles(organization_id)
    is_exempt = user_role in exempt_roles

    effective_policy = MemberBudgetService.get_effective_policy(
        organization_id, user_id, user_role=user_role,
    )

    monthly_counter = MemberLlmUsageCounter.objects.filter(
        organization_id=organization_id, user_id=user_id,
        cycle_date=month_start, cycle_type="monthly",
    ).first()
    daily_counter = MemberLlmUsageCounter.objects.filter(
        organization_id=organization_id, user_id=user_id,
        cycle_date=today, cycle_type="daily",
    ).first()

    monthly_used = safe_decimal(monthly_counter.consumed_credits) if monthly_counter else Decimal("0")
    daily_used = safe_decimal(daily_counter.consumed_credits) if daily_counter else Decimal("0")
    policy_info = _format_policy_entry(effective_policy, is_exempt)

    admins = _get_organization_admins(organization_id)

    return success_response(
        data={
            "organization_id": organization_id,
            "user_id": user_id,
            "role": user_role,
            "is_exempt": is_exempt,
            "cycle_month": month_start.isoformat(),
            "today": today.isoformat(),
            "monthly_used": str(monthly_used),
            "daily_used": str(daily_used),
            **policy_info,
            "admins": admins,
        },
        message=_("billing.my_usage_success"),
    )


# ──────────────────────────────────────────────────────────
# 批量成员预算策略 API（UX-1）
# ──────────────────────────────────────────────────────────


class BatchMemberBudgetItem(Schema):
    user_id: str
    monthly_credits_limit: Optional[Decimal] = None
    daily_credits_limit: Optional[Decimal] = None
    max_model_tier: str = "enterprise"
    is_active: bool = True


class BatchMemberBudgetIn(Schema):
    items: List[BatchMemberBudgetItem]


@router.post("/organizations/{organization_id}/member-budgets", auth=jwt_auth, tags=["成员费用管控"])
@billing_api_errors
def batch_set_member_budgets(request, organization_id: str, data: BatchMemberBudgetIn):
    """批量设置成员预算策略（owner/admin only）。"""
    _check_organization_permission(request, organization_id, "owner")

    if not data.items:
        raise HttpError(400, "items 不能为空")
    if len(data.items) > 100:
        raise HttpError(400, "单次批量操作最多 100 条")

    valid_tiers = {t[0] for t in MemberLlmBudgetPolicy.MODEL_TIER_CHOICES}
    for item in data.items:
        if item.max_model_tier not in valid_tiers:
            raise HttpError(400, f"无效的模型等级: {item.max_model_tier}")
        if item.monthly_credits_limit is not None and item.monthly_credits_limit < 0:
            raise HttpError(400, _("billing.errors.field_negative", field="monthly_credits_limit"))
        if item.daily_credits_limit is not None and item.daily_credits_limit < 0:
            raise HttpError(400, _("billing.errors.field_negative", field="daily_credits_limit"))
        if (
            item.daily_credits_limit is not None
            and item.monthly_credits_limit is not None
            and item.daily_credits_limit > 0
            and item.monthly_credits_limit > 0
            and item.daily_credits_limit > item.monthly_credits_limit
        ):
            raise HttpError(400, _("billing.daily_exceeds_monthly"))

    from django.db import transaction as _tx
    from .services.member_budget_service import MemberBudgetService

    results = []
    with _tx.atomic():
        for item in data.items:
            policy = MemberBudgetService.upsert_policy(
                organization_id=organization_id,
                user_id=item.user_id,
                monthly_credits_limit=item.monthly_credits_limit,
                daily_credits_limit=item.daily_credits_limit,
                max_model_tier=item.max_model_tier,
                is_active=item.is_active,
            )
            results.append(_serialize_member_budget_policy(policy))

    return success_response(
        data={"organization_id": organization_id, "count": len(results), "policies": results},
        message=_("billing.member_budget_policy_saved"),
    )


@router.delete("/organizations/{organization_id}/member-budgets/{user_id}", auth=jwt_auth, tags=["成员费用管控"])
@billing_api_errors
def delete_member_budget_by_user(request, organization_id: str, user_id: str):
    """删除指定成员的个人预算策略（回退到角色/默认策略）。"""
    _check_organization_permission(request, organization_id, "owner")

    policy = MemberLlmBudgetPolicy.objects.filter(
        organization_id=organization_id,
        user_id=user_id,
        target_role=MEMBER_BUDGET_SENTINEL,
    ).first()
    if not policy:
        raise HttpError(404, "该成员没有个人预算策略")

    policy_data = _serialize_member_budget_policy(policy)
    from .services.member_budget_service import MemberBudgetService
    MemberBudgetService.delete_policy(str(policy.id))
    return success_response(data=policy_data, message=_("billing.member_budget_policy_deleted"))


# ──────────────────────────────────────────────────────────
# 计费导出 API（PR 5 前端消费）
# ──────────────────────────────────────────────────────────


_EXPORT_MAX_DAYS = 90
_EXPORT_RATE_KEY_PREFIX = "billing:export_rate:"
_EXPORT_RATE_MAX = 5
_EXPORT_RATE_WINDOW = 3600


def _check_export_rate_limit(organization_id: str) -> None:
    """per-organization 每小时最多 _EXPORT_RATE_MAX 次导出。"""
    from django.core.cache import cache as _cache
    key = f"{_EXPORT_RATE_KEY_PREFIX}{organization_id}"
    count = _cache.get(key, 0)
    if count >= _EXPORT_RATE_MAX:
        raise HttpError(429, "导出频率超限，每小时最多 5 次")
    _cache.set(key, count + 1, _EXPORT_RATE_WINDOW)


def _get_organization_role(request, organization_id: str) -> str:
    """获取用户在团队中的角色。

    与 OrganizationService.check_organization_permission 保持一致：organization 的 owner
    即使没有 OrganizationMember 行也应解析为 'owner'，否则会出现「能过 viewer 权限校验
    却拿不到角色」从而被导出端点 403 拒绝的矛盾。
    """
    user_id = str(request.auth.id)
    try:
        from apps.tabtinspace.models import Organization, OrganizationMember

        owner_id = (
            Organization.objects.filter(id=organization_id)
            .values_list("owner_id", flat=True)
            .first()
        )
        if owner_id is not None and str(owner_id) == user_id:
            return "owner"

        role = (
            OrganizationMember.objects.filter(
                organization_id=organization_id,
                user_id=user_id,
            )
            .values_list("role", flat=True)
            .first()
        )
        return role or ""
    except Exception:
        return ""


def _export_csv_rows(events_qs, user_info_map: Dict[str, Dict]):
    """.. deprecated:: 已废弃，请使用 BillingExportService.generate_csv_rows()。"""
    import warnings
    warnings.warn(
        "_export_csv_rows is deprecated, use BillingExportService.generate_csv_rows() instead",
        DeprecationWarning,
        stacklevel=2,
    )
    buf = io.StringIO()
    writer = csv.writer(buf)
    header = ["date", "user_id", "user_name", "model", "tokens", "credits"]
    writer.writerow(header)
    buf.seek(0)
    yield buf.read()
    buf.truncate(0)
    buf.seek(0)

    for event in events_qs.iterator(chunk_size=500):
        user_info = user_info_map.get(event.user_id, {})
        display_name = user_info.get("display_name", event.user_id[:8] if event.user_id else "")
        writer.writerow([
            event.occurred_at.strftime("%Y-%m-%d %H:%M"),
            event.user_id,
            display_name,
            event.model_name or "",
            str(event.quantity),
            str(event.amount),
        ])
        buf.seek(0)
        yield buf.read()
        buf.truncate(0)
        buf.seek(0)


@router.get("/organizations/{organization_id}/billing/export", auth=jwt_auth, tags=["报表导出"])
@billing_api_errors
def export_billing_report(
    request,
    organization_id: str,
    start_date: str = "",
    end_date: str = "",
    user_id: Optional[str] = None,
    meter_key: Optional[str] = None,
    biz_type: Optional[str] = None,
    scene_key: Optional[str] = None,
    schema: Optional[str] = None,
    # 避免参数名 timezone 遮蔽 django.utils.timezone
    client_timezone: Optional[str] = Query(None, alias="timezone"),
):
    """导出计费报表（CSV 流式输出，内存 O(1)）。

    权限：owner/admin 全量，editor 仅自己。
    限制：日期范围最大 90 天，per-organization 每小时最多 5 次。

    schema:
      - audit（默认）：机读全量列，含 user_id / task_name，供成员用量与审计
      - ledger：兼容旧客户端的 LLM 账本中文窄列，须显式传入
      - llm_usage：当前 LLM 场景列表中文窄列，须显式传入

    timezone (query):
      - IANA 名（如 America/Los_Angeles）；LLM 窄列时间列按此时区显示，与 Electron
        Intl.DateTimeFormat 系统时区对齐。缺省回落 Django TIME_ZONE。
    """
    _check_organization_permission(request, organization_id, "viewer")
    role = _get_organization_role(request, organization_id)
    request_user_id = str(request.auth.id)

    if role not in ("owner", "admin", "editor"):
        raise HttpError(403, "无导出权限")

    if not start_date or not end_date:
        end_dt = timezone.localdate()
        start_dt = end_dt - timedelta(days=30)
    else:
        try:
            start_dt = date.fromisoformat(start_date)
            end_dt = date.fromisoformat(end_date)
        except ValueError:
            raise HttpError(400, "日期格式无效，需 YYYY-MM-DD")

    if start_dt > end_dt:
        raise HttpError(400, "start_date 不能晚于 end_date")
    if (end_dt - start_dt).days > _EXPORT_MAX_DAYS:
        raise HttpError(400, f"日期范围最大 {_EXPORT_MAX_DAYS} 天")

    from .services.export_service import (
        BillingExportService,
        normalize_export_schema,
        resolve_export_timezone,
    )

    export_user_id = request_user_id if role == "editor" else (user_id.strip() if user_id else None)
    export_meter_key = meter_key.strip() if meter_key else None
    export_biz_type = biz_type.strip() if biz_type else None
    export_scene_key = scene_key.strip() if scene_key else None
    # 先校验 schema / timezone 等不依赖导出的输入，避免非法请求消耗组织共享配额
    try:
        export_schema = normalize_export_schema(schema)
    except ValueError:
        raise HttpError(400, "schema 无效，仅支持 audit / ledger / llm_usage")
    try:
        export_display_tz = resolve_export_timezone(client_timezone)
    except ValueError:
        raise HttpError(400, "timezone 无效，需 IANA 时区名（如 Asia/Shanghai）")

    _check_export_rate_limit(organization_id)

    filename = f"billing_{organization_id[:8]}_{start_dt}_{end_dt}.csv"
    response = StreamingHttpResponse(
        BillingExportService.generate_csv_rows(
            organization_id=organization_id,
            start_date=start_dt,
            end_date=end_dt,
            user_id=export_user_id,
            meter_key=export_meter_key,
            biz_type=export_biz_type,
            scene_key=export_scene_key,
            schema=export_schema,
            display_timezone=export_display_tz,
        ),
        content_type="text/csv; charset=utf-8",
    )
    response["Content-Disposition"] = f'attachment; filename="{filename}"'
    # 避免反向代理 / 中间层整包缓冲，让客户端尽早收到表头并重置读超时。
    response["X-Accel-Buffering"] = "no"
    response["Cache-Control"] = "no-store"
    return response
