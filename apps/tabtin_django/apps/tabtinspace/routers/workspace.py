"""Workspace（执行现场）路由 —  PR2。

会话 = 谁干（Agent）× 在哪干（Workspace）两个自由度（owner 2026-07-08
终态口径）。本路由服务任务门「显式选执行目标」（two-doors IA §1.4）与
Workspace 的独立供给（不再经 create_agent_workspace 隐式配对建 Agent）。

契约（与前端线约定，Stage A/B 形状不变）：
    GET /api/context/workspaces →
        {"workspaces": [{id, name, working_dir, working_dir_type,
                          device_id, device_online, is_home}], "total": N}

- ``id``：执行现场 ID。Stage B 起为 Workspace 独立表行 id——迁移保 id
  复用（Workspace.id 沿用源 Space.id），Stage A 时代前端拿到的值无缝。
- ``device_online``：绑定执行设备当前是否可达（online/busy 视为可达）。
- ``is_home``：是否主场（每设备静默供给的默认现场， P1）；任务门
  列表应将主场置顶并默认选中。
"""

from typing import Optional
from uuid import UUID

from ninja import Router, Schema
from django.http import HttpRequest
from pydantic import Field

from apps.users.auth.permissions import JWTAuth
from apps.i18n.response import (
    success_response,
    error_response_with_status as error_response,
)
from apps.tabtinspace.schemas.common import ErrorResponse
from apps.tabtinspace.schemas.space import SpaceAppsSettingsUpdate
from apps.tabtinspace.services.base import ServiceError
from apps.tabtinspace.services.workspace_service import (
    WorkspaceService,
    serialize_workspace,
    serialize_workspaces,
)

router = Router(tags=["Tabtin Space"])

jwt_auth = JWTAuth()


class WorkspaceCreate(Schema):
    organization_id: UUID = Field(..., description="所属组织 ID")
    device_id: Optional[UUID] = Field(
        default=None, description="Django 执行设备 ID（与 device_installation_id 二选一）",
    )
    device_installation_id: Optional[str] = Field(
        default=None,
        max_length=255,
        description="执行设备稳定安装 ID（与 device_id 二选一）",
    )
    working_dir: str = Field(..., description="设备上的工作目录绝对路径（客户端解析后传入）")
    working_dir_type: Optional[str] = Field(default="", description="code/mixed/doc")
    name: Optional[str] = Field(default="", description="展示名（可空，目录才是身份）")


class HomeWorkspaceEnsure(Schema):
    organization_id: UUID = Field(..., description="个人组织 ID")
    device_id: UUID = Field(..., description="本机执行设备 ID")
    working_dir: str = Field(..., description="客户端解析的 ~/TabTin/Home 绝对路径")
    working_dir_type: Optional[str] = Field(default="mixed", description="缺省 mixed")
    name: Optional[str] = Field(default="", description="本地化展示名（中「主场」/英「Home」）")


class WorkspaceTrustUpdate(Schema):
    trust_status: str = Field(..., description="trusted / untrusted（一个总开关不分项）")


class WorkspaceApprovalGrantUpdate(Schema):
    approval_grant: str = Field(
        ...,
        description="always_ask / auto / full_access",
    )


class WorkspaceUpdate(Schema):
    name: Optional[str] = Field(default=None, description="展示名")
    description: Optional[str] = Field(
        default=None,
        max_length=500,
        description="Workspace 简介；传空串清空",
    )
    working_dir: Optional[str] = Field(
        default=None, description="新工作目录绝对路径（客户端解析；不允许清空）",
    )
    working_dir_type: Optional[str] = Field(default=None, description="code/mixed/doc")
    device_fingerprint: Optional[str] = Field(
        default=None, description="请求方设备指纹（目录变更时服务端权威校验绑定设备）",
    )
    # ：现场自有规则与执行限额（不复用 Agent）
    custom_rules: Optional[str] = Field(
        default=None,
        max_length=5000,
        description="现场自定义规则；传空串清空",
    )
    execution_limits: Optional[dict] = Field(
        default=None,
        description=(
            "现场执行限制 {max_iterations_per_run, max_credits_per_run}；"
            "传 {} 或键为 null 表示跟随产品默认"
        ),
    )


@router.get("/workspaces", auth=jwt_auth, response={200: dict, 401: ErrorResponse})
def list_workspaces(
    request: HttpRequest,
    organization_id: Optional[UUID] = None,
):
    """列出当前用户可用的执行现场（Workspace 独立表，Stage B）。

    口径（总控 2026-07-08 拍板）：Workspace 是个人执行现场——
    ``created_by=当前用户`` + ``organization_id`` 过滤（query param，
    与前端每组织上下文一致）；未传时跨组织全量（兼容早期调用方）。
    """
    service = WorkspaceService(user=request.auth)
    try:
        rows = service.list_workspaces(organization_id=organization_id)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    items = serialize_workspaces(rows)
    return success_response({"workspaces": items, "total": len(items)})


@router.post(
    "/workspaces",
    auth=jwt_auth,
    response={201: dict, 400: ErrorResponse, 401: ErrorResponse,
              403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse,
              503: ErrorResponse},
    summary="创建执行现场",
)
def create_workspace(request: HttpRequest, data: WorkspaceCreate):
    """创建执行现场（独立入口，不隐式建 Agent——#3266 PR2 创建链拆分）。

    PR2b 起 create_session 准入已双轨支持无壳 Workspace 行——本端点建的
    现场可直接开会话（会话 = 显式选的 Agent × 本现场）。
    """
    service = WorkspaceService(user=request.auth)
    try:
        workspace = service.create_workspace(
            organization_id=data.organization_id,
            device_id=data.device_id,
            device_installation_id=data.device_installation_id or "",
            working_dir=data.working_dir,
            working_dir_type=data.working_dir_type or "",
            name=data.name or "",
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return 201, success_response(data=serialize_workspace(workspace))


@router.post(
    "/workspaces/ensure-home",
    auth=jwt_auth,
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse,
              403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse},
    summary="幂等供给主场",
)
def ensure_home_workspace(request: HttpRequest, data: HomeWorkspaceEnsure):
    """幂等确保当前用户在当前设备的主场（ P1 懒供给原语）。

    客户端首跑编排调用（registerCurrentDevice → ensureHomeWorkspaceDir →
    本端点）；幂等键 (organization, device, user, kind='home')，已存在直接返回不改目录/信任。
    PR2b 起主场行可直接开会话（create_session 准入已双轨）。
    """
    service = WorkspaceService(user=request.auth)
    try:
        workspace, created = service.ensure_home_workspace(
            organization_id=data.organization_id,
            device_id=data.device_id,
            working_dir=data.working_dir,
            working_dir_type=data.working_dir_type or "mixed",
            name=data.name or "",
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    payload = serialize_workspace(workspace)
    payload["created"] = created
    return success_response(data=payload)


@router.get(
    "/workspaces/{workspace_id}",
    auth=jwt_auth,
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    summary="读取执行现场",
)
def get_workspace(request: HttpRequest, workspace_id: UUID):
    """按创建者边界读取单个 Workspace，供本地运行时获取权威授权。"""
    service = WorkspaceService(user=request.auth)
    try:
        workspace = service.get_workspace(workspace_id)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return success_response(data=serialize_workspace(workspace))


@router.patch(
    "/workspaces/{workspace_id}",
    auth=jwt_auth,
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse,
              403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse},
    summary="更新执行现场",
)
def update_workspace(request: HttpRequest, workspace_id: UUID, data: WorkspaceUpdate):
    """改名 / 更换目录（个人域壳消解后的终态编辑入口）。

    - 主场（kind='home'）系统托管，400 HOME_WORKSPACE_MANAGED；
    - 目录变更须在绑定设备本机发起（403 WORKSPACE_DEVICE_MISMATCH）；
    - 同设备目录冲突 409 WORKING_DIR_CONFLICT。
    """
    service = WorkspaceService(user=request.auth)
    payload = data.dict(exclude_unset=True)
    try:
        workspace = service.update_workspace(
            workspace_id,
            name=payload.get('name', data.name),
            description=payload.get('description', data.description),
            working_dir=payload.get('working_dir', data.working_dir),
            working_dir_type=payload.get('working_dir_type', data.working_dir_type),
            device_fingerprint=payload.get('device_fingerprint', data.device_fingerprint),
            custom_rules=payload.get('custom_rules') if 'custom_rules' in payload else None,
            execution_limits=payload.get('execution_limits') if 'execution_limits' in payload else None,
            execution_limits_provided='execution_limits' in payload,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return success_response(data=serialize_workspace(workspace))


@router.delete(
    "/workspaces/{workspace_id}",
    auth=jwt_auth,
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse,
              403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse},
    summary="删除执行现场",
)
def delete_workspace(
    request: HttpRequest, workspace_id: UUID, device_id: Optional[UUID] = None,
):
    """删除执行现场记录（不碰磁盘目录）。

    级联口径：会话/Tracker 历史保留（workspace FK SET_NULL）、现场级
    索引与 checkpoint 随删。只能在绑定设备本机发起（``device_id`` 声明，
    403 REMOTE_DELETE_FORBIDDEN）；主场不可删（400 HOME_WORKSPACE_MANAGED）。
    """
    service = WorkspaceService(user=request.auth)
    try:
        service.delete_workspace(workspace_id, acting_device_id=device_id)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return success_response(data={"deleted": True})


@router.patch(
    "/workspaces/{workspace_id}/trust",
    auth=jwt_auth,
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse,
              403: ErrorResponse, 404: ErrorResponse},
    summary="更新 Workspace 信任状态（ W3 Trust）",
)
def update_workspace_trust(
    request: HttpRequest, workspace_id: UUID, data: WorkspaceTrustUpdate,
):
    """Workspace Trust 总开关（脑暴板口径：一个开关不分项，记 (设备+路径) 行）。

    - ``trusted``：用户确认信任 → trust_source=user_confirmed + trusted_at=now；
      目录自带规约 / Skill 允许注入会话（unattended 会话仍一律不注入）。
    - ``untrusted``：撤销信任 → trust_source=none + trusted_at 清空。
    仅创建者可改；「仅本次信任」是客户端运行期决策，不落库不走本端点。
    """
    service = WorkspaceService(user=request.auth)
    try:
        workspace = service.set_trust_status(workspace_id, data.trust_status)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return success_response(data=serialize_workspace(workspace))


@router.patch(
    "/workspaces/{workspace_id}/approval-grant",
    auth=jwt_auth,
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse,
              403: ErrorResponse, 404: ErrorResponse},
    summary="更新 Workspace 审批授权档位",
)
def update_workspace_approval_grant(
    request: HttpRequest,
    workspace_id: UUID,
    data: WorkspaceApprovalGrantUpdate,
):
    service = WorkspaceService(user=request.auth)
    try:
        workspace = service.set_approval_grant(workspace_id, data.approval_grant)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return success_response(data=serialize_workspace(workspace))


def _serialize_workspace_apps(workspace, user, disabled_apps):
    """组装 Workspace 应用列表（Organization 安装过滤 + 设备 runtime）。"""
    from apps.services.common.app_registry import get_app_runtime_mode, normalize_type
    from apps.services.common.app_registry import list_apps
    from apps.tabtinspace.schemas.space import SpaceAppOut
    from apps.tabtinspace.services.app_catalog_service import OrganizationAppCatalogService
    from apps.tabtinspace.routers.shared import _get_context_url_field

    installed_ids = OrganizationAppCatalogService.get_installed_app_ids(
        workspace.organization_id,
    )
    device = getattr(workspace, 'device', None)
    agent_runtime_type = getattr(device, 'device_type', '') if device else ''
    disabled = {normalize_type(aid) for aid in (disabled_apps or [])}

    apps = [
        SpaceAppOut(
            id=app.id,
            name=app.name,
            icon=app.icon,
            icon_asset=app.icon_asset,
            can_create=app.can_create,
            searchable=app.searchable,
            enabled=app.id not in disabled,
            order=app.order,
            desktop_group=app.desktop_group,
            category=app.category,
            context_type=app.context_type,
            ui_runtime=app.ui_runtime,
            distribution=app.distribution,
            install_scope=app.install_scope,
            surface=app.surface,
            embedded_web={
                "baseUrl": app.embedded_web_base_url,
                "urlPatterns": list(app.embedded_web_url_patterns),
                "sessionMode": app.embedded_web_session_mode,
            } if app.embedded_web_base_url else None,
            context_url_field=_get_context_url_field(app),
        ).model_dump()
        for app in list_apps()
        if app.id in installed_ids
        and (
            not agent_runtime_type
            or get_app_runtime_mode(app.id, agent_runtime_type) != 'unavailable'
        )
    ]
    return {
        "apps": apps,
        "disabled_apps": list(disabled),
    }


@router.get(
    "/workspaces/{workspace_id}/apps",
    auth=jwt_auth,
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse},
    summary="读取 Workspace 应用启用状态",
)
def get_workspace_app_settings(request: HttpRequest, workspace_id: UUID):
    """返回 Organization 已安装 APP 及其在当前 Workspace 的启用状态。

    ：承接原 ``/spaces/{id}/apps``（已 410）；缓存键改用 workspace 前缀。
    """
    from django.core.cache import cache as djcache
    from apps.tabtinspace.models import SpaceAppSettings

    user_id = str(request.auth.id)
    cache_key = f"workspace_app_settings:{workspace_id}:{user_id}"
    cached = djcache.get(cache_key)
    if cached is not None:
        return success_response(cached)

    service = WorkspaceService(user=request.auth)
    try:
        workspace = service.get_workspace(workspace_id)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    settings = SpaceAppSettings.objects.filter(
        workspace_id=workspace_id, user=request.auth,
    ).first()
    result = _serialize_workspace_apps(
        workspace,
        request.auth,
        settings.disabled_apps if settings else [],
    )
    djcache.set(cache_key, result, timeout=120)
    return success_response(result)


@router.put(
    "/workspaces/{workspace_id}/apps",
    auth=jwt_auth,
    response={
        200: dict, 400: ErrorResponse, 401: ErrorResponse,
        403: ErrorResponse, 404: ErrorResponse,
    },
    summary="更新 Workspace 应用启用状态",
)
def update_workspace_app_settings(
    request: HttpRequest,
    workspace_id: UUID,
    data: SpaceAppsSettingsUpdate,
):
    from django.core.cache import cache as djcache
    from apps.tabtinspace.models import SpaceAppSettings

    service = WorkspaceService(user=request.auth)
    try:
        workspace = service.get_workspace(workspace_id)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    if data.disabled_apps is not None:
        settings, created = SpaceAppSettings.objects.get_or_create(
            workspace_id=workspace_id,
            user=request.auth,
            defaults={"disabled_apps": data.disabled_apps},
        )
        if not created:
            settings.disabled_apps = data.disabled_apps
            settings.save(update_fields=["disabled_apps", "updated_at"])
    else:
        settings = SpaceAppSettings.objects.filter(
            workspace_id=workspace_id, user=request.auth,
        ).first()

    djcache.delete(f"workspace_app_settings:{workspace_id}:{request.auth.id}")
    # 兼容旧缓存键（Electron 切换窗口期可能仍命中）
    djcache.delete(f"space_app_settings:{workspace_id}:{request.auth.id}")

    result = _serialize_workspace_apps(
        workspace,
        request.auth,
        settings.disabled_apps if settings else [],
    )
    return success_response(data=result, message="Workspace 应用设置已更新")


__all__ = ["router"]
