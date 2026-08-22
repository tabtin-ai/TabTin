"""Tabtin Space capability 路由。"""

from .shared import *  # noqa: F401,F403
from apps.services.common.agent_governance_resolver import ORG_ALLOW_MEMBER_YOLO_DEFAULT

router = Router(tags=["Tabtin Space"])

@router.get("/security-presets", auth=jwt_auth, response={200: dict, 401: ErrorResponse})
def get_security_presets(request: HttpRequest):
    """返回安全配置 schema（：Yolo 准入天花板在组织 settings）。"""
    return success_response(data={
        "schema": {
            "organization": {
                "allow_member_yolo": {
                    "type": "boolean",
                    "default": ORG_ALLOW_MEMBER_YOLO_DEFAULT,
                },
            },
        },
    })

# ：Workspace / Project 正式路径；/spaces/... 过渡别名保留至 Space 壳 DROP。
@router.get("/spaces/{space_id}/available-tools", auth=jwt_auth, response={200: dict, **RESP_ERR})
@router.get("/workspaces/{space_id}/available-tools", auth=jwt_auth, response={200: dict, **RESP_ERR})
@router.get("/projects/{space_id}/available-tools", auth=jwt_auth, response={200: dict, **RESP_ERR})
def list_space_available_tools(request: HttpRequest, space_id: UUID):
    if not BaseService(user=request.auth).check_space_permission(str(space_id), "viewer"):
        return permission_denied_response(_("tabtinspace.no_space_access"))
    uid = str(request.auth.id)
    tools = _serialize_space_available_tools(uid, str(space_id))
    return success_response(data={"tools": tools, "total": len(tools)})

@router.get("/spaces/{space_id}/capability-discovery", auth=jwt_auth, response={200: dict, **RESP_ERR_400})
@router.get("/workspaces/{space_id}/capability-discovery", auth=jwt_auth, response={200: dict, **RESP_ERR_400})
@router.get("/projects/{space_id}/capability-discovery", auth=jwt_auth, response={200: dict, **RESP_ERR_400})
def get_space_capability_discovery(request: HttpRequest, space_id: UUID):
    service = CapabilityDiscoveryService(user=request.auth)
    try:
        summary = service.get_space_summary(str(space_id))
    except ServiceError as exc:
        return error_response(exc.code, exc.message or "获取能力发现摘要失败", status_code=exc.status)
    return success_response(data=CapabilityDiscoverySpaceSummaryOut(**summary).dict())

@router.post("/spaces/{space_id}/capability-refresh", auth=jwt_auth, response={200: dict, 202: dict, **RESP_WITH_CONFLICT})
@router.post("/workspaces/{space_id}/capability-refresh", auth=jwt_auth, response={200: dict, 202: dict, **RESP_WITH_CONFLICT})
@router.post("/projects/{space_id}/capability-refresh", auth=jwt_auth, response={200: dict, 202: dict, **RESP_WITH_CONFLICT})
def refresh_space_capability_discovery(request: HttpRequest, space_id: UUID, payload: CapabilityRefreshRequest):
    service = CapabilityDiscoveryService(user=request.auth)
    try:
        result = service.initiate_space_refresh(
            space_id=str(space_id),
            requested_by=payload.requested_by,
        )
    except ServiceError as exc:
        return error_response(exc.code, exc.message or "触发能力刷新失败", status_code=exc.status)

    status = result.get("status")
    if status == "pending":
        status_code = 202
    elif status == "offline":
        status_code = 409
    elif status == "unsupported":
        status_code = 409
    elif status == "failed":
        status_code = 409
    else:
        status_code = 200

    return status_code, success_response(
        data=CapabilityRefreshResponse(**result).dict(),
        message="执行设备能力刷新请求已发起" if status == "pending" else "执行设备能力刷新请求已处理",
    )

__all__ = ["router"]
