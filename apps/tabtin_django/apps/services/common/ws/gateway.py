"""
WS gateway consumer (WS-first).

Thin dispatcher core — handler logic lives in ``handlers/`` sub-modules.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import re
import time
import uuid
from collections import deque
from typing import Any, Dict, FrozenSet, Optional, Tuple

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncWebsocketConsumer
from django.conf import settings
from django.db import close_old_connections

from apps.services.common.agent_protocol.constants import AgentActionEvent as _AAE, ToolDiscoveryEvent as _TDE, PromptForwardEvent as _PFE
from apps.services.common.agent_protocol.namespace import (
    ACTION_CAPABILITY as _ACTION_CAPABILITY,
    ACTION_DEVICE_PREFIX as _ACTION_DEVICE_PREFIX,
    ACTION_PREFIX as _ACTION_PREFIX,
)

from .protocol import (
    CHANNEL_SAFE_PATTERN,
    ContextSyncEvent,
    ERROR_AUTH_REQUIRED,
    ERROR_AUTH_TOKEN_EXPIRED,
    ERROR_CONFLICT,
    ERROR_INTERNAL,
    ERROR_NOT_FOUND,
    ERROR_PERMISSION_DENIED,
    ERROR_RATE_LIMITED,
    ERROR_REPLAY_GAP,
    ERROR_SCHEMA_INVALID,
    ERROR_TYPE_UNKNOWN,
    MAX_CONNECTIONS_PER_USER,
    MAX_MESSAGE_BYTES,
    build_envelope,
    build_error,
    validate_envelope,
)
from .organization_context import OrganizationContext
from .frame_reassembly import (
    FRAME_FRAGMENT_TYPE,
    FrameFragmentError,
    FrameFragmentReassembler,
)
from .metrics import (
    ws_connections_total,
    ws_connections_opened,
    ws_connections_closed,
    record_message_received,
    record_relay_ws_timestamp_rejected,
)
from .async_io import run_sync_io
from .bus import DEVICE_CONN_KEY_PREFIX, DEVICE_CONN_TTL, device_connection_count_key
from .handlers import (
    create_auth_handler,
    create_subscribe_handler,
    create_unsubscribe_handler,
    create_channel_inbound_handler,
    create_channel_outbound_ack_handler,
    create_channel_status_handler,
    create_action_result_handler,
    create_approval_request_handler,
    create_approval_response_handler,
    create_asr_stream_handler,
    create_tts_stream_handler,
    create_git_status_report_handler,
    create_git_diff_request_handler,
    create_git_diff_response_handler,
    create_device_capabilities_report_handler,
    create_device_capability_refresh_ack_handler,
    create_device_capability_refresh_result_handler,
    create_relay_events_handler,
    create_localrt_user_response_delivery_handler,
    create_localrt_user_response_handler,
    create_chat_send_message_handler,
    create_chat_cancel_handler,
    create_chat_pause_control_handler,
    create_subagent_cancel_handler,
    create_session_viewing_handler,
    cleanup_session_viewing_for_consumer,
)

from apps.updater.ws_handler import UpdateWSMixin

logger = logging.getLogger(__name__)

_USER_SCOPE_ACTION_ALLOWLIST = frozenset({
    _AAE.APPROVAL_REQUEST,
    _AAE.APPROVAL_RESOLVED,
    _AAE.APPROVAL_MEMO_UPDATED,
})


def _should_filter_user_scope_event(evt_type: str) -> bool:
    return evt_type.startswith(_ACTION_CAPABILITY) and evt_type not in _USER_SCOPE_ACTION_ALLOWLIST


def _classify_close_code(code: int | None) -> str:
    if code is None:
        return 'abnormal'
    if code in (1000, 1001):
        return 'normal'
    if code in (4001, 4003):
        return 'auth_failed'
    if code == 4002:
        return 'timeout'
    if 4000 <= code < 5000:
        return 'app_error'
    return 'other'

# ---- 安全配置 ----
AUTH_TIMEOUT_SECONDS = 15  # 连接后必须在此时间内完成认证
RATE_LIMIT_WINDOW_SECONDS = 10  # 速率限制滑动窗口
RATE_LIMIT_MAX_MESSAGES = 100  # 窗口内最大消息数
FRAGMENT_RATE_LIMIT_MAX_MESSAGES = int(
    getattr(settings, "WS_FRAGMENT_RATE_LIMIT_MAX_MESSAGES", 160)
)  # 默认至少容纳连续两个 64 片逻辑帧
FRAGMENT_RATE_LIMIT_MAX_BYTES = int(
    getattr(settings, "WS_FRAGMENT_RATE_LIMIT_MAX_BYTES", 64_000_000)
)
HEARTBEAT_INTERVAL_SECONDS = 30  # 服务端心跳间隔
JWT_RECHECK_INTERVAL_SECONDS = int(
    getattr(settings, "WS_JWT_RECHECK_INTERVAL_SECONDS", 60)
)  # RB-014: 从 300s 降至 60s，缩短权限撤销检测窗口；可通过 settings 覆盖

# G-035: 控制帧不计入速率限制（弱网重连时批量发送不应被限流）
_RATE_LIMIT_EXEMPT_TYPES = frozenset({"ping", "auth", "resume"})

# G-003: 并发连接总数限制，防止慢速 DDoS
MAX_TOTAL_CONNECTIONS = getattr(settings, "WS_MAX_TOTAL_CONNECTIONS", 10000)
# G-003: Origin 白名单（为空或 None 时不检查）
WS_ALLOWED_ORIGINS: list[str] | None = getattr(settings, "WS_ALLOWED_ORIGINS", None)

# RV-003: 未认证连接独立限制，防止未认证 WS 连接耗尽配额
MAX_UNAUTHENTICATED_CONNECTIONS = getattr(settings, "WS_MAX_UNAUTHENTICATED_CONNECTIONS", 500)
MAX_UNAUTHENTICATED_PER_IP = getattr(settings, "WS_MAX_UNAUTHENTICATED_PER_IP", 10)


def _resolve_gateway_client_ip(scope: dict[str, Any]) -> str | None:
    """按统一的可信代理层数解析 WS 客户端 IP。

    ``TRUSTED_PROXY_COUNT=0`` 时完全忽略 XFF，防止直连请求伪造来源；配置
    为 N 时只信任 XFF 右侧第 N 个地址，与 HTTP ``get_client_ip`` 保持同一
    安全口径。无效或不足的 XFF 链回退到 ASGI peer IP。
    """
    client = scope.get("client")
    peer_ip = client[0] if isinstance(client, (tuple, list)) and client else None
    trusted_proxy_count = int(getattr(settings, "TRUSTED_PROXY_COUNT", 0) or 0)
    if trusted_proxy_count <= 0:
        return peer_ip

    forwarded_values: list[str] = []
    for raw_name, raw_value in scope.get("headers", []):
        if raw_name.lower() != b"x-forwarded-for":
            continue
        forwarded_values.extend(
            part.strip()
            for part in raw_value.decode("ascii", errors="ignore").split(",")
            if part.strip()
        )

    candidate_index = len(forwarded_values) - trusted_proxy_count
    if candidate_index < 0:
        return peer_ip
    candidate = forwarded_values[candidate_index]
    try:
        return str(ipaddress.ip_address(candidate))
    except ValueError:
        return peer_ip

# ---- 连接计数 Redis 配置 ----
CONN_COUNT_KEY_PREFIX = "ws:conn:"
CONN_COUNT_TTL = 90  # 连接计数 Redis key TTL（秒）；心跳每 30s 续期，3x 容错

# ---- Daemon 断开宽限期 ----
DISCONNECT_GRACE_SECONDS = 30  # daemon/device_runtime 断开后等待重连的宽限期
DISCONNECT_GRACE_KEY_PREFIX = "ws:disconnect_grace:"  # Redis cache key 前缀

# ---- 延迟获取 ActionService（disconnect 清理用）----
# G-039: 使用 threading.local 替代模块级全局单例，
# 避免多 ASGI worker 线程间共享同一实例导致 Redis 连接交叉污染。
import threading as _threading

_action_service_local = _threading.local()


def _get_action_service():
    svc = getattr(_action_service_local, 'instance', None)
    if svc is None:
        from apps.services.agent_engine.services.frontend_action_service import FrontendActionService
        svc = FrontendActionService()
        _action_service_local.instance = svc
    return svc


def should_mark_device_offline_on_disconnect(role: Optional[str]) -> bool:
    """
    Electron devices should rely on HTTP heartbeat / explicit offline reporting.
    Remote runtimes still use WS disconnect as a stronger offline signal.
    """
    return role in {"daemon", "device_runtime"}


class GatewayConsumer(UpdateWSMixin, AsyncWebsocketConsumer):
    """
    WebSocket Gateway — single endpoint for all real-time communication.

    Responsibilities (kept in this file):
      - Transport lifecycle: connect / disconnect / receive
      - Message dispatch to handler modules
      - Auth timeout enforcement
      - Rate limiting (sliding window)
      - Channel-layer group management
      - Background task tracking

    Business handlers are in ``handlers/`` sub-modules.
    """

    # G-003: 类级别并发连接计数（单 worker 进程）
    _total_connections: int = 0
    # RV-003: 未认证连接计数（独立于 _total_connections，限制握手阶段 DDoS）
    _unauthenticated_connections: int = 0
    _per_ip_unauthenticated: dict[str, int] = {}
    # RT-21: 进程级认证用户连接计数 — Redis 故障时的 Fail-Close 兜底
    _per_user_connections: dict[str, int] = {}
    _PROCESS_LEVEL_MAX_PER_USER: int = MAX_CONNECTIONS_PER_USER * 2

    def __init__(self, *args: Any, **kwargs: Any):
        super().__init__(*args, **kwargs)
        # ---- 连接状态 ----
        self.authed = False
        self.user = None
        self.user_id: Optional[str] = None
        self.organization_ctx: OrganizationContext = OrganizationContext(None, set())
        self.role: Optional[str] = None
        self.device_fingerprint: Optional[str] = None
        self.connection_scope: Optional[str] = None  # user/session/device
        self.capabilities: set[str] = set()
        self.subscriptions: set[str] = set()
        self.subscription_boundaries: dict[str, str] = {}
        self.joined_groups: set[str] = set()
        self._group_safe_pattern = CHANNEL_SAFE_PATTERN
        # ---- 安全增强 ----
        self._auth_timeout_handle: Optional[asyncio.TimerHandle] = None
        self._heartbeat_handle: Optional[asyncio.TimerHandle] = None
        self._message_timestamps: deque[float] = deque()
        self._fragment_timestamps: deque[float] = deque()
        self._fragment_byte_timestamps: deque[Tuple[float, int]] = deque()
        self._fragment_window_bytes = 0
        # ---- 连接计数 ----
        self._conn_counted = False
        self._conn_registered_at: float = 0.0
        self._device_conn_counted = False  # 是否已为当前设备增加了连接计数
        self._total_conn_counted = False   # G-003: 是否已计入类级别 _total_connections
        self._unauth_counted = False       # RV-003: 是否已计入未认证连接计数
        self._client_ip: Optional[str] = None  # RV-003: 连接来源 IP
        # ---- 稳健性增强 ----
        self._background_tasks: set[asyncio.Task] = set()
        # DEV 入站延迟：计时可重叠，handler 串行（见 _schedule_client_handler）
        self._client_handler_lock = asyncio.Lock()
        # ---- 客户端活跃检测 ----
        self._last_client_message_at: float = time.time()
        # ---- RT-04: JWT 周期重验状态 ----
        self._ws_auth_token: Optional[str] = None
        self._last_jwt_recheck_at: float = 0.0
        self._ws_transport_connected_at: float = 0.0
        self._ws_connected_at: float = 0.0
        self._device_action_ready_generation: Optional[int] = None
        self.device_identity_verified = False
        self._ws_client_type: str = ""
        self._ws_client_version: str = ""
        self._last_message_type: str = "-"
        # ---- session viewing presence（chat.session.presence）----
        self._viewing_session_id: Optional[str] = None
        # ---- handler 缓存（避免每次 receive 重新创建闭包） ----
        self._cached_handlers: Optional[Dict[str, Any]] = None
        # 大帧分片只在当前已认证连接内暂存，不跨连接或身份共享。
        self._frame_fragment_reassembler = FrameFragmentReassembler()
        self._frame_fragment_expiry_handle: Optional[asyncio.TimerHandle] = None

    # ==================================================================
    # Organization context — compat properties
    # ==================================================================

    @property
    def organization_id(self) -> Optional[str]:
        """Compat: returns organization_ctx.primary_id."""
        return self.organization_ctx.primary_id

    @property
    def organization_ids(self) -> FrozenSet[str]:
        return self.organization_ctx.all_ids

    # ==================================================================
    # Transport lifecycle
    # ==================================================================

    async def connect(self) -> None:
        # G-003: 并发连接总数限制，在 accept 前拒绝超限连接
        if GatewayConsumer._total_connections >= MAX_TOTAL_CONNECTIONS:
            logger.warning(
                "[WS] connection rejected pre-accept: total connections limit reached (%d)",
                MAX_TOTAL_CONNECTIONS,
            )
            await self.close()
            return

        # RV-003: 提取客户端 IP（后续 per-IP 限制使用）
        self._client_ip = _resolve_gateway_client_ip(self.scope)

        # RV-003: 未认证连接总数限制（独立于已认证连接配额）
        if GatewayConsumer._unauthenticated_connections >= MAX_UNAUTHENTICATED_CONNECTIONS:
            logger.warning(
                "[WS] connection rejected pre-accept: unauthenticated connections limit reached (%d/%d) ip=%s",
                GatewayConsumer._unauthenticated_connections,
                MAX_UNAUTHENTICATED_CONNECTIONS,
                self._client_ip,
            )
            await self.close()
            return

        # RV-003: 单 IP 未认证连接限制，防止单源 DDoS
        if self._client_ip:
            ip_unauth_count = GatewayConsumer._per_ip_unauthenticated.get(self._client_ip, 0)
            if ip_unauth_count >= MAX_UNAUTHENTICATED_PER_IP:
                logger.warning(
                    "[WS] connection rejected pre-accept: per-IP unauthenticated limit reached ip=%s (%d/%d)",
                    self._client_ip, ip_unauth_count, MAX_UNAUTHENTICATED_PER_IP,
                )
                await self.close()
                return

        # G-003 + RT-06: Origin 白名单检查（可选，通过 settings.WS_ALLOWED_ORIGINS 配置）
        # RT-06: 配置了白名单时，缺少 Origin 头的请求同样拒绝，防止 curl/SSRF 绕过
        if WS_ALLOWED_ORIGINS:
            origin = None
            for header_name, header_value in self.scope.get("headers", []):
                if header_name == b"origin":
                    origin = header_value.decode("utf-8", errors="replace")
                    break
            if not origin or not any(origin == allowed or origin.endswith(f".{allowed}") for allowed in WS_ALLOWED_ORIGINS):
                logger.warning("[WS] connection rejected: origin %r not in whitelist", origin)
                await self.close()
                return

        GatewayConsumer._total_connections += 1
        self._total_conn_counted = True

        # RV-003: 递增未认证连接计数
        GatewayConsumer._unauthenticated_connections += 1
        if self._client_ip:
            GatewayConsumer._per_ip_unauthenticated[self._client_ip] = (
                GatewayConsumer._per_ip_unauthenticated.get(self._client_ip, 0) + 1
            )
        self._unauth_counted = True

        await self.accept()
        self._ws_transport_connected_at = time.time()
        # G-007: 使用 create_task + _track_task 替代 ensure_future，
        # 确保 auth timeout task 纳入 _background_tasks，disconnect 时可取消，
        # 连接已断时异常不会被静默丢弃。
        loop = asyncio.get_running_loop()
        self._auth_timeout_handle = loop.call_later(
            AUTH_TIMEOUT_SECONDS,
            lambda: self._track_task(loop.create_task(self._enforce_auth_timeout())),
        )

    async def _enforce_auth_timeout(self) -> None:
        """连接后 N 秒内未完成认证则断开。"""
        if not self.authed:
            from .metrics import ws_auth_failures
            ws_auth_failures.labels(reason="timeout").inc()
            logger.warning("[WS] auth timeout, closing unauthenticated connection")
            await self._send_error("req_timeout", ERROR_AUTH_REQUIRED, "auth timeout")
            await self.close(code=4001)

    async def disconnect(self, code: int) -> None:
        if getattr(self, "_frame_fragment_expiry_handle", None) is not None:
            self._frame_fragment_expiry_handle.cancel()
            self._frame_fragment_expiry_handle = None
        fragment_reassembler = getattr(self, "_frame_fragment_reassembler", None)
        if fragment_reassembler is not None:
            fragment_reassembler.clear()
        # G-003: 仅在 connect() 中确实计数过才递减，避免 connect 拒绝后误 dec
        if self._total_conn_counted:
            GatewayConsumer._total_connections = max(0, GatewayConsumer._total_connections - 1)
            self._total_conn_counted = False

        # RV-003: 未认证连接断开时递减计数
        self._release_unauthenticated_slot()

        # 最先清理本连接的 session presence。后续 runtime snapshot、channel
        # layer 或设备回收的 await 即使失败，也不能阻断该 cleanup；Redis 故障
        # 由 helper 记录 warning，90 秒 TTL 仅作为最佳努力兜底。
        await cleanup_session_viewing_for_consumer(self)

        connected_at = self._ws_transport_connected_at or self._ws_connected_at
        connection_age_ms = int((time.time() - connected_at) * 1000) if connected_at else 0
        logger.info(
            "[WS Gateway] disconnect code=%s user=%s device=%s role=%s "
            "primary_organization=%s organization_count=%d subs=%d "
            "connection_age_ms=%d last_message_type=%s",
            code, self.user_id, self.device_fingerprint, self.role,
            self.organization_ctx.primary_id or "-",
            len(self.organization_ctx.all_ids),
            len(self.subscriptions),
            connection_age_ms,
            self._last_message_type,
        )
        await self._mark_runtime_snapshot_disconnected(code)
        ws_connections_closed.labels(role=self.role or 'unknown', code=_classify_close_code(code)).inc()
        if self.connection_scope:
            ws_connections_total.labels(scope=self.connection_scope).dec()
        # 取消认证超时
        if self._auth_timeout_handle:
            self._auth_timeout_handle.cancel()
            self._auth_timeout_handle = None

        # 取消心跳定时器
        if self._heartbeat_handle:
            self._heartbeat_handle.cancel()
            self._heartbeat_handle = None

        # 递减连接计数
        await self._decrement_connection_count()

        # 取消所有后台任务
        for task in self._background_tasks:
            if not task.done():
                task.cancel()
        self._background_tasks.clear()

        # ── Phase 1: 立即清除路由缓存（在退组前！）──
        # 必须在 group_discard 之前完成，否则 is_daemon_ws_connected() 仍返回 True，
        # 导致新消息被 group_send 到已空的 group 而静默丢失。
        await self._invalidate_routing_caches_early()

        # ── Phase 2: 退出所有 channel-layer groups ──
        for group in list(self.joined_groups):
            await self.channel_layer.group_discard(group, self.channel_name)
        self.joined_groups.clear()

        # 释放 action device 绑定 + G-074: decrement subscription gauge
        from .metrics import ws_subscription_count
        action_devices_to_release: list[tuple[str, str]] = []
        for topic in list(self.subscriptions):
            prefix_parts = topic.split(".", 3)
            topic_prefix = ".".join(prefix_parts[:2]) if len(prefix_parts) >= 2 else topic
            ws_subscription_count.labels(topic_prefix=topic_prefix).dec()
            if self.device_fingerprint and topic.startswith(_ACTION_PREFIX):
                thread_id = topic.split(".", 2)[2]
                if thread_id:
                    action_devices_to_release.append((thread_id, self.device_fingerprint))
        if action_devices_to_release:
            def _release_action_devices() -> None:
                action_service = _get_action_service()
                for thread_id, fingerprint in action_devices_to_release:
                    action_service.release_action_device(thread_id, fingerprint)

            await run_sync_io(_release_action_devices)
        self.subscriptions.clear()

        # Clear per-topic filter/RLS subscription contexts
        if hasattr(self, '_open_table_subscriptions'):
            self._open_table_subscriptions.clear()

        # ── Phase 3: Device 离线处理 ──
        # 路由缓存（daemon_channel / runtime_channel / device_action_ready）
        # 已在 Phase 1 _invalidate_routing_caches_early 中统一清理。
        if self.device_fingerprint and self._device_conn_counted:
            remaining = await self._decrement_device_conn_count()
            if remaining <= 0 and should_mark_device_offline_on_disconnect(self.role):
                await self._schedule_disconnect_grace()

        # 清理 ASR/TTS 流式会话
        from .handlers.asr_stream import cleanup_asr_streams_for_consumer
        from .handlers.tts_stream import cleanup_tts_streams_for_consumer
        await cleanup_asr_streams_for_consumer(self.channel_name)
        await cleanup_tts_streams_for_consumer(self.channel_name)

        # 清理陈旧的数据库连接
        await database_sync_to_async(close_old_connections)()

    def _do_invalidate_routing_caches(self) -> None:
        """Sync: 条件删除路由缓存，仅当值属于当前连接时才删除。

        G-080: 统一的缓存清理逻辑，被 _invalidate_routing_caches_early
        和 _cleanup_device_routing_caches 共用，消除重复代码。
        """
        fp = self.device_fingerprint
        if not fp:
            return
        from django.core.cache import cache as _cache
        from .bus import release_device_action_ready

        release_device_action_ready(
            fp,
            self.channel_name,
            getattr(self, "_device_action_ready_generation", None),
        )
        for key in (f"daemon_channel:{fp}", f"runtime_channel:{fp}"):
            if _cache.get(key) == self.channel_name:
                _cache.delete(key)

    async def _invalidate_routing_caches_early(self) -> None:
        """Phase 1: 在 group_discard 之前清除路由缓存，消除竞态窗口。

        G-080b: 必须通过 database_sync_to_async 将同步 cache 操作
        推到线程池执行，否则 cache.get/delete 内部的 redis-py 连接池
        threading.Lock 会阻塞 event loop，与持有同一锁的 HTTP 工作线程
        形成死锁。
        """
        if not self.device_fingerprint:
            return
        try:
            await database_sync_to_async(self._do_invalidate_routing_caches)()
        except Exception as exc:
            logger.warning(
                "[WS] early routing cache invalidation failed (fp=%s): %s",
                self.device_fingerprint, exc,
            )

    # G-005: 拆分为 DB 更新 + async 广播，避免 @database_sync_to_async
    # 内部调用 async_to_sync(group_send) 导致嵌套事件循环死锁。

    @database_sync_to_async
    def _update_device_offline_db(self, fingerprint: str):
        """Sync: 标记设备 offline，返回广播所需信息（dict）或 None。"""
        try:
            from apps.tabtinspace.services.device_service import DeviceService
            device = DeviceService().update_device_status(fingerprint, 'offline', user_id=self.user_id)
            if device and device.organization_id and getattr(device, "_status_changed", True):
                return {
                    "device_id": str(device.id),
                    "user_id": str(device.user_id),
                    "fingerprint": device.fingerprint,
                    "name": device.name,
                    "device_type": device.device_type,
                    "role": getattr(device, "role", "control"),
                    "organization_id": str(device.organization_id),
                    "capabilities": device.capabilities or [],
                }
        except Exception as exc:
            logger.debug("[WS] 更新 Device 离线状态失败（fingerprint=%s）: %s", fingerprint, exc)
        return None

    @database_sync_to_async
    def _cleanup_device_routing_caches(self, fingerprint: str) -> None:
        """Sync: 清理断开设备的路由缓存（复用 _do_invalidate_routing_caches）。"""
        try:
            self._do_invalidate_routing_caches()
        except Exception as exc:
            logger.warning("[WS] routing cache cleanup failed (fp=%s): %s", fingerprint, exc)

    async def _update_device_offline(self, fingerprint: str) -> None:
        """Async: 标记设备 offline + 广播 + 清理缓存（无嵌套事件循环）。"""
        broadcast_info = await self._update_device_offline_db(fingerprint)

        if broadcast_info:
            try:
                from .protocol import DomainEvent, new_event_id
                event_id = new_event_id()
                envelope = build_envelope(
                    DomainEvent.DEVICE_STATUS,
                    event_id,
                    {
                        "device_id": broadcast_info["device_id"],
                        "user_id": broadcast_info["user_id"],
                        "fingerprint": broadcast_info["fingerprint"],
                        "name": broadcast_info["name"],
                        "device_type": broadcast_info["device_type"],
                        "role": broadcast_info["role"],
                        "status": "offline",
                        "capabilities": broadcast_info["capabilities"],
                    },
                    event_id=event_id,
                    organization_id=broadcast_info["organization_id"],
                )
                group_name = CHANNEL_SAFE_PATTERN.sub(".", f"user.{broadcast_info['user_id']}")
                await self.channel_layer.group_send(
                    group_name,
                    {"type": "broadcast_message", "message": envelope},
                )
                logger.info(
                    "[WS] 设备离线广播: %s -> offline (user=%s)",
                    broadcast_info.get("name"), broadcast_info["user_id"],
                )
            except Exception as exc:
                logger.debug("[WS] 设备离线广播失败: %s", exc)

        await self._cleanup_device_routing_caches(fingerprint)

    # G-077: Lua 脚本原子检查设备连接数并条件设置 grace key，
    # 消除 _decrement_device_conn_count 到 cache.set(grace_key) 之间的 TOCTOU 窗口。
    _GRACE_SET_LUA = """
    local conn_val = redis.call('GET', KEYS[2])
    if conn_val and tonumber(conn_val) > 0 then
        return 0
    end
    redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
    return 1
    """

    async def _schedule_disconnect_grace(self) -> None:
        """设置断开宽限期，延迟标记 daemon/device_runtime offline。

        在 Redis 中写入宽限标记，然后通过 Celery 延迟任务在宽限期到期后
        检查设备是否已重连。若未重连则标记 offline 并广播。

        G-077: 使用 Lua 脚本原子检查连接计数 + 设置 grace key，
        避免新连接 auth 的 cache.delete(grace_key) 被后续 cache.set 覆盖。

        若 Celery 调度失败，回退到立即标记 offline（保证最终一致性）。
        """
        fingerprint = self.device_fingerprint
        user_id = self.user_id
        try:
            disconnect_ts = time.time()
            grace_key = f"{DISCONNECT_GRACE_KEY_PREFIX}{fingerprint}"
            conn_key = device_connection_count_key(fingerprint)
            grace_ttl = DISCONNECT_GRACE_SECONDS * 5

            def _atomic_set_grace():
                from django_redis import get_redis_connection
                rc = get_redis_connection("default")
                return rc.eval(
                    GatewayConsumer._GRACE_SET_LUA, 2,
                    grace_key, conn_key,
                    str(disconnect_ts), grace_ttl,
                )

            set_result = await asyncio.to_thread(_atomic_set_grace)
            if not set_result:
                logger.info(
                    "[WS] grace key skipped: device=%s has active connections",
                    fingerprint,
                )
                return

            def _schedule_offline_task() -> None:
                from apps.tabtinspace.tasks import mark_device_offline_after_grace

                mark_device_offline_after_grace.apply_async(
                    kwargs={
                        'fingerprint': fingerprint,
                        'user_id': user_id,
                        'disconnect_ts': disconnect_ts,
                    },
                    countdown=DISCONNECT_GRACE_SECONDS,
                )

            await run_sync_io(_schedule_offline_task)
            logger.info(
                "[WS] scheduled disconnect grace: device=%s grace=%ds",
                fingerprint, DISCONNECT_GRACE_SECONDS,
            )
        except Exception as exc:
            logger.warning(
                "[WS] grace period scheduling failed, falling back to immediate offline (device=%s): %s",
                fingerprint, exc,
            )
            await self._update_device_offline(fingerprint)

    async def _increment_device_conn_count(self) -> None:
        """为当前设备增加活跃连接计数（多窗口场景下同一设备有多条 WS）。"""
        if not self.device_fingerprint:
            return
        try:
            def _do_incr():
                from django_redis import get_redis_connection
                redis_client = get_redis_connection("default")
                key = device_connection_count_key(self.device_fingerprint)
                redis_client.incr(key)
                redis_client.expire(key, DEVICE_CONN_TTL)
            await asyncio.to_thread(_do_incr)
            self._device_conn_counted = True
        except Exception as exc:
            logger.debug("[WS] 设备连接计数 INCR 失败（device=%s）: %s", self.device_fingerprint, exc)

    async def _decrement_device_conn_count(self) -> int:
        """递减设备连接计数，返回剩余连接数。返回 0 表示该设备已无活跃连接。"""
        if not self._device_conn_counted or not self.device_fingerprint:
            return 0
        try:
            def _do_decr():
                from django_redis import get_redis_connection
                redis_client = get_redis_connection("default")
                key = device_connection_count_key(self.device_fingerprint)
                remaining = redis_client.decr(key)
                if remaining <= 0:
                    redis_client.delete(key)
                return max(remaining, 0)
            return await asyncio.to_thread(_do_decr)
        except Exception as exc:
            logger.debug("[WS] 设备连接计数 DECR 失败（device=%s）: %s", self.device_fingerprint, exc)
            return 0

    async def receive(self, text_data: Optional[str] = None, bytes_data: Optional[bytes] = None) -> None:
        server_received_at = time.time()
        self._last_client_message_at = server_received_at

        if bytes_data is not None:
            await self._send_error("req_unknown", ERROR_SCHEMA_INVALID, "binary frames are not supported")
            return

        if not text_data:
            await self._send_error("req_unknown", ERROR_SCHEMA_INVALID, "empty payload")
            return

        payload_bytes = len(text_data.encode("utf-8"))
        if payload_bytes > MAX_MESSAGE_BYTES:
            # ：超限时尚未 json.loads，尽量从原文廉价抽取 request_id，
            # 避免客户端对不上 pending 而误判为可重试的 WS_REQUEST_TIMEOUT。
            request_id = "req_unknown"
            match = re.search(r'"request_id"\s*:\s*"([^"]{1,128})"', text_data)
            if match:
                request_id = match.group(1)
            await self._send_error(request_id, ERROR_SCHEMA_INVALID, "message too large")
            return

        try:
            data = json.loads(text_data)
        except json.JSONDecodeError:
            await self._send_error("req_unknown", ERROR_SCHEMA_INVALID, "invalid json")
            return

        await self._process_inbound_envelope(
            data,
            received_at=server_received_at,
            payload_bytes=payload_bytes,
        )

    async def _process_inbound_envelope(
        self,
        data: Any,
        *,
        received_at: float,
        payload_bytes: int,
    ) -> None:
        """Validate and dispatch one logical envelope.

        Reassembled envelopes enter here, so they receive the same schema,
        authentication, rate-limit and handler checks as ordinary frames.
        """
        try:
            envelope = validate_envelope(data, received_at=received_at)
        except Exception as exc:
            if hasattr(exc, "code"):
                details = getattr(exc, "details", None) or {}
                if (
                    getattr(exc, "code", None) == ERROR_SCHEMA_INVALID
                    and isinstance(details, dict)
                    and details.get("field") == "ts"
                    and data.get("type") == "relay_events"
                ):
                    record_relay_ws_timestamp_rejected(str(data.get("v", "unknown")))
                request_id = getattr(exc, "request_id", None) or "req_unknown"
                await self._send_error(request_id, exc.code, exc.message, details)
                return
            await self._send_error("req_unknown", ERROR_SCHEMA_INVALID, "invalid envelope")
            return

        envelope["_server_received_at"] = received_at
        envelope["_payload_bytes"] = payload_bytes
        envelope["_legacy_protocol"] = envelope.get("v") == 1

        message_type = envelope["type"]
        request_id = envelope["request_id"]
        self._last_message_type = message_type

        # G-028: record upstream message receipt after successful parsing
        record_message_received(message_type)

        if not self.authed and message_type != "auth":
            await self._send_error(request_id, ERROR_AUTH_REQUIRED, "auth required")
            return

        if message_type == FRAME_FRAGMENT_TYPE:
            payload = envelope["payload"]
            try:
                decoded = self._frame_fragment_reassembler.decode_payload(payload)
            except FrameFragmentError as exc:
                self._frame_fragment_reassembler.abort(payload.get("frame_id"))
                self._refresh_fragment_expiry_timer()
                await self._send_error(request_id, ERROR_SCHEMA_INVALID, str(exc))
                return
            if self._is_fragment_rate_limited(len(decoded[1])):
                self._frame_fragment_reassembler.abort(payload.get("frame_id"))
                self._refresh_fragment_expiry_timer()
                await self._send_error(
                    request_id,
                    ERROR_RATE_LIMITED,
                    "too many frame fragments, slow down",
                )
                return
            await self._handle_frame_fragment(envelope, decoded)
            return

        # G-035: 控制帧（ping/auth/resume）不计入普通业务限流。
        # frame_fragment 使用独立物理层额度，重组后的逻辑 envelope 在此仅计一次。
        if message_type not in _RATE_LIMIT_EXEMPT_TYPES and self._is_rate_limited():
            await self._send_error(request_id, ERROR_RATE_LIMITED, "too many messages, slow down")
            return

        handler = self._handlers().get(message_type)
        if handler is None:
            await self._send_error(request_id, ERROR_TYPE_UNKNOWN, f"unknown type: {message_type}")
            return

        # 本地开发弱网模拟：处理前入站延迟（模拟 RTT）。N>0 时并行计时、
        # receive 立刻返回，handler 用连接级锁串行；不影响 broadcast/stream/tick。
        # 仅 DEBUG + DEV_RESPONSE_LATENCY_MS>0 生效，生产环境走直接 await。
        await self._schedule_client_handler(envelope, handler, request_id)

    async def _handle_frame_fragment(
        self,
        envelope: Dict[str, Any],
        decoded: Tuple[Dict[str, Any], bytes],
    ) -> None:
        """Buffer one physical fragment and dispatch a complete logical envelope."""
        payload = envelope["payload"]
        try:
            reassembled = self._frame_fragment_reassembler.add(
                payload,
                received_at=envelope["_server_received_at"],
                decoded=decoded,
            )
        except FrameFragmentError as exc:
            self._frame_fragment_reassembler.abort(payload.get("frame_id"))
            self._refresh_fragment_expiry_timer()
            logger.warning(
                "[WS] fragmented frame rejected user=%s device=%s reason=%s",
                self.user_id,
                self.device_fingerprint,
                str(exc),
            )
            await self._send_error(
                envelope["request_id"],
                ERROR_SCHEMA_INVALID,
                str(exc),
            )
            return
        self._refresh_fragment_expiry_timer()
        if reassembled is None:
            return

        await self._process_inbound_envelope(
            reassembled.envelope,
            received_at=reassembled.received_at,
            payload_bytes=reassembled.total_bytes,
        )

    def _refresh_fragment_expiry_timer(self) -> None:
        handle = self._frame_fragment_expiry_handle
        if handle is not None:
            handle.cancel()
            self._frame_fragment_expiry_handle = None
        expires_at = self._frame_fragment_reassembler.next_pending_expiry_at()
        if expires_at is None:
            return
        loop = asyncio.get_running_loop()
        self._frame_fragment_expiry_handle = loop.call_later(
            max(0.0, expires_at - time.time()),
            self._expire_idle_frame_fragments,
        )

    def _expire_idle_frame_fragments(self) -> None:
        self._frame_fragment_expiry_handle = None
        self._frame_fragment_reassembler.purge_expired()
        self._refresh_fragment_expiry_timer()

    async def _schedule_client_handler(
        self,
        envelope: Dict[str, Any],
        handler: Any,
        request_id: str,
    ) -> None:
        """调度客户端消息的业务 handler。

        - 延迟为 0：直接 await（生产路径，零额外调度开销）
        - 延迟 > 0：create_task 各自倒计时，不挡 receive；到期后锁内串行 handler
        """
        from tabtin.dev_latency import get_latency_seconds

        delay = get_latency_seconds()
        if delay <= 0:
            await self._invoke_client_handler(envelope, handler, request_id)
            return

        process_after = time.time() + delay
        task = asyncio.create_task(
            self._run_delayed_client_handler(envelope, handler, request_id, process_after),
            name=f"ws_dev_latency_{request_id}",
        )
        self._track_task(task)

    async def _run_delayed_client_handler(
        self,
        envelope: Dict[str, Any],
        handler: Any,
        request_id: str,
        process_after: float,
    ) -> None:
        """入站延迟到期后，在连接级锁内串行执行 handler。"""
        remaining = process_after - time.time()
        if remaining > 0:
            await asyncio.sleep(remaining)
        async with self._client_handler_lock:
            await self._invoke_client_handler(envelope, handler, request_id)

    async def _invoke_client_handler(
        self,
        envelope: Dict[str, Any],
        handler: Any,
        request_id: str,
    ) -> None:
        try:
            await handler(envelope)
        except Exception as exc:
            logger.exception("[WS] handler error: %s", exc)
            await self._send_error(request_id, ERROR_INTERNAL, "internal error")

    # ==================================================================
    # Channel-layer event handler
    # ==================================================================

    async def broadcast_message(self, event: Dict[str, Any]) -> None:
        """Channel-layer event handler — filters by connection_scope.

        Scope filtering rules (update when adding new event types):
          - user scope (mobile/admin):  SKIP agent.action.* except approval request/resolved
          - device scope (daemon):      SKIP context.sync, table.events, docparse.* (UI-only events)
          - session scope (electron):   receive everything

        Events delivered to ALL scopes:
          - device.status, agent.stream.*, tracker.events

        Per-subscriber filtering for ``table.open.record_change`` events:
          - Subscriber filter: evaluate filter DSL against record data
          - RLS enforcement: evaluate RLS policies against record data

        ``exclude_channel``（layer event 字段，非 envelope）：与本连接
        ``channel_name`` 相同时跳过投递，用于 relay 广播抑制发送方回环。
        """
        exclude_channel = event.get("exclude_channel")
        if (
            isinstance(exclude_channel, str)
            and exclude_channel
            and exclude_channel == self.channel_name
        ):
            return

        message = event.get("message")
        if not isinstance(message, dict):
            return
        blocked_topics = getattr(self, "_revoked_collaboration_topics", {})
        topic = str(message.get("_topic") or "")
        if topic and any(topic in topics for topics in blocked_topics.values()):
            return
        msg_type = message.get("type", "")

        # Device action topics may still arrive through the legacy group path.
        # Fence both group and exact-channel delivery so a superseded connection
        # cannot receive work after a newer connection claims the same device.
        topic = message.get("_topic")
        device_action_fingerprint = None
        device_action_generation = None
        if isinstance(topic, str) and topic.startswith(_ACTION_DEVICE_PREFIX):
            fingerprint = topic[len(_ACTION_DEVICE_PREFIX):]
            event_fingerprint = event.get("device_action_fingerprint")
            if (
                event_fingerprint is not None
                and event_fingerprint != fingerprint
            ):
                return
            device_action_fingerprint = fingerprint
            device_action_generation = event.get("device_action_generation")

        if self.connection_scope == "user" and _should_filter_user_scope_event(msg_type):
            return
        if self.connection_scope == "device":
            if msg_type.startswith(ContextSyncEvent.PREFIX) or msg_type.startswith("table.events") or msg_type.startswith("docparse."):
                return

        # ：组织 / space topic 上的云资源敏感 payload fail-closed 丢弃
        if self._should_drop_leaked_cloud_context_sync(message):
            return

        # ---- Per-subscriber row filtering for table.open.record_change ----
        if msg_type == "table.open.record_change":
            filtered = self._filter_open_table_event(message)
            if filtered is None:
                return
            message = filtered

        try:
            if device_action_fingerprint is not None:
                delivered = await self._send_device_action_envelope(
                    message,
                    device_action_fingerprint,
                    device_action_generation,
                )
                if not delivered:
                    return
            else:
                await self._send_envelope(message)
        except Exception as exc:
            logger.debug("[WS] broadcast send failed: %s", exc)
            await self._record_runtime_event("send_failed", abnormal_reason="broadcast_send_failed")

    async def relay_message(self, event: Dict[str, Any]) -> None:
        """Channel-layer event handler for point-to-point relay (e.g. git.diff)."""
        message = event.get("message")
        if isinstance(message, dict):
            msg_type = message.get("type", "unknown")
            logger.info("[WS Gateway] relay type=%s to user=%s", msg_type, self.user_id)
            try:
                await self._send_envelope(message)
            except Exception:
                logger.warning("[WS Gateway] relay send failed user=%s type=%s", self.user_id, msg_type)
                await self._record_runtime_event("send_failed", abnormal_reason="relay_send_failed")

    async def session_collaboration_access_control(self, event: Dict[str, Any]) -> None:
        """同步共享授权边界；撤权剪订阅，恢复通知客户端重拉详情。"""
        session_id = str(event.get("session_id") or "")
        thread_id = str(event.get("thread_id") or "")
        share_id = str(event.get("share_id") or "")
        revoked = event.get("revoked") is True
        blocked_topics = getattr(self, "_revoked_collaboration_topics", {})
        if not revoked:
            blocked_topics.pop(share_id, None)
            self._revoked_collaboration_topics = blocked_topics
            try:
                await self._send_envelope(
                    {
                        "type": "session.collaboration.access_restored",
                        "payload": {
                            "object_id": share_id,
                            "version": int(event.get("version") or 0),
                            "access_epoch": int(event.get("access_epoch") or 0),
                        },
                    }
                )
            except Exception:
                logger.warning(
                    "[WS Gateway] collaboration restore notify failed user=%s share=%s",
                    self.user_id,
                    share_id,
                )
            return

        prefixes = (
            f"session.collaboration.{share_id}.",
            f"agent.session.{session_id}",
            f"agent.stream.{thread_id}" if thread_id else "",
        )
        removed_topics = set()
        for topic in list(self.subscriptions):
            if any(prefix and (topic == prefix or topic.startswith(prefix)) for prefix in prefixes):
                removed_topics.add(topic)
                await self._leave_group(f"topic.{topic}")
                self.subscriptions.discard(topic)
        blocked_topics[share_id] = removed_topics
        self._revoked_collaboration_topics = blocked_topics
        try:
            await self._send_envelope(
                {
                    "type": "session.collaboration.access_revoked",
                    "payload": {
                        "object_id": share_id,
                        "version": int(event.get("version") or 0),
                        "access_epoch": int(event.get("access_epoch") or 0),
                    },
                }
            )
        except Exception:
            logger.warning(
                "[WS Gateway] collaboration revoke notify failed user=%s share=%s",
                self.user_id,
                share_id,
            )

    # ==================================================================
    # Handler dispatch (delegates to handler modules)
    # ==================================================================

    def _handlers(self) -> Dict[str, Any]:
        if self._cached_handlers is None:
            asr_start, asr_audio, asr_stop = create_asr_stream_handler(self)
            tts_start, tts_text, tts_stop = create_tts_stream_handler(self)
            self._cached_handlers = {
                "auth":                     create_auth_handler(self),
                "subscribe":                create_subscribe_handler(self),
                "unsubscribe":              create_unsubscribe_handler(self),
                "resume":                   self._handle_resume,
                "ping":                     self._handle_ping,
                _PFE.ADMITTED:               self._handle_prompt_admitted,
                "channel.inbound":          create_channel_inbound_handler(self),
                "channel.outbound.ack":     create_channel_outbound_ack_handler(self),
                "channel.status":           create_channel_status_handler(self),
                _AAE.RESULT:                create_action_result_handler(self),
                _AAE.APPROVAL_REQUEST:      create_approval_request_handler(self),
                _AAE.APPROVAL_RESPONSE:     create_approval_response_handler(self),
                "asr.stream.start":         asr_start,
                "asr.stream.audio":         asr_audio,
                "asr.stream.stop":          asr_stop,
                "tts.stream.start":         tts_start,
                "tts.stream.text":          tts_text,
                "tts.stream.stop":          tts_stop,
                "git.status.report":        create_git_status_report_handler(self),
                "git.diff.request":         create_git_diff_request_handler(self),
                "git.diff.response":        create_git_diff_response_handler(self),
                "device.capabilities.report": create_device_capabilities_report_handler(self),
                "device.capabilities.refresh.ack": create_device_capability_refresh_ack_handler(self),
                "device.capabilities.refresh.result": create_device_capability_refresh_result_handler(self),
                "relay_events":             create_relay_events_handler(self),
                "localrt.user_response":    create_localrt_user_response_handler(self),
                "localrt.user_response.delivery": create_localrt_user_response_delivery_handler(self),
                "chat.send_message":        create_chat_send_message_handler(self),
                "chat.cancel":              create_chat_cancel_handler(self),
                "chat.pause":               create_chat_pause_control_handler(self, paused=True),
                "chat.resume":              create_chat_pause_control_handler(self, paused=False),
                "chat.session.presence":    create_session_viewing_handler(self),
                "subagent.cancel":          create_subagent_cancel_handler(self),
                "app_state":                self._handle_app_state,
                "app.update.progress":      self._handle_update_progress,  # UpdateWSMixin
            }
            # Monitor device events (Electron/Daemon → Backend)
            from apps.services.common.ws.handlers.monitor import create_monitor_event_handler
            monitor_handler = create_monitor_event_handler(self)
            for mon_type in (
                "agent.monitor.event",
                "agent.monitor.heartbeat",
                "agent.monitor.stream_ended",
                "agent.monitor.failed",
            ):
                self._cached_handlers[mon_type] = monitor_handler

        return self._cached_handlers

    # ---- trivial inline handlers ----

    @staticmethod
    def _parse_stream_id(stream_id: str) -> Tuple[int, int]:
        """Parse a Redis Stream ID ``<ms>-<seq>`` into a comparable tuple."""
        parts = stream_id.split("-", 1)
        return (int(parts[0]), int(parts[1]) if len(parts) > 1 else 0)

    async def _handle_resume(self, envelope: Dict[str, Any]) -> None:
        """Replay missed events from Redis Stream buffer after reconnection.

        Supports paginated resume: when results are truncated, the response
        includes ``next_cursor`` — the minimum last-stream-id across truncated
        topics.  The client should loop ``resume(last_event_id=next_cursor)``
        until ``next_cursor`` is absent.
        """
        request_id = envelope["request_id"]
        payload = envelope["payload"]
        last_event_id = payload.get("last_event_id")
        raw_topic_cursors = payload.get("topic_cursors")

        # No global or per-topic cursor → nothing to replay.
        if not last_event_id and raw_topic_cursors is None:
            await self._send_envelope(build_envelope(
                "resume.ok", request_id,
                {
                    "last_event_id": last_event_id,
                    "replayed": 0,
                    "has_more": False,
                    "next_cursors": {},
                },
            ))
            return

        from .protocol import is_stream_event_id
        if last_event_id and not is_stream_event_id(last_event_id):
            await self._send_envelope(build_envelope(
                "resume.ok", request_id,
                {
                    "last_event_id": last_event_id,
                    "replayed": 0,
                    "reason": "legacy_event_id",
                    "has_more": False,
                    "next_cursors": {},
                },
            ))
            return

        resume_topics = set(self.subscriptions)
        # user-scope 客户端在线时会自动加入 user / organization groups，这些不是
        # 显式 subscribe，仍必须进入断线续传，否则组织级只读通知会在线可达、
        # 重连丢失。
        if self.connection_scope == "user":
            if self.user_id:
                resume_topics.add(f"user.{self.user_id}")
            resume_topics.update(
                f"organization.{organization_id}"
                for organization_id in self.organization_ctx.all_ids
            )

        for topic in tuple(resume_topics):
            if topic.startswith(_ACTION_DEVICE_PREFIX):
                fingerprint = topic[len(_ACTION_DEVICE_PREFIX):]
                if not await self._is_current_device_action_receiver(fingerprint):
                    resume_topics.remove(topic)

        # G-024: 没有任何显式或自动 topic 时返回 warning。
        if not resume_topics:
            await self._send_envelope(build_envelope(
                "resume.ok", request_id,
                {"last_event_id": last_event_id, "replayed": 0, "warning": "no_subscriptions"},
            ))
            return

        if raw_topic_cursors is not None:
            if not isinstance(raw_topic_cursors, dict):
                await self._send_error(
                    request_id,
                    ERROR_SCHEMA_INVALID,
                    "topic_cursors must be an object",
                )
                return
            topic_cursors: list[tuple[str, str]] = []
            for topic, cursor in raw_topic_cursors.items():
                if not isinstance(topic, str) or not is_stream_event_id(cursor):
                    await self._send_error(
                        request_id,
                        ERROR_SCHEMA_INVALID,
                        "invalid topic cursor",
                    )
                    return
                if topic in resume_topics:
                    topic_cursors.append((topic, cursor))
        else:
            topic_cursors = [(topic, last_event_id) for topic in resume_topics]

        # G-036: batch XRANGE via Redis Pipeline instead of serial per-topic calls
        from .event_buffer import get_event_buffer, MAX_REPLAY_LIMIT, ReplayGapError
        buffer = get_event_buffer()

        resume_limit = MAX_REPLAY_LIMIT
        try:
            results, any_truncated = await database_sync_to_async(
                buffer.read_after_many
            )(topic_cursors, limit=resume_limit, raise_on_error=True)
        except ReplayGapError as exc:
            logger.warning("[WS] resume rejected by unresolved replay gap: topic=%s", exc.topic)
            await self._send_error(
                request_id,
                ERROR_REPLAY_GAP,
                "replay buffer has an unresolved gap; reload authoritative history",
                details={"topic": exc.topic, "recovery": "reload_history"},
            )
            return
        except Exception as exc:
            logger.warning("[WS] resume pipeline read failed: %s", exc)
            await self._send_error(
                request_id,
                ERROR_INTERNAL,
                "resume event buffer unavailable",
            )
            return

        total_replayed = 0
        # P1-29: collect prompt.forward stream IDs per topic for XDEL after replay
        prompt_forward_ack: Dict[str, list] = {}

        for topic, events in results.items():
            for stream_id, event_envelope in events:
                event_envelope["event_id"] = stream_id
                event_envelope["_topic"] = topic
                event_envelope["_delivery"] = "replay"

                # G-015: apply same scope + RLS filtering as broadcast_message
                evt_type = event_envelope.get("type", "")
                if self.connection_scope == "user" and _should_filter_user_scope_event(evt_type):
                    continue
                if self.connection_scope == "device":
                    if (evt_type.startswith(ContextSyncEvent.PREFIX)
                            or evt_type.startswith("table.events")
                            or evt_type.startswith("docparse.")):
                        continue
                # ：resume 与实时投递共用 fail-closed 防御
                if self._should_drop_leaked_cloud_context_sync(event_envelope):
                    continue
                if evt_type == "table.open.record_change":
                    filtered = self._filter_open_table_event(event_envelope)
                    if filtered is None:
                        continue
                    event_envelope = filtered

                if topic.startswith(_ACTION_DEVICE_PREFIX):
                    delivered = await self._send_device_action_envelope(
                        event_envelope,
                        topic[len(_ACTION_DEVICE_PREFIX):],
                    )
                    if not delivered:
                        continue
                else:
                    await self._send_envelope(event_envelope)
                total_replayed += 1

                if (
                    evt_type == _PFE.FORWARD
                    and not topic.startswith(_ACTION_DEVICE_PREFIX)
                ):
                    prompt_forward_ack.setdefault(topic, []).append(stream_id)

        # P1-29: XDEL successfully replayed prompt.forward events to prevent
        # duplicate execution on subsequent Daemon reconnects.
        if prompt_forward_ack:
            await self._ack_prompt_forwards(prompt_forward_ack)

        # G-059 + P0-10: paginated resume — compute next_cursor from truncated topics
        response_payload: Dict[str, Any] = {
            "last_event_id": last_event_id,
            "replayed": total_replayed,
        }
        next_cursors = {
            topic: events[-1][0]
            for topic, events in results.items()
            if len(events) >= resume_limit and events
        }
        response_payload["has_more"] = bool(next_cursors)
        response_payload["next_cursors"] = next_cursors
        if raw_topic_cursors is None and any_truncated and next_cursors:
            response_payload["truncated"] = True
            truncated_last_ids = list(next_cursors.values())
            if truncated_last_ids:
                response_payload["next_cursor"] = min(
                    truncated_last_ids,
                    key=self._parse_stream_id,
                )

        await self._send_envelope(build_envelope(
            "resume.ok", request_id, response_payload,
        ))

    @database_sync_to_async
    def _ack_prompt_forwards(self, topic_ids: Dict[str, list]) -> None:
        """XDEL replayed prompt.forward events from their Redis Streams (P1-29).

        Prevents duplicate Agent task execution when a Daemon reconnects
        multiple times — once replayed, the actionable events are removed.
        """
        try:
            from django_redis import get_redis_connection
            from .event_buffer import STREAM_KEY_PREFIX
            redis_client = get_redis_connection("default")
            for topic, stream_ids in topic_ids.items():
                if not stream_ids:
                    continue
                stream_key = f"{STREAM_KEY_PREFIX}{topic}"
                try:
                    redis_client.xdel(stream_key, *stream_ids)
                except Exception as exc:
                    logger.warning(
                        "[WS] prompt.forward XDEL failed for %s (%d ids): %s",
                        stream_key, len(stream_ids), exc,
                    )
        except Exception as exc:
            logger.warning("[WS] _ack_prompt_forwards failed: %s", exc)

    async def _handle_ping(self, envelope: Dict[str, Any]) -> None:
        request_id = envelope["request_id"]
        response = build_envelope("pong", request_id, {})
        await self._send_envelope(response)

    async def _handle_app_state(self, envelope: Dict[str, Any]) -> None:
        """移动端前后台状态帧（ 推送在线抑制）。

        foreground → 标记前台在线（抑制远程推送）；background → 立即清除
        （用户刚锁屏就该能收到审批/完成推送，不等 WS 断连 + TTL 过期）。
        仅 mobile 角色有意义，其他角色静默忽略。fire-and-forget，无 ack。
        """
        if self.role != 'mobile' or not self.user_id:
            return
        state = str((envelope.get("payload") or {}).get("state", ""))
        from apps.services.notification.push.presence import (
            clear_mobile_foreground,
            mark_mobile_foreground,
        )
        if state == "background":
            clear_mobile_foreground(self.user_id)
        elif state == "foreground":
            mark_mobile_foreground(self.user_id)

    async def _handle_prompt_admitted(self, envelope: Dict[str, Any]) -> None:
        """Delete one reliable forward only after the target host admitted it."""
        request_id = envelope["request_id"]
        payload = envelope.get("payload") or {}
        stream_id = payload.get("buffered_event_id")
        run_id = payload.get("run_id")
        thread_id = envelope.get("thread_id")
        fingerprint = self.device_fingerprint

        from .protocol import is_stream_event_id

        if (
            self.role not in {"electron", "daemon", "device_runtime"}
            or not getattr(self, "device_identity_verified", False)
            or not fingerprint
        ):
            await self._send_error(
                request_id,
                ERROR_PERMISSION_DENIED,
                "verified execution device required",
            )
            return
        if (
            not isinstance(stream_id, str)
            or not is_stream_event_id(stream_id)
            or not isinstance(run_id, str)
            or not isinstance(thread_id, str)
            or not thread_id
        ):
            await self._send_error(
                request_id,
                ERROR_SCHEMA_INVALID,
                "buffered_event_id, run_id and thread_id are required",
            )
            return
        if not await self._is_current_device_action_receiver(fingerprint):
            await self._send_error(
                request_id,
                ERROR_CONFLICT,
                "device connection is no longer the current delivery owner",
            )
            return

        outcome = await self._ack_admitted_prompt(
            fingerprint=fingerprint,
            stream_id=stream_id,
            run_id=run_id,
            thread_id=thread_id,
        )
        if outcome == "not_found":
            await self._send_error(
                request_id,
                ERROR_NOT_FOUND,
                "prompt admission does not match an owned execution run",
            )
            return
        if outcome == "mismatch":
            await self._send_error(
                request_id,
                ERROR_CONFLICT,
                "buffered prompt does not match the admitted run",
            )
            return
        if outcome == "failed":
            await self._send_error(
                request_id,
                ERROR_INTERNAL,
                "prompt admission acknowledgement failed",
            )
            return
        await self._send_envelope(build_envelope(
            f"{_PFE.ADMITTED}.ok",
            request_id,
            {"status": outcome, "buffered_event_id": stream_id, "run_id": run_id},
        ))

    @database_sync_to_async
    def _ack_admitted_prompt(
        self,
        *,
        fingerprint: str,
        stream_id: str,
        run_id: str,
        thread_id: str,
    ) -> str:
        """Validate the execution owner and frozen target before XDEL."""
        from django_redis import get_redis_connection

        from apps.chat.conversation.models import ChatSession
        from apps.services.agent_engine.models import ExecutionRun
        from apps.services.agent_engine.services.session_run_state_service import (
            SessionRunStateService,
        )
        from apps.services.common.agent_protocol.namespace import device_action_topic
        from .event_buffer import STREAM_KEY_PREFIX

        session_id = SessionRunStateService._normalize_session_id(thread_id)
        try:
            normalized_run_id = uuid.UUID(run_id)
        except (TypeError, ValueError):
            return "not_found"
        if not session_id:
            return "not_found"
        run = (
            ExecutionRun.objects.filter(
                run_id=normalized_run_id,
                session_id=session_id,
            )
            .only("user_id", "metadata")
            .first()
        )
        if run is None or str(run.user_id or "") != str(self.user_id or ""):
            return "not_found"

        metadata = run.metadata if isinstance(run.metadata, dict) else {}
        frozen_target = str(metadata.get("target_device_installation_id") or "")
        if frozen_target:
            if frozen_target != fingerprint:
                return "not_found"
        elif not ChatSession.objects.filter(
            id=session_id,
            user_id=self.user_id,
            target_device_installation_id=fingerprint,
        ).exists():
            # Runs created before target snapshots were introduced retain the
            # legacy personal-session ownership check.
            return "not_found"

        topic = device_action_topic(fingerprint)
        stream_key = f"{STREAM_KEY_PREFIX}{topic}"
        try:
            redis_client = get_redis_connection("default")
            entries = redis_client.xrange(
                stream_key,
                min=stream_id,
                max=stream_id,
                count=1,
            )
            if not entries:
                # A repeated request after a lost *.ok response is safe.
                return "already_admitted"
            _, fields = entries[0]
            raw = fields.get("e") or fields.get(b"e")
            if isinstance(raw, bytes):
                raw = raw.decode("utf-8")
            buffered = json.loads(raw) if isinstance(raw, str) else None
            buffered_payload = (
                buffered.get("payload") if isinstance(buffered, dict) else None
            )
            buffered_thread_id = (
                buffered.get("thread_id") if isinstance(buffered, dict) else None
            )
            buffered_session_id = SessionRunStateService._normalize_session_id(
                buffered_thread_id,
            )
            if (
                not isinstance(buffered, dict)
                or buffered.get("type") != _PFE.FORWARD
                or buffered.get("_topic") != topic
                or not isinstance(buffered_payload, dict)
                or str(buffered_payload.get("run_id") or "") != str(normalized_run_id)
                or buffered_session_id != session_id
            ):
                return "mismatch"
            deleted = redis_client.xdel(stream_key, stream_id)
            return "admitted" if deleted else "already_admitted"
        except Exception as exc:
            logger.warning(
                "[WS] prompt admission ACK failed device=%s run=%s event=%s: %s",
                fingerprint,
                run_id,
                stream_id,
                exc,
            )
            return "failed"

    # ==================================================================
    # Shared utilities (used by handler modules via consumer reference)
    # ==================================================================

    async def _send_envelope(self, envelope: Dict[str, Any]) -> None:
        await self.send(text_data=json.dumps(envelope, ensure_ascii=False))

    async def _send_error(
        self,
        request_id: str,
        code: str,
        message: str,
        details: Optional[Dict[str, Any]] = None,
    ) -> None:
        await self._send_envelope(build_error(request_id, code, message, details=details))

    def _normalize_group_name(self, group: str) -> str:
        return self._group_safe_pattern.sub(".", group)

    async def _join_group(self, group: str) -> None:
        safe_group = self._normalize_group_name(group)
        await self.channel_layer.group_add(safe_group, self.channel_name)
        self.joined_groups.add(safe_group)

    async def _is_current_device_action_receiver(
        self,
        fingerprint: str,
        event_generation: Any = None,
    ) -> bool:
        local_generation = self._device_action_ready_generation
        if (
            not fingerprint
            or fingerprint != self.device_fingerprint
            or (
                event_generation is not None
                and event_generation != local_generation
            )
        ):
            return False
        try:
            from .bus import is_device_action_ready_owner

            return await run_sync_io(
                is_device_action_ready_owner,
                fingerprint,
                self.channel_name,
                local_generation,
            )
        except Exception as exc:
            logger.warning(
                "[WS] device action owner check failed (fp=%s): %s",
                fingerprint,
                exc,
            )
            return False

    async def _send_device_action_envelope(
        self,
        message: Dict[str, Any],
        fingerprint: str,
        event_generation: Any = None,
    ) -> bool:
        local_generation = self._device_action_ready_generation
        if (
            not fingerprint
            or fingerprint != self.device_fingerprint
            or (
                event_generation is not None
                and event_generation != local_generation
            )
        ):
            return False

        from .protocol import is_stream_event_id

        stream_id = message.get("event_id")
        buffered = isinstance(stream_id, str) and is_stream_event_id(stream_id)

        # Legacy exact events have no recovery copy, so the originally
        # selected generation must finish even if a reconnect wins meanwhile.
        # Reliable exact events are buffered and instead compete with resume
        # under the route lock below: exactly one current owner sends + ACKs.
        if event_generation is not None and not buffered:
            await self._send_envelope(message)
            return True

        from .bus import (
            acquire_device_action_delivery_lock,
            release_device_action_delivery_lock,
        )

        lock = await run_sync_io(
            acquire_device_action_delivery_lock,
            fingerprint,
            self.channel_name,
            local_generation,
        )
        if lock is None:
            return False
        try:
            await self._send_envelope(message)
            return True
        finally:
            await run_sync_io(release_device_action_delivery_lock, lock)

    async def _leave_group(self, group: str) -> None:
        safe_group = self._normalize_group_name(group)
        await self.channel_layer.group_discard(safe_group, self.channel_name)
        self.joined_groups.discard(safe_group)

    # ----  cloud context.sync fail-closed ----

    @staticmethod
    def _should_drop_leaked_cloud_context_sync(message: Dict[str, Any]) -> bool:
        """Drop cloud-resource payloads incorrectly published to org/space topics.

        Shared by ``broadcast_message`` and ``_handle_resume`` so realtime and
        replay stay consistent (fail-closed).
        """
        try:
            from apps.tabtinspace.services.context_sync_publisher import (
                should_drop_leaked_cloud_context_sync,
            )
            return should_drop_leaked_cloud_context_sync(message)
        except Exception:
            # 防御层自身故障时 fail-closed：若 topic 看起来像 org/space context.sync
            # 且带云资源字段，仍丢弃。
            topic = message.get("_topic") if isinstance(message, dict) else None
            resource_type = message.get("resource_type") if isinstance(message, dict) else None
            if (
                isinstance(topic, str)
                and topic.startswith(f"{ContextSyncEvent.PREFIX}.")
                and ".user." not in topic
                and resource_type in {"tabdoc", "tabdata", "tabfiles"}
            ):
                logger.warning(
                    "[WS] fail-closed drop cloud context.sync on org/space topic=%s type=%s",
                    topic,
                    message.get("type"),
                )
                return True
            return False

    # ---- Per-subscriber row filtering for table.open events ----

    def _filter_open_table_event(self, message: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Filter a ``table.open.record_change`` event through subscriber filter and RLS.

        Returns a copy of *message* containing only the records that pass
        filter + RLS checks, or ``None`` to suppress the event entirely.

        G-016: only authorized records are delivered (not the full bulk payload).
        G-017: non-dict records are excluded (fail-closed).

        This method is intentionally synchronous and performs zero I/O.
        RLS policies are pre-fetched at subscription time.
        """
        open_subs: Optional[Dict] = getattr(self, '_open_table_subscriptions', None)
        if not open_subs:
            return message

        payload = message.get("payload", {})
        table_id = payload.get("table_id") or message.get("table_id")
        if not table_id:
            return message

        topic = f"table.open.{table_id}"
        sub_ctx = open_subs.get(topic)
        if not sub_ctx:
            return message

        if sub_ctx.get('rls_fetch_failed'):
            return None

        records = payload.get("records")
        event_type = payload.get("event")

        if event_type == "DELETE":
            if sub_ctx.get('rls_policies'):
                return None
            return message

        if not records:
            return message

        filter_config = sub_ctx.get('filter')
        rls_policies = sub_ctx.get('rls_policies')

        passing_records = []

        for record in records:
            if not isinstance(record, dict):
                continue

            if filter_config:
                from .realtime_filter import matches_filter
                if not matches_filter(record, filter_config):
                    continue

            if rls_policies:
                try:
                    from apps.tabdata.services.rls_service import RLSService

                    check_data = record.get('fields', record)
                    all_pass = True
                    for policy in rls_policies:
                        condition = policy.get('_resolved_condition', policy['condition'])
                        normalized = RLSService._normalize_condition(condition)
                        if not RLSService._check_record_against_condition(
                            check_data, normalized,
                        ):
                            all_pass = False
                            break
                    if not all_pass:
                        continue
                except Exception as exc:
                    logger.debug(
                        "[WS] RLS check failed for table=%s, skipping record (fail-closed): %s",
                        sub_ctx.get('table_id'), exc,
                    )
                    continue

            passing_records.append(record)

        if not passing_records:
            return None

        return {**message, "payload": {**payload, "records": passing_records}}

    # ---- 速率限制（滑动窗口 deque 优化版）----

    def _is_rate_limited(self) -> bool:
        """滑动窗口速率限制。deque 头部弹出 amortized O(1)。"""
        now = time.monotonic()
        cutoff = now - RATE_LIMIT_WINDOW_SECONDS
        while self._message_timestamps and self._message_timestamps[0] <= cutoff:
            self._message_timestamps.popleft()
        if len(self._message_timestamps) >= RATE_LIMIT_MAX_MESSAGES:
            return True
        self._message_timestamps.append(now)
        return False

    def _is_fragment_rate_limited(self, decoded_bytes: int) -> bool:
        """Physical fragment quota, isolated from logical business messages."""
        now = time.monotonic()
        cutoff = now - RATE_LIMIT_WINDOW_SECONDS
        while self._fragment_timestamps and self._fragment_timestamps[0] <= cutoff:
            self._fragment_timestamps.popleft()
        while self._fragment_byte_timestamps and self._fragment_byte_timestamps[0][0] <= cutoff:
            _, expired_bytes = self._fragment_byte_timestamps.popleft()
            self._fragment_window_bytes -= expired_bytes
        if (
            len(self._fragment_timestamps) >= FRAGMENT_RATE_LIMIT_MAX_MESSAGES
            or self._fragment_window_bytes + decoded_bytes > FRAGMENT_RATE_LIMIT_MAX_BYTES
        ):
            return True
        self._fragment_timestamps.append(now)
        self._fragment_byte_timestamps.append((now, decoded_bytes))
        self._fragment_window_bytes += decoded_bytes
        return False

    # ---- 认证超时 ----

    def _cancel_auth_timeout(self) -> None:
        """认证成功后取消超时计时器。"""
        if self._auth_timeout_handle:
            self._auth_timeout_handle.cancel()
            self._auth_timeout_handle = None
        # RV-003: 认证成功，释放未认证连接配额
        self._release_unauthenticated_slot()

    def _release_unauthenticated_slot(self) -> None:
        """释放此连接占用的未认证连接配额（幂等）。"""
        if not self._unauth_counted:
            return
        self._unauth_counted = False
        GatewayConsumer._unauthenticated_connections = max(
            0, GatewayConsumer._unauthenticated_connections - 1
        )
        ip = self._client_ip
        if ip:
            count = GatewayConsumer._per_ip_unauthenticated.get(ip, 0) - 1
            if count <= 0:
                GatewayConsumer._per_ip_unauthenticated.pop(ip, None)
            else:
                GatewayConsumer._per_ip_unauthenticated[ip] = count

    # ---- 服务端心跳 ----

    async def _start_heartbeat(self) -> None:
        """认证成功后启动心跳。由 auth handler 调用。"""
        await self._join_recovery_group()
        self._schedule_next_heartbeat()

    async def _join_recovery_group(self) -> None:
        """加入断路器恢复信号 group，收到 resume_hint 时通过 broadcast_message 自动转发给客户端。"""
        try:
            from .bus import RECOVERY_SIGNAL_GROUP
            await self._join_group(RECOVERY_SIGNAL_GROUP)
        except Exception as exc:
            logger.debug("[WS] Failed to join recovery signal group: %s", exc)

    def _schedule_next_heartbeat(self) -> None:
        """调度下一次心跳 tick。"""
        try:
            loop = asyncio.get_running_loop()
            # G-006: 使用 create_task + _track_task 替代 ensure_future，
            # 确保心跳 task 纳入 _background_tasks，disconnect 时可取消。
            self._heartbeat_handle = loop.call_later(
                HEARTBEAT_INTERVAL_SECONDS,
                lambda: self._track_task(loop.create_task(self._send_heartbeat())),
            )
        except RuntimeError:
            pass  # 事件循环已关闭

    async def _send_heartbeat(self) -> None:
        """发送 tick 消息，失败则关闭僵尸连接；检测客户端是否长时间无消息。

        RT-04: 每 JWT_RECHECK_INTERVAL_SECONDS 重验 JWT 有效性，
        过期或用户被禁用时主动断开连接。
        """
        if not self.authed:
            return

        client_silent_seconds = time.time() - self._last_client_message_at
        if client_silent_seconds > 120:
            logger.warning(
                "[WS] client silent for %.0fs, closing connection user=%s",
                client_silent_seconds, self.user_id,
            )
            await self._record_runtime_event("heartbeat_timeout", abnormal_reason="client_silent")
            await self.close(code=4003)
            return

        # RT-04: periodic JWT re-verification + Wave 1 动态 membership 同步
        now_time = time.time()
        if (self._ws_auth_token
                and now_time - self._last_jwt_recheck_at >= JWT_RECHECK_INTERVAL_SECONDS):
            from .handlers.auth import recheck_jwt_validity, sync_organization_membership
            token_valid = await recheck_jwt_validity(self)
            self._last_jwt_recheck_at = now_time
            if not token_valid:
                await self._send_error(
                    f"tick_{int(now_time)}", ERROR_AUTH_TOKEN_EXPIRED,
                    "token expired",
                )
                await self.close(code=4001)
                return
            # R1-00: token 有效后再做 organization membership diff；sync 内部
            # 若发现用户已被踢出所有 organization 会自行 send_error + close，
            # 这里若连接已关就直接退出心跳循环。
            try:
                await sync_organization_membership(self)
            except Exception as exc:
                logger.warning(
                    "[WS] organization membership sync failed (user=%s): %s",
                    self.user_id, exc,
                )
            if not self.authed:
                return

        try:
            await self._send_envelope(build_envelope(
                "tick", f"tick_{int(time.time())}",
                {"server_ts": int(time.time())},
            ))
            await self._refresh_connection_ttl()
            await self._refresh_runtime_snapshot()
            self._schedule_next_heartbeat()
        except Exception:
            logger.warning("[WS] heartbeat send failed, closing connection user=%s", self.user_id)
            await self._record_runtime_event("heartbeat_timeout", abnormal_reason="heartbeat_send_failed")
            await self.close(code=4002)

    # ---- 连接数限制 ----

    @property
    def _conn_member(self) -> str:
        """Sorted Set member: 优先 device_fingerprint（跨重启不变），fallback channel_name。"""
        return self.device_fingerprint or self.channel_name

    @property
    def _conn_count_key(self) -> Optional[str]:
        """Redis key for per-user/channel connection counting.

        G-011: channel 角色使用 organization_id 维度的独立计数 key，
        确保内部服务异常重连也受到连接数限制。
        """
        if self.user_id:
            return f"{CONN_COUNT_KEY_PREFIX}{self.user_id}"
        if self.role == "channel" and self.organization_id:
            return f"{CONN_COUNT_KEY_PREFIX}channel:{self.organization_id}"
        return None

    async def _increment_connection_count(self) -> bool:
        """注册连接并检查是否超限。

        使用 Redis Sorted Set，member 为 device_fingerprint（同设备重连自动覆盖），
        score 为时间戳。每次先清理过期条目，再检查数量，最后注册自身。
        """
        key = self._conn_count_key
        if not key:
            return True
        try:
            from django_redis import get_redis_connection
            now = time.time()
            cutoff = now - CONN_COUNT_TTL
            conn_member = self._conn_member
            lua_script = """
            redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
            local count = redis.call('ZCARD', KEYS[1])
            if count >= tonumber(ARGV[2]) then
                return 0
            end
            redis.call('ZADD', KEYS[1], ARGV[3], ARGV[4])
            redis.call('EXPIRE', KEYS[1], ARGV[5])
            return 1
            """

            _key = key

            def _do_increment():
                redis_client = get_redis_connection("default")
                return redis_client.eval(
                    lua_script, 1, _key,
                    cutoff, MAX_CONNECTIONS_PER_USER, now,
                    conn_member, CONN_COUNT_TTL * 2,
                )

            allowed = await asyncio.to_thread(_do_increment)
            if not allowed:
                return False
            self._conn_counted = True
            self._conn_registered_at = now
            return True
        except Exception as exc:
            # RT-21: Redis 故障时 Fail-Close — 使用进程级计数器兜底
            logger.warning("[WS] connection count Redis failed, using process-level fallback: %s", exc)
            user_key = self.user_id or (f"channel:{self.organization_id}" if self.role == "channel" else None)
            if not user_key:
                return True
            current = GatewayConsumer._per_user_connections.get(user_key, 0)
            if current >= GatewayConsumer._PROCESS_LEVEL_MAX_PER_USER:
                logger.warning("[WS] process-level connection limit reached for %s (%d)", user_key, current)
                return False
            GatewayConsumer._per_user_connections[user_key] = current + 1
            self._conn_counted = True
            self._conn_registered_at = now
            return True

    async def _refresh_connection_ttl(self) -> None:
        """心跳时更新本连接的时间戳，保持活跃状态。"""
        if not self._conn_counted:
            return
        key = self._conn_count_key
        if not key:
            return
        try:
            from django_redis import get_redis_connection
            conn_member = self._conn_member
            now = time.time()

            def _do_refresh():
                redis_client = get_redis_connection("default")
                redis_client.zadd(key, {conn_member: now})
                if self._device_conn_counted and self.device_fingerprint:
                    redis_client.expire(
                        device_connection_count_key(self.device_fingerprint),
                        DEVICE_CONN_TTL,
                    )

            await asyncio.to_thread(_do_refresh)
        except Exception as exc:
            logger.warning("[WS] connection TTL refresh failed (user=%s): %s", self.user_id, exc)

        # 仅已订阅精确设备 topic 的当前连接可续期 readiness；旧连接不得抢回
        # 新连接写入的 channel_name，退订后的普通用户连接也不能保持在线假象。
        fp = self.device_fingerprint
        action_topic = f"agent.action.device.{fp}" if fp else ""
        if (
            fp
            and self.role in {'daemon', 'device_runtime', 'electron'}
            and action_topic in self.subscriptions
        ):
            try:
                from .bus import renew_device_action_ready

                if self._device_action_ready_generation is not None:
                    renewed_generation = await run_sync_io(
                        renew_device_action_ready,
                        fp,
                        self.channel_name,
                        self._device_action_ready_generation,
                    )
                    if renewed_generation is not None:
                        self._device_action_ready_generation = renewed_generation
            except Exception as exc:
                logger.warning("[WS] device_action_ready_key heartbeat renewal failed (fp=%s): %s", fp, exc)

        #  推送在线抑制：移动端前台在线态续期（后台帧清除后不复活）
        if self.role == 'mobile' and self.user_id:
            from apps.services.notification.push.presence import refresh_mobile_foreground
            refresh_mobile_foreground(self.user_id)

    @property
    def _runtime_connection_id(self) -> str:
        from .runtime_snapshot import connection_id_for_channel

        return connection_id_for_channel(self.channel_name)

    async def _refresh_runtime_snapshot(self) -> None:
        if not self.authed:
            return
        try:
            from .runtime_snapshot import upsert_connection_snapshot
            await asyncio.to_thread(
                upsert_connection_snapshot,
                connection_id=self._runtime_connection_id,
                user_id=self.user_id or "",
                device_id=self.device_fingerprint or "",
                daemon_id=self.device_fingerprint if self.role in {"daemon", "device_runtime"} else "",
                instance_id=getattr(settings, "WS_INSTANCE_ID", "") or "",
                client_type=self._ws_client_type or self.role or "",
                client_version=self._ws_client_version or "",
                subscriptions_count=len(self.subscriptions),
                status="connected",
            )
        except Exception as exc:
            logger.debug("[WS] runtime snapshot refresh skipped: %s", exc)

    async def _mark_runtime_snapshot_connected(self, *, client_type: str = "", client_version: str = "") -> None:
        self._ws_connected_at = time.time()
        self._ws_client_type = client_type or self.role or ""
        self._ws_client_version = client_version or ""
        await self._refresh_runtime_snapshot()
        await self._record_runtime_event("connected")

    async def _mark_runtime_snapshot_disconnected(self, code: int | None) -> None:
        if not self.authed:
            return
        close_reason = _classify_close_code(code)
        abnormal_reason = "" if close_reason == "normal" else close_reason
        try:
            from .runtime_snapshot import mark_connection_disconnected
            await asyncio.to_thread(
                mark_connection_disconnected,
                connection_id=self._runtime_connection_id,
                close_reason=close_reason,
                abnormal_reason=abnormal_reason,
            )
        except Exception as exc:
            logger.debug("[WS] runtime snapshot disconnect skipped: %s", exc)
        await self._record_runtime_event("disconnected", close_reason=close_reason, abnormal_reason=abnormal_reason)

    async def _record_runtime_event(self, event_type: str, **fields: Any) -> None:
        try:
            from .runtime_snapshot import record_event
            await asyncio.to_thread(
                record_event,
                event_type,
                connection_id=self._runtime_connection_id,
                user_id=self.user_id or "",
                device_id=self.device_fingerprint or "",
                daemon_id=self.device_fingerprint if self.role in {"daemon", "device_runtime"} else "",
                instance_id=getattr(settings, "WS_INSTANCE_ID", "") or "",
                client_type=self._ws_client_type or self.role or "",
                client_version=self._ws_client_version or "",
                subscriptions_count=len(self.subscriptions),
                ip=self._client_ip or "",
                **fields,
            )
        except Exception as exc:
            logger.debug("[WS] runtime event sample skipped: %s", exc)

    async def _decrement_connection_count(self) -> None:
        """移除本连接的注册记录。

        使用条件删除：只在 score 未被更新（即没有同 device 的更新连接覆盖）时才移除，
        避免旧连接 disconnect 误删新连接的条目。
        """
        if not self._conn_counted:
            return
        key = self._conn_count_key
        if not key:
            return
        try:
            from django_redis import get_redis_connection
            conn_member = self._conn_member
            registered_at = self._conn_registered_at
            lua_script = """
            local score = redis.call('ZSCORE', KEYS[1], ARGV[1])
            if score and tonumber(score) <= tonumber(ARGV[2]) then
                redis.call('ZREM', KEYS[1], ARGV[1])
            end
            """

            def _do_decrement():
                redis_client = get_redis_connection("default")
                redis_client.eval(
                    lua_script, 1, key,
                    conn_member, registered_at,
                )

            await asyncio.to_thread(_do_decrement)
        except Exception as exc:
            logger.warning("[WS] connection count decrement failed (user=%s): %s", self.user_id, exc)

        # RT-21: 同步递减进程级计数器（无论 Redis 路径是否成功，都维护此计数器一致性）
        user_key = self.user_id or (f"channel:{self.organization_id}" if self.role == "channel" else None)
        if user_key and user_key in GatewayConsumer._per_user_connections:
            GatewayConsumer._per_user_connections[user_key] = max(
                0, GatewayConsumer._per_user_connections[user_key] - 1
            )
            if GatewayConsumer._per_user_connections[user_key] == 0:
                GatewayConsumer._per_user_connections.pop(user_key, None)

    # ---- 后台任务追踪 ----

    def _track_task(self, task: asyncio.Task) -> None:
        """追踪后台任务，添加异常日志回调。"""
        self._background_tasks.add(task)
        task.add_done_callback(self._on_task_done)

    def _on_task_done(self, task: asyncio.Task) -> None:
        """后台任务完成回调：记录未捕获的异常。"""
        self._background_tasks.discard(task)
        if task.cancelled():
            return
        exc = task.exception()
        if exc:
            logger.error("[WS] background task failed: %s", exc, exc_info=exc)

    # ---- 资源级权限校验 ----

    async def _check_table_access(
        self,
        table_id: str,
        *,
        parent_document_id: str | None = None,
    ) -> bool:
        """校验用户对 table 有 viewer 级访问（对齐 HTTP ``check_table_permission``）。

         后云盘/组织级新建表可为 org-only（``space_id=NULL``）：HTTP 经
        Organization viewer 放行，旧实现在 ``space_id`` 为空时硬拒，导致
        ``table.events`` 稳定 ``WS_1005``（见 ）。有 ``space_id`` 时也不再
        只认 SpaceMembership——owner / TablePermission 须与 HTTP 一致放行。
        """
        if not self.organization_ctx or not self.user_id:
            return False
        try:
            from apps.tabdata.models import Table

            table_organization_id = await database_sync_to_async(
                lambda: Table.objects.filter(id=table_id)
                .values_list('organization_id', flat=True)
                .first()
            )()
            if not table_organization_id:
                return False
            if not self.organization_ctx.is_member(table_organization_id):
                return False

            user = self.user
            if user is None:
                from django.contrib.auth import get_user_model

                UserModel = get_user_model()
                user = await database_sync_to_async(
                    lambda: UserModel.objects.filter(id=self.user_id).first()
                )()
                if not user:
                    return False

            from apps.tabdata.services.base import BaseService as TabDataBaseService
            from apps.tabdata.request_context import parent_document_access_context

            def _check_access() -> bool:
                with parent_document_access_context(parent_document_id):
                    return TabDataBaseService(user=user).check_table_permission(
                        str(table_id), 'viewer',
                    )

            has_access = await database_sync_to_async(
                _check_access,
            )()
            if not has_access:
                logger.info(
                    "[WS] table access denied: table=%s user=%s",
                    table_id, self.user_id,
                )
            return has_access
        except Exception as exc:
            logger.warning("[WS] table access check failed: %s", exc)
            return False

    async def _check_table_organization(
        self,
        table_id: str,
        *,
        parent_document_id: str | None = None,
    ) -> bool:
        return await self._check_table_access(
            table_id,
            parent_document_id=parent_document_id,
        )

    async def _check_document_organization(self, document_id: str) -> bool:
        """校验 document_id 是否属于用户所属的 organization。"""
        if not self.organization_ctx:
            return False
        try:
            from apps.tabdoc.models import Document
            doc = await database_sync_to_async(
                lambda: Document.objects.filter(id=document_id).first()
            )()
            if not doc:
                return False
            return self.organization_ctx.is_member(doc.organization_id)
        except Exception as exc:
            logger.warning("[WS] document organization check failed: %s", exc)
            return False
