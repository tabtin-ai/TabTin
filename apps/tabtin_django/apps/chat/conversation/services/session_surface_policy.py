"""ChatSession.primary_surface 映射与升格策略（纯函数 + 弱/强写入）。

脸枚举（wire）：chat | doc | browser | code
- 文档与表格合并为 doc
- Tracker 不进枚举
- 禁止标题 NLP；禁止发明未声明 surface
"""

from __future__ import annotations

import logging
from typing import Optional
from uuid import UUID

from apps.chat.conversation.models import ChatSession

logger = logging.getLogger(__name__)

PRIMARY_SURFACES = frozenset({'chat', 'doc', 'browser', 'code'})
DEFAULT_SURFACE = 'chat'

# current_app_type / client tool app_id → surface；未列出的类型不映射（保持 chat，不发明）。
_APP_TYPE_TO_SURFACE = {
    'tabdoc': 'doc',
    'tabdata': 'doc',
    'tabweb': 'browser',
    'browser': 'browser',
    'tabcode': 'code',
}

# ChangeLog.resource_type → surface；仅声明过的类型，slide/video/canvas/tracker 等忽略。
_RESOURCE_TYPE_TO_SURFACE = {
    'docs': 'doc',
    'doc': 'doc',
    'document': 'doc',
    'tabdoc': 'doc',
    'table': 'doc',
    'tabdata': 'doc',
    'file': 'code',
}


def normalize_surface(value: Optional[str]) -> str:
    """非法 / 空 / 未知 → chat（与客户端兜底一致）。"""
    if value is None:
        return DEFAULT_SURFACE
    raw = str(value).strip().lower()
    if raw in PRIMARY_SURFACES:
        return raw
    return DEFAULT_SURFACE


def app_type_to_surface(app_type: Optional[str]) -> Optional[str]:
    """可映射的 app_type / app_id → surface；不可映射返回 None（调用方勿写入）。"""
    if app_type is None:
        return None
    key = str(app_type).strip().lower()
    if not key:
        return None
    return _APP_TYPE_TO_SURFACE.get(key)


def resource_type_to_surface(resource_type: Optional[str]) -> Optional[str]:
    """ChangeLog / 产物 resource_type → surface；不可映射返回 None。"""
    if resource_type is None:
        return None
    key = str(resource_type).strip().lower()
    if not key:
        return None
    return _RESOURCE_TYPE_TO_SURFACE.get(key)


def promote_surface(current: Optional[str], evidence_surface: str) -> str:
    """强证据升格：最近一次合法非 chat 证据覆盖；chat 证据不降级。

    Phase C 工具/产物钩子复用此纯函数；本模块不发明 surface。
    """
    current_norm = normalize_surface(current)
    evidence = normalize_surface(evidence_surface)
    # normalize 会把未知压成 chat；若原始证据本就不在枚举内则忽略。
    raw = (evidence_surface or '').strip().lower()
    if raw not in PRIMARY_SURFACES:
        return current_norm
    if evidence == DEFAULT_SURFACE:
        return current_norm
    return evidence


def apply_weak_primary_surface_from_app_type(
    session: ChatSession,
    app_type: Optional[str],
) -> bool:
    """冷启动弱信号：仅当当前仍为 chat 且 app_type 可映射时写入。

    已是 doc/browser/code 时不覆盖（用户乱点 App 不改脸）。
    使用条件 update，不 bump updated_at，避免列表排序抖动。
    """
    mapped = app_type_to_surface(app_type)
    if mapped is None:
        return False
    current = normalize_surface(getattr(session, 'primary_surface', None))
    if current != DEFAULT_SURFACE:
        return False
    updated = ChatSession.objects.filter(
        pk=session.pk,
        primary_surface=DEFAULT_SURFACE,
    ).update(primary_surface=mapped)
    if updated:
        session.primary_surface = mapped
    return bool(updated)


def promote_session_primary_surface(
    session_id: Optional[str],
    evidence_surface: str,
) -> bool:
    """按强证据升格会话 primary_surface。

    - 非 chat 合法证据：覆盖为新值（最近强证据胜）
    - chat / 未知证据：不降级、不写入
    - session 不存在或 id 非法：静默 False（钩子路径不抛）
    - 使用 QuerySet.update，不 bump updated_at
    """
    if not session_id:
        return False
    sid = str(session_id).strip()
    if not sid:
        return False

    raw = (evidence_surface or '').strip().lower()
    if raw not in PRIMARY_SURFACES or raw == DEFAULT_SURFACE:
        return False

    try:
        UUID(sid)
    except (ValueError, TypeError, AttributeError):
        return False

    try:
        session = ChatSession.objects.filter(pk=sid).only('id', 'primary_surface').first()
    except Exception:
        logger.debug(
            'promote_session_primary_surface: lookup failed session_id=%s',
            sid,
            exc_info=True,
        )
        return False
    if session is None:
        return False

    current = normalize_surface(getattr(session, 'primary_surface', None))
    next_surface = promote_surface(current, raw)
    if next_surface == current:
        return False

    updated = ChatSession.objects.filter(pk=session.pk).update(primary_surface=next_surface)
    return bool(updated)


def promote_session_from_resource_type(
    session_id: Optional[str],
    resource_type: Optional[str],
) -> bool:
    """ChangeLog resource_type → promote；不可映射则跳过。"""
    mapped = resource_type_to_surface(resource_type)
    if mapped is None:
        return False
    return promote_session_primary_surface(session_id, mapped)


def promote_session_from_app_id(
    session_id: Optional[str],
    app_id: Optional[str],
) -> bool:
    """Client tool app_id → promote；不可映射则跳过。"""
    mapped = app_type_to_surface(app_id)
    if mapped is None:
        return False
    return promote_session_primary_surface(session_id, mapped)


def session_id_from_thread_id(thread_id: Optional[str]) -> Optional[str]:
    """从 chat-session-<uuid> thread_id 解析 ChatSession.id；其它前缀返回 None。"""
    if not thread_id:
        return None
    raw = str(thread_id).strip()
    prefix = 'chat-session-'
    if not raw.startswith(prefix):
        return None
    sid = raw[len(prefix):].strip()
    return sid or None
