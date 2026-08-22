"""Tabtin Space remote_server 路由。"""

from .shared import *  # noqa: F401,F403

router = Router(tags=["Tabtin Space"])

@router.post("/devices/{device_id}/ssh-servers", auth=jwt_auth, response={200: dict, **RESP_ERR_400})
def create_ssh_server(request: HttpRequest, device_id: UUID, payload: RemoteServerCreate):
    from apps.tabtinspace.services.remote_server_service import RemoteServerService
    service = RemoteServerService(user=request.auth)
    server = service.create_server(
        device_id=device_id,
        name=payload.name,
        host=payload.host,
        port=payload.port,
        username=payload.username,
        auth_method=payload.auth_method,
        credential_value=payload.credential_value,
        credential_name=payload.credential_name,
    )
    if not server:
        return not_found_response(_("tabtinspace.device_not_found"))
    return success_response(data=RemoteServerOut.from_server(server).dict(), message="SSH 服务器创建成功")

@router.get("/devices/{device_id}/ssh-servers", auth=jwt_auth, response={200: dict, 401: ErrorResponse})
def list_ssh_servers(request: HttpRequest, device_id: UUID):
    from apps.tabtinspace.services.remote_server_service import RemoteServerService
    service = RemoteServerService(user=request.auth)
    servers = service.list_servers(device_id=device_id)
    data = [RemoteServerOut.from_server(s).dict() for s in servers]
    return success_response(data={"servers": data, "total": len(data)})

@router.patch("/ssh-servers/{server_id}", auth=jwt_auth, response={200: dict, **RESP_ERR_400})
def update_ssh_server(request: HttpRequest, server_id: UUID, payload: RemoteServerUpdate):
    from apps.tabtinspace.services.remote_server_service import RemoteServerService
    service = RemoteServerService(user=request.auth)
    server = service.update_server(
        server_id=server_id,
        name=payload.name,
        host=payload.host,
        port=payload.port,
        username=payload.username,
        auth_method=payload.auth_method,
        credential_value=payload.credential_value,
        status=payload.status,
    )
    if not server:
        return not_found_response(_("tabtinspace.server_not_found"))
    return success_response(data=RemoteServerOut.from_server(server).dict(), message="SSH 服务器更新成功")

@router.delete("/ssh-servers/{server_id}", auth=jwt_auth, response={200: dict, **RESP_ERR})
def delete_ssh_server(request: HttpRequest, server_id: UUID):
    from apps.tabtinspace.services.remote_server_service import RemoteServerService
    service = RemoteServerService(user=request.auth)
    if not service.delete_server(server_id=server_id):
        return not_found_response(_("tabtinspace.server_not_found"))
    return success_response(message="SSH 服务器已删除")

@router.post("/ssh-servers/{server_id}/test", auth=jwt_auth, response={200: dict, **RESP_ERR})
def test_ssh_connection(request: HttpRequest, server_id: UUID):
    """SSH 连通性测试。

    Wave 1 A2 改造（含 review 自修：补 ``detail.reason`` 与 generate_title 同源）：
    连接失败（SSH timeout / auth 错 / unreachable）→
    ``err_response('SOFT_FAIL', retryable=True, detail={'fallback': {...}, 'reason': 'connection_failed'})``，
    前端默认 throw + 显示错误，不再被 ``{success: false, error}`` 包成 ``ok:true``
    的 envelope 误当作"测试成功"处理。

    ``detail.reason`` 与 ``generate_title`` 三个分支保持同源（fail-soft 路径子结构
    一致：``fallback`` 是兜底数据，``reason`` 是机器可读的失败子类）；本期统一用
    ``connection_failed`` 一个值，后续若要细分（``timeout`` / ``auth_failed`` /
    ``unreachable``）由 service 层在 result.reason 显式给出。

    服务器不存在 → ``error_response_with_status('NOT_FOUND', ...)``。
    """
    from apps.tabtinspace.services.ssh_execution_service import SSHExecutionService
    from apps.services.common.error_codes import err_response
    ssh_service = SSHExecutionService()
    result = ssh_service.test_connection(server_id, user=request.auth)
    if result is None:
        return not_found_response(_("tabtinspace.server_not_found"))
    if not result.get("ok"):
        return err_response(
            'SOFT_FAIL',
            _("tabtinspace.ssh_test_failed"),
            request=request,
            retryable=True,
            detail={
                'fallback': {'error': result.get('error', '')},
                'reason': result.get('reason') or 'connection_failed',
            },
        )
    return success_response(data={'os_info': result.get('os_info', '')})

@router.post("/ssh-servers/{server_id}/reset-host-key", auth=jwt_auth, response={200: dict, **RESP_ERR})
def reset_ssh_host_key(request: HttpRequest, server_id: UUID):
    from apps.tabtinspace.services.remote_server_service import RemoteServerService
    service = RemoteServerService(user=request.auth)
    server = service.reset_host_key(server_id)
    if not server:
        return not_found_response(_("tabtinspace.server_not_found"))
    return success_response(message=_("tabtinspace.server_fingerprint_reset"))

__all__ = ["router"]
