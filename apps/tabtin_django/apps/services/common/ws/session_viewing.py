"""
Chat session viewing presence — Redis ZSET 原语。

C2S 事件 ``chat.session.presence`` 的存储层：记录「某用户的某 GUI 设备
正在前台看哪个 ChatSession」。供后续 HITL 通知门闩调用
``is_user_viewing_session`` 判断是否仍需投递收件箱。

Key: ``ws:session_viewing:{user_id}:{session_id}``
Member: 服务端生成的 WS connection id（Channels ``channel_name``）
Score: 最近刷新 Unix 秒
TTL: 90 秒（过期 member 在查询时剔除；key EXPIRE 为兜底）

Redis 异常时 ``is_user_viewing_session`` 返回 False（fail-open：仍发通知）。
"""

from __future__ import annotations

import logging
import time
from typing import Optional

from django_redis import get_redis_connection

logger = logging.getLogger(__name__)

SESSION_VIEWING_KEY_PREFIX = "ws:session_viewing:"
SESSION_VIEWING_TTL_SECONDS = 90


def session_viewing_key(user_id: str, session_id: str) -> str:
    return f"{SESSION_VIEWING_KEY_PREFIX}{user_id}:{session_id}"


def _truncate_id(value: Optional[str], n: int = 8) -> str:
    if not value:
        return "-"
    text = str(value)
    return text if len(text) <= n else text[:n]


def set_session_viewing(
    user_id: str,
    session_id: str,
    connection_id: str,
    *,
    device_fingerprint: Optional[str] = None,
) -> bool:
    """登记 / 续期：该服务端连接正在前台看 session。

    ``connection_id`` 必须由 GatewayConsumer 提供的服务端 ``channel_name``，
    不能使用客户端可伪造的 payload 值。返回值精确反映 Redis 写入是否完成。
    """
    if not user_id or not session_id or not connection_id:
        return False
    key = session_viewing_key(user_id, session_id)
    now = time.time()
    try:
        redis_client = get_redis_connection("default")
        pipe = redis_client.pipeline()
        pipe.zadd(key, {connection_id: now})
        pipe.expire(key, SESSION_VIEWING_TTL_SECONDS)
        results = pipe.execute()
        is_new_member = bool(results[0]) if results else False
        log = logger.info if is_new_member else logger.debug
        log(
            "[session_viewing] %s user=%s session=%s device=%s connection=%s",
            "enter" if is_new_member else "refresh",
            _truncate_id(user_id),
            _truncate_id(session_id),
            _truncate_id(device_fingerprint),
            _truncate_id(connection_id),
        )
        return True
    except Exception:
        logger.warning(
            "[session_viewing] set failed user=%s session=%s device=%s connection=%s",
            _truncate_id(user_id),
            _truncate_id(session_id),
            _truncate_id(device_fingerprint),
            _truncate_id(connection_id),
            exc_info=True,
        )
        return False


def clear_session_viewing(
    user_id: str,
    session_id: str,
    connection_id: str,
    *,
    device_fingerprint: Optional[str] = None,
) -> bool:
    """清除该服务端连接在 session 上的 presence member。

    ``ZREM`` 未命中仍是幂等的成功清理；仅 Redis 调用异常才返回 False。
    """
    if not user_id or not session_id or not connection_id:
        return False
    key = session_viewing_key(user_id, session_id)
    try:
        redis_client = get_redis_connection("default")
        removed = redis_client.zrem(key, connection_id)
        log = logger.info if removed else logger.debug
        log(
            "[session_viewing] %s user=%s session=%s device=%s connection=%s",
            "clear" if removed else "clear_noop",
            _truncate_id(user_id),
            _truncate_id(session_id),
            _truncate_id(device_fingerprint),
            _truncate_id(connection_id),
        )
        return True
    except Exception:
        logger.warning(
            "[session_viewing] clear failed user=%s session=%s device=%s connection=%s",
            _truncate_id(user_id),
            _truncate_id(session_id),
            _truncate_id(device_fingerprint),
            _truncate_id(connection_id),
            exc_info=True,
        )
        return False


def is_user_viewing_session(user_id: Optional[str], session_id: Optional[str]) -> bool:
    """同用户任一设备未过期 member → True；异常 / 缺参 / 过期 → False（fail-open）。"""
    if not user_id or not session_id:
        return False
    key = session_viewing_key(str(user_id), str(session_id))
    try:
        redis_client = get_redis_connection("default")
        cutoff = time.time() - SESSION_VIEWING_TTL_SECONDS
        redis_client.zremrangebyscore(key, "-inf", cutoff)
        return bool(redis_client.zcard(key) > 0)
    except Exception:
        logger.warning(
            "[session_viewing] is_viewing fail-open user=%s session=%s",
            _truncate_id(user_id),
            _truncate_id(session_id),
            exc_info=True,
        )
        return False
