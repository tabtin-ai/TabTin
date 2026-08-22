from __future__ import annotations

from typing import Optional

from ninja import Router

from apps.agent_memory.error_codes import ServiceError
from apps.agent_memory.schemas import (
    MemoryCorrectRequest,
    MemoryFeedbackRequest,
    MemoryLifecycleRequest,
    MemoryRecordRequest,
    WorkspaceMemorySettingsUpdateRequest,
)
from apps.agent_memory.services import AgentMemoryService
from apps.agent_memory.workspace_settings import (
    WorkspaceMemoryOwner,
    WorkspaceMemorySettingsError,
    WorkspaceMemorySettingsService,
    serialize_memory_model,
)
from apps.i18n.response import error_response_with_status, success_response
from apps.users.auth.permissions import JWTAuth


router = Router(tags=["AgentMemory"])
jwt_auth = JWTAuth()
_API_RESPONSE_SCHEMA = {200: dict, 201: dict, ...: dict}


def _handle_service_error(error: ServiceError):
    return error_response_with_status(
        error.code,
        error.message,
        status_code=error.status,
        data=error.data,
    )


def _handle_workspace_settings_error(error: WorkspaceMemorySettingsError):
    if error.code in {"UNAUTHORIZED"}:
        status = 401
    elif error.code in {"WORKSPACE_MEMORY_PERMISSION_DENIED"}:
        status = 403
    elif error.code in {
        "WORKSPACE_NOT_FOUND",
        "ORGANIZATION_WORKSPACE_NOT_FOUND",
        "WORKSPACE_MEMORY_MODEL_NOT_FOUND",
    }:
        status = 404
    else:
        status = 422
    return error_response_with_status(
        error.code,
        str(error),
        status_code=status,
        data=(
            {"incompatible_scenes": list(error.incompatible_scenes)}
            if error.incompatible_scenes
            else None
        ),
    )


def _workspace_settings_payload(
    service: WorkspaceMemorySettingsService,
    owner: WorkspaceMemoryOwner,
    settings,
):
    return {
        "workspace_scope": owner.scope,
        "auto_memory_enabled": bool(settings.auto_memory_enabled),
        "memory_model_mode": settings.memory_model_mode,
        "memory_model": serialize_memory_model(settings.memory_model),
        "can_update": service.can_update(owner),
    }


@router.get("/workspace-settings/", auth=jwt_auth, response=_API_RESPONSE_SCHEMA)
def get_workspace_memory_settings_api(request, organization_id: str):
    try:
        service = WorkspaceMemorySettingsService(request.auth)
        owner = service.resolve_owner(organization_id)
        return success_response(
            _workspace_settings_payload(service, owner, service.get(owner))
        )
    except WorkspaceMemorySettingsError as error:
        return _handle_workspace_settings_error(error)


@router.put("/workspace-settings/", auth=jwt_auth, response=_API_RESPONSE_SCHEMA)
def update_workspace_memory_settings_api(
    request,
    payload: WorkspaceMemorySettingsUpdateRequest,
):
    try:
        service = WorkspaceMemorySettingsService(request.auth)
        owner = service.resolve_owner(payload.organization_id)
        settings = service.update(
            owner,
            auto_memory_enabled=payload.auto_memory_enabled,
            memory_model_mode=payload.memory_model_mode,
            memory_model_id=payload.memory_model_id,
        )
        return success_response(_workspace_settings_payload(service, owner, settings))
    except WorkspaceMemorySettingsError as error:
        return _handle_workspace_settings_error(error)


@router.get(
    "/workspace-settings/models/",
    auth=jwt_auth,
    response=_API_RESPONSE_SCHEMA,
)
def list_workspace_memory_models_api(request, organization_id: str):
    try:
        service = WorkspaceMemorySettingsService(request.auth)
        owner = service.resolve_owner(organization_id)
        eligible, unavailable = service.list_model_options(owner)
        return success_response(
            {
                "workspace_scope": owner.scope,
                "items": [
                    serialize_memory_model(model)
                    for model in eligible
                ],
                "unavailable_items": [
                    {
                        **serialize_memory_model(model),
                        "reason_code": error.code,
                        "incompatible_scenes": list(error.incompatible_scenes),
                    }
                    for model, error in unavailable
                ],
            }
        )
    except WorkspaceMemorySettingsError as error:
        return _handle_workspace_settings_error(error)


def _scope(service: AgentMemoryService, payload):
    return service.resolve_scope(
        organization_id=payload.organization_id,
        agent_id=payload.agent_id,
        space_id=payload.space_id,
    )


@router.get("/diary-feed/", auth=jwt_auth, response=_API_RESPONSE_SCHEMA)
def list_org_diary_feed(
    request,
    organization_id: str,
    search: str = "",
    state: str = "active",
    cursor: str = "",
    limit: int = 30,
):
    """Organization 级跨 Agent diary 只读聚合。

    仅返回当前 subject + 可用 Agent 的 ``memory_type=diary``；遵守记忆总开关；
    不接受 governance_view。旧 TabMemo diary 不混排（见服务层 legacy_policy）。
    """
    try:
        service = AgentMemoryService(request.auth)
        return success_response(
            service.list_org_diary_feed(
                organization_id=organization_id,
                search=search,
                state=state,
                cursor=cursor,
                limit=limit,
            )
        )
    except ServiceError as error:
        return _handle_service_error(error)


@router.get("/memories/", auth=jwt_auth, response=_API_RESPONSE_SCHEMA)
def list_memories(
    request,
    organization_id: str,
    agent_id: Optional[str] = None,
    space_id: Optional[str] = None,
    search: str = "",
    memory_type: str = "",
    state: str = "active",
    cursor: str = "",
    limit: int = 30,
    governance_view: bool = False,
):
    """列出记忆。``governance_view=true`` 仅供治理面板在总闸关闭时仍能看到
    历史条目以便忘记（ 治理闭环缺口）；运行时召回 / ``memory_search``
    工具绝不传该参数，因此关闸后仍严格 fail-closed 不召回。
    """
    try:
        service = AgentMemoryService(request.auth)
        scope = service.resolve_scope(
            organization_id=organization_id,
            agent_id=agent_id,
            space_id=space_id,
        )
        return success_response(
            service.list_memories(
                scope=scope,
                search=search,
                memory_type=memory_type,
                state=state,
                cursor=cursor,
                limit=limit,
                governance_view=governance_view,
            )
        )
    except ServiceError as error:
        return _handle_service_error(error)


@router.get("/memories/stats/", auth=jwt_auth, response=_API_RESPONSE_SCHEMA)
def stats_memories(
    request,
    organization_id: str,
    agent_id: Optional[str] = None,
    space_id: Optional[str] = None,
    governance_view: bool = False,
):
    try:
        service = AgentMemoryService(request.auth)
        scope = service.resolve_scope(
            organization_id=organization_id,
            agent_id=agent_id,
            space_id=space_id,
        )
        return success_response(
            service.stats(scope=scope, governance_view=governance_view)
        )
    except ServiceError as error:
        return _handle_service_error(error)


@router.get("/memories/{memory_id}/", auth=jwt_auth, response=_API_RESPONSE_SCHEMA)
def get_memory(
    request,
    memory_id: str,
    organization_id: str,
    agent_id: Optional[str] = None,
    space_id: Optional[str] = None,
):
    try:
        service = AgentMemoryService(request.auth)
        scope = service.resolve_scope(
            organization_id=organization_id,
            agent_id=agent_id,
            space_id=space_id,
        )
        return success_response(
            service.serialize(
                service.get_memory(scope=scope, memory_id=memory_id)
            )
        )
    except ServiceError as error:
        return _handle_service_error(error)


@router.post("/memories/", auth=jwt_auth, response=_API_RESPONSE_SCHEMA)
def record_memory(request, payload: MemoryRecordRequest):
    try:
        service = AgentMemoryService(request.auth)
        memory = service.record(
            scope=_scope(service, payload),
            memory_type=payload.memory_type,
            content=payload.content,
            title=payload.title,
            importance=payload.importance,
            tags=payload.tags,
            source_ref=payload.source_ref,
        )
        return 201, success_response(service.serialize(memory))
    except ServiceError as error:
        return _handle_service_error(error)


@router.post(
    "/memories/{memory_id}/correct/",
    auth=jwt_auth,
    response=_API_RESPONSE_SCHEMA,
)
def correct_memory(request, memory_id: str, payload: MemoryCorrectRequest):
    try:
        service = AgentMemoryService(request.auth)
        memory = service.correct(
            scope=_scope(service, payload),
            memory_id=memory_id,
            content=payload.content,
            memory_type=payload.memory_type,
        )
        return success_response(service.serialize(memory))
    except ServiceError as error:
        return _handle_service_error(error)


@router.post(
    "/memories/{memory_id}/feedback/",
    auth=jwt_auth,
    response=_API_RESPONSE_SCHEMA,
)
def feedback_memory(request, memory_id: str, payload: MemoryFeedbackRequest):
    """重要度 / 「有用」反馈：调整活跃记忆的 importance。

    鉴权与 correct/forget 同口径（Agent owner × subject 当前用户，走
    ``resolve_scope``）；forgotten / 非活跃行拒绝（404）。
    """
    try:
        service = AgentMemoryService(request.auth)
        memory = service.adjust_importance(
            scope=_scope(service, payload),
            memory_id=memory_id,
            importance=payload.importance,
            useful=payload.useful,
        )
        return success_response(service.serialize(memory))
    except ServiceError as error:
        return _handle_service_error(error)


@router.post(
    "/memories/{memory_id}/archive/",
    auth=jwt_auth,
    response=_API_RESPONSE_SCHEMA,
)
def archive_memory(request, memory_id: str, payload: MemoryLifecycleRequest):
    try:
        service = AgentMemoryService(request.auth)
        changed = service.archive(
            scope=_scope(service, payload),
            memory_id=memory_id,
        )
        return success_response({"memory_id": memory_id, "archived": True, "changed": changed})
    except ServiceError as error:
        return _handle_service_error(error)


@router.post(
    "/memories/{memory_id}/forget/",
    auth=jwt_auth,
    response=_API_RESPONSE_SCHEMA,
)
def forget_memory(request, memory_id: str, payload: MemoryLifecycleRequest):
    try:
        service = AgentMemoryService(request.auth)
        changed = service.forget(
            scope=_scope(service, payload),
            memory_id=memory_id,
        )
        return success_response({"memory_id": memory_id, "forgotten": True, "changed": changed})
    except ServiceError as error:
        return _handle_service_error(error)
