"""Agent 任务类通知落库（完成 / 出错 / 中断 / HITL / Tracker）。

供 relay_handler、pending_interaction_service、tracker_executor 调用。
任何失败只记日志，不阻断主流程。

metadata.navigate_to 供前端 notificationTargetResolver 直接消费，
打开对应会话并（可选）定位到 messageId。
"""

from __future__ import annotations

import logging
import re
from typing import Any, Iterable, Optional

from apps.services.notification.services.notification_service import (
    compact_notification_source_event_id,
)

logger = logging.getLogger(__name__)

AGENT_TASK_CATEGORY = "agent.task"
TRACKER_RUN_CATEGORY = "tracker.run"

# 铃铛主标题用一句话摘要；过长会变成半截回复。
_NOTIFICATION_SUMMARY_MAX = 80
_SENTENCE_END_RE = re.compile(r"(?<=[。！？!?；;])")
_MARKDOWN_BOLD_RE = re.compile(r"\*\*(.+?)\*\*")
_MARKDOWN_CODE_RE = re.compile(r"`([^`]+)`")
_MARKDOWN_HEADING_RE = re.compile(r"^#{1,6}\s+", re.MULTILINE)
_WHITESPACE_RE = re.compile(r"\s+")


def _safe_str(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    return text


def compact_agent_notification_summary(
    text: Any,
    *,
    max_len: int = _NOTIFICATION_SUMMARY_MAX,
) -> str:
    """从最终回复 / 错误文案提取通知用一句话（首行首句，非 LLM）。

    铃铛 typeLabel 已表达「任务已完成」等状态，摘要应是结果内容，
    而不是 DONE.content 硬截断 200 字。
    """
    cleaned = _safe_str(text)
    if not cleaned:
        return ""
    if max_len <= 1:
        return "…"

    # 代码块通常不是用户扫读重点；优先取 fence 前的自然语言。
    if "```" in cleaned:
        before_fence = cleaned.split("```", 1)[0].strip()
        if before_fence:
            cleaned = before_fence

    cleaned = _MARKDOWN_HEADING_RE.sub("", cleaned)
    cleaned = _MARKDOWN_BOLD_RE.sub(r"\1", cleaned)
    cleaned = _MARKDOWN_CODE_RE.sub(r"\1", cleaned)
    cleaned = cleaned.replace("\r\n", "\n").replace("\r", "\n")
    first_line = cleaned.split("\n", 1)[0].strip()
    first_line = _WHITESPACE_RE.sub(" ", first_line).strip()
    if not first_line:
        return ""

    # lookbehind split：首段已含句末标点，只取第一句。
    parts = _SENTENCE_END_RE.split(first_line, maxsplit=1)
    summary = (parts[0] if parts else first_line).strip() or first_line

    if len(summary) <= max_len:
        return summary
    return summary[: max_len - 1].rstrip() + "…"


def _is_uuid_like(value: str) -> bool:
    try:
        import uuid

        uuid.UUID(value)
        return True
    except (TypeError, ValueError, AttributeError):
        return False


def build_chat_session_navigate_to(
    *,
    session_id: str,
    workspace_id: str = "",
    project_id: str = "",
    organization_id: str = "",
    message_id: str = "",
) -> dict[str, Any]:
    target: dict[str, Any] = {
        "type": "chat-session",
        "id": _safe_str(session_id),
    }
    if workspace_id:
        target["workspaceId"] = _safe_str(workspace_id)
    if project_id:
        target["projectId"] = _safe_str(project_id)
    if organization_id:
        target["organizationId"] = _safe_str(organization_id)
    if message_id:
        target["messageId"] = _safe_str(message_id)
    return target


def build_tracker_navigate_to(
    *,
    tracker_id: str,
    space_id: str = "",
    organization_id: str = "",
    run_id: str = "",
) -> dict[str, Any]:
    target: dict[str, Any] = {
        "type": "tracker",
        "id": _safe_str(tracker_id),
    }
    if space_id:
        target["spaceId"] = _safe_str(space_id)
    if organization_id:
        target["organizationId"] = _safe_str(organization_id)
    if run_id:
        target["runId"] = _safe_str(run_id)
    return target


def _already_notified(user_id: str, source_event_id: str) -> bool:
    if not source_event_id:
        return False
    try:
        from apps.services.notification.models import Notification

        return Notification.objects.filter(
            user_id=user_id,
            source_event_id=source_event_id,
        ).exists()
    except Exception:
        logger.debug(
            "[AgentTaskNotify] dedupe lookup failed user=%s source=%s",
            user_id,
            source_event_id,
            exc_info=True,
        )
        return False


def _notify_user(
    *,
    user_id: str,
    type: str,
    title: str,
    body: str = "",
    organization_id: str = "",
    space_id: str = "",
    category: str = AGENT_TASK_CATEGORY,
    priority: str = "normal",
    source_event_id: str = "",
    navigate_to: Optional[dict[str, Any]] = None,
    extra_meta: Optional[dict[str, Any]] = None,
) -> None:
    uid = _safe_str(user_id)
    if not uid:
        return
    stored_source_event_id, raw_source_event_id = compact_notification_source_event_id(source_event_id)
    if stored_source_event_id and _already_notified(uid, stored_source_event_id):
        return

    try:
        from apps.services.notification.services.notification_service import (
            NotificationService,
        )

        metadata: dict[str, Any] = {
            **(extra_meta or {}),
            "category": category,
            "priority": priority,
            "space_id": _safe_str(space_id),
            "source_event_id": stored_source_event_id,
        }
        if raw_source_event_id != stored_source_event_id:
            metadata["original_source_event_id"] = raw_source_event_id
        if navigate_to:
            metadata["navigate_to"] = navigate_to

        NotificationService.notify(
            user_id=uid,
            type=type,
            title=title,
            body=body,
            metadata=metadata,
            organization_id=_safe_str(organization_id),
        )
    except Exception:
        logger.warning(
            "[AgentTaskNotify] notify failed type=%s user=%s",
            type,
            uid,
            exc_info=True,
        )


def resolve_chat_session_context(session_id: str) -> dict[str, str]:
    """查 ChatSession 拿明确的 Organization / Workspace / Project 与用户信息。"""
    sid = _safe_str(session_id)
    if not sid or not _is_uuid_like(sid):
        return {}
    try:
        from apps.chat.conversation.models import ChatSession

        session = (
            ChatSession.objects.filter(id=sid)
            .only(
                "id",
                "organization_id",
                "workspace_id",
                "project_id",
                "user_id",
                "title",
            )
            .first()
        )
        if not session:
            return {}
        context = {
            "session_id": sid,
            "organization_id": _safe_str(session.organization_id),
            "workspace_id": _safe_str(session.workspace_id),
            "project_id": _safe_str(session.project_id),
            "user_id": _safe_str(session.user_id),
            "title": _safe_str(getattr(session, "title", "") or ""),
        }
        # Tracker 每次运行都有独立 ChatSession。运行时的 DONE 也会触发通用
        # agent.task 通知；若把它当普通会话打开，移动端会进入无标题的运行
        # transcript，而用户实际要处理的是对应的 Tracker。这里从 Run ↔ Session
        # 关系恢复一等目标，避免要求客户端猜测会话标题或内部 metadata。
        try:
            from apps.tracker.models import TrackerRun

            tracker_run = (
                TrackerRun.objects.select_related("tracker")
                .filter(chat_session_id=sid)
                .order_by("-created_at")
                .first()
            )
            if tracker_run and getattr(tracker_run, "tracker_id", None):
                context["tracker_id"] = _safe_str(tracker_run.tracker_id)
                context["tracker_run_id"] = _safe_str(tracker_run.id)
        except Exception:
            logger.debug(
                "[AgentTaskNotify] resolve tracker target failed session=%s",
                sid,
                exc_info=True,
            )
        return context
    except Exception:
        logger.debug(
            "[AgentTaskNotify] resolve session failed session=%s",
            sid,
            exc_info=True,
        )
        return {}


def pick_last_assistant_message_id(
    message_ids: Iterable[dict[str, Any]] | None = None,
    *,
    session_id: str = "",
    trace_id: str = "",
) -> str:
    """优先用 relay ACK 的 message_ids，兜底按 trace 查最后一条 assistant。"""
    if message_ids:
        for item in reversed(list(message_ids)):
            if not isinstance(item, dict):
                continue
            server_id = _safe_str(item.get("server_id") or item.get("message_id"))
            if server_id:
                return server_id

    sid = _safe_str(session_id)
    tid = _safe_str(trace_id)
    if not sid or not _is_uuid_like(sid):
        return ""
    try:
        from apps.chat.conversation.models import ChatMessage

        qs = ChatMessage.objects.filter(session_id=sid, role="assistant")
        if tid and _is_uuid_like(tid):
            qs = qs.filter(trace_id=tid)
        msg = qs.order_by("-created_at").only("id").first()
        return _safe_str(msg.id) if msg else ""
    except Exception:
        logger.debug(
            "[AgentTaskNotify] lookup assistant message failed session=%s trace=%s",
            sid,
            tid,
            exc_info=True,
        )
        return ""


def notify_agent_task_terminal(
    *,
    session_id: str,
    phase: str,
    title: str,
    body: str = "",
    user_ids: Optional[Iterable[str]] = None,
    message_id: str = "",
    message_ids: Optional[Iterable[dict[str, Any]]] = None,
    trace_id: str = "",
    source_event_id: str = "",
) -> None:
    """Turn 终态落库：completed / error / interrupted。"""
    ctx = resolve_chat_session_context(session_id)
    if not ctx:
        return

    phase_norm = _safe_str(phase).lower()
    if phase_norm in {"cancelled", "canceled", "user_cancelled", "user_canceled"}:
        # 用户主动取消已知晓结果，不产生系统通知。
        return
    if phase_norm in ("end", "completed", "complete"):
        notif_type = "agent.task.completed"
        priority = "normal"
    elif phase_norm in ("error", "failed"):
        notif_type = "agent.task.error"
        priority = "high"
    elif phase_norm in ("interrupted", "cancelled", "terminated", "session_interrupted"):
        notif_type = "agent.task.interrupted"
        priority = "low"
    else:
        return

    recipients = [uid for uid in (_safe_str(u) for u in (user_ids or [])) if uid]
    if not recipients and ctx.get("user_id"):
        recipients = [ctx["user_id"]]
    if not recipients:
        return

    resolved_message_id = _safe_str(message_id) or pick_last_assistant_message_id(
        message_ids,
        session_id=ctx["session_id"],
        trace_id=trace_id,
    )
    tracker_id = _safe_str(ctx.get("tracker_id", ""))
    tracker_run_id = _safe_str(ctx.get("tracker_run_id", ""))
    navigate_to = (
        build_tracker_navigate_to(
            tracker_id=tracker_id,
            space_id=ctx.get("workspace_id", ""),
            organization_id=ctx.get("organization_id", ""),
            run_id=tracker_run_id,
        )
        if tracker_id
        else build_chat_session_navigate_to(
            session_id=ctx["session_id"],
            workspace_id=ctx.get("workspace_id", ""),
            project_id=ctx.get("project_id", ""),
            organization_id=ctx.get("organization_id", ""),
            message_id=resolved_message_id,
        )
    )
    event_id = _safe_str(source_event_id) or (
        f"{notif_type}:{ctx['session_id']}:{_safe_str(trace_id) or 'no-trace'}"
    )
    # title = 一句话摘要（或状态兜底）；body 空时回退会话标题作次要行。
    # 铃铛 typeLabel 已表达完成/出错，title 勿再写「Agent 任务完成」。
    resolved_title = _safe_str(title) or ctx.get("title") or ""
    resolved_body = _safe_str(body)
    if not resolved_body:
        session_title = ctx.get("title") or ""
        if session_title and session_title != resolved_title:
            resolved_body = session_title
    session_id = ctx["session_id"]
    session_trunc = session_id[:8]
    presence_checker = None
    try:
        from apps.services.common.ws.session_viewing import (
            is_user_viewing_session,
        )

        presence_checker = is_user_viewing_session
    except Exception as exc:
        logger.warning(
            "[AgentTaskNotify] terminal presence unavailable type=%s session=%s reason=%s",
            notif_type,
            session_trunc,
            type(exc).__name__,
        )

    for uid in recipients:
        if presence_checker is not None:
            try:
                viewing = presence_checker(uid, session_id)
            except Exception as exc:
                logger.warning(
                    "[AgentTaskNotify] terminal presence unavailable type=%s session=%s reason=%s",
                    notif_type,
                    session_trunc,
                    type(exc).__name__,
                )
                presence_checker = None
                viewing = False
            if viewing:
                logger.info(
                    "[AgentTaskNotify] terminal inbox suppressed type=%s session=%s uid=%s reason=viewing",
                    notif_type,
                    session_trunc,
                    uid,
                )
                continue
        extra_meta = {
            "session_id": ctx["session_id"],
            "message_id": resolved_message_id,
            "trace_id": _safe_str(trace_id),
            "workspace_id": ctx.get("workspace_id", ""),
            "project_id": ctx.get("project_id", ""),
        }
        if tracker_id:
            extra_meta.update(
                {
                    "notification_target": "tracker",
                    "tracker_id": tracker_id,
                    "run_id": tracker_run_id,
                }
            )
        _notify_user(
            user_id=uid,
            type=notif_type,
            title=resolved_title,
            body=resolved_body,
            organization_id=ctx.get("organization_id", ""),
            # Notification 表的列名仍是发布兼容壳；值明确写执行 Workspace。
            space_id=ctx.get("workspace_id", ""),
            category=AGENT_TASK_CATEGORY,
            priority=priority,
            source_event_id=f"{event_id}:{uid}",
            navigate_to=navigate_to,
            extra_meta=extra_meta,
        )


def notify_agent_hitl_waiting(
    *,
    interaction,
    title: str,
    body: str = "",
) -> None:
    """HITL 待确认落库。"""
    if interaction is None:
        return
    session_id = _safe_str(getattr(interaction, "session_id", "") or "")
    organization_id = _safe_str(getattr(interaction, "organization_id", "") or "")
    payload = getattr(interaction, "payload", None) or {}
    if not isinstance(payload, dict):
        payload = {}

    workspace_id = ""
    project_id = ""
    if session_id:
        ctx = resolve_chat_session_context(session_id)
        workspace_id = ctx.get("workspace_id", "")
        project_id = ctx.get("project_id", "")
        if not organization_id:
            organization_id = ctx.get("organization_id", "")

    message_id = _safe_str(
        payload.get("message_id")
        or payload.get("client_event_id")
        or ""
    )
    navigate_to = build_chat_session_navigate_to(
        session_id=session_id,
        workspace_id=workspace_id,
        project_id=project_id,
        organization_id=organization_id,
        message_id=message_id,
    ) if session_id else None

    request_key = _safe_str(getattr(interaction, "request_key", "") or "")
    interaction_id = _safe_str(getattr(interaction, "id", "") or "")
    source_event_id = f"agent.hitl.waiting:{interaction_id or request_key}"

    try:
        from apps.services.agent_engine.services.pending_interaction_service import (
            interaction_notify_user_ids,
        )

        recipients = interaction_notify_user_ids(interaction)
    except Exception:
        recipients = [_safe_str(getattr(interaction, "user_id", "") or "")]

    kind = _safe_str(getattr(interaction, "kind", "") or "")
    session_trunc = session_id[:8] if session_id else "-"
    presence_checker = None
    if session_id:
        try:
            from apps.services.common.ws.session_viewing import (
                is_user_viewing_session,
            )

            presence_checker = is_user_viewing_session
        except Exception as exc:
            logger.warning(
                "[AgentTaskNotify] hitl presence unavailable kind=%s session=%s reason=%s",
                kind,
                session_trunc,
                type(exc).__name__,
            )

    for uid in recipients:
        if not uid:
            continue
        if presence_checker is not None:
            try:
                viewing = presence_checker(uid, session_id)
            except Exception as exc:
                logger.warning(
                    "[AgentTaskNotify] hitl presence unavailable kind=%s session=%s reason=%s",
                    kind,
                    session_trunc,
                    type(exc).__name__,
                )
                presence_checker = None
                viewing = False
            if viewing:
                logger.info(
                    "[AgentTaskNotify] hitl inbox suppressed kind=%s session=%s uid=%s reason=viewing",
                    kind,
                    session_trunc,
                    uid,
                )
                continue
        _notify_user(
            user_id=uid,
            type="agent.hitl.waiting",
            title=title,
            body=body,
            organization_id=organization_id,
            # Notification 表的列名仍是发布兼容壳；值明确写执行 Workspace。
            space_id=workspace_id,
            category=AGENT_TASK_CATEGORY,
            priority="urgent",
            source_event_id=f"{source_event_id}:{uid}",
            navigate_to=navigate_to,
            extra_meta={
                "session_id": session_id,
                "message_id": message_id,
                "interaction_id": interaction_id,
                "request_key": request_key,
                "kind": kind,
                "workspace_id": workspace_id,
                "project_id": project_id,
            },
        )


def notify_tracker_run_terminal(
    *,
    tracker_run,
    success: bool,
    title: str,
    body: str = "",
) -> None:
    """Tracker run 完成/失败落库（与 WS TrackerNotificationService 并行）。"""
    if tracker_run is None:
        return
    tracker = getattr(tracker_run, "tracker", None)
    if tracker is None:
        return

    user_id = _safe_str(getattr(tracker, "created_by_id", None) or "")
    if not user_id:
        return

    tracker_id = _safe_str(getattr(tracker, "id", "") or "")
    run_id = _safe_str(getattr(tracker_run, "id", "") or "")
    space_id = _safe_str(getattr(tracker, "workspace_id", None) or "")
    organization_id = _safe_str(getattr(tracker, "organization_id", "") or "")
    session_id = _safe_str(getattr(tracker_run, "chat_session_id", "") or "")

    notif_type = "tracker.run.completed" if success else "tracker.run.failed"
    navigate_to = build_tracker_navigate_to(
        tracker_id=tracker_id,
        space_id=space_id,
        organization_id=organization_id,
        run_id=run_id,
    )
    # 若有关联会话，额外塞 session 信息供前端兜底
    extra: dict[str, Any] = {
        "tracker_id": tracker_id,
        "run_id": run_id,
        "skill_key": _safe_str(getattr(tracker, "skill_key", "") or ""),
        "tracker_name": _safe_str(getattr(tracker, "name", "") or ""),
    }
    if session_id:
        extra["session_id"] = session_id

    _notify_user(
        user_id=user_id,
        type=notif_type,
        title=title,
        body=body,
        organization_id=organization_id,
        space_id=space_id,
        category=TRACKER_RUN_CATEGORY,
        priority="normal" if success else "high",
        source_event_id=f"{notif_type}:{run_id}:{user_id}",
        navigate_to=navigate_to,
        extra_meta=extra,
    )
