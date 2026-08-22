"""会话协作式暂停 / 继续。

暂停不是取消：当前 LLM / 工具步骤可以安全结束，runtime 会在下一轮推理前挂起；
继续后沿同一个 Session 与 run 上下文恢复。持久化状态同时阻止新消息绕过暂停门。
"""

from __future__ import annotations

import logging
from typing import Any, Dict

from asgiref.sync import sync_to_async

from ..protocol import ERROR_PERMISSION_DENIED, build_envelope
from .chat_cancel import _resolve_cancel_session

logger = logging.getLogger(__name__)


def create_chat_pause_control_handler(consumer, *, paused: bool):
    action = "pause" if paused else "resume"
    ok_type = f"chat.{action}.ok"
    nak_type = f"chat.{action}.nak"

    async def _send_nak(request_id: str, error_code: str, error_message: str) -> None:
        await consumer._send_envelope(build_envelope(
            nak_type,
            request_id,
            {"error_code": error_code, "error_message": error_message},
        ))

    async def handle(envelope: Dict[str, Any]) -> None:
        request_id = envelope["request_id"]
        payload = dict(envelope["payload"])
        if consumer.role not in ("electron", "mobile", "admin", "web"):
            await consumer._send_error(request_id, ERROR_PERMISSION_DENIED, "role not allowed")
            return

        session_id = payload.get("session_id")
        if not session_id:
            await _send_nak(request_id, "schema_invalid", "missing session_id")
            return

        try:
            session = await _resolve_cancel_session(session_id, consumer.user)
        except Exception:
            logger.exception("[chat.%s] session lookup failed: %s", action, session_id)
            session = None
        if not session:
            await _send_nak(request_id, "not_found", "session not found or access denied")
            return

        def _load_workspace():
            from apps.chat.conversation.models import ChatSession

            return ChatSession.objects.select_related("workspace").get(pk=session.pk).workspace

        # PromptForwardService 入参仍叫 space=；实际传 Workspace 实体。
        space = await sync_to_async(_load_workspace, thread_sensitive=True)()
        if space is None:
            await _send_nak(request_id, "no_space", "session has no space")
            return

        try:
            from apps.services.agent_engine.services.prompt_forward_service import PromptForwardService

            published = await sync_to_async(
                lambda: PromptForwardService().forward_pause_control(
                    thread_id=session.effective_thread_id,
                    space=space,
                    paused=paused,
                    # ChatSession 的执行者字段在  收敛为 ``agent`` / ``agent_id``；
                    # ``execution_agent_id`` 属于其它运行时上下文，不能从会话读取。
                    agent_id=str(session.agent_id) if session.agent_id else None,
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
            logger.exception("[chat.%s] forward failed: %s", action, session_id)
            await _send_nak(request_id, f"{action}_failed", f"failed to {action} runtime")
            return

        if published <= 0:
            await _send_nak(
                request_id,
                "device_unreachable",
                f"no runtime accepted {action} request",
            )
            return

        def _persist_state() -> None:
            from apps.chat.conversation.models import ChatSession

            ChatSession.objects.filter(pk=session.pk).update(is_paused=paused)

        await sync_to_async(_persist_state, thread_sensitive=True)()
        # ：pause ACK 只表示请求已转发。run_state=paused 要等 runtime
        # 走到下一轮迭代边界，由 lifecycle.phase=paused 再投影。
        # resume 立刻放行 waiter，所以 ACK 后就可以标回 running。
        if not paused:
            from apps.services.agent_engine.services.session_run_state_service import (
                SessionRunStateService,
            )

            await sync_to_async(
                lambda: SessionRunStateService.transition_current(
                    session_id=str(session.id),
                    status="running",
                    allowed_from=frozenset({"paused"}),
                ),
                thread_sensitive=True,
            )()
        await consumer._send_envelope(build_envelope(
            ok_type,
            request_id,
            {"published": published, "is_paused": paused},
        ))

    return handle
