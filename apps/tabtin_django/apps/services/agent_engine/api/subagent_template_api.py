"""
SubAgent Template API

提供子 Agent 模板的 CRUD 管理能力（Space 级别）。
"""

import logging
from typing import Optional, List, Literal
from uuid import UUID

from django.db import transaction
from django.db.models import F
from ninja import Router, Schema
from pydantic import Field

from apps.users.auth.api import jwt_auth
from apps.services.common.api_errors import (
    raise_unauthorized,
    raise_forbidden,
    raise_not_found,
    raise_bad_request,
)
from apps.services.common.tool_utils import normalize_tool_list
from apps.services.common.db_router import postgres_app_db_alias
from apps.services.agent_engine.models import SubAgentTemplate, SubAgentTemplateVersion
from apps.services.common.app_registry import CORE_APPS, get_virtual_app_ids

logger = logging.getLogger(__name__)

router = Router(tags=["SubAgent Templates"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class SubAgentTemplateIn(Schema):
    name: str = Field(..., max_length=64)
    description: str = Field("", max_length=2000)
    icon: str = Field("", max_length=50)
    system_prompt: str = Field("", max_length=10000)
    subagent_type: str = Field("execute")
    allowed_tools: List[str] = Field(default_factory=list)
    denied_tools: List[str] = Field(default_factory=list)
    model_id: str = Field("")
    thinking_level: str = Field("")
    default_mode: str = Field("wait")
    app_id: str = Field("")
    reply_mode: str = Field("")
    tool_domains: List[str] = Field(default_factory=list)
    skill_key: str = Field("")
    is_enabled: bool = True
    order: int = 0
    display_color: str = Field("", max_length=16)
    max_turns: int = Field(50, ge=1, le=500)
    max_active: int = Field(5, ge=1, le=100)


class SubAgentTemplateUpdate(Schema):
    name: Optional[str] = Field(None, max_length=64)
    description: Optional[str] = Field(None, max_length=2000)
    icon: Optional[str] = Field(None, max_length=50)
    system_prompt: Optional[str] = Field(None, max_length=10000)
    subagent_type: Optional[str] = None
    allowed_tools: Optional[List[str]] = None
    denied_tools: Optional[List[str]] = None
    model_id: Optional[str] = None
    thinking_level: Optional[str] = None
    default_mode: Optional[str] = None
    app_id: Optional[str] = None
    reply_mode: Optional[str] = None
    tool_domains: Optional[List[str]] = None
    skill_key: Optional[str] = None
    is_enabled: Optional[bool] = None
    order: Optional[int] = None
    display_color: Optional[str] = Field(None, max_length=16)
    max_turns: Optional[int] = Field(None, ge=1, le=500)
    max_active: Optional[int] = Field(None, ge=1, le=100)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _serialize(tpl: SubAgentTemplate) -> dict:
    return {
        "id": str(tpl.id),
        "space_id": str(tpl.space_id),
        "name": tpl.name,
        "description": tpl.description,
        "icon": tpl.icon,
        "system_prompt": tpl.system_prompt,
        "subagent_type": tpl.subagent_type,
        "allowed_tools": tpl.allowed_tools or [],
        "denied_tools": tpl.denied_tools or [],
        "model_id": tpl.model_id,
        "thinking_level": tpl.thinking_level,
        "default_mode": tpl.default_mode,
        "app_id": tpl.app_id,
        "reply_mode": tpl.reply_mode,
        "tool_domains": tpl.tool_domains or [],
        "skill_key": tpl.skill_key,
        "is_enabled": tpl.is_enabled,
        "order": tpl.order,
        "display_color": tpl.display_color,
        "max_turns": tpl.max_turns,
        "max_active": tpl.max_active,
        "version": tpl.version,
        "created_at": tpl.created_at.isoformat() if tpl.created_at else None,
        "updated_at": tpl.updated_at.isoformat() if tpl.updated_at else None,
    }


def _build_snapshot(tpl: SubAgentTemplate) -> dict:
    """构建模板当前状态的 JSON 快照，用于版本记录。"""
    data = _serialize(tpl)
    for key in ("created_at", "updated_at"):
        data.pop(key, None)
    return data


VALID_SUBAGENT_TYPES = {"explore", "plan", "execute"}
VALID_MODES = {"wait", "background"}
VALID_THINKING_LEVELS = {"off", "low", "medium", "high"}


def _normalize_payload(data: dict) -> dict:
    normalized = dict(data)
    for field in ("name", "description", "icon", "system_prompt", "model_id", "app_id", "reply_mode", "skill_key", "display_color"):
        if field in normalized and normalized[field] is not None:
            normalized[field] = str(normalized[field]).strip()
    if "subagent_type" in normalized and normalized["subagent_type"] is not None:
        normalized["subagent_type"] = str(normalized["subagent_type"]).strip().lower()
    if "default_mode" in normalized and normalized["default_mode"] is not None:
        normalized["default_mode"] = str(normalized["default_mode"]).strip().lower()
    if "thinking_level" in normalized and normalized["thinking_level"] is not None:
        raw = str(normalized["thinking_level"]).strip().lower()
        normalized["thinking_level"] = raw
    if "allowed_tools" in normalized and normalized["allowed_tools"] is not None:
        normalized["allowed_tools"] = normalize_tool_list(normalized["allowed_tools"])
    if "denied_tools" in normalized and normalized["denied_tools"] is not None:
        normalized["denied_tools"] = normalize_tool_list(normalized["denied_tools"])
    if "tool_domains" in normalized and normalized["tool_domains"] is not None:
        normalized["tool_domains"] = [
            str(d).strip() for d in normalized["tool_domains"]
            if isinstance(d, str) and d.strip()
        ]
    return normalized


def _validate_fields(data: dict) -> Optional[str]:
    if "subagent_type" in data and data["subagent_type"] not in VALID_SUBAGENT_TYPES:
        return f"Invalid subagent_type: {data['subagent_type']}"
    if "default_mode" in data and data["default_mode"] not in VALID_MODES:
        return f"Invalid default_mode: {data['default_mode']}"
    if "thinking_level" in data and data["thinking_level"] and data["thinking_level"] not in VALID_THINKING_LEVELS:
        return f"Invalid thinking_level: {data['thinking_level']}"
    if "app_id" in data and data["app_id"]:
        aid = data["app_id"]
        if aid not in CORE_APPS and aid not in get_virtual_app_ids():
            return f"Invalid app_id: {aid}"
    return None


def _check_space_access(user, space_id: str, *, min_role: str = "viewer") -> None:
    """校验用户对目标 Space 的访问权限，委托给统一的 check_space_access。"""
    from apps.tabtinspace.services.base import check_space_access
    from apps.tabtinspace.services.host_resolver import host_exists

    if not host_exists(space_id):
        raise_not_found("Space not found")

    if user.is_superuser:
        return

    if not check_space_access(user, space_id, min_role):
        raise_forbidden("No access to this space")


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/spaces/{space_id}/subagent-templates", auth=jwt_auth)
def list_templates(request, space_id: str):
    user = request.auth
    if not user:
        raise_unauthorized()
    _check_space_access(user, space_id)
    templates = SubAgentTemplate.objects.filter(space_id=space_id).order_by("order", "created_at")
    return {"items": [_serialize(t) for t in templates]}


@router.post("/spaces/{space_id}/subagent-templates", auth=jwt_auth)
def create_template(request, space_id: str, payload: SubAgentTemplateIn):
    user = request.auth
    if not user:
        raise_unauthorized()
    _check_space_access(user, space_id, min_role="editor")

    data = _normalize_payload(payload.model_dump())
    err = _validate_fields(data)
    if err:
        raise_bad_request(err)

    if not data.get("name", "").strip():
        raise_bad_request("name is required")

    if SubAgentTemplate.objects.filter(space_id=space_id, name=data["name"]).exists():
        raise_bad_request(f"Template name already exists: {data['name']}")

    data["version"] = 1
    with transaction.atomic(using=postgres_app_db_alias()):
        tpl = SubAgentTemplate.objects.create(space_id=space_id, **data)
        SubAgentTemplateVersion.objects.create(
            template=tpl,
            version=1,
            snapshot_json=_build_snapshot(tpl),
        )
    return _serialize(tpl)


@router.put("/spaces/{space_id}/subagent-templates/{template_id}", auth=jwt_auth)
def update_template(request, space_id: str, template_id: str, payload: SubAgentTemplateUpdate):
    user = request.auth
    if not user:
        raise_unauthorized()
    _check_space_access(user, space_id, min_role="editor")

    tpl = SubAgentTemplate.objects.filter(id=template_id, space_id=space_id).first()
    if not tpl:
        raise_not_found("Template not found")

    updates = _normalize_payload(payload.model_dump(exclude_unset=True))
    err = _validate_fields(updates)
    if err:
        raise_bad_request(err)

    if "name" in updates:
        name = updates["name"].strip()
        if not name:
            raise_bad_request("name cannot be empty")
        updates["name"] = name

    _VERSION_EXEMPT_FIELDS = {"is_enabled", "order"}
    needs_version_bump = bool(set(updates.keys()) - _VERSION_EXEMPT_FIELDS)

    try:
        with transaction.atomic(using=postgres_app_db_alias()):
            tpl = (
                SubAgentTemplate.objects
                .select_for_update()
                .get(id=template_id, space_id=space_id)
            )

            if "name" in updates:
                dup = (
                    SubAgentTemplate.objects
                    .filter(space_id=space_id, name=updates["name"])
                    .exclude(id=template_id)
                    .exists()
                )
                if dup:
                    raise_bad_request(f"Template name already exists: {updates['name']}")

            for field, value in updates.items():
                setattr(tpl, field, value)

            if needs_version_bump:
                tpl.version = F('version') + 1

            tpl.save()
            tpl.refresh_from_db()

            if needs_version_bump:
                SubAgentTemplateVersion.objects.create(
                    template=tpl,
                    version=tpl.version,
                    snapshot_json=_build_snapshot(tpl),
                )
    except SubAgentTemplate.DoesNotExist:
        raise_not_found("Template not found")

    return _serialize(tpl)


@router.delete("/spaces/{space_id}/subagent-templates/{template_id}", auth=jwt_auth)
def delete_template(request, space_id: str, template_id: str):
    user = request.auth
    if not user:
        raise_unauthorized()
    _check_space_access(user, space_id, min_role="editor")

    deleted, _ = SubAgentTemplate.objects.filter(id=template_id, space_id=space_id).delete()
    if not deleted:
        raise_not_found("Template not found")
    return {"success": True}
