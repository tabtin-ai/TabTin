"""普通群聊 Agent × Workspace 执行现场绑定。

成员关系仍由 ConversationService.add_agents / remove_agent 写入；
本服务负责普通群校验、主人现场校验，并在同一事务里落绑定。
"""

from __future__ import annotations

import logging
from typing import Any

from django.db import transaction
from django.utils import timezone

from apps.services.common.db_router import postgres_app_db_alias
from apps.tabchat.constants import ConversationType
from apps.tabchat.models import Conversation, ConversationAgentWorkspace, ConversationMember
from apps.tabchat.services.conversation_access import ConversationAccessResolver
from apps.tabchat.services.conversation_service import ConversationService
from apps.tabchat.utils import get_conversation_team_space
from apps.tabtinspace.models import Agent, SpaceMembership, Workspace

logger = logging.getLogger(__name__)

REBIND_REQUIRED_REASON = "请重新指定执行现场"
WORKSPACE_UNAVAILABLE_REASON = "工作空间不可用或未信任"
WORKSPACE_UNTRUSTED_REASON = "工作空间未信任"
DEVICE_OFFLINE_OR_UNAVAILABLE_REASON = "执行设备离线或不可用"


def explain_executable_owner_workspace(
    workspace: Workspace | None,
    *,
    owner_user_id: str,
    organization_id: str,
) -> str | None:
    """主人当前可控、已信任、用户供给的个人现场。

    返回 None 表示可绑定；否则返回失败原因。
    ``device.user_id`` 不是主人不挡绑定：触发时按离线，群里写错误提示、不派发。
    """
    if workspace is None:
        return WORKSPACE_UNAVAILABLE_REASON
    if str(workspace.organization_id) != str(organization_id):
        return WORKSPACE_UNAVAILABLE_REASON
    if str(getattr(workspace, "created_by_id", "") or "") != str(owner_user_id):
        return WORKSPACE_UNAVAILABLE_REASON
    if workspace.provisioning_source != Workspace.ProvisioningSource.USER:
        return WORKSPACE_UNAVAILABLE_REASON
    if workspace.trust_status != Workspace.TrustStatus.TRUSTED:
        return WORKSPACE_UNTRUSTED_REASON
    device = getattr(workspace, "device", None)
    if device is None:
        return DEVICE_OFFLINE_OR_UNAVAILABLE_REASON
    if getattr(device, "role", None) != "control":
        return DEVICE_OFFLINE_OR_UNAVAILABLE_REASON
    if not SpaceMembership.objects.filter(
        workspace=workspace,
        user_id=owner_user_id,
        role="owner",
        is_active=True,
        status=SpaceMembership.Status.ACTIVE,
    ).exists():
        return WORKSPACE_UNAVAILABLE_REASON
    return None


def is_execution_device_registered_to_owner(
    workspace: Workspace | None,
    owner_user_id: str,
) -> bool:
    """执行设备是否登记在主人账号下。不是则触发时按离线、不派发。"""
    device = getattr(workspace, "device", None) if workspace is not None else None
    if device is None:
        return False
    return str(getattr(device, "user_id", "") or "") == str(owner_user_id)


def is_owner_execution_online(workspace: Workspace | None, owner_user_id: str) -> bool:
    """主人登记的执行设备当前是否可派发（online/busy）。"""
    if not is_execution_device_registered_to_owner(workspace, owner_user_id):
        return False
    from apps.services.common.device_capability_registry import DEVICE_AVAILABLE_STATUSES

    device = getattr(workspace, "device", None)
    return getattr(device, "status", None) in DEVICE_AVAILABLE_STATUSES


def is_executable_owner_workspace(
    workspace: Workspace | None,
    *,
    owner_user_id: str,
    organization_id: str,
) -> bool:
    """主人当前可控、已信任、用户供给的个人现场。"""
    return (
        explain_executable_owner_workspace(
            workspace,
            owner_user_id=owner_user_id,
            organization_id=organization_id,
        )
        is None
    )


def resolve_bound_workspace(
    conversation_id: str,
    agent_id: str,
    *,
    owner_user_id: str,
    organization_id: str,
) -> Workspace | None:
    binding = (
        ConversationAgentWorkspace.objects.select_related("workspace", "workspace__device")
        .filter(conversation_id=conversation_id, agent_id=str(agent_id))
        .first()
    )
    if binding is None:
        return None
    if not is_executable_owner_workspace(
        binding.workspace,
        owner_user_id=str(owner_user_id),
        organization_id=str(organization_id),
    ):
        return None
    return binding.workspace


class ConversationAgentWorkspaceService:
    @staticmethod
    def _load_conversation(conversation_id: str) -> Conversation:
        try:
            return Conversation.objects.get(pk=conversation_id)
        except Conversation.DoesNotExist as exc:
            raise ValueError("会话不存在") from exc

    @staticmethod
    def _require_ordinary_group(conv: Conversation) -> None:
        if conv.type == ConversationType.DM:
            raise ValueError("私聊不能绑定执行现场")
        if get_conversation_team_space(conv) is not None:
            raise ValueError("项目群不支持绑定执行现场")

    @staticmethod
    def _load_owned_agent(agent_id: str, operator_id: str, organization_id: str) -> Agent:
        agent = (
            Agent.objects.filter(
                id=agent_id,
                organization_id=organization_id,
                type="bot",
                is_active=True,
            )
            .select_related("owner_user")
            .first()
        )
        if agent is None:
            raise ValueError("AI 助手不存在")
        if str(getattr(agent, "owner_user_id", "") or "") != str(operator_id):
            raise PermissionError("只有 Agent 主人可以指定执行现场")
        return agent

    @staticmethod
    def _load_executable_workspace(
        workspace_id: str,
        *,
        owner_user_id: str,
        organization_id: str,
    ) -> Workspace:
        workspace = (
            Workspace.objects.select_related("device")
            .filter(id=workspace_id, organization_id=organization_id)
            .first()
        )
        reason = explain_executable_owner_workspace(
            workspace,
            owner_user_id=owner_user_id,
            organization_id=organization_id,
        )
        if reason:
            raise ValueError(reason)
        assert workspace is not None
        return workspace

    @staticmethod
    def _serialize(
        binding: ConversationAgentWorkspace,
        *,
        operator_id: str,
        owner_user_id: str | None = None,
    ) -> dict[str, Any]:
        workspace = binding.workspace
        if owner_user_id is None:
            agent = Agent.objects.filter(id=binding.agent_id).only("owner_user_id").first()
            owner_user_id = str(getattr(agent, "owner_user_id", "") or "")
        return {
            "agent_id": binding.agent_id,
            "workspace_id": str(workspace.id),
            "workspace_name": workspace.name,
            "bound_by_user_id": binding.bound_by_user_id,
            "bound_at": binding.bound_at.isoformat() if binding.bound_at else None,
            "can_rebind": owner_user_id == str(operator_id),
            "is_executable": is_executable_owner_workspace(
                workspace,
                owner_user_id=owner_user_id,
                organization_id=binding.organization_id,
            )
            if owner_user_id
            else False,
        }

    @classmethod
    def list_bindings(cls, conversation_id: str, operator_id: str) -> list[dict[str, Any]]:
        conv = cls._load_conversation(conversation_id)
        if not ConversationAccessResolver.resolve(conv, operator_id).can_view:
            raise PermissionError("无权访问该会话")
        bindings = list(
            ConversationAgentWorkspace.objects.select_related("workspace", "workspace__device")
            .filter(conversation=conv)
            .order_by("bound_at", "id")
        )
        owners = {
            str(agent.id): str(getattr(agent, "owner_user_id", "") or "")
            for agent in Agent.objects.filter(
                id__in=[binding.agent_id for binding in bindings]
            ).only("id", "owner_user_id")
        }
        return [
            cls._serialize(
                binding,
                operator_id=operator_id,
                owner_user_id=owners.get(binding.agent_id, ""),
            )
            for binding in bindings
        ]

    @classmethod
    def bind_agent(
        cls,
        conversation_id: str,
        operator_id: str,
        agent_id: str,
        workspace_id: str,
    ) -> dict[str, Any]:
        conv = cls._load_conversation(conversation_id)
        cls._require_ordinary_group(conv)
        if not ConversationAccessResolver.resolve(conv, operator_id).can_view:
            raise PermissionError("只有群成员可以添加 AI 助手")
        agent = cls._load_owned_agent(agent_id, operator_id, str(conv.organization_id))
        workspace = cls._load_executable_workspace(
            workspace_id,
            owner_user_id=str(agent.owner_user_id),
            organization_id=str(conv.organization_id),
        )
        with transaction.atomic(using=postgres_app_db_alias()):
            ConversationService.add_agents(str(conv.id), operator_id, [str(agent.id)])
            binding, _created = ConversationAgentWorkspace.objects.update_or_create(
                conversation=conv,
                agent_id=str(agent.id),
                defaults={
                    "organization_id": str(conv.organization_id),
                    "workspace": workspace,
                    "bound_by_user_id": str(operator_id),
                    "bound_at": timezone.now(),
                },
            )
        binding = (
            ConversationAgentWorkspace.objects.select_related("workspace", "workspace__device")
            .get(pk=binding.pk)
        )
        return cls._serialize(binding, operator_id=operator_id)

    @classmethod
    def update_binding(
        cls,
        conversation_id: str,
        operator_id: str,
        agent_id: str,
        workspace_id: str,
    ) -> dict[str, Any]:
        conv = cls._load_conversation(conversation_id)
        cls._require_ordinary_group(conv)
        if not ConversationAccessResolver.resolve(conv, operator_id).can_view:
            raise PermissionError("无权访问该会话")
        agent = cls._load_owned_agent(agent_id, operator_id, str(conv.organization_id))
        if not ConversationMember.objects.filter(conversation=conv, agent_id=str(agent.id)).exists():
            raise ValueError("该 Agent 不在群里")
        workspace = cls._load_executable_workspace(
            workspace_id,
            owner_user_id=str(agent.owner_user_id),
            organization_id=str(conv.organization_id),
        )
        binding = ConversationAgentWorkspace.objects.filter(
            conversation=conv,
            agent_id=str(agent.id),
        ).first()
        if binding is None:
            raise ValueError(REBIND_REQUIRED_REASON)
        binding.workspace = workspace
        binding.bound_by_user_id = str(operator_id)
        binding.bound_at = timezone.now()
        binding.save(update_fields=["workspace", "bound_by_user_id", "bound_at"])
        binding = (
            ConversationAgentWorkspace.objects.select_related("workspace", "workspace__device")
            .get(pk=binding.pk)
        )
        return cls._serialize(binding, operator_id=operator_id)

    @classmethod
    def unbind_agent(cls, conversation_id: str, operator_id: str, agent_id: str) -> bool:
        conv = cls._load_conversation(conversation_id)
        cls._require_ordinary_group(conv)
        cls._load_owned_agent(agent_id, operator_id, str(conv.organization_id))
        return ConversationService.remove_agent(conversation_id, operator_id, agent_id)
