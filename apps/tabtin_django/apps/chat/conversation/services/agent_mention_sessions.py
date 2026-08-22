"""TabChat @Agent 内部执行会话分类器。

list 排除、会话 DTO ``is_agent_mention_session``、activity 推送共用本模块。
禁止用标题 ``[私信@…]`` 判断，也不在 ChatSession 上落专用列。
"""

from __future__ import annotations

from typing import Iterable


def fetch_tabchat_mention_context_session_ids(
    candidate_session_ids: list[str],
) -> set[str]:
    """``ChatContext._invoked_from=tabchat_mention`` 的会话（Job 尚未回填时的同口径）。"""
    from apps.chat.conversation.models import ChatContext
    from apps.tabchat.constants import TABCHAT_MENTION_INVOKED_FROM

    if not candidate_session_ids:
        return set()
    return {
        str(session_id)
        for session_id in ChatContext.objects.filter(
            session_id__in=candidate_session_ids,
            context_data__contains={"_invoked_from": TABCHAT_MENTION_INVOKED_FROM},
        ).values_list("session_id", flat=True)
        if session_id
    }


def fetch_agent_mention_session_ids(
    *,
    organization_id,
    candidate_session_ids: Iterable,
) -> set[str]:
    """指定组织下由 TabChat ``@Agent`` 生成的 ChatSession ID。

    ``AgentMentionJob.session_id`` ∪ ``ChatContext._invoked_from=tabchat_mention``。
    """
    from apps.services.common.db_router import postgres_app_db_alias
    from apps.tabchat.models import AgentMentionJob

    ids_list = [str(session_id) for session_id in candidate_session_ids if session_id]
    if not ids_list:
        return set()

    query = AgentMentionJob.objects.using(postgres_app_db_alias()).filter(
        organization_id=str(organization_id),
        session_id__isnull=False,
        session_id__in=ids_list,
    )
    job_ids = {
        str(session_id)
        for session_id in query.values_list("session_id", flat=True).distinct()
        if session_id
    }
    return job_ids | fetch_tabchat_mention_context_session_ids(ids_list)


def session_is_agent_mention(session) -> bool:
    """单会话是否为 TabChat @Agent 内部执行会话。非 ORM 桩返回 False。"""
    from apps.chat.conversation.models import ChatSession

    if not isinstance(session, ChatSession) or not getattr(session, "id", None):
        return False
    return str(session.id) in fetch_agent_mention_session_ids(
        organization_id=getattr(session, "organization_id", None),
        candidate_session_ids=[session.id],
    )
