"""同账号跨端会话列表活动推送。

向 session owner 的 ``user.{user_id}`` 推送 ``chat.session.activity.updated``，
供其他在线端 upsert 列表行并按活动时间重排。不对组织其他成员广播；
不重开团队 ``session_created``。

契约字段（列表可见性）：
- ``message_count``：与列表 API 同口径的可见消息数（非模型列，推送时计算）
- ``has_messages``：``message_count > 0``，供客户端空草稿滤镜单点判断
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Optional

from django.db import transaction

from apps.services.common.ws.bus import publish_to_user
from apps.services.common.ws.protocol import build_envelope, new_event_id

logger = logging.getLogger(__name__)

ACTIVITY_EVENT = "chat.session.activity.updated"


def _iso_or_none(value: Optional[datetime]) -> Optional[str]:
    if value is None:
        return None
    return value.isoformat()


def _id_or_none(value: Any) -> Optional[str]:
    if value is None:
        return None
    return str(value)


def _annotated_message_count(session) -> Optional[int]:
    for attr in ("_total_message_count", "_visible_message_count"):
        value = getattr(session, attr, None)
        if isinstance(value, bool):
            continue
        if isinstance(value, int):
            return max(0, value)
    return None


def _count_visible_messages(session) -> Optional[int]:
    """真实 ChatSession 走列表同口径 COUNT；测试桩 / 非 ORM 返回 None。"""
    try:
        from apps.chat.conversation.api._common import _visible_message_count
        from apps.chat.conversation.models import ChatSession

        if not isinstance(session, ChatSession):
            return None
        return max(0, int(_visible_message_count(session)))
    except Exception:
        logger.debug(
            "session-activity visible message_count lookup failed session=%s",
            getattr(session, "id", None),
            exc_info=True,
        )
        return None


def _resolve_activity_message_count(session, *, reason: str) -> int:
    """解析 activity 的 message_count（权威优先，降级可测）。

    优先级：
    1. queryset annotate / 调用方预填
    2. ORM ``_visible_message_count``（与 GET sessions 同口径）
    3. 降级：``created``→0；``message`` 或已有 ``last_message_at``→至少 1
    """
    annotated = _annotated_message_count(session)
    if annotated is not None:
        return annotated

    counted = _count_visible_messages(session)
    if counted is not None:
        return counted

    if reason == "created":
        return 0
    if reason == "message" or getattr(session, "last_message_at", None):
        return 1

    raw = getattr(session, "message_count", None)
    if isinstance(raw, int) and not isinstance(raw, bool):
        return max(0, raw)
    return 0


def _resolve_activity_agent_face(session) -> tuple[Optional[str], Optional[str]]:
    """活动推送附带 Agent 脸：name + avatar（url 优先，否则 avatar_key）。

    与列表 ``_resolve_session_avatar`` 对齐；Agent 缺失时两者均为 None。
    """
    agent = getattr(session, "agent", None)
    if agent is None and getattr(session, "agent_id", None):
        try:
            from apps.tabtinspace.models import Agent

            agent = (
                Agent.objects.filter(pk=session.agent_id)
                .only("id", "name", "settings")
                .first()
            )
        except Exception:
            logger.debug(
                "session-activity agent face lookup failed session=%s",
                getattr(session, "id", None),
                exc_info=True,
            )
            agent = None
    if agent is None:
        return None, None
    name = (getattr(agent, "name", None) or "").strip() or None
    settings = getattr(agent, "settings", None)
    if isinstance(settings, dict):
        avatar_url = (settings.get("avatar_url") or "").strip()
        avatar_key = (settings.get("avatar_key") or "").strip()
        avatar = avatar_url or avatar_key or "general-assistant"
    else:
        avatar = "general-assistant"
    return name, avatar


def publish_session_activity(session, *, reason: str) -> None:
    """在事务提交后向 session owner 推送活动更新。

    Args:
        session: ``ChatSession`` 实例（需已具备 id / user_id 等字段）。
        reason: ``"created"`` | ``"message"`` | ``"agent_switched"``。
    """
    user_id = str(session.user_id) if getattr(session, "user_id", None) else ""
    if not user_id:
        logger.warning(
            "session-activity publish skipped: empty user_id (session=%s reason=%s)",
            getattr(session, "id", None),
            reason,
        )
        return

    from apps.chat.conversation.services.agent_mention_sessions import (
        session_is_agent_mention,
    )

    agent_name, agent_avatar = _resolve_activity_agent_face(session)
    message_count = _resolve_activity_message_count(session, reason=reason)
    has_messages = message_count > 0

    payload: dict[str, Any] = {
        "session_id": str(session.id),
        "organization_id": str(session.organization_id),
        "reason": reason,
        "is_agent_mention_session": session_is_agent_mention(session),
        "title": session.title or "",
        "status": session.status or "",
        "workspace_id": _id_or_none(getattr(session, "workspace_id", None)),
        "project_id": _id_or_none(getattr(session, "project_id", None)),
        "agent_id": _id_or_none(getattr(session, "agent_id", None)),
        # 列表脸跟执行 Agent：只推 agent_id 会让客户端保留旧头像（张冠李戴）。
        "agent_name": agent_name,
        "agent_avatar": agent_avatar,
        # 列表可见性契约：Electron 空草稿滤镜以 has_messages / message_count 为准。
        "message_count": message_count,
        "has_messages": has_messages,
        "last_message_at": _iso_or_none(getattr(session, "last_message_at", None)),
        "updated_at": _iso_or_none(getattr(session, "updated_at", None)),
        "created_at": _iso_or_none(getattr(session, "created_at", None)),
        "thread_id": getattr(session, "effective_thread_id", None) or None,
    }

    def publish() -> None:
        try:
            publish_to_user(
                user_id,
                build_envelope(ACTIVITY_EVENT, new_event_id(), payload),
            )
        except Exception:
            logger.warning(
                "session-activity publish failed session=%s reason=%s",
                session.id,
                reason,
                exc_info=True,
            )

    transaction.on_commit(publish)


__all__ = [
    "ACTIVITY_EVENT",
    "publish_session_activity",
]
