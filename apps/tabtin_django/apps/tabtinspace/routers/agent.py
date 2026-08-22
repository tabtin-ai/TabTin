"""Agent 身份旧路径的限时兼容适配器。

实现只委托 ``apps.agent.api``，不保留第二套业务逻辑。设备与审批记忆不做
Agent 维度兼容，分别使用 Workspace 接口。

例外：``GET /agents/{id}/local-mcp/attachments`` 是 Agent MCP 只读同步的正典
路径（手机问当前用户在线 Electron），挂在 ``/api/context`` 下，不做 Deprecation。
"""

import logging
from uuid import UUID

from django.http import HttpRequest, HttpResponse
from ninja import Router

from apps.agent.api import (
    create_agent,
    delete_agent,
    get_agent,
    list_agent_templates_api,
    list_deactivated_agents,
    list_organization_agents,
    reactivate_agent,
    update_agent,
    update_preferred_model,
)
from apps.agent.schemas import AgentCreate, AgentPreferredModelUpdate, AgentUpdate
from apps.i18n.response import (
    error_response_with_status as error_response,
    not_found_response,
    success_response,
)
from apps.users.auth.permissions import JWTAuth

logger = logging.getLogger(__name__)
router = Router(tags=["Agent Legacy"])
jwt_auth = JWTAuth()

LEGACY_AGENT_API_SUNSET = "Wed, 30 Sep 2026 23:59:59 GMT"
LEGACY_AGENT_API_SUCCESSOR = "/api/agents"


def _mark_legacy(response: HttpResponse, route: str) -> None:
    response["Deprecation"] = "true"
    response["Sunset"] = LEGACY_AGENT_API_SUNSET
    response["Link"] = f'<{LEGACY_AGENT_API_SUCCESSOR}>; rel="successor-version"'
    logger.info("legacy Agent API used: route=%s", route)


@router.get("/agents", auth=jwt_auth)
def legacy_list_agents(request, response: HttpResponse, organization_id: UUID):
    _mark_legacy(response, "context.agents.list")
    return list_organization_agents(request, organization_id)


@router.post(
    "/agents",
    auth=jwt_auth,
    response={
        201: dict,
        400: dict,
        401: dict,
        403: dict,
        404: dict,
        409: dict,
    },
)
def legacy_create_agent(request, response: HttpResponse, data: AgentCreate):
    _mark_legacy(response, "context.agents.create")
    return create_agent(request, data)


# 必须在 /agents/{agent_id} 之前注册，否则字面量 "templates" 会被当成 UUID。
@router.get("/agents/templates", auth=jwt_auth, response={200: dict, 401: dict})
def legacy_list_agent_templates(request, response: HttpResponse):
    _mark_legacy(response, "context.agents.templates")
    return list_agent_templates_api(request)


@router.get("/agents/{agent_id}", auth=jwt_auth)
def legacy_get_agent(request, response: HttpResponse, agent_id: UUID):
    _mark_legacy(response, "context.agents.detail")
    return get_agent(request, agent_id)


@router.get(
    "/agents/{agent_id}/local-mcp/attachments",
    auth=jwt_auth,
    response={
        200: dict,
        400: dict,
        401: dict,
        403: dict,
        404: dict,
        409: dict,
        500: dict,
        502: dict,
        504: dict,
    },
)
def list_agent_local_mcp_attachments(request: HttpRequest, agent_id: UUID):
    """查询当前用户在线 Electron 上，该 Agent 已挂载且启用的 MCP 摘要。

    经设备 action ``mcp.list_agent_attachments`` 派发；不做云端 attach 投影。
    电脑离线返回 409 ``DEVICE_RUNTIME_OFFLINE`` / ``DEVICE_RUNTIME_UNAVAILABLE``。
    """
    from apps.services.agent_engine.services.device_runtime_query_service import (
        DeviceRuntimeQueryService,
    )
    from apps.tabtinspace.services import AgentService

    # 读权限：与 Agent 详情一致，仅 owner 可见（Organization 角色不授予 Agent 读权）。
    agent = AgentService(user=request.auth).get_agent(agent_id)
    if agent is None:
        return not_found_response()

    result = DeviceRuntimeQueryService(user=request.auth).dispatch_user_electron_query(
        agent_id=str(agent_id),
        action="mcp.list_agent_attachments",
        params={"agent_id": str(agent_id)},
        timeout_seconds=20,
    )
    if not result.get("success"):
        return error_response(
            str(result.get("error_code") or "DEVICE_ACTION_FAILED"),
            result.get("error") or "设备动作执行失败",
            status_code=int(result.get("http_status") or 409),
            data=result,
        )

    # Electron bridge 成功形态：``{ success, data: { connections: [...] } }``
    nested = result.get("data") if isinstance(result.get("data"), dict) else {}
    connections = nested.get("connections")
    if connections is None:
        connections = result.get("connections", [])
    if not isinstance(connections, list):
        connections = []
    return success_response(data={"connections": connections})


@router.put("/agents/{agent_id}", auth=jwt_auth)
def legacy_update_agent(
    request,
    response: HttpResponse,
    agent_id: UUID,
    data: AgentUpdate,
):
    _mark_legacy(response, "context.agents.update")
    return update_agent(request, agent_id, data)


@router.delete("/agents/{agent_id}", auth=jwt_auth)
def legacy_delete_agent(request, response: HttpResponse, agent_id: UUID):
    _mark_legacy(response, "context.agents.delete")
    return delete_agent(request, agent_id)


@router.post("/agents/{agent_id}/reactivate", auth=jwt_auth)
def legacy_reactivate_agent(request, response: HttpResponse, agent_id: UUID):
    _mark_legacy(response, "context.agents.reactivate")
    return reactivate_agent(request, agent_id)


@router.patch("/agents/{agent_id}/preferred-model", auth=jwt_auth)
def legacy_update_preferred_model(
    request,
    response: HttpResponse,
    agent_id: UUID,
    payload: AgentPreferredModelUpdate,
):
    _mark_legacy(response, "context.agents.preferred_model")
    return update_preferred_model(request, agent_id, payload)


@router.get("/organizations/{organization_id}/agents", auth=jwt_auth)
def legacy_list_organization_agents(
    request,
    response: HttpResponse,
    organization_id: UUID,
):
    _mark_legacy(response, "context.organizations.agents")
    return list_organization_agents(request, organization_id)


@router.get("/organizations/{organization_id}/deactivated-agents", auth=jwt_auth)
def legacy_list_deactivated_agents(
    request,
    response: HttpResponse,
    organization_id: UUID,
):
    _mark_legacy(response, "context.organizations.deactivated_agents")
    return list_deactivated_agents(request, organization_id)

__all__ = ["router"]
