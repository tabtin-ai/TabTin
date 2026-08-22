"""
subagent.cancel handler — 通过 WS 取消单个正在执行的子 Agent（W5-a）。

与整轮取消 ``chat.cancel`` 对称：``chat.cancel`` 停掉整个 turn（task_id 维度），
本 handler 只停掉一个子 Agent（child_id 维度）。两者走完全一致的上行协议
（role 校验 + ``_resolve_cancel_session`` session 访问权限 + space 校验 +
``PromptForwardService`` 转发到绑定设备），下行 envelope 不同：
``chat.cancel`` → ``agent.prompt.cancel {task_id}``；
``subagent.cancel`` → ``agent.subagent.cancel {child_id}``（daemon 接收端契约）。

上行 payload::

    {
        "session_id": "<uuid>",
        "child_id":   "<subagent_run_id>"
    }

下行 ACK::

    subagent.cancel.ok   payload = { "published": <int> }
    subagent.cancel.nak  payload = { "error_code": "...", "error_message": "..." }
"""

from __future__ import annotations

import logging
from typing import Any, Dict

from ..protocol import (
    ERROR_PERMISSION_DENIED,
    build_envelope,
)

# session 权限校验与 chat.cancel 共用同一份 SSoT（含历史 bug 修复说明，见
# chat_cancel.py）——避免两条取消路径的访问控制漂移。
from .chat_cancel import _resolve_cancel_session

logger = logging.getLogger(__name__)

SUBAGENT_CANCEL_OK = "subagent.cancel.ok"
SUBAGENT_CANCEL_NAK = "subagent.cancel.nak"


def create_subagent_cancel_handler(consumer):
    """Handle subagent.cancel from frontend: forward cancel to Daemon/Electron."""

    async def handle_subagent_cancel(envelope: Dict[str, Any]) -> None:
        request_id = envelope["request_id"]
        payload = dict(envelope["payload"])

        if consumer.role not in ("electron", "mobile", "admin", "web"):
            await consumer._send_error(
                request_id, ERROR_PERMISSION_DENIED, "role not allowed",
            )
            return

        session_id = payload.get("session_id")
        child_id = payload.get("child_id")

        if not session_id or not child_id:
            nak = build_envelope(
                SUBAGENT_CANCEL_NAK, request_id,
                {
                    "error_code": "schema_invalid",
                    "error_message": "missing session_id or child_id in payload",
                },
            )
            await consumer._send_envelope(nak)
            return

        try:
            session = await _resolve_cancel_session(session_id, consumer.user)
        except Exception:
            logger.exception(
                "[subagent.cancel] session lookup failed: session=%s user=%s",
                session_id, getattr(consumer, "user_id", "?"),
            )
            nak = build_envelope(
                SUBAGENT_CANCEL_NAK, request_id,
                {"error_code": "internal_error", "error_message": "session lookup failed"},
            )
            await consumer._send_envelope(nak)
            return

        if not session:
            nak = build_envelope(
                SUBAGENT_CANCEL_NAK, request_id,
                {"error_code": "not_found", "error_message": "session not found or access denied"},
            )
            await consumer._send_envelope(nak)
            return

        # ：读 workspace；PromptForwardService 入参名仍为 space=。
        space = getattr(session, "workspace", None)
        if space is None:
            nak = build_envelope(
                SUBAGENT_CANCEL_NAK, request_id,
                {"error_code": "no_space", "error_message": "session has no space"},
            )
            await consumer._send_envelope(nak)
            return

        try:
            from asgiref.sync import sync_to_async
            from apps.services.agent_engine.services.prompt_forward_service import PromptForwardService

            service = PromptForwardService()
            published = await sync_to_async(
                lambda: service.forward_subagent_cancel(
                    thread_id=session.effective_thread_id,
                    child_id=child_id,
                    space=space,
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
                "[subagent.cancel] forward_subagent_cancel failed: session=%s child=%s",
                session_id, child_id,
            )
            nak = build_envelope(
                SUBAGENT_CANCEL_NAK, request_id,
                {"error_code": "cancel_failed", "error_message": "failed to forward subagent cancel request"},
            )
            await consumer._send_envelope(nak)
            return

        ok = build_envelope(
            SUBAGENT_CANCEL_OK, request_id,
            {"published": published},
        )
        await consumer._send_envelope(ok)

        logger.info(
            "[subagent.cancel] session=%s child=%s published=%s",
            session_id, child_id, published,
        )

    return handle_subagent_cancel
