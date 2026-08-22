"""Tin CRUD 与生命周期管理服务。"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional
from uuid import UUID

from django.db import transaction
from django.utils import timezone

from apps.tins.models import Tin, TinInstance, TinRunLog

logger = logging.getLogger(__name__)


class TinService:
    """Tin 定义的 CRUD 和生命周期操作。"""

    # ── 创建 ─────────────────────────────────────

    @staticmethod
    def create_tin(
        organization_id: UUID,
        data: dict,
        *,
        space_id: UUID | None = None,
        created_by: UUID | None = None,
    ) -> Tin:
        manifest = _build_manifest_from_data(data)
        tin = Tin.objects.create(
            organization_id=organization_id,
            space_id=space_id,
            name=data["name"],
            description=data.get("description", ""),
            icon_url=data.get("icon_url", ""),
            source=data.get("source", "agent_generated"),
            status="draft",
            activation_mode=data.get("activation_mode", "auto"),
            activation_rules=_serialize_rules(data.get("activation_rules", [])),
            activation_match=data.get("activation_match", "any"),
            variables_schema=_serialize_variables(data.get("variables_schema", {})),
            permissions=data.get("permissions", []),
            panel_position=data.get("panel_position", "sidebar_right"),
            panel_width=data.get("panel_width", 360),
            panel_html=data.get("panel_html", ""),
            content_script=data.get("content_script", ""),
            background_script=data.get("background_script", ""),
            agent_instructions=data.get("agent_instructions", ""),
            manifest=manifest,
            created_by=created_by,
        )
        logger.info("Tin created: %s (%s)", tin.name, tin.id)
        return tin

    # ── 更新 ─────────────────────────────────────

    @staticmethod
    def update_tin(tin: Tin, data: dict) -> Tin:
        updatable_fields = [
            "name", "description", "icon_url",
            "activation_mode", "activation_match",
            "permissions", "panel_position", "panel_width",
            "panel_html", "content_script", "background_script",
            "agent_instructions",
        ]
        changed = []
        for field in updatable_fields:
            if field in data and data[field] is not None:
                setattr(tin, field, data[field])
                changed.append(field)

        if "activation_rules" in data and data["activation_rules"] is not None:
            tin.activation_rules = _serialize_rules(data["activation_rules"])
            changed.append("activation_rules")

        if "variables_schema" in data and data["variables_schema"] is not None:
            tin.variables_schema = _serialize_variables(data["variables_schema"])
            changed.append("variables_schema")

        if changed:
            tin.manifest = _build_manifest_from_tin(tin)
            tin.save(update_fields=changed + ["manifest", "updated_at"])
            logger.info("Tin updated: %s, fields=%s", tin.id, changed)

        return tin

    # ── 更新单个文件 ─────────────────────────────

    @staticmethod
    def update_file(tin: Tin, file_type: str, content: str) -> Tin:
        valid_types = {"panel_html", "content_script", "background_script", "agent_instructions"}
        if file_type not in valid_types:
            raise ValueError(f"Invalid file_type: {file_type}")
        setattr(tin, file_type, content)
        tin.save(update_fields=[file_type, "updated_at"])
        logger.info("Tin file updated: %s.%s", tin.id, file_type)
        return tin

    # ── 状态变更 ──────────────────────────────────

    @staticmethod
    def activate_tin(tin: Tin) -> Tin:
        tin.status = "active"
        tin.save(update_fields=["status", "updated_at"])
        logger.info("Tin activated: %s", tin.id)
        return tin

    @staticmethod
    def disable_tin(tin: Tin) -> Tin:
        tin.status = "disabled"
        tin.save(update_fields=["status", "updated_at"])
        logger.info("Tin disabled: %s", tin.id)
        return tin

    # ── 删除 ─────────────────────────────────────

    @staticmethod
    def delete_tin(tin: Tin) -> None:
        tin_id = tin.id
        tin.delete()
        logger.info("Tin deleted: %s", tin_id)

    # ── 查询 ─────────────────────────────────────

    @staticmethod
    def get_tin(tin_id: UUID, organization_id: UUID) -> Optional[Tin]:
        return Tin.objects.filter(id=tin_id, organization_id=organization_id).first()

    @staticmethod
    def list_tins(
        organization_id: UUID,
        *,
        space_id: UUID | None = None,
        status: str | None = None,
    ) -> list:
        return list(TinService.list_tins_qs(organization_id, space_id=space_id, status=status))

    @staticmethod
    def list_tins_qs(
        organization_id: UUID,
        *,
        space_id: UUID | None = None,
        status: str | None = None,
    ):
        qs = Tin.objects.filter(organization_id=organization_id)
        if space_id:
            from django.db.models import Q
            qs = qs.filter(
                Q(space_id=space_id) | Q(space_id__isnull=True)
            )
        if status:
            qs = qs.filter(status=status)
        return qs.order_by("-updated_at")


class TinInstanceService:
    """Tin 实例（Space 内的安装/激活）管理。"""

    @staticmethod
    def install_tin(
        tin: Tin,
        space_id: UUID,
        organization_id: UUID,
        *,
        user_variables: dict | None = None,
        is_enabled: bool = True,
        pinned: bool = False,
    ) -> TinInstance:
        instance, created = TinInstance.objects.get_or_create(
            tin=tin,
            space_id=space_id,
            defaults={
                "organization_id": organization_id,
                "is_enabled": is_enabled,
                "pinned": pinned,
                "user_variables": user_variables or {},
            },
        )
        if not created:
            instance.is_enabled = is_enabled
            instance.pinned = pinned
            if user_variables is not None:
                instance.user_variables = user_variables
            instance.save(update_fields=["is_enabled", "pinned", "user_variables", "updated_at"])
        logger.info("TinInstance installed: tin=%s, space=%s, created=%s", tin.id, space_id, created)
        return instance

    @staticmethod
    def update_instance(instance: TinInstance, data: dict) -> TinInstance:
        changed = []
        for field in ("is_enabled", "pinned", "user_variables"):
            if field in data and data[field] is not None:
                setattr(instance, field, data[field])
                changed.append(field)
        if changed:
            instance.save(update_fields=changed + ["updated_at"])
        return instance

    @staticmethod
    def uninstall(instance: TinInstance) -> None:
        instance_id = instance.id
        instance.delete()
        logger.info("TinInstance uninstalled: %s", instance_id)

    @staticmethod
    def list_instances(
        space_id: UUID,
        organization_id: UUID,
        *,
        is_enabled: bool | None = None,
    ) -> list:
        return list(TinInstanceService.list_instances_qs(space_id, organization_id, is_enabled=is_enabled))

    @staticmethod
    def list_instances_qs(
        space_id: UUID,
        organization_id: UUID,
        *,
        is_enabled: bool | None = None,
    ):
        qs = TinInstance.objects.filter(
            space_id=space_id,
            organization_id=organization_id,
        ).select_related("tin")
        if is_enabled is not None:
            qs = qs.filter(is_enabled=is_enabled)
        return qs.order_by("-updated_at")

    @staticmethod
    def get_instance(instance_id: UUID) -> Optional[TinInstance]:
        return TinInstance.objects.select_related("tin").filter(id=instance_id).first()

    @staticmethod
    def record_activation(instance: TinInstance) -> None:
        instance.last_activated_at = timezone.now()
        instance.save(update_fields=["last_activated_at", "updated_at"])

    @staticmethod
    def log_run(
        instance: TinInstance,
        action: str,
        *,
        input_data: dict | None = None,
        output_data: dict | None = None,
        error: str = "",
        duration_ms: int | None = None,
    ) -> TinRunLog:
        return TinRunLog.objects.create(
            instance=instance,
            action=action,
            input_data=input_data or {},
            output_data=output_data or {},
            error=error,
            duration_ms=duration_ms,
        )


# ─── helpers ──────────────────────────────────────────────────

def _serialize_rules(rules: list) -> list:
    if not rules:
        return []
    return [r if isinstance(r, dict) else r.model_dump() for r in rules]


def _serialize_variables(variables: dict) -> dict:
    if not variables:
        return {}
    result = {}
    for k, v in variables.items():
        result[k] = v if isinstance(v, dict) else v.model_dump()
    return result


def _build_manifest(
    *,
    name: str = "",
    description: str = "",
    version: str = "1.0.0",
    activation_mode: str = "auto",
    activation_rules: list | None = None,
    activation_match: str = "any",
    variables_schema: dict | None = None,
    permissions: list | None = None,
    panel_position: str = "sidebar_right",
    panel_width: int = 360,
) -> dict:
    return {
        "name": name,
        "description": description,
        "version": version,
        "activation": {
            "mode": activation_mode,
            "rules": activation_rules if activation_rules is not None else [],
            "match": activation_match,
        },
        "variables": variables_schema if variables_schema is not None else {},
        "permissions": permissions if permissions is not None else [],
        "ui": {
            "panel_position": panel_position,
            "width": panel_width,
            "entry": "ui/panel.html",
        },
    }


def _build_manifest_from_data(data: dict) -> dict:
    return _build_manifest(
        name=data.get("name", ""),
        description=data.get("description", ""),
        activation_mode=data.get("activation_mode", "auto"),
        activation_rules=_serialize_rules(data.get("activation_rules", [])),
        activation_match=data.get("activation_match", "any"),
        variables_schema=_serialize_variables(data.get("variables_schema", {})),
        permissions=data.get("permissions", []),
        panel_position=data.get("panel_position", "sidebar_right"),
        panel_width=data.get("panel_width", 360),
    )


def _build_manifest_from_tin(tin: Tin) -> dict:
    return _build_manifest(
        name=tin.name,
        description=tin.description,
        version=tin.version,
        activation_mode=tin.activation_mode,
        activation_rules=tin.activation_rules,
        activation_match=tin.activation_match,
        variables_schema=tin.variables_schema,
        permissions=tin.permissions,
        panel_position=tin.panel_position,
        panel_width=tin.panel_width,
    )
