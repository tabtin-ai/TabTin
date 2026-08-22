"""移动端前台在线判定（在线抑制的事实源）。

规则：用户有「前台移动端」时不发系统推送——WS 实时事件已覆盖，推了反而打扰。

写入方（apps/services/common/ws/）：
  - auth 成功（role=mobile）→ mark（连上即视为前台）
  - 服务端心跳 tick（30s）→ 仅当 key 仍存在时续期（不复活已清除的前台态）
  - 客户端 app_state 帧：background → clear；foreground → mark

TTL 75s（心跳 30s × 2 + 余量）：客户端异常断连不发 background 帧时，
最迟 75s 后推送自动恢复。误差窗口是 P0 接受的精度（见  文档 §4.4）。
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

MOBILE_PRESENCE_TTL_SECONDS = 75


def _key(user_id: str) -> str:
    return f"push:mobile_fg:{user_id}"


def mark_mobile_foreground(user_id: str) -> None:
    if not user_id:
        return
    try:
        from django.core.cache import cache
        cache.set(_key(user_id), 1, timeout=MOBILE_PRESENCE_TTL_SECONDS)
    except Exception as exc:
        logger.debug("[Push] mark mobile presence failed user=%s: %s", user_id, exc)


def refresh_mobile_foreground(user_id: str) -> None:
    """心跳续期：key 已被 background 帧清除时不复活。"""
    if not user_id:
        return
    try:
        from django.core.cache import cache
        if cache.get(_key(user_id)) is not None:
            cache.set(_key(user_id), 1, timeout=MOBILE_PRESENCE_TTL_SECONDS)
    except Exception as exc:
        logger.debug("[Push] refresh mobile presence failed user=%s: %s", user_id, exc)


def clear_mobile_foreground(user_id: str) -> None:
    if not user_id:
        return
    try:
        from django.core.cache import cache
        cache.delete(_key(user_id))
    except Exception as exc:
        logger.debug("[Push] clear mobile presence failed user=%s: %s", user_id, exc)


def has_mobile_foreground(user_id: str) -> bool:
    """判定失败（Redis 抖动）时返回 False —— 宁可多推一条也别把人晾着。"""
    if not user_id:
        return False
    try:
        from django.core.cache import cache
        return cache.get(_key(user_id)) is not None
    except Exception as exc:
        logger.debug("[Push] presence check failed user=%s: %s", user_id, exc)
        return False
