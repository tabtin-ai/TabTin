"""Team Space channel message -> Agent task thread service."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from django.contrib.auth import get_user_model
from django.db import transaction

from apps.chat.conversation.models import ChatSession
from apps.agent.models import Agent
from apps.services.common.db_router import postgres_app_db_alias
from apps.tabchat.models import Conversation, Message
from apps.tabchat.services.external_group_errors import ExternalGroupCapabilityError
from apps.tabchat.utils import get_conversation_team_space, is_team_space_conversation_user_active
from apps.tabtinspace.models import Project, Workspace
from apps.tabtinspace.services.project_execution import resolve_project_execution_workspace


MAX_EXTRA_CONTEXT_LEN = 4000
MAX_TASK_PROMPT_LEN = 12000
MAX_MESSAGE_CONTEXT_ITEMS = 20
logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class TeamSpaceTaskThread:
    session: ChatSession
    prompt: str
    source_message_ids: list[int]


def _message_sender_names(messages: list[Message]) -> dict[str, str]:
    user_ids = {
        message.sender_id
        for message in messages
        if message.sender_type == "user" and message.sender_id
    }
    users = {
        str(user.id): user
        for user in get_user_model().objects.filter(id__in=user_ids)
    }
    names: dict[str, str] = {}
    for user_id, user in users.items():
        names[user_id] = user.get_display_name() or user_id[:8]
    return names


def _format_message_context(messages: list[Message]) -> str:
    names = _message_sender_names(messages)
    lines: list[str] = []
    for message in messages[:MAX_MESSAGE_CONTEXT_ITEMS]:
        sender = names.get(message.sender_id, message.sender_id[:8] if message.sender_id else "unknown")
        if message.sender_type == "agent":
            sender = f"Agent {sender}"
        prefix = "源消息" if message.reply_to_id is None else "回复"
        content = (message.content or "").strip()
        if not content:
            content = "[非文本消息]"
        lines.append(f"- {prefix} #{message.id} · {sender}: {content}")
    return "\n".join(lines)


def _build_task_prompt(
    *,
    team_space: Project,
    channel: Conversation,
    source_message: Message,
    context_messages: list[Message],
    additional_context: str,
) -> str:
    context_text = _format_message_context(context_messages)
    extra = additional_context.strip()[:MAX_EXTRA_CONTEXT_LEN]
    parts = [
        f"请基于 Team Space「{team_space.name}」频道「{channel.name}」里的这段讨论，直接处理用户这次问询或请求。",
        "",
        "默认上下文：",
        context_text,
    ]
    if extra:
        parts.extend(["", "用户补充上下文：", extra])
    parts.extend([
        "",
        "默认把它当作一次性问询：先给出结论、验证结果或下一步建议，不要自行判断为长期/追踪类任务。",
        "只有当用户明确要求持续跟进、跨步骤执行，或会产出团队资产时，才先拆解执行计划并在必要时请求确认。",
    ])
    prompt = "\n".join(parts).strip()
    return prompt[:MAX_TASK_PROMPT_LEN]


def create_agent_task_thread_from_channel_message(
    *,
    conversation_id: str,
    message_id: int,
    actor_user: Any,
    additional_context: str = "",
    agent_id: str | None = None,
) -> TeamSpaceTaskThread:
    """Create a Team Space ChatSession seeded from one channel message thread.

    The task thread belongs to the owning Team Space. The default prompt includes
    only the selected message and its direct replies, never unrelated channel
    history.
    """
    try:
        channel = Conversation.objects.get(pk=conversation_id, is_archived=False)
    except Conversation.DoesNotExist:
        raise ValueError("频道不存在")

    if channel.is_external:
        raise ExternalGroupCapabilityError("外部群不能发起 Agent 任务")

    team_space = get_conversation_team_space(channel)
    if not team_space:
        raise ValueError("只能从团队 Space 频道询问 Agent")

    actor_user_id = str(getattr(actor_user, "id", "") or "")
    if not actor_user_id or not is_team_space_conversation_user_active(channel, actor_user_id):
        raise PermissionError("无权访问该团队 Space 频道")

    try:
        source = Message.objects.get(pk=message_id, conversation=channel, is_deleted=False)
    except Message.DoesNotExist:
        raise ValueError("源消息不存在")

    replies = list(
        Message.objects.filter(
            conversation=channel,
            reply_to_id=source.id,
            is_deleted=False,
        ).order_by("id")[: MAX_MESSAGE_CONTEXT_ITEMS - 1]
    )
    context_messages = [source, *replies]
    prompt = _build_task_prompt(
        team_space=team_space,
        channel=channel,
        source_message=source,
        context_messages=context_messages,
        additional_context=additional_context,
    )
    title_seed = (source.content or channel.name or "Agent 任务").strip().replace("\n", " ")
    title = f"来自 {channel.name}：{title_seed[:60]}"[:255]

    # Project 是协作场；ChatSession 必须挂成员自己的执行 Workspace。
    execution_workspace = resolve_project_execution_workspace(
        project=team_space,
        user=actor_user,
    )
    if execution_workspace is None:
        execution_workspace = (
            Workspace.objects.filter(
                organization_id=team_space.organization_id,
                created_by_id=actor_user.id,
            )
            .order_by("kind", "-created_at")
            .first()
        )
    if execution_workspace is None:
        raise ValueError("无法定位执行现场，请先在电脑端绑定本地工作区")

    try:
        agent_uuid = UUID(str(agent_id or ""))
    except (TypeError, ValueError, AttributeError):
        raise ValueError("请先选择一个 Agent")
    agent = Agent.objects.filter(
        id=agent_uuid,
        organization_id=team_space.organization_id,
        owner_user_id=actor_user.id,
        is_active=True,
    ).first()
    if agent is None:
        raise PermissionError("Agent 不存在、已停用或不属于当前用户")

    with transaction.atomic(using=postgres_app_db_alias()):
        session = ChatSession.objects.create(
            user=actor_user,
            organization_id=str(team_space.organization_id),
            workspace=execution_workspace,
            project=team_space,
            agent=agent,
            title=title,
        )
        try:
            from apps.chat.conversation.models import ChatContext

            context, _ = ChatContext.objects.get_or_create(session=session)
            # Project 是协作归属，不能再伪装成 current_space_id 的资源宿主。
            context.current_project = team_space
            context.save(update_fields=["current_project", "updated_at"])
        except Exception:
            logger.warning(
                "Failed to attach ChatContext for Team Space task session: session=%s space=%s",
                session.id,
                team_space.id,
                exc_info=True,
            )

    return TeamSpaceTaskThread(
        session=session,
        prompt=prompt,
        source_message_ids=[message.id for message in context_messages],
    )
