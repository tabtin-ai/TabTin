"""
chat.cancel handler — 通过 WS 取消正在执行的 Agent 任务。

与 HTTP ``external-agent/cancel`` 端点功能对齐，但走 WS 通道，
与 chat.send_message / localrt.user_response 保持一致的上行协议。

上行 payload::

    {
        "session_id": "<uuid>",
        "task_id":    "<prompt_xxx>"   # 可选（ 按 thread 取消）
    }

#3406 按 thread 取消：``task_id`` 改为可选。取消的权威身份是 session
（→ ``effective_thread_id``）；设备端按 envelope 顶层 thread_id 命中当前
run（``resolveAbortSessionKeys``），前端停止不再依赖缓存 task_id。
同时对该 thread 最近的 ExecutionRun 写 durable cancel marker
（``RunService.request_cancel``）——设备离线时 run 状态也能最终收敛，
且 runtime 每轮迭代的 cancel 检查可拾取。

下行 ACK::

    chat.cancel.ok   payload = { "published": <int>, "withdraw_applied"?: <bool> }
    chat.cancel.nak  payload = { "error_code": "...", "error_message": "..." }

#9614：``withdraw_unanswered=true`` 且带 ``client_message_id`` 时，服务端当场
物理删除未答轮次；``withdraw_applied`` 仅在该路径出现于 ok / agent.stream.done。
"""

from __future__ import annotations

import logging
from typing import Any, Dict

from channels.db import database_sync_to_async

from ..protocol import (
    ERROR_PERMISSION_DENIED,
    ERROR_SCHEMA_INVALID,
    build_envelope,
    new_event_id,
)
from ..bus import publish_ws_event_async

logger = logging.getLogger(__name__)

CHAT_CANCEL_OK = "chat.cancel.ok"
CHAT_CANCEL_NAK = "chat.cancel.nak"


def _resolve_cancel_session_sync(session_id: str, user):
    """校验用户对 session 的访问权限，返回 session 或 None。

    Pre-existing bug 修复：``_get_session_with_shared_access`` 返回 ``(session, is_shared)``
    元组，老代码直接 ``return`` 没有 unpack——下游 ``if not session:`` 把 ``(None, False)``
    元组当 truthy 通过校验，又走到 ``getattr(session, 'workspace', None)`` 时拿元组取属性
    必为 None，最终给前端误判为"该会话没有 space"。

    ：ChatSession.space FK 已 Drop；下游读 ``session.workspace``（PromptForward
    入参仍叫 space=）。本函数不做 select_related——handler 用 getattr 取已加载属性即可。
    """
    from apps.chat.conversation.models import ChatSession
    from apps.chat.conversation.api._common import _get_session_with_shared_access

    session = ChatSession.objects.select_related("workspace").filter(
        id=session_id, user=user,
    ).first()
    if session:
        return session
    # ：cancel 是副作用动作——session-share grantee 只读 + shared-chat 发言，
    # 不得取消 owner 正在跑的 turn；workspace 共享成员保持原行为。
    session, _is_shared = _get_session_with_shared_access(
        session_id, user, include_session_share=False,
    )
    return session


_resolve_cancel_session = database_sync_to_async(_resolve_cancel_session_sync)


def create_chat_cancel_handler(consumer):
    """Handle chat.cancel from frontend: forward cancel to Daemon."""

    async def handle_chat_cancel(envelope: Dict[str, Any]) -> None:
        request_id = envelope["request_id"]
        payload = dict(envelope["payload"])

        if consumer.role not in ("electron", "mobile", "admin", "web"):
            await consumer._send_error(
                request_id, ERROR_PERMISSION_DENIED, "role not allowed",
            )
            return

        session_id = payload.get("session_id")
        #  按 thread 取消：task_id 可选（普通 chat stop 前端没有 task_id）。
        task_id = payload.get("task_id") or None
        withdraw_unanswered = payload.get("withdraw_unanswered") is True
        client_message_id = payload.get("client_message_id") or None
        target_content = payload.get("target_content")

        if not session_id:
            nak = build_envelope(
                CHAT_CANCEL_NAK, request_id,
                {
                    "error_code": "schema_invalid",
                    "error_message": "missing session_id in payload",
                },
            )
            await consumer._send_envelope(nak)
            return

        try:
            session = await _resolve_cancel_session(session_id, consumer.user)
        except Exception:
            logger.exception(
                "[chat.cancel] session lookup failed: session=%s user=%s",
                session_id, getattr(consumer, "user_id", "?"),
            )
            nak = build_envelope(
                CHAT_CANCEL_NAK, request_id,
                {"error_code": "internal_error", "error_message": "session lookup failed"},
            )
            await consumer._send_envelope(nak)
            return

        if not session:
            nak = build_envelope(
                CHAT_CANCEL_NAK, request_id,
                {"error_code": "not_found", "error_message": "session not found or access denied"},
            )
            await consumer._send_envelope(nak)
            return

        # ：读 workspace；PromptForwardService 入参名仍为 space=。
        space = getattr(session, "workspace", None)
        if space is None:
            nak = build_envelope(
                CHAT_CANCEL_NAK, request_id,
                {"error_code": "no_space", "error_message": "session has no space"},
            )
            await consumer._send_envelope(nak)
            return

        try:
            from asgiref.sync import sync_to_async
            from apps.services.agent_engine.services.prompt_forward_service import PromptForwardService

            service = PromptForwardService()
            published = await sync_to_async(
                lambda: service.forward_cancel(
                    thread_id=session.effective_thread_id,
                    task_id=task_id,
                    space=space,
                    # ChatSession 的执行者字段在  收敛为 ``agent`` / ``agent_id``；
                    # ``execution_agent_id`` 属于其它运行时上下文，不能从会话读取。
                    agent_id=str(session.agent_id) if session.agent_id else None,
                    withdraw_unanswered=withdraw_unanswered,
                    client_message_id=client_message_id,
                    target_content=target_content if isinstance(target_content, str) else None,
                    session_id=str(session.id),
                    target_device_fingerprint=(
                        session.target_device_installation_id
                        if isinstance(session.target_device_installation_id, str)
                        and session.target_device_installation_id
                        else None
                    ),
                ),
                thread_sensitive=False,
            )()
        except Exception:
            logger.exception(
                "[chat.cancel] forward_cancel failed: session=%s task=%s",
                session_id, task_id,
            )
            nak = build_envelope(
                CHAT_CANCEL_NAK, request_id,
                {"error_code": "cancel_failed", "error_message": "failed to forward cancel request"},
            )
            await consumer._send_envelope(nak)
            return

        # ：未答轮次撤回——服务端当场权威删除（不依赖执行机）。
        # 在 forward 之后、ack 之前完成，保证 ack / done 里的 withdraw_applied 权威。
        # 复判拒绝时仍按普通 cancel 收口，不 NAK。
        withdraw_applied: bool | None = None
        if withdraw_unanswered and client_message_id:
            try:
                from apps.chat.conversation.services.withdraw_unanswered import (
                    withdraw_unanswered_messages,
                )

                withdraw_source = (
                    "mobile_cancel" if consumer.role == "mobile" else "electron_runtime"
                )

                def _apply_withdraw() -> dict:
                    return withdraw_unanswered_messages(
                        session=session,
                        client_message_id=str(client_message_id),
                        actor=consumer.user,
                        source=withdraw_source,
                    )

                withdraw_result = await sync_to_async(
                    _apply_withdraw,
                    thread_sensitive=False,
                )()
                withdraw_applied = bool(withdraw_result.get("withdraw_applied"))
                logger.info(
                    "[chat.cancel] withdraw_unanswered session=%s client=%s applied=%s "
                    "deleted=%s reason=%s",
                    session_id,
                    client_message_id,
                    withdraw_applied,
                    withdraw_result.get("deleted_count"),
                    withdraw_result.get("reason"),
                )
            except Exception:
                # fail-soft：删除失败不阻断 cancel ACK（abort 已转发）；客户端走 reconcile。
                withdraw_applied = False
                logger.exception(
                    "[chat.cancel] withdraw_unanswered failed (non-critical): "
                    "session=%s client=%s",
                    session_id, client_message_id,
                )

        # Cancel 立即终止并清除暂停；否则同一 Session 下一条消息会被 paused guard 拒绝。
        try:
            from apps.chat.conversation.models import ChatSession

            await database_sync_to_async(
                lambda: ChatSession.objects.filter(pk=session.pk).update(is_paused=False),
                thread_sensitive=True,
            )()
        except Exception:
            logger.warning(
                "[chat.cancel] failed to clear paused state: session=%s",
                session_id,
                exc_info=True,
            )

        #  durable cancel marker：对该 thread 最近的 ExecutionRun 写
        # Redis+DB cancel 标记（与 Tracker cancel_run 同口径）。forward 只覆盖
        # 「设备在线且命中」的即时路径；设备离线（published=0）/ 命中失败时，
        # marker 保证在线 host 的 runtime 侧迭代检查可拾取；如果没有 host 收到
        # cancel 控制帧，下面会在服务端兜底收口为 interrupted，避免永久 busy。
        # fail-soft：marker 写失败不影响 cancel ACK（forward 已尽力）。
        try:
            from apps.services.agent_engine.services.run_service import RunService
            from apps.services.agent_engine.services.session_run_state_service import (
                ACTIVE_STATUSES,
                SessionRunStateService,
            )

            def _mark_latest_run_cancelled() -> str | None:
                latest_run = RunService.get_latest_run(session.effective_thread_id)
                if latest_run is None or latest_run.status not in ACTIVE_STATUSES:
                    return None
                run_id = str(latest_run.run_id)
                RunService.request_cancel(run_id, reason="chat_cancel")
                SessionRunStateService.transition(
                    run_id=run_id,
                    status="cancelling",
                    stop_reason="chat_cancel",
                )
                SessionRunStateService.cancel_queued_after(run_id=run_id)
                return run_id

            current_run_id = await sync_to_async(
                _mark_latest_run_cancelled,
                thread_sensitive=False,
            )()
        except Exception:
            current_run_id = None
            logger.warning(
                "[chat.cancel] cancel marker write failed (non-critical): session=%s",
                session_id, exc_info=True,
            )

        # 向观察端广播控制面镜像，便于立即收口流式 UI。它只表示取消请求已发出，
        # 不是 runtime 已停止的确认，因此不能据此把权威投影推进到终态；
        # projection 保持 cancelling，直到 relay 收到真实 runtime terminal。
        cancel_terminal_payload = {
            "session_id": str(session.id),
            "task_id": task_id,
            "run_id": current_run_id,
            "source_client_event_id": client_message_id,
            "stop_reason": "aborted",
            "error": True,
            "error_class": "ABORT",
            "error_message": "Run aborted by user.",
            "suggested_action": "retry_later",
            "cancel_control": True,
            "withdraw_unanswered": withdraw_unanswered,
        }
        # ：仅撤回路径附加可选字段；老 cancel payload 不加。
        if withdraw_applied is not None:
            cancel_terminal_payload["withdraw_applied"] = withdraw_applied
        cancel_terminal_payload = {
            key: value for key, value in cancel_terminal_payload.items()
            if value is not None
        }
        cancel_terminal = build_envelope(
            "agent.stream.done",
            new_event_id(),
            cancel_terminal_payload,
            thread_id=session.effective_thread_id,
            session_id=str(session.id),
        )
        cancel_synced = await publish_ws_event_async(
            f"agent.stream.{session.effective_thread_id}",
            cancel_terminal,
        )
        if not cancel_synced:
            logger.warning(
                "[chat.cancel] cancel terminal buffered but realtime broadcast skipped: session=%s",
                session_id,
            )

        if published == 0 and current_run_id:
            try:
                from apps.services.agent_engine.services.run_service import RunService
                from apps.services.agent_engine.services.session_run_state_service import (
                    ACTIVE_STATUSES,
                    SessionRunStateService,
                )

                def _terminal_if_still_active() -> None:
                    projection = SessionRunStateService.transition(
                        run_id=current_run_id,
                        status="interrupted",
                        stop_reason="aborted",
                        error_class="ABORT",
                        allowed_from=ACTIVE_STATUSES,
                    )
                    if projection is not None:
                        RunService.clear_cancelled(current_run_id)

                await sync_to_async(
                    _terminal_if_still_active,
                    thread_sensitive=False,
                )()
            except Exception:
                logger.warning(
                    "[chat.cancel] offline terminal fallback failed (non-critical): session=%s run=%s",
                    session_id,
                    current_run_id,
                    exc_info=True,
                )

        ok_payload: Dict[str, Any] = {"published": published}
        if withdraw_applied is not None:
            ok_payload["withdraw_applied"] = withdraw_applied
        ok = build_envelope(
            CHAT_CANCEL_OK, request_id,
            ok_payload,
        )
        await consumer._send_envelope(ok)

        logger.info(
            "[chat.cancel] session=%s task=%s published=%s withdraw_applied=%s",
            session_id, task_id, published, withdraw_applied,
        )

    return handle_chat_cancel
