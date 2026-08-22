"""TrackerRun.chat_session 批量预加载 helper。

单库治理后 ``TrackerRun.chat_session`` 已从跨库 UUIDField 软引用恢复为同库物理 FK。
保留 ``attach_chat_sessions_to_goal_runs(runs)`` 后置批量调用风格（调用方无需改），
内部改成"批量 fetch ChatSession + 填 FK 关系缓存"——等价 select_related，避免列表 N+1。
"""

from __future__ import annotations

from typing import Iterable, TYPE_CHECKING

if TYPE_CHECKING:
    from apps.tracker.models import TrackerRun


__all__ = ["attach_chat_sessions_to_goal_runs"]


def attach_chat_sessions_to_goal_runs(runs: Iterable["TrackerRun"]) -> None:
    """批量预填 ``TrackerRun.chat_session`` 的 FK 关系缓存（幂等；调用前先 list 化）。"""
    runs_list = list(runs)
    if not runs_list:
        return
    from apps.chat.conversation.models import ChatSession

    field = runs_list[0]._meta.get_field("chat_session")
    wanted = {str(r.chat_session_id) for r in runs_list if r.chat_session_id}
    sessions = (
        {str(s.id): s for s in ChatSession.objects.filter(id__in=wanted)} if wanted else {}
    )
    for r in runs_list:
        raw = r.chat_session_id
        field.set_cached_value(r, sessions.get(str(raw)) if raw else None)
