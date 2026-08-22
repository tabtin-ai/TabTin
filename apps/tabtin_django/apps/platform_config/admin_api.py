from __future__ import annotations

from typing import Any

from django.core.exceptions import ObjectDoesNotExist
from ninja import Router, Schema
from ninja.errors import HttpError

from apps.i18n.response import success_response
from apps.platform_config.services import PlatformConfigError, PlatformRuntimeConfigService
from apps.users.auth.admin_audit import record_admin_sensitive_action
from apps.users.auth.permissions import AdminPermissionAuth, StaffAuth, SuperuserAuth


router = Router(tags=["Platform Config Admin"], auth=StaffAuth())


class PlatformConfigUpsertRequest(Schema):
    key: str
    name: str
    description: str = ""
    category: str
    value_type: str
    value: Any
    default_value: Any | None = None
    is_active: bool = True
    is_system: bool = False
    sort_order: int = 0
    extra_schema: dict[str, Any] | None = None


class PlatformConfigUpdateRequest(Schema):
    name: str | None = None
    description: str | None = None
    category: str | None = None
    value_type: str | None = None
    value: Any | None = None
    default_value: Any | None = None
    is_active: bool | None = None
    sort_order: int | None = None
    extra_schema: dict[str, Any] | None = None


def _mask_platform_value(key: str, value: Any) -> Any:
    key_lower = (key or "").lower()
    if any(marker in key_lower for marker in ("secret", "token", "api_key", "password")):
        return "***"
    if isinstance(value, dict):
        return {k: _mask_platform_value(str(k), v) for k, v in value.items()}
    if isinstance(value, list):
        return [_mask_platform_value(key, item) for item in value]
    return value


@router.get("/platform-config/items", auth=StaffAuth())
def list_platform_config_items(
    request,
    category: str | None = None,
    include_inactive: bool = True,
):
    return success_response(
        data={
            "items": PlatformRuntimeConfigService.list_items(
                category=category,
                include_inactive=include_inactive,
            )
        }
    )


@router.get("/platform-config/items/{key}", auth=StaffAuth())
def get_platform_config_item(request, key: str):
    try:
        item = PlatformRuntimeConfigService.get_item(key)
    except ObjectDoesNotExist as exc:
        raise HttpError(404, "配置不存在") from exc
    return success_response(data={"item": PlatformRuntimeConfigService.serialize_item(item)})


@router.post("/platform-config/items", auth=SuperuserAuth())
def upsert_platform_config_item(request, data: PlatformConfigUpsertRequest):
    try:
        item = PlatformRuntimeConfigService.upsert_item(
            key=data.key,
            name=data.name,
            description=data.description,
            category=data.category,
            value_type=data.value_type,
            value=data.value,
            default_value=data.default_value,
            is_active=data.is_active,
            is_system=data.is_system,
            sort_order=data.sort_order,
            extra_schema=data.extra_schema,
            updated_by=request.auth,
        )
    except PlatformConfigError as exc:
        raise HttpError(400, str(exc)) from exc
    return success_response(data={"item": item}, message="配置已保存")


@router.put("/platform-config/items/{key}", auth=SuperuserAuth())
def update_platform_config_item(request, key: str, data: PlatformConfigUpdateRequest):
    updates = data.dict(exclude_unset=True)
    updates["updated_by"] = request.auth
    try:
        item = PlatformRuntimeConfigService.update_item(key, **updates)
    except ObjectDoesNotExist as exc:
        raise HttpError(404, "配置不存在") from exc
    except PlatformConfigError as exc:
        raise HttpError(400, str(exc)) from exc
    return success_response(data={"item": item}, message="配置已更新")


@router.delete("/platform-config/items/{key}", auth=AdminPermissionAuth("platform_config:update"))
def delete_platform_config_item(request, key: str, reason: str = "", ticket_id: str = ""):
    normalized_reason = (reason or "").strip()
    if not normalized_reason:
        raise HttpError(400, "reason 不能为空")
    try:
        existing = PlatformRuntimeConfigService.serialize_item(PlatformRuntimeConfigService.get_item(key))
        PlatformRuntimeConfigService.delete_item(key)
    except ObjectDoesNotExist as exc:
        raise HttpError(404, "配置不存在") from exc
    except PlatformConfigError as exc:
        raise HttpError(400, str(exc)) from exc
    value_summary = {
        "value_type": existing.get("value_type"),
        "value": _mask_platform_value(key, existing.get("value")),
        "default_value": _mask_platform_value(key, existing.get("default_value")),
    }
    record_admin_sensitive_action(
        request,
        permission_code="platform_config:update",
        action="platform_config.delete",
        target_type="platform_config",
        target_id=key,
        reason=normalized_reason,
        ticket_id=(ticket_id or "").strip(),
        before_json={
            "key": key,
            "name": existing.get("name") or "",
            "category": existing.get("category") or "",
            "is_active": bool(existing.get("is_active")),
            "value_summary": value_summary,
        },
        after_json={
            "key": key,
            "deleted": True,
        },
    )
    return success_response(message="配置已删除")
