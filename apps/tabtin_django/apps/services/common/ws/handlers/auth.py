"""
Auth handler — JWT + HMAC dual-path authentication.

Extracted from GatewayConsumer._handle_auth.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import asyncio
import time
from collections import OrderedDict
from typing import Any, Dict, Optional, Tuple

import jwt as _jwt
from asgiref.sync import sync_to_async
from channels.db import database_sync_to_async
from django.conf import settings
from django.contrib.auth import get_user_model

from apps.services.common.agent_protocol.namespace import ACTION_CAPABILITY, normalize_capabilities
from apps.tabtinspace.services.organization_service import OrganizationService
from apps.tabtinspace.services.device_control_guard import is_device_blocked
from apps.tabtinspace.services.daemon_token_service import is_daemon_token_revoked
from apps.users.auth.session_manager import SessionManager

from ..frame_reassembly import FRAME_FRAGMENT_TRANSPORT_CAPABILITY
from ..organization_context import OrganizationContext

from ..protocol import (
    CHANNEL_SAFE_PATTERN,
    CONNECTION_SCOPE_DEVICE,
    CONNECTION_SCOPE_SESSION,
    CONNECTION_SCOPE_USER,
    DomainEvent,
    ERROR_AUTH_INVALID,
    ERROR_AUTH_REQUIRED,
    ERROR_AUTH_TOKEN_EXPIRED,
    ERROR_CONNECTION_LIMIT,
    ERROR_INTERNAL,
    ERROR_PERMISSION_DENIED,
    ERROR_SCHEMA_INVALID,
    FINGERPRINT_SAFE,
    build_envelope,
    new_event_id,
    now_ts,
)
from ..metrics import (
    ws_auth_failures,
    ws_connections_opened,
    ws_connections_total,
)
from ..async_io import run_sync_io

_logger_security = logging.getLogger(__name__ + ".security")


def _record_auth_failure(consumer, reason: str, detail: str) -> None:
    """Increment auth failure metric and emit structured security log.

    G-028: ensures ws_auth_failures is actually called.
    G-045: emits a structured warning with IP, fingerprint, and reason.
    """
    ws_auth_failures.labels(reason=reason).inc()
    client_addr = consumer.scope.get("client", ("", 0))
    client_ip = client_addr[0] if client_addr else ""
    fingerprint = getattr(consumer, "device_fingerprint", None) or ""
    _logger_security.warning(
        "[Auth] authentication failed: reason=%s detail=%s ip=%s fingerprint=%s",
        reason, detail, client_ip, fingerprint,
    )
    try:
        from ..runtime_snapshot import record_event
        record_event(
            "auth_failed",
            connection_id=getattr(consumer, "_runtime_connection_id", ""),
            user_id=getattr(consumer, "user_id", "") or "",
            device_id=fingerprint,
            client_type=getattr(consumer, "role", "") or "",
            ip=client_ip,
            abnormal_reason=reason,
        )
    except Exception:
        logger.debug("[Auth] runtime auth_failed sample skipped", exc_info=True)


_ROLE_TO_SCOPE = {
    'daemon': CONNECTION_SCOPE_DEVICE,
    'device_runtime': CONNECTION_SCOPE_DEVICE,
    'electron': CONNECTION_SCOPE_SESSION,
    'web': CONNECTION_SCOPE_SESSION,
    'mobile': CONNECTION_SCOPE_USER,
    'admin': CONNECTION_SCOPE_USER,
    'channel': CONNECTION_SCOPE_SESSION,
    'backend': CONNECTION_SCOPE_SESSION,
    'open_api': CONNECTION_SCOPE_SESSION,
}

logger = logging.getLogger(__name__)
User = get_user_model()

_CHANNEL_TOKEN_MAX_AGE = 300  # 5 minutes

# G-012: capability whitelist per role — intersection is taken at auth time.
ROLE_CAPABILITY_WHITELIST: Dict[str, frozenset] = {
    'electron': frozenset({
        'context.sync', 'agent.stream', 'agent.action',
        'table.events', 'table.open', 'doc.events', 'share.events', 'slide.events',
        'scheduled.tasks', 'trace.stream',
        'docparse.events',
        'asr.stream', 'tts.stream', 'tracker.events',
        'ssh.stream', 'git.status', 'notifications',
        'extension.events',
        'billing.events',
        'session.collaboration',
        'device.capabilities.refresh',
    }),
    'web': frozenset({
        'context.sync', 'agent.stream',
        'table.events', 'table.open', 'doc.events', 'share.events', 'slide.events',
        'scheduled.tasks', 'trace.stream',
        'docparse.events',
        'tracker.events', 'notifications',
        'extension.events',
        'billing.events',
        'device.capabilities.refresh',
    }),
    'mobile': frozenset({
        'context.sync', 'agent.stream',
        'table.events', 'table.open', 'doc.events', 'share.events', 'slide.events',
        'trace.stream',
        'notifications',
        'billing.events',
        'device.capabilities.refresh',
    }),
    'admin': frozenset({
        'context.sync', 'agent.stream',
        'table.events', 'table.open', 'doc.events', 'share.events', 'slide.events',
        'scheduled.tasks', 'trace.stream',
        'docparse.events', 'tracker.events',
        'notifications', 'extension.events',
        'billing.events',
        'device.capabilities.refresh',
    }),
    'daemon': frozenset({
        'context.sync', 'agent.stream', 'agent.action',
        'table.events', 'table.open', 'doc.events', 'slide.events',
        'trace.stream',
        'asr.stream', 'tts.stream', 'ssh.stream',
        'git.status', 'extension.events', 'notifications',
    }),
    'device_runtime': frozenset({
        'context.sync', 'agent.stream', 'agent.action',
        'table.events', 'table.open', 'doc.events', 'slide.events',
        'trace.stream',
        'asr.stream', 'tts.stream', 'ssh.stream',
        'git.status', 'extension.events', 'notifications',
    }),
    'channel': frozenset({
        'channel.inbound', 'channel.outbound', 'channel.status',
        'agent.stream', 'notifications',
    }),
    'open_api': frozenset({
        'table.open', 'table.events', 'notifications',
    }),
    'backend': frozenset({
        'context.sync', 'agent.stream', 'agent.action',
        'table.events', 'table.open', 'doc.events', 'slide.events',
        'scheduled.tasks', 'trace.stream',
        'channel.inbound', 'channel.outbound', 'channel.status',
        'docparse.events',
        'asr.stream', 'tts.stream', 'tracker.events', 'ssh.stream',
        'git.status', 'notifications', 'extension.events',
        'billing.events',
    }),
}


def _verify_jwt_for_ws(token: str):
    """G-008: WS-specific JWT verification that distinguishes expired vs invalid.

    Returns (payload, error_reason):
    - (payload, None): valid token
    - (None, "expired"): signature valid but expired — client should refresh
    - (None, "invalid"): token is invalid/tampered
    """
    try:
        secret_key = settings.JWT_SECRET_KEY
        payload = _jwt.decode(token, secret_key, algorithms=['HS256'])
        return payload, None
    except _jwt.ExpiredSignatureError:
        return None, "expired"
    except _jwt.InvalidTokenError:
        return None, "invalid"


async def recheck_jwt_validity(consumer) -> bool:
    """RT-04: 心跳周期中重验 JWT 有效性，过期/吊销则断开。

    Returns True if token is still valid (or recheck not applicable).
    Returns False if token has expired or user has been deactivated.
    """
    token = getattr(consumer, '_ws_auth_token', None)
    if not token:
        return True

    payload, jwt_error = _verify_jwt_for_ws(token)
    if jwt_error:
        _logger_security.warning(
            "[Auth] JWT %s during active WS session, disconnecting user=%s",
            jwt_error, consumer.user_id,
        )
        return False

    # CD-002: 重验时检查 token_type，防止非法类型绕过初始认证后逃逸检测
    token_type = payload.get('token_type') if payload else None
    if token_type not in ('access', 'daemon'):
        _logger_security.warning(
            "[Auth] invalid token_type=%s during WS recheck, disconnecting user=%s",
            token_type, consumer.user_id,
        )
        return False

    if token_type == 'daemon':
        device_id = payload.get('device_id') if payload else None
        if device_id:
            blocked = await database_sync_to_async(is_device_blocked)(device_id)
            if blocked:
                _logger_security.warning(
                    "[Auth] blocked daemon device during active WS session, disconnecting user=%s device=%s",
                    consumer.user_id, device_id,
                )
                return False
        jti = payload.get('jti') if payload else None
        if jti:
            revoked = await database_sync_to_async(is_daemon_token_revoked)(jti)
            if revoked:
                _logger_security.warning(
                    "[Auth] daemon token revoked during active WS session, disconnecting user=%s jti=%s",
                    consumer.user_id, jti,
                )
                return False

    if consumer.user_id:
        try:
            user_active = await database_sync_to_async(
                lambda: User.objects.filter(id=consumer.user_id, is_active=True).exists()
            )()
            if not user_active:
                _logger_security.warning(
                    "[Auth] user deactivated during active WS session, disconnecting user=%s",
                    consumer.user_id,
                )
                return False
        except Exception:
            pass

    # RB-002: session 活跃性重验（与 HTTP 层 JWTAuth 对齐）
    # 登出/改密后 session 被失活，已有 WS 连接应在下次重验时被断开
    if token_type == 'access' and payload:
        session_key = payload.get('sid')
        if session_key:
            try:
                session = await database_sync_to_async(
                    SessionManager.validate_session
                )(session_key)
                if not session or str(session.user_id) != str(consumer.user_id):
                    _logger_security.warning(
                        "[Auth] session revoked/expired during active WS session, "
                        "disconnecting user=%s",
                        consumer.user_id,
                    )
                    return False
            except Exception as exc:
                logger.warning(
                    "[Auth] session recheck failed during active WS session: user=%s error=%s",
                    consumer.user_id,
                    exc,
                    exc_info=True,
                )

    return True


_USER_LEVEL_ROLES = frozenset({'electron', 'web', 'mobile', 'admin', 'backend'})
"""仅这些角色走"多 organization"语义，需要周期同步 membership。

daemon/device_runtime 固定绑定单个 Device.organization_id，不随 user membership 变；
channel/open_api 使用 HMAC/API token 单 organization 语义。它们跳过 membership sync。
"""

# Topic 直接内嵌 organization_id 的前缀列表（membership sync 时按字符串解析即可退订）。
# B 类 topic（含资源 ID、organization 归属需查 DB）不在此列 —— 这类 topic 在
# `organization.{wt_id}` group 被 leave 后，broadcast 路径自然切断，不会误投递。
_ORGANIZATION_TOPIC_PREFIXES_2 = frozenset({
    'tracker.events',
    'extension.events', 'billing.events',
})
_ORGANIZATION_TOPIC_PREFIXES_3 = frozenset({
    'context.sync.organization', 'device.capabilities.refresh',
})


def _extract_topic_organization_id(topic: str) -> Optional[str]:
    """从 topic 字符串中提取内嵌的 organization_id（若有）。

    仅对 A 类 topic（前缀.organization_id）返回值；B 类 topic（含资源 ID）返回 None。
    """
    parts = topic.split(".")
    if len(parts) < 3:
        return None
    prefix_2 = ".".join(parts[:2])
    if prefix_2 in _ORGANIZATION_TOPIC_PREFIXES_2:
        return parts[2]
    if len(parts) >= 4:
        prefix_3 = ".".join(parts[:3])
        if prefix_3 in _ORGANIZATION_TOPIC_PREFIXES_3:
            return parts[3]
    return None


_RESOURCE_ORGANIZATION_CACHE_MAX = 256
_RESOURCE_ORGANIZATION_CACHE_TTL = 300


def _get_or_init_resource_cache(consumer) -> "OrderedDict[str, Tuple[Optional[str], float]]":
    """Per-consumer LRU：topic → (organization_id, expires_at)。"""
    cache = getattr(consumer, '_resource_organization_cache', None)
    if cache is None:
        cache = OrderedDict()
        consumer._resource_organization_cache = cache
    return cache


def _resolve_b_class_organizations_sync(consumer, topics: list) -> Dict[str, Optional[str]]:
    """同步批量解析 B 类 topic 的 organization 归属。由 caller 用 database_sync_to_async 包装。

    每个 topic 先查 per-consumer LRU，miss 才通过对应 validator 的
    ``resolve_resource_organization`` 查 DB；结果（含 None）回填缓存。
    """
    from .subscription_validators import resolve_validator

    cache = _get_or_init_resource_cache(consumer)
    now = time.time()
    results: Dict[str, Optional[str]] = {}
    for topic in topics:
        entry = cache.get(topic)
        if entry and entry[1] > now:
            cache.move_to_end(topic)
            results[topic] = entry[0]
            continue
        validator = resolve_validator(topic)
        wt_id: Optional[str] = None
        if validator is not None and hasattr(validator, 'resolve_resource_organization'):
            try:
                wt_id = validator.resolve_resource_organization(topic)
            except Exception:
                logger.debug(
                    "[Auth] resolve_resource_organization raised for topic=%s", topic,
                    exc_info=True,
                )
                wt_id = None
        results[topic] = wt_id
        cache[topic] = (wt_id, now + _RESOURCE_ORGANIZATION_CACHE_TTL)
        cache.move_to_end(topic)
        while len(cache) > _RESOURCE_ORGANIZATION_CACHE_MAX:
            cache.popitem(last=False)
    return results


async def _prune_organization_subscriptions(consumer, removed_organization_ids: set) -> list:
    """退订 `consumer.subscriptions` 中归属于已移除 organization 的 **所有** topic。

    覆盖：
    - A 类：topic 字符串内嵌 organization_id（`_extract_topic_organization_id` 解析）
    - B 类：topic 含资源 ID，通过 validator.resolve_resource_organization 查 DB
      （带 per-consumer LRU，60s 周期不会造成热路径 DB 压力）

    返回实际退订的 topic 列表（供调用方发 channel_layer.group_discard）。
    注意：A 类 + B 类都会主动 leave group，因为 publish_ws_event 发到
    `topic.{topic}` group 而不是 `organization.{wt_id}` group，所以仅 leave
    organization.group **不足以切断事件流**。
    """
    a_class_remove: list = []
    b_class_candidates: list = []
    for topic in list(consumer.subscriptions):
        wt_id = _extract_topic_organization_id(topic)
        if wt_id is not None:
            if wt_id in removed_organization_ids:
                a_class_remove.append(topic)
        else:
            b_class_candidates.append(topic)

    b_class_results: Dict[str, Optional[str]] = {}
    if b_class_candidates:
        try:
            b_class_results = await database_sync_to_async(
                _resolve_b_class_organizations_sync,
            )(consumer, b_class_candidates)
        except Exception:
            logger.warning(
                "[Auth] B-class organization resolution failed during prune (user=%s)",
                getattr(consumer, 'user_id', None), exc_info=True,
            )
            b_class_results = {}

    b_class_remove = [
        topic for topic, wt_id in b_class_results.items()
        if wt_id and wt_id in removed_organization_ids
    ]

    to_remove = a_class_remove + b_class_remove
    for topic in to_remove:
        consumer.subscriptions.discard(topic)
    return to_remove


def _invalidate_consumer_caches(consumer) -> None:
    """membership 变化后清空 per-consumer 缓存（thread/resource）。

    - ``_thread_organization_cache``（per-consumer thread→organization 映射遗留缓存）：
      organization 变后若旧 thread 归属的 organization 被移除，缓存命中会产生 403 日志
      噪音；防御性清空（当前生产无 setter，保留清理以兼容历史 / 测试覆盖）。
    - ``_resource_organization_cache``（本模块持有）：topic→organization 映射，资源自身
      的 organization 归属虽不变，但清空可避免陈旧 cache 跨 membership 周期误用。
    """
    for attr in ("_thread_organization_cache", "_resource_organization_cache"):
        cache = getattr(consumer, attr, None)
        if cache is not None:
            try:
                cache.clear()
            except Exception:
                pass


def _select_new_primary(
    old_primary: Optional[str],
    new_all: set,
    preferred: Optional[str],
) -> Optional[str]:
    """primary_id 选择策略：
    1. 原 primary 仍在 new_all → 保留（避免 UI 跳变）
    2. 客户端 auth 时提供的 preferred hint 命中 → 使用
    3. 否则为 None，让客户端显式选择（避免跳到陌生 organization）
    """
    if old_primary and old_primary in new_all:
        return old_primary
    if preferred and preferred in new_all:
        return str(preferred)
    return None


async def sync_organization_membership(consumer) -> bool:
    """周期同步用户 organization membership，保证 WS 连接不需重连即可感知 join/leave。

    流程：
    1. 仅对 JWT 常规角色（``_USER_LEVEL_ROLES``）执行；daemon/channel/open_api 跳过
    2. 用 per-consumer ``_membership_lock`` 串行化
    3. 重新查询 DB 获得 ``new_all``，与 ``consumer.organization_ctx.all_ids`` 做 diff
    4. ``removed``：先 ``leave_group(organization.{wt_id})``，再退订 **所有** 归属
       removed 的 topic（A 类内嵌解析 + B 类 validator DB 查询，带 LRU）——
       因为 ``publish_ws_event`` 发到 ``topic.{topic}`` group，仅 leave organization
       group **不足以** 切断资源级事件流
    5. ``added``：``join_group(organization.{wt_id})``
    6. 原子替换 ``consumer.organization_ctx``；primary 保留 > preferred hint > None
    7. 清空 thread/resource LRU cache（避免陈旧命中导致 stale 判断）
    8. 若新集合为空 → 断开连接（与 auth 初始"无 organization 拒绝"对齐）
    9. 否则推送 ``organization.membership_changed`` 事件供客户端消费

    返回 True 表示本次有变化；False 表示无变化或角色不支持。
    DB 抖动时（``_OrganizationMembershipFetchError``）保持现状不动，下个周期重试。
    """
    if consumer.role not in _USER_LEVEL_ROLES or not consumer.user:
        return False

    # P1-NEW-1：per-consumer Lock 串行化。lock 延迟创建（避免 __init__ 时 event
    # loop 未就绪）；`asyncio.Lock()` 无参构造，与当前运行的 loop 绑定。
    lock = getattr(consumer, '_membership_lock', None)
    if lock is None:
        lock = asyncio.Lock()
        consumer._membership_lock = lock

    async with lock:
        try:
            new_all = await _fetch_user_organization_ids(consumer.user)
        except _OrganizationMembershipFetchError:
            logger.warning(
                "[Auth] membership sync DB error, skipping this cycle (user=%s)",
                consumer.user_id,
            )
            return False

        old_all = set(consumer.organization_ctx.all_ids)
        if new_all == old_all:
            return False

        added = new_all - old_all
        removed = old_all - new_all
        preferred = getattr(consumer, '_initial_organization_hint', None)

        # 被踢出所有 organization
        if not new_all:
            try:
                await consumer._send_envelope(build_envelope(
                    'organization.membership_changed',
                    new_event_id(),
                    {
                        'added': [],
                        'removed': sorted(removed),
                        'all_ids': [],
                        'primary_id': None,
                        'reason': 'removed_from_all_organizations',
                    },
                ))
            except Exception:
                logger.debug(
                    "[Auth] membership_changed push failed (user=%s)",
                    consumer.user_id,
                )
            for wt_id in removed:
                try:
                    await consumer._leave_group(f"organization.{wt_id}")
                except Exception:
                    pass
            pruned = await _prune_organization_subscriptions(consumer, removed)
            for topic in pruned:
                try:
                    await consumer._leave_group(f"topic.{topic}")
                except Exception:
                    pass
            consumer.organization_ctx = OrganizationContext(None, set())
            _invalidate_consumer_caches(consumer)
            consumer.authed = False
            try:
                await consumer._send_error(
                    f"membership_sync_{int(time.time())}",
                    ERROR_PERMISSION_DENIED,
                    "user is not a member of any organization",
                )
                await consumer.close(code=4003)
            except Exception:
                pass
            logger.info(
                "[Auth] user %s removed from all organizations during recheck, closing connection",
                consumer.user_id,
            )
            return True

        # Leave removed organization groups（粗粒度）
        for wt_id in removed:
            try:
                await consumer._leave_group(f"organization.{wt_id}")
            except Exception as exc:
                logger.warning(
                    "[Auth] leave_group organization.%s failed during sync: %s", wt_id, exc,
                )

        # 退订所有归属 removed organization 的 topic（A 类 + B 类）
        pruned_topics = await _prune_organization_subscriptions(consumer, removed)
        topic_leaves: list = []
        for topic in pruned_topics:
            try:
                await consumer._leave_group(f"topic.{topic}")
                topic_leaves.append(topic)
            except Exception as exc:
                logger.warning(
                    "[Auth] leave_group topic.%s failed during sync: %s", topic, exc,
                )

        # Join added organization groups
        for wt_id in added:
            try:
                await consumer._join_group(f"organization.{wt_id}")
            except Exception as exc:
                logger.warning(
                    "[Auth] join_group organization.%s failed during sync: %s", wt_id, exc,
                )

        # 原子替换 organization_ctx（frozenset 不可变 + 引用原子赋值）
        old_primary = consumer.organization_ctx.primary_id
        new_primary = _select_new_primary(old_primary, new_all, preferred)
        consumer.organization_ctx = OrganizationContext(new_primary, new_all)

        # 清 LRU 缓存，避免旧 thread/resource cache 命中产生 stale 判断
        _invalidate_consumer_caches(consumer)

        logger.info(
            "[Auth] organization membership synced user=%s added=%s removed=%s "
            "primary=%s topic_leaves=%d",
            consumer.user_id, sorted(added), sorted(removed),
            new_primary, len(topic_leaves),
        )

        try:
            await consumer._send_envelope(build_envelope(
                'organization.membership_changed',
                new_event_id(),
                {
                    'added': sorted(added),
                    'removed': sorted(removed),
                    'all_ids': sorted(new_all),
                    'primary_id': new_primary,
                    'pruned_topics': sorted(pruned_topics),
                },
            ))
        except Exception:
            logger.debug(
                "[Auth] membership_changed push failed (user=%s, non-fatal)",
                consumer.user_id,
            )

        return True


def _filter_capabilities(role: str, declared: set) -> set:
    """Take intersection of client-declared capabilities and role whitelist."""
    whitelist = ROLE_CAPABILITY_WHITELIST.get(role)
    if whitelist is None:
        logger.warning("[Auth] no capability whitelist for role=%s, denying all", role)
        return set()
    filtered = declared & whitelist
    dropped = declared - whitelist
    if dropped:
        logger.warning("[Auth] role=%s: dropped unauthorized capabilities: %s", role, dropped)
    return filtered


def _verify_channel_token(token: str, secret: str) -> tuple:
    """Verify channel HMAC token with timestamp.

    New format: ``{unix_ts}:{hmac_sha256_hex}``
    Legacy format: plain shared secret (backward compat, logged as deprecation).

    Returns (ok: bool, error_msg: str).
    """
    if ':' in token:
        parts = token.split(':', 1)
        try:
            ts = int(parts[0])
        except (ValueError, OverflowError):
            return False, "invalid timestamp in channel token"

        age = abs(time.time() - ts)
        if age > _CHANNEL_TOKEN_MAX_AGE:
            return False, "channel token expired"

        expected_sig = hmac.new(
            secret.encode('utf-8'),
            parts[0].encode('utf-8'),
            hashlib.sha256,
        ).hexdigest()
        if not hmac.compare_digest(parts[1], expected_sig):
            return False, "invalid channel signature"
        return True, ""

    # RT-05: Legacy tokens (no timestamp) are rejected by default.
    # They have no time-bound validity and can be replayed indefinitely if leaked.
    legacy_enabled = getattr(settings, 'CHANNEL_LEGACY_TOKEN_ENABLED', False)
    if not legacy_enabled:
        return False, "legacy channel token format rejected — use timestamped HMAC format"
    if not hmac.compare_digest(token.encode('utf-8'), secret.encode('utf-8')):
        return False, "invalid channel token"
    logger.warning("[Auth] channel using legacy token format without timestamp — please upgrade")
    return True, ""


class _OrganizationMembershipFetchError(RuntimeError):
    """DB 查询用户 organization membership 失败。由上层 auth handler 捕获并返回 ERROR_INTERNAL。"""


@database_sync_to_async
def _fetch_user_organization_ids(user) -> set:
    """查询用户所属的全部 organization id（owner + member）。

    Fail-close：DB 查询异常时抛出 ``_OrganizationMembershipFetchError``，由 auth handler
    统一拒绝连接。若静默返回空集，用户会处于「认证成功但订阅全部被拒」的幽灵状态，
    运维和客户端都难以察觉。
    """
    user_id = user.id if hasattr(user, 'id') else user
    try:
        from apps.tabtinspace.models import Organization
        from django.db.models import Q
        qs = Organization.objects.filter(
            Q(owner_id=user_id) | Q(members__user_id=user_id)
        ).distinct().values_list('id', flat=True)
        return {str(wid) for wid in qs}
    except Exception as exc:
        logger.warning(
            "[Auth] failed to fetch user organization memberships for user=%s",
            user_id, exc_info=True,
        )
        raise _OrganizationMembershipFetchError(str(exc)) from exc


@database_sync_to_async
def _fetch_device_organization_id(device_id: str, user_id: str) -> Optional[str]:
    """Daemon / device_runtime 角色下，从 bound Device 获取所属 organization_id。

    Daemon 本质绑定单个设备、单个 organization，不应持有 user 全部 organization 的订阅权。
    返回 None 表示 device 不存在或尚未关联 organization；调用方应拒绝 auth。
    """
    try:
        from apps.tabtinspace.models import Device
        ws_id = (
            Device.objects.filter(fingerprint=device_id, user_id=user_id, control_status="active")
            .values_list('organization_id', flat=True)
            .first()
        )
        return str(ws_id) if ws_id else None
    except Exception:
        logger.warning(
            "[Auth] failed to fetch device organization for device=%s user=%s",
            device_id, user_id, exc_info=True,
        )
        return None


@database_sync_to_async
def _ensure_electron_device_registered(
    user,
    organization_id: str,
    fingerprint: str,
    device_info: Any,
    capabilities: set[str],
) -> bool:
    """Keep the legacy Workspace device projection ready before topic subscription."""
    try:
        from apps.tabtinspace.services.device_service import DeviceService

        info = device_info if isinstance(device_info, dict) else {}
        name = str(info.get("name") or "TabTin Desktop").strip()[:255]
        os_name = str(info.get("os") or info.get("platform") or "").strip()
        os_info = {
            key: value
            for key, value in {
                "os": os_name,
                "platform": str(info.get("platform") or os_name).strip(),
                "version": str(info.get("os_version") or "").strip(),
                "app_version": str(info.get("app_version") or "").strip(),
            }.items()
            if value
        }
        return bool(
            DeviceService(user=user).register_device(
                organization_id=organization_id,
                fingerprint=fingerprint,
                device_type="electron",
                name=name or "TabTin Desktop",
                os_info=os_info,
                capabilities=sorted(capabilities),
                identity_verified=True,
            )
        )
    except Exception:
        logger.warning(
            "[Auth] failed to auto-register Electron device=%s user=%s",
            fingerprint,
            getattr(user, "id", ""),
            exc_info=True,
        )
        return False


@database_sync_to_async
def _daemon_control_enabled_for_connection(
    *,
    user_id: str,
    organization_id: str,
    client_type: str,
    client_version: str,
) -> bool:
    from apps.services.common.runtime_build import ClientBuild
    from apps.services.daemon_control.feature import (
        daemon_control_enabled_for_organization,
    )

    return daemon_control_enabled_for_organization(
        client=ClientBuild(client_type=client_type, client_version=client_version),
        user_id=user_id,
        organization_id=organization_id,
    )


@database_sync_to_async
def _check_organization_exists(organization_id: str) -> bool:
    """G-043: verify organization exists in DB (lightweight pk lookup)."""
    try:
        from apps.tabtinspace.models import Organization
        return Organization.objects.filter(pk=organization_id).exists()
    except Exception:
        return False


@database_sync_to_async
def _verify_api_token(raw_token: str):
    """Verify an Open API token (ttn_xxx_yyy format). Returns ApiToken or None."""
    try:
        from apps.tabdata.models_token import TableApiToken
        result = TableApiToken.verify_token(raw_token)
        if result is None:
            return None
        token_instance, _user = result
        return token_instance
    except Exception:
        return None


@database_sync_to_async
def _verify_api_token_organization(api_token, organization_id: str, user) -> bool:
    """Verify that the API token is authorized for the given organization.

    ：单值 ``space`` FK 已 Drop；若 Token 限定了 ``space_ids`` scope，
    要求其中至少一个 host 属于目标组织（否则仅校验组织 viewer）。
    """
    space_ids = getattr(api_token, "space_ids", None)
    if space_ids:
        try:
            from apps.tabtinspace.services.host_resolver import host_organization_id

            matched = False
            for host_id in space_ids:
                org_id = host_organization_id(host_id)
                if org_id is not None and str(org_id) == str(organization_id):
                    matched = True
                    break
            if not matched:
                return False
        except Exception:
            return False
    return OrganizationService(user).check_organization_permission(organization_id, "viewer")


@database_sync_to_async
def _update_device_status_db(fingerprint: str, status: str, user_id: str = None):
    """DB-only: 更新 Device 在线状态，返回 (device, should_broadcast)。

    G-044: 纯 DB 操作拆分——不在 sync 线程内调用 async_to_sync，
    释放 DB 线程池槽位后由 caller 在 async 上下文广播。
    """
    try:
        from apps.tabtinspace.services.device_service import DeviceService
        device = DeviceService().update_device_status(fingerprint, status, user_id=user_id)
        if device and device.organization_id and getattr(device, "_status_changed", True):
            return _serialize_device_for_broadcast(device, status), True
        return None, False
    except Exception as exc:
        logger.debug("[Auth] 更新 Device 状态失败（fingerprint=%s, status=%s）: %s", fingerprint, status, exc)
        return None, False


# R2-03: broadcast utilities extracted to device_broadcast.py — re-export for backward compat
from ..device_broadcast import (  # noqa: F401
    _broadcast_device_status,
    _broadcast_device_status_async,
    _serialize_device_for_broadcast,
)


async def _update_device_status(fingerprint: str, status: str, user_id: str = None) -> None:
    """异步更新 Device 在线状态（WS connect/disconnect 钩子）。

    G-044: DB 写和 channel layer 广播拆分——DB 在 sync 线程，广播在 async 上下文，
    避免在 DB 线程池内嵌套 async_to_sync。
    """
    broadcast_data, should_broadcast = await _update_device_status_db(fingerprint, status, user_id=user_id)
    if should_broadcast and broadcast_data:
        await _broadcast_device_status_async(broadcast_data)


def _invalidate_daemon_fp_cache_for_device(fingerprint: str) -> None:
    """Clear daemon fp None sentinel caches for all sessions bound to this device.

    G-047: 移除 [:100] 硬截断 + 用 space_id__in 批量查询替代 N+1 循环。
    """
    try:
        from apps.tabtinspace.models import Device, Workspace
        device = Device.objects.filter(fingerprint=fingerprint).first()
        if not device:
            return
        space_ids = list(
            Workspace.objects.filter(device=device)
            .values_list('id', flat=True)
        )
        if not space_ids:
            return
        from apps.chat.conversation.models import ChatSession
        from apps.services.agent_engine.services.frontend_action_service import FrontendActionService
        session_ids = list(
            ChatSession.objects.filter(workspace_id__in=space_ids)
            .values_list('id', flat=True)
        )
        from apps.services.agent_engine.services.device_dispatch_service import DeviceDispatchService
        for sid in session_ids:
            FrontendActionService.invalidate_daemon_fp_cache(f"chat-session-{sid}")
            DeviceDispatchService.invalidate_thread_context_cache(str(sid))
        logger.info("[Auth] cleared daemon fp + thread_ctx caches for device=%s (%d spaces, %d sessions)", fingerprint, len(space_ids), len(session_ids))
    except Exception as exc:
        logger.debug("[Auth] _invalidate_daemon_fp_cache_for_device failed: %s", exc)


BUFFERED_ACTION_MAX_AGE = 300  # action envelopes older than 5 min are stale
BUFFERED_APPROVAL_MAX_AGE = 150  # approval responses have tighter TTL


def _is_envelope_expired(envelope: Dict[str, Any], max_age: int) -> bool:
    ts = envelope.get("ts")
    if ts is None or not isinstance(ts, (int, float)) or ts <= 0:
        logger.debug("[Auth] envelope missing or invalid ts field (ts=%r), treating as not expired", ts)
        return False
    return (time.time() - ts) > max_age


def _is_sandbox_policy_blocked(envelope: Dict[str, Any]) -> bool:
    """E2E-022: 检查缓冲 action 的 sandbox_policy 是否已被阻止。

    drain 时跳过 route=="blocked" 的 action，防止旧缓冲中被当前策略
    阻止的操作在 Daemon 重连后被执行。
    """
    payload = envelope.get("payload") or envelope.get("data") or {}
    policy = payload.get("sandbox_policy")
    if not isinstance(policy, dict):
        return False
    return policy.get("route") == "blocked"


async def _drain_buffered_actions(consumer, device_id: str) -> None:
    """Daemon 重连后从 Redis 取出缓冲 action 和 approval_response 并通过 WS 推送。

    G-011: 对每个 envelope 做 TTL 校验，过期的跳过不推送。
    G-046: 如果 send 失败（连接已断），将未发送的 envelope 归还 buffer，
    避免 drain 期间断连导致数据丢失。
    """
    try:
        from apps.services.agent_engine.services.frontend_action_service import FrontendActionService
        service = FrontendActionService()
        actions = await database_sync_to_async(service.drain_buffered_actions)(device_id)
        sent = 0
        expired = 0
        policy_blocked = 0
        unsent: list = []
        for action in actions:
            if _is_envelope_expired(action, BUFFERED_ACTION_MAX_AGE):
                expired += 1
                continue
            # E2E-022: 跳过 sandbox_policy.route 为 blocked 的缓冲 action
            if _is_sandbox_policy_blocked(action):
                policy_blocked += 1
                continue
            try:
                await consumer._send_envelope(action)
                sent += 1
            except Exception:
                unsent.append(action)
        if unsent:
            await _re_buffer_actions(service, device_id, unsent)
            logger.warning("[Auth] re-buffered %d action(s) after drain send failure for device=%s", len(unsent), device_id)
        if expired:
            logger.info(
                "[Auth] skipped %d expired buffered action(s) for device=%s (sent %d)",
                expired, device_id, sent,
            )
        if policy_blocked:
            logger.info(
                "[Auth] skipped %d policy-blocked buffered action(s) for device=%s",
                policy_blocked, device_id,
            )
    except Exception as exc:
        logger.debug("[Auth] drain buffered actions failed: %s", exc)

    try:
        from .approval import drain_buffered_approval_responses
        approvals = await database_sync_to_async(drain_buffered_approval_responses)(device_id)
        sent = 0
        expired = 0
        for approval in approvals:
            if _is_envelope_expired(approval, BUFFERED_APPROVAL_MAX_AGE):
                expired += 1
                continue
            try:
                await consumer._send_envelope(approval)
                sent += 1
            except Exception:
                logger.warning("[Auth] approval send failed during drain for device=%s, lost 1 approval", device_id)
                break
        if sent:
            logger.info("[Auth] drained %d buffered approval_response(s) for daemon %s", sent, device_id)
        if expired:
            logger.info("[Auth] skipped %d expired buffered approval_response(s) for device=%s", expired, device_id)
    except Exception as exc:
        logger.debug("[Auth] drain buffered approval responses failed: %s", exc)


async def _re_buffer_actions(service, device_id: str, envelopes: list) -> None:
    """G-046: return unsent actions back to the buffer so next reconnect can retry."""
    def _do_re_buffer():
        for env in envelopes:
            service._transport.buffer_action(device_id, env)
    try:
        await database_sync_to_async(_do_re_buffer)()
    except Exception as exc:
        logger.warning("[Auth] re-buffer failed for device=%s: %s (lost %d actions)", device_id, exc, len(envelopes))


def create_auth_handler(consumer):
    """Factory: returns an async handler bound to *consumer*."""

    async def handle_auth(envelope: Dict[str, Any]) -> None:
        payload = envelope["payload"]
        request_id = envelope["request_id"]
        consumer.device_identity_verified = False

        # 防止重复认证
        if consumer.authed:
            await consumer._send_error(request_id, ERROR_SCHEMA_INVALID, "already authenticated")
            return

        token = payload.get("access_token")
        organization_id = payload.get("organization_id")
        capabilities = payload.get("capabilities")
        role = envelope.get("role")
        client_type = str(payload.get("client_type") or role or "")
        device_info = payload.get("device") if isinstance(payload.get("device"), dict) else {}
        client_version = str(
            payload.get("client_version")
            or payload.get("version")
            or device_info.get("app_version")
            or ""
        )
        # envelope.device_id carries the client-generated fingerprint (see protocol.py)
        device_id = envelope.get("device_id")

        if not isinstance(capabilities, list) or not all(isinstance(item, str) for item in capabilities):
            await consumer._send_error(request_id, ERROR_SCHEMA_INVALID, "invalid capabilities")
            return

        normalized_capabilities = normalize_capabilities(capabilities)

        if device_id and not FINGERPRINT_SAFE.match(device_id):
            await consumer._send_error(request_id, ERROR_SCHEMA_INVALID, "invalid device_id format")
            return

        if role == "mobile" and ACTION_CAPABILITY in normalized_capabilities:
            await consumer._send_error(request_id, ERROR_PERMISSION_DENIED, "capability not allowed")
            return

        # ---- Open API role (API Token: ttn_xxx_yyy) ----
        if role == "open_api":
            if not token:
                await consumer._send_error(request_id, ERROR_SCHEMA_INVALID, "missing access_token")
                return

            api_token = await _verify_api_token(token)
            if api_token is None:
                _record_auth_failure(consumer, "invalid_token", "invalid api token")
                await consumer._send_error(request_id, ERROR_AUTH_INVALID, "invalid api token")
                return

            token_user = await database_sync_to_async(lambda: api_token.user)()

            # G-021: verify token is authorized for the declared organization
            if organization_id:
                ws_ok = await _verify_api_token_organization(api_token, organization_id, token_user)
                if not ws_ok:
                    _record_auth_failure(consumer, "permission_denied", "api token organization mismatch")
                    await consumer._send_error(
                        request_id, ERROR_PERMISSION_DENIED,
                        "api token not authorized for this organization",
                    )
                    return

            consumer.authed = True
            consumer.user = token_user
            consumer.user_id = str(token_user.id)
            consumer.organization_ctx = OrganizationContext(organization_id, {organization_id} if organization_id else set())
            consumer.role = role
            consumer.device_fingerprint = device_id
            consumer.connection_scope = CONNECTION_SCOPE_SESSION
            # G-012: whitelist intersection + auto-grant table.open for Open API
            open_api_caps = _filter_capabilities(role, normalized_capabilities) | {'table.open'}
            consumer.capabilities = open_api_caps
            consumer._api_token = api_token
            consumer._cancel_auth_timeout()

            # NP-01: open_api 路径与 channel/JWT 路径一致，认证成功后执行连接数限制检查，
            # 防止外部服务持有 API token 无限建立连接。
            allowed = await consumer._increment_connection_count()
            if not allowed:
                _record_auth_failure(
                    consumer, "connection_limit",
                    f"open_api user={consumer.user_id} exceeded connection limit",
                )
                consumer.authed = False
                consumer.user = None
                consumer.user_id = None
                consumer.organization_ctx = OrganizationContext(None, set())
                consumer.role = None
                consumer.device_fingerprint = None
                consumer.connection_scope = None
                consumer.capabilities = set()
                consumer._api_token = None
                await consumer._send_error(
                    request_id, ERROR_CONNECTION_LIMIT,
                    "too many connections",
                )
                await consumer.close(code=4003)
                return

            # G-029: record connection metrics for open_api path
            ws_connections_opened.labels(role=role).inc()
            ws_connections_total.labels(scope=consumer.connection_scope).inc()

            # G-013: open_api 认证成功后加入 user/organization group，
            # 否则该连接无法收到任何 organization/user 级别的 group broadcast。
            await consumer._join_group(f"user.{consumer.user_id}")
            if organization_id:
                await consumer._join_group(f"organization.{organization_id}")

            await consumer._start_heartbeat()
            await consumer._mark_runtime_snapshot_connected(
                client_type=client_type,
                client_version=client_version,
            )

            response = build_envelope(
                "auth.ok",
                request_id,
                {
                    "user_id": str(token_user.id),
                    "organization_id": organization_id or "",
                    "organization_ids": sorted(consumer.organization_ctx.all_ids),
                    "roles": [role],
                    "connection_scope": consumer.connection_scope,
                    "server_ts": now_ts(),
                    "transport_capabilities": [FRAME_FRAGMENT_TRANSPORT_CAPABILITY],
                },
                organization_id=organization_id or "",
            )
            await consumer._send_envelope(response)
            return

        # ---- Channel role (HMAC token) ----
        if role == "channel":
            if not token or not organization_id:
                await consumer._send_error(request_id, ERROR_SCHEMA_INVALID, "missing access_token or organization_id")
                return
            expected = getattr(settings, "CHANNEL_GATEWAY_TOKEN", "")
            if not expected:
                _record_auth_failure(consumer, "invalid_token", "channel token not configured")
                await consumer._send_error(request_id, ERROR_AUTH_INVALID, "channel token not configured")
                return
            # G-010: HMAC with timestamp validity (+ legacy fallback)
            token_ok, token_err = _verify_channel_token(token, expected)
            if not token_ok:
                _record_auth_failure(consumer, "invalid_token", token_err)
                await consumer._send_error(request_id, ERROR_AUTH_INVALID, token_err)
                return

            # G-043: 校验 organization 在数据库中实际存在，防止内部服务订阅已删除 organization 的 group
            ws_exists = await _check_organization_exists(organization_id)
            if not ws_exists:
                _record_auth_failure(consumer, "permission_denied", f"channel: organization not found: {organization_id}")
                await consumer._send_error(request_id, ERROR_PERMISSION_DENIED, "organization not found")
                return

            consumer.authed = True
            consumer.user = None
            consumer.user_id = None
            consumer.organization_ctx = OrganizationContext(organization_id, {organization_id})
            consumer.role = role
            consumer.device_fingerprint = device_id
            consumer.connection_scope = _ROLE_TO_SCOPE.get(role, CONNECTION_SCOPE_SESSION)
            # G-012: whitelist intersection
            consumer.capabilities = _filter_capabilities(role, normalized_capabilities)
            consumer._cancel_auth_timeout()

            # G-011: channel 角色也执行连接数限制检查（使用 organization 维度），
            # 防止内部服务异常重连时无法限流。
            allowed = await consumer._increment_connection_count()
            if not allowed:
                _record_auth_failure(consumer, "connection_limit", f"channel organization={organization_id} exceeded connection limit")
                # G-042: 重置所有已设置字段
                consumer.authed = False
                consumer.user = None
                consumer.user_id = None
                consumer.organization_ctx = OrganizationContext(None, set())
                consumer.role = None
                consumer.device_fingerprint = None
                consumer.connection_scope = None
                consumer.capabilities = set()
                await consumer._send_error(
                    request_id, ERROR_CONNECTION_LIMIT,
                    "too many connections",
                )
                await consumer.close(code=4003)
                return

            # G-029: record connection metrics for channel path
            ws_connections_opened.labels(role=role).inc()
            ws_connections_total.labels(scope=consumer.connection_scope).inc()

            await consumer._join_group(f"organization.{organization_id}")

            await consumer._start_heartbeat()
            await consumer._mark_runtime_snapshot_connected(
                client_type=client_type,
                client_version=client_version,
            )

            response = build_envelope(
                "auth.ok",
                request_id,
                {
                    "user_id": "channel",
                    "organization_id": organization_id,
                    "organization_ids": [organization_id],
                    "roles": [role],
                    "connection_scope": consumer.connection_scope,
                    "server_ts": now_ts(),
                    "transport_capabilities": [FRAME_FRAGMENT_TRANSPORT_CAPABILITY],
                },
                organization_id=organization_id,
            )
            await consumer._send_envelope(response)
            return

        # ---- Standard role (JWT token) ----
        # G-071: backend role 仅用于服务端发消息，不允许通过标准 JWT 路径建立连接
        if role == "backend":
            _record_auth_failure(consumer, "invalid_token", "backend role not allowed via JWT auth")
            await consumer._send_error(request_id, ERROR_PERMISSION_DENIED, "backend role not allowed for client connections")
            return

        if not token:
            await consumer._send_error(request_id, ERROR_SCHEMA_INVALID, "missing access_token")
            return

        # G-008: 区分 token 过期 vs 无效，返回不同错误码让客户端知道该刷新 token
        token_payload, jwt_error = _verify_jwt_for_ws(token)
        if jwt_error == "expired":
            _record_auth_failure(consumer, "token_expired", "JWT token expired")
            await consumer._send_error(request_id, ERROR_AUTH_TOKEN_EXPIRED, "token expired")
            return
        if not token_payload or not token_payload.get("user_id"):
            _record_auth_failure(consumer, "invalid_token", "invalid JWT token")
            await consumer._send_error(request_id, ERROR_AUTH_INVALID, "invalid token")
            return

        # G-009 + CD-001: daemon/device_runtime 角色接受 daemon token，其他角色只接受 access token
        expected_type = 'daemon' if role in {'daemon', 'device_runtime'} else 'access'
        actual_type = token_payload.get("token_type")
        if actual_type != expected_type:
            _record_auth_failure(consumer, "invalid_token", f"token_type={actual_type} not allowed for role={role}")
            await consumer._send_error(request_id, ERROR_AUTH_INVALID, "invalid token type")
            return

        if actual_type == 'daemon':
            jti = token_payload.get('jti')
            if jti:
                revoked = await database_sync_to_async(is_daemon_token_revoked)(jti)
                if revoked:
                    _record_auth_failure(consumer, "token_revoked", f"daemon token revoked: jti={jti}")
                    await consumer._send_error(request_id, ERROR_AUTH_INVALID, "token revoked")
                    return

            token_device_id = token_payload.get('device_id')
            if device_id:
                if str(token_device_id or '') != str(device_id):
                    _record_auth_failure(
                        consumer, "device_mismatch",
                        f"envelope device_id={device_id} != token device_id={token_device_id}"
                    )
                    await consumer._send_error(request_id, ERROR_AUTH_INVALID, "device identity mismatch")
                    return

            consumer.device_identity_verified = bool(
                device_id and token_payload.get('device_id') == device_id
            )

        user_id = str(token_payload["user_id"])

        try:
            user = await database_sync_to_async(User.objects.get)(id=user_id)
        except User.DoesNotExist:
            _record_auth_failure(consumer, "invalid_token", f"user not found: {user_id}")
            await consumer._send_error(request_id, ERROR_AUTH_INVALID, "user not found")
            return

        if organization_id:
            has_access = await database_sync_to_async(OrganizationService(user).check_organization_permission)(
                organization_id,
                "viewer",
            )
            if not has_access:
                _record_auth_failure(consumer, "permission_denied", f"organization access denied for user={user_id}")
                await consumer._send_error(request_id, ERROR_PERMISSION_DENIED, "organization access denied")
                return

        # SDI-018: validate session binding for access tokens (consistent with HTTP JWTAuth)
        # Daemon tokens use jti-based revocation (checked above), not session binding.
        if actual_type == 'access':
            session_key = token_payload.get("sid")
            if not session_key:
                _record_auth_failure(consumer, "invalid_token", f"missing session binding for user={user_id}")
                await consumer._send_error(request_id, ERROR_AUTH_INVALID, "missing session binding")
                return

            def _check_session():
                s = SessionManager.validate_session(session_key)
                return s is not None and str(s.user_id) == user_id

            session_valid = await database_sync_to_async(_check_session)()
            if not session_valid:
                _record_auth_failure(consumer, "invalid_session", f"session revoked for user={user_id}")
                await consumer._send_error(request_id, ERROR_AUTH_INVALID, "session revoked")
                return


        if role == "electron" and device_id:
            daemon_control_enabled = await _daemon_control_enabled_for_connection(
                user_id=user_id,
                organization_id=str(organization_id or ""),
                client_type=client_type,
                client_version=client_version,
            )
            # Rollout gate: until daemon-control is enabled, preserve the existing
            # Electron execution path. Once enabled, missing/invalid credentials
            # may still chat but cannot claim an execution route.
            consumer.device_identity_verified = not daemon_control_enabled
            device_credential = str(payload.get("device_credential") or "")
            if daemon_control_enabled and device_credential:
                try:
                    from apps.services.daemon_control.client import (
                        DaemonControlUnavailable,
                        verify_device_credential,
                    )

                    consumer.device_identity_verified = await run_sync_io(
                        verify_device_credential,
                        owner_user_id=user_id,
                        installation_id=device_id,
                        device_credential=device_credential,
                    )
                except DaemonControlUnavailable:
                    # Old clients may still chat, but no unverified connection may
                    # claim an execution route while the control plane is unavailable.
                    consumer.device_identity_verified = False

        # 查询用户所有 organization membership，构建多 organization 上下文。
        #
        # 角色差异：
        #   - daemon / device_runtime: 单设备单 organization 语义，强制使用
        #     bound Device 的 organization_id，避免 Daemon WS 收到非绑定
        #     organization 的事件放大攻击面。
        #   - 其他 JWT role (electron/web/mobile/admin): 用户级连接，
        #     承载该用户所有 Organization 的订阅权限。
        if role in {'daemon', 'device_runtime'}:
            if not device_id:
                _record_auth_failure(
                    consumer, "invalid_token",
                    f"daemon/device_runtime missing device_id for user={user_id}",
                )
                await consumer._send_error(request_id, ERROR_SCHEMA_INVALID, "missing device_id")
                return
            device_blocked = await database_sync_to_async(is_device_blocked)(device_id)
            if device_blocked:
                _record_auth_failure(
                    consumer, "device_blocked",
                    f"device blocked: fp={device_id} user={user_id}",
                )
                await consumer._send_error(request_id, ERROR_PERMISSION_DENIED, "DEVICE_BLOCKED")
                return
            bound_wt = await _fetch_device_organization_id(device_id, user_id)
            if not bound_wt:
                _record_auth_failure(
                    consumer, "permission_denied",
                    f"device not bound to organization: fp={device_id} user={user_id}",
                )
                await consumer._send_error(
                    request_id, ERROR_PERMISSION_DENIED,
                    "device not bound to any organization",
                )
                return
            all_organization_ids = {bound_wt}
            primary_id: Optional[str] = bound_wt
        else:
            try:
                all_organization_ids = await _fetch_user_organization_ids(user)
            except _OrganizationMembershipFetchError:
                _record_auth_failure(
                    consumer, "internal_error",
                    f"organization membership fetch failed for user={user_id}",
                )
                await consumer._send_error(
                    request_id, ERROR_INTERNAL,
                    "failed to load organization memberships, retry later",
                )
                return
            if organization_id and str(organization_id) not in all_organization_ids:
                # check_organization_permission 已经通过，补加 defensive entry
                # 兜住 membership 复制延迟等极端情况。
                all_organization_ids.add(str(organization_id))
            # Fail-close：未关联任何 organization 的用户拒绝连接，避免"假认证+
            # 订阅全部被拒"的幽灵连接。客户端应引导用户先加入 organization。
            if not all_organization_ids:
                _record_auth_failure(
                    consumer, "permission_denied",
                    f"user={user_id} has no organization membership",
                )
                await consumer._send_error(
                    request_id, ERROR_PERMISSION_DENIED,
                    "user is not a member of any organization",
                )
                return
            # primary_id 选择策略：
            # 1. 客户端显式声明（hint）
            # 2. all_organization_ids 按字典序最小（保证同一用户多次 auth 取值稳定，
            #    避免 set 迭代顺序随机导致前端 UI 跳变）
            if organization_id:
                primary_id = organization_id
            else:
                primary_id = min(all_organization_ids)

        if (
            role == "electron"
            and device_id
            and consumer.device_identity_verified
        ):
            registered = await _ensure_electron_device_registered(
                user,
                str(primary_id or ""),
                device_id,
                payload.get("device"),
                normalized_capabilities,
            )
            if not registered:
                _record_auth_failure(
                    consumer,
                    "internal_error",
                    f"electron device registration failed: user={user_id}",
                )
                await consumer._send_error(
                    request_id,
                    ERROR_INTERNAL,
                    "failed to register execution device, retry later",
                )
                return

        consumer.authed = True
        consumer.user = user
        consumer.user_id = user_id
        consumer.organization_ctx = OrganizationContext(primary_id, all_organization_ids)
        # P1-NEW-2：sync_organization_membership primary 回退时优先用客户端声明的 hint，
        # 避免跳到字典序最小的陌生 organization；hint 为 auth payload 里的 organization_id。
        consumer._initial_organization_hint = str(organization_id) if organization_id else None
        consumer.role = role
        consumer.device_fingerprint = device_id
        consumer.connection_scope = _ROLE_TO_SCOPE.get(role, CONNECTION_SCOPE_SESSION)
        # G-012: whitelist intersection
        consumer.capabilities = _filter_capabilities(role, normalized_capabilities)
        consumer._cancel_auth_timeout()
        # RT-04: store JWT token for periodic re-verification in heartbeat
        consumer._ws_auth_token = token
        consumer._last_jwt_recheck_at = time.time()

        # G-001: 连接数检查必须在 _update_device_status 之前，
        # 避免超限拒绝时设备状态已被标记为 online 而无法回滚。
        allowed = await consumer._increment_connection_count()
        if not allowed:
            _record_auth_failure(consumer, "connection_limit", f"user={user_id} exceeded connection limit")
            # G-042: 重置所有已设置字段，防止残留值影响后续逻辑
            consumer.authed = False
            consumer.user = None
            consumer.user_id = None
            consumer.organization_ctx = OrganizationContext(None, set())
            consumer.role = None
            consumer.device_fingerprint = None
            consumer.connection_scope = None
            consumer.capabilities = set()
            await consumer._send_error(
                request_id, ERROR_CONNECTION_LIMIT,
                "too many connections",
            )
            await consumer.close(code=4003)
            return

        # G-004: 指标递增移到确认不超限之后，
        # 确保 ws_connections_opened 统计的是真正建立的连接数。
        ws_connections_opened.labels(role=role or 'unknown').inc()
        ws_connections_total.labels(scope=consumer.connection_scope).inc()

        if device_id and (
            role != "electron" or consumer.device_identity_verified
        ):
            await _update_device_status(device_id, 'online', user_id=user_id)
            await consumer._increment_device_conn_count()

        #  推送在线抑制：移动端连上 = 前台在线（连接必然发生在前台）。
        # 之后由服务端心跳续期、app_state 帧显式切换。
        if role == 'mobile' and user_id:
            from apps.services.notification.push.presence import mark_mobile_foreground
            mark_mobile_foreground(user_id)

        # 并发 join 所有 organization group + user group，减少多 organization 用户
        # auth→auth.ok 之间的线性 Redis round-trip 延迟。
        # 任一 group_add 失败（channel layer 异常等）需整体回滚：
        # 已成功 join 的组先退出，再 reset consumer 字段 + close 连接，
        # 避免"consumer.authed=True 但部分组未加入"的幽灵状态让客户端陷入
        # "auth.ok 没收到、重发 auth 又被 already authenticated 拒绝"的死锁。
        import asyncio as _asyncio
        group_join_coros = [consumer._join_group(f"user.{user_id}")]
        group_join_coros.extend(
            consumer._join_group(f"organization.{wt_id}")
            for wt_id in consumer.organization_ctx.all_ids
        )
        try:
            await _asyncio.gather(*group_join_coros)
        except Exception as exc:
            logger.warning(
                "[Auth] group_add failed during auth join, rolling back: user=%s %s",
                user_id, exc, exc_info=True,
            )
            for group in list(consumer.joined_groups):
                try:
                    await consumer.channel_layer.group_discard(group, consumer.channel_name)
                except Exception:
                    pass
            consumer.joined_groups.clear()
            consumer.authed = False
            consumer.user = None
            consumer.user_id = None
            consumer.organization_ctx = OrganizationContext(None, set())
            consumer.role = None
            consumer.device_fingerprint = None
            consumer.connection_scope = None
            consumer.capabilities = set()
            consumer._ws_auth_token = None
            await consumer._send_error(
                request_id, ERROR_INTERNAL,
                "failed to join channel layer groups, please reconnect",
            )
            await consumer.close(code=4003)
            return

        # 设备态 runtime 重连时 drain 缓冲的 action（background task，不阻塞 auth.ok）。
        # DEV-P1-19: device_action_ready_key 已移至 on_subscribed 中写入，
        # auth 阶段仅做 drain + channel 缓存，确保设备订阅 topic 后才允许 group_send 投递。
        if role in {'daemon', 'device_runtime'} and device_id:
            # 取消断开宽限期（设备已重连，无需延迟标记 offline）
            try:
                from django.core.cache import cache as _cache
                from ..gateway import DISCONNECT_GRACE_KEY_PREFIX
                from ..bus import set_pre_subscribe_flag
                grace_key = f"{DISCONNECT_GRACE_KEY_PREFIX}{device_id}"

                def _sync_device_auth_cache_ops() -> bool:
                    cancelled_grace = False
                    try:
                        cancelled_grace = _cache.get(grace_key) is not None
                        if cancelled_grace:
                            _cache.delete(grace_key)
                    except Exception as exc:
                        logger.warning(
                            "[Auth] disconnect grace cancel failed for reconnected device=%s: %s",
                            device_id,
                            exc,
                            exc_info=True,
                        )

                    try:
                        set_pre_subscribe_flag(device_id)
                    except Exception as exc:
                        logger.warning(
                            "[Auth] pre-subscribe flag write failed for device=%s: %s",
                            device_id,
                            exc,
                            exc_info=True,
                        )

                    try:
                        _cache.set(f"runtime_channel:{device_id}", consumer.channel_name, timeout=3600)
                        if role == 'daemon':
                            _cache.set(f"daemon_channel:{device_id}", consumer.channel_name, timeout=3600)
                    except Exception as exc:
                        logger.warning(
                            "[Auth] channel cache write failed, device status unclear: fp=%s, %s",
                            device_id,
                            exc,
                            exc_info=True,
                        )
                    return cancelled_grace

                if await run_sync_io(_sync_device_auth_cache_ops):
                    logger.info("[Auth] cancelled disconnect grace for reconnected device=%s", device_id)
            except Exception as exc:
                logger.warning(
                    "[Auth] device auth cache boundary failed: fp=%s, %s",
                    device_id,
                    exc,
                    exc_info=True,
                )

            # E2E-013: 设置预订阅标志，保护 auth→subscribe 窗口期。
            # CA-004: offline buffer drain 统一由 on_subscribed 触发，避免 auth 阶段
            # drain 时 device_action_ready_key 尚未写入、设备 topic 未订阅的竞态窗口。
            # 缓存 runtime 的 channel_name，用于动作投递可达性判断。
            # 注意：这些 cache/Redis 操作在上面的 run_sync_io 中一次性完成，避免
            # django-redis 的同步锁阻塞 Daphne event loop。

            # 清除 daemon fp None sentinel 缓存，使下次路由查询能发现已重连的 runtime
            try:
                await database_sync_to_async(_invalidate_daemon_fp_cache_for_device)(device_id)
            except Exception as exc:
                logger.debug("[Auth] daemon fp cache invalidation failed: %s", exc)

        # 启动服务端心跳
        await consumer._start_heartbeat()
        await consumer._mark_runtime_snapshot_connected(
            client_type=client_type,
            client_version=client_version,
        )

        # G-014: auth.ok 先于扩展逻辑发送，确保即使 _extend_auth_handler 抛异常
        # 客户端也能收到认证成功响应，不会出现 authed=True 但客户端收到 ERROR 的状态不一致。
        response = build_envelope(
            "auth.ok",
            request_id,
            {
                "user_id": user_id,
                "organization_id": primary_id or "",
                "organization_ids": sorted(consumer.organization_ctx.all_ids),
                "roles": [role],
                "connection_scope": consumer.connection_scope,
                "server_ts": now_ts(),
                "transport_capabilities": [FRAME_FRAGMENT_TRANSPORT_CAPABILITY],
            },
            organization_id=primary_id or "",
        )
        await consumer._send_envelope(response)

        logger.info(
            "[Auth] authenticated user=%s role=%s device=%s primary_organization=%s member_count=%d scope=%s",
            user_id, role, device_id or "-",
            primary_id or "-", len(consumer.organization_ctx.all_ids),
            consumer.connection_scope,
        )

        # UpdateWSMixin 钩子：解析客户端版本元数据 & 加入更新推送分组
        # 异常不影响已完成的认证状态。
        try:
            consumer._extend_auth_handler(envelope)
            await consumer._auto_join_update_group()
        except Exception as exc:
            logger.warning(
                "[Auth] _extend_auth_handler failed (non-fatal, auth already complete): %s",
                exc,
            )

    return handle_auth
