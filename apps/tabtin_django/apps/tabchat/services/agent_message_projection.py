"""将群聊 @Agent 的可见文本投射到 TabChat 实时频道。"""

from __future__ import annotations

import logging
from typing import Any, Iterable

from django.core.cache import cache
from django.utils import timezone

from apps.agent.display_name import resolve_agent_display_name
from apps.agent.models import Agent
from apps.services.common.agent_protocol.constants import AgentStreamEvent
from apps.tabchat.models import AgentMentionJob, Message
from apps.tabchat.services.centrifugo_service import get_centrifugo_service

logger = logging.getLogger(__name__)

STREAM_EVENT_TYPE = "im.agent.message.stream"
FINAL_EVENT_TYPE = "im.agent.message.final"
ERROR_EVENT_TYPE = "im.agent.message.error"

_CACHE_PREFIX = "tabchat:agent-message-projection"
_CACHE_TTL_SECONDS = 60 * 30


def _context_key(thread_id: str) -> str:
    return f"{_CACHE_PREFIX}:thread:{thread_id}"


def _sequence_key(message_ref: str) -> str:
    return f"{_CACHE_PREFIX}:sequence:{message_ref}"


def _closed_key(message_ref: str) -> str:
    return f"{_CACHE_PREFIX}:closed:{message_ref}"


def _role_key(thread_id: str, message_id: str) -> str:
    return f"{_CACHE_PREFIX}:role:{thread_id}:{message_id}"


def _agent_avatar(agent: Agent) -> str:
    settings = agent.settings if isinstance(agent.settings, dict) else {}
    value = settings.get("avatar_url")
    return value.strip() if isinstance(value, str) else ""


def resolve_agent_identity(agent: Agent) -> dict[str, str]:
    return {
        "sender_id": str(agent.id),
        "sender_name": resolve_agent_display_name(agent),
        "sender_avatar": _agent_avatar(agent),
    }


def resolve_agent_session_ref(job: AgentMentionJob) -> str:
    """没有执行会话的轻量提示，使用 job UUID 保持稳定引用。"""
    return str(job.session_id or job.id)


def build_agent_message_metadata(
    job: AgentMentionJob,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        **(metadata or {}),
        "message_ref": str(job.id),
        "agent_session_ref": resolve_agent_session_ref(job),
        "source_message_id": str(job.source_message_id),
        "kind": "tabtin_ref",
    }


def ensure_agent_message_metadata(
    job: AgentMentionJob,
    message: Message,
) -> Message:
    metadata = build_agent_message_metadata(job, dict(message.metadata or {}))
    if metadata != message.metadata:
        Message.objects.filter(pk=message.pk).update(metadata=metadata)
        message.metadata = metadata
    return message


def register_agent_message_stream(
    *,
    thread_id: str,
    job: AgentMentionJob,
    conversation_id: str,
    agent: Agent,
) -> bool:
    """在调用 Agent runtime 前登记 thread 到群聊消息的投射关系。"""
    try:
        context = {
            "conversation_id": str(conversation_id),
            "message_ref": str(job.id),
            "agent_session_ref": resolve_agent_session_ref(job),
            **resolve_agent_identity(agent),
        }
        cache.set(_context_key(thread_id), context, timeout=_CACHE_TTL_SECONDS)
        cache.add(_sequence_key(str(job.id)), 0, timeout=_CACHE_TTL_SECONDS)
        return True
    except Exception:
        logger.exception(
            "[tabchat.ai] stream registration failed thread=%s job=%s",
            thread_id,
            job.id,
        )
        return False


def _short_event_type(raw_type: Any) -> str:
    value = str(raw_type or "")
    prefix = "agent.stream."
    return value[len(prefix):] if value.startswith(prefix) else value


def _remember_message_role(
    *,
    thread_id: str,
    payload: dict[str, Any],
    roles: dict[str, str],
) -> None:
    message_id = payload.get("message_id")
    role = payload.get("role")
    if not isinstance(message_id, str) or not message_id:
        return
    if not isinstance(role, str) or not role:
        return
    roles[message_id] = role
    cache.set(
        _role_key(thread_id, message_id),
        role,
        timeout=_CACHE_TTL_SECONDS,
    )


def _text_delta(
    *,
    thread_id: str,
    payload: dict[str, Any],
    roles: dict[str, str],
) -> str:
    if payload.get("subagent_run_id"):
        return ""
    message_id = payload.get("message_id")
    if not isinstance(message_id, str) or not message_id:
        return ""
    role = roles.get(message_id)
    if role is None:
        role = cache.get(_role_key(thread_id, message_id))
    if role != "assistant":
        return ""

    delta = payload.get("delta")
    if not isinstance(delta, dict):
        return ""
    delta_type = delta.get("type")
    if delta_type == "text_delta":
        value = delta.get("text")
    elif delta_type == "connector_text_delta":
        value = delta.get("connector_text")
    else:
        return ""
    return value if isinstance(value, str) else ""


def _next_stream_sequence(message_ref: str) -> int:
    key = _sequence_key(message_ref)
    cache.add(key, 0, timeout=_CACHE_TTL_SECONDS)
    try:
        return int(cache.incr(key))
    except ValueError:
        cache.set(key, 1, timeout=_CACHE_TTL_SECONDS)
        return 1


def project_agent_stream_events(
    thread_id: str,
    events: Iterable[dict[str, Any]],
) -> bool:
    """转发一个 runtime 批次中的 assistant 可见文本，忽略其它中间态。"""
    try:
        context = cache.get(_context_key(thread_id))
        if not isinstance(context, dict):
            return False
        message_ref = str(context.get("message_ref") or "")
        if not message_ref or cache.get(_closed_key(message_ref)):
            return False

        roles: dict[str, str] = {}
        chunks: list[str] = []
        for event in events:
            if not isinstance(event, dict):
                continue
            event_type = _short_event_type(event.get("type"))
            payload = event.get("payload")
            if not isinstance(payload, dict):
                payload = {}
            if event_type == AgentStreamEvent.MESSAGE_START:
                _remember_message_role(
                    thread_id=thread_id,
                    payload=payload,
                    roles=roles,
                )
                continue
            if event_type != AgentStreamEvent.CONTENT_BLOCK_DELTA:
                continue
            chunk = _text_delta(
                thread_id=thread_id,
                payload=payload,
                roles=roles,
            )
            if chunk:
                chunks.append(chunk)

        delta = "".join(chunks)
        if not delta:
            return False
        data = {
            "conversation_id": str(context["conversation_id"]),
            "message_ref": message_ref,
            "agent_session_ref": str(context["agent_session_ref"]),
            "sender_id": str(context["sender_id"]),
            "sender_name": str(context["sender_name"]),
            "sender_avatar": str(context["sender_avatar"]),
            "delta": delta,
            "stream_seq": _next_stream_sequence(message_ref),
            "created_at": timezone.now().isoformat(),
        }
        get_centrifugo_service().publish(
            f"chat:{data['conversation_id']}",
            {"type": STREAM_EVENT_TYPE, "data": data},
        )
        return True
    except Exception:
        logger.exception(
            "[tabchat.ai] stream projection failed thread=%s",
            thread_id,
        )
        return False


def project_agent_stream_event(
    thread_id: str,
    event_type: str,
    payload: dict[str, Any],
) -> bool:
    return project_agent_stream_events(
        thread_id,
        [{"type": event_type, "payload": payload}],
    )


def _load_agent(job: AgentMentionJob) -> Agent | None:
    return (
        Agent.objects.filter(
            id=job.agent_id,
            organization_id=job.organization_id,
        )
        .select_related("owner_user", "organization__owner")
        .first()
    )


def publish_agent_message_final(job: AgentMentionJob, message: Message | None = None) -> bool:
    """把 Agent 执行结果投射为实时预览；消息真相保存在 Django Message。"""
    try:
        agent = _load_agent(job)
        if agent is None:
            logger.warning("[tabchat.ai] final projection agent missing job=%s", job.id)
            return False
        identity = resolve_agent_identity(agent)
        message_ref = str(job.id)
        cache.set(_closed_key(message_ref), True, timeout=_CACHE_TTL_SECONDS)
        content = getattr(job, "final_content", "") or str(getattr(message, "content", ""))
        message_type = getattr(job, "final_message_type", 0) or int(getattr(message, "message_type", 1))
        metadata = dict(getattr(job, "final_metadata", None) or getattr(message, "metadata", None) or {})
        data = {
            "conversation_id": getattr(job, "conversation_ref", "") or str(job.conversation_id or ""),
            "message_ref": message_ref,
            "agent_session_ref": resolve_agent_session_ref(job),
            **identity,
            "content": content,
            "message_type": int(message_type),
            "metadata": metadata,
            "created_at": timezone.now().isoformat(),
        }
        get_centrifugo_service().publish(
            f"chat:{data['conversation_id']}",
            {"type": FINAL_EVENT_TYPE, "data": data},
        )
        return True
    except Exception:
        logger.exception("[tabchat.ai] final projection failed job=%s", job.id)
        return False


def publish_agent_message_error(job: AgentMentionJob) -> bool:
    try:
        agent = _load_agent(job)
        if agent is None:
            logger.warning("[tabchat.ai] error projection agent missing job=%s", job.id)
            return False
        message_ref = str(job.id)
        cache.set(_closed_key(message_ref), True, timeout=_CACHE_TTL_SECONDS)
        data = {
            "conversation_id": getattr(job, "conversation_ref", "") or str(job.conversation_id or ""),
            "message_ref": message_ref,
            "agent_session_ref": resolve_agent_session_ref(job),
            **resolve_agent_identity(agent),
        }
        get_centrifugo_service().publish(
            f"chat:{data['conversation_id']}",
            {"type": ERROR_EVENT_TYPE, "data": data},
        )
        return True
    except Exception:
        logger.exception("[tabchat.ai] error projection failed job=%s", job.id)
        return False
