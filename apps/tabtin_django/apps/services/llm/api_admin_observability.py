"""LLM 管理员 API — 可观测性（审计日志、用量统计、预算、告警、CSV 导出）。"""

from typing import Optional, Any
import logging
from datetime import datetime, timedelta, timezone as dt_timezone
from decimal import Decimal
import csv
import io

from django.db.models import Q, Count, Sum, Avg, Max
from django.db.models.functions import TruncMinute, TruncHour, TruncDate
from django.db.utils import OperationalError, ProgrammingError
from django.utils import timezone
from django.http import HttpResponse, StreamingHttpResponse
from ninja import Router
from ninja.errors import HttpError

from apps.i18n import _
from apps.i18n.response import success_response, error_response_with_status
from apps.users.auth.permissions import SuperuserAuth
from apps.services.billing.models import OrganizationLlmMonthlyBudget, OrganizationBillingPolicy
from apps.tabtinspace.models import Organization

from .api_common import envelope_errors
from .models import (
    LLMProvider,
    LLMModel,
    LLMAdminAuditLog,
    LLMUsageFact,
)
from apps.services.billing.models import BillingBudgetPolicy
from .schemas import AdminUsageBudgetPolicyUpdateRequest
from .api_admin_utils import (
    _serialize_audit_log,
    _record_admin_audit,
    _serialize_provider,
    _serialize_model,
    _parse_iso_datetime,
    _resolve_usage_time_window,
    _build_usage_fact_queryset,
    _calculate_percentile,
    _safe_float,
    _safe_int,
    _safe_decimal,
    _normalize_month_start,
    _next_month_start,
    _resolve_budget_status,
    _serialize_usage_budget_policy,
)

logger = logging.getLogger(__name__)

router = Router()


@router.get("/admin/organizations", auth=SuperuserAuth(), tags=["管理员配置"])
@envelope_errors
def admin_list_organizations(
    request,
    keyword: Optional[str] = None,
    limit: int = 200,
):

    limit_value = max(1, min(limit, 500))
    query = Organization.objects.all().order_by("-updated_at")

    normalized_keyword = (keyword or "").strip()
    if normalized_keyword:
        query = query.filter(name__icontains=normalized_keyword)

    organizations = list(query[:limit_value])
    organization_items = []
    for organization in organizations:
        settings = organization.settings or {}
        organization_items.append({
            "id": str(organization.id),
            "name": organization.name,
            "owner_id": str(organization.owner_id),
            "is_default": organization.is_default,
            "default_model_id": settings.get("llm_default_model_id"),
            "created_at": organization.created_at.isoformat(),
            "updated_at": organization.updated_at.isoformat(),
        })

    return success_response(
        data={
            "organizations": organization_items,
            "total": query.count(),
            "returned": len(organization_items),
        },
        message=_("llm.organization_list_success"),
    )

@router.get("/admin/audit-logs", auth=SuperuserAuth(), tags=["管理员配置"])
@envelope_errors
def admin_list_audit_logs(
    request,
    action: Optional[str] = None,
    target_type: Optional[str] = None,
    target_id: Optional[str] = None,
    organization_id: Optional[str] = None,
    provider_id: Optional[str] = None,
    model_id: Optional[str] = None,
    operator_id: Optional[str] = None,
    keyword: Optional[str] = None,
    page: int = 1,
    page_size: int = 50,
):

    normalized_page = max(1, page)
    normalized_page_size = max(1, min(page_size, 200))
    offset = (normalized_page - 1) * normalized_page_size

    query = LLMAdminAuditLog.objects.all().order_by("-created_at")
    if action:
        query = query.filter(action=action)
    if target_type:
        query = query.filter(target_type=target_type)
    if target_id:
        query = query.filter(target_id=target_id)
    if organization_id:
        query = query.filter(organization_id=organization_id)
    if provider_id:
        query = query.filter(provider_id=provider_id)
    if model_id:
        query = query.filter(model_id=model_id)
    if operator_id:
        query = query.filter(operator_id=operator_id)

    normalized_keyword = (keyword or "").strip()
    if normalized_keyword:
        query = query.filter(
            Q(action__icontains=normalized_keyword)
            | Q(target_type__icontains=normalized_keyword)
            | Q(target_id__icontains=normalized_keyword)
            | Q(operator_username__icontains=normalized_keyword)
            | Q(operator_id__icontains=normalized_keyword)
            | Q(organization_id__icontains=normalized_keyword)
            | Q(provider_id__icontains=normalized_keyword)
            | Q(model_id__icontains=normalized_keyword)
        )

    try:
        total = query.count()
        logs = list(query[offset: offset + normalized_page_size])
    except (ProgrammingError, OperationalError) as exc:
        # 兼容历史环境：审计表未迁移时降级为空列表，避免管理页整体 500。
        logger.warning("[LLM Admin] audit log table unavailable, fallback empty list: %s", exc)
        return success_response(
            data={
                "logs": [],
                "total": 0,
                "page": normalized_page,
                "page_size": normalized_page_size,
                "total_pages": 0,
                "degraded": True,
            },
            message=_("llm.audit_table_not_ready"),
        )

    return success_response(
        data={
            "logs": [_serialize_audit_log(log) for log in logs],
            "total": total,
            "page": normalized_page,
            "page_size": normalized_page_size,
            "total_pages": (total + normalized_page_size - 1) // normalized_page_size,
        },
        message=_("llm.audit_log_success"),
    )

@router.get("/admin/usage/overview", auth=SuperuserAuth(), tags=["用量统计"])
@envelope_errors
def admin_usage_overview(
    request,
    start_time: Optional[str] = None,
    end_time: Optional[str] = None,
    scope: Optional[str] = "all",
    organization_id: Optional[str] = None,
    user_id: Optional[str] = None,
    provider_id: Optional[str] = None,
    model_id: Optional[str] = None,
    scene_key: Optional[str] = None,
    capability_domain: Optional[str] = None,
    cost_status: Optional[str] = None,
    effective_provider_scope: Optional[str] = None,
):

    start_at, end_at = _resolve_usage_time_window(start_time, end_time)
    try:
        query = _build_usage_fact_queryset(
            start_at=start_at,
            end_at=end_at,
            scope=scope,
            organization_id=organization_id,
            user_id=user_id,
            provider_id=provider_id,
            model_id=model_id,
            scene_key=scene_key,
            capability_domain=capability_domain,
            cost_status=cost_status,
            effective_provider_scope=effective_provider_scope,
        )
        aggregated = query.aggregate(
            total_requests=Count("id"),
            completed_requests=Count("id", filter=Q(status="completed")),
            failed_requests=Count("id", filter=Q(status="failed")),
            total_input_tokens=Sum("input_tokens"),
            total_output_tokens=Sum("output_tokens"),
            total_tokens=Sum("total_tokens"),
            total_cache_read_input_tokens=Sum("cache_read_input_tokens"),
            total_cache_creation_input_tokens=Sum("cache_creation_input_tokens"),
            total_cost=Sum("total_cost"),
            avg_latency_ms=Avg("latency_ms"),
        )
        _LATENCY_SAMPLE_LIMIT = 50000
        latency_values = list(
            query.exclude(latency_ms__isnull=True).values_list("latency_ms", flat=True)[:_LATENCY_SAMPLE_LIMIT]
        )
        latency_sample_truncated = len(latency_values) >= _LATENCY_SAMPLE_LIMIT
    except (ProgrammingError, OperationalError) as exc:
        logger.warning("[LLM Admin] usage fact table unavailable, fallback empty overview: %s", exc)
        return success_response(
            data={
                "time_window": {
                    "start_time": start_at.isoformat(),
                    "end_time": end_at.isoformat(),
                },
                "overview": {
                    "total_requests": 0,
                    "completed_requests": 0,
                    "failed_requests": 0,
                    "success_rate": 0,
                    "error_rate": 0,
                    "total_input_tokens": 0,
                    "total_output_tokens": 0,
                    "total_tokens": 0,
                    "total_cache_read_input_tokens": 0,
                    "total_cache_creation_input_tokens": 0,
                    "cache_hit_rate": 0,
                    "total_cost": 0.0,
                    "avg_latency_ms": 0.0,
                    "p95_latency_ms": 0.0,
                    "p99_latency_ms": 0.0,
                },
                "degraded": True,
            },
            message=_("llm.usage_table_not_ready"),
        )

    total_requests = _safe_int(aggregated.get("total_requests"))
    completed_requests = _safe_int(aggregated.get("completed_requests"))
    failed_requests = _safe_int(aggregated.get("failed_requests"))
    total_input_tokens = _safe_int(aggregated.get("total_input_tokens"))
    total_output_tokens = _safe_int(aggregated.get("total_output_tokens"))
    total_cache_read_input_tokens = _safe_int(aggregated.get("total_cache_read_input_tokens"))
    total_cache_creation_input_tokens = _safe_int(aggregated.get("total_cache_creation_input_tokens"))
    denominator = completed_requests + failed_requests
    success_rate = round((completed_requests / denominator) * 100, 2) if denominator > 0 else 0
    error_rate = round((failed_requests / denominator) * 100, 2) if denominator > 0 else 0
    cache_hit_rate = round((total_cache_read_input_tokens / total_input_tokens) * 100, 2) if total_input_tokens > 0 else 0

    overview_data = {
        "time_window": {
            "start_time": start_at.isoformat(),
            "end_time": end_at.isoformat(),
        },
        "overview": {
            "total_requests": total_requests,
            "completed_requests": completed_requests,
            "failed_requests": failed_requests,
            "success_rate": success_rate,
            "error_rate": error_rate,
            "total_input_tokens": total_input_tokens,
            "total_output_tokens": total_output_tokens,
            "total_tokens": _safe_int(aggregated.get("total_tokens")),
            "total_cache_read_input_tokens": total_cache_read_input_tokens,
            "total_cache_creation_input_tokens": total_cache_creation_input_tokens,
            "cache_hit_rate": cache_hit_rate,
            "total_cost": round(_safe_float(aggregated.get("total_cost")), 6),
            "avg_latency_ms": round(_safe_float(aggregated.get("avg_latency_ms")), 2),
            "p95_latency_ms": round(_calculate_percentile(latency_values, 95), 2),
            "p99_latency_ms": round(_calculate_percentile(latency_values, 99), 2),
        },
        "latency_sample": {
            "size": len(latency_values),
            "limit": _LATENCY_SAMPLE_LIMIT,
            "truncated": latency_sample_truncated,
        },
    }

    return success_response(
        data=overview_data,
        message=_("llm.usage_overview_success"),
    )

@router.get("/admin/usage/budget/overview", auth=SuperuserAuth(), tags=["用量统计"])
@envelope_errors
def admin_usage_budget_overview(
    request,
    organization_id: Optional[str] = None,
    month: Optional[str] = None,
):

    month_start = _normalize_month_start(month)
    month_end = _next_month_start(month_start)
    cycle_month = month_start.date()

    def _degraded_organization_response():
        return success_response(
            data={
                "scope": "organization",
                "month": month_start.strftime("%Y-%m"),
                "organization_id": organization_id,
                "summary": {
                    "included_credits": 0.0,
                    "consumed_credits": 0.0,
                    "overflow_credits": 0.0,
                    "remaining_credits": 0.0,
                    "usage_cost": 0.0,
                    "utilization_percent": 0.0,
                    "status": "no_budget",
                    "billing_mode": "quota_only",
                },
                "policy": _serialize_usage_budget_policy(None),
                "degraded": True,
            },
            message=_("llm.budget_overview_degraded"),
        )

    def _degraded_global_response():
        return success_response(
            data={
                "scope": "global",
                "month": month_start.strftime("%Y-%m"),
                "summary": {
                    "organization_count": 0,
                    "included_credits": 0.0,
                    "consumed_credits": 0.0,
                    "overflow_credits": 0.0,
                    "remaining_credits": 0.0,
                    "usage_cost": 0.0,
                    "utilization_percent": 0.0,
                },
                "alerts": [],
                "degraded": True,
            },
            message=_("llm.budget_overview_degraded"),
        )

    try:
        usage_query = LLMUsageFact.objects.filter(
            occurred_at__gte=month_start,
            occurred_at__lt=month_end,
        )
    except (OperationalError, ProgrammingError) as exc:
        logger.warning("[LLM Admin] usage budget overview fallback due to unavailable usage table: %s", exc)
        return _degraded_organization_response() if organization_id else _degraded_global_response()

    if organization_id:
        try:
            budget = OrganizationLlmMonthlyBudget.objects.filter(
                organization_id=organization_id,
                cycle_month=cycle_month,
            ).first()
            policy = BillingBudgetPolicy.objects.filter(organization_id=organization_id).first()
            billing_policy = OrganizationBillingPolicy.objects.filter(organization_id=organization_id).first()

            included = _safe_decimal(getattr(budget, "included_credits", 0))
            consumed = _safe_decimal(getattr(budget, "consumed_credits", 0))
            overflow = _safe_decimal(getattr(budget, "overflow_credits", 0))
            remaining = max(Decimal("0"), included - consumed)
            usage_cost = _safe_decimal(
                usage_query.filter(organization_id=organization_id).aggregate(total=Sum("total_cost")).get("total")
            )

            policy_payload = _serialize_usage_budget_policy(policy)
            warning_threshold = _safe_decimal(policy_payload["warning_threshold_percent"])
            critical_threshold = _safe_decimal(policy_payload["critical_threshold_percent"])
            utilization_percent = Decimal("0")
            if included > 0:
                utilization_percent = (consumed / included * Decimal("100")).quantize(Decimal("0.01"))

            status = _resolve_budget_status(
                included_credits=included,
                utilization_percent=utilization_percent,
                warning_threshold_percent=warning_threshold,
                critical_threshold_percent=critical_threshold,
                policy_active=bool(policy_payload["is_active"]),
            )

            return success_response(
                data={
                    "scope": "organization",
                    "month": month_start.strftime("%Y-%m"),
                    "organization_id": organization_id,
                    "summary": {
                        "included_credits": float(included),
                        "consumed_credits": float(consumed),
                        "overflow_credits": float(overflow),
                        "remaining_credits": float(remaining),
                        "usage_cost": float(usage_cost),
                        "utilization_percent": float(utilization_percent),
                        "status": status,
                        "billing_mode": getattr(billing_policy, "llm_billing_mode", "quota_only"),
                    },
                    "policy": policy_payload,
                },
                message=_("llm.budget_overview_success"),
            )
        except (OperationalError, ProgrammingError) as exc:
            logger.warning("[LLM Admin] usage budget organization fallback due to unavailable table: %s", exc)
            return _degraded_organization_response()

    try:
        budgets_qs = OrganizationLlmMonthlyBudget.objects.filter(cycle_month=cycle_month)
        budget_agg = budgets_qs.aggregate(
            organization_count=Count("organization_id", distinct=True),
            included_credits=Sum("included_credits"),
            consumed_credits=Sum("consumed_credits"),
            overflow_credits=Sum("overflow_credits"),
        )

        included_total = _safe_decimal(budget_agg.get("included_credits"))
        consumed_total = _safe_decimal(budget_agg.get("consumed_credits"))
        overflow_total = _safe_decimal(budget_agg.get("overflow_credits"))
        remaining_total = max(Decimal("0"), included_total - consumed_total)
        usage_cost_total = _safe_decimal(usage_query.aggregate(total=Sum("total_cost")).get("total"))
        utilization_total = Decimal("0")
        if included_total > 0:
            utilization_total = (consumed_total / included_total * Decimal("100")).quantize(Decimal("0.01"))

        budget_rows = list(
            budgets_qs.values("organization_id", "included_credits", "consumed_credits", "overflow_credits")
        )
        organization_ids = [row["organization_id"] for row in budget_rows if row.get("organization_id")]
        policy_map = {
            item.organization_id: item
            for item in BillingBudgetPolicy.objects.filter(organization_id__in=organization_ids)
        }

        alerts = []
        for row in budget_rows:
            ws_id = row.get("organization_id") or ""
            included = _safe_decimal(row.get("included_credits"))
            consumed = _safe_decimal(row.get("consumed_credits"))
            overflow = _safe_decimal(row.get("overflow_credits"))
            utilization = Decimal("0")
            if included > 0:
                utilization = (consumed / included * Decimal("100")).quantize(Decimal("0.01"))

            policy = policy_map.get(ws_id)
            policy_payload = _serialize_usage_budget_policy(policy)
            status = _resolve_budget_status(
                included_credits=included,
                utilization_percent=utilization,
                warning_threshold_percent=_safe_decimal(policy_payload["warning_threshold_percent"]),
                critical_threshold_percent=_safe_decimal(policy_payload["critical_threshold_percent"]),
                policy_active=bool(policy_payload["is_active"]),
            )
            if status in {"warning", "critical"}:
                alerts.append(
                    {
                        "organization_id": ws_id,
                        "status": status,
                        "utilization_percent": float(utilization),
                        "included_credits": float(included),
                        "consumed_credits": float(consumed),
                        "overflow_credits": float(overflow),
                        "warning_threshold_percent": float(policy_payload["warning_threshold_percent"]),
                        "critical_threshold_percent": float(policy_payload["critical_threshold_percent"]),
                    }
                )

        alerts.sort(
            key=lambda item: (
                0 if item["status"] == "critical" else 1,
                -item["utilization_percent"],
            )
        )

        return success_response(
            data={
                "scope": "global",
                "month": month_start.strftime("%Y-%m"),
                "summary": {
                    "organization_count": _safe_int(budget_agg.get("organization_count")),
                    "included_credits": float(included_total),
                    "consumed_credits": float(consumed_total),
                    "overflow_credits": float(overflow_total),
                    "remaining_credits": float(remaining_total),
                    "usage_cost": float(usage_cost_total),
                    "utilization_percent": float(utilization_total),
                },
                "alerts": alerts[:30],
            },
            message=_("llm.budget_overview_success"),
        )
    except (OperationalError, ProgrammingError) as exc:
        logger.warning("[LLM Admin] usage budget global fallback due to unavailable table: %s", exc)
        return _degraded_global_response()

@router.put("/admin/usage/budget/policy", auth=SuperuserAuth(), tags=["用量统计"])
@envelope_errors
def admin_update_usage_budget_policy(
    request,
    payload: AdminUsageBudgetPolicyUpdateRequest,
):

    organization_id = (payload.organization_id or "").strip()
    if not organization_id:
        return error_response_with_status("BAD_REQUEST", message="organization_id 不能为空", status_code=400)

    existing = BillingBudgetPolicy.objects.filter(organization_id=organization_id).first()
    before_snapshot = {
        "organization_id": organization_id,
        **_serialize_usage_budget_policy(existing),
    }

    warning_threshold = _safe_decimal(
        payload.warning_threshold_percent
        if payload.warning_threshold_percent is not None
        else getattr(existing, "warning_threshold_percent", Decimal("80"))
    )
    critical_threshold = _safe_decimal(
        payload.critical_threshold_percent
        if payload.critical_threshold_percent is not None
        else getattr(existing, "critical_threshold_percent", Decimal("100"))
    )
    if critical_threshold < warning_threshold:
        return error_response_with_status("BAD_REQUEST", message="critical_threshold_percent 不能小于 warning_threshold_percent", status_code=400)

    is_active = (
        bool(payload.is_active)
        if payload.is_active is not None
        else (existing.is_active if existing else True)
    )

    policy, _created = BillingBudgetPolicy.objects.update_or_create(
        organization_id=organization_id,
        defaults={
            "warning_threshold_percent": warning_threshold,
            "critical_threshold_percent": critical_threshold,
            "is_active": is_active,
        },
    )

    after_snapshot = {
        "organization_id": organization_id,
        **_serialize_usage_budget_policy(policy),
    }
    _record_admin_audit(
        request,
        action="usage.budget.policy.update",
        target_type="usage_budget_policy",
        target_id=str(policy.id),
        organization_id=organization_id,
        before_data=before_snapshot,
        after_data=after_snapshot,
    )

    return success_response(
        data={
            "organization_id": organization_id,
            "policy": after_snapshot,
        },
        message=_("llm.budget_threshold_updated"),
    )

@router.get("/admin/usage/alerts", auth=SuperuserAuth(), tags=["用量统计"])
@envelope_errors
def admin_usage_alerts(
    request,
    start_time: Optional[str] = None,
    end_time: Optional[str] = None,
    scope: Optional[str] = "all",
    organization_id: Optional[str] = None,
    user_id: Optional[str] = None,
    provider_id: Optional[str] = None,
    model_id: Optional[str] = None,
    scene_key: Optional[str] = None,
    capability_domain: Optional[str] = None,
    cost_status: Optional[str] = None,
    effective_provider_scope: Optional[str] = None,
    success_rate_threshold: float = 90.0,
    p95_latency_threshold_ms: int = 5000,
    provider_failure_threshold: int = 3,
    min_requests: int = 20,
    limit: int = 50,
):

    start_at, end_at = _resolve_usage_time_window(start_time, end_time)
    normalized_scope = (scope or "all").strip().lower() or "all"
    normalized_limit = max(1, min(limit, 200))
    normalized_min_requests = max(1, min(min_requests, 5000))
    normalized_success_threshold = max(0.0, min(float(success_rate_threshold), 100.0))
    normalized_p95_threshold = max(100, min(int(p95_latency_threshold_ms), 120000))
    normalized_failure_threshold = max(1, min(int(provider_failure_threshold), 100))

    try:
        usage_query = _build_usage_fact_queryset(
            start_at=start_at,
            end_at=end_at,
            scope=normalized_scope,
            organization_id=organization_id,
            user_id=user_id,
            provider_id=provider_id,
            model_id=model_id,
            scene_key=scene_key,
            capability_domain=capability_domain,
            cost_status=cost_status,
            effective_provider_scope=effective_provider_scope,
        )
        provider_rows = list(
            usage_query.values("provider_id", "provider__display_name", "provider_key").annotate(
                total_requests=Count("id"),
                completed_requests=Count("id", filter=Q(status="completed")),
                failed_requests=Count("id", filter=Q(status="failed")),
            )
        )
        latency_rows = list(
            usage_query.filter(latency_ms__isnull=False).values(
                "provider_id",
                "provider__display_name",
                "provider_key",
                "latency_ms",
            )
        )
    except (OperationalError, ProgrammingError) as exc:
        logger.warning("[LLM Admin] usage alerts fallback empty due to unavailable table: %s", exc)
        return success_response(
            data={
                "time_window": {
                    "start_time": start_at.isoformat(),
                    "end_time": end_at.isoformat(),
                },
                "thresholds": {
                    "success_rate_threshold": normalized_success_threshold,
                    "p95_latency_threshold_ms": normalized_p95_threshold,
                    "provider_failure_threshold": normalized_failure_threshold,
                    "min_requests": normalized_min_requests,
                },
                "summary": {
                    "total_alerts": 0,
                    "critical_alerts": 0,
                    "warning_alerts": 0,
                },
                "alerts": [],
                "degraded": True,
            },
            message=_("llm.usage_alert_degraded"),
        )

    alerts: list[dict] = []

    for row in provider_rows:
        total_requests = _safe_int(row.get("total_requests"))
        completed_requests = _safe_int(row.get("completed_requests"))
        failed_requests = _safe_int(row.get("failed_requests"))
        denominator = completed_requests + failed_requests
        if denominator < normalized_min_requests:
            continue
        success_rate = round((completed_requests / denominator) * 100, 2) if denominator > 0 else 0.0
        if success_rate >= normalized_success_threshold:
            continue

        provider_uuid = row.get("provider_id")
        provider_resolved_id = str(provider_uuid) if provider_uuid else None
        provider_display_name = (
            str(row.get("provider__display_name") or "")
            or str(row.get("provider_key") or "")
            or provider_resolved_id
            or "未知渠道"
        )
        severity = "critical" if success_rate <= max(0.0, normalized_success_threshold - 20.0) else "warning"
        alerts.append(
            {
                "alert_type": "success_rate",
                "severity": severity,
                "provider_id": provider_resolved_id,
                "provider_display_name": provider_display_name,
                "organization_id": organization_id or None,
                "metric_name": "success_rate",
                "metric_value": success_rate,
                "threshold_value": normalized_success_threshold,
                "message": f"成功率 {success_rate:.2f}% 低于阈值 {normalized_success_threshold:.2f}%",
                "context": {
                    "total_requests": total_requests,
                    "completed_requests": completed_requests,
                    "failed_requests": failed_requests,
                },
                "_score": max(0.0, normalized_success_threshold - success_rate),
            }
        )

    latency_map: dict[str, dict] = {}
    for row in latency_rows:
        provider_uuid = row.get("provider_id")
        provider_resolved_id = str(provider_uuid) if provider_uuid else ""
        entry = latency_map.setdefault(
            provider_resolved_id,
            {
                "provider_id": provider_resolved_id or None,
                "provider_display_name": (
                    str(row.get("provider__display_name") or "")
                    or str(row.get("provider_key") or "")
                    or provider_resolved_id
                    or "未知渠道"
                ),
                "latencies": [],
            },
        )
        latency_value = _safe_int(row.get("latency_ms"))
        if latency_value > 0:
            entry["latencies"].append(latency_value)

    for item in latency_map.values():
        latencies = item.get("latencies") or []
        if len(latencies) < normalized_min_requests:
            continue
        p95_latency = round(_calculate_percentile(latencies, 95), 2)
        if p95_latency <= normalized_p95_threshold:
            continue

        severity = "critical" if p95_latency >= normalized_p95_threshold * 1.5 else "warning"
        alerts.append(
            {
                "alert_type": "latency_p95",
                "severity": severity,
                "provider_id": item.get("provider_id"),
                "provider_display_name": item.get("provider_display_name"),
                "organization_id": organization_id or None,
                "metric_name": "latency_ms_p95",
                "metric_value": p95_latency,
                "threshold_value": float(normalized_p95_threshold),
                "message": f"P95 延迟 {p95_latency:.2f}ms 高于阈值 {normalized_p95_threshold}ms",
                "context": {
                    "sample_size": len(latencies),
                },
                "_score": max(0.0, p95_latency - normalized_p95_threshold),
            }
        )

    try:
        # v0.1：is_active 字段已删；只对启用路由的 provider 触发健康告警。
        provider_query = LLMProvider.objects.filter(routing_enabled=True)
        if provider_id:
            provider_query = provider_query.filter(id=provider_id)
        if normalized_scope == "global":
            provider_query = provider_query.filter(scope="global")
        elif normalized_scope == "organization":
            if organization_id:
                provider_query = provider_query.filter(Q(scope="global") | Q(organization_id=organization_id))
        elif organization_id:
            provider_query = provider_query.filter(Q(scope="global") | Q(organization_id=organization_id))

        providers = list(
            provider_query.only(
                "id",
                "display_name",
                "provider_key",
                "scope",
                "organization_id",
                "runtime_status",
                "health_consecutive_failures",
            )
        )
    except (OperationalError, ProgrammingError) as exc:
        logger.warning("[LLM Admin] usage alerts skipped provider health due to unavailable table: %s", exc)
        providers = []

    for provider in providers:
        consecutive_failures = _safe_int(getattr(provider, "health_consecutive_failures", 0))
        if consecutive_failures < normalized_failure_threshold:
            continue
        runtime_status = getattr(provider, "runtime_status", "unknown")
        severity = (
            "critical"
            if consecutive_failures >= normalized_failure_threshold * 2 or runtime_status == "unhealthy"
            else "warning"
        )
        alerts.append(
            {
                "alert_type": "provider_health",
                "severity": severity,
                "provider_id": str(provider.id),
                "provider_display_name": provider.display_name or provider.provider_key or str(provider.id),
                "organization_id": provider.organization_id or None,
                "metric_name": "consecutive_failures",
                "metric_value": float(consecutive_failures),
                "threshold_value": float(normalized_failure_threshold),
                "message": f"渠道连续失败 {consecutive_failures} 次，运行态为 {runtime_status}",
                "context": {
                    "runtime_status": runtime_status,
                    "scope": provider.scope,
                },
                "_score": float(consecutive_failures - normalized_failure_threshold),
            }
        )

    alerts.sort(
        key=lambda item: (
            0 if item.get("severity") == "critical" else 1,
            -_safe_float(item.get("_score")),
            str(item.get("alert_type") or ""),
            str(item.get("provider_display_name") or ""),
        )
    )

    total_alerts = len(alerts)
    critical_alerts = len([item for item in alerts if item.get("severity") == "critical"])
    warning_alerts = len([item for item in alerts if item.get("severity") == "warning"])

    response_alerts = []
    for item in alerts[:normalized_limit]:
        sanitized = dict(item)
        sanitized.pop("_score", None)
        response_alerts.append(sanitized)

    return success_response(
        data={
            "time_window": {
                "start_time": start_at.isoformat(),
                "end_time": end_at.isoformat(),
            },
            "thresholds": {
                "success_rate_threshold": normalized_success_threshold,
                "p95_latency_threshold_ms": normalized_p95_threshold,
                "provider_failure_threshold": normalized_failure_threshold,
                "min_requests": normalized_min_requests,
            },
            "summary": {
                "total_alerts": total_alerts,
                "critical_alerts": critical_alerts,
                "warning_alerts": warning_alerts,
            },
            "alerts": response_alerts,
        },
        message=_("llm.usage_alert_done"),
    )

@router.get("/admin/usage/trends", auth=SuperuserAuth(), tags=["用量统计"])
@envelope_errors
def admin_usage_trends(
    request,
    start_time: Optional[str] = None,
    end_time: Optional[str] = None,
    granularity: str = "1h",
    scope: Optional[str] = "all",
    organization_id: Optional[str] = None,
    user_id: Optional[str] = None,
    provider_id: Optional[str] = None,
    model_id: Optional[str] = None,
    scene_key: Optional[str] = None,
    capability_domain: Optional[str] = None,
    cost_status: Optional[str] = None,
    effective_provider_scope: Optional[str] = None,
):

    start_at, end_at = _resolve_usage_time_window(start_time, end_time)
    normalized_granularity = (granularity or "1h").strip().lower()
    if normalized_granularity not in {"5m", "1h", "1d"}:
        return error_response_with_status("BAD_REQUEST", message="granularity 必须为 5m / 1h / 1d", status_code=400)

    try:
        query = _build_usage_fact_queryset(
            start_at=start_at,
            end_at=end_at,
            scope=scope,
            organization_id=organization_id,
            user_id=user_id,
            provider_id=provider_id,
            model_id=model_id,
            scene_key=scene_key,
            capability_domain=capability_domain,
            cost_status=cost_status,
            effective_provider_scope=effective_provider_scope,
        )

        _utc = dt_timezone.utc

        if normalized_granularity == "1h":
            grouped = list(
                query.annotate(bucket=TruncHour("occurred_at", tzinfo=_utc))
                .values("bucket")
                .annotate(
                    total_requests=Count("id"),
                    completed_requests=Count("id", filter=Q(status="completed")),
                    failed_requests=Count("id", filter=Q(status="failed")),
                    total_input_tokens=Sum("input_tokens"),
                    total_output_tokens=Sum("output_tokens"),
                    total_tokens=Sum("total_tokens"),
                    total_cache_read_input_tokens=Sum("cache_read_input_tokens"),
                    total_cache_creation_input_tokens=Sum("cache_creation_input_tokens"),
                    total_cost=Sum("total_cost"),
                    latency_sum=Sum("latency_ms"),
                    latency_count=Count("latency_ms"),
                )
                .order_by("bucket")
            )
        elif normalized_granularity == "1d":
            grouped = list(
                query.annotate(bucket=TruncDate("occurred_at", tzinfo=_utc))
                .values("bucket")
                .annotate(
                    total_requests=Count("id"),
                    completed_requests=Count("id", filter=Q(status="completed")),
                    failed_requests=Count("id", filter=Q(status="failed")),
                    total_input_tokens=Sum("input_tokens"),
                    total_output_tokens=Sum("output_tokens"),
                    total_tokens=Sum("total_tokens"),
                    total_cache_read_input_tokens=Sum("cache_read_input_tokens"),
                    total_cache_creation_input_tokens=Sum("cache_creation_input_tokens"),
                    total_cost=Sum("total_cost"),
                    latency_sum=Sum("latency_ms"),
                    latency_count=Count("latency_ms"),
                )
                .order_by("bucket")
            )
        else:
            minute_rows = list(
                query.annotate(bucket=TruncMinute("occurred_at", tzinfo=_utc))
                .values("bucket")
                .annotate(
                    total_requests=Count("id"),
                    completed_requests=Count("id", filter=Q(status="completed")),
                    failed_requests=Count("id", filter=Q(status="failed")),
                    total_input_tokens=Sum("input_tokens"),
                    total_output_tokens=Sum("output_tokens"),
                    total_tokens=Sum("total_tokens"),
                    total_cache_read_input_tokens=Sum("cache_read_input_tokens"),
                    total_cache_creation_input_tokens=Sum("cache_creation_input_tokens"),
                    total_cost=Sum("total_cost"),
                    latency_sum=Sum("latency_ms"),
                    latency_count=Count("latency_ms"),
                )
                .order_by("bucket")
            )
            merged: dict[datetime, dict[str, Any]] = {}
            for row in minute_rows:
                bucket = row["bucket"]
                normalized_bucket = bucket.replace(
                    minute=(bucket.minute // 5) * 5,
                    second=0,
                    microsecond=0,
                )
                existing = merged.setdefault(
                    normalized_bucket,
                    {
                        "bucket": normalized_bucket,
                        "total_requests": 0,
                        "completed_requests": 0,
                        "failed_requests": 0,
                        "total_input_tokens": 0,
                        "total_output_tokens": 0,
                        "total_tokens": 0,
                        "total_cache_read_input_tokens": 0,
                        "total_cache_creation_input_tokens": 0,
                        "total_cost": 0.0,
                        "latency_sum": 0,
                        "latency_count": 0,
                    },
                )
                existing["total_requests"] += _safe_int(row.get("total_requests"))
                existing["completed_requests"] += _safe_int(row.get("completed_requests"))
                existing["failed_requests"] += _safe_int(row.get("failed_requests"))
                existing["total_input_tokens"] += _safe_int(row.get("total_input_tokens"))
                existing["total_output_tokens"] += _safe_int(row.get("total_output_tokens"))
                existing["total_tokens"] += _safe_int(row.get("total_tokens"))
                existing["total_cache_read_input_tokens"] += _safe_int(row.get("total_cache_read_input_tokens"))
                existing["total_cache_creation_input_tokens"] += _safe_int(row.get("total_cache_creation_input_tokens"))
                existing["total_cost"] += _safe_float(row.get("total_cost"))
                existing["latency_sum"] += _safe_int(row.get("latency_sum"))
                existing["latency_count"] += _safe_int(row.get("latency_count"))
            grouped = [merged[key] for key in sorted(merged.keys())]
    except (ProgrammingError, OperationalError) as exc:
        logger.warning("[LLM Admin] usage fact table unavailable, fallback empty trends: %s", exc)
        return success_response(
            data={
                "time_window": {
                    "start_time": start_at.isoformat(),
                    "end_time": end_at.isoformat(),
                    "granularity": normalized_granularity,
                },
                "points": [],
                "degraded": True,
            },
            message=_("llm.usage_table_not_ready"),
        )

    points = []
    for row in grouped:
        completed_requests = _safe_int(row.get("completed_requests"))
        failed_requests = _safe_int(row.get("failed_requests"))
        total_input_tokens = _safe_int(row.get("total_input_tokens"))
        total_cache_read_input_tokens = _safe_int(row.get("total_cache_read_input_tokens"))
        denominator = completed_requests + failed_requests
        avg_latency_ms = 0.0
        latency_count = _safe_int(row.get("latency_count"))
        if latency_count > 0:
            avg_latency_ms = round(_safe_float(row.get("latency_sum")) / latency_count, 2)
        points.append(
            {
                "bucket": row["bucket"].isoformat(),
                "total_requests": _safe_int(row.get("total_requests")),
                "completed_requests": completed_requests,
                "failed_requests": failed_requests,
                "success_rate": round((completed_requests / denominator) * 100, 2) if denominator > 0 else 0,
                "total_input_tokens": total_input_tokens,
                "total_output_tokens": _safe_int(row.get("total_output_tokens")),
                "total_tokens": _safe_int(row.get("total_tokens")),
                "total_cache_read_input_tokens": total_cache_read_input_tokens,
                "total_cache_creation_input_tokens": _safe_int(row.get("total_cache_creation_input_tokens")),
                "cache_hit_rate": round((total_cache_read_input_tokens / total_input_tokens) * 100, 2)
                if total_input_tokens > 0 else 0,
                "total_cost": round(_safe_float(row.get("total_cost")), 6),
                "avg_latency_ms": avg_latency_ms,
            }
        )

    return success_response(
        data={
            "time_window": {
                "start_time": start_at.isoformat(),
                "end_time": end_at.isoformat(),
                "granularity": normalized_granularity,
            },
            "points": points,
        },
        message=_("llm.usage_trend_success"),
    )

@router.get("/admin/usage/breakdown", auth=SuperuserAuth(), tags=["用量统计"])
@envelope_errors
def admin_usage_breakdown(
    request,
    start_time: Optional[str] = None,
    end_time: Optional[str] = None,
    dimension: str = "organization",
    scope: Optional[str] = "all",
    organization_id: Optional[str] = None,
    user_id: Optional[str] = None,
    provider_id: Optional[str] = None,
    model_id: Optional[str] = None,
    scene_key: Optional[str] = None,
    capability_domain: Optional[str] = None,
    cost_status: Optional[str] = None,
    effective_provider_scope: Optional[str] = None,
    limit: int = 50,
):

    start_at, end_at = _resolve_usage_time_window(start_time, end_time)
    normalized_dimension = (dimension or "organization").strip().lower()
    # v0.1：use_case / source_app 字段已删（0022），改用 scene_key / capability_domain / cost_status。
    # 兼容期：'workspace' 旧值映射为 'organization'。
    if normalized_dimension == "workspace":
        normalized_dimension = "organization"
    if normalized_dimension not in {
        "organization",
        "provider",
        "model",
        "scene_key",
        "capability_domain",
        "cost_status",
    }:
        return error_response_with_status(
            "BAD_REQUEST",
            message="dimension 必须为 organization/provider/model/scene_key/capability_domain/cost_status",
            status_code=400,
        )

    try:
        query = _build_usage_fact_queryset(
            start_at=start_at,
            end_at=end_at,
            scope=scope,
            organization_id=organization_id,
            user_id=user_id,
            provider_id=provider_id,
            model_id=model_id,
            scene_key=scene_key,
            capability_domain=capability_domain,
            cost_status=cost_status,
            effective_provider_scope=effective_provider_scope,
        )
        if normalized_dimension == "organization":
            grouped = query.values("organization_id")
        elif normalized_dimension == "provider":
            grouped = query.values("provider_id", "provider__display_name", "provider_key")
        elif normalized_dimension == "model":
            grouped = query.values("model_id", "model_name", "model__display_name")
        elif normalized_dimension == "scene_key":
            grouped = query.values("scene_key")
        elif normalized_dimension == "cost_status":
            grouped = query.values("cost_status")
        else:
            grouped = query.values("capability_domain")

        rows = list(
            grouped.annotate(
                total_requests=Count("id"),
                completed_requests=Count("id", filter=Q(status="completed")),
                failed_requests=Count("id", filter=Q(status="failed")),
                total_input_tokens=Sum("input_tokens"),
                total_output_tokens=Sum("output_tokens"),
                total_tokens=Sum("total_tokens"),
                total_cache_read_input_tokens=Sum("cache_read_input_tokens"),
                total_cache_creation_input_tokens=Sum("cache_creation_input_tokens"),
                total_cost_sum=Sum("total_cost"),
                avg_latency_ms=Avg("latency_ms"),
                # cost_status 子聚合：同一行内拆分 platform_paid / byok_self_paid / n_a 占比。
                # 宪法 §5.8：每行返回 cost_status_breakdown 帮助 UI 判读"这维度里 BYOK 占比"。
                count_platform_paid=Count("id", filter=Q(cost_status="platform_paid")),
                count_byok_self_paid=Count("id", filter=Q(cost_status="byok_self_paid")),
                count_n_a=Count("id", filter=Q(cost_status="n_a")),
                cost_platform_paid=Sum("total_cost", filter=Q(cost_status="platform_paid")),
                cost_byok_self_paid=Sum("total_cost", filter=Q(cost_status="byok_self_paid")),
                cost_n_a=Sum("total_cost", filter=Q(cost_status="n_a")),
            )
            .order_by("-total_cost_sum", "-total_requests")[: max(1, min(limit, 200))]
        )
    except (ProgrammingError, OperationalError) as exc:
        logger.warning("[LLM Admin] usage fact table unavailable, fallback empty breakdown: %s", exc)
        return success_response(
            data={
                "dimension": normalized_dimension,
                "items": [],
                "degraded": True,
            },
            message=_("llm.usage_table_not_ready"),
        )

    cost_status_label_map = {
        "platform_paid": "平台计费",
        "byok_self_paid": "BYOK 自付",
        "n_a": "不计费 (N/A)",
    }

    items = []
    for row in rows:
        if normalized_dimension == "organization":
            dimension_key = row.get("organization_id") or "global"
            dimension_label = row.get("organization_id") or "全局"
        elif normalized_dimension == "provider":
            dimension_key = row.get("provider_id") or "-"
            provider_name = row.get("provider__display_name") or "-"
            provider_key = row.get("provider_key") or "-"
            dimension_label = f"{provider_name} ({provider_key})"
        elif normalized_dimension == "model":
            dimension_key = row.get("model_id") or "-"
            display_name = row.get("model__display_name") or row.get("model_name") or "-"
            model_name_val = row.get("model_name") or "-"
            dimension_label = f"{display_name} ({model_name_val})"
        elif normalized_dimension == "scene_key":
            dimension_key = row.get("scene_key") or "-"
            dimension_label = row.get("scene_key") or "-"
        elif normalized_dimension == "cost_status":
            raw_cs = row.get("cost_status") or "-"
            dimension_key = str(raw_cs)
            dimension_label = cost_status_label_map.get(str(raw_cs), str(raw_cs))
        else:
            dimension_key = row.get("capability_domain") or "-"
            dimension_label = row.get("capability_domain") or "-"

        completed_requests = _safe_int(row.get("completed_requests"))
        failed_requests = _safe_int(row.get("failed_requests"))
        total_input_tokens = _safe_int(row.get("total_input_tokens"))
        total_cache_read_input_tokens = _safe_int(row.get("total_cache_read_input_tokens"))
        denominator = completed_requests + failed_requests
        items.append(
            {
                "dimension_key": str(dimension_key),
                "dimension_label": dimension_label,
                "total_requests": _safe_int(row.get("total_requests")),
                "completed_requests": completed_requests,
                "failed_requests": failed_requests,
                "success_rate": round((completed_requests / denominator) * 100, 2) if denominator > 0 else 0,
                "total_input_tokens": total_input_tokens,
                "total_output_tokens": _safe_int(row.get("total_output_tokens")),
                "total_tokens": _safe_int(row.get("total_tokens")),
                "total_cache_read_input_tokens": total_cache_read_input_tokens,
                "total_cache_creation_input_tokens": _safe_int(row.get("total_cache_creation_input_tokens")),
                "cache_hit_rate": round((total_cache_read_input_tokens / total_input_tokens) * 100, 2)
                if total_input_tokens > 0 else 0,
                "total_cost": round(_safe_float(row.get("total_cost_sum")), 6),
                "avg_latency_ms": round(_safe_float(row.get("avg_latency_ms")), 2),
                "cost_status_breakdown": {
                    "platform_paid": {
                        "count": _safe_int(row.get("count_platform_paid")),
                        "total_cost": round(_safe_float(row.get("cost_platform_paid")), 6),
                    },
                    "byok_self_paid": {
                        "count": _safe_int(row.get("count_byok_self_paid")),
                        "total_cost": round(_safe_float(row.get("cost_byok_self_paid")), 6),
                    },
                    "n_a": {
                        "count": _safe_int(row.get("count_n_a")),
                        "total_cost": round(_safe_float(row.get("cost_n_a")), 6),
                    },
                },
            }
        )

    return success_response(
        data={
            "dimension": normalized_dimension,
            "items": items,
        },
        message=_("llm.usage_distribution_success"),
    )

@router.get("/admin/usage/errors", auth=SuperuserAuth(), tags=["用量统计"])
@envelope_errors
def admin_usage_errors(
    request,
    start_time: Optional[str] = None,
    end_time: Optional[str] = None,
    scope: Optional[str] = "all",
    organization_id: Optional[str] = None,
    user_id: Optional[str] = None,
    provider_id: Optional[str] = None,
    model_id: Optional[str] = None,
    scene_key: Optional[str] = None,
    capability_domain: Optional[str] = None,
    cost_status: Optional[str] = None,
    effective_provider_scope: Optional[str] = None,
    limit: int = 50,
):

    start_at, end_at = _resolve_usage_time_window(start_time, end_time)
    try:
        query = _build_usage_fact_queryset(
            start_at=start_at,
            end_at=end_at,
            scope=scope,
            organization_id=organization_id,
            user_id=user_id,
            provider_id=provider_id,
            model_id=model_id,
            scene_key=scene_key,
            capability_domain=capability_domain,
            cost_status=cost_status,
            effective_provider_scope=effective_provider_scope,
        ).filter(status="failed")

        rows = list(
            query.values("error_category", "error_code")
            .annotate(total=Count("id"))
            .order_by("-total", "error_category", "error_code")[: max(1, min(limit, 200))]
        )
    except (ProgrammingError, OperationalError) as exc:
        logger.warning("[LLM Admin] usage fact table unavailable, fallback empty errors: %s", exc)
        return success_response(
            data={
                "items": [],
                "degraded": True,
            },
            message=_("llm.usage_table_not_ready"),
        )

    return success_response(
        data={
            "items": [
                {
                    "error_category": row.get("error_category") or "other",
                    "error_code": row.get("error_code") or "UNKNOWN_ERROR",
                    "total": _safe_int(row.get("total")),
                }
                for row in rows
            ],
        },
        message=_("llm.error_distribution_success"),
    )

@router.get("/admin/usage/requests", auth=SuperuserAuth(), tags=["用量统计"])
@envelope_errors
def admin_usage_requests(
    request,
    start_time: Optional[str] = None,
    end_time: Optional[str] = None,
    scope: Optional[str] = "all",
    organization_id: Optional[str] = None,
    user_id: Optional[str] = None,
    provider_id: Optional[str] = None,
    model_id: Optional[str] = None,
    scene_key: Optional[str] = None,
    capability_domain: Optional[str] = None,
    cost_status: Optional[str] = None,
    effective_provider_scope: Optional[str] = None,
    page: int = 1,
    page_size: int = 50,
):

    normalized_page = max(1, page)
    normalized_page_size = max(1, min(page_size, 200))
    offset = (normalized_page - 1) * normalized_page_size
    start_at, end_at = _resolve_usage_time_window(start_time, end_time)

    try:
        query = _build_usage_fact_queryset(
            start_at=start_at,
            end_at=end_at,
            scope=scope,
            organization_id=organization_id,
            user_id=user_id,
            provider_id=provider_id,
            model_id=model_id,
            scene_key=scene_key,
            capability_domain=capability_domain,
            cost_status=cost_status,
            effective_provider_scope=effective_provider_scope,
        ).order_by("-occurred_at")

        total = query.count()
        rows = list(query[offset: offset + normalized_page_size])
    except (ProgrammingError, OperationalError) as exc:
        logger.warning("[LLM Admin] usage fact table unavailable, fallback empty requests: %s", exc)
        return success_response(
            data={
                "requests": [],
                "total": 0,
                "page": normalized_page,
                "page_size": normalized_page_size,
                "total_pages": 0,
                "degraded": True,
            },
            message=_("llm.usage_table_not_ready"),
        )

    request_items = []
    for row in rows:
        # v0.1：scene_key + capability_domain 替代旧 use_case + source_app；
        # cost_status / effective_provider_scope 反映 BYOK / 平台计费状态。
        request_items.append(
            {
                "id": str(row.id),
                "request_id": row.request_id,
                "occurred_at": row.occurred_at.isoformat(),
                "organization_id": row.organization_id,
                "user_id": row.user_id,
                "provider_id": str(row.provider_id) if row.provider_id else None,
                "provider_display_name": row.provider.display_name if row.provider else "",
                "provider_key": row.provider_key,
                "model_id": str(row.model_id) if row.model_id else None,
                "model_display_name": row.model.display_name if row.model else row.model_name,
                "model_name": row.model_name,
                "scene_key": row.scene_key,
                "capability_domain": row.capability_domain,
                "effective_provider_scope": row.effective_provider_scope,
                "cost_status": row.cost_status,
                "status": row.status,
                "error_code": row.error_code,
                "error_category": row.error_category,
                "attempt_count": row.attempt_count,
                "latency_ms": row.latency_ms,
                "input_tokens": row.input_tokens,
                "output_tokens": row.output_tokens,
                "total_tokens": row.total_tokens,
                "cache_read_input_tokens": row.cache_read_input_tokens,
                "cache_creation_input_tokens": row.cache_creation_input_tokens,
                "cache_hit_rate": round((row.cache_read_input_tokens / row.input_tokens) * 100, 2)
                if row.input_tokens > 0 else 0,
                "total_cost": float(row.total_cost),
            }
        )

    return success_response(
        data={
            "requests": request_items,
            "total": total,
            "page": normalized_page,
            "page_size": normalized_page_size,
            "total_pages": (total + normalized_page_size - 1) // normalized_page_size,
        },
        message=_("llm.usage_detail_success"),
    )

@router.get("/admin/usage/export", auth=SuperuserAuth(), tags=["用量统计"])
@envelope_errors
def admin_usage_export(
    request,
    start_time: Optional[str] = None,
    end_time: Optional[str] = None,
    scope: Optional[str] = "all",
    organization_id: Optional[str] = None,
    user_id: Optional[str] = None,
    provider_id: Optional[str] = None,
    model_id: Optional[str] = None,
    scene_key: Optional[str] = None,
    capability_domain: Optional[str] = None,
    cost_status: Optional[str] = None,
    effective_provider_scope: Optional[str] = None,
    max_rows: int = 50000,
):

    normalized_max_rows = max(1, min(max_rows, 200000))
    start_at, end_at = _resolve_usage_time_window(start_time, end_time)

    try:
        query = _build_usage_fact_queryset(
            start_at=start_at,
            end_at=end_at,
            scope=scope,
            organization_id=organization_id,
            user_id=user_id,
            provider_id=provider_id,
            model_id=model_id,
            scene_key=scene_key,
            capability_domain=capability_domain,
            cost_status=cost_status,
            effective_provider_scope=effective_provider_scope,
        ).order_by("-occurred_at")

        total_count = query.count()
        rows_qs = query.values(
            "occurred_at",
            "request_id",
            "organization_id",
            "user_id",
            "provider__display_name",
            "provider_key",
            "model__display_name",
            "model_name",
            "scene_key",
            "capability_domain",
            "effective_provider_scope",
            "cost_status",
            "status",
            "error_code",
            "error_category",
            "attempt_count",
            "latency_ms",
            "input_tokens",
            "output_tokens",
            "total_tokens",
            "cache_read_input_tokens",
            "cache_creation_input_tokens",
            "total_cost",
        )[:normalized_max_rows]
    except (ProgrammingError, OperationalError) as exc:
        logger.warning("[LLM Admin] usage fact table unavailable, export failed: %s", exc)
        return error_response_with_status("SERVICE_UNAVAILABLE", message=_("llm.usage_table_not_ready_export"), status_code=503)

    def _csv_row_to_str(values):
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(values)
        return buf.getvalue()

    def _stream_csv():
        yield "\ufeff"
        yield _csv_row_to_str([
            "occurred_at",
            "request_id",
            "organization_id",
            "user_id",
            "provider",
            "provider_key",
            "model",
            "model_name",
            "scene_key",
            "capability_domain",
            "effective_provider_scope",
            "cost_status",
            "status",
            "error_code",
            "error_category",
            "attempt_count",
            "latency_ms",
            "input_tokens",
            "output_tokens",
            "total_tokens",
            "cache_read_input_tokens",
            "cache_creation_input_tokens",
            "cache_hit_rate",
            "total_cost",
        ])
        for row in rows_qs.iterator(chunk_size=2000):
            input_tokens = _safe_int(row.get("input_tokens"))
            cache_read = _safe_int(row.get("cache_read_input_tokens"))
            cache_hit_rate = round((cache_read / input_tokens) * 100, 2) if input_tokens > 0 else 0
            yield _csv_row_to_str([
                row.get("occurred_at").isoformat() if row.get("occurred_at") else "",
                row.get("request_id") or "",
                row.get("organization_id") or "",
                row.get("user_id") or "",
                row.get("provider__display_name") or "",
                row.get("provider_key") or "",
                row.get("model__display_name") or "",
                row.get("model_name") or "",
                row.get("scene_key") or "",
                row.get("capability_domain") or "",
                row.get("effective_provider_scope") or "",
                row.get("cost_status") or "",
                row.get("status") or "",
                row.get("error_code") or "",
                row.get("error_category") or "",
                row.get("attempt_count") or 0,
                row.get("latency_ms") if row.get("latency_ms") is not None else "",
                row.get("input_tokens") or 0,
                row.get("output_tokens") or 0,
                row.get("total_tokens") or 0,
                row.get("cache_read_input_tokens") or 0,
                row.get("cache_creation_input_tokens") or 0,
                cache_hit_rate,
                _safe_float(row.get("total_cost")),
            ])

    filename = f"llm_usage_export_{timezone.now().strftime('%Y%m%d_%H%M%S')}.csv"
    response = StreamingHttpResponse(
        _stream_csv(),
        content_type="text/csv; charset=utf-8",
    )
    response["Content-Disposition"] = f'attachment; filename="{filename}"'
    response["X-Export-Total-Rows"] = str(min(total_count, normalized_max_rows))
    response["X-Export-Max-Rows"] = str(normalized_max_rows)
    if total_count > normalized_max_rows:
        response["X-Export-Truncated"] = "true"
    return response


@router.get("/admin/usage/byok-savings", auth=SuperuserAuth(), tags=["用量统计"])
@envelope_errors
def admin_usage_byok_savings(
    request,
    days: int = 30,
    organization_id: Optional[str] = None,
):
    """
    BYOK vs 平台调用对比（v0.1 新加，宪法 §2.2.2）。

    - byok.total_savings_usd      = SUM(total_cost WHERE cost_status='byok_self_paid')
      （这部分成本由用户自付，平台节省了对应金额）
    - platform.total_cost_usd     = SUM(total_cost WHERE cost_status='platform_paid')
      （这部分成本由平台计费）
    - n_a 桶：cost_status='n_a'（系统/治理类调用，不计费），仅用于诊断
    - cumulative.savings_ratio    = byok / (byok + platform)
    """
    normalized_days = max(1, min(int(days or 30), 365))
    since = timezone.now() - timedelta(days=normalized_days)

    try:
        qs = LLMUsageFact.objects.filter(occurred_at__gte=since)
        if organization_id:
            qs = qs.filter(organization_id=organization_id)

        byok_agg = qs.filter(cost_status="byok_self_paid").aggregate(
            total=Sum("total_cost"),
            count=Count("id"),
            tokens=Sum("total_tokens"),
        )
        platform_agg = qs.filter(cost_status="platform_paid").aggregate(
            total=Sum("total_cost"),
            count=Count("id"),
            tokens=Sum("total_tokens"),
        )
        n_a_agg = qs.filter(cost_status="n_a").aggregate(
            total=Sum("total_cost"),
            count=Count("id"),
            tokens=Sum("total_tokens"),
        )
    except (ProgrammingError, OperationalError) as exc:
        logger.warning("[LLM Admin] usage byok-savings fallback due to unavailable table: %s", exc)
        return success_response(
            data={
                "since": since.isoformat(),
                "days": normalized_days,
                "byok": {
                    "total_savings_usd": "0",
                    "call_count": 0,
                    "total_tokens": 0,
                },
                "platform": {
                    "total_cost_usd": "0",
                    "call_count": 0,
                    "total_tokens": 0,
                },
                "n_a": {
                    "total_cost_usd": "0",
                    "call_count": 0,
                    "total_tokens": 0,
                },
                "cumulative": {
                    "billable_total_usd": "0",
                    "savings_ratio": 0.0,
                },
                "degraded": True,
            },
            message=_("llm.usage_table_not_ready"),
        )

    byok_total = _safe_decimal(byok_agg.get("total"))
    platform_total = _safe_decimal(platform_agg.get("total"))
    n_a_total = _safe_decimal(n_a_agg.get("total"))
    billable_total = byok_total + platform_total
    savings_ratio = 0.0
    if billable_total > 0:
        savings_ratio = float(
            (byok_total / billable_total).quantize(Decimal("0.0001"))
        )

    return success_response(
        data={
            "since": since.isoformat(),
            "days": normalized_days,
            "organization_id": organization_id or None,
            "byok": {
                "total_savings_usd": str(byok_total.quantize(Decimal("0.000001"))),
                "call_count": _safe_int(byok_agg.get("count")),
                "total_tokens": _safe_int(byok_agg.get("tokens")),
            },
            "platform": {
                "total_cost_usd": str(platform_total.quantize(Decimal("0.000001"))),
                "call_count": _safe_int(platform_agg.get("count")),
                "total_tokens": _safe_int(platform_agg.get("tokens")),
            },
            "n_a": {
                "total_cost_usd": str(n_a_total.quantize(Decimal("0.000001"))),
                "call_count": _safe_int(n_a_agg.get("count")),
                "total_tokens": _safe_int(n_a_agg.get("tokens")),
            },
            "cumulative": {
                "billable_total_usd": str(billable_total.quantize(Decimal("0.000001"))),
                "savings_ratio": savings_ratio,
            },
        },
        message=_("llm.usage_byok_savings_success"),
    )
