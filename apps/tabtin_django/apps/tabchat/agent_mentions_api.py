"""Agent execution ingress for mentions carried by Django IM messages."""

from __future__ import annotations

import logging

from django.db import transaction
from ninja import Router

from apps.services.common.db_router import postgres_app_db_alias
from apps.tabchat.models import AgentMentionJob, Message
from apps.tabchat.schemas import (
    ApiResponse,
    CreateAgentMentionRequest,
)
from apps.tabchat.services.agent_message_reference import (
    AgentMentionContextSnapshot,
)
from apps.tabchat.services.im_conversation_route import (
    IMConversationRouteUnavailable,
    resolve_im_conversation,
)
from apps.tabtinspace.models import Agent
from apps.users.auth.api import jwt_auth

router = Router()
logger = logging.getLogger(__name__)


def _display_names(detail: dict) -> dict[tuple[str, str], str]:
    names: dict[tuple[str, str], str] = {}
    for member in detail.get("members", []):
        if not isinstance(member, dict):
            continue
        member_type = str(member.get("member_type") or "")
        member_id = member.get("agent_id" if member_type == "agent" else "user_id")
        if member_type not in {"user", "agent"} or not member_id:
            continue
        names[(member_type, str(member_id))] = str(
            member.get("nickname")
            or member.get("username")
            or member.get("name")
            or ("AI" if member_type == "agent" else "成员")
        )
    return names


def _job_context(
    snapshots: tuple[AgentMentionContextSnapshot, ...],
    detail: dict,
) -> list[dict[str, object]]:
    names = _display_names(detail)
    return [
        {
            "sender_name": names.get(
                (item.sender_type, item.sender_id),
                "AI" if item.sender_type == "agent" else "成员",
            ),
            "content": item.content,
            **({"is_referenced": True} if item.is_referenced else {}),
        }
        for item in snapshots
    ]


def _create_jobs(
    *,
    organization_id: str,
    conversation_ref: str,
    conversation_name: str,
    project_ref: str,
    message_ref: str,
    source_message_seq: int | None,
    source_sender_id: str,
    source_content: str,
    context: list[dict[str, object]],
    agent_ids: list[str],
) -> list[AgentMentionJob]:
    jobs: list[AgentMentionJob] = []
    db_alias = postgres_app_db_alias()
    with transaction.atomic(using=db_alias):
        for agent_id in agent_ids:
            job, _ = AgentMentionJob.objects.get_or_create(
                source_message_ref=message_ref,
                agent_id=agent_id,
                defaults={
                    "organization_id": organization_id,
                    "conversation_ref": conversation_ref,
                    "conversation_name": conversation_name,
                    "project_ref": project_ref,
                    "source_sender_id": source_sender_id,
                    "source_message_seq": source_message_seq,
                    "source_content": source_content,
                    "context_messages": context,
                    "billing_idempotency_key": (
                        f"tabchat:agent-mention:{message_ref}:{agent_id}"
                    ),
                },
            )
            jobs.append(job)

        def enqueue() -> None:
            from apps.tabchat.tasks import dispatch_agent_mention

            for job in jobs:
                if job.status == AgentMentionJob.Status.PENDING:
                    dispatch_agent_mention.apply_async(
                        args=[str(job.id)],
                        queue="tracker_agent",
                    )

        transaction.on_commit(enqueue, using=db_alias)

    return jobs


@router.post("", auth=jwt_auth, response=ApiResponse)
def create_agent_mentions(request, payload: CreateAgentMentionRequest):
    """Validate the IM reference, then enqueue the non-IM Agent execution."""
    try:
        detail = resolve_im_conversation(
            conversation_ref=payload.conversation_ref,
            user_id=str(request.auth.id),
        )
    except PermissionError as exc:
        return ApiResponse(success=False, code=403, message=str(exc))
    except ValueError as exc:
        return ApiResponse(success=False, code=400, message=str(exc))
    except IMConversationRouteUnavailable:
        return ApiResponse(success=False, code=503, message="IM 会话服务暂不可用")

    organization_id = str(detail.get("organization_id") or "")
    if not organization_id:
        return ApiResponse(success=False, code=503, message="IM 会话服务暂不可用")
    if int(detail.get("type") or 0) != 2:
        return ApiResponse(success=False, code=400, message="仅群聊支持 @Agent")

    requested_ids = list(dict.fromkeys(str(value) for value in payload.mentioned_agent_ids))
    member_agent_ids = {
        str(member.get("agent_id"))
        for member in detail.get("members", [])
        if isinstance(member, dict) and member.get("member_type") == "agent" and member.get("agent_id")
    }
    if not requested_ids or any(agent_id not in member_agent_ids for agent_id in requested_ids):
        return ApiResponse(success=False, code=403, message="Agent 不是会话成员")

    agent_by_id = {
        str(value.id): value
        for value in Agent.objects.filter(
            id__in=requested_ids,
            organization_id=organization_id,
            type="bot",
            is_active=True,
        )
    }
    active_agent_ids = set(agent_by_id)
    if any(agent_id not in active_agent_ids for agent_id in requested_ids):
        return ApiResponse(success=False, code=400, message="Agent 不可用")

    if payload.source_message_seq is None:
        requester_id = str(request.auth.id)
        if any(
            str(getattr(agent_by_id[agent_id], "owner_user_id", "") or "")
            != requester_id
            for agent_id in requested_ids
        ):
            return ApiResponse(
                success=False,
                code=403,
                message="旧版本仅支持 @ 自己的 Agent，请升级客户端",
            )
        source_content = payload.content
        context = [item.dict() for item in payload.context_messages[-20:]]
        if payload.referenced_message is not None:
            context.append({**payload.referenced_message.dict(), "is_referenced": True})
    else:
        source = (
            Message.objects.filter(
                conversation_id=payload.conversation_ref,
                seq=payload.source_message_seq,
                is_deleted=False,
            )
            .first()
        )
        if source is None:
            return ApiResponse(success=False, code=409, message="@Agent 消息校验失败")
        nearby = list(
            Message.objects.filter(
                conversation_id=payload.conversation_ref,
                seq__lte=payload.source_message_seq,
                is_deleted=False,
            ).order_by("-seq")[:21]
        )
        nearby.reverse()
        authoritative_context = tuple(
            AgentMentionContextSnapshot(
                sender_id=str(item.sender_id),
                sender_type=str(item.sender_type or "user"),
                content=str(item.content or ""),
                seq=int(item.seq),
                is_referenced=int(item.seq) == int(payload.source_message_seq)
                and str(item.id) == str(payload.message_ref),
            )
            for item in nearby
        )
        source_content = str(source.content or "")
        context = _job_context(authoritative_context, detail)

    jobs = _create_jobs(
        organization_id=organization_id,
        conversation_ref=payload.conversation_ref,
        conversation_name=str(detail.get("name") or ""),
        project_ref=str(detail.get("space_id") or ""),
        message_ref=payload.message_ref,
        source_message_seq=payload.source_message_seq,
        source_sender_id=str(request.auth.id),
        source_content=source_content,
        context=context,
        agent_ids=requested_ids,
    )

    return ApiResponse(data={"job_ids": [str(job.id) for job in jobs]})
