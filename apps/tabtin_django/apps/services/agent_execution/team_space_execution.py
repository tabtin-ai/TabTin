"""Project 协作场景的 AI 执行上下文解析。

分层模型（principle/workspace-project.md）：协作场自己不执行，任务落到**发起人
自己的 Workspace / 设备 / 本地目录**，不再路由到 Owner。因此：

- 执行现场 = 发起人在该 Project 下自己的伴生 Workspace。
- 执行归属人 = 发起人本人（自己执行、自己审批）。
- 当发起人在该团队还没有可执行 Workspace 时，返回“未设置 Workspace”拦截，
  引导其创建 / 选择，而不是回落到别人的设备。

历史 ``OWNER_EXECUTION_UNAVAILABLE_CATEGORY`` 常量名保留（下游/前端引用），
但语义已从“Owner 设备不可用”改为“发起人尚无执行 Workspace”。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

from django.contrib.auth import get_user_model


OWNER_EXECUTION_UNAVAILABLE_CATEGORY = "owner_execution_device_unavailable"
OWNER_EXECUTION_AVAILABLE_STATUSES = frozenset({"online", "busy"})


@dataclass(frozen=True)
class OwnerExecutionAvailability:
    available: bool
    reason: str = ""
    device_id: str = ""
    device_name: str = ""
    device_status: str = ""


@dataclass(frozen=True)
class ChatExecutionContext:
    collaboration_space: Any
    execution_space: Any
    initiator_user: Any
    execution_owner_user: Any

    @property
    def is_team_space(self) -> bool:
        """协作场是否为团队 Project（真表或历史 team_space 壳）。"""
        collab = self.collaboration_space
        if collab is None:
            return False
        # ：Project 真表无 type 字段，用 model 名判定。
        model_name = getattr(getattr(collab, "_meta", None), "model_name", "")
        if model_name == "project":
            return True
        return getattr(collab, "type", None) == "team_space"

    @property
    def collaboration_space_id(self) -> str:
        return str(getattr(self.collaboration_space, "id", "") or "")

    @property
    def execution_space_id(self) -> str:
        return str(getattr(self.execution_space, "id", "") or "")

    @property
    def initiator_user_id(self) -> str:
        return str(getattr(self.initiator_user, "id", "") or "")

    @property
    def execution_owner_user_id(self) -> str:
        return str(getattr(self.execution_owner_user, "id", "") or "")

    def to_context_fields(self) -> dict[str, Any]:
        if not self.is_team_space:
            return {}
        return {
            "collaboration_space_id": self.collaboration_space_id,
            "execution_space_id": self.execution_space_id,
            "initiator_user_id": self.initiator_user_id,
            "execution_owner_user_id": self.execution_owner_user_id,
        }

    def to_message_metadata(self) -> dict[str, Any]:
        if not self.is_team_space:
            return {}
        return {
            "team_space_execution": {
                **self.to_context_fields(),
                "collaboration_space_name": _display_name(self.collaboration_space),
                "execution_space_name": _display_name(self.execution_space),
                "initiator_display_name": _user_display_name(self.initiator_user),
                "execution_owner_display_name": _user_display_name(self.execution_owner_user),
            }
        }


def _display_name(obj: Any) -> str:
    value = getattr(obj, "name", "") if obj is not None else ""
    return value.strip() if isinstance(value, str) else ""


def _user_display_name(user: Any) -> str:
    if user is None:
        return ""
    try:
        value = user.get_display_name()
    except Exception:
        value = ""
    if isinstance(value, str) and value.strip():
        return value.strip()
    for attr in ("username", "email"):
        value = getattr(user, attr, "")
        if isinstance(value, str) and value.strip():
            return value.strip()
    user_id = getattr(user, "id", None)
    return str(user_id) if user_id else ""


def _resolve_initiator_workspace(*, project, user) -> Optional[Any]:
    """发起人在指定 Project 下的伴生 Workspace。无则 None。"""
    from apps.tabtinspace.services.project_execution import (
        resolve_project_execution_workspace,
    )
    return resolve_project_execution_workspace(project=project, user=user)


def resolve_chat_execution_context(
    *,
    session,
    initiator_user,
) -> ChatExecutionContext:
    """解析一次对话轮次的协作场与执行身份。

     终态：协作场是 :class:`Project`；执行场是发起人在该 Project 下的
    伴生 :class:`Workspace`（``ProjectMemberWorkspace``）。会话优先读
    ``session.workspace``，再经成员伴生表反查 Project。
    """

    from apps.tabtinspace.models import (
        Project,
        ProjectMemberWorkspace,
        Workspace,
    )

    session_workspace = getattr(session, "workspace", None)
    if session_workspace is None and getattr(session, "workspace_id", None):
        session_workspace = (
            Workspace.objects
            .select_related("organization", "device")
            .filter(id=session.workspace_id)
            .first()
        )

    # ：会话已经显式记录协作 Project，优先用它确定协作边界；不能再仅凭
    # Workspace 恰好是某个 Project 成员现场就把个人对话猜成团队对话。
    session_project = getattr(session, "project", None)
    if session_project is None and getattr(session, "project_id", None):
        session_project = (
            Project.objects
            .filter(id=session.project_id)
            .first()
        )
    if session_project is not None:
        execution_space = _resolve_initiator_workspace(
            project=session_project,
            user=initiator_user,
        )
        return ChatExecutionContext(
            collaboration_space=session_project,
            execution_space=execution_space,
            initiator_user=initiator_user,
            execution_owner_user=initiator_user,
        )

    if session_workspace is not None:
        link = (
            ProjectMemberWorkspace.objects
            .select_related("project")
            .filter(workspace_id=session_workspace.id, user_id=getattr(initiator_user, "id", None))
            .first()
        )
        if link is None:
            # 会话挂在个人 Workspace，但非当前用户伴生登记 → 仍按个人场处理
            link = (
                ProjectMemberWorkspace.objects
                .select_related("project")
                .filter(workspace_id=session_workspace.id)
                .first()
            )
        if link is not None and link.project_id:
            execution_space = _resolve_initiator_workspace(
                project=link.project,
                user=initiator_user,
            )
            return ChatExecutionContext(
                collaboration_space=link.project,
                execution_space=execution_space,
                initiator_user=initiator_user,
                execution_owner_user=initiator_user,
            )
        # 纯个人 Workspace 会话
        return ChatExecutionContext(
            collaboration_space=session_workspace,
            execution_space=session_workspace,
            initiator_user=initiator_user,
            execution_owner_user=initiator_user,
        )

    # 兼容：历史会话可能只挂过 space_id（列已 Drop）；无 workspace 则无法解析。
    return ChatExecutionContext(
        collaboration_space=None,
        execution_space=None,
        initiator_user=initiator_user,
        execution_owner_user=initiator_user,
    )


def resolve_owner_execution_availability(
    execution_context: ChatExecutionContext,
) -> OwnerExecutionAvailability:
    """协作场里，发起人是否有可执行的自有 Workspace。

    分层模型下不再检查 Owner 设备；只要发起人在该团队有可执行 Workspace 即可
    （执行落到自己现场）。发起人尚未设置 Workspace 时才拦截并引导。
    """

    if not execution_context.is_team_space:
        return OwnerExecutionAvailability(available=True)

    if execution_context.execution_space is None:
        return OwnerExecutionAvailability(
            available=False,
            reason="member_workspace_unset",
        )

    return OwnerExecutionAvailability(
        available=True,
        device_id=execution_context.execution_space_id,
        device_name=_display_name(execution_context.execution_space),
    )


def build_owner_execution_unavailable_response(
    execution_context: ChatExecutionContext,
) -> dict[str, Any] | None:
    availability = resolve_owner_execution_availability(execution_context)
    if availability.available:
        return None

    message = (
        "你还没有为这个 Project 准备可执行的电脑端 Workspace。"
        "请先在电脑端接受邀请并完成本地执行环境绑定，再让 Agent 执行任务。"
    )
    return {
        "message_id": "",
        "reply": message,
        "model_id": None,
        "model_name": None,
        "trace_id": None,
        "dispatched_external": False,
        "error_category": OWNER_EXECUTION_UNAVAILABLE_CATEGORY,
        "error_message": message,
        "team_space_execution": {
            **execution_context.to_context_fields(),
            "reason": availability.reason,
        },
    }


def resolve_message_execution_metadata(
    session_id: str,
    *,
    run_id: str | None = None,
) -> dict[str, Any]:
    """Resolve metadata for relay-persisted assistant messages.

    The durable run owner is the stable initiator anchor for an exact turn.
    Runs created before that fact was recorded retain the latest-user-message
    fallback for compatibility.
    """

    from apps.chat.conversation.models import ChatMessage, ChatSession

    session = (
        ChatSession.objects
        .select_related(
            "workspace",
            "workspace__organization",
            "workspace__device",
        )
        .filter(id=session_id)
        .first()
    )
    if session is None:
        return {}

    initiator_id = None
    if run_id:
        from apps.services.agent_engine.models import ExecutionRun

        initiator_id = (
            ExecutionRun.objects
            .filter(run_id=run_id, session_id=str(session.id))
            .values_list("user_id", flat=True)
            .first()
        )
    if not initiator_id:
        initiator_id = (
            ChatMessage.objects
            .filter(session_id=session_id, role="user")
            .order_by("-created_at", "-id")
            .values_list("sender_user_id", flat=True)
            .first()
        )
    initiator = None
    if initiator_id:
        User = get_user_model()
        initiator = User.objects.filter(id=initiator_id).first()
    initiator = initiator or getattr(session, "user", None)
    if initiator is None:
        return {}
    return resolve_chat_execution_context(
        session=session,
        initiator_user=initiator,
    ).to_message_metadata()


__all__ = [
    "ChatExecutionContext",
    "OWNER_EXECUTION_UNAVAILABLE_CATEGORY",
    "OwnerExecutionAvailability",
    "build_owner_execution_unavailable_response",
    "resolve_chat_execution_context",
    "resolve_message_execution_metadata",
    "resolve_owner_execution_availability",
]
