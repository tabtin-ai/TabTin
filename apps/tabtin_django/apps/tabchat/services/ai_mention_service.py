"""TC-8 P3.2：群聊 @AI 唤起编排。

链路：被 @ 的 Agent → 临时 ChatSession（挂群聊绑定的 Workspace + _execution_agent_id）→
RemoteAgentDispatcher.send_message_sync（路由到该 Agent 的设备 runtime）→
取最终回复 → 以 Agent 身份写回 tabchat（走 MessageService.send_message）。

复用 Agent 执行链（与 Tracker skill_executor 同款），不重造 runtime。
无法回复（设备离线/绑定缺失或失效/派发失败）时以 Agent 身份在群里写一条错误提示。
普通群聊执行现场以 ConversationAgentWorkspace 绑定为准，不再猜主场。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from django.contrib.auth import get_user_model

from apps.tabchat.constants import (
    ConversationType,
    MessageType,
    SenderType,
    TABCHAT_MENTION_INVOKED_FROM,
)
from apps.tabchat.models import AgentMentionJob, Conversation, Message
from apps.tabchat.services.centrifugo_service import get_centrifugo_service
from apps.tabchat.services.conversation_access import ConversationAccessResolver
from apps.tabchat.services.im_outbox_service import IMOutboxService
from apps.tabchat.services.message_service import MAX_CONTENT_LENGTH, MessageService

User = get_user_model()
logger = logging.getLogger(__name__)

# 喂给 Agent 的群聊上下文条数（含被 @ 那条）
CONTEXT_MESSAGE_COUNT = 20
# @AI 回复超时（秒）；对话档，比 Tracker 长任务短
AI_REPLY_TIMEOUT_SECONDS = 300
MENTION_FAILED_REASON = "AI 未能完成回复"
DEVICE_OFFLINE_CATEGORY = "device_offline"


@dataclass(frozen=True)
class AgentMentionResult:
    content: str
    message_type: int = MessageType.TEXT
    metadata: dict | None = None


class AgentMentionInterrupted(RuntimeError):
    pass


# Team Space 频道 @Agent：命中以下模式视为「应升级为任务线程」，不在 IM 内全量执行。
_HEAVY_TASK_HINTS = (
    "写代码", "改代码", "实现功能", "开发", "部署", "重构", "写脚本", "写测试",
    "创建文档", "生成报告", "导出", "爬取", "抓取", "批量", "运行脚本",
    "修改文件", "删除文件", "安装", "编译", "写个程序", "做个网站", "写项目",
    "提交pr", "pull request", "写程序", "生成代码", "自动执行", "帮我做",
    "帮我写", "帮我改", "帮我实现", "帮我开发", "帮我部署",
)


def _classify_team_space_mention_intent(content: str) -> str:
    """轻量问答 vs 应升级为任务线程（启发式，避免在 IM 内静默跑长任务）。"""
    text = (content or "").strip()
    if len(text) >= 200:
        return "task"
    lowered = text.lower()
    for hint in _HEAVY_TASK_HINTS:
        if hint in text or hint in lowered:
            return "task"
    return "lightweight"


def _write_agent_error_message(
    *,
    job: AgentMentionJob,
    conv_id: str,
    agent_id: str,
    reason: str,
) -> AgentMentionResult | None:
    """无法回复时在群里写一条 Agent 错误提示。"""
    content = (reason or MENTION_FAILED_REASON).strip()[:MAX_CONTENT_LENGTH]
    if not content:
        content = MENTION_FAILED_REASON
    try:
        from apps.tabchat.services.agent_message_projection import (
            build_agent_message_metadata,
        )

        final_message = MessageService.send_message(
            conversation_id=conv_id,
            sender_id=str(agent_id),
            content=content,
            message_type=MessageType.TEXT,
            sender_type=SenderType.AGENT,
            metadata=build_agent_message_metadata(job, {"ai_reply": False, "ai_error": True}),
            client_request_id=f"agent-mention-error:{job.id}",
        )
    except Exception:
        logger.exception("[tabchat.ai] agent error write-back failed conv=%s", conv_id)
        return None
    return AgentMentionResult(
        content=content,
        metadata={
            "ai_reply": False,
            "ai_error": True,
            "tabtin_message_id": str(final_message.id),
        },
    )


def _notify_mention_error(sender_id: str, conv_id: str, agent_name: str, reason: str) -> None:
    """失败仅给 @ 的人推一条轻量提示（D5 默认：仅 @ 者可见），群里不留痕。"""
    try:
        data = {
            "conversation_id": conv_id,
            "agent_name": agent_name,
            "reason": reason,
        }
        conversation = Conversation.objects.filter(pk=conv_id).first()
        if conversation is not None:
            IMOutboxService.enqueue(
                organization_id=str(conversation.organization_id),
                event_type="im.ai.error",
                target_channels=[f"personal:{sender_id}"],
                data=data,
                conversation=conversation,
            )
        else:
            get_centrifugo_service().publish(
                f"personal:{sender_id}",
                {"type": "im.ai.error", "data": data},
            )
    except Exception:
        logger.exception("[tabchat.ai] error notify failed conv=%s", conv_id)


def notify_terminal_mention_error(job: AgentMentionJob) -> None:
    """仅在 mention job 重试耗尽后通知触发者。"""
    msg = Message.objects.filter(pk=job.source_message_id).first()
    sender_id = job.source_sender_id or (msg.sender_id if msg else "")
    conversation_ref = job.conversation_ref or str(job.conversation_id or "")
    if not sender_id or not conversation_ref:
        return
    from apps.tabtinspace.models import Agent

    agent = Agent.objects.filter(
        id=job.agent_id,
        organization_id=job.organization_id,
    ).first()
    if agent is None:
        return
    _notify_mention_error(
        sender_id,
        conversation_ref,
        agent.name,
        MENTION_FAILED_REASON,
    )


def _build_prompt(
    recent_messages: list,
    agent_name: str,
    *,
    referenced_message: tuple[str, str] | None = None,
    team_space_name: str | None = None,
    channel_name: str | None = None,
) -> str:
    """把群聊最近 N 条 + 被 @ 指令组装成 Agent prompt。

    recent_messages: 按时间正序（旧→新），含发送者展示名。
    """
    lines: list[str] = []
    for name, content in recent_messages:
        text = (content or "").strip()
        if not text:
            continue
        lines.append(f"{name}: {text}")
    context_block = "\n".join(lines) if lines else "（无更早消息）"
    reference_block = ""
    if referenced_message is not None:
        reference_name, reference_content = referenced_message
        reference_block = (
            "## 当前消息引用\n"
            f"{reference_name or '成员'}: {(reference_content or '').strip() or '消息内容不可用'}\n\n"
        )

    if team_space_name:
        location = f"Team Space「{team_space_name}」的频道「{channel_name or '未命名频道'}」"
        guidance = (
            "请把这次回复控制成频道里的轻量协作回复：先给结论或下一步建议，"
            "不要直接展开长任务执行。如果请求明显需要多步骤执行、查资料、改代码或产出文档，"
            "请提醒用户可以把这条消息交给 Agent 单独处理。"
        )
    else:
        location = "群聊"
        guidance = "请基于以上上下文，作为群成员回应被 @ 的请求，直接给出要发到群里的回复内容。"

    return (
        f"你是{location}中的成员「{agent_name}」。下面是最近的对话记录，"
        f"有人 @ 你请求协助。\n\n"
        f"{reference_block}"
        f"## 最近对话\n{context_block}\n\n"
        f"{guidance}"
        f"不要带「{agent_name}:」前缀。"
    )


def dispatch_agent_mention(job: AgentMentionJob) -> AgentMentionResult | None:
    """处理一次群聊 @AI（由幂等 AgentMentionJob 调用）。

    幂等/防御：消息不存在、非群聊、Agent 不是成员、Agent 不可用、发送者是
    Agent（防递归）均直接返回。执行中断会抛出
    ``AgentMentionInterrupted`` 交给任务层落取消终态；其余异常在本层兜底。
    """
    msg = Message.objects.filter(pk=job.source_message_id).first() if job.source_message_id else None
    if msg is None and not job.source_message_ref:
        logger.warning("[tabchat.ai] source message missing job=%s", job.id)
        return None
    agent_id = str(job.agent_id)

    # 防递归：Agent 自己发的消息不再触发
    if msg is not None and msg.sender_type == SenderType.AGENT:
        return

    conv = Conversation.objects.filter(pk=msg.conversation_id).first() if msg is not None else None
    if conv is not None and conv.type != ConversationType.GROUP:
        return None

    conv_id = job.conversation_ref or str(getattr(conv, "id", ""))
    organization_id = str(job.organization_id or getattr(conv, "organization_id", ""))
    if not conv_id or not organization_id:
        return None

    from apps.tabchat.utils import get_conversation_team_space
    from apps.tabtinspace.models import Project

    team_space = (
        Project.objects.filter(
            id=job.project_ref,
            organization_id=organization_id,
            is_archived=False,
            trashed_at__isnull=True,
        ).first()
        if job.project_ref
        else get_conversation_team_space(conv) if conv is not None else None
    )
    if conv is not None and not ConversationAccessResolver.can_agent_send(conv, agent_id):
        logger.info("[tabchat.ai] agent=%s not a member of conv=%s, skip", agent_id, conv_id)
        return None
    is_channel_execution_agent = team_space is not None

    from apps.tabtinspace.models import Agent, Workspace

    agent = (
        Agent.objects.filter(
            id=agent_id, organization_id=organization_id, type="bot", is_active=True
        )
        .select_related("owner_user")
        .first()
    )
    if not agent:
        logger.info("[tabchat.ai] agent=%s unavailable for conv=%s", agent_id, conv_id)
        return

    sender_user_id = job.source_sender_id or str(getattr(msg, "sender_id", ""))
    sender_user = User.objects.filter(id=sender_user_id).first()
    if not sender_user:
        logger.info("[tabchat.ai] trigger sender=%s not a user, skip", sender_user_id)
        return

    sender_user_id = str(sender_user.id)
    from apps.tabchat.utils import is_organization_member

    if job.source_message_seq is None and not is_organization_member(
        organization_id,
        sender_user_id,
    ):
        logger.warning(
            "[tabchat.ai] trigger sender left organization: conv=%s agent=%s sender=%s",
            conv_id,
            agent_id,
            sender_user_id,
        )
        return
    execution_user = (
        sender_user
        if is_channel_execution_agent
        else agent.owner_user
    )
    if execution_user is None or not is_organization_member(
        organization_id,
        str(execution_user.id),
    ):
        logger.warning(
            "[tabchat.ai] agent owner missing: conv=%s agent=%s",
            conv_id,
            agent_id,
        )
        return

    # 组装上下文（最近 N 条，正序）
    referenced_pair = None
    if job.context_messages:
        referenced_item = next(
            (
                item
                for item in job.context_messages
                if isinstance(item, dict) and item.get("is_referenced") is True
            ),
            None,
        )
        if referenced_item is not None:
            referenced_pair = (
                str(referenced_item.get("sender_name") or "成员"),
                str(referenced_item.get("content") or "消息内容不可用"),
            )
        recent_pairs = [
            (str(item.get("sender_name") or "成员"), str(item.get("content") or ""))
            for item in job.context_messages
            if isinstance(item, dict) and item.get("is_referenced") is not True
        ][-CONTEXT_MESSAGE_COUNT:]
    else:
        recent_qs = Message.objects.filter(conversation=conv, is_deleted=False).order_by("-id")[:CONTEXT_MESSAGE_COUNT]
        recent = list(recent_qs)
        recent.reverse()
        user_ids = {m.sender_id for m in recent if m.sender_type != SenderType.AGENT}
        agent_ids = {m.sender_id for m in recent if m.sender_type == SenderType.AGENT}
        name_map: dict[str, str] = {}
        for u in User.objects.filter(id__in=user_ids).values("id", "nickname", "username"):
            name_map[str(u["id"])] = u.get("nickname") or u.get("username") or "成员"
        for a in Agent.objects.filter(id__in=agent_ids).values("id", "name"):
            name_map[str(a["id"])] = a.get("name") or "AI"
        recent_pairs = [(name_map.get(str(item.sender_id), "成员"), item.content) for item in recent]
    source_content = job.source_content or str(getattr(msg, "content", ""))
    if team_space and _classify_team_space_mention_intent(source_content) == "task":
        reply = (
            "这类请求更适合交给 Agent 单独处理（有状态、审批和产物归档）。"
            "请点击这条消息旁的「询问 Agent」，源消息和回复会作为默认上下文带入。"
        )
        return AgentMentionResult(
            content=reply[:MAX_CONTENT_LENGTH],
            metadata={"ai_reply": True, "suggest_task_upgrade": True},
        )

    prompt = _build_prompt(
        recent_pairs,
        agent.name,
        referenced_message=referenced_pair,
        team_space_name=team_space.name if team_space else None,
        channel_name=job.conversation_name or str(getattr(conv, "name", "")),
    )

    from apps.chat.conversation.models import ChatContext, ChatSession

    session = (
        ChatSession.objects.filter(id=job.session_id, user=execution_user).first()
        if job.session_id
        else None
    )
    workspace = getattr(session, "workspace", None) if session else None
    if not is_channel_execution_agent:
        from apps.tabchat.services.conversation_agent_workspace_service import (
            DEVICE_OFFLINE_OR_UNAVAILABLE_REASON,
            REBIND_REQUIRED_REASON,
            is_execution_device_registered_to_owner,
            resolve_bound_workspace,
        )

        workspace = resolve_bound_workspace(
            conv_id,
            agent_id,
            owner_user_id=str(execution_user.id),
            organization_id=organization_id,
        )
        if workspace is None:
            logger.warning(
                "[tabchat.ai] bound workspace missing or stale: conv=%s agent=%s",
                conv_id,
                agent_id,
            )
            return _write_agent_error_message(
                job=job,
                conv_id=conv_id,
                agent_id=agent_id,
                reason=REBIND_REQUIRED_REASON,
            )
        if not is_execution_device_registered_to_owner(workspace, str(execution_user.id)):
            logger.info(
                "[tabchat.ai] execution device not registered to owner, write error: conv=%s agent=%s",
                conv_id,
                agent_id,
            )
            return _write_agent_error_message(
                job=job,
                conv_id=conv_id,
                agent_id=agent_id,
                reason=DEVICE_OFFLINE_OR_UNAVAILABLE_REASON,
            )
    elif workspace is None and team_space and team_space.execution_space_id:
        workspace = Workspace.objects.filter(
            id=team_space.execution_space_id,
            organization_id=organization_id,
        ).first()
    workspace_id = workspace.id if workspace else None
    if not workspace_id:
        logger.warning(
            "[tabchat.ai] workspace missing for conv=%s agent=%s organization=%s",
            conv_id,
            agent_id,
            organization_id,
        )
        return _write_agent_error_message(
            job=job,
            conv_id=conv_id,
            agent_id=agent_id,
            reason=MENTION_FAILED_REASON,
        )
    session_space_id = str(workspace_id)

    reply = ""
    error_reason = ""
    try:
        from apps.services.remote_agent import RemoteAgentDispatcher

        if session is None:
            session = ChatSession.objects.create(
                user=execution_user,
                organization_id=organization_id,
                workspace_id=session_space_id,
                project=team_space,
                agent_id=agent.id,
                title=f"[私信@{agent.name}]",
            )
            AgentMentionJob.objects.filter(id=job.id).update(session_id=session.id)
            job.session_id = session.id
        else:
            update_fields = []
            if str(session.workspace_id or "") != session_space_id:
                session.workspace_id = session_space_id
                update_fields.append("workspace")
            if str(session.agent_id or "") != str(agent.id):
                session.agent_id = agent.id
                update_fields.append("agent")
            if team_space and str(session.project_id or "") != str(team_space.id):
                session.project = team_space
                update_fields.append("project")
            if update_fields:
                update_fields.append("updated_at")
                session.save(update_fields=update_fields)
        context, _ = ChatContext.objects.get_or_create(
            session=session,
            defaults={
                # 执行现场在 session.workspace_id；这里不把 Workspace 塞进资源宿主。
                "current_space_id": "",
                "current_project_id": team_space.id if team_space else None,
                "context_data": {
                    "current_app_type": "tabchat",
                    "_invoked_from": TABCHAT_MENTION_INVOKED_FROM,
                    "team_space_channel_id": conv_id if team_space else None,
                    "team_space_id": str(team_space.id) if team_space else None,
                    "execution_space_id": session_space_id,
                },
            },
        )
        if team_space and context.current_project_id != team_space.id:
            context.current_project = team_space
            context.save(update_fields=["current_project", "updated_at"])
        app_context = {
            "current_space_id": "",
            "current_project_id": str(team_space.id) if team_space else None,
            "execution_space_id": session_space_id,
            "current_app_type": "tabchat",
            "_invoked_from": TABCHAT_MENTION_INVOKED_FROM,
            "team_space_channel_id": conv_id if team_space else None,
            "team_space_id": str(team_space.id) if team_space else None,
            "_execution_agent_id": str(agent_id),
            "_shared_chat_by": sender_user_id,
            "idempotency_key": job.billing_idempotency_key,
            "billing_idempotency_key": job.billing_idempotency_key,
            "runtime_timeout_seconds": AI_REPLY_TIMEOUT_SECONDS,
        }

        from apps.tabchat.services.agent_message_projection import (
            register_agent_message_stream,
        )

        register_agent_message_stream(
            thread_id=session.effective_thread_id,
            job=job,
            conversation_id=conv_id,
            agent=agent,
        )

        # ：preferred 须落在 chat catalog（与模型列表同口径），否则回落
        # 组织默认 / DEFAULT_LLM_MODEL / catalog 首项——禁止非空即透传 stale BYOK。
        from apps.services.agent_execution.model_resolver import resolve_execution_model_id

        execution_model_id = resolve_execution_model_id(
            preferred_model_id=getattr(agent, "preferred_model_id", None),
            organization_id=organization_id,
            user_id=str(execution_user.id),
            session=session,
        )

        result = RemoteAgentDispatcher.send_message_sync(
            session_id=str(session.id),
            user=execution_user,
            message=prompt,
            client_type="server",
            execution_profile="conversational",
            app_context=app_context,
            model_id=str(execution_model_id) if execution_model_id else None,
            client_message_id=str(job.id),
        ) or {}

        reply = (result.get("reply") or result.get("content") or "").strip()
        error_category = result.get("error_category")
        category = str(error_category or "").lower()
        if category in {"abort", "aborted", "cancelled"}:
            raise AgentMentionInterrupted(
                str(result.get("error_message") or "Agent mention was interrupted")
            )
        if error_category:
            from apps.tabchat.services.conversation_agent_workspace_service import (
                DEVICE_OFFLINE_OR_UNAVAILABLE_REASON,
            )

            if category == DEVICE_OFFLINE_CATEGORY:
                error_reason = reply or DEVICE_OFFLINE_OR_UNAVAILABLE_REASON
            else:
                error_reason = reply or MENTION_FAILED_REASON
    except AgentMentionInterrupted:
        raise
    except Exception:
        logger.exception("[tabchat.ai] dispatch failed conv=%s agent=%s", conv_id, agent_id)
        error_reason = MENTION_FAILED_REASON

    if error_reason:
        return _write_agent_error_message(
            job=job,
            conv_id=conv_id,
            agent_id=agent_id,
            reason=error_reason,
        )
    if not reply:
        return None

    logger.info("[tabchat.ai] agent=%s replied in conv=%s", agent_id, conv_id)
    try:
        from apps.tabchat.services.agent_message_projection import (
            build_agent_message_metadata,
        )

        final_message = MessageService.send_message(
            conversation_id=conv_id,
            sender_id=str(agent_id),
            content=reply[:MAX_CONTENT_LENGTH],
            message_type=MessageType.TEXT,
            sender_type=SenderType.AGENT,
            metadata=build_agent_message_metadata(job, {"ai_reply": True}),
            client_request_id=f"agent-mention-reply:{job.id}",
        )
    except Exception:
        logger.exception("[tabchat.ai] agent reply write-back failed conv=%s", conv_id)
        return None

    return AgentMentionResult(
        content=reply[:MAX_CONTENT_LENGTH],
        metadata={
            "ai_reply": True,
            "tabtin_message_id": str(final_message.id),
        },
    )
