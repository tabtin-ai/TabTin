"""Tabtin Space mcp_connection 路由。

local（device）与 remote（organization）均开放；remote 仅 http。
"""

from .shared import *  # noqa: F401,F403

router = Router(tags=["Tabtin Space"])

@router.post("/devices/{device_id}/mcp-connections", auth=jwt_auth, response={200: dict, **RESP_ERR_400})
def create_mcp_connection(request: HttpRequest, device_id: UUID, payload: MCPConnectionCreate):
    from apps.tabtinspace.services.mcp_connection_service import MCPConnectionService
    service = MCPConnectionService(user=request.auth)
    try:
        conn = service.create_connection(
            device_id=device_id,
            name=payload.name,
            description=payload.description,
            transport=payload.transport,
            command=payload.command,
            args=payload.args,
            cwd=payload.cwd,
            endpoint=payload.endpoint,
            config=payload.config,
            credential_value=payload.credential_value,
            credential_name=payload.credential_name,
            enabled=payload.enabled,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    if not conn:
        return not_found_response(_("tabtinspace.device_not_found"))
    return success_response(data=MCPConnectionOut.from_connection(conn).dict(), message="MCP 连接创建成功")

@router.get("/devices/{device_id}/mcp-connections", auth=jwt_auth, response={200: dict, 401: ErrorResponse})
def list_mcp_connections(request: HttpRequest, device_id: UUID):
    from apps.tabtinspace.services.mcp_connection_service import MCPConnectionService
    service = MCPConnectionService(user=request.auth)
    connections = service.list_connections(device_id=device_id)
    data = [MCPConnectionOut.from_connection(c).dict() for c in connections]
    return success_response(data={"connections": data, "total": len(data)})

@router.get(
    "/organizations/{organization_id}/mcp-connections",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR},
)
def list_org_mcp_connections(request: HttpRequest, organization_id: UUID):
    from apps.tabtinspace.services.mcp_connection_service import MCPConnectionService
    service = MCPConnectionService(user=request.auth)
    connections = service.list_org_connections(organization_id=organization_id)
    data = [MCPConnectionOut.from_connection(c).dict() for c in connections]
    return success_response(data={"connections": data, "total": len(data)})

@router.post(
    "/organizations/{organization_id}/mcp-connections",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR_400},
)
def create_org_mcp_connection(request: HttpRequest, organization_id: UUID, payload: MCPConnectionOrgCreate):
    from apps.tabtinspace.services.mcp_connection_service import MCPConnectionService
    service = MCPConnectionService(user=request.auth)
    try:
        conn = service.create_org_connection(
            organization_id=organization_id,
            name=payload.name,
            description=payload.description,
            endpoint=payload.endpoint,
            config=payload.config,
            credential_value=payload.credential_value,
            credential_name=payload.credential_name,
            enabled=payload.enabled,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return success_response(data=MCPConnectionOut.from_connection(conn).dict(), message="组织远程 MCP 连接已创建")

@router.patch("/mcp-connections/{connection_id}", auth=jwt_auth, response={200: dict, **RESP_ERR_400})
def update_mcp_connection(request: HttpRequest, connection_id: UUID, payload: MCPConnectionUpdate):
    from apps.tabtinspace.services.mcp_connection_service import MCPConnectionService
    service = MCPConnectionService(user=request.auth)
    try:
        conn = service.update_connection(
            connection_id=connection_id,
            name=payload.name,
            description=payload.description,
            transport=payload.transport,
            command=payload.command,
            args=payload.args,
            cwd=payload.cwd,
            endpoint=payload.endpoint,
            config=payload.config,
            credential_value=payload.credential_value,
            enabled=payload.enabled,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    if not conn:
        return not_found_response(_("tabtinspace.mcp_connection_not_found"))
    return success_response(data=MCPConnectionOut.from_connection(conn).dict(), message="MCP 连接更新成功")

@router.delete("/mcp-connections/{connection_id}", auth=jwt_auth, response={200: dict, **RESP_ERR})
def delete_mcp_connection(request: HttpRequest, connection_id: UUID):
    from apps.tabtinspace.services.mcp_connection_service import MCPConnectionService
    service = MCPConnectionService(user=request.auth)
    try:
        if not service.delete_connection(connection_id=connection_id):
            return not_found_response(_("tabtinspace.mcp_connection_not_found"))
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return success_response(message="MCP 连接已删除")

@router.post("/mcp-connections/{connection_id}/probe", auth=jwt_auth, response={200: dict, **RESP_ERR})
def probe_mcp_connection(request: HttpRequest, connection_id: UUID, payload: MCPConnectionProbe):
    """写入 Electron 端回传的 probe 健康结果（后端只存，不真连）。"""
    from apps.tabtinspace.services.mcp_connection_service import MCPConnectionService
    service = MCPConnectionService(user=request.auth)
    conn = service.record_probe(connection_id=connection_id, last_probe=payload.last_probe)
    if not conn:
        return not_found_response(_("tabtinspace.mcp_connection_not_found"))
    return success_response(data=MCPConnectionOut.from_connection(conn).dict(), message="MCP 探针结果已记录")

@router.get(
    "/mcp-connections/{connection_id}/runtime-config",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR},
)
def get_mcp_runtime_config(request: HttpRequest, connection_id: UUID):
    """Electron main 取解密 transport；勿写入 renderer / 日志。"""
    from apps.tabtinspace.services.mcp_connection_service import MCPConnectionService
    service = MCPConnectionService(user=request.auth)
    try:
        data = service.get_runtime_config(connection_id=connection_id)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return success_response(data=data)

__all__ = ["router"]
