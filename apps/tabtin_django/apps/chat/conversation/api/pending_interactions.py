"""Pending user interactions API.

实时 WS 事件不承担可靠恢复；移动端/桌面端在启动、前台恢复、重连和进入会话时
通过这些接口拉取仍需用户处理的 Agent 待办。
"""

from __future__ import annotations

from django.utils import timezone

from apps.services.agent_engine.models import PendingInteraction
from apps.services.agent_engine.services.pending_interaction_service import (
    cancel_pending_interactions_by_thread,
    list_pending_interactions_for_thread,
    list_pending_interactions_for_user,
    mark_interaction_resolved,
)
from apps.services.common.db_router import postgres_app_db_alias

from ._common import (
    _get_session_with_shared_access,
    error_response_with_status,
    jwt_auth,
    router,
    success_response,
)

RUNTIME_GONE_REASON = "runtime_gone"


@router.get("/pending-interactions", auth=jwt_auth, tags=["待处理交互"])
def get_pending_interactions(request, organization_id: str | None = None):
    interactions = list_pending_interactions_for_user(
        str(request.auth.id),
        organization_id=organization_id,
    )
    return success_response(data={"interactions": interactions})


@router.get("/sessions/{session_id}/pending-interactions", auth=jwt_auth, tags=["待处理交互"])
def get_session_pending_interactions(request, session_id: str):
    session, _is_shared = _get_session_with_shared_access(
        session_id, request.auth, include_session_share=True,
    )
    if not session:
        return error_response_with_status("NOT_FOUND", message="会话不存在", status_code=404)
    thread_id = session.thread_id or f"chat-session-{session.id}"
    interactions = list_pending_interactions_for_thread(str(request.auth.id), thread_id)
    return success_response(data={"interactions": interactions})


@router.post("/pending-interactions/{interaction_id}/dismiss", auth=jwt_auth, tags=["待处理交互"])
def dismiss_pending_interaction(request, interaction_id: str):
    db_alias = postgres_app_db_alias()
    interaction = (
        PendingInteraction.objects.using(db_alias)
        .filter(id=interaction_id, user_id=request.auth.id)
        .first()
    )
    if interaction is None:
        return error_response_with_status("NOT_FOUND", message="待处理事项不存在", status_code=404)
    if interaction.status == "pending":
        if not interaction.expires_at or interaction.expires_at > timezone.now():
            return error_response_with_status(
                "INTERACTION_STILL_PENDING",
                message="待处理事项仍有效，请提交处理或等待过期",
                status_code=409,
            )
        interaction = mark_interaction_resolved(
            kind=interaction.kind,
            thread_id=interaction.thread_id,
            request_key=interaction.request_key,
            status="expired",
            result={"reason": "dismissed_by_client"},
            publish=True,
        ) or interaction
    return success_response(data={"interaction_id": str(interaction.id), "status": interaction.status})


@router.post(
    "/sessions/{session_id}/pending-interactions/cancel-runtime",
    auth=jwt_auth,
    tags=["待处理交互"],
)
def cancel_session_pending_interactions_for_runtime(request, session_id: str):
    """#5526：执行设备 runtime 销毁时，取消该会话仍 pending 的 HITL。

    Electron / Daemon ``host.stop()`` 在清本机 waiter 前调用，把
    PendingInteraction + hitl_interaction 消息打成 ``cancelled``，避免重启后
    HitlMessageReconcile 恢复幽灵审批卡再触发 delivery_timeout。

    ``session_id`` 必须是 ChatSession raw UUID（非 ``chat-session-`` 前缀）。
    """
    # ：写路径（批量取消 HITL）——session-share grantee 只读，不放行。
    session, _is_shared = _get_session_with_shared_access(
        session_id, request.auth, include_session_share=False,
    )
    if not session:
        return error_response_with_status("NOT_FOUND", message="会话不存在", status_code=404)

    thread_id = session.thread_id or f"chat-session-{session.id}"
    cancelled = cancel_pending_interactions_by_thread(
        thread_id,
        reason=RUNTIME_GONE_REASON,
        publish=True,
    )
    return success_response(
        data={"cancelled": cancelled, "thread_id": thread_id, "reason": RUNTIME_GONE_REASON},
    )
