"""接收人执行目标（Agent × Workspace）归属校验公共 helper。

共享任务 shared-fork 与 IM 接力 take-over 都要把「别人给的内容」物化成
接收人**自己的** Agent × Workspace 新会话——两处的归属校验必须一个口径，
统一收敛到本模块（对齐 create_session 姿势： 以 SpaceService.get_space
为 Workspace 唯一真源）：

- agent 必须归 user 所有、启用、且属于 ``organization_id``；
- workspace 必须是 user 有权限的 Workspace，且与 agent 同 Organization。

校验失败抛 :class:`ExecutionTargetError`（带 code / status_code），API 层
直接映射错误响应，不各自复制校验分支。
"""

from __future__ import annotations

from uuid import UUID


class ExecutionTargetError(ValueError):
    """Agent / Workspace 归属校验失败；code 与 status_code 供 API 层映射响应。"""

    def __init__(self, message: str, *, code: str = "VALIDATION_ERROR", status_code: int = 400):
        super().__init__(message)
        self.code = code
        self.status_code = status_code


def resolve_execution_target(*, user, agent_id, workspace_id, organization_id):
    """校验并返回接收人自己的 ``(agent, workspace)`` 执行目标。

    Args:
        user: 请求用户（新会话 owner）。
        agent_id: 接收人选择的 Agent id。
        workspace_id: 接收人选择的执行 Workspace id。
        organization_id: 目标组织（来源内容的组织归属，agent 必须同组织）。

    Raises:
        ExecutionTargetError: id 非法（400）、归属不符（403）、跨组织（400）。
    """
    from apps.agent.models import Agent
    from apps.tabtinspace.models import Workspace
    from apps.tabtinspace.services import SpaceService

    # ── Agent 归属校验 ──────────────────────────────────────────────────
    try:
        agent_uuid = UUID(str(agent_id))
    except (ValueError, TypeError, AttributeError):
        raise ExecutionTargetError("Agent ID 非法")
    agent = Agent.objects.filter(
        id=agent_uuid,
        is_active=True,
        owner_user_id=user.id,
    ).first()
    if not agent:
        raise ExecutionTargetError(
            "Agent 不存在或不属于当前用户", code="FORBIDDEN", status_code=403,
        )
    if str(agent.organization_id) != str(organization_id):
        raise ExecutionTargetError("Agent 不属于目标 Organization")

    # ── Workspace 归属校验（SpaceService.get_space 为唯一真源）─────────
    try:
        workspace_uuid = UUID(str(workspace_id))
    except (ValueError, TypeError, AttributeError):
        raise ExecutionTargetError("Workspace ID 非法")
    host = SpaceService(user=user).get_space(workspace_uuid)
    if not isinstance(host, Workspace):
        raise ExecutionTargetError(
            "Workspace 不存在或不属于当前用户", code="FORBIDDEN", status_code=403,
        )
    if str(host.organization_id) != str(agent.organization_id):
        raise ExecutionTargetError("Agent 与 Workspace 不属于同一 Organization")

    return agent, host
