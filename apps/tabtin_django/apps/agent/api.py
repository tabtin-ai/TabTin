"""Agent 身份 API — 挂载于 /api/agents（与 Space/Workspace 的 /api/context 分离）。"""

from __future__ import annotations

import logging
from uuid import UUID

from django.db import DatabaseError
from django.http import HttpRequest
from ninja import Router
from ninja.errors import HttpError

from apps.agent.models import Agent
from apps.agent.schemas import (
    AgentCreate,
    AgentPreferredModelUpdate,
    AgentSkillAttach,
    AgentSkillUpdate,
    AgentUpdate,
    ErrorResponse,
)
from apps.agent.serializers import serialize_agent, serialize_agent_summary
from apps.i18n import _
from apps.i18n.language import get_user_language
from apps.i18n.response import (
    error_response_with_status as error_response,
    not_found_response,
    success_response,
)
from apps.tabtinspace.services import AgentService, SpaceAccessService
from apps.tabtinspace.services.base import ServiceError
from apps.users.auth.permissions import JWTAuth

router = Router(tags=["Agent"])
jwt_auth = JWTAuth()
logger = logging.getLogger(__name__)

RESP_ERR = {401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse}
RESP_WITH_CONFLICT = {
    400: ErrorResponse,
    401: ErrorResponse,
    403: ErrorResponse,
    404: ErrorResponse,
    409: ErrorResponse,
}
RESP_CREATE_WITH_CONFLICT = {
    201: dict,
    400: ErrorResponse,
    401: ErrorResponse,
    403: ErrorResponse,
    404: ErrorResponse,
    409: ErrorResponse,
}


@router.get("", auth=jwt_auth, response={200: dict, 401: ErrorResponse, 403: ErrorResponse})
def list_organization_agents(request: HttpRequest, organization_id: UUID):
    """列出组织下的 Agent（身份）；首次进入幂等补建五个首发角色。

    默认小Tin承担日常角色，另外补齐代码、文书、数据、冲浪四个模板 Agent。
    完成后走纯读快路径；补建若遇锁超时等数据库错误，降级返回已有列表，
    避免读接口整体 500。
    """
    try:
        page = max(1, int(request.GET.get("page", "1") or "1"))
    except (ValueError, TypeError):
        page = 1
    try:
        page_size = min(max(1, int(request.GET.get("page_size", "50") or "50")), 200)
    except (ValueError, TypeError):
        page_size = 50

    agent_service = AgentService(user=request.auth)
    try:
        agent_service.ensure_starter_agent_roster_for_listing(organization_id)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    except DatabaseError:
        logger.warning(
            "ensure_starter_agent_roster_for_listing degraded for org=%s",
            organization_id,
            exc_info=True,
        )

    service = SpaceAccessService(user=request.auth)
    agents = service.list_organization_agents(organization_id)

    total = agents.count()
    offset = (page - 1) * page_size
    page_agents = agents[offset : offset + page_size]
    # 列表用摘要投影，避免逐行 resolve_personal_rules_by_owner_id 的 N+1；
    # 完整 agent_config / personal_rules 仍走 GET /agents/{id} 详情路径。
    agent_data = [serialize_agent_summary(a) for a in page_agents]

    return success_response(
        {
            "agents": agent_data,
            "total": total,
            "page": page,
            "page_size": page_size,
        }
    )


@router.get("/deactivated", auth=jwt_auth, response={200: dict, **RESP_ERR})
def list_deactivated_agents(request: HttpRequest, organization_id: UUID):
    """列出组织中已停用（软删除）的 Agent。"""
    user = request.auth
    if not user:
        raise HttpError(401, _("auth.unauthenticated"))
    service = AgentService(user=user)
    if not service.check_organization_permission(str(organization_id), "viewer"):
        raise HttpError(403, _("tabtinspace.no_organization_access"))

    agents = (
        Agent.objects.filter(
            service.owned_agent_filter(),
            organization_id=organization_id,
            is_active=False,
        )
        .only("id", "name", "type", "is_default", "settings", "created_at", "updated_at")
        .order_by("-updated_at")
    )
    items = [
        {
            "id": str(a.id),
            "name": a.name,
            "type": a.type,
            "is_default": a.is_default,
            "settings": a.settings or {},
            "created_at": a.created_at.isoformat() if a.created_at else None,
            "deactivated_at": a.updated_at.isoformat() if a.updated_at else None,
        }
        for a in agents
    ]
    return success_response({"items": items, "total": len(items)})


@router.get("/templates", auth=jwt_auth, response={200: dict, 401: ErrorResponse})
def list_agent_templates_api(request: HttpRequest):
    from apps.services.common.agent_template_registry import list_agent_templates

    templates = [
        {
            "id": template.id,
            "version": template.version,
            "name": template.name,
            "icon": template.icon,
            "avatar_key": template.avatar_key,
            "tagline": template.tagline,
            "description": template.description,
            "skills": list(template.skills),
        }
        for template in list_agent_templates()
    ]
    return success_response({"templates": templates, "total": len(templates)})


@router.get(
    "/{agent_id}/skills",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR},
)
def list_agent_skills(request: HttpRequest, agent_id: UUID):
    from apps.skills.services.agent_link_service import AgentSkillLinkService

    agent = AgentService(user=request.auth).get_agent(agent_id)
    if agent is None:
        return not_found_response()
    items = AgentSkillLinkService.list_links(
        agent,
        requesting_user_id=getattr(request.auth, "id", None),
    )
    return success_response({"skills": items, "total": len(items)})


@router.post(
    "/{agent_id}/skills",
    auth=jwt_auth,
    response={200: dict, **RESP_WITH_CONFLICT},
)
def attach_agent_skill(
    request: HttpRequest,
    agent_id: UUID,
    payload: AgentSkillAttach,
):
    from apps.skills.services.agent_link_service import (
        AgentSkillLinkError,
        AgentSkillLinkNotFoundError,
        AgentSkillLinkService,
    )

    agent = AgentService(user=request.auth).get_agent(agent_id)
    if agent is None:
        return not_found_response()
    try:
        item = AgentSkillLinkService.attach_skill(
            agent,
            skill_canonical_key=payload.skill_canonical_key,
            requesting_user_id=request.auth.id,
            space_id=payload.space_id,
            enabled=payload.enabled,
        )
    except AgentSkillLinkNotFoundError as exc:
        return error_response("SKILL_NOT_FOUND", str(exc), status_code=404)
    except AgentSkillLinkError as exc:
        return error_response("INVALID_SKILL_LINK", str(exc), status_code=400)
    return success_response(item)


@router.patch(
    "/{agent_id}/skills/{path:skill_canonical_key}",
    auth=jwt_auth,
    response={200: dict, **RESP_WITH_CONFLICT},
)
def update_agent_skill(
    request: HttpRequest,
    agent_id: UUID,
    skill_canonical_key: str,
    payload: AgentSkillUpdate,
):
    from apps.skills.services.agent_link_service import (
        AgentSkillLinkCredentialValidationError,
        AgentSkillLinkError,
        AgentSkillLinkLockedError,
        AgentSkillLinkNotFoundError,
        AgentSkillLinkService,
    )
    from apps.tabtinspace.services.app_settings_service import AppSettingsService

    agent = AgentService(user=request.auth).get_agent(agent_id)
    if agent is None:
        return not_found_response()
    try:
        item = AgentSkillLinkService.update_link(
            agent,
            skill_canonical_key=skill_canonical_key,
            requesting_user_id=request.auth.id,
            enabled=payload.enabled,
            config_json=payload.config_json,
            space_id=payload.space_id,
        )
    except AgentSkillLinkNotFoundError as exc:
        return error_response("SKILL_LINK_NOT_FOUND", str(exc), status_code=404)
    except AgentSkillLinkLockedError as exc:
        return error_response(exc.err_code, str(exc), status_code=400)
    except AgentSkillLinkCredentialValidationError as exc:
        status_code = (
            503 if exc.err_code == AppSettingsService.CRED_ERR_DB_ERROR else 400
        )
        return error_response(exc.err_code, str(exc), status_code=status_code)
    except AgentSkillLinkError as exc:
        return error_response("INVALID_SKILL_LINK", str(exc), status_code=400)
    return success_response(item)


@router.delete(
    "/{agent_id}/skills/{path:skill_canonical_key}",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR},
)
def detach_agent_skill(
    request: HttpRequest,
    agent_id: UUID,
    skill_canonical_key: str,
    space_id: UUID | None = None,
):
    from apps.skills.services.agent_link_service import (
        AgentSkillLinkError,
        AgentSkillLinkLockedError,
        AgentSkillLinkService,
    )

    agent = AgentService(user=request.auth).get_agent(agent_id)
    if agent is None:
        return not_found_response()
    try:
        found = AgentSkillLinkService.detach_skill(
            agent,
            skill_canonical_key=skill_canonical_key,
            space_id=space_id,
        )
    except AgentSkillLinkLockedError as exc:
        return error_response(exc.err_code, str(exc), status_code=400)
    except AgentSkillLinkError as exc:
        return error_response("INVALID_SKILL_LINK", str(exc), status_code=400)
    return success_response(
        {"skill_canonical_key": skill_canonical_key, "found": found}
    )


@router.get("/{agent_id}", auth=jwt_auth, response={200: dict, **RESP_ERR})
def get_agent(request: HttpRequest, agent_id: UUID):
    service = AgentService(user=request.auth)
    agent = service.get_agent(agent_id)
    if not agent:
        return not_found_response(
            language=get_user_language(request=request, user=request.auth)
        )
    return success_response(serialize_agent(agent))


@router.post("", auth=jwt_auth, response=RESP_CREATE_WITH_CONFLICT)
def create_agent(request: HttpRequest, data: AgentCreate):
    service = AgentService(user=request.auth)
    try:
        agent = service.create_agent(
            organization_id=data.organization_id,
            name=data.name,
            agent_type=data.type,
            custom_rules=data.custom_rules,
            goal=data.goal,
            agent_config=data.agent_config,
            template_id=data.template_id,
            avatar_key=data.avatar_key,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    return 201, success_response(
        data=serialize_agent(agent),
        message=_("tabtinspace.agent_created"),
    )


@router.put("/{agent_id}", auth=jwt_auth, response={200: dict, **RESP_WITH_CONFLICT})
def update_agent(request: HttpRequest, agent_id: UUID, data: AgentUpdate):
    service = AgentService(user=request.auth)
    # agent_config 三态：未传不动、显式 null 清回继承、非 null 覆盖。
    # 必须 exclude_unset（不能 exclude_none），否则显式 null 会被剥掉。
    agent_config_dict = (
        data.agent_config.model_dump(exclude_unset=True)
        if data.agent_config is not None
        else None
    )
    # avatar_url 三态：未传不动、显式 "" 清除、非空写入 settings。
    update_avatar_url = "avatar_url" in data.model_fields_set
    update_avatar_key = "avatar_key" in data.model_fields_set
    try:
        agent = service.update_agent(
            agent_id=agent_id,
            name=data.name,
            custom_rules=data.custom_rules,
            goal=data.goal,
            suggested_prompts=data.suggested_prompts,
            agent_config=agent_config_dict,
            avatar_url=data.avatar_url if update_avatar_url else None,
            update_avatar_url=update_avatar_url,
            avatar_key=data.avatar_key if update_avatar_key else None,
            update_avatar_key=update_avatar_key,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status, data=e.data)
    return success_response(
        data=serialize_agent(agent),
        message=_("tabtinspace.agent_updated"),
    )


@router.delete("/{agent_id}", auth=jwt_auth, response={200: dict, **RESP_ERR})
def delete_agent(request: HttpRequest, agent_id: UUID):
    """停用 Agent；不修改其他领域对象。"""
    service = AgentService(user=request.auth)
    try:
        success = service.delete_agent(agent_id)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    if not success:
        return not_found_response(
            language=get_user_language(request=request, user=request.auth)
        )
    return success_response(message=_("tabtinspace.agent_deleted"))


@router.delete("/{agent_id}/permanent", auth=jwt_auth, response={200: dict, **RESP_ERR})
def permanently_delete_agent(request: HttpRequest, agent_id: UUID):
    """永久删除已停用 Agent；历史资产按各领域外键契约保留。"""
    service = AgentService(user=request.auth)
    try:
        success = service.permanently_delete_agent(agent_id)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    if not success:
        return not_found_response(
            language=get_user_language(request=request, user=request.auth)
        )
    return success_response(message=_("tabtinspace.agent_permanently_deleted"))


@router.post("/{agent_id}/reactivate", auth=jwt_auth, response={200: dict, **RESP_ERR})
def reactivate_agent(request: HttpRequest, agent_id: UUID):
    """重新激活已停用的 Agent。"""
    service = AgentService(user=request.auth)
    try:
        success = service.reactivate_agent(agent_id)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    if not success:
        return not_found_response(
            language=get_user_language(request=request, user=request.auth)
        )
    # Electron 的恢复链路需要用恢复后的完整 Agent 更新本地缓存；只返回
    # success/message 会让客户端拿到 undefined，随后在合并 Agent 时崩溃。
    agent = service.get_agent(agent_id)
    if agent is None:
        return not_found_response(
            language=get_user_language(request=request, user=request.auth)
        )
    return success_response(
        data=serialize_agent(agent),
        message=_("tabtinspace.agent_reactivated"),
    )


@router.patch(
    "/{agent_id}/preferred-model",
    auth=jwt_auth,
    response={200: dict, 400: ErrorResponse, **RESP_ERR},
)
def update_preferred_model(
    request: HttpRequest, agent_id: UUID, payload: AgentPreferredModelUpdate
):
    """更新 Agent 偏好模型（轻量级，无 CAS 版本控制）。

    ：仅接受平台模型 UUID 或空串（清空）；拒绝本机 Codex id 等非目录值，
    避免污染 Agent.preferred_model_id 导致自述与会话模型不一致。
    """
    agent = Agent.objects.filter(id=agent_id).first()
    if not agent:
        return not_found_response(
            language=get_user_language(request=request, user=request.auth)
        )
    service = AgentService(user=request.auth)
    if not service.check_agent_owner(agent):
        return not_found_response(
            language=get_user_language(request=request, user=request.auth)
        )
    model_id = (payload.model_id or "").strip()
    if model_id:
        try:
            UUID(model_id)
        except (TypeError, ValueError, AttributeError):
            return error_response(
                "INVALID_PREFERRED_MODEL",
                "preferred_model_id must be a platform model UUID or empty",
                status_code=400,
            )
    agent.preferred_model_id = model_id
    agent.save(update_fields=["preferred_model_id", "updated_at"])
    return success_response(data={"preferred_model_id": model_id})


__all__ = ["router"]
