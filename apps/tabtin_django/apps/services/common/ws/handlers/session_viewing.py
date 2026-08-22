"""
chat.session.presence handler — GUI 客户端上报前台会话 presence。

上行 payload::

    { "session_id": "<uuid>" | null }

- 合法 uuid：该已认证 GUI 设备进入 / 续期该 session
- null：该连接离开当前 session

身份只来自 ``consumer.user_id`` / ``consumer.device_fingerprint``，
绝不信 payload 里的 user/device 字段。非 GUI role 拒绝。

下行::

    chat.session.presence.ok
    chat.session.presence.nak  { error_code, error_message }
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any, Dict, Optional

from channels.db import database_sync_to_async

from ..protocol import (
    ERROR_PERMISSION_DENIED,
    build_envelope,
)
from ..session_viewing import clear_session_viewing, set_session_viewing

logger = logging.getLogger(__name__)

CHAT_SESSION_PRESENCE = "chat.session.presence"
CHAT_SESSION_PRESENCE_OK = "chat.session.presence.ok"
CHAT_SESSION_PRESENCE_NAK = "chat.session.presence.nak"

_GUI_ROLES = frozenset({"electron", "mobile", "admin", "web"})


def _truncate_id(value: Optional[str], n: int = 8) -> str:
    if not value:
        return "-"
    text = str(value)
    return text if len(text) <= n else text[:n]


def _canonical_uuid(value: Any) -> Optional[str]:
    if not isinstance(value, str) or not value:
        return None
    try:
        return str(uuid.UUID(value))
    except (ValueError, AttributeError, TypeError):
        return None


def _resolve_presence_session_sync(session_id: str, user):
    """本人拥有或 shared/team-space 可访问的 ChatSession；否则 None。"""
    from apps.chat.conversation.api._common import _get_session_with_shared_access

    # 读路径：放行 SessionShare grantee（与 HTTP get_session / WS 订阅同口径）
    session, _is_shared = _get_session_with_shared_access(
        session_id, user, include_session_share=True,
    )
    return session


_resolve_presence_session = database_sync_to_async(_resolve_presence_session_sync)


async def cleanup_session_viewing_for_consumer(consumer) -> None:
    """Gateway disconnect：清掉当前连接登记的 presence（TTL 为兜底）。"""
    session_id = getattr(consumer, "_viewing_session_id", None)
    user_id = getattr(consumer, "user_id", None)
    device_fp = getattr(consumer, "device_fingerprint", None)
    connection_id = getattr(consumer, "channel_name", None)
    if not session_id or not user_id or not device_fp or not connection_id:
        return
    try:
        cleared = await asyncio.to_thread(
            clear_session_viewing,
            user_id,
            session_id,
            connection_id,
            device_fingerprint=device_fp,
        )
        if not cleared:
            logger.warning(
                "[chat.session.presence] disconnect clear failed user=%s session=%s "
                "device=%s connection=%s",
                _truncate_id(user_id),
                _truncate_id(session_id),
                _truncate_id(device_fp),
                _truncate_id(connection_id),
            )
        else:
            logger.info(
                "[chat.session.presence] disconnect leave user=%s session=%s "
                "device=%s connection=%s",
                _truncate_id(user_id),
                _truncate_id(session_id),
                _truncate_id(device_fp),
                _truncate_id(connection_id),
            )
    except Exception:
        logger.warning(
            "[chat.session.presence] disconnect clear failed user=%s session=%s "
            "device=%s connection=%s",
            _truncate_id(user_id),
            _truncate_id(session_id),
            _truncate_id(device_fp),
            _truncate_id(connection_id),
            exc_info=True,
        )
    finally:
        consumer._viewing_session_id = None


def create_session_viewing_handler(consumer):
    """Handle chat.session.presence from GUI clients."""

    async def handle_session_presence(envelope: Dict[str, Any]) -> None:
        request_id = envelope["request_id"]
        payload = envelope.get("payload") or {}

        if consumer.role not in _GUI_ROLES:
            await consumer._send_error(
                request_id, ERROR_PERMISSION_DENIED, "role not allowed",
            )
            return

        if not consumer.user_id or not consumer.device_fingerprint:
            await consumer._send_error(
                request_id, ERROR_PERMISSION_DENIED, "authenticated device required",
            )
            return

        if "session_id" not in payload:
            nak = build_envelope(
                CHAT_SESSION_PRESENCE_NAK,
                request_id,
                {
                    "error_code": "schema_invalid",
                    "error_message": "missing session_id in payload",
                },
            )
            await consumer._send_envelope(nak)
            return

        session_id = payload.get("session_id")
        user_id = consumer.user_id
        device_fp = consumer.device_fingerprint
        connection_id = getattr(consumer, "channel_name", None)

        if not connection_id:
            await consumer._send_error(
                request_id, ERROR_PERMISSION_DENIED, "authenticated connection required",
            )
            return

        # 离开：null
        if session_id is None:
            previous = getattr(consumer, "_viewing_session_id", None)
            if previous:
                cleared = await asyncio.to_thread(
                    clear_session_viewing,
                    user_id,
                    previous,
                    connection_id,
                    device_fingerprint=device_fp,
                )
                if not cleared:
                    await consumer._send_envelope(
                        build_envelope(
                            CHAT_SESSION_PRESENCE_NAK,
                            request_id,
                            {
                                "error_code": "presence_unavailable",
                                "error_message": "session presence temporarily unavailable",
                            },
                        ),
                    )
                    return
                logger.info(
                    "[chat.session.presence] leave user=%s session=%s device=%s connection=%s",
                    _truncate_id(user_id),
                    _truncate_id(previous),
                    _truncate_id(device_fp),
                    _truncate_id(connection_id),
                )
            consumer._viewing_session_id = None
            await consumer._send_envelope(
                build_envelope(CHAT_SESSION_PRESENCE_OK, request_id, {}),
            )
            return

        session_id = _canonical_uuid(session_id)
        if session_id is None:
            nak = build_envelope(
                CHAT_SESSION_PRESENCE_NAK,
                request_id,
                {
                    "error_code": "schema_invalid",
                    "error_message": "session_id must be a valid uuid or null",
                },
            )
            await consumer._send_envelope(nak)
            return

        try:
            session = await _resolve_presence_session(session_id, consumer.user)
        except Exception:
            logger.exception(
                "[chat.session.presence] session lookup failed user=%s session=%s",
                _truncate_id(user_id),
                _truncate_id(session_id),
            )
            nak = build_envelope(
                CHAT_SESSION_PRESENCE_NAK,
                request_id,
                {
                    "error_code": "internal_error",
                    "error_message": "session lookup failed",
                },
            )
            await consumer._send_envelope(nak)
            return

        if session is None:
            nak = build_envelope(
                CHAT_SESSION_PRESENCE_NAK,
                request_id,
                {
                    "error_code": "not_found",
                    "error_message": "session not found or access denied",
                },
            )
            await consumer._send_envelope(nak)
            return

        previous = getattr(consumer, "_viewing_session_id", None)
        if previous and previous != session_id:
            cleared = await asyncio.to_thread(
                clear_session_viewing,
                user_id,
                previous,
                connection_id,
                device_fingerprint=device_fp,
            )
            if not cleared:
                await consumer._send_envelope(
                    build_envelope(
                        CHAT_SESSION_PRESENCE_NAK,
                        request_id,
                        {
                            "error_code": "presence_unavailable",
                            "error_message": "session presence temporarily unavailable",
                        },
                    ),
                )
                return

        stored = await asyncio.to_thread(
            set_session_viewing,
            user_id,
            session_id,
            connection_id,
            device_fingerprint=device_fp,
        )
        if not stored:
            # 若切换时已成功清旧，内存状态也不能继续声称仍在看旧会话。
            if previous and previous != session_id:
                consumer._viewing_session_id = None
            await consumer._send_envelope(
                build_envelope(
                    CHAT_SESSION_PRESENCE_NAK,
                    request_id,
                    {
                        "error_code": "presence_unavailable",
                        "error_message": "session presence temporarily unavailable",
                    },
                ),
            )
            return

        consumer._viewing_session_id = session_id
        log = logger.debug if previous == session_id else logger.info
        log(
            "[chat.session.presence] %s user=%s session=%s device=%s connection=%s",
            "refresh" if previous == session_id else "enter",
            _truncate_id(user_id),
            _truncate_id(session_id),
            _truncate_id(device_fp),
            _truncate_id(connection_id),
        )
        await consumer._send_envelope(
            build_envelope(CHAT_SESSION_PRESENCE_OK, request_id, {}),
        )

    return handle_session_presence
