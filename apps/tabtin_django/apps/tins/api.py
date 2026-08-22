"""Tins API endpoints."""

import logging
from uuid import UUID

from django.http import HttpRequest
from ninja import Router

from apps.users.auth.permissions import JWTAuth
from apps.tabdata.api_helpers import (
    api_error_handler,
    success_response,
    error_response,
    not_found_response,
    validation_error_response,
)
from apps.tins.schemas import (
    TinCreate,
    TinUpdate,
    TinFileUpdate,
    TinDetailOut,
    TinOut,
    TinInstanceCreate,
    TinInstanceUpdate,
    TinInstanceListOut,
    TinInstanceDetailOut,
    TinInstanceOut,
    TinRunLogOut,
)
from apps.tins.models import Tin, TinInstance, TinRunLog
from apps.tins.services.tin_service import TinService, TinInstanceService

_logger = logging.getLogger(__name__)

router = Router(tags=["Tins"])
auth = JWTAuth()


# ─── helpers ──────────────────────────────────────────────────

def _get_user_id(request: HttpRequest) -> UUID:
    return UUID(str(request.auth.id))


def _ensure_space(organization_id: UUID, space_id: UUID):
    """校验 space 属于 organization，不匹配时抛 ValueError。"""
    from apps.tabtinspace.services.base import ensure_space_in_organization
    ensure_space_in_organization(organization_id, space_id)


def _parse_request_context(request: HttpRequest, role: str = "viewer"):
    """统一解析 organization_id 并校验权限。返回 (organization_id, err_response)。"""
    raw = request.headers.get("X-Organization-Id", "").strip()
    if not raw:
        return None, validation_error_response("缺少 X-Organization-Id")
    try:
        organization_id = UUID(raw)
    except ValueError:
        return None, validation_error_response("X-Organization-Id 格式非法")

    from apps.tabtinspace.services import OrganizationService
    svc = OrganizationService(user=request.auth)
    if not svc.check_organization_permission(str(organization_id), role):
        return None, error_response("PERMISSION_DENIED", "权限不足", status_code=403)
    return organization_id, None


# ═══ Tin CRUD ═════════════════════════════════════════════════


@router.get("/tins", response={200: dict, 400: dict, 403: dict}, auth=auth)
@api_error_handler
def list_tins(
    request: HttpRequest,
    space_id: UUID = None,
    status: str = None,
    offset: int = 0,
    limit: int = 50,
):
    """列出当前 organization 下的所有 Tin。"""
    organization_id, err = _parse_request_context(request, "viewer")
    if err:
        return err
    limit = min(max(limit, 1), 100)
    offset = max(offset, 0)
    tins_qs = TinService.list_tins_qs(
        organization_id,
        space_id=space_id,
        status=status,
    )
    total = tins_qs.count()
    tins = list(tins_qs[offset : offset + limit])
    return success_response({
        "tins": [TinOut.model_validate(t).model_dump(mode="json") for t in tins],
        "total": total,
        "has_more": offset + limit < total,
    })


@router.get("/tins/{tin_id}", response={200: dict, 400: dict, 403: dict, 404: dict}, auth=auth)
@api_error_handler
def get_tin(request: HttpRequest, tin_id: UUID):
    """获取 Tin 详情（含文件内容）。"""
    organization_id, err = _parse_request_context(request, "viewer")
    if err:
        return err
    tin = TinService.get_tin(tin_id, organization_id)
    if not tin:
        return not_found_response("Tin")
    return success_response(TinDetailOut.model_validate(tin).model_dump(mode="json"))


@router.post("/tins", response={200: dict, 400: dict, 403: dict}, auth=auth)
@api_error_handler
def create_tin(request: HttpRequest, payload: TinCreate):
    """创建新的 Tin。"""
    organization_id, err = _parse_request_context(request, "editor")
    if err:
        return err
    user_id = _get_user_id(request)

    data = payload.model_dump()
    data["source"] = "user_created"
    tin = TinService.create_tin(
        organization_id=organization_id,
        data=data,
        space_id=None,
        created_by=user_id,
    )
    return success_response(TinDetailOut.model_validate(tin).model_dump(mode="json"))


@router.put("/tins/{tin_id}", response={200: dict, 400: dict, 403: dict, 404: dict}, auth=auth)
@api_error_handler
def update_tin(request: HttpRequest, tin_id: UUID, payload: TinUpdate):
    """更新 Tin 定义。"""
    organization_id, err = _parse_request_context(request, "editor")
    if err:
        return err
    tin = TinService.get_tin(tin_id, organization_id)
    if not tin:
        return not_found_response("Tin")

    data = payload.model_dump(exclude_none=True)
    tin = TinService.update_tin(tin, data)
    return success_response(TinDetailOut.model_validate(tin).model_dump(mode="json"))


@router.put("/tins/{tin_id}/file", response={200: dict, 400: dict, 403: dict, 404: dict}, auth=auth)
@api_error_handler
def update_tin_file(request: HttpRequest, tin_id: UUID, payload: TinFileUpdate):
    """更新 Tin 的单个文件（panel_html / content_script 等）。"""
    organization_id, err = _parse_request_context(request, "editor")
    if err:
        return err
    tin = TinService.get_tin(tin_id, organization_id)
    if not tin:
        return not_found_response("Tin")

    try:
        tin = TinService.update_file(tin, payload.file_type, payload.content)
    except ValueError as exc:
        return validation_error_response(str(exc))

    return success_response(TinDetailOut.model_validate(tin).model_dump(mode="json"))


@router.post("/tins/{tin_id}/activate", response={200: dict, 400: dict, 403: dict, 404: dict}, auth=auth)
@api_error_handler
def activate_tin(request: HttpRequest, tin_id: UUID):
    """将 Tin 状态设为 active。"""
    organization_id, err = _parse_request_context(request, "editor")
    if err:
        return err
    tin = TinService.get_tin(tin_id, organization_id)
    if not tin:
        return not_found_response("Tin")
    tin = TinService.activate_tin(tin)
    return success_response(TinOut.model_validate(tin).model_dump(mode="json"))


@router.post("/tins/{tin_id}/disable", response={200: dict, 400: dict, 403: dict, 404: dict}, auth=auth)
@api_error_handler
def disable_tin(request: HttpRequest, tin_id: UUID):
    """将 Tin 状态设为 disabled。"""
    organization_id, err = _parse_request_context(request, "editor")
    if err:
        return err
    tin = TinService.get_tin(tin_id, organization_id)
    if not tin:
        return not_found_response("Tin")
    tin = TinService.disable_tin(tin)
    return success_response(TinOut.model_validate(tin).model_dump(mode="json"))


@router.delete("/tins/{tin_id}", response={200: dict, 400: dict, 403: dict, 404: dict}, auth=auth)
@api_error_handler
def delete_tin(request: HttpRequest, tin_id: UUID):
    """删除 Tin 及其所有实例。"""
    organization_id, err = _parse_request_context(request, "editor")
    if err:
        return err
    tin = TinService.get_tin(tin_id, organization_id)
    if not tin:
        return not_found_response("Tin")
    TinService.delete_tin(tin)
    return success_response({"deleted": True})


# ═══ TinInstance CRUD ═════════════════════════════════════════


@router.get("/instances", response={200: dict, 400: dict, 403: dict, 404: dict}, auth=auth)
@api_error_handler
def list_instances(
    request: HttpRequest,
    space_id: UUID = None,
    is_enabled: bool = None,
    offset: int = 0,
    limit: int = 50,
):
    """列出 Space 中安装的 Tin 实例（含 Tin 详情）。"""
    organization_id, err = _parse_request_context(request, "viewer")
    if err:
        return err
    if not space_id:
        return validation_error_response("space_id is required")

    _ensure_space(organization_id, space_id)

    limit = min(max(limit, 1), 100)
    offset = max(offset, 0)
    instances_qs = TinInstanceService.list_instances_qs(
        space_id=space_id,
        organization_id=organization_id,
        is_enabled=is_enabled,
    )
    total = instances_qs.count()
    instances = list(instances_qs[offset : offset + limit])
    return success_response({
        "instances": [
            TinInstanceListOut.model_validate(inst).model_dump(mode="json")
            for inst in instances
        ],
        "total": total,
        "has_more": offset + limit < total,
    })


@router.post("/instances", response={200: dict, 400: dict, 403: dict, 404: dict}, auth=auth)
@api_error_handler
def install_tin(request: HttpRequest, payload: TinInstanceCreate):
    """将 Tin 安装到 Space。"""
    organization_id, err = _parse_request_context(request, "editor")
    if err:
        return err

    _ensure_space(organization_id, payload.space_id)

    tin = TinService.get_tin(payload.tin_id, organization_id)
    if not tin:
        return not_found_response("Tin")

    instance = TinInstanceService.install_tin(
        tin=tin,
        space_id=payload.space_id,
        organization_id=organization_id,
        user_variables=payload.user_variables,
        is_enabled=payload.is_enabled,
        pinned=payload.pinned,
    )
    return success_response(
        TinInstanceDetailOut.model_validate(instance).model_dump(mode="json")
    )


@router.put("/instances/{instance_id}", response={200: dict, 400: dict, 403: dict, 404: dict}, auth=auth)
@api_error_handler
def update_instance(request: HttpRequest, instance_id: UUID, payload: TinInstanceUpdate):
    """更新 Tin 实例配置。"""
    organization_id, err = _parse_request_context(request, "editor")
    if err:
        return err
    instance = TinInstanceService.get_instance(instance_id)
    if not instance or str(instance.organization_id) != str(organization_id):
        return not_found_response("TinInstance")

    data = payload.model_dump(exclude_none=True)
    instance = TinInstanceService.update_instance(instance, data)
    return success_response(
        TinInstanceOut.model_validate(instance).model_dump(mode="json")
    )


@router.delete("/instances/{instance_id}", response={200: dict, 400: dict, 403: dict, 404: dict}, auth=auth)
@api_error_handler
def uninstall_tin(request: HttpRequest, instance_id: UUID):
    """从 Space 卸载 Tin 实例。"""
    organization_id, err = _parse_request_context(request, "editor")
    if err:
        return err
    instance = TinInstanceService.get_instance(instance_id)
    if not instance or str(instance.organization_id) != str(organization_id):
        return not_found_response("TinInstance")
    TinInstanceService.uninstall(instance)
    return success_response({"deleted": True})


# ═══ Tin 运行日志 ═════════════════════════════════════════════


@router.get("/instances/{instance_id}/logs", response={200: dict, 400: dict, 403: dict, 404: dict}, auth=auth)
@api_error_handler
def list_run_logs(request: HttpRequest, instance_id: UUID, offset: int = 0, limit: int = 50):
    """获取 Tin 实例的运行日志。"""
    organization_id, err = _parse_request_context(request, "viewer")
    if err:
        return err
    instance = TinInstanceService.get_instance(instance_id)
    if not instance or str(instance.organization_id) != str(organization_id):
        return not_found_response("TinInstance")

    limit = min(max(limit, 1), 200)
    offset = max(offset, 0)
    logs_qs = TinRunLog.objects.filter(instance=instance).order_by("-created_at")
    total = logs_qs.count()
    logs = list(logs_qs[offset : offset + limit])
    return success_response({
        "logs": [TinRunLogOut.model_validate(log).model_dump(mode="json") for log in logs],
        "total": total,
        "has_more": offset + limit < total,
    })
