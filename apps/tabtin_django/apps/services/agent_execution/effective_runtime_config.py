from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from uuid import UUID


class EffectiveRuntimeConfigError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


_APPROVAL_RANK = {
    'always_ask': 0,
    'auto': 1,
    'full_access': 2,
}


def resolve_workspace_approval_mode(workspace, project=None) -> str:
    """Return the sole effective approval level exposed by a Workspace."""
    if workspace is None or project is not None:
        return 'always_ask'

    from apps.services.common.agent_governance_resolver import resolve_allow_yolo_mode

    organization_settings = getattr(workspace.organization, 'settings', None) or {}
    if not resolve_allow_yolo_mode(organization_settings):
        return 'always_ask'
    grant = getattr(workspace, 'approval_grant', None)
    return grant if grant in _APPROVAL_RANK else 'always_ask'


@dataclass(frozen=True)
class EffectiveRuntimeConfig:
    session_id: str
    organization_id: str
    agent_id: str
    agent_owner_user_id: str
    workspace_id: str
    project_id: str | None
    agent_name: str
    goal: str
    custom_rules: str
    agent_config: dict[str, Any]
    workspace_root: str
    working_dir_type: str
    device_id: str
    device_fingerprint: str
    trust_status: str
    approval_mode: str
    approval_grant: str
    approval_memo_generation: int
    agent_mode: str

    def to_wire_payload(self) -> dict[str, Any]:
        return {
            'session_id': self.session_id,
            'organization_id': self.organization_id,
            'agent_id': self.agent_id,
            'agent_owner_user_id': self.agent_owner_user_id,
            'workspace_id': self.workspace_id,
            'project_id': self.project_id,
            'agent_name': self.agent_name,
            'goal': self.goal,
            'custom_rules': self.custom_rules,
            'agent_config': self.agent_config,
            'workspace_root': self.workspace_root,
            'working_dir_type': self.working_dir_type,
            'device_id': self.device_id,
            'device_fingerprint': self.device_fingerprint,
            'trust_status': self.trust_status,
            'approval_mode': self.approval_mode,
            'approval_grant': self.approval_grant,
            'approval_memo_generation': self.approval_memo_generation,
            'agent_mode': self.agent_mode,
        }


def resolve_effective_runtime_config(
    session,
    initiator_user,
    agent_id: UUID | str | None = None,
) -> EffectiveRuntimeConfig:
    """Read and validate the Agent × Workspace configuration for one turn."""
    from apps.agent.display_name import resolve_agent_display_name
    from apps.tabtinspace.models import Agent, Workspace

    resolved_agent_id = agent_id or getattr(session, 'agent_id', None)
    if not resolved_agent_id:
        raise EffectiveRuntimeConfigError('AGENT_REQUIRED', '会话没有当前 Agent')
    workspace_id = getattr(session, 'workspace_id', None)
    if not workspace_id:
        raise EffectiveRuntimeConfigError(
            'OBSERVER_SESSION',
            'observer 会话未绑定 Workspace，不能执行工具',
        )

    agent = Agent.objects.filter(id=resolved_agent_id, is_active=True).first()
    if agent is None:
        raise EffectiveRuntimeConfigError('AGENT_NOT_FOUND', 'Agent 不存在或已停用')
    workspace = (
        Workspace.objects
        .select_related('device', 'organization')
        .filter(id=workspace_id)
        .first()
    )
    if workspace is None:
        raise EffectiveRuntimeConfigError('WORKSPACE_NOT_FOUND', 'Workspace 不存在')

    session_org_id = str(getattr(session, 'organization_id', '') or '')
    if str(agent.organization_id) != session_org_id or str(workspace.organization_id) != session_org_id:
        raise EffectiveRuntimeConfigError(
            'ORGANIZATION_MISMATCH',
            'Agent、Workspace 与会话不属于同一 Organization',
        )

    user_id = str(getattr(initiator_user, 'id', initiator_user) or '')
    agent_owner_id = getattr(agent, 'owner_user_id', None)
    if str(agent_owner_id or '') != user_id:
        raise EffectiveRuntimeConfigError('AGENT_FORBIDDEN', '只能使用自己的 Agent')
    if str(workspace.created_by_id or '') != user_id:
        raise EffectiveRuntimeConfigError('WORKSPACE_FORBIDDEN', '只能使用自己的 Workspace')

    effective_mode = resolve_workspace_approval_mode(
        workspace,
        project=getattr(session, 'project_id', None),
    )
    effective_grant = effective_mode
    memo = workspace.approval_memo if isinstance(workspace.approval_memo, dict) else {}

    agent_config = dict(agent.agent_config or {})
    for retired_key in (
        'workspace_root', 'git_status', 'approval_grant', 'approval_memo',
    ):
        agent_config.pop(retired_key, None)
    security = agent_config.get('security')
    if isinstance(security, dict):
        security = dict(security)
        security.pop('approval_grant', None)
        security.pop('approval_memo', None)
        agent_config['security'] = security

    # ：ChatSession.space FK 已 Drop；project 经伴生 Workspace 反查，勿把
    # workspace_id 误填进 project_id。
    from apps.tabtinspace.models import ProjectMemberWorkspace

    pmw_project_id = (
        ProjectMemberWorkspace.objects
        .filter(workspace_id=workspace.id)
        .values_list('project_id', flat=True)
        .first()
    )

    return EffectiveRuntimeConfig(
        session_id=str(session.id),
        organization_id=session_org_id,
        agent_id=str(agent.id),
        agent_owner_user_id=str(agent.owner_user_id),
        workspace_id=str(workspace.id),
        project_id=str(pmw_project_id) if pmw_project_id else None,
        # ：展示名优先（展开 {owner}），供 host 贴用户消息前注入 agent-profile
        agent_name=resolve_agent_display_name(agent) or agent.name,
        goal=agent.goal or '',
        custom_rules=agent.custom_rules or '',
        agent_config=agent_config,
        workspace_root=workspace.working_dir,
        working_dir_type=workspace.working_dir_type or '',
        device_id=str(workspace.device_id),
        device_fingerprint=workspace.device.fingerprint,
        trust_status=workspace.trust_status,
        approval_mode=effective_mode,
        approval_grant=effective_grant,
        approval_memo_generation=memo.get('generation', 0),
        agent_mode=getattr(session, 'agent_mode', None) or '',
    )


__all__ = [
    'EffectiveRuntimeConfig',
    'EffectiveRuntimeConfigError',
    'resolve_workspace_approval_mode',
    'resolve_effective_runtime_config',
]
