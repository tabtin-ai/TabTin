"""Resolve Skill APIs to Agent + optional Workspace anchors。

#7118：Skill HTTP 不再暴露 ``space_id``——身份维度是 ``organization_id`` +
``agent_id``。``SkillSpaceContext.space_id`` 字段保留但仅用于 SubAgent 模板同步
等内部路径；如无 Workspace 上下文，回落到 ``agent_id`` 便于沙盒占位。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional
from uuid import UUID


class SkillSpaceContextError(Exception):
    """The supplied context cannot identify the required Skill owner."""


@dataclass(frozen=True)
class SkillSpaceContext:
    space_id: UUID
    agent_id: UUID
    organization_id: UUID
    device_id: Optional[UUID]


def resolve_skill_agent_context(
    agent_id,
    workspace_id=None,
) -> SkillSpaceContext:
    """#6198 / ：Skill 归属 Agent；Workspace 仅内部可选提供 device/org。

    ``agent_id`` 必填。``workspace_id`` 缺省时 organization/device 从 Agent 所属
    组织推断；``space_id`` 回落到 agent_id（作为 SubAgent sync 与 sandbox 占位）。
    """
    if not agent_id:
        raise SkillSpaceContextError(
            "agent_id 必填：Skill 归属身份，不再从 Workspace 反推"
        )

    from apps.agent.models import Agent
    from apps.tabtinspace.models import Workspace

    try:
        agent_uuid = agent_id if isinstance(agent_id, UUID) else UUID(str(agent_id))
    except (TypeError, ValueError) as exc:
        raise SkillSpaceContextError(f"无效 agent_id: {agent_id}") from exc

    agent = (
        Agent.objects.filter(id=agent_uuid, is_active=True)
        .only("id", "organization_id")
        .first()
    )
    if agent is None:
        raise SkillSpaceContextError(f"Agent 不存在或已停用: {agent_uuid}")

    space_uuid: UUID = agent_uuid
    device_id: Optional[UUID] = None
    organization_id = agent.organization_id

    if workspace_id:
        try:
            space_uuid = (
                workspace_id
                if isinstance(workspace_id, UUID)
                else UUID(str(workspace_id))
            )
        except (TypeError, ValueError) as exc:
            raise SkillSpaceContextError(f"无效 workspace_id: {workspace_id}") from exc
        workspace = (
            Workspace.objects.filter(id=space_uuid)
            .only("id", "organization_id", "device_id")
            .first()
        )
        if workspace is None:
            raise SkillSpaceContextError(f"Workspace 不存在: {space_uuid}")
        organization_id = workspace.organization_id
        device_id = workspace.device_id

    return SkillSpaceContext(
        space_id=space_uuid,
        agent_id=agent.id,
        organization_id=organization_id,
        device_id=device_id,
    )


def resolve_skill_context_for_organization(
    *,
    organization_id,
    agent_id=None,
) -> SkillSpaceContext:
    """#7118：Skill HTTP 首选入口——(organization_id[, agent_id]) → 上下文。

    ``organization_id`` 必填（HTTP 已用它做成员鉴权）。``agent_id`` 可选：
    - 传入：走 ``resolve_skill_agent_context`` 校验 Agent 属于该 organization
    - 缺省：仅供列表 / 市场等无 Agent 上下文的读接口用，返回占位 space=空
    """
    if not organization_id:
        raise SkillSpaceContextError(
            "organization_id 必填：Skill HTTP 需要显式 Organization 上下文"
        )
    try:
        org_uuid = (
            organization_id
            if isinstance(organization_id, UUID)
            else UUID(str(organization_id))
        )
    except (TypeError, ValueError) as exc:
        raise SkillSpaceContextError(
            f"无效 organization_id: {organization_id}"
        ) from exc

    if agent_id:
        context = resolve_skill_agent_context(agent_id=agent_id, workspace_id=None)
        if str(context.organization_id) != str(org_uuid):
            raise SkillSpaceContextError(
                "Agent 不属于指定 Organization：agent_id 与 organization_id 不匹配"
            )
        return context

    return SkillSpaceContext(
        space_id=org_uuid,
        agent_id=org_uuid,
        organization_id=org_uuid,
        device_id=None,
    )


def resolve_skill_space_context(space_id, agent_id=None) -> SkillSpaceContext:
    """内部兼容入口：必须同时提供 agent_id（ 后不再读 Workspace.agent）。

    ：仅供 SubAgent 模板同步等内部路径复用；Skill HTTP 已不暴露 space_id。
    """
    if not agent_id:
        raise SkillSpaceContextError(
            "agent_id 必填：Skill 归属身份，不再从 Workspace 反推"
        )
    return resolve_skill_agent_context(agent_id=agent_id, workspace_id=space_id)


__all__ = [
    "SkillSpaceContext",
    "SkillSpaceContextError",
    "resolve_skill_agent_context",
    "resolve_skill_context_for_organization",
    "resolve_skill_space_context",
]
