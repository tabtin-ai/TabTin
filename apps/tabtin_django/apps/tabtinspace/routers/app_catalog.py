"""Tabtin Space app_catalog 路由。"""

from .shared import *  # noqa: F401,F403

router = Router(tags=["Tabtin Space"])

@router.get("/organizations/{organization_id}/app-catalog", auth=jwt_auth, response={200: dict, **RESP_ERR})
def get_organization_app_catalog(request: HttpRequest, organization_id: UUID):
    service = OrganizationService(user=request.auth)
    if not service.check_organization_permission(str(organization_id), 'viewer'):
        return permission_denied_response(_("tabtinspace.no_organization_access"))

    catalog = OrganizationAppCatalogService.list_catalog(organization_id, user=request.auth)
    return success_response(catalog)

@router.get("/organizations/{organization_id}/app-catalog/{app_id}/manifest", auth=jwt_auth, response={200: dict, **RESP_ERR, 500: ErrorResponse})
def get_app_manifest(request: HttpRequest, organization_id: UUID, app_id: str):
    service = OrganizationService(user=request.auth)
    if not service.check_organization_permission(str(organization_id), 'viewer'):
        return permission_denied_response(_("tabtinspace.no_organization_access"))

    import json
    from pathlib import Path
    project_root = Path(__file__).resolve().parents[3]
    manifest_path = project_root / "packages" / "apps" / app_id / "app.json"
    if not manifest_path.exists():
        return error_response('NOT_FOUND', f'应用 {app_id} 的 manifest 不存在', status_code=404)

    try:
        manifest_data = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception:
        return error_response('INTERNAL_ERROR', 'manifest 读取失败', status_code=500)

    return success_response(manifest_data)

@router.post("/organizations/{organization_id}/app-catalog/{app_id}/install", auth=jwt_auth, response={200: dict, **RESP_ERR_400})
def install_organization_app(request: HttpRequest, organization_id: UUID, app_id: str):
    service = OrganizationService(user=request.auth)
    if not service.check_organization_permission(str(organization_id), 'owner'):
        return permission_denied_response(_("tabtinspace.owner_required"))

    try:
        install = OrganizationAppCatalogService.install_app(
            organization_id, app_id, user=request.auth,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    from apps.services.common.app_registry import get_app
    installed_app_def = get_app(install.app_id)

    _audit(
        request,
        action_type='app_install', target_type='organization_app',
        target_id=organization_id, organization_id=organization_id,
        message=f"安装应用 {app_id}",
        activity_action='installed', resource_name=app_id,
    )

    return success_response(
        data=AppInstallOut(
            app_id=install.app_id,
            installed=True,
            installed_at=install.created_at.isoformat() if install.created_at else None,
            surface=installed_app_def.surface if installed_app_def else None,
        ).model_dump(),
        message=_("tabtinspace.app_installed"),
    )

@router.post("/organizations/{organization_id}/app-catalog/{app_id}/uninstall", auth=jwt_auth, response={200: dict, **RESP_ERR_400})
def uninstall_organization_app(request: HttpRequest, organization_id: UUID, app_id: str):
    service = OrganizationService(user=request.auth)
    if not service.check_organization_permission(str(organization_id), 'owner'):
        return permission_denied_response(_("tabtinspace.owner_required"))

    try:
        result = OrganizationAppCatalogService.uninstall_app(
            organization_id, app_id, user=request.auth,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    affected = result.get('affected_spaces', 0)

    _audit(
        request,
        action_type='app_uninstall', target_type='organization_app',
        target_id=organization_id, organization_id=organization_id,
        message=f"卸载应用 {app_id}，影响 {affected} 个 Space",
        activity_action='uninstalled', resource_name=app_id,
    )

    msg_suffix = f"，{affected} 个 Space 中的相关资源已标记" if affected > 0 else ""
    return success_response(
        data=AppUninstallOut(
            app_id=app_id,
            installed=False,
            affected_spaces=affected,
        ).model_dump(),
        message=_("tabtinspace.app_uninstalled") + msg_suffix,
    )

__all__ = ["router"]
