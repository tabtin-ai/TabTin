"""
Tins ↔ Skills 桥接层。

当 Tin 的 agent_instructions 非空时，将其作为一个 skill entry
注入到 Agent 上下文中，使 Agent 能感知当前激活的 Tins。
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Set, Union

from apps.tins.constants import TIN_ACTIVATE_TOOLS
from uuid import UUID

logger = logging.getLogger(__name__)


def collect_tin_skill_entries(
    organization_id: str | UUID,
    space_id: str | UUID,
) -> List[Dict[str, Any]]:
    """收集当前 Space 中所有激活 Tin 的 skill 索引条目。

    返回格式与 SkillsRegistryService.list_available_skills 兼容，
    可以被 SkillsMessageMiddleware 直接消费。
    """
    from apps.tins.models import TinInstance

    instances = TinInstance.objects.filter(
        organization_id=str(organization_id),
        space_id=str(space_id),
        is_enabled=True,
        tin__status="active",
    ).select_related("tin")

    entries: List[Dict[str, Any]] = []
    for inst in instances:
        tin = inst.tin
        if not tin.agent_instructions:
            continue

        entries.append({
            "skill_key": f"tin:{tin.id}",
            "name": tin.name,
            "description": tin.description or f"Tin: {tin.name}",
            "source": "tin",
            "auto_activate_for": [],
            "tools": list(TIN_ACTIVATE_TOOLS),
            "_tin_id": str(tin.id),
            "_tin_instructions": tin.agent_instructions,
        })

    return entries


def get_tin_instructions(
    tin_id: str | UUID,
    *,
    organization_id: str | UUID,
) -> Optional[str]:
    """读取单个 Tin 的 agent_instructions（供 skills.read 使用）。

    organization_id 为必填参数，确保只返回属于该 organization 的 Tin 指令，防止跨 organization 数据泄露。
    """
    from apps.tins.models import Tin

    try:
        tin = Tin.objects.get(
            id=str(tin_id),
            status="active",
            organization_id=str(organization_id),
        )
        return tin.agent_instructions
    except Tin.DoesNotExist:
        return None
