from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

from apps.services.agent_engine.services.role_spec_service import RoleSpecService


GROUP_RUNTIME_CONTEXT_KEY = "group_runtime"
DEFAULT_ORCHESTRATION_MODE = "parallel"
DEFAULT_LEAD_ROLE = "lead_agent"
LEGACY_PRIMARY_LEAD_ROLE = "primary_agent"
DEFAULT_SUMMARY_STYLE = "summary_only"
VALID_ORCHESTRATION_MODES = {"parallel", "round_robin", "moderated", "free"}
VALID_SUMMARY_STYLES = {"summary_only", "summary_plus_details"}


@dataclass(frozen=True)
class GroupRuntimeSnapshot:
    enabled: bool
    orchestration_mode: str
    lead_role: str
    summary_style: str
    roles: list[dict[str, Any]]
    resolved_roles: list[dict[str, Any]]
    is_active: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "orchestration_mode": self.orchestration_mode,
            "lead_role": self.lead_role,
            "summary_style": self.summary_style,
            "roles": self.roles,
            "resolved_roles": self.resolved_roles,
            "is_active": self.is_active,
        }


class GroupRuntimeService:
    """会话级 group runtime 归一化与角色解析。"""

    @classmethod
    def normalize_config(cls, raw_config: Mapping[str, Any] | None) -> dict[str, Any]:
        raw = raw_config if isinstance(raw_config, Mapping) else {}
        roles: list[dict[str, Any]] = []
        seen_template_ids: set[str] = set()
        raw_roles = raw.get("roles")
        if isinstance(raw_roles, list):
            for item in raw_roles:
                if not isinstance(item, Mapping):
                    continue
                template_id = str(item.get("template_id") or "").strip()
                if not template_id or template_id in seen_template_ids:
                    continue
                seen_template_ids.add(template_id)
                roles.append(
                    {
                        "template_id": template_id,
                        "enabled": bool(item.get("enabled", True)),
                    }
                )

        orchestration_mode = str(raw.get("orchestration_mode") or DEFAULT_ORCHESTRATION_MODE).strip()
        if orchestration_mode not in VALID_ORCHESTRATION_MODES:
            orchestration_mode = DEFAULT_ORCHESTRATION_MODE

        summary_style = str(raw.get("summary_style") or DEFAULT_SUMMARY_STYLE).strip()
        if summary_style not in VALID_SUMMARY_STYLES:
            summary_style = DEFAULT_SUMMARY_STYLE

        lead_role = str(raw.get("lead_role") or DEFAULT_LEAD_ROLE).strip()
        if lead_role == LEGACY_PRIMARY_LEAD_ROLE:
            lead_role = DEFAULT_LEAD_ROLE
        elif lead_role != DEFAULT_LEAD_ROLE:
            lead_role = DEFAULT_LEAD_ROLE

        return {
            "enabled": bool(raw.get("enabled", False)),
            "orchestration_mode": orchestration_mode,
            "lead_role": lead_role,
            "summary_style": summary_style,
            "roles": roles,
        }

    @classmethod
    def extract_from_context_data(cls, context_data: Mapping[str, Any] | None) -> dict[str, Any]:
        if not isinstance(context_data, Mapping):
            return cls.normalize_config(None)
        return cls.normalize_config(context_data.get(GROUP_RUNTIME_CONTEXT_KEY))

    @classmethod
    def merge_into_context_data(
        cls,
        context_data: Mapping[str, Any] | None,
        *,
        group_runtime: Mapping[str, Any] | None,
    ) -> dict[str, Any]:
        merged = dict(context_data or {})
        merged[GROUP_RUNTIME_CONTEXT_KEY] = cls.normalize_config(group_runtime)
        return merged

    @classmethod
    def build_snapshot(
        cls,
        *,
        space_id: str,
        context_data: Mapping[str, Any] | None,
    ) -> GroupRuntimeSnapshot:
        normalized = cls.extract_from_context_data(context_data)
        resolved_roles = [
            role_spec.to_dict()
            for role_spec in RoleSpecService.resolve_role_specs(
                space_id=space_id,
                role_inputs=normalized["roles"],
            )
        ]
        is_active = bool(normalized["enabled"] and resolved_roles)
        return GroupRuntimeSnapshot(
            enabled=bool(normalized["enabled"]),
            orchestration_mode=normalized["orchestration_mode"],
            lead_role=normalized["lead_role"],
            summary_style=normalized["summary_style"],
            roles=list(normalized["roles"]),
            resolved_roles=resolved_roles,
            is_active=is_active,
        )

