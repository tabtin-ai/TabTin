"""
统一的 organization_id 解析服务 — 宪法 §2.2 第 5 点。

所有需要"从上下文推导 organization_id"的场景都应调用本模块，
不再自建 space→organization / agent→organization 的反查逻辑。

解析优先级（标准链路）：
1. payload_organization_id（请求 payload 中用户显式传入）
2. space_id → Space.organization_id
3. agent_id → Agent.organization_id
4. conversation_id / session_id → ChatSession → Space.organization_id
5. api_key_organization_id（API Key 绑定）
6. request 对象上的 _billing_organization_id / api_key_organization_id / HTTP header
7. fallback_to_personal=True → 用户的 personal organization
   fallback_to_personal=False → 返回 ""

W2-1c 已落地：fallback_to_personal 默认 False。
需要 fallback 的场景必须显式 opt-in 并注明原因。

用法：
    from apps.services.billing.organization_resolver import resolve_organization_id

    wt = resolve_organization_id(space_id=space_id)
    wt = resolve_organization_id_from_space(space_id)
    wt = resolve_organization_id_from_request(request)
    wt = get_personal_organization_id(user)
    wt = get_personal_organization_id_by_user_id(user_id_str)
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from django.core.cache import cache
from apps.services.common.db_router import postgres_app_db_alias

logger = logging.getLogger(__name__)

_PERSONAL_WT_CACHE_PREFIX = "billing:personal_wt:"
_PERSONAL_WT_CACHE_TTL = 300


# ─────────────────────────────────────────────────────────────────
# 核心：标准解析链路
# ─────────────────────────────────────────────────────────────────

def resolve_organization_id(
    *,
    payload_organization_id: str = "",
    space_id: str = "",
    agent_id: str = "",
    conversation_id: str = "",
    session_id: str = "",
    api_key_organization_id: str = "",
    user: Any = None,
    request: Any = None,
    fallback_to_personal: bool = False,
) -> str:
    """宪法 §2.2 第 5 点的标准解析链路。

    按优先级依次尝试，任一步成功即返回。每步独立 try/except，
    不因一步查询失败就跳到最后。

    Returns:
        organization_id 字符串。空字符串表示解析失败。
    """

    # ── 步骤 0: payload 显式传入（用户在请求体中声明的 organization_id）──
    if payload_organization_id:
        logger.debug(
            "[OrganizationResolver] resolved via payload: wt=%s",
            _short(payload_organization_id),
        )
        return payload_organization_id

    # ── 步骤 1: space_id → Space.organization_id ──
    if space_id:
        result = _resolve_from_space(space_id)
        if result:
            logger.debug(
                "[OrganizationResolver] resolved via space: space=%s → wt=%s",
                _short(space_id), _short(result),
            )
            return result
        logger.debug(
            "[OrganizationResolver] space lookup miss: space=%s", _short(space_id),
        )

    # ── 步骤 2: agent_id → Agent.organization_id ──
    if agent_id:
        result = _resolve_from_agent(agent_id)
        if result:
            logger.debug(
                "[OrganizationResolver] resolved via agent: agent=%s → wt=%s",
                _short(agent_id), _short(result),
            )
            return result
        logger.debug(
            "[OrganizationResolver] agent lookup miss: agent=%s", _short(agent_id),
        )

    # ── 步骤 3: conversation_id / session_id → ChatSession → Space ──
    sid = conversation_id or session_id
    if sid:
        result = _resolve_from_session(sid)
        if result:
            logger.debug(
                "[OrganizationResolver] resolved via session: session=%s → wt=%s",
                _short(sid), _short(result),
            )
            return result
        logger.debug(
            "[OrganizationResolver] session lookup miss: session=%s", _short(sid),
        )

    # ── 步骤 4: API Key 绑定的 organization_id ──
    if api_key_organization_id:
        logger.debug(
            "[OrganizationResolver] resolved via api_key: wt=%s",
            _short(api_key_organization_id),
        )
        return api_key_organization_id

    # ── 步骤 5: request 对象上的已解析值 / HTTP header ──
    if request is not None:
        result = _resolve_from_request_attrs(request)
        if result:
            return result

    # ── 步骤 6: fallback ──
    if not fallback_to_personal:
        logger.debug("[OrganizationResolver] all steps exhausted, no fallback")
        return ""

    resolved_user = _extract_user(user=user, request=request)
    if resolved_user is None:
        logger.debug("[OrganizationResolver] fallback skipped: no user context")
        return ""

    personal = get_personal_organization_id(resolved_user)
    if personal:
        logger.debug(
            "[OrganizationResolver] fallback to personal organization: wt=%s",
            _short(personal),
        )
    else:
        logger.warning(
            "[OrganizationResolver] personal organization not found for user=%s",
            _short(str(getattr(resolved_user, "id", "?"))),
        )
    return personal


# ─────────────────────────────────────────────────────────────────
# 便捷函数
# ─────────────────────────────────────────────────────────────────

def resolve_organization_id_from_space(space_id: str) -> Optional[str]:
    """从 space_id 反查 organization_id。失败返回 None。

    适用于只有 space_id 的场景（信号、后台任务等），
    不做 personal fallback，调用方自行决定空值处理。
    """
    if not space_id:
        return None
    return _resolve_from_space(space_id) or None


def resolve_organization_id_from_request(request: Any, fallback_to_personal: bool = False) -> str:
    """从 HTTP request 对象解析 organization_id。

    兼容 billing decorator 设置的 _billing_organization_id，
    API Key 鉴权设置的 api_key_organization_id，
    以及 HTTP header X-TabTin-Organization-Id。
    """
    result = _resolve_from_request_attrs(request)
    if result:
        return result

    if not fallback_to_personal:
        return ""

    user = _extract_user(request=request)
    if user is None:
        return ""
    return get_personal_organization_id(user)


def resolve_organization_id_from_session(session_id: str) -> Optional[str]:
    """从 session_id (conversation_id) 反查 organization_id。失败返回 None。"""
    if not session_id:
        return None
    return _resolve_from_session(session_id) or None


def resolve_organization_id_from_context_item_resource(
    resource_id: str,
    *,
    database: str | None = None,
) -> Optional[str]:
    """从 ContextItem.resource_id 反查所在 Space 的 organization_id。"""
    if not resource_id:
        return None
    if database is None:
        database = postgres_app_db_alias()
    try:
        from apps.tabtinspace.models import ContextItem

        ci = (
            ContextItem.objects.using(database)
            .filter(resource_id=str(resource_id))
            .select_related("workspace", "project")
            .first()
        )
        host = (ci.workspace or ci.project) if ci else None
        if host and host.organization_id:
            return str(host.organization_id)
    except Exception as exc:
        logger.debug(
            "[OrganizationResolver] context item lookup failed: resource=%s err=%s",
            _short(resource_id), exc,
        )
    return None


def get_personal_organization_id(user: Any) -> str:
    """获取用户的 personal organization id。带 Redis 缓存。

    Args:
        user: Django User 实例或任何有 .id 属性的对象。
    """
    user_id = str(getattr(user, "id", "") or "")
    if not user_id:
        return ""
    return get_personal_organization_id_by_user_id(user_id)


def get_personal_organization_id_by_user_id(user_id: str) -> str:
    """通过 user_id 字符串获取 personal organization_id。带 Redis 缓存。

    适用于调用方只有 user_id 字符串、没有 User 对象的场景。
    """
    if not user_id:
        return ""

    cache_key = f"{_PERSONAL_WT_CACHE_PREFIX}{user_id}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached if cached != "__none__" else ""

    try:
        from apps.tabtinspace.models import Organization

        personal_wt_id = (
            Organization.objects.using(postgres_app_db_alias())
            .filter(owner_id=user_id, type=Organization.OrganizationType.PERSONAL)
            .values_list("id", flat=True)
            .first()
        )
        if personal_wt_id:
            result = str(personal_wt_id)
            cache.set(cache_key, result, _PERSONAL_WT_CACHE_TTL)
            return result
        else:
            cache.set(cache_key, "__none__", _PERSONAL_WT_CACHE_TTL)
            return ""
    except Exception as exc:
        logger.warning(
            "[OrganizationResolver] personal organization query failed: user=%s err=%s",
            user_id[:8], exc,
        )
        return ""


def extract_user_id(request: Any) -> str:
    """从已认证的 request 中提取 user_id（向后兼容）。"""
    auth = getattr(request, "auth", None)
    if auth is not None:
        uid = getattr(auth, "id", None)
        if uid:
            return str(uid)
    return ""


# ─────────────────────────────────────────────────────────────────
# 内部实现
# ─────────────────────────────────────────────────────────────────

def _resolve_from_space(space_id: str) -> str:
    """space_id → Space.organization_id"""
    try:
        from apps.tabtinspace.services.host_resolver import host_organization_id
        wt = host_organization_id(space_id)
        return str(wt) if wt else ""
    except Exception as exc:
        logger.warning(
            "[OrganizationResolver] space→organization query failed: space=%s err=%s",
            _short(space_id), exc,
        )
        return ""


def _resolve_from_agent(agent_id: str) -> str:
    """agent_id → Agent.organization_id"""
    try:
        from apps.tabtinspace.models import Agent
        wt = (
            Agent.objects.using(postgres_app_db_alias())
            .filter(id=agent_id)
            .values_list("organization_id", flat=True)
            .first()
        )
        return str(wt) if wt else ""
    except Exception as exc:
        logger.warning(
            "[OrganizationResolver] agent→organization query failed: agent=%s err=%s",
            _short(agent_id), exc,
        )
        return ""


def _resolve_from_session(session_id: str) -> str:
    """session_id → ChatSession.organization_id（直接字段）或 → workspace → organization。

    ：ChatSession.space FK 已 Drop；无 organization_id 时按 workspace_id 反查。
    """
    try:
        from apps.chat.conversation.models import ChatSession

        row = (
            ChatSession.objects
            .filter(id=session_id)
            .values("organization_id", "workspace_id")
            .first()
        )
        if not row:
            return ""

        wt = row.get("organization_id")
        if wt:
            return str(wt)

        workspace_id = row.get("workspace_id")
        if workspace_id:
            return _resolve_from_space(str(workspace_id))
    except Exception as exc:
        logger.warning(
            "[OrganizationResolver] session→organization query failed: session=%s err=%s",
            _short(session_id), exc,
        )
    return ""


def _resolve_from_request_attrs(request: Any) -> str:
    """从 request 对象的属性和 HTTP header 中提取 organization_id。

    供 resolve_organization_id 步骤 5 和 resolve_organization_id_from_request 共用，
    消除重复逻辑。
    """
    billing_wt = getattr(request, "_billing_organization_id", "")
    if billing_wt:
        logger.debug(
            "[OrganizationResolver] resolved via request._billing_organization_id: wt=%s",
            _short(billing_wt),
        )
        return billing_wt

    api_key_wt = getattr(request, "api_key_organization_id", "")
    if api_key_wt:
        logger.debug(
            "[OrganizationResolver] resolved via request.api_key_organization_id: wt=%s",
            _short(api_key_wt),
        )
        return api_key_wt

    meta = getattr(request, "META", None)
    if meta:
        header_wt = str(meta.get("HTTP_X_TABTIN_ORGANIZATION_ID", "") or "").strip()
        if header_wt:
            logger.debug(
                "[OrganizationResolver] resolved via HTTP header: wt=%s",
                _short(header_wt),
            )
            return header_wt

    return ""


def _extract_user(*, user: Any = None, request: Any = None) -> Any:
    """从参数中提取 user 对象。"""
    if user is not None:
        return user
    if request is not None:
        auth = getattr(request, "auth", None)
        if auth is not None and getattr(auth, "id", None):
            return auth
    return None


def _short(s: str) -> str:
    """截断 UUID 用于日志显示。"""
    return s[:8] if len(s) > 8 else s
