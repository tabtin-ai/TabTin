from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Iterable
from uuid import UUID

from apps.services.agent_engine.models import SubAgentTemplate


@dataclass(frozen=True)
class RoleSpec:
    """V1 协作角色定义，直接由 SubAgentTemplate 投影而来。"""

    template_id: str
    role_id: str
    name: str
    description: str
    system_prompt: str
    subagent_type: str
    allowed_tools: list[str]
    denied_tools: list[str]
    model_id: str
    thinking_level: str
    default_mode: str
    app_id: str
    reply_mode: str
    tool_domains: list[str]
    enabled: bool = True

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class RoleSpecService:
    """将 Space 下的 SubAgentTemplate 解析为 group runtime 可消费的角色。"""

    @staticmethod
    def list_available_role_specs(space_id: str | UUID) -> list[RoleSpec]:
        templates = SubAgentTemplate.objects.filter(space_id=space_id, is_enabled=True).order_by("created_at", "name")
        return [RoleSpecService._from_template(template) for template in templates]

    @staticmethod
    def resolve_role_specs(
        *,
        space_id: str | UUID,
        role_inputs: Iterable[dict[str, Any]] | None,
    ) -> list[RoleSpec]:
        normalized_inputs = [item for item in (role_inputs or []) if isinstance(item, dict)]
        template_ids: list[str] = []
        seen: set[str] = set()
        for item in normalized_inputs:
            template_id = str(item.get("template_id") or "").strip()
            if not template_id or template_id in seen:
                continue
            seen.add(template_id)
            template_ids.append(template_id)

        if not template_ids:
            return []

        valid_template_ids: list[str] = []
        for template_id in template_ids:
            try:
                UUID(template_id)
            except (TypeError, ValueError, AttributeError):
                continue
            valid_template_ids.append(template_id)

        if not valid_template_ids:
            return []

        templates = {
            str(template.id): template
            for template in SubAgentTemplate.objects.filter(space_id=space_id, id__in=valid_template_ids, is_enabled=True)
        }

        resolved: list[RoleSpec] = []
        for item in normalized_inputs:
            template_id = str(item.get("template_id") or "").strip()
            if not template_id or not item.get("enabled", True):
                continue
            template = templates.get(template_id)
            if template is None:
                continue
            resolved.append(RoleSpecService._from_template(template))
        return resolved

    @staticmethod
    def _from_template(template: SubAgentTemplate) -> RoleSpec:
        template_id = str(template.id)
        return RoleSpec(
            template_id=template_id,
            role_id=template_id,
            name=template.name,
            description=template.description or "",
            system_prompt=template.system_prompt or "",
            subagent_type=template.subagent_type or "execute",
            allowed_tools=list(template.allowed_tools or []),
            denied_tools=list(template.denied_tools or []),
            model_id=template.model_id or "",
            thinking_level=template.thinking_level or "",
            default_mode=template.default_mode or "wait",
            app_id=template.app_id or "",
            reply_mode=template.reply_mode or "",
            tool_domains=list(template.tool_domains or []),
            enabled=True,
        )

