"""LLM 管理员 API — Provider 管理（CRUD + Runtime + 探测）。"""

from typing import Optional, Any
from datetime import timedelta
import logging

from django.db import transaction
from django.db.utils import OperationalError, ProgrammingError
from django.db.models import Q, Count, Sum, Avg, Max, Exists, OuterRef
from django.utils import timezone
from ninja import Router, Schema
from ninja.errors import HttpError

from apps.i18n import _
from apps.i18n.response import success_response, error_response_with_status
from apps.users.auth.admin_audit import record_admin_sensitive_action
from apps.users.auth.permissions import AdminPermissionAuth, SuperuserAuth

from .api_common import (
    envelope_errors,
    _normalize_provider_key,
    _normalize_base_url,
)
from .models import (
    LLMCredentialDecryptionError,
    LLMProvider,
    LLMProviderKey,
    LLMModel,
    LLMSceneBinding,
    LLMUsageFact,
)
from .schemas import (
    AdminProviderCreateRequest,
    AdminProviderUpdateRequest,
    AdminProviderRuntimeUpdateRequest,
    ProviderKeyCreateRequest,
    ProviderKeyUpdateRequest,
)
from .registry import ProviderRegistry
from .services import get_available_models, invalidate_models_cache
from .services.runtime import probe_provider_health, reset_provider_health
from .utils.provider_profiles import (
    CAPABILITY_SCHEMA_VERSION,
    get_capability_matrix,
    list_provider_profiles,
)
from .api_admin_utils import (
    _mask_api_key,
    _record_admin_audit,
    _serialize_provider,
    _serialize_model,
    _resolve_model_runtime_status,
    _serialize_runtime_model,
    _validate_provider_scope,
    _clear_organization_default_model_refs,
    _invalidate_provider_related_cache,
    _invalidate_model_related_cache,
    _safe_float,
    _safe_int,
    _resolve_usage_time_window,
    _build_usage_fact_queryset,
    _calculate_percentile,
)

logger = logging.getLogger(__name__)

router = Router()


_CAPABILITY_DOMAIN_ORDER = (
    "chat", "embedding", "vision", "asr", "tts",
    "image_gen", "video_gen", "audio_gen",
)
_VALID_CAPABILITY_DOMAINS = set(_CAPABILITY_DOMAIN_ORDER)
_REGISTRY_CAPABILITY_DOMAIN_ALIASES = {
    "llm": "chat",
    "audio_generation": "audio_gen",
    "bgm": "audio_gen",
}


def _normalize_registry_capability_domains(domains: list[str] | set[str]) -> list[str]:
    """将服务注册表的内部能力名转换为管理后台可保存的公共能力域。"""
    normalized = {
        _REGISTRY_CAPABILITY_DOMAIN_ALIASES.get(domain, domain)
        for domain in domains
    }
    return [domain for domain in _CAPABILITY_DOMAIN_ORDER if domain in normalized]


def _delete_provider_models(*, provider: LLMProvider, model_ids: list[Any]) -> dict[str, Any]:
    """删除渠道下未被场景引用的模型，供渠道删除事务复用。"""
    referencing_bindings = list(
        LLMSceneBinding.objects.filter(primary_model_id__in=model_ids)
        .values("scene_key", "display_name", "primary_model_id")
        .order_by("scene_key")[:20]
    )
    if referencing_bindings:
        return {
            "deleted_models": 0,
            "referencing_bindings": referencing_bindings,
        }

    models = LLMModel.objects.filter(provider=provider, id__in=model_ids)
    model_count = models.count()
    models.delete()
    return {
        "deleted_models": model_count,
        "referencing_bindings": [],
    }


class SensitiveActionRequest(Schema):
    reason: str = ""
    ticket_id: str = ""


@router.get("/admin/providers", auth=SuperuserAuth(), tags=["管理员配置"])
@envelope_errors
def admin_list_providers(
    request,
    scope: Optional[str] = None,
    capability_domain: Optional[str] = None,
    organization_id: Optional[str] = None,
    include_global_for_organization: bool = False,
    include_inactive: bool = True,
    keyword: Optional[str] = None,
    limit: int = 200,
):

    limit_value = max(1, min(limit, 500))
    # v0.1.x：AdminDash 8 个 Tab 各自传 capability_domain 过滤；
    # capability_domains 是 ArrayField，"该 Tab 显示包含此 domain 的 Provider"。
    # 空值 = 全部域。
    query = LLMProvider.objects.annotate(model_count=Count("models")).order_by("-updated_at")

    normalized_capability_domain = (capability_domain or "").strip().lower() or None
    if normalized_capability_domain and normalized_capability_domain not in _VALID_CAPABILITY_DOMAINS:
        return error_response_with_status(
            "BAD_REQUEST",
            message=f"capability_domain 必须为 {sorted(_VALID_CAPABILITY_DOMAINS)} 之一",
            status_code=400,
        )
    if normalized_capability_domain:
        query = query.filter(capability_domains__contains=[normalized_capability_domain])

    normalized_scope = (scope or "").strip() or None
    if normalized_scope and normalized_scope not in {"global", "organization", "user"}:
        return error_response_with_status("BAD_REQUEST", message="scope 必须为 global / organization / user", status_code=400)
    if include_global_for_organization and not organization_id:
        return error_response_with_status("BAD_REQUEST", message="include_global_for_organization=true 时 organization_id 必填", status_code=400)

    include_organization_union = bool(
        include_global_for_organization and organization_id and normalized_scope in {None, "organization"}
    )
    if include_organization_union:
        query = query.filter(
            Q(scope="global")
            | Q(scope="organization", organization_id=organization_id)
        )
    else:
        if normalized_scope:
            query = query.filter(scope=normalized_scope)
        if organization_id:
            query = query.filter(organization_id=organization_id)
    # v0.1：is_active 字段已删（0022），include_inactive=false 在 v0.1 等价于
    # routing_enabled=True；为兼容前端旧参数保留接口，但不再过滤掉 routing 关闭项。
    # 注意：不要写 `_ = include_inactive`——会把同名 i18n 函数 _ 覆盖成 bool。
    del include_inactive

    normalized_keyword = (keyword or "").strip()
    if normalized_keyword:
        model_base_url_match = LLMModel.objects.filter(
            provider_id=OuterRef("pk"),
            base_url__icontains=normalized_keyword,
        )
        query = query.annotate(model_base_url_match=Exists(model_base_url_match)).filter(
            Q(name__icontains=normalized_keyword)
            | Q(provider_key__icontains=normalized_keyword)
            | Q(display_name__icontains=normalized_keyword)
            | Q(model_base_url_match=True)
        )

    providers = list(query[:limit_value])
    provider_items = [_serialize_provider(provider) for provider in providers]

    return success_response(
        data={
            "providers": provider_items,
            "total": query.count(),
            "returned": len(provider_items),
        },
        message=_("llm.channel_list_success"),
    )

@router.get("/admin/capability-profiles", auth=SuperuserAuth(), tags=["管理员配置"])
@envelope_errors
def admin_list_capability_profiles(
    request,
    provider: Optional[str] = None,
):
    """
    返回模型能力矩阵与渠道能力模板。

    - matrix: UI 渲染 schema（布尔能力、限制项、缓存计费项）
    - providers: 按渠道内置的默认能力模板（可用于一键回填表单）
    """

    provider_profiles = list_provider_profiles(provider=provider)
    return success_response(
        data={
            "schema_version": CAPABILITY_SCHEMA_VERSION,
            "matrix": get_capability_matrix(),
            "providers": provider_profiles,
        },
        message=_("llm.capability_template_success"),
    )

@router.get("/admin/runtime/providers", auth=SuperuserAuth(), tags=["运行治理"])
@envelope_errors
def admin_list_runtime_providers(
    request,
    scope: Optional[str] = None,
    capability_domain: Optional[str] = None,
    organization_id: Optional[str] = None,
    include_global_for_organization: bool = False,
    include_inactive: bool = True,
    keyword: Optional[str] = None,
    limit: int = 200,
):

    limit_value = max(1, min(limit, 500))
    # v0.1.x：capability_domains 为集合，按"包含此 domain"过滤。
    query = LLMProvider.objects.annotate(model_count=Count("models")).order_by("-updated_at")

    normalized_capability_domain = (capability_domain or "").strip().lower() or None
    if normalized_capability_domain and normalized_capability_domain not in _VALID_CAPABILITY_DOMAINS:
        return error_response_with_status(
            "BAD_REQUEST",
            message=f"capability_domain 必须为 {sorted(_VALID_CAPABILITY_DOMAINS)} 之一",
            status_code=400,
        )
    if normalized_capability_domain:
        query = query.filter(capability_domains__contains=[normalized_capability_domain])

    normalized_scope = (scope or "").strip() or None
    if normalized_scope and normalized_scope not in {"global", "organization", "user"}:
        return error_response_with_status("BAD_REQUEST", message="scope 必须为 global / organization / user", status_code=400)
    if include_global_for_organization and not organization_id:
        return error_response_with_status("BAD_REQUEST", message="include_global_for_organization=true 时 organization_id 必填", status_code=400)

    include_organization_union = bool(
        include_global_for_organization and organization_id and normalized_scope in {None, "organization"}
    )
    if include_organization_union:
        query = query.filter(Q(scope="global") | Q(scope="organization", organization_id=organization_id))
    else:
        if normalized_scope:
            query = query.filter(scope=normalized_scope)
        if organization_id:
            query = query.filter(organization_id=organization_id)

    # v0.1：is_active 字段已删（0022），保留 include_inactive 形参兼容前端但不过滤。
    # 注意：不要写 `_ = include_inactive`——会把同名 i18n 函数 _ 覆盖成 bool。
    del include_inactive

    normalized_keyword = (keyword or "").strip()
    if normalized_keyword:
        model_base_url_match = LLMModel.objects.filter(
            provider_id=OuterRef("pk"),
            base_url__icontains=normalized_keyword,
        )
        query = query.annotate(model_base_url_match=Exists(model_base_url_match)).filter(
            Q(name__icontains=normalized_keyword)
            | Q(provider_key__icontains=normalized_keyword)
            | Q(display_name__icontains=normalized_keyword)
            | Q(model_base_url_match=True)
            | Q(runtime_status__icontains=normalized_keyword)
        )

    providers = list(query[:limit_value])

    return success_response(
        data={
            "providers": [_serialize_provider(provider) for provider in providers],
            "total": query.count(),
            "returned": len(providers),
        },
        message=_("llm.runtime_channel_list_success"),
    )

@router.get("/admin/runtime/models", auth=SuperuserAuth(), tags=["运行治理"])
@envelope_errors
def admin_list_runtime_models(
    request,
    provider_id: Optional[str] = None,
    scope: Optional[str] = None,
    organization_id: Optional[str] = None,
    include_global_for_organization: bool = False,
    include_inactive: bool = True,
    keyword: Optional[str] = None,
    hours: int = 24,
    min_requests: int = 5,
    limit: int = 300,
):

    limit_value = max(1, min(limit, 500))
    hours_value = max(1, min(hours, 24 * 30))
    min_requests_value = max(1, min(min_requests, 1000))

    query = LLMModel.objects.select_related("provider").all().order_by("-updated_at")

    normalized_scope = (scope or "").strip() or None
    if normalized_scope and normalized_scope not in {"global", "organization", "user"}:
        return error_response_with_status("BAD_REQUEST", message="scope 必须为 global / organization / user", status_code=400)
    if include_global_for_organization and not organization_id:
        return error_response_with_status("BAD_REQUEST", message="include_global_for_organization=true 时 organization_id 必填", status_code=400)

    include_organization_union = bool(
        include_global_for_organization and organization_id and normalized_scope in {None, "organization"}
    )
    if include_organization_union:
        query = query.filter(
            Q(provider__scope="global") | Q(provider__scope="organization", provider__organization_id=organization_id)
        )
    else:
        if normalized_scope:
            query = query.filter(provider__scope=normalized_scope)
        if organization_id:
            query = query.filter(provider__organization_id=organization_id)

    if provider_id:
        query = query.filter(provider_id=provider_id)

    # v0.1：is_active 字段已删（0022），保留 include_inactive 形参兼容前端但不过滤。
    # 注意：不要写 `_ = include_inactive`——会把同名 i18n 函数 _ 覆盖成 bool。
    del include_inactive

    normalized_keyword = (keyword or "").strip()
    if normalized_keyword:
        # v0.1：mode 字段已删（0022），按 capability_domain 模糊匹配替代。
        query = query.filter(
            Q(model_name__icontains=normalized_keyword)
            | Q(display_name__icontains=normalized_keyword)
            | Q(capability_domain__icontains=normalized_keyword)
            | Q(provider__display_name__icontains=normalized_keyword)
            | Q(provider__provider_key__icontains=normalized_keyword)
        )

    total = query.count()
    models = list(query[:limit_value])
    model_ids = [str(model.id) for model in models]

    now = timezone.now()
    window_start = now - timedelta(hours=hours_value)

    usage_map: dict[str, dict] = {}
    latency_values_by_model: dict[str, list[int]] = {}
    degraded = False
    if model_ids:
        try:
            usage_qs = LLMUsageFact.objects.filter(
                model_id__in=model_ids,
                occurred_at__gte=window_start,
                occurred_at__lte=now,
            )
            usage_rows = list(
                usage_qs.values("model_id")
                .annotate(
                    total_requests=Count("id"),
                    completed_requests=Count("id", filter=Q(status="completed")),
                    failed_requests=Count("id", filter=Q(status="failed")),
                    avg_latency_ms=Avg("latency_ms"),
                    total_tokens=Sum("total_tokens"),
                    total_cost=Sum("total_cost"),
                    last_occurred_at=Max("occurred_at"),
                )
            )
            usage_map = {
                str(row.get("model_id")): row
                for row in usage_rows
                if row.get("model_id")
            }

            latency_rows = list(
                usage_qs.filter(latency_ms__isnull=False).values("model_id", "latency_ms")
            )
            for row in latency_rows:
                model_key = str(row.get("model_id") or "")
                if not model_key:
                    continue
                latency_value = _safe_int(row.get("latency_ms"))
                if latency_value <= 0:
                    continue
                latency_values_by_model.setdefault(model_key, []).append(latency_value)
        except (ProgrammingError, OperationalError) as exc:
            logger.warning("[LLM Admin] runtime model metrics degraded due to unavailable usage table: %s", exc)
            degraded = True

    model_items = []
    for model in models:
        model_key = str(model.id)
        usage_row = usage_map.get(model_key, {})
        total_requests = _safe_int(usage_row.get("total_requests"))
        completed_requests = _safe_int(usage_row.get("completed_requests"))
        failed_requests = _safe_int(usage_row.get("failed_requests"))
        denominator = completed_requests + failed_requests
        success_rate = (completed_requests / denominator * 100) if denominator > 0 else 0.0

        p95_latency = _calculate_percentile(latency_values_by_model.get(model_key, []), 95)
        avg_latency = _safe_float(usage_row.get("avg_latency_ms"))
        total_tokens = _safe_int(usage_row.get("total_tokens"))
        total_cost = _safe_float(usage_row.get("total_cost"))
        last_occurred_at = usage_row.get("last_occurred_at")

        runtime_status, status_reason = _resolve_model_runtime_status(
            # v0.1：LLMModel.is_active 已删（0022）；wave_status='ready' 视为 active。
            model_active=(model.wave_status == 'ready'),
            provider_runtime_status=str(getattr(model.provider, "runtime_status", "unknown") or "unknown"),
            total_requests=total_requests,
            success_rate=success_rate,
            p95_latency_ms=p95_latency,
            min_requests=min_requests_value,
        )

        model_items.append(
            _serialize_runtime_model(
                model,
                runtime_status=runtime_status,
                status_reason=status_reason,
                total_requests=total_requests,
                completed_requests=completed_requests,
                failed_requests=failed_requests,
                success_rate=success_rate,
                avg_latency_ms=avg_latency,
                p95_latency_ms=p95_latency,
                total_tokens=total_tokens,
                total_cost=total_cost,
                last_occurred_at=last_occurred_at,
            )
        )

    payload = {
        "models": model_items,
        "total": total,
        "returned": len(model_items),
        "time_window": {
            "start_time": window_start.isoformat(),
            "end_time": now.isoformat(),
            "hours": hours_value,
        },
        "thresholds": {
            "min_requests": min_requests_value,
            "success_rate_unhealthy_below": 80,
            "success_rate_degraded_below": 92,
            "p95_latency_degraded_ms": 3500,
            "p95_latency_unhealthy_ms": 7000,
        },
    }
    if degraded:
        payload["degraded"] = True

    return success_response(
        data=payload,
        message=_("llm.runtime_model_list_success"),
    )

@router.put("/admin/runtime/providers/{provider_id}", auth=SuperuserAuth(), tags=["运行治理"])
@envelope_errors
def admin_update_provider_runtime(
    request,
    provider_id: str,
    payload: AdminProviderRuntimeUpdateRequest,
):

    provider = LLMProvider.objects.filter(id=provider_id).first()
    if not provider:
        return error_response_with_status("NOT_FOUND", message=_("llm.channel_not_found"), status_code=404)

    before_snapshot = _serialize_provider(provider)

    if payload.routing_enabled is not None:
        provider.routing_enabled = payload.routing_enabled
    if payload.routing_weight is not None:
        provider.routing_weight = payload.routing_weight
    if payload.health_check_enabled is not None:
        provider.health_check_enabled = payload.health_check_enabled
    if payload.health_check_interval_sec is not None:
        provider.health_check_interval_sec = payload.health_check_interval_sec

    provider.save()
    _invalidate_provider_related_cache(provider)

    after_snapshot = _serialize_provider(provider)
    _record_admin_audit(
        request,
        action="provider.runtime.update",
        target_type="provider",
        target_id=str(provider.id),
        organization_id=provider.organization_id,
        provider_id=str(provider.id),
        before_data=before_snapshot,
        after_data=after_snapshot,
    )

    return success_response(
        data={"provider": after_snapshot},
        message=_("llm.channel_runtime_config_updated"),
    )

@router.post("/admin/runtime/providers/{provider_id}/probe", auth=SuperuserAuth(), tags=["运行治理"])
@envelope_errors
def admin_probe_provider(
    request,
    provider_id: str,
):

    provider = LLMProvider.objects.filter(id=provider_id).first()
    if not provider:
        return error_response_with_status("NOT_FOUND", message=_("llm.channel_not_found"), status_code=404)

    result = probe_provider_health(provider, check_type="manual")
    refreshed = LLMProvider.objects.filter(id=provider_id).first() or provider
    _invalidate_provider_related_cache(refreshed)

    _record_admin_audit(
        request,
        action="provider.runtime.probe",
        target_type="provider",
        target_id=str(provider.id),
        organization_id=provider.organization_id,
        provider_id=str(provider.id),
        before_data={},
        after_data={
            "probe_success": bool((result.get("probe") or {}).get("is_success")),
            "runtime_status": refreshed.runtime_status,
            "health_consecutive_failures": refreshed.health_consecutive_failures,
            "health_last_latency_ms": refreshed.health_last_latency_ms,
            "health_last_error": refreshed.health_last_error,
        },
        extra_data={
            "probe": {
                **(result.get("probe") or {}),
                "diagnostic": result.get("diagnostic"),
            }
        },
    )

    return success_response(
        data={
            "provider": _serialize_provider(refreshed),
            "probe": result,
        },
        message=_("llm.channel_probe_done"),
    )

@router.post("/admin/runtime/providers/{provider_id}/reset-health", auth=AdminPermissionAuth("provider:update"), tags=["运行治理"])
@envelope_errors
def admin_reset_provider_health(
    request,
    provider_id: str,
    payload: SensitiveActionRequest,
):
    reason = (payload.reason or "").strip()
    if not reason:
        raise HttpError(400, "reason 不能为空")

    provider = LLMProvider.objects.filter(id=provider_id).first()
    if not provider:
        return error_response_with_status("NOT_FOUND", message=_("llm.channel_not_found"), status_code=404)
    before_snapshot = _serialize_provider(provider)

    reset_provider_health(provider)
    _invalidate_provider_related_cache(provider)

    after_snapshot = _serialize_provider(provider)
    _record_admin_audit(
        request,
        action="provider.runtime.reset",
        target_type="provider",
        target_id=str(provider.id),
        organization_id=provider.organization_id,
        provider_id=str(provider.id),
        before_data=before_snapshot,
        after_data=after_snapshot,
    )
    record_admin_sensitive_action(
        request,
        permission_code="provider:update",
        action="provider.runtime.reset_health",
        target_type="provider",
        target_id=str(provider.id),
        reason=reason,
        ticket_id=(payload.ticket_id or "").strip(),
        before_json={
            "provider_id": str(provider.id),
            "runtime_status": before_snapshot.get("runtime_status") or "unknown",
            "health_consecutive_failures": before_snapshot.get("health_consecutive_failures") or 0,
            "health_last_error": before_snapshot.get("health_last_error") or "",
        },
        after_json={
            "provider_id": str(provider.id),
            "runtime_status": after_snapshot.get("runtime_status") or "unknown",
            "health_consecutive_failures": after_snapshot.get("health_consecutive_failures") or 0,
            "health_last_error": after_snapshot.get("health_last_error") or "",
        },
    )

    return success_response(
        data={"provider": after_snapshot},
        message=_("llm.channel_health_reset"),
    )

@router.post("/admin/runtime/models/{model_id}/probe", auth=SuperuserAuth(), tags=["运行治理"])
@envelope_errors
def admin_probe_runtime_model(
    request,
    model_id: str,
):

    model = LLMModel.objects.select_related("provider").filter(id=model_id).first()
    if not model:
        return error_response_with_status("NOT_FOUND", message=_("llm.model_not_found"), status_code=404)

    provider = model.provider
    result = probe_provider_health(
        provider,
        check_type="manual",
        probe_model_name=model.model_name,
        extra_details={
            "model_id": str(model.id),
            "model_display_name": model.display_name,
        },
    )
    refreshed_provider = LLMProvider.objects.filter(id=provider.id).first() or provider
    _invalidate_provider_related_cache(refreshed_provider)

    _record_admin_audit(
        request,
        action="model.runtime.probe",
        target_type="model",
        target_id=str(model.id),
        organization_id=provider.organization_id,
        provider_id=str(provider.id),
        model_id=str(model.id),
        before_data={},
        after_data={
            "probe_success": bool((result.get("probe") or {}).get("is_success")),
            "provider_runtime_status": refreshed_provider.runtime_status,
            "probe_model_name": model.model_name,
        },
        extra_data={
            "probe": {
                **(result.get("probe") or {}),
                "diagnostic": result.get("diagnostic"),
            }
        },
    )

    return success_response(
        data={
            "model": _serialize_model(model),
            "provider": _serialize_provider(refreshed_provider),
            "probe": result,
        },
        message=_("llm.model_probe_done"),
    )

@router.post("/admin/providers", auth=SuperuserAuth(), tags=["管理员配置"])
@envelope_errors
def admin_create_provider(request, payload: AdminProviderCreateRequest):

    provider_name = (payload.name or "").strip().lower()
    if not provider_name:
        return error_response_with_status("BAD_REQUEST", message="name 不能为空", status_code=400)
    # 创建期以「代码注册表」为准（哪些 provider 类型有实现），而非运行时 DB-first
    # 口径——否则一个新注册但 DB 里还没有行的类型永远建不出来（鸡生蛋）。
    if not ProviderRegistry.is_registered(provider_name):
        allowed_provider_names = sorted(ProviderRegistry.all_metadata().keys())
        return error_response_with_status("BAD_REQUEST", message=f"name 必须是 {', '.join(allowed_provider_names)}", status_code=400)

    display_name = (payload.display_name or "").strip()
    if not display_name:
        return error_response_with_status("BAD_REQUEST", message="display_name 不能为空", status_code=400)

    scope = (payload.scope or "global").strip()
    organization_id = (payload.organization_id or "").strip() or None
    user_id = (payload.user_id or "").strip() or None
    _validate_provider_scope(scope, organization_id, user_id)

    provider_key = _normalize_provider_key(payload.provider_key or provider_name)
    normalized_base_url = _normalize_base_url(payload.base_url)

    duplicate_query = LLMProvider.objects.filter(
        scope=scope,
        organization_id=organization_id,
        user_id=user_id,
        provider_key=provider_key,
    )
    if duplicate_query.exists():
        return error_response_with_status("BAD_REQUEST", message=_("llm.channel_slug_exists"), status_code=400)

    duplicate_endpoint_query = LLMProvider.objects.filter(
        scope=scope,
        organization_id=organization_id,
        user_id=user_id,
        name=provider_name,
        default_base_url=normalized_base_url,
    )
    if duplicate_endpoint_query.exists():
        return error_response_with_status(
            "BAD_REQUEST",
            message=(
                "当前使用范围内已存在相同服务类型和 API 地址的渠道。"
                "请编辑现有渠道；如需增加密钥，请在现有渠道的“密钥”页添加。"
            ),
            status_code=400,
        )

    api_key = (payload.api_key or "").strip()
    if not api_key:
        return error_response_with_status("BAD_REQUEST", message="api_key 不能为空", status_code=400)

    # v0.1.x：capability_domains 来自 payload（强必填，至少 1 个域）。
    # 一个 Provider 可同时提供多个能力域（如阿里云账号同时承担 chat/embedding/vision）。
    capability_domains = [
        (d or "").strip().lower() for d in (payload.capability_domains or [])
    ]
    capability_domains = [d for d in capability_domains if d]
    if not capability_domains:
        return error_response_with_status(
            "BAD_REQUEST",
            message="capability_domains 至少需要 1 个能力域",
            status_code=400,
        )
    invalid_domains = [d for d in capability_domains if d not in _VALID_CAPABILITY_DOMAINS]
    if invalid_domains:
        return error_response_with_status(
            "BAD_REQUEST",
            message=(
                f"capability_domains 含非法值 {invalid_domains}，"
                f"必须从 {sorted(_VALID_CAPABILITY_DOMAINS)} 选取"
            ),
            status_code=400,
        )
    # 去重保序
    seen = set()
    capability_domains = [d for d in capability_domains if not (d in seen or seen.add(d))]

    provider = LLMProvider.objects.create(
        name=provider_name,
        provider_key=provider_key,
        display_name=display_name,
        default_base_url=normalized_base_url,
        api_key=api_key,
        capability_domains=capability_domains,
        scope=scope,
        organization_id=organization_id,
        user_id=user_id,
        # v0.1：is_active 字段已删；启用/禁用语义由 routing_enabled 表达。
        routing_enabled=getattr(payload, "routing_enabled", True),
        priority=payload.priority,
        rate_limit=payload.rate_limit,
    )
    _invalidate_provider_related_cache(provider)
    provider_snapshot = _serialize_provider(provider)
    _record_admin_audit(
        request,
        action="provider.create",
        target_type="provider",
        target_id=str(provider.id),
        organization_id=provider.organization_id,
        provider_id=str(provider.id),
        before_data={},
        after_data=provider_snapshot,
    )

    logger.info(
        "[LLM Admin] provider created",
        extra={
            "event": "llm.admin.provider.create",
            "provider_id": str(provider.id),
            "scope": provider.scope,
            "organization_id": provider.organization_id,
            "user_id": provider.user_id,
            "operator_id": str(request.auth.id),
        },
    )

    return success_response(
        data={"provider": provider_snapshot},
        message=_("llm.channel_created"),
    )

@router.put("/admin/providers/{provider_id}", auth=SuperuserAuth(), tags=["管理员配置"])
@envelope_errors
def admin_update_provider(request, provider_id: str, payload: AdminProviderUpdateRequest):

    provider = LLMProvider.objects.filter(id=provider_id).first()
    if not provider:
        return error_response_with_status("NOT_FOUND", message=_("llm.channel_not_found"), status_code=404)
    before_snapshot = _serialize_provider(provider)

    if payload.provider_key is not None:
        normalized_provider_key = _normalize_provider_key(payload.provider_key)
        duplicate_query = LLMProvider.objects.filter(
            scope=provider.scope,
            organization_id=provider.organization_id,
            user_id=provider.user_id,
            provider_key=normalized_provider_key,
        ).exclude(id=provider.id)
        if duplicate_query.exists():
            return error_response_with_status("BAD_REQUEST", message=_("llm.channel_slug_exists"), status_code=400)
        provider.provider_key = normalized_provider_key

    next_base_url = (
        _normalize_base_url(payload.base_url)
        if payload.base_url is not None
        else provider.default_base_url
    )
    duplicate_endpoint_query = LLMProvider.objects.filter(
        scope=provider.scope,
        organization_id=provider.organization_id,
        user_id=provider.user_id,
        name=provider.name,
        default_base_url=next_base_url,
    ).exclude(id=provider.id)
    if duplicate_endpoint_query.exists():
        return error_response_with_status(
            "BAD_REQUEST",
            message=(
                "当前使用范围内已存在相同服务类型和 API 地址的渠道。"
                "请编辑现有渠道；如需增加密钥，请在现有渠道的“密钥”页添加。"
            ),
            status_code=400,
        )

    if payload.display_name is not None:
        provider.display_name = payload.display_name.strip() or provider.display_name
    # 默认端点只影响后续新增模型，不覆盖既有模型。
    if payload.base_url is not None:
        provider.default_base_url = next_base_url
    if payload.api_key is not None and payload.api_key.strip():
        provider.api_key = payload.api_key.strip()
    if getattr(payload, "capability_domains", None) is not None:
        new_domains = [
            (d or "").strip().lower() for d in (payload.capability_domains or [])
        ]
        new_domains = [d for d in new_domains if d]
        if not new_domains:
            return error_response_with_status(
                "BAD_REQUEST",
                message="capability_domains 至少需要 1 个能力域",
                status_code=400,
            )
        invalid_domains = [d for d in new_domains if d not in _VALID_CAPABILITY_DOMAINS]
        if invalid_domains:
            return error_response_with_status(
                "BAD_REQUEST",
                message=(
                    f"capability_domains 含非法值 {invalid_domains}，"
                    f"必须从 {sorted(_VALID_CAPABILITY_DOMAINS)} 选取"
                ),
                status_code=400,
            )
        seen = set()
        new_domains = [d for d in new_domains if not (d in seen or seen.add(d))]
        # 缩减能力域时，必须保证下属 LLMModel.capability_domain 仍落在新集合内
        outliers = list(
            LLMModel.objects
            .filter(provider=provider)
            .exclude(capability_domain__in=new_domains)
            .values_list("model_name", "capability_domain")[:5]
        )
        if outliers:
            return error_response_with_status(
                "BAD_REQUEST",
                message=(
                    f"无法移除能力域：{outliers} 等模型的 capability_domain 不在新集合 "
                    f"{new_domains} 中。请先迁移这些模型或保留对应 domain。"
                ),
                status_code=400,
            )
        provider.capability_domains = new_domains
    routing_was_enabled = provider.routing_enabled
    # v0.1：is_active → routing_enabled。
    if getattr(payload, "routing_enabled", None) is not None:
        provider.routing_enabled = payload.routing_enabled
    if payload.priority is not None:
        provider.priority = payload.priority
    if payload.rate_limit is not None:
        provider.rate_limit = payload.rate_limit

    cleared_organization_default_refs = 0
    with transaction.atomic():
        provider.save()
        if routing_was_enabled and not provider.routing_enabled:
            model_ids = list(
                LLMModel.objects
                .filter(provider=provider)
                .values_list("id", flat=True)
            )
            cleared_organization_default_refs = _clear_organization_default_model_refs(
                [str(model_id) for model_id in model_ids]
            )
    _invalidate_provider_related_cache(provider)
    after_snapshot = _serialize_provider(provider)
    _record_admin_audit(
        request,
        action="provider.update",
        target_type="provider",
        target_id=str(provider.id),
        organization_id=provider.organization_id,
        provider_id=str(provider.id),
        before_data=before_snapshot,
        after_data=after_snapshot,
    )

    logger.info(
        "[LLM Admin] provider updated",
        extra={
            "event": "llm.admin.provider.update",
            "provider_id": str(provider.id),
            "operator_id": str(request.auth.id),
            "cleared_organization_default_refs": cleared_organization_default_refs,
        },
    )

    return success_response(
        data={"provider": after_snapshot},
        message=_("llm.channel_updated"),
    )

@router.delete("/admin/providers/{provider_id}", auth=AdminPermissionAuth("provider:delete"), tags=["管理员配置"])
@envelope_errors
def admin_delete_provider(
    request,
    provider_id: str,
    force: bool = False,
    reason: str = "",
    ticket_id: str = "",
):
    normalized_reason = (reason or "").strip()
    if not normalized_reason:
        raise HttpError(400, "reason 不能为空")

    provider = LLMProvider.objects.filter(id=provider_id).first()
    if not provider:
        return error_response_with_status("NOT_FOUND", message=_("llm.channel_not_found"), status_code=404)
    before_snapshot = _serialize_provider(provider)

    model_ids = list(LLMModel.objects.filter(provider=provider).values_list("id", flat=True))
    model_count = len(model_ids)
    if model_count > 0 and not force:
        return error_response_with_status("BAD_REQUEST", message=_("llm.channel_has_models", count=model_count), status_code=400)

    with transaction.atomic():
        cleared_refs = _clear_organization_default_model_refs([str(model_id) for model_id in model_ids])
        delete_result = _delete_provider_models(provider=provider, model_ids=model_ids)
        if delete_result["referencing_bindings"]:
            transaction.set_rollback(True)
            return error_response_with_status(
                "E14_MODEL_IN_USE",
                message=(
                    "该渠道下的模型仍被业务场景使用。请先在场景中心改绑其他模型，"
                    "再删除渠道。"
                ),
                status_code=409,
                data={"referencing_bindings": delete_result["referencing_bindings"]},
            )
        provider.delete()

    _invalidate_provider_related_cache(provider)
    _record_admin_audit(
        request,
        action="provider.delete",
        target_type="provider",
        target_id=provider_id,
        organization_id=before_snapshot.get("organization_id") or None,
        provider_id=provider_id,
        before_data=before_snapshot,
        after_data={},
        extra_data={
            "force": force,
            "deleted_models": model_count,
            "cleared_organization_default_refs": cleared_refs,
        },
    )
    record_admin_sensitive_action(
        request,
        permission_code="provider:delete",
        action="provider.delete",
        target_type="provider",
        target_id=provider_id,
        reason=normalized_reason,
        ticket_id=(ticket_id or "").strip(),
        before_json={
            "provider_id": provider_id,
            "display_name": before_snapshot.get("display_name") or "",
            "provider_key": before_snapshot.get("provider_key") or "",
            "status": before_snapshot.get("runtime_status") or "unknown",
            "model_count": model_count,
        },
        after_json={
            "provider_id": provider_id,
            "status": "deleted",
            "deleted_models": model_count,
        },
    )

    logger.info(
        "[LLM Admin] provider deleted",
        extra={
            "event": "llm.admin.provider.delete",
            "provider_id": provider_id,
            "deleted_models": model_count,
            "cleared_organization_default_refs": cleared_refs,
            "operator_id": str(request.auth.id),
        },
    )

    return success_response(
        data={
            "provider_id": provider_id,
            "deleted_models": model_count,
            "cleared_organization_default_refs": cleared_refs,
        },
        message=_("llm.channel_deleted"),
    )


# ============================================================
# v0.1 §1.2.3 / 5.3：管理员视角的多 Key 管理
# ============================================================
# 旧 /api/services/llm/organizations/{wid}/providers/{pid}/keys 是 organization 用户视角，
# AdminDash /ai/providers 直接走平台管理员（Superuser）视角，所以单独提供
# /admin/providers/:id/keys 系列端点；不依赖 organization 归属校验。


def _serialize_admin_key(key: LLMProviderKey) -> dict:
    """与 api_config._serialize_key 字段对齐；admin 路径同时返回 provider_id。"""
    api_key_status = "ok"
    try:
        api_key_value = getattr(key, "api_key", "") or ""
        api_key_preview = f"...{api_key_value[-4:]}" if len(api_key_value) > 4 else "***"
    except LLMCredentialDecryptionError:
        api_key_preview = "无法解密，请重新录入"
        api_key_status = "credential_decryption_failed"
    return {
        "id": str(key.id),
        "provider_id": str(key.provider_id),
        "label": key.label,
        "key_type": key.key_type,
        "is_usable": key.is_usable,
        "priority": key.priority,
        "last_used_at": key.last_used_at.isoformat() if key.last_used_at else None,
        "error_count": key.error_count,
        "cooldown_until": key.cooldown_until.isoformat() if key.cooldown_until else None,
        "disabled_until": key.disabled_until.isoformat() if key.disabled_until else None,
        "disabled_reason": key.disabled_reason,
        "total_requests": key.total_requests,
        "total_tokens": key.total_tokens,
        "api_key_preview": api_key_preview,
        "api_key_status": api_key_status,
        "created_at": key.created_at.isoformat() if key.created_at else None,
    }


@router.get("/admin/providers/{provider_id}/keys", auth=SuperuserAuth(), tags=["管理员配置"])
@envelope_errors
def admin_list_provider_keys(request, provider_id: str):
    """列出渠道下所有密钥（管理员视角，跨 organization）。"""
    provider = LLMProvider.objects.filter(id=provider_id).first()
    if not provider:
        return error_response_with_status("NOT_FOUND", message=_("llm.channel_not_found"), status_code=404)

    keys_list = list(
        LLMProviderKey.objects.filter(provider_id=provider_id).order_by("-priority", "created_at")
    )
    return success_response(
        data={
            "provider_id": str(provider.id),
            "keys": [_serialize_admin_key(k) for k in keys_list],
            "total": len(keys_list),
        },
    )


@router.post("/admin/providers/{provider_id}/keys", auth=SuperuserAuth(), tags=["管理员配置"])
@envelope_errors
def admin_create_provider_key(request, provider_id: str, payload: ProviderKeyCreateRequest):
    """添加新密钥（管理员视角）。"""
    provider = LLMProvider.objects.filter(id=provider_id).first()
    if not provider:
        return error_response_with_status("NOT_FOUND", message=_("llm.channel_not_found"), status_code=404)

    label = (payload.label or "").strip()
    if not label:
        return error_response_with_status("BAD_REQUEST", message="label 不能为空", status_code=400)

    api_key = (payload.api_key or "").strip()
    if not api_key:
        return error_response_with_status("BAD_REQUEST", message="api_key 不能为空", status_code=400)

    key = LLMProviderKey(
        provider=provider,
        label=label,
        key_type=payload.key_type or "api_key",
        priority=payload.priority,
    )
    key.api_key = api_key
    key.save()

    _record_admin_audit(
        request,
        action="provider_key.create",
        target_type="provider_key",
        target_id=str(key.id),
        organization_id=provider.organization_id,
        provider_id=str(provider.id),
        before_data={},
        after_data={
            "key_id": str(key.id),
            "label": key.label,
            "priority": key.priority,
        },
    )

    return success_response(data={"key": _serialize_admin_key(key)})


@router.put("/admin/providers/{provider_id}/keys/{key_id}", auth=SuperuserAuth(), tags=["管理员配置"])
@envelope_errors
def admin_update_provider_key(
    request,
    provider_id: str,
    key_id: str,
    payload: ProviderKeyUpdateRequest,
):
    """更新密钥（label / priority / api_key / 启用禁用）。"""
    provider = LLMProvider.objects.filter(id=provider_id).first()
    if not provider:
        return error_response_with_status("NOT_FOUND", message=_("llm.channel_not_found"), status_code=404)

    try:
        key = LLMProviderKey.objects.get(id=key_id, provider_id=provider_id)
    except LLMProviderKey.DoesNotExist:
        return error_response_with_status("NOT_FOUND", message="密钥不存在", status_code=404)

    before_snapshot = _serialize_admin_key(key)

    if payload.label is not None:
        new_label = payload.label.strip()
        if new_label:
            key.label = new_label
    if payload.api_key is not None and payload.api_key.strip():
        key.api_key = payload.api_key.strip()
    if payload.priority is not None:
        key.priority = payload.priority
    if getattr(payload, "is_active", None) is False:
        # v0.1：is_active 字段已删，is_active=False 映射为长期 disabled_until。
        key.disabled_until = timezone.now() + timedelta(days=3650)
        key.disabled_reason = "manual_disable"
    elif getattr(payload, "is_active", None) is True:
        key.disabled_until = None
        key.disabled_reason = ""
    key.save()

    after_snapshot = _serialize_admin_key(key)
    _record_admin_audit(
        request,
        action="provider_key.update",
        target_type="provider_key",
        target_id=str(key.id),
        organization_id=provider.organization_id,
        provider_id=str(provider.id),
        before_data=before_snapshot,
        after_data=after_snapshot,
    )
    return success_response(data={"key": after_snapshot})


@router.post(
    "/admin/providers/{provider_id}/keys/{key_id}/reset-error-count",
    auth=SuperuserAuth(),
    tags=["管理员配置"],
)
@envelope_errors
def admin_reset_provider_key_errors(request, provider_id: str, key_id: str):
    """重置密钥的 error_count / cooldown_until。"""
    provider = LLMProvider.objects.filter(id=provider_id).first()
    if not provider:
        return error_response_with_status("NOT_FOUND", message=_("llm.channel_not_found"), status_code=404)

    try:
        key = LLMProviderKey.objects.get(id=key_id, provider_id=provider_id)
    except LLMProviderKey.DoesNotExist:
        return error_response_with_status("NOT_FOUND", message="密钥不存在", status_code=404)

    before = {
        "error_count": key.error_count,
        "cooldown_until": key.cooldown_until.isoformat() if key.cooldown_until else None,
    }
    key.error_count = 0
    key.cooldown_until = None
    # 显式列入 updated_at：Django auto_now=True 字段在 update_fields 模式下不会自动刷新。
    key.save(update_fields=["error_count", "cooldown_until", "updated_at"])

    _record_admin_audit(
        request,
        action="provider_key.reset_errors",
        target_type="provider_key",
        target_id=str(key.id),
        organization_id=provider.organization_id,
        provider_id=str(provider.id),
        before_data=before,
        after_data={"error_count": 0, "cooldown_until": None},
    )
    return success_response(data={"key": _serialize_admin_key(key)})


@router.delete("/admin/providers/{provider_id}/keys/{key_id}", auth=AdminPermissionAuth("provider_key:delete"), tags=["管理员配置"])
@envelope_errors
def admin_delete_provider_key(
    request,
    provider_id: str,
    key_id: str,
    reason: str = "",
    ticket_id: str = "",
):
    """删除密钥。"""
    normalized_reason = (reason or "").strip()
    if not normalized_reason:
        raise HttpError(400, "reason 不能为空")
    provider = LLMProvider.objects.filter(id=provider_id).first()
    if not provider:
        return error_response_with_status("NOT_FOUND", message=_("llm.channel_not_found"), status_code=404)

    try:
        key = LLMProviderKey.objects.get(id=key_id, provider_id=provider_id)
    except LLMProviderKey.DoesNotExist:
        return error_response_with_status("NOT_FOUND", message="密钥不存在", status_code=404)

    snapshot = _serialize_admin_key(key)
    key.delete()
    _record_admin_audit(
        request,
        action="provider_key.delete",
        target_type="provider_key",
        target_id=key_id,
        organization_id=provider.organization_id,
        provider_id=str(provider.id),
        before_data=snapshot,
        after_data={},
    )
    record_admin_sensitive_action(
        request,
        permission_code="provider_key:delete",
        action="provider_key.delete",
        target_type="provider_key",
        target_id=key_id,
        reason=normalized_reason,
        ticket_id=(ticket_id or "").strip(),
        before_json={
            "key_id": key_id,
            "provider_id": provider_id,
            "masked_key": snapshot.get("api_key_preview") or "***",
            "status": "usable" if snapshot.get("is_usable") else "unusable",
            "created_at": snapshot.get("created_at"),
            "updated_at": None,
        },
        after_json={
            "key_id": key_id,
            "provider_id": provider_id,
            "masked_key": snapshot.get("api_key_preview") or "***",
            "status": "deleted",
            "created_at": snapshot.get("created_at"),
            "updated_at": None,
        },
    )
    return success_response(data={"key_id": key_id})


# ============================================================
# v0.1 §5.3：provider-types 端点（创建 Modal 的 type 下拉）
# ============================================================


@router.get("/admin/provider-types", auth=SuperuserAuth(), tags=["管理员配置"])
@envelope_errors
def admin_list_provider_types(request):
    """
    返回 ProviderRegistry 中所有已注册的 provider 类型清单（含默认 base_url 等元信息）。

    AdminDash /ai/providers 创建 Modal 用此端点填充 type 下拉。以「代码注册表」为准
    列出全部可创建类型，而非运行时 DB-first 口径——后者会把下拉框死在 DB 现有行上，
    导致新注册的 provider 类型无法从 UI 创建。同时复用 list_provider_profiles 的
    base_url / capability 字段，前端选好 type 即可一键回填 base_url。
    """
    metadata = ProviderRegistry.all_metadata()
    profiles = {p.get("provider"): p for p in list_provider_profiles(provider=None)}

    items = []
    for name in sorted(metadata.keys()):
        meta = metadata[name]
        profile = profiles.get(name) or {}
        items.append(
            {
                "name": name,
                "display_name": profile.get("display_name") or meta.get("display_name") or name.title(),
                "default_base_url": profile.get("recommended_base_url") or meta.get("default_base_url") or "",
                "supported_capabilities": list(
                    (profile.get("capabilities") or {}).keys()
                ),
                "api_style": profile.get("api_style") or meta.get("sdk_type") or "",
                "notes": profile.get("notes") or [],
                "capability_domains": meta.get("capability_domains") or [],
                "recommended_capability_domains": _normalize_registry_capability_domains(
                    meta.get("capability_domains") or [],
                ),
            }
        )

    return success_response(
        data={
            "provider_types": items,
            "total": len(items),
        },
    )
