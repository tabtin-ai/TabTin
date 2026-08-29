"""LLM 管理员 API — Model 管理（CRUD + 组织模型管理）。"""

from typing import Optional, List, Dict, Any
import logging

from django.db import transaction
from django.db.models import Q, Count
from django.utils import timezone
from ninja import Router
from pydantic import BaseModel, ConfigDict, Field

from apps.i18n import _
from apps.i18n.response import success_response, error_response_with_status
from apps.users.auth.permissions import SuperuserAuth
from apps.tabtinspace.models import Organization

from .api_common import (
    envelope_errors,
    _get_organization_default_model_id,
    _extract_token_limits,
    validate_model_endpoint_host,
)
from .models import LLMProvider, LLMModel, LLMSceneBinding
from .schemas import (
    OrganizationDefaultModelRequest,
    AdminModelCreateRequest,
    AdminModelUpdateRequest,
    ChatMessage,
)
from .services import get_available_models, get_llm_service, invalidate_models_cache
from .services.litellm_model_info import LiteLLMModelInfoService
from .providers.model_metadata import merge_authoritative_model_capabilities
from .utils.capabilities import resolve_model_capabilities, resolve_model_limits
from .api_admin_utils import (
    _record_admin_audit,
    _serialize_model,
    _clear_organization_default_model_refs,
    _invalidate_model_related_cache,
)

logger = logging.getLogger(__name__)

router = Router()


# ─────────────────────────────────────────────────────────────────────────────
# capabilities_config 字段集校验
#
# 按 capability_domain 校验 capabilities_config 顶层必须包含的子键。
#
# 这里只做"关键子键存在性"的最小校验——具体字段类型 / 取值由 Wire Adapter
# 阶段的 _validate_capabilities 负责（v0.1 只做 warning）。
# ─────────────────────────────────────────────────────────────────────────────

# 每个 domain 在 capabilities_config 顶层必须出现的关键子键（缺即 422）。
_DOMAIN_REQUIRED_SUBKEYS: Dict[str, List[str]] = {
    "chat": ["wire"],
    "vision": ["wire"],
    "embedding": ["embedding"],
    "asr": ["speech"],
    "tts": ["speech"],
    "image_gen": ["media_gen"],
    "video_gen": ["media_gen"],
    "audio_gen": ["media_gen"],
}


def _validate_capabilities_config_for_domain(
    capability_domain: str,
    capabilities_config: Optional[Dict[str, Any]],
) -> Optional[str]:
    """按 capability_domain 校验 capabilities_config 顶层必填子键。

    返回 None=通过；返回 str=错误信息（用于 422 响应）。

    设计取舍：
    - 空 dict 不报错（允许创建后再补填，但运行时 capability_match 会拦下）
    - 必填子键存在即可，子键内字段完整性由更下游负责
    - chat/vision domain 共用 'wire' 顶层（包含 request_protocol 等），运行时差异
      靠 capability_domain 路由
    """
    if not capabilities_config:
        return None
    required = _DOMAIN_REQUIRED_SUBKEYS.get(capability_domain)
    if not required:
        return f"未知 capability_domain: {capability_domain}"
    missing = [k for k in required if k not in capabilities_config]
    if missing:
        return (
            f"capabilities_config 缺少 capability_domain={capability_domain} "
            f"要求的顶层子键: {', '.join(missing)}（参考宪法 04 §2.1）"
        )
    return None


@router.get("/admin/models", auth=SuperuserAuth(), tags=["管理员配置"])
@envelope_errors
def admin_list_models(
    request,
    provider_id: Optional[str] = None,
    provider_scope: Optional[str] = None,
    organization_id: Optional[str] = None,
    include_global_for_organization: bool = False,
    include_inactive: bool = True,
    keyword: Optional[str] = None,
    domain: Optional[str] = None,
    limit: int = 200,
):

    limit_value = max(1, min(limit, 500))
    query = LLMModel.objects.select_related("provider").all().order_by("-updated_at")

    if provider_id:
        query = query.filter(provider_id=provider_id)

    normalized_provider_scope = (provider_scope or "").strip() or None
    if normalized_provider_scope and normalized_provider_scope not in {"global", "organization", "user"}:
        return error_response_with_status("BAD_REQUEST", message="provider_scope 必须为 global / workspace / user", status_code=400)
    if include_global_for_organization and not organization_id:
        return error_response_with_status("BAD_REQUEST", message="include_global_for_organization=true 时 organization_id 必填", status_code=400)

    # v0.1：domain 参数对应 capability_domain，用于 ai/models Tab 切换（宪法 07 §1.3）。
    normalized_domain = (domain or "").strip() or None
    if normalized_domain:
        valid_domains = {"chat", "embedding", "vision", "asr", "tts", "image_gen", "video_gen", "audio_gen"}
        if normalized_domain not in valid_domains:
            return error_response_with_status(
                "BAD_REQUEST",
                message=f"domain 必须是 8 个 capability_domain 之一: {sorted(valid_domains)}",
                status_code=400,
            )
        query = query.filter(capability_domain=normalized_domain)

    include_organization_union = bool(
        include_global_for_organization and organization_id and normalized_provider_scope in {None, "organization"}
    )
    if include_organization_union:
        query = query.filter(
            Q(provider__scope="global")
            | Q(provider__scope="organization", provider__organization_id=organization_id)
        )
    else:
        if normalized_provider_scope:
            query = query.filter(provider__scope=normalized_provider_scope)
        if organization_id:
            query = query.filter(provider__organization_id=organization_id)
    # v0.1：is_active 字段已删（0022）；include_inactive 形参兼容期保留但不再过滤。
    # 路由是否参与新调用由 LLMProvider.routing_enabled 表达，下线模型直接删行。
    # 注意：不要写 `_ = include_inactive`——会把同名 i18n 函数 _ 覆盖成 bool。
    del include_inactive

    normalized_keyword = (keyword or "").strip()
    if normalized_keyword:
        query = query.filter(
            Q(model_name__icontains=normalized_keyword)
            | Q(display_name__icontains=normalized_keyword)
            | Q(provider__name__icontains=normalized_keyword)
            | Q(provider__display_name__icontains=normalized_keyword)
            | Q(provider__provider_key__icontains=normalized_keyword)
        )

    models = list(query[:limit_value])

    # 一次性聚合 related_scenes_count，避免 _serialize_model 内 N+1 查询。
    model_ids = [m.id for m in models]
    binding_counts: Dict[str, int] = {}
    if model_ids:
        for row in LLMSceneBinding.objects.filter(
            primary_model_id__in=model_ids,
        ).values("primary_model_id").annotate(cnt=Count("id")):
            binding_counts[str(row["primary_model_id"])] = int(row["cnt"])

    model_items = [
        _serialize_model(model, related_scenes_count=binding_counts.get(str(model.id), 0))
        for model in models
    ]

    return success_response(
        data={
            "models": model_items,
            "total": query.count(),
            "returned": len(model_items),
        },
        message=_("llm.model_list_success"),
    )

@router.post("/admin/models", auth=SuperuserAuth(), tags=["管理员配置"])
@envelope_errors
def admin_create_model(request, payload: AdminModelCreateRequest):

    model_name = (payload.model_name or "").strip()
    if not model_name:
        return error_response_with_status("BAD_REQUEST", message="model_name 不能为空", status_code=400)
    display_name = (payload.display_name or "").strip() or model_name

    provider = LLMProvider.objects.filter(id=payload.provider_id).first()
    if not provider:
        return error_response_with_status("NOT_FOUND", message=_("llm.channel_not_found"), status_code=404)

    if LLMModel.objects.filter(provider=provider, model_name=model_name).exists():
        return error_response_with_status("BAD_REQUEST", message=_("llm.model_name_exists"), status_code=400)

    # v0.1：模型 capability_domain 必须落在 provider.capability_domains 集合内
    # （启动校验同源）。supports_streaming / supports_function_calling / supports_vision /
    # max_image_* 等"硬开关字段"统一进 capabilities_config
    provider_caps = list(provider.capability_domains or [])
    capability_domain = (
        getattr(payload, "capability_domain", None)
        or (provider_caps[0] if provider_caps else "")
    )
    if capability_domain not in provider_caps:
        # 与 capabilities_config 字段集校验保持同一错误码族（E16 + 422）：
        # 运营在前端要么改 capability_domain、要么扩 provider.capability_domains，
        # 处理路径与"capabilities_config 缺顶层子键"完全一致；422 也比 400 更准确——
        # 这是语义层校验失败，不是输入格式错。
        return error_response_with_status(
            "E16_CAPABILITY_MISMATCH",
            message=(
                f"capability_domain 与 provider 不一致：model={capability_domain} "
                f"provider.capability_domains={provider_caps}"
            ),
            status_code=422,
        )

    # v0.1：capabilities_config 字段集按 capability_domain 校验（宪法 04 §2.1）。
    # 不通过 → 422，避免 model 创建后 SceneBinding 校验时才发现。
    requested_capabilities_config = payload.capabilities_config or {}
    cap_error = _validate_capabilities_config_for_domain(
        capability_domain, requested_capabilities_config
    )
    capabilities_config_payload = merge_authoritative_model_capabilities(
        provider_name=provider.name,
        provider_scope=provider.scope,
        model_name=model_name,
        capabilities_config=requested_capabilities_config,
    )
    if cap_error:
        return error_response_with_status(
            "E16_CAPABILITY_MISMATCH",
            message=cap_error,
            status_code=422,
        )

    # 模型可显式覆盖；省略时继承渠道默认端点。
    new_base_url = (
        (getattr(payload, "base_url", "") or "").strip()
        or (provider.default_base_url or "").strip()
    )
    if not new_base_url:
        return error_response_with_status(
            "BAD_REQUEST",
            message="base_url 不能为空：请填写模型端点或先配置渠道默认端点",
            status_code=400,
        )
    host_mismatch = validate_model_endpoint_host(provider, new_base_url)
    if host_mismatch:
        return error_response_with_status(
            "MODEL_ENDPOINT_HOST_MISMATCH",
            message=host_mismatch,
            status_code=400,
        )
    model = LLMModel.objects.create(
        provider=provider,
        model_name=model_name,
        display_name=display_name,
        description=payload.description or "",
        capability_domain=capability_domain,
        base_url=new_base_url,
        context_window_tokens=payload.context_window_tokens,
        max_input_tokens=payload.max_input_tokens,
        max_output_tokens=payload.max_output_tokens,
        capabilities_config=capabilities_config_payload,
        billing_type=payload.billing_type,
        input_price_per_1k=payload.input_price_per_1k,
        output_price_per_1k=payload.output_price_per_1k,
        price_per_request=payload.price_per_request,
        price_per_second=payload.price_per_second,
        custom_billing_config=payload.custom_billing_config or {},
    )
    _invalidate_model_related_cache(model)
    model_snapshot = _serialize_model(model)
    _record_admin_audit(
        request,
        action="model.create",
        target_type="model",
        target_id=str(model.id),
        organization_id=provider.organization_id,
        provider_id=str(provider.id),
        model_id=str(model.id),
        before_data={},
        after_data=model_snapshot,
    )

    logger.info(
        "[LLM Admin] model created",
        extra={
            "event": "llm.admin.model.create",
            "model_id": str(model.id),
            "provider_id": str(provider.id),
            "operator_id": str(request.auth.id),
        },
    )

    return success_response(
        data={"model": model_snapshot},
        message=_("llm.model_created"),
    )

def _do_admin_update_model(request, model_id: str, payload: AdminModelUpdateRequest):
    """共享实现：PUT 与 PATCH 走同一份业务逻辑。"""

    model = LLMModel.objects.select_related("provider").filter(id=model_id).first()
    if not model:
        return error_response_with_status("NOT_FOUND", message=_("llm.model_not_found"), status_code=404)
    before_snapshot = _serialize_model(model)

    if payload.model_name is not None:
        normalized_model_name = payload.model_name.strip()
        if normalized_model_name and normalized_model_name != model.model_name:
            if LLMModel.objects.filter(
                provider=model.provider,
                model_name=normalized_model_name,
            ).exclude(id=model.id).exists():
                return error_response_with_status("BAD_REQUEST", message=_("llm.model_name_exists"), status_code=400)
            model.model_name = normalized_model_name

    if payload.display_name is not None:
        model.display_name = payload.display_name.strip() or model.display_name
    if payload.description is not None:
        model.description = payload.description
    # v0.1.x Phase 2.5：允许编辑 base_url（dashscope 同账号不同 model 走不同 endpoint 必备）
    if getattr(payload, "base_url", None) is not None:
        _new_base_url = (payload.base_url or "").strip()
        if not _new_base_url:
            return error_response_with_status(
                "BAD_REQUEST",
                message="base_url 不能为空",
                status_code=400,
            )
        host_mismatch = validate_model_endpoint_host(
            model.provider,
            _new_base_url,
            exclude_model_id=model.id,
        )
        if host_mismatch:
            return error_response_with_status(
                "MODEL_ENDPOINT_HOST_MISMATCH",
                message=host_mismatch,
                status_code=400,
            )
        model.base_url = _new_base_url
    if getattr(payload, "capability_domain", None) is not None:
        provider_caps = list(model.provider.capability_domains or [])
        if payload.capability_domain not in provider_caps:
            # v0.1 强约束：model.capability_domain 必须落在 provider.capability_domains 集合内
            return error_response_with_status(
                "E16_CAPABILITY_MISMATCH",
                message=(
                    f"capability_domain 与 provider 不一致：model={payload.capability_domain} "
                    f"provider.capability_domains={provider_caps}"
                ),
                status_code=422,
            )
        model.capability_domain = payload.capability_domain
    if payload.context_window_tokens is not None:
        model.context_window_tokens = payload.context_window_tokens
    if payload.max_input_tokens is not None:
        model.max_input_tokens = payload.max_input_tokens
    if payload.max_output_tokens is not None:
        model.max_output_tokens = payload.max_output_tokens
    if payload.capabilities_config is not None:
        # v0.1：更新前按 capability_domain 校验字段集（宪法 04 §2.1）。
        # 用更新后的最终 capability_domain 校验（既支持同请求中改了 capability_domain，
        # 也覆盖只改 capabilities_config 的常规情况）。
        cap_error = _validate_capabilities_config_for_domain(
            model.capability_domain, payload.capabilities_config
        )
        if cap_error:
            return error_response_with_status(
                "E16_CAPABILITY_MISMATCH",
                message=cap_error,
                status_code=422,
            )
        model.capabilities_config = payload.capabilities_config
    model.capabilities_config = merge_authoritative_model_capabilities(
        provider_name=model.provider.name,
        provider_scope=model.provider.scope,
        model_name=model.model_name,
        capabilities_config=model.capabilities_config,
    )
    if payload.billing_type is not None:
        model.billing_type = payload.billing_type
    if payload.input_price_per_1k is not None:
        model.input_price_per_1k = payload.input_price_per_1k
    if payload.output_price_per_1k is not None:
        model.output_price_per_1k = payload.output_price_per_1k
    if payload.price_per_request is not None:
        model.price_per_request = payload.price_per_request
    if payload.price_per_second is not None:
        model.price_per_second = payload.price_per_second
    if payload.custom_billing_config is not None:
        model.custom_billing_config = payload.custom_billing_config
    # v0.1：模型 is_active 字段已删，下线模型直接 DELETE；
    # 启用/禁用语义由 wave_status='ready' 推导。

    model.save()
    _invalidate_model_related_cache(model)
    after_snapshot = _serialize_model(model)
    _record_admin_audit(
        request,
        action="model.update",
        target_type="model",
        target_id=str(model.id),
        organization_id=model.provider.organization_id,
        provider_id=str(model.provider.id),
        model_id=str(model.id),
        before_data=before_snapshot,
        after_data=after_snapshot,
    )

    logger.info(
        "[LLM Admin] model updated",
        extra={
            "event": "llm.admin.model.update",
            "model_id": str(model.id),
            "operator_id": str(request.auth.id),
        },
    )

    return success_response(
        data={"model": after_snapshot},
        message=_("llm.model_updated"),
    )


@router.put("/admin/models/{model_id}", auth=SuperuserAuth(), tags=["管理员配置"])
@envelope_errors
def admin_update_model_put(request, model_id: str, payload: AdminModelUpdateRequest):
    """PUT 兼容入口（旧 admindash llm-admin.tsx 使用）。"""
    return _do_admin_update_model(request, model_id, payload)


@router.patch("/admin/models/{model_id}", auth=SuperuserAuth(), tags=["管理员配置"])
@envelope_errors
def admin_update_model_patch(request, model_id: str, payload: AdminModelUpdateRequest):
    """PATCH 入口（v0.1 AdminDash AI 能力组使用，宪法 07 §5.4）。"""
    return _do_admin_update_model(request, model_id, payload)


@router.get("/admin/models/{model_id}/capability-profile", auth=SuperuserAuth(), tags=["管理员配置"])
@envelope_errors
def admin_get_model_capability_profile(request, model_id: str):
    """模型 capability profile（宪法 07 §5.4）。

    v0.1 只返回 declared 字段（capabilities_config + resolved_capabilities + resolved_limits），
    不再做 nightly drift 检测（旧 LLMCapabilityDrift 表已删）。
    """
    model = LLMModel.objects.select_related("provider").filter(id=model_id).first()
    if not model:
        return error_response_with_status(
            "NOT_FOUND", message=_("llm.model_not_found"), status_code=404,
        )

    return success_response(
        data={
            "model_id": str(model.id),
            "model_name": model.model_name,
            "display_name": model.display_name,
            "capability_domain": model.capability_domain,
            "declared": {
                "capabilities_config": model.capabilities_config or {},
                "context_window_tokens": model.context_window_tokens,
                "max_input_tokens": model.max_input_tokens_resolved,
                "max_output_tokens": model.max_output_tokens_resolved,
                "billing_type": model.billing_type,
                "input_price_per_1k": float(model.input_price_per_1k),
                "output_price_per_1k": float(model.output_price_per_1k),
            },
            "resolved_capabilities": resolve_model_capabilities(model),
            "resolved_limits": resolve_model_limits(model),
        },
        message=_("llm.model_list_success"),
    )


@router.delete("/admin/models/{model_id}", auth=SuperuserAuth(), tags=["管理员配置"])
@envelope_errors
def admin_delete_model(request, model_id: str):

    model = LLMModel.objects.select_related("provider").filter(id=model_id).first()
    if not model:
        return error_response_with_status("NOT_FOUND", message=_("llm.model_not_found"), status_code=404)

    # v0.1：LLMSceneBinding.primary_model FK 是 on_delete=PROTECT（migration 0022），
    # 直接 model.delete() 触发 ProtectedError → 500。
    # 删除前 pre-check：有 binding 引用 → 友好返回 409，要求运营先把这些 Scene 改绑别的模型。
    # 设计取舍：不主动 SET_NULL（那会让 binding 变成"未配置"运行时直接抛 E13_NO_BINDING）；
    # 让运营显式去 Scenes 页面改绑，是更安全的双重确认。
    referencing_bindings = list(
        LLMSceneBinding.objects.filter(primary_model_id=model.id)
        .values("scene_key", "display_name")[:20]
    )
    if referencing_bindings:
        return error_response_with_status(
            "E14_MODEL_IN_USE",
            message=(
                f"模型被 {len(referencing_bindings)} 个 Scene 作为 primary_model 引用，"
                f"必须先在 /ai/scenes 把这些 Scene 改绑其他模型才能删除。"
            ),
            status_code=409,
            data={"referencing_bindings": referencing_bindings},
        )

    before_snapshot = _serialize_model(model, related_scenes_count=0)

    with transaction.atomic():
        cleared_refs = _clear_organization_default_model_refs([str(model.id)])
        model.delete()

    _invalidate_model_related_cache(model)
    _record_admin_audit(
        request,
        action="model.delete",
        target_type="model",
        target_id=model_id,
        organization_id=before_snapshot.get("provider_organization_id") or None,
        provider_id=before_snapshot.get("provider_id"),
        model_id=model_id,
        before_data=before_snapshot,
        after_data={},
        extra_data={"cleared_organization_default_refs": cleared_refs},
    )

    logger.info(
        "[LLM Admin] model deleted",
        extra={
            "event": "llm.admin.model.delete",
            "model_id": model_id,
            "cleared_organization_default_refs": cleared_refs,
            "operator_id": str(request.auth.id),
        },
    )

    return success_response(
        data={
            "model_id": model_id,
            "cleared_organization_default_refs": cleared_refs,
        },
        message=_("llm.model_deleted"),
    )

@router.get("/admin/organizations/{organization_id}/models", auth=SuperuserAuth(), tags=["管理员配置"])
@envelope_errors
def admin_get_organization_available_models(
    request,
    organization_id: str,
    include_inactive: bool = False,
):

    organization = Organization.objects.filter(id=organization_id).first()
    if not organization:
        return error_response_with_status("NOT_FOUND", message=_("llm.organization_not_found"), status_code=404)

    models = get_available_models(
        user_id=None,
        organization_id=organization_id,
        include_inactive=include_inactive,
    )
    default_model_id = _get_organization_default_model_id(organization_id)

    return success_response(
        data={
            "organization_id": organization_id,
            "default_model_id": default_model_id,
            "models": [
                {
                    **model,
                    "is_default": model.get("id") == default_model_id,
                }
                for model in models
            ],
            "total": len(models),
        },
        message=_("llm.organization_model_list_success"),
    )

@router.put(
    "/admin/organizations/{organization_id}/default-model",
    auth=SuperuserAuth(),
    tags=["管理员配置"],
)
@envelope_errors
def admin_set_organization_default_model(
    request,
    organization_id: str,
    payload: OrganizationDefaultModelRequest,
):

    organization = Organization.objects.filter(id=organization_id).first()
    if not organization:
        return error_response_with_status("NOT_FOUND", message=_("llm.organization_not_found"), status_code=404)

    model = LLMModel.objects.select_related("provider").filter(
        id=payload.model_id,
        provider__routing_enabled=True,
        wave_status="ready",
    ).first()
    if not model:
        return error_response_with_status("NOT_FOUND", message=_("llm.model_not_found_or_disabled"), status_code=404)

    if model.capability_domain != "chat":
        return error_response_with_status(
            "BAD_REQUEST",
            message="默认模型必须是 chat capability_domain 模型",
            status_code=400,
        )

    provider = model.provider
    if provider.scope == "user":
        return error_response_with_status("BAD_REQUEST", message=_("llm.personal_model_no_default"), status_code=400)
    if provider.scope == "organization" and provider.organization_id != organization_id:
        return error_response_with_status("BAD_REQUEST", message=_("llm.model_not_in_organization"), status_code=400)

    settings = organization.settings or {}
    before_default_model_id = settings.get("llm_default_model_id")
    settings["llm_default_model_id"] = str(model.id)
    organization.settings = settings
    organization.save(update_fields=["settings", "updated_at"])
    invalidate_models_cache(organization_id=organization_id)
    _record_admin_audit(
        request,
        action="organization.default_model.set",
        target_type="organization",
        target_id=organization_id,
        organization_id=organization_id,
        provider_id=str(provider.id),
        model_id=str(model.id),
        before_data={
            "default_model_id": before_default_model_id,
        },
        after_data={
            "default_model_id": str(model.id),
            "default_model_name": model.model_name,
        },
        extra_data={
            "provider_scope": provider.scope,
            "provider_key": provider.provider_key,
        },
    )

    logger.info(
        "[LLM Admin] organization default model updated",
        extra={
            "event": "llm.admin.organization.default_model.update",
            "organization_id": organization_id,
            "model_id": str(model.id),
            "operator_id": str(request.auth.id),
        },
    )

    return success_response(
        data={
            "organization_id": organization_id,
            "default_model_id": str(model.id),
            "default_model_name": model.model_name,
        },
        message=_("llm.default_model_set"),
    )

@router.delete(
    "/admin/organizations/{organization_id}/default-model",
    auth=SuperuserAuth(),
    tags=["管理员配置"],
)
@envelope_errors
def admin_clear_organization_default_model(
    request,
    organization_id: str,
):

    organization = Organization.objects.filter(id=organization_id).first()
    if not organization:
        return error_response_with_status("NOT_FOUND", message=_("llm.organization_not_found"), status_code=404)

    settings = organization.settings or {}
    before_default_model_id = settings.get("llm_default_model_id")
    changed = bool(before_default_model_id)

    settings.pop("llm_default_model_id", None)
    organization.settings = settings
    organization.save(update_fields=["settings", "updated_at"])
    invalidate_models_cache(organization_id=organization_id)

    if changed:
        _record_admin_audit(
            request,
        action="organization.default_model.clear",
        target_type="organization",
            target_id=organization_id,
            organization_id=organization_id,
            model_id=str(before_default_model_id),
            before_data={
                "default_model_id": before_default_model_id,
            },
            after_data={
                "default_model_id": None,
            },
        )

    logger.info(
        "[LLM Admin] organization default model cleared",
        extra={
            "event": "llm.admin.organization.default_model.clear",
            "organization_id": organization_id,
            "cleared_default_model_id": before_default_model_id,
            "operator_id": str(request.auth.id),
        },
    )

    return success_response(
        data={
            "organization_id": organization_id,
            "default_model_id": None,
            "changed": changed,
        },
        message=_("llm.default_model_cleared") if changed else _("llm.default_model_already_empty"),
    )


# ============ 平台级工具（无需 organization_id） ============


@router.get("/admin/search-models", auth=SuperuserAuth(), tags=["管理员配置"])
@envelope_errors
def admin_search_models(
    request,
    keyword: str,
    limit: int = 30,
):
    """搜索 LiteLLM 模型信息库（平台级，无需 organization_id）。"""
    normalized = (keyword or "").strip()
    if not normalized:
        return error_response_with_status("BAD_REQUEST", message="keyword 不能为空", status_code=400)

    results = LiteLLMModelInfoService.search_models(normalized)
    model_items = []
    for model_name, model_info in list(results.items())[: max(1, min(limit, 100))]:
        token_limits = _extract_token_limits(model_info or {})
        cache_pricing = LiteLLMModelInfoService.extract_prompt_cache_pricing(model_info or {})
        # LiteLLM 元数据用第三方 schema（仍含 mode/supports_vision），仅作搜索回填来源；
        # 业务侧落库时由 admin_create_model 转换到 capability_domain + capabilities_config。
        model_items.append({
            "name": model_name,
            "provider": model_info.get("litellm_provider"),
            "litellm_mode": model_info.get("mode"),
            "litellm_supports_vision": model_info.get("supports_vision", False),
            "context_window_tokens": token_limits.get("context_window_tokens"),
            "max_input_tokens": token_limits.get("max_input_tokens"),
            "max_output_tokens": token_limits.get("max_output_tokens"),
            "cache_read_input_price_per_1k": cache_pricing.get("cache_read_input_price_per_1k"),
            "cache_write_input_price_per_1k": cache_pricing.get("cache_write_input_price_per_1k"),
        })

    return success_response(
        data={"models": model_items, "total": len(model_items)},
        message=_("llm.model_list_success"),
    )


class AdminTokenEstimateRequest(BaseModel):
    """管理员 Token 估算请求（平台级，无需 organization_id）。"""
    model_config = ConfigDict(protected_namespaces=())

    model_id: str = Field(..., description="模型 UUID")
    messages: List[ChatMessage] = Field(..., description="消息列表")
    prefer_provider_api: bool = Field(True, description="优先使用渠道原生估算接口")


@router.post("/admin/estimate-tokens", auth=SuperuserAuth(), tags=["管理员配置"])
@envelope_errors
def admin_estimate_tokens(request, payload: AdminTokenEstimateRequest):
    """Token 估算（平台级，直接按 model_id 查找，无需 organization_id）。"""
    model_instance = LLMModel.objects.select_related("provider").filter(
        id=payload.model_id,
    ).first()
    if not model_instance:
        return error_response_with_status("NOT_FOUND", message=_("llm.model_not_found"), status_code=404)

    llm_service = get_llm_service(model_id=str(model_instance.id))
    messages = [msg.dict() for msg in payload.messages]
    estimate = llm_service.estimate_tokens(
        messages=messages,
        prefer_provider_api=payload.prefer_provider_api,
    )

    billing_type = model_instance.billing_type or "token"
    estimated_cost = None
    cost_unavailable_reason = None
    if billing_type == "token":
        cost = llm_service._calculate_cost_from_usage({
            "input_tokens": estimate.get("input_tokens", 0),
            "output_tokens": 0,
            "total_tokens": estimate.get("total_tokens", 0),
        })
        estimated_cost = {
            "input_cost": float(cost.get("input_cost", 0)),
            "output_cost": float(cost.get("output_cost", 0)),
            "total_cost": float(cost.get("total_cost", 0)),
        }
    else:
        cost_unavailable_reason = f"billing_type '{billing_type}' does not support token-based cost estimation"

    return success_response(
        data={
            "model_id": str(model_instance.id),
            "model_name": model_instance.model_name,
            "provider": model_instance.provider.name,
            "billing_type": billing_type,
            "estimate": estimate,
            "estimated_cost": estimated_cost,
            "cost_unavailable_reason": cost_unavailable_reason,
        },
        message="Token estimation successful",
    )
