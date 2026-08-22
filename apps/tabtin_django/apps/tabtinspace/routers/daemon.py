"""Tabtin Space daemon 路由。"""

from .shared import *  # noqa: F401,F403

router = Router(tags=["Tabtin Space"])

@router.post("/devices/install-token", auth=jwt_auth, response={200: dict, 403: ErrorResponse})
def create_install_token(request: HttpRequest, payload: DaemonInstallTokenCreate):
    from apps.tabtinspace.services.daemon_token_service import DaemonTokenService
    service = DaemonTokenService(user=request.auth)
    result = service.create_install_token(
        organization_id=payload.organization_id,
        device_name=payload.device_name,
        expires_minutes=payload.expires_minutes,
    )
    if result is None:
        return error_response("PERMISSION_DENIED", "无权限或组织不存在", status_code=403)
    return success_response(data=result)

@router.post("/devices/activate", auth=None, response={200: dict, 403: ErrorResponse, 409: ErrorResponse, 429: ErrorResponse})
def activate_daemon(request: HttpRequest, payload: DaemonActivate):
    if not _check_activate_rate_limit(request):
        return error_response("RATE_LIMITED", _("请求过于频繁，请稍后再试"), status_code=429)

    from apps.tabtinspace.services.daemon_token_service import DaemonTokenService, DeviceFingerprintConflictError
    service = DaemonTokenService()
    try:
        result = service.activate_device(
            token=payload.token,
            fingerprint=payload.fingerprint,
            device_type=payload.device_type,
            device_name=payload.device_name,
            os_info=payload.os_info,
            capabilities=payload.capabilities,
        )
    except DeviceFingerprintConflictError:
        return error_response(
            "DEVICE_FINGERPRINT_CONFLICT",
            "该设备指纹已被其他用户注册，请使用 --force 重新初始化",
            status_code=409,
        )
    if result is None:
        return error_response("INVALID_TOKEN", "Token 无效或已过期", status_code=403)
    return success_response(data=result)

__all__ = ["router"]
