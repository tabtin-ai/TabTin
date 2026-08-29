"""
LLM 用户配置 & 组织配置（Provider / Model CRUD）
"""

from ninja import Router
from typing import Optional
from django.conf import settings
from django.db import transaction
from django.db.models import Q, Count, OuterRef, Subquery
import logging

from apps.i18n import get_text, _
from apps.i18n.response import success_response, error_response_with_status
from apps.users.auth.permissions import JWTAuth
from apps.tabtinspace.services import OrganizationService

from .api_common import (
    envelope_errors,
    _normalize_provider_key,
    _normalize_base_url,
    validate_model_endpoint_host,
    _get_organization_default_model_id,
    _read_user_default_model_id,
    _write_user_default_model_id,
    _clear_user_default_model_id,
    _read_user_subagent_model_id,
    _read_user_subagent_model_policy,
    _write_user_subagent_model_policy,
    _clear_user_subagent_model_policy,
    _write_user_subagent_model_id,
    _clear_user_subagent_model_id,
    _get_organization_subagent_model_policy,
    _clear_organization_default_model_id,
    _clear_organization_subagent_model_id,
    _serialize_organization_subagent_model_policy,
)
from .schemas import (
    ProviderConfigRequest,
    OrganizationProviderCreateRequest, OrganizationProviderUpdateRequest,
    OrganizationModelCreateRequest, OrganizationModelUpdateRequest,
    OrganizationDefaultModelRequest,
    UserDefaultModelRequest,
    OrganizationSubagentModelRequest,
    ProviderKeyCreateRequest, ProviderKeyUpdateRequest,
)
from .services import get_available_models, invalidate_models_cache
from .models import LLMProvider, LLMModel, LLMProviderKey
from .permissions import ensure_self_user_id, ensure_organization_permission
from .utils.custom_model_capabilities import (
    ensure_custom_chat_json_capability,
    ensure_known_provider_chat_capabilities,
    resolve_known_provider_chat_max_output_tokens,
)
from .utils.known_byok_capabilities import ensure_known_byok_wire_capability

logger = logging.getLogger(__name__)

router = Router()

jwt_auth = JWTAuth()

def can_use_as_organization_default(
    organization,
    model: LLMModel,
    *,
    actor_user_id: str,
) -> bool:
    """默认模型 scope 单一判定：个人用本人 BYOK，团队用本组织 BYOK。"""
    provider = getattr(model, "provider", None)
    if provider is None:
        return False
    if getattr(model, "capability_domain", "") != "chat":
        return False
    if getattr(model, "wave_status", "ready") != "ready":
        return False
    if not getattr(provider, "routing_enabled", False):
        return False

    scope = str(getattr(provider, "scope", "") or "")
    if scope == "global":
        return True

    organization_type = str(getattr(organization, "type", "") or "")
    organization_id = str(getattr(organization, "id", "") or "")
    if scope == "user":
        return (
            organization_type == "personal"
            and str(getattr(provider, "user_id", "") or "") == str(actor_user_id)
        )
    if scope == "organization":
        return str(getattr(provider, "organization_id", "") or "") == organization_id
    return False


def can_use_as_user_default(
    organization,
    model: LLMModel,
    *,
    actor_user_id: str,
) -> bool:
    """个人默认模型判定：当前用户可选全局、本组织 BYOK、本人 BYOK。"""
    provider = getattr(model, "provider", None)
    if provider is None:
        return False
    if getattr(model, "capability_domain", "") != "chat":
        return False
    if getattr(model, "wave_status", "ready") != "ready":
        return False
    if not getattr(provider, "routing_enabled", False):
        return False

    scope = str(getattr(provider, "scope", "") or "")
    if scope == "global":
        return True

    organization_id = str(getattr(organization, "id", "") or "")
    if scope == "organization":
        return str(getattr(provider, "organization_id", "") or "") == organization_id
    if scope == "user":
        return str(getattr(provider, "user_id", "") or "") == str(actor_user_id)
    return False


def _catalog_model_can_use_as_default(organization, model: dict) -> bool:
    """列表投影只接收已按 actor / organization 收窄过的 Catalog 行。"""
    if model.get("capability_domain") != "chat":
        return False
    if model.get("wave_status") != "ready":
        return False
    if model.get("provider_routing_enabled") is False:
        return False
    scope = str(model.get("provider_scope") or "")
    if scope == "global":
        return True
    if scope == "organization":
        return True
    return scope == "user" and str(getattr(organization, "type", "")) == "personal"


def _catalog_model_can_use_as_user_default(model: dict) -> bool:
    if model.get("capability_domain") != "chat":
        return False
    if model.get("wave_status") != "ready":
        return False
    if model.get("provider_routing_enabled") is False:
        return False
    return str(model.get("provider_scope") or "") in {"global", "organization", "user"}


def _check_provider_access(provider: LLMProvider, organization_id: str, user_id: str) -> str | None:
    """校验用户对 Provider 的访问权限。返回错误消息或 None（通过）。"""
    if provider.scope == 'global':
        return None
    # v0.1：scope 取值为 global / organization / user（旧值 'workspace' 已 deprecated）。
    if provider.scope == 'organization':
        if provider.organization_id != organization_id:
            return "Provider not found in this organization"
    if provider.scope == 'user':
        # 个人渠道跨组织可见与可管，只校验归属用户。
        if provider.user_id != user_id:
            return "No permission to access this provider"
    return None


# ============ 用户 Provider 配置 ============

@router.post("/user/providers", auth=jwt_auth, tags=["用户配置"])
@envelope_errors
def create_user_provider(request, payload: ProviderConfigRequest, user_id: Optional[str] = None, organization_id: Optional[str] = None):
    """
    创建用户提供商配置
    """
    user_id = ensure_self_user_id(request, user_id, organization_id=organization_id)

    provider_key = _normalize_provider_key(payload.provider_key or payload.provider_name)
    base_url = _normalize_base_url(payload.base_url)

    existing = LLMProvider.objects.filter(
        user_id=user_id,
        scope='user',
        provider_key=provider_key
    ).first()

    if existing:
        return error_response_with_status("BAD_REQUEST", message=get_text("llm.provider_already_configured", provider=payload.provider_name), status_code=400)

    # v0.1.x：用户/组织级 BYOK provider 默认 capability_domains=['chat']。
    # 多模态/embedding 等 BYOK 走专属入口（参见 03_BYOK 边界）。
    # v0.1.x Phase 2.5：Provider.base_url 已删；用户传入的 base_url 缓存到 payload
    # 后用，在创建 LLMModel 时落到 model.base_url。
    # 个人渠道不绑定创建时组织，跨组织跟随本人。
    provider = LLMProvider.objects.create(
        name=payload.provider_name,
        provider_key=provider_key,
        display_name=f"{payload.provider_name.upper()} (用户配置)",
        default_base_url=base_url,
        api_key=payload.api_key,
        user_id=user_id,
        scope='user',
        organization_id=None,
        capability_domains=['chat'],
        routing_enabled=True,
    )
    # 即使旧客户端仍携带 model_name，也只创建渠道。模型必须由模型管理入口显式创建，
    # 避免把未经用户确认的名称、能力和容量猜成一个实际不可用的模型。
    invalidate_models_cache(organization_id=organization_id, user_id=user_id)

    logger.info(
        "[LLM User] provider created",
        extra={
            "event": "llm.user.provider.create",
            "user_id": user_id,
            "organization_id": organization_id,
            "provider_name": payload.provider_name,
            "provider_key": provider_key
        }
    )

    return success_response(
        data={
            'provider_id': str(provider.id),
            'provider_name': provider.name,
            'display_name': provider.display_name
        },
        message=get_text("llm.provider_create_success")
    )


@router.get("/user/providers", auth=jwt_auth, tags=["用户配置"])
@envelope_errors
def get_user_providers(request, user_id: Optional[str] = None, organization_id: Optional[str] = None):
    """
    获取用户提供商配置列表
    """
    user_id = ensure_self_user_id(request, user_id, organization_id=organization_id)

    # 个人渠道跨组织列出；organization_id 查询参数不再收窄。
    first_model_base_url = (
        LLMModel.objects.filter(provider_id=OuterRef('pk'))
        .order_by('created_at')
        .values('base_url')[:1]
    )
    providers = LLMProvider.objects.filter(user_id=user_id, scope='user').annotate(
        _model_count=Count('models'),
        _fallback_base_url=Subquery(first_model_base_url),
    ).order_by('-created_at')

    provider_list = []
    for provider in providers:
        _caps = list(provider.capability_domains or [])
        # 渠道默认端点用于创建模型时预填；兼容历史数据时回退首个模型端点。
        _first_base_url = provider.default_base_url or (provider._fallback_base_url or '')
        provider_info = {
            'id': str(provider.id),
            'name': provider.name,
            'provider_key': provider.provider_key,
            'display_name': provider.display_name,
            'base_url': _first_base_url,
            'scope': provider.scope,
            'capability_domains': _caps,
            # 兼容旧前端：返回首个 domain（与 _serialize_provider 一致）
            'capability_domain': _caps[0] if _caps else '',
            'organization_id': provider.organization_id,
            'routing_enabled': provider.routing_enabled,
            'created_at': provider.created_at.isoformat(),
            'model_count': provider._model_count
        }
        provider_list.append(provider_info)

    return success_response(
        data={
            'providers': provider_list,
            'total': len(provider_list)
        },
        message=get_text("llm.provider_list_success")
    )


@router.put("/user/providers/{provider_name}", auth=jwt_auth, tags=["用户配置"])
@envelope_errors
def update_user_provider(
    request,
    provider_name: str,
    payload: ProviderConfigRequest,
    user_id: Optional[str] = None,
    provider_key: Optional[str] = None,
    organization_id: Optional[str] = None
):
    """
    更新用户提供商配置
    """
    user_id = ensure_self_user_id(request, user_id, organization_id=organization_id)

    query = LLMProvider.objects.filter(
        user_id=user_id,
        scope='user',
        name=provider_name
    )
    if provider_key:
        query = query.filter(provider_key=provider_key)
    providers = list(query[:2])
    provider = providers[0] if providers else None

    if not provider:
        return error_response_with_status("NOT_FOUND", message=get_text("llm.provider_not_found", provider=provider_name), status_code=404)
    if len(providers) > 1:
        return error_response_with_status("BAD_REQUEST", message=get_text("llm.provider_not_found", provider=provider_name), status_code=400)

    provider.default_base_url = _normalize_base_url(payload.base_url)
    provider.api_key = payload.api_key
    if payload.provider_key:
        provider.provider_key = _normalize_provider_key(payload.provider_key)
    provider.save()
    invalidate_models_cache(organization_id=organization_id, user_id=user_id)

    logger.info(
        "[LLM User] provider updated",
        extra={
            "event": "llm.user.provider.update",
            "user_id": user_id,
            "organization_id": organization_id,
            "provider_name": provider_name,
            "provider_key": provider.provider_key
        }
    )

    return success_response(
        data={
            'provider_id': str(provider.id),
            'provider_name': provider.name,
            'updated_at': provider.updated_at.isoformat()
        },
        message=get_text("llm.provider_update_success")
    )


@router.delete("/user/providers/{provider_name}", auth=jwt_auth, tags=["用户配置"])
@envelope_errors
def delete_user_provider(
    request,
    provider_name: str,
    user_id: Optional[str] = None,
    provider_key: Optional[str] = None,
    organization_id: Optional[str] = None
):
    """
    删除用户提供商配置
    """
    user_id = ensure_self_user_id(request, user_id, organization_id=organization_id)

    query = LLMProvider.objects.filter(
        user_id=user_id,
        scope='user',
        name=provider_name
    )
    if provider_key:
        query = query.filter(provider_key=provider_key)
    providers = list(query[:2])
    provider = providers[0] if providers else None

    if not provider:
        return error_response_with_status("NOT_FOUND", message=get_text("llm.provider_not_found", provider=provider_name), status_code=404)
    if len(providers) > 1:
        return error_response_with_status("BAD_REQUEST", message=get_text("llm.provider_not_found", provider=provider_name), status_code=400)

    provider_id = str(provider.id)
    provider.delete()
    invalidate_models_cache(organization_id=organization_id, user_id=user_id)

    logger.info(
        "[LLM User] provider deleted",
        extra={
            "event": "llm.user.provider.delete",
            "user_id": user_id,
            "organization_id": organization_id,
            "provider_name": provider_name,
            "provider_key": provider.provider_key
        }
    )

    return success_response(
        data={
            'provider_id': provider_id,
            'provider_name': provider_name
        },
        message=get_text("llm.provider_delete_success")
    )


# ============ 组织 Provider 配置 ============

@router.get("/organizations/{organization_id}/providers", auth=jwt_auth, tags=["组织配置"])
@envelope_errors
def list_organization_providers(request, organization_id: str):
    """
    获取组织可见的提供商列表
    """
    ensure_organization_permission(request, organization_id, role='viewer')

    user_id = str(request.auth.id)

    # v0.1：capability_domain 'llm' 旧值已删；按 8 域全量列出，
    # 前端按 capability_domain 切 Tab 筛选
    # 个人渠道跨组织可见；fallback base_url 用 Subquery 避免 N+1。
    first_model_base_url = (
        LLMModel.objects.filter(provider_id=OuterRef('pk'))
        .order_by('created_at')
        .values('base_url')[:1]
    )
    providers = LLMProvider.objects.filter(
        Q(scope='organization', organization_id=organization_id) |
        Q(scope='user', user_id=user_id)
    ).annotate(
        # models × keys 同时联表会产生笛卡尔积，两个计数都必须 distinct。
        _model_count=Count('models', distinct=True),
        _key_count=Count('keys', distinct=True),
        _fallback_base_url=Subquery(first_model_base_url),
    ).order_by('-created_at')

    provider_list = []
    for provider in providers:
        _caps = list(provider.capability_domains or [])
        # 渠道默认端点用于创建模型时预填；兼容历史数据时回退首个模型端点。
        _first_base_url = provider.default_base_url or (provider._fallback_base_url or '')
        provider_list.append({
            'id': str(provider.id),
            'name': provider.name,
            'provider_key': provider.provider_key,
            'display_name': provider.display_name,
            'base_url': _first_base_url,
            'scope': provider.scope,
            'capability_domains': _caps,
            # 兼容旧前端：返回首个 domain（与 _serialize_provider 一致）
            'capability_domain': _caps[0] if _caps else '',
            'organization_id': provider.organization_id,
            'is_own': provider.user_id == user_id,
            'routing_enabled': provider.routing_enabled,
            'created_at': provider.created_at.isoformat(),
            'model_count': provider._model_count,
            'runtime_status': provider.runtime_status,
            'health_success_rate': provider.health_success_rate,
            'health_avg_latency_ms': provider.health_avg_latency_ms,
            'health_total_checks': provider.health_total_checks,
            'health_last_error': provider.health_last_error or '',
            'health_consecutive_failures': provider.health_consecutive_failures,
            'key_count': provider._key_count,
        })

    return success_response(
        data={
            'providers': provider_list,
            'total': len(provider_list)
        },
        message=get_text("llm.provider_list_success")
    )


@router.post("/organizations/{organization_id}/providers", auth=jwt_auth, tags=["组织配置"])
@envelope_errors
def create_organization_provider(request, organization_id: str, payload: OrganizationProviderCreateRequest):
    """
    创建组织/个人提供商配置
    """
    scope = payload.scope or 'organization'
    if scope not in {'organization', 'user'}:
        return error_response_with_status("BAD_REQUEST", message=get_text("llm.provider_create_failed", detail="scope 必须为 organization 或 user"), status_code=400)

    required_role = 'owner' if scope == 'organization' else 'viewer'
    ensure_organization_permission(request, organization_id, role=required_role)

    provider_key = _normalize_provider_key(payload.provider_key or payload.provider_name)
    default_base_url = _normalize_base_url(payload.base_url)
    user_id = str(request.auth.id)

    dup_qs = LLMProvider.objects.filter(provider_key=provider_key, scope=scope)
    if scope == 'organization':
        dup_qs = dup_qs.filter(organization_id=organization_id)
    else:
        # 个人渠道全局唯一到 user+provider_key
        dup_qs = dup_qs.filter(user_id=user_id)
    if dup_qs.exists():
        return error_response_with_status("BAD_REQUEST", message=get_text("llm.provider_already_configured", provider=payload.provider_name), status_code=400)

    # Provider 保存账号/密钥和“新模型默认端点”；模型名和运行时 endpoint
    # 仍由用户在模型管理中显式确认，避免创建未经确认的占位模型。
    # 个人渠道不绑定创建时组织，跨组织跟随本人。
    provider = LLMProvider.objects.create(
        name=payload.provider_name,
        provider_key=provider_key,
        display_name=payload.display_name or payload.provider_name,
        default_base_url=default_base_url,
        api_key=payload.api_key,
        scope=scope,
        organization_id=None if scope == 'user' else organization_id,
        user_id=user_id if scope == 'user' else None,
        capability_domains=['chat'],
        routing_enabled=True,
    )
    invalidate_models_cache(organization_id=organization_id, user_id=user_id)

    logger.info(
        "[LLM Organization] provider created",
        extra={
            "event": "llm.organization.provider.create",
            "organization_id": organization_id,
            "user_id": user_id,
            "scope": scope,
            "provider_key": provider_key,
        }
    )

    return success_response(
        data={
            'provider_id': str(provider.id),
            'provider_name': provider.name,
            'display_name': provider.display_name,
            'scope': provider.scope,
        },
        message=get_text("llm.provider_create_success")
    )


@router.put("/organizations/{organization_id}/providers/{provider_id}", auth=jwt_auth, tags=["组织配置"])
@envelope_errors
def update_organization_provider(
    request,
    organization_id: str,
    provider_id: str,
    payload: OrganizationProviderUpdateRequest
):
    """
    更新组织/个人提供商配置
    """
    ensure_organization_permission(request, organization_id, role='member')

    try:
        provider = LLMProvider.objects.get(id=provider_id)
    except LLMProvider.DoesNotExist:
        return error_response_with_status("NOT_FOUND", message=get_text("llm.provider_not_found", provider=provider_id), status_code=404)

    if provider.scope == 'global':
        return error_response_with_status("FORBIDDEN", message=get_text("llm.provider_update_failed", detail=_("llm.provider_global_no_ws_modify")), status_code=403)

    if provider.scope == 'organization':
        if provider.organization_id != organization_id:
            return error_response_with_status("NOT_FOUND", message=get_text("llm.provider_not_found", provider=provider_id), status_code=404)
        ensure_organization_permission(request, organization_id, role='owner')

    if provider.scope == 'user':
        if provider.user_id != str(request.auth.id):
            return error_response_with_status("FORBIDDEN", message=get_text("chat.workspace_mismatch", organization_id=organization_id), status_code=403)

    if payload.display_name is not None:
        provider.display_name = payload.display_name.strip() or provider.display_name
    # 编辑渠道默认端点不覆盖既有模型，避免同账号不同能力域的 endpoint 被一刀切坏。
    if payload.base_url is not None:
        provider.default_base_url = _normalize_base_url(payload.base_url)
    if payload.api_key is not None and payload.api_key.strip():
        provider.api_key = payload.api_key.strip()
    # v0.1：is_active 字段已删（0022），payload.is_active 兼容期保留但不再写入 ORM。
    # 启用/禁用语义由 routing_enabled 表达；下线 provider 直接 DELETE。
    routing_was_enabled = provider.routing_enabled
    if getattr(payload, "routing_enabled", None) is not None:
        provider.routing_enabled = payload.routing_enabled

    with transaction.atomic():
        provider.save()
        if routing_was_enabled and not provider.routing_enabled:
            default_model_id = _get_organization_default_model_id(organization_id)
            default_model_belongs_to_provider = default_model_id and LLMModel.objects.filter(
                id=default_model_id,
                provider=provider,
            ).exists()
            if default_model_belongs_to_provider:
                _clear_organization_default_model_id(organization_id, default_model_id)

            subagent_model_id = _get_organization_subagent_model_policy(
                organization_id,
            ).get('subagent_model_id')
            if subagent_model_id and LLMModel.objects.filter(
                id=subagent_model_id,
                provider=provider,
            ).exists():
                _clear_organization_subagent_model_id(
                    organization_id,
                    subagent_model_id,
                )
    invalidate_models_cache(organization_id=organization_id, user_id=str(request.auth.id))

    logger.info(
        "[LLM Organization] provider updated",
        extra={
            "event": "llm.organization.provider.update",
            "organization_id": organization_id,
            "user_id": str(request.auth.id),
            "provider_id": provider_id,
            "provider_key": provider.provider_key
        }
    )

    return success_response(
        data={
            'provider_id': str(provider.id),
            'provider_name': provider.name,
            'display_name': provider.display_name,
            'routing_enabled': provider.routing_enabled,
            'updated_at': provider.updated_at.isoformat()
        },
        message=get_text("llm.provider_update_success")
    )


@router.delete("/organizations/{organization_id}/providers/{provider_id}", auth=jwt_auth, tags=["组织配置"])
@envelope_errors
def delete_organization_provider(request, organization_id: str, provider_id: str):
    """
    删除组织/个人提供商配置
    """
    ensure_organization_permission(request, organization_id, role='member')

    try:
        provider = LLMProvider.objects.get(id=provider_id)
    except LLMProvider.DoesNotExist:
        return error_response_with_status("NOT_FOUND", message=get_text("llm.provider_not_found", provider=provider_id), status_code=404)

    if provider.scope == 'global':
        return error_response_with_status("FORBIDDEN", message=get_text("llm.provider_delete_failed", detail=_("llm.provider_global_no_ws_delete")), status_code=403)

    if provider.scope == 'organization':
        if provider.organization_id != organization_id:
            return error_response_with_status("NOT_FOUND", message=get_text("llm.provider_not_found", provider=provider_id), status_code=404)
        ensure_organization_permission(request, organization_id, role='owner')

    if provider.scope == 'user':
        if provider.user_id != str(request.auth.id):
            return error_response_with_status("FORBIDDEN", message=get_text("chat.workspace_mismatch", organization_id=organization_id), status_code=403)

    provider_id_value = str(provider.id)
    model_count = provider.models.count()
    with transaction.atomic():
        default_model_id = _get_organization_default_model_id(organization_id)
        if default_model_id and LLMModel.objects.filter(id=default_model_id, provider=provider).exists():
            _clear_organization_default_model_id(organization_id, default_model_id)

        subagent_model_id = _get_organization_subagent_model_policy(
            organization_id,
        ).get('subagent_model_id')
        if subagent_model_id and LLMModel.objects.filter(
            id=subagent_model_id,
            provider=provider,
        ).exists():
            _clear_organization_subagent_model_id(
                organization_id,
                subagent_model_id,
            )

        # LLMModel.provider 使用 PROTECT，必须显式删除下属模型后才能删除渠道。
        # 单个模型仍保留 PROTECT 语义：若异常数据把 BYOK 模型绑到平台 Scene，
        # 整个事务会失败，避免留下半删状态。
        provider.models.all().delete()
        provider.delete()
    invalidate_models_cache(organization_id=organization_id, user_id=str(request.auth.id))

    logger.info(
        "[LLM Organization] provider deleted",
        extra={
            "event": "llm.organization.provider.delete",
            "organization_id": organization_id,
            "user_id": str(request.auth.id),
            "provider_id": provider_id_value,
            "deleted_model_count": model_count,
        }
    )

    return success_response(
        data={
            'provider_id': provider_id_value,
            'deleted_model_count': model_count,
        },
        message=get_text("llm.provider_delete_success")
    )


# ============ 组织 Model 配置 ============

@router.get("/organizations/{organization_id}/models", auth=jwt_auth, tags=["组织配置"])
@envelope_errors
def list_organization_models(request, organization_id: str):
    """
    获取组织可用模型列表
    """
    ensure_organization_permission(request, organization_id, role='viewer')

    organization = OrganizationService(user=request.auth).get_organization(organization_id)
    if not organization:
        return error_response_with_status("NOT_FOUND", message=get_text("chat.workspace_mismatch", organization_id=organization_id), status_code=404)

    models = get_available_models(
        user_id=str(request.auth.id),
        organization_id=organization_id,
        include_inactive=True
    )
    for model in models:
        model["can_set_as_default"] = _catalog_model_can_use_as_default(
            organization,
            model,
        )
        model["can_set_as_user_default"] = _catalog_model_can_use_as_user_default(model)

    organization_default_model_id = _get_organization_default_model_id(organization_id)
    organization_subagent_policy = _serialize_organization_subagent_model_policy(organization)
    organization_default_model = None
    if organization_default_model_id:
        organization_default_model = next(
            (
                m for m in models
                if m["id"] == organization_default_model_id and m.get("can_set_as_default")
            ),
            None,
        )

    user_default_model_id = _read_user_default_model_id(request.auth, organization_id)
    user_default_model = None
    if user_default_model_id:
        user_default_model = next(
            (
                m for m in models
                if m["id"] == user_default_model_id and m.get("can_set_as_user_default")
            ),
            None,
        )
    user_subagent_model_id = _read_user_subagent_model_id(request.auth, organization_id)
    user_subagent_policy = _read_user_subagent_model_policy(request.auth, organization_id)
    user_subagent_model = None
    if user_subagent_model_id:
        user_subagent_model = next(
            (
                m for m in models
                if m["id"] == user_subagent_model_id and m.get("can_set_as_user_default")
            ),
            None,
        )
    user_subagent_policy = 'fixed' if user_subagent_model else ('inherit' if user_subagent_model_id else user_subagent_policy)
    effective_subagent_model_id = None
    if user_subagent_model:
        effective_subagent_model_id = user_subagent_model['id']
    elif user_subagent_policy != 'inherit_main':
        effective_subagent_model_id = organization_subagent_policy['subagent_model_id']
    effective_subagent_policy = 'fixed' if effective_subagent_model_id else 'inherit'

    return success_response(
        data={
            'models': models,
            'total': len(models),
            'default_model_id': organization_default_model['id'] if organization_default_model else '',
            'default_model_name': organization_default_model['name'] if organization_default_model else '',
            'organization_default_model_id': organization_default_model['id'] if organization_default_model else '',
            'organization_default_model_name': organization_default_model['name'] if organization_default_model else '',
            'user_default_model_id': user_default_model['id'] if user_default_model else '',
            'user_default_model_name': user_default_model['name'] if user_default_model else '',
            # Backward compatible effective policy: user override first, then organization policy.
            'subagent_model_policy': effective_subagent_policy,
            'subagent_model_id': effective_subagent_model_id,
            'organization_subagent_model_policy': organization_subagent_policy['subagent_model_policy'],
            'organization_subagent_model_id': organization_subagent_policy['subagent_model_id'],
            'user_subagent_model_policy': user_subagent_policy,
            'user_subagent_model_id': user_subagent_model['id'] if user_subagent_model else '',
            'user_subagent_model_name': user_subagent_model['name'] if user_subagent_model else '',
        },
        message=get_text("llm.models_fetch_success")
    )


@router.post("/organizations/{organization_id}/models", auth=jwt_auth, tags=["组织配置"])
@envelope_errors
def create_organization_model(request, organization_id: str, payload: OrganizationModelCreateRequest):
    """
    创建组织模型
    """
    ensure_organization_permission(request, organization_id, role='viewer')

    try:
        provider = LLMProvider.objects.get(id=payload.provider_id)
    except LLMProvider.DoesNotExist:
        return error_response_with_status("NOT_FOUND", message=get_text("llm.provider_not_found", provider=payload.provider_id), status_code=404)

    if provider.scope == 'global':
        return error_response_with_status("BAD_REQUEST", message=get_text("llm.provider_create_failed", detail=_("llm.no_model_under_global_provider")), status_code=400)

    if provider.scope == 'organization':
        if provider.organization_id != organization_id:
            return error_response_with_status("BAD_REQUEST", message=get_text("llm.provider_not_found", provider=payload.provider_id), status_code=400)
        ensure_organization_permission(request, organization_id, role='owner')

    if provider.scope == 'user':
        if provider.user_id != str(request.auth.id):
            return error_response_with_status("FORBIDDEN", message=get_text("chat.workspace_mismatch", organization_id=organization_id), status_code=403)

    exists = LLMModel.objects.filter(provider=provider, model_name=payload.model_name).exists()
    if exists:
        return error_response_with_status("BAD_REQUEST", message=get_text("llm.model_create_failed", detail=_("llm.model_name_exists_v2")), status_code=400)

    # v0.1.x：模型 capability_domain 必须落在 provider.capability_domains 集合内。
    # BYOK provider 默认 capability_domains=['chat']，所以模型默认走 chat 域；
    # 多模态/embedding 走专属入口，不在此函数处理。
    provider_caps = list(provider.capability_domains or [])
    model_domain = provider_caps[0] if provider_caps else 'chat'
    capabilities_config = payload.capabilities_config or {}
    max_output_tokens = payload.max_output_tokens
    if model_domain == 'chat':
        capabilities_config = ensure_custom_chat_json_capability(capabilities_config)
        if getattr(settings, 'TABTIN_EDITION', 'saas') == 'community':
            capabilities_config = ensure_known_provider_chat_capabilities(
                provider_name=provider.name,
                config=capabilities_config,
            )
            max_output_tokens = resolve_known_provider_chat_max_output_tokens(
                provider_name=provider.name,
                context_window_tokens=payload.context_window_tokens,
                explicit_max_output_tokens=max_output_tokens,
            )
        capabilities_config = ensure_known_byok_wire_capability(
            provider_key=provider.provider_key or provider.name,
            model_name=payload.model_name,
            capabilities_config=capabilities_config,
        )

    # 运行时 base_url 跟 Model 走。创建时优先用请求体，其次渠道默认端点，
    # 最后兼容历史渠道，继承同渠道已有真实 endpoint。
    _PLACEHOLDER_BASE = 'https://api.example.com/v1'
    requested_base_url = (getattr(payload, 'base_url', None) or '').strip()
    base_url = _normalize_base_url(requested_base_url) if requested_base_url else provider.default_base_url
    if not base_url:
        sibling = (
            provider.models.exclude(base_url='')
            .exclude(base_url=_PLACEHOLDER_BASE)
            .order_by('created_at')
            .only('base_url')
            .first()
        )
        base_url = (sibling.base_url if sibling else '') or ''
    if not base_url:
        return error_response_with_status(
            "BAD_REQUEST",
            message=get_text("llm.model_create_failed", detail="base_url 不能为空"),
            status_code=400,
        )
    host_mismatch = validate_model_endpoint_host(provider, base_url)
    if host_mismatch:
        return error_response_with_status(
            "MODEL_ENDPOINT_HOST_MISMATCH",
            message=host_mismatch,
            status_code=400,
        )

    model = LLMModel.objects.create(
        provider=provider,
        model_name=payload.model_name,
        display_name=payload.display_name,
        description=payload.description or '',
        capability_domain=model_domain,
        base_url=base_url,
        context_window_tokens=payload.context_window_tokens,
        max_input_tokens=payload.max_input_tokens,
        max_output_tokens=max_output_tokens,
        capabilities_config=capabilities_config,
        billing_type=payload.billing_type,
        input_price_per_1k=payload.input_price_per_1k,
        output_price_per_1k=payload.output_price_per_1k,
    )
    invalidate_models_cache(organization_id=organization_id, user_id=str(request.auth.id))

    logger.info(
        "[LLM Organization] model created",
        extra={
            "event": "llm.organization.model.create",
            "organization_id": organization_id,
            "user_id": str(request.auth.id),
            "provider_id": str(provider.id),
            "model_id": str(model.id),
            "model_name": model.model_name
        }
    )

    return success_response(
        data={
            'model_id': str(model.id),
            'model_name': model.model_name,
            'display_name': model.display_name
        },
        message=get_text("llm.model_create_success")
    )


@router.put("/organizations/{organization_id}/models/{model_id}", auth=jwt_auth, tags=["组织配置"])
@envelope_errors
def update_organization_model(
    request,
    organization_id: str,
    model_id: str,
    payload: OrganizationModelUpdateRequest
):
    """
    更新组织模型
    """
    ensure_organization_permission(request, organization_id, role='viewer')

    try:
        model = LLMModel.objects.select_related('provider').get(id=model_id)
    except LLMModel.DoesNotExist:
        return error_response_with_status("NOT_FOUND", message=get_text("chat.model_not_found", model_id=model_id), status_code=404)

    provider = model.provider
    if provider.scope == 'global':
        return error_response_with_status("FORBIDDEN", message=get_text("llm.model_create_failed", detail=_("llm.global_model_no_ws_modify")), status_code=403)

    if provider.scope == 'organization':
        if provider.organization_id != organization_id:
            return error_response_with_status("NOT_FOUND", message=get_text("chat.model_not_found", model_id=model_id), status_code=404)
        ensure_organization_permission(request, organization_id, role='owner')

    if provider.scope == 'user':
        if provider.user_id != str(request.auth.id):
            return error_response_with_status("FORBIDDEN", message=get_text("chat.workspace_mismatch", organization_id=organization_id), status_code=403)

    if payload.model_name and payload.model_name != model.model_name:
        exists = LLMModel.objects.filter(
            provider=provider,
            model_name=payload.model_name
        ).exclude(id=model.id).exists()
        if exists:
            return error_response_with_status("BAD_REQUEST", message=get_text("llm.model_create_failed", detail=_("llm.model_name_exists_v2")), status_code=400)
        model.model_name = payload.model_name

    if payload.display_name is not None:
        model.display_name = payload.display_name
    if payload.description is not None:
        model.description = payload.description
    if payload.base_url is not None:
        normalized_base_url = _normalize_base_url(payload.base_url)
        if not normalized_base_url:
            return error_response_with_status(
                "BAD_REQUEST",
                message=get_text("llm.model_create_failed", detail="base_url 不能为空"),
                status_code=400,
            )
        host_mismatch = validate_model_endpoint_host(
            provider,
            normalized_base_url,
            exclude_model_id=model.id,
        )
        if host_mismatch:
            return error_response_with_status(
                "MODEL_ENDPOINT_HOST_MISMATCH",
                message=host_mismatch,
                status_code=400,
            )
        model.base_url = normalized_base_url
    if payload.context_window_tokens is not None:
        model.context_window_tokens = payload.context_window_tokens
    if payload.max_input_tokens is not None:
        model.max_input_tokens = payload.max_input_tokens
    if payload.max_output_tokens is not None:
        model.max_output_tokens = payload.max_output_tokens
    if payload.capabilities_config is not None:
        # v0.1：supports_* / max_image_* 等硬开关全部进 capabilities_config。
        model.capabilities_config = payload.capabilities_config
    if model.capability_domain == 'chat':
        model.capabilities_config = ensure_custom_chat_json_capability(
            model.capabilities_config
        )
        if getattr(settings, 'TABTIN_EDITION', 'saas') == 'community':
            model.capabilities_config = ensure_known_provider_chat_capabilities(
                provider_name=provider.name,
                config=model.capabilities_config,
            )
            model.max_output_tokens = resolve_known_provider_chat_max_output_tokens(
                provider_name=provider.name,
                context_window_tokens=model.context_window_tokens,
                explicit_max_output_tokens=model.max_output_tokens,
            )
        model.capabilities_config = ensure_known_byok_wire_capability(
            provider_key=provider.provider_key or provider.name,
            model_name=model.model_name,
            capabilities_config=model.capabilities_config,
        )
    # v0.1：模型 is_active 字段已删（0022），下线模型直接 DELETE。

    model.save()
    invalidate_models_cache(organization_id=organization_id, user_id=str(request.auth.id))

    logger.info(
        "[LLM Organization] model updated",
        extra={
            "event": "llm.organization.model.update",
            "organization_id": organization_id,
            "user_id": str(request.auth.id),
            "model_id": model_id
        }
    )

    return success_response(
        data={
            'model_id': str(model.id),
            'model_name': model.model_name,
            'display_name': model.display_name,
            'base_url': model.base_url,
            'wave_status': model.wave_status,
            'updated_at': model.updated_at.isoformat()
        },
        message=get_text("llm.provider_update_success")
    )


@router.delete("/organizations/{organization_id}/models/{model_id}", auth=jwt_auth, tags=["组织配置"])
@envelope_errors
def delete_organization_model(request, organization_id: str, model_id: str):
    """
    删除组织模型
    """
    ensure_organization_permission(request, organization_id, role='viewer')

    try:
        model = LLMModel.objects.select_related('provider').get(id=model_id)
    except LLMModel.DoesNotExist:
        return error_response_with_status("NOT_FOUND", message=get_text("chat.model_not_found", model_id=model_id), status_code=404)

    provider = model.provider
    if provider.scope == 'global':
        return error_response_with_status("FORBIDDEN", message=get_text("llm.model_create_failed", detail=_("llm.global_model_no_ws_delete")), status_code=403)

    if provider.scope == 'organization':
        if provider.organization_id != organization_id:
            return error_response_with_status("NOT_FOUND", message=get_text("chat.model_not_found", model_id=model_id), status_code=404)
        ensure_organization_permission(request, organization_id, role='owner')

    if provider.scope == 'user':
        if provider.user_id != str(request.auth.id):
            return error_response_with_status("FORBIDDEN", message=get_text("chat.workspace_mismatch", organization_id=organization_id), status_code=403)

    model_id_value = str(model.id)
    with transaction.atomic():
        _clear_organization_default_model_id(organization_id, model_id)
        _clear_organization_subagent_model_id(organization_id, model_id)
        model.delete()
    invalidate_models_cache(organization_id=organization_id, user_id=str(request.auth.id))

    logger.info(
        "[LLM Organization] model deleted",
        extra={
            "event": "llm.organization.model.delete",
            "organization_id": organization_id,
            "user_id": str(request.auth.id),
            "model_id": model_id_value,
        }
    )

    return success_response(
        data={
            'model_id': model_id_value
        },
        message=get_text("llm.model_delete_success")
    )


@router.put("/organizations/{organization_id}/default-model", auth=jwt_auth, tags=["组织配置"])
@envelope_errors
def set_organization_default_model(request, organization_id: str, payload: OrganizationDefaultModelRequest):
    """
    设置组织默认模型
    """
    ensure_organization_permission(request, organization_id, role='owner')

    organization = OrganizationService(user=request.auth).get_organization(organization_id)
    if not organization:
        return error_response_with_status("NOT_FOUND", message=get_text("chat.workspace_mismatch", organization_id=organization_id), status_code=404)

    try:
        model = LLMModel.objects.select_related('provider').get(
            id=payload.model_id,
            provider__routing_enabled=True,
            wave_status='ready',
        )
    except LLMModel.DoesNotExist:
        return error_response_with_status("NOT_FOUND", message=get_text("chat.model_not_found", model_id=payload.model_id), status_code=404)

    if model.capability_domain != 'chat':
        return error_response_with_status(
            "BAD_REQUEST",
            message=get_text("llm.model_create_failed", detail="默认模型必须是 chat capability_domain 模型"),
            status_code=400,
        )

    if not can_use_as_organization_default(
        organization,
        model,
        actor_user_id=str(request.auth.id),
    ):
        return error_response_with_status(
            "BAD_REQUEST",
            message=get_text("llm.model_create_failed", detail=_("llm.model_not_in_ws")),
            status_code=400,
        )

    settings = organization.settings or {}
    settings['llm_default_model_id'] = str(model.id)
    organization.settings = settings
    organization.save(update_fields=['settings', 'updated_at'])
    invalidate_models_cache(organization_id=organization_id)
    OrganizationService.broadcast_organization_updated(organization)

    logger.info(
        "[LLM Organization] default model updated",
        extra={
            "event": "llm.organization.model.default",
            "organization_id": organization_id,
            "user_id": str(request.auth.id),
            "model_id": str(model.id),
            "model_name": model.model_name
        }
    )

    return success_response(
        data={
            'organization_id': organization_id,
            'default_model_id': str(model.id),
            'default_model_name': model.model_name
        },
        message=get_text("llm.provider_update_success")
    )


@router.put("/organizations/{organization_id}/user-default-model", auth=jwt_auth, tags=["个人配置"])
@envelope_errors
def set_user_default_model(request, organization_id: str, payload: UserDefaultModelRequest):
    """
    设置当前用户在该组织内的默认模型；model_id 为空时清除个人覆盖并跟随组织默认。
    """
    ensure_organization_permission(request, organization_id, role='viewer')

    organization = OrganizationService(user=request.auth).get_organization(organization_id)
    if not organization:
        return error_response_with_status("NOT_FOUND", message=get_text("chat.workspace_mismatch", organization_id=organization_id), status_code=404)

    model_id = str(payload.model_id or "").strip()
    if not model_id:
        _clear_user_default_model_id(request.auth, organization_id)
        invalidate_models_cache(organization_id=organization_id, user_id=str(request.auth.id))
        logger.info(
            "[LLM Organization] user default model cleared",
            extra={
                "event": "llm.organization.model.user_default.clear",
                "organization_id": organization_id,
                "user_id": str(request.auth.id),
            }
        )
        return success_response(
            data={
                'organization_id': organization_id,
                'user_default_model_id': '',
                'user_default_model_name': '',
            },
            message=get_text("llm.provider_update_success")
        )

    try:
        model = LLMModel.objects.select_related('provider').get(
            id=model_id,
            provider__routing_enabled=True,
            wave_status='ready',
        )
    except LLMModel.DoesNotExist:
        return error_response_with_status("NOT_FOUND", message=get_text("chat.model_not_found", model_id=model_id), status_code=404)

    if not can_use_as_user_default(
        organization,
        model,
        actor_user_id=str(request.auth.id),
    ):
        return error_response_with_status(
            "BAD_REQUEST",
            message=get_text("llm.model_create_failed", detail=_("llm.model_not_in_ws")),
            status_code=400,
        )

    _write_user_default_model_id(request.auth, organization_id, str(model.id))
    invalidate_models_cache(organization_id=organization_id, user_id=str(request.auth.id))

    logger.info(
        "[LLM Organization] user default model updated",
        extra={
            "event": "llm.organization.model.user_default",
            "organization_id": organization_id,
            "user_id": str(request.auth.id),
            "model_id": str(model.id),
            "model_name": model.model_name,
        }
    )

    return success_response(
        data={
            'organization_id': organization_id,
            'user_default_model_id': str(model.id),
            'user_default_model_name': model.model_name,
        },
        message=get_text("llm.provider_update_success")
    )


@router.put("/organizations/{organization_id}/subagent-model", auth=jwt_auth, tags=["组织配置"])
@envelope_errors
def set_organization_subagent_model(
    request,
    organization_id: str,
    payload: OrganizationSubagentModelRequest,
):
    """设置新派发子 Agent 的默认模型策略；不改写既有会话和历史执行。"""
    ensure_organization_permission(request, organization_id, role='owner')

    organization = OrganizationService(user=request.auth).get_organization(organization_id)
    if not organization:
        return error_response_with_status(
            "NOT_FOUND",
            message=get_text("chat.workspace_mismatch", organization_id=organization_id),
            status_code=404,
        )

    model = None
    if payload.mode == 'fixed':
        try:
            model = LLMModel.objects.select_related('provider').get(
                id=payload.model_id,
                provider__routing_enabled=True,
                wave_status='ready',
            )
        except LLMModel.DoesNotExist:
            return error_response_with_status(
                "NOT_FOUND",
                message=get_text("chat.model_not_found", model_id=payload.model_id),
                status_code=404,
            )
        if not can_use_as_organization_default(
            organization,
            model,
            actor_user_id=str(request.auth.id),
        ):
            return error_response_with_status(
                "BAD_REQUEST",
                message=get_text("llm.model_create_failed", detail=_("llm.model_not_in_ws")),
                status_code=400,
            )

    settings = organization.settings or {}
    if model is None:
        settings.pop('llm_subagent_model_id', None)
    else:
        settings['llm_subagent_model_id'] = str(model.id)
    organization.settings = settings
    organization.save(update_fields=['settings', 'updated_at'])
    invalidate_models_cache(organization_id=organization_id)
    OrganizationService.broadcast_organization_updated(organization)

    policy = _serialize_organization_subagent_model_policy(organization)
    logger.info(
        "[LLM Organization] subagent model policy updated",
        extra={
            "event": "llm.organization.model.subagent_policy",
            "organization_id": organization_id,
            "user_id": str(request.auth.id),
            "mode": policy['subagent_model_policy'],
            "model_id": policy['subagent_model_id'],
        },
    )
    return success_response(
        data={
            'organization_id': organization_id,
            **policy,
            'subagent_model_name': model.model_name if model else None,
        },
        message=get_text("llm.provider_update_success"),
    )


@router.put("/organizations/{organization_id}/user-subagent-model", auth=jwt_auth, tags=["个人配置"])
@envelope_errors
def set_user_subagent_model(
    request,
    organization_id: str,
    payload: OrganizationSubagentModelRequest,
):
    """设置当前用户新派发子 Agent 的默认模型；不影响团队默认和其他成员。"""
    ensure_organization_permission(request, organization_id, role='viewer')

    organization = OrganizationService(user=request.auth).get_organization(organization_id)
    if not organization:
        return error_response_with_status(
            "NOT_FOUND",
            message=get_text("chat.workspace_mismatch", organization_id=organization_id),
            status_code=404,
        )

    model = None
    if payload.mode == 'fixed':
        try:
            model = LLMModel.objects.select_related('provider').get(
                id=payload.model_id,
                provider__routing_enabled=True,
                wave_status='ready',
            )
        except LLMModel.DoesNotExist:
            return error_response_with_status(
                "NOT_FOUND",
                message=get_text("chat.model_not_found", model_id=payload.model_id),
                status_code=404,
            )
        if not can_use_as_user_default(
            organization,
            model,
            actor_user_id=str(request.auth.id),
        ):
            return error_response_with_status(
                "BAD_REQUEST",
                message=get_text("llm.model_create_failed", detail=_("llm.model_not_in_ws")),
                status_code=400,
            )

    if model is None:
        _clear_user_subagent_model_id(request.auth, organization_id)
        if payload.mode == 'inherit_main':
            _write_user_subagent_model_policy(request.auth, organization_id, 'inherit_main')
        else:
            _clear_user_subagent_model_policy(request.auth, organization_id)
    else:
        _write_user_subagent_model_policy(request.auth, organization_id, 'fixed')
        _write_user_subagent_model_id(request.auth, organization_id, str(model.id))
    invalidate_models_cache(organization_id=organization_id, user_id=str(request.auth.id))

    model_id = str(model.id) if model else None
    response_policy = 'fixed' if model_id else ('inherit_main' if payload.mode == 'inherit_main' else 'inherit')
    logger.info(
        "[LLM Organization] user subagent model policy updated",
        extra={
            "event": "llm.organization.model.user_subagent_policy",
            "organization_id": organization_id,
            "user_id": str(request.auth.id),
            "mode": response_policy,
            "model_id": model_id,
        },
    )
    return success_response(
        data={
            'organization_id': organization_id,
            'user_subagent_model_policy': response_policy,
            'user_subagent_model_id': model_id,
            'user_subagent_model_name': model.model_name if model else None,
        },
        message=get_text("llm.provider_update_success"),
    )

# ============ 探针 API ============

@router.post("/organizations/{organization_id}/providers/{provider_id}/probe", auth=jwt_auth, tags=["组织配置"])
@envelope_errors
def probe_provider(request, organization_id: str, provider_id: str, level: int = 0, model_name: str = ""):
    """分层探针验证渠道连通性。

    与 Agent 对话共用 LLMProxy 的 OpenAI 兼容 ``/chat/completions``，
    不再按 ``provider.name`` 走厂商 SDK。探针发空 messages，不触发生成、不计 token。

    level=0/1: 无生成连通性探针
    level=2: 目前与 level=1 相同（能力探测仍待对话链路对齐）
    """
    ensure_organization_permission(request, organization_id, role='member')

    try:
        provider = LLMProvider.objects.get(id=provider_id)
    except LLMProvider.DoesNotExist:
        return error_response_with_status("NOT_FOUND", message="Provider not found", status_code=404)

    if provider.scope != 'global':
        # v0.1：scope 取值 global / organization / user（'workspace' 旧值已 deprecated）。
        if provider.scope == 'organization' and provider.organization_id != organization_id:
            return error_response_with_status("NOT_FOUND", message="Provider not found", status_code=404)
        if provider.scope == 'user' and provider.user_id != str(request.auth.id):
            return error_response_with_status("FORBIDDEN", message="No permission", status_code=403)

    from .services.proxy_service import probe_upstream_chat

    requested_model_name = model_name.strip()
    model_query = LLMModel.objects.filter(provider=provider, wave_status='ready').select_related('provider')
    if requested_model_name:
        target_model_record = model_query.filter(model_name=requested_model_name).first()
        if target_model_record is None:
            return error_response_with_status(
                "MODEL_NOT_FOUND",
                message="该渠道没有这个可用模型，请先在模型管理中添加",
                status_code=400,
            )
    else:
        target_model_record = model_query.first()
        if target_model_record is None:
            return error_response_with_status(
                "NO_MODELS",
                message="渠道尚未配置模型，请先添加模型后再测试连接",
                status_code=400,
            )

    target_model = target_model_record.model_name
    try:
        result = probe_upstream_chat(target_model_record, level=level)
    except Exception as e:
        result = {"valid": False, "level": level, "error": str(e)[:500], "latency_ms": 0, "details": {}}

    # 成员侧「测试连接」必须落库，否则仅本机会话态显示失败，其他成员仍见旧 healthy。
    # 与 AdminDash / 周期探针共用 apply_provider_runtime_feedback。
    from .services.runtime import apply_provider_runtime_feedback

    is_success = bool(result.get("valid"))
    latency_raw = result.get("latency_ms")
    try:
        latency_ms = int(latency_raw) if latency_raw is not None else None
    except (TypeError, ValueError):
        latency_ms = None
    error_message = (result.get("error") or "")[:2000]
    probe_details = dict(result.get("details") or {})
    if result.get("error_code"):
        probe_details["error_code"] = result.get("error_code")
    if result.get("status_code") is not None:
        probe_details["status_code"] = result.get("status_code")
    probe_details["probe_level"] = level
    probe_details["probe_model_name"] = target_model

    feedback = apply_provider_runtime_feedback(
        provider,
        is_success=is_success,
        latency_ms=latency_ms,
        error_message=error_message,
        check_type="manual",
        details=probe_details,
        persist_log=True,
    )
    result = {
        **result,
        "runtime_status": feedback.get("runtime_status"),
        "health_consecutive_failures": feedback.get("health_consecutive_failures"),
        "health_success_rate": feedback.get("health_success_rate"),
        "health_total_checks": feedback.get("health_total_checks"),
    }

    return success_response(data=result)


# ============ 密钥管理 API ============


def _serialize_key(k: LLMProviderKey) -> dict:
    return {
        "id": str(k.id),
        "label": k.label,
        "key_type": k.key_type,
        # v0.1：is_active 字段已删（0022），可用性由 cooldown_until / disabled_until 决定。
        "is_usable": k.is_usable,
        "priority": k.priority,
        "last_used_at": k.last_used_at.isoformat() if k.last_used_at else None,
        "error_count": k.error_count,
        "cooldown_until": k.cooldown_until.isoformat() if k.cooldown_until else None,
        "disabled_until": k.disabled_until.isoformat() if k.disabled_until else None,
        "disabled_reason": k.disabled_reason,
        "total_requests": k.total_requests,
        "total_tokens": k.total_tokens,
        "api_key_preview": f"...{k.api_key[-4:]}" if len(k.api_key) > 4 else "***",
        "created_at": k.created_at.isoformat(),
    }


def _get_provider_with_access(request, organization_id: str, provider_id: str, write: bool = False):
    """获取 Provider 并校验 organization 归属权限。返回 (provider, error_response)。"""
    ensure_organization_permission(request, organization_id, role='member')

    try:
        provider = LLMProvider.objects.get(id=provider_id)
    except LLMProvider.DoesNotExist:
        return None, error_response_with_status("NOT_FOUND", message=get_text("llm.provider_not_found", provider=provider_id), status_code=404)

    access_err = _check_provider_access(provider, organization_id, str(request.auth.id))
    if access_err:
        return None, error_response_with_status("NOT_FOUND", message=access_err, status_code=404)

    if write and provider.scope == 'organization':
        ensure_organization_permission(request, organization_id, role='owner')

    return provider, None


@router.get("/organizations/{organization_id}/providers/{provider_id}/keys", auth=jwt_auth, tags=["密钥管理"])
@envelope_errors
def list_provider_keys(request, organization_id: str, provider_id: str):
    """列出指定渠道的所有密钥。"""
    provider, err = _get_provider_with_access(request, organization_id, provider_id)
    if err:
        return err

    keys_list = list(
        LLMProviderKey.objects.filter(provider_id=provider_id).order_by('-priority', 'created_at')
    )

    return success_response(data={
        "keys": [_serialize_key(k) for k in keys_list],
        "total": len(keys_list),
    })


@router.post("/organizations/{organization_id}/providers/{provider_id}/keys", auth=jwt_auth, tags=["密钥管理"])
@envelope_errors
def create_provider_key(request, organization_id: str, provider_id: str, payload: ProviderKeyCreateRequest):
    """添加新密钥。"""
    provider, err = _get_provider_with_access(request, organization_id, provider_id, write=True)
    if err:
        return err

    key = LLMProviderKey(
        provider=provider,
        label=payload.label.strip(),
        key_type=payload.key_type,
        priority=payload.priority,
    )
    key.api_key = payload.api_key.strip()
    key.save()

    return success_response(data={"key_id": str(key.id), "label": key.label})


@router.put("/organizations/{organization_id}/providers/{provider_id}/keys/{key_id}", auth=jwt_auth, tags=["密钥管理"])
@envelope_errors
def update_provider_key(request, organization_id: str, provider_id: str, key_id: str, payload: ProviderKeyUpdateRequest):
    """更新密钥属性（label、priority、is_active 等）。"""
    provider, err = _get_provider_with_access(request, organization_id, provider_id, write=True)
    if err:
        return err

    try:
        key = LLMProviderKey.objects.get(id=key_id, provider_id=provider_id)
    except LLMProviderKey.DoesNotExist:
        return error_response_with_status("NOT_FOUND", message=get_text("llm.key_not_found", key=key_id), status_code=404)

    if payload.label is not None:
        key.label = payload.label.strip()
    if payload.api_key is not None:
        key.api_key = payload.api_key.strip()
    if payload.priority is not None:
        key.priority = payload.priority
    # v0.1：LLMProviderKey.is_active 字段已删（0022）；
    # payload.is_active=False 等价于"永久禁用"——映射为 disabled_until=now+10y。
    if getattr(payload, "is_active", None) is False:
        from datetime import timedelta
        from django.utils import timezone as _tz
        key.disabled_until = _tz.now() + timedelta(days=3650)
        key.disabled_reason = "manual_disable"
    elif getattr(payload, "is_active", None) is True:
        key.disabled_until = None
        key.disabled_reason = ""
    key.save()

    return success_response(data=_serialize_key(key))


@router.delete("/organizations/{organization_id}/providers/{provider_id}/keys/{key_id}", auth=jwt_auth, tags=["密钥管理"])
@envelope_errors
def delete_provider_key(request, organization_id: str, provider_id: str, key_id: str):
    """删除指定密钥。"""
    provider, err = _get_provider_with_access(request, organization_id, provider_id, write=True)
    if err:
        return err

    try:
        key = LLMProviderKey.objects.get(id=key_id, provider_id=provider_id)
    except LLMProviderKey.DoesNotExist:
        return error_response_with_status("NOT_FOUND", message=get_text("llm.key_not_found", key=key_id), status_code=404)

    key.delete()
    return success_response(message=get_text("llm.key_delete_success"))
