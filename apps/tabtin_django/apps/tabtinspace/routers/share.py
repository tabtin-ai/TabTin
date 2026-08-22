"""Tabtin Space share 路由。"""

from .shared import *  # noqa: F401,F403

router = Router(tags=["Tabtin Space"])

@router.get("/resources/{resource_type}/{resource_id}/permissions", auth=jwt_auth, response={200: dict, 401: ErrorResponse})
def list_resource_permissions(request: HttpRequest, resource_type: str, resource_id: str):
    service = ResourcePermissionService(user=request.auth)
    perms = service.list_permissions(resource_type, resource_id)
    return success_response(data={"permissions": perms, "total": len(perms)})

@router.post("/resources/{resource_type}/{resource_id}/permissions", auth=jwt_auth, response=RESP_CREATE_SIMPLE)
def grant_resource_permission(
    request: HttpRequest, resource_type: str, resource_id: str, data: ResourcePermissionGrant,
):
    service = ResourcePermissionService(user=request.auth)
    result = service.grant_permission(
        resource_type=resource_type,
        resource_id=resource_id,
        subject_type=data.subject_type,
        subject_id=data.subject_id,
        permission=data.permission,
    )
    if not result:
        return permission_denied_response(_("tabtinspace.share_grant_failed"))

    _audit(
        request,
        action_type='permission_grant', target_type='permission',
        target_id=result.get('id', resource_id),
        message=f"授予 {data.subject_type}:{data.subject_id} 对 {resource_type}:{resource_id} 的 {data.permission} 权限",
        request_payload={'resource_type': resource_type, 'resource_id': resource_id,
                         'subject_type': data.subject_type, 'subject_id': data.subject_id,
                         'permission': data.permission},
        activity_action='shared', resource_name=f'{resource_type}:{resource_id}',
    )

    return 201, success_response(data=result, message=_("tabtinspace.permission_granted"))

@router.delete("/resources/{resource_type}/{resource_id}/permissions/{permission_id}", auth=jwt_auth, response={200: dict, **RESP_ERR})
def revoke_resource_permission(
    request: HttpRequest, resource_type: str, resource_id: str, permission_id: str,
):
    service = ResourcePermissionService(user=request.auth)
    success = service.revoke_permission(resource_type, resource_id, permission_id)
    if not success:
        return permission_denied_response(_("tabtinspace.share_revoke_failed"))

    _audit(
        request,
        action_type='permission_revoke', target_type='permission',
        target_id=permission_id,
        message=f"撤销 {resource_type}:{resource_id} 的权限 {permission_id}",
        request_payload={'resource_type': resource_type, 'resource_id': resource_id,
                         'permission_id': permission_id},
    )

    return success_response(message=_("tabtinspace.permission_revoked"))

__all__ = ["router"]
