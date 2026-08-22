"""Tabtin Space device 路由。"""

from .shared import *  # noqa: F401,F403

router = Router(tags=["Tabtin Space"])

@router.post("/devices/register", auth=jwt_auth, response={200: dict, **RESP_ERR_400})
def register_device(request: HttpRequest, payload: DeviceRegister):
    from apps.tabtinspace.services.device_control_guard import is_device_blocked
    if is_device_blocked(payload.fingerprint):
        return error_response("DEVICE_BLOCKED", "该设备已被后台封禁", status_code=403)
    service = DeviceService(user=request.auth)
    try:
        device = service.register_device(
            organization_id=payload.organization_id,
            fingerprint=payload.fingerprint,
            device_type=payload.device_type,
            name=payload.name,
            os_info=payload.os_info,
            capabilities=payload.capabilities,
            machine_key=payload.machine_key,
            previous_fingerprint=payload.previous_fingerprint,
            recovery_fingerprints=payload.recovery_fingerprints,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    if not device:
        return error_response("PERMISSION_DENIED", "注册失败，组织不存在或无权限", status_code=403)
    return success_response(data=DeviceOut.from_orm(device).dict(), message=_("tabtinspace.device_registered"))

@router.post("/devices/push-token", auth=jwt_auth, response={200: dict, **RESP_ERR_400})
def register_device_push_token(request: HttpRequest, payload: DevicePushTokenRegister):
    """移动端推送 token 上报。

    与 /devices/register 解耦：推送按 user 路由（一个人所有端都要收），
    不要求设备先完成 Device 注册；fingerprint 仅作排障归因弱关联。
    """
    from apps.services.notification.push.service import register_push_token

    registration = register_push_token(
        user_id=str(request.auth.id),
        registration_id=payload.registration_id,
        platform=payload.platform,
        provider=payload.provider,
        environment=payload.environment,
        device_fingerprint=payload.fingerprint or "",
        app_version=payload.app_version or "",
    )
    return success_response(data={
        "id": str(registration.id),
        "provider": registration.provider,
        "platform": registration.platform,
        "is_active": registration.is_active,
    })

@router.post("/devices/push-token/revoke", auth=jwt_auth, response={200: dict, **RESP_ERR_400})
def revoke_device_push_token(request: HttpRequest, payload: DevicePushTokenRevoke):
    """登出时反注册推送 token（幂等：不存在/已注销也返回成功）。"""
    from apps.services.notification.push.service import revoke_push_token

    revoked = revoke_push_token(
        user_id=str(request.auth.id),
        registration_id=payload.registration_id,
        provider=payload.provider,
    )
    return success_response(data={"revoked": revoked})

@router.post("/devices/heartbeat", auth=[jwt_auth, daemon_jwt_auth], response={200: dict, **RESP_ERR_400})
def device_heartbeat(request: HttpRequest, payload: DeviceHeartbeat):
    from apps.tabtinspace.services.device_control_guard import is_device_blocked
    if is_device_blocked(payload.fingerprint):
        return error_response("DEVICE_BLOCKED", "该设备已被后台封禁", status_code=403)
    token_raw = request.META.get('HTTP_AUTHORIZATION', '').replace('Bearer ', '')
    token_payload = None
    if token_raw:
        from apps.users.auth.utils import verify_jwt_token
        token_payload = verify_jwt_token(token_raw)
        if token_payload and token_payload.get('token_type') == 'daemon':
            from apps.tabtinspace.services.daemon_token_service import verify_daemon_device_claim
            if not verify_daemon_device_claim(token_payload, payload.fingerprint):
                return error_response("DEVICE_MISMATCH", message="device_id claim 与请求设备不匹配", status_code=401)

    service = DeviceService(user=request.auth)
    device = service.heartbeat(
        fingerprint=payload.fingerprint,
        capabilities=payload.capabilities,
        system_info=payload.system_info,
    )
    if not device:
        return error_response("DEVICE_NOT_FOUND", "设备不存在或已被删除", status_code=404)
    from django.conf import settings
    latest_ver = getattr(settings, 'LATEST_DAEMON_VERSION', None)
    resp: dict = {"status": device.status, "last_heartbeat_at": device.last_heartbeat_at.isoformat()}
    if latest_ver:
        resp["latest_daemon_version"] = latest_ver
    from apps.services.common.device_capability_registry import DEVICE_RUNTIME_TYPES
    if device.device_type in DEVICE_RUNTIME_TYPES and token_payload and token_payload.get('exp'):
        import time
        remaining_seconds = int(token_payload['exp'] - time.time())
        resp["token_expires_in_seconds"] = remaining_seconds
    return success_response(data=resp)

@router.post("/devices/token/renew", auth=[jwt_auth, daemon_jwt_auth], response={200: dict, **RESP_ERR_400})
def device_token_renew(request: HttpRequest, payload: DeviceTokenRenew):
    from django.conf import settings
    from apps.tabtinspace.services.device_control_guard import is_device_blocked
    if is_device_blocked(payload.fingerprint):
        return error_response("DEVICE_BLOCKED", "该设备已被后台封禁", status_code=403)
    daemon_device_id = str(getattr(request, 'daemon_device_id', '') or '')
    if (
        (daemon_device_id and daemon_device_id != payload.fingerprint)
        or (not daemon_device_id and getattr(settings, 'DAEMON_CONTROL_ENABLED', False))
    ):
        return error_response("DEVICE_MISMATCH", message="device_id claim 与请求设备不匹配", status_code=401)
    from apps.tabtinspace.services.daemon_token_service import renew_daemon_token
    new_token = renew_daemon_token(request.auth, payload.fingerprint)
    if not new_token:
        return not_found_response(_("tabtinspace.device_not_found"))
    return success_response(data={"access_token": new_token})

@router.post("/devices/dispatch", auth=jwt_auth, response={200: dict, **RESP_ERR_400})
def dispatch_device_action(request: HttpRequest, payload: DeviceActionRequest):
    from apps.services.common.dispatch.frontend_dispatcher import get_frontend_dispatcher

    dispatcher = get_frontend_dispatcher()
    result = dispatcher.dispatch_action(
        thread_id=payload.thread_id,
        action_type=payload.action,
        params=payload.params,
        timeout=payload.timeout_seconds,
        wait_for_dynamic=bool(payload.params.get("waitForDynamic", True)),
    )
    return success_response(data=result)

@router.post("/devices/query", auth=jwt_auth, response={200: dict, **RESP_WITH_CONFLICT})
def query_device_action(request: HttpRequest, payload: SpaceDeviceActionRequest):
    from apps.services.tools import get_tool_permission_map
    from apps.services.agent_engine.services.device_runtime_query_service import UI_QUERY_ACTIONS
    _PERM_TO_ROLE = {"read": "viewer", "write": "editor", "admin": "admin"}
    if payload.action in UI_QUERY_ACTIONS:
        # ：UI 级只读文件浏览（fs.*）——Space viewer 即可，
        # 与「能看这个 Space 的聊天」同权。不在 mobile 工具 perm_map 里。
        mapped_role = "viewer"
    else:
        perm_map = get_tool_permission_map()
        perm = perm_map.get(payload.action, "admin")
        mapped_role = _PERM_TO_ROLE.get(perm, "admin")

    service = DeviceRuntimeQueryService(user=request.auth)
    result = service.dispatch_space_action(
        space_id=str(payload.space_id),
        action=payload.action,
        params=payload.params or None,
        timeout_seconds=payload.timeout_seconds,
        required_role=mapped_role,
    )
    if not result.get("success"):
        return error_response(
            str(result.get("error_code") or "DEVICE_ACTION_FAILED"),
            result.get("error") or "设备动作执行失败",
            status_code=int(result.get("http_status") or 409),
            data=result,
        )
    return success_response(data=result)

@router.post("/devices/offline", auth=None, response={200: dict, 401: ErrorResponse, 404: ErrorResponse})
def device_offline(request: HttpRequest, payload: DeviceOffline):
    from apps.users.auth.permissions import JWTAuth
    # 优先 header 认证，fallback 到 body _token（sendBeacon 无法设 header）
    auth_header = request.META.get('HTTP_AUTHORIZATION', '')
    token = auth_header.replace('Bearer ', '', 1).strip() if auth_header.startswith('Bearer ') else ''
    if not token and payload.token:
        token = payload.token
    if not token:
        return error_response("AUTH_FAILED", "认证失败", status_code=401)
    user = JWTAuth().authenticate(request, token)
    if not user:
        return error_response("AUTH_FAILED", "认证失败", status_code=401)
    service = DeviceService(user=user)
    device = service.report_offline(fingerprint=payload.fingerprint)
    if not device:
        return not_found_response(_("tabtinspace.device_not_found"))
    return success_response(message=_("tabtinspace.device_offline"))

@router.get("/devices/", auth=jwt_auth, response={200: dict, 401: ErrorResponse})
def list_devices(request: HttpRequest):
    organization_id_raw = request.GET.get("organization_id")
    organization_id = UUID(organization_id_raw) if organization_id_raw else None
    service = DeviceService(user=request.auth)
    devices = service.list_devices(organization_id=organization_id)
    devices_data = [DeviceOut.from_orm(d).dict() for d in devices]
    return success_response(data={"devices": devices_data, "total": len(devices_data)})


@router.get(
    "/devices/host-state",
    auth=[jwt_auth, daemon_jwt_auth],
    response={
        200: dict,
        400: ErrorResponse,
        401: ErrorResponse,
        403: ErrorResponse,
        404: ErrorResponse,
    },
    summary="拉取执行 Host 权威状态",
)
def get_device_host_state(request: HttpRequest):
    """返回目标设备当前可执行的全部 Agent × Workspace 上下文。

    Host 在启动、重连、定时对账或收到失效通知后主动拉取。服务端不接受
    客户端提交的配置快照，避免远控端伪造权限或执行限制。
    """
    from apps.tabtinspace.services.host_state_pull_service import HostStatePullService

    daemon_fingerprint = getattr(request, "daemon_device_id", None)
    device_fingerprint = daemon_fingerprint or request.META.get(
        "HTTP_X_DEVICE_FINGERPRINT", ""
    ).strip()
    if not device_fingerprint:
        return error_response(
            "DEVICE_FINGERPRINT_REQUIRED",
            "缺少执行设备指纹",
            status_code=400,
        )
    try:
        from apps.tabtinspace.schemas.common import _validate_fingerprint

        device_fingerprint = _validate_fingerprint(device_fingerprint)
    except ValueError:
        return error_response(
            "DEVICE_FINGERPRINT_INVALID",
            "执行设备指纹格式非法",
            status_code=400,
        )
    try:
        data = HostStatePullService(user=request.auth).pull(device_fingerprint)
    except ServiceError as exc:
        return error_response(exc.code, exc.message, status_code=exc.status)
    return success_response(data=data)

@router.patch("/devices/{device_id}", auth=jwt_auth, response={200: dict, **RESP_ERR_400})
def update_device(request: HttpRequest, device_id: UUID, payload: DeviceUpdate):
    service = DeviceService(user=request.auth)
    device = service.update_device(
        device_id=device_id,
        name=payload.name,
        capabilities=payload.capabilities,
    )
    if not device:
        return not_found_response(_("tabtinspace.device_not_found"))
    return success_response(data=DeviceOut.from_orm(device).dict(), message=_("tabtinspace.device_updated"))

@router.delete("/devices/{device_id}", auth=jwt_auth, response={200: dict, **RESP_WITH_CONFLICT})
def delete_device(request: HttpRequest, device_id: UUID, force: bool = False):
    service = DeviceService(user=request.auth)
    try:
        success = service.delete_device(device_id=device_id, force=force)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status, data=e.data)
    if not success:
        return not_found_response(_("tabtinspace.device_not_found"))
    return success_response(message=_("tabtinspace.device_deleted"))

@router.patch("/workspaces/{space_id}/device", auth=jwt_auth, response={200: dict, **RESP_WITH_CONFLICT})
@router.patch("/spaces/{space_id}/device", auth=jwt_auth, response={200: dict, **RESP_WITH_CONFLICT})
def bind_space_device(request: HttpRequest, space_id: UUID, payload: SpaceBindDevice):
    from apps.tabtinspace.services.workspace_service import (
        WorkspaceService,
        serialize_workspace,
    )

    try:
        workspace = WorkspaceService(user=request.auth).bind_device(
            workspace_id=space_id,
            device_id=payload.device_id,
            expected_version=payload.expected_version,
            recover_offline_binding=payload.recover_offline_binding,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status, data=e.data)

    return success_response(
        data=serialize_workspace(workspace),
        message=_("tabtinspace.device_binding_updated"),
    )

__all__ = ["router"]
