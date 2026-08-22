"""
WS protocol helpers: envelope, validation, and errors.

Device Identity Convention
--------------------------
The ``device_id`` field in WS envelopes carries the **Device.fingerprint**
(a client-generated persistent identifier such as ``electron-{uuid}`` or
``daemon-{uuid}``), **not** the Device model's database UUID primary key.

REST API path parameters named ``device_id`` (e.g. ``/devices/{device_id}``)
use the Device model's UUID.  These are two distinct identifiers:

- **fingerprint**: used in WS auth, heartbeat, topic subscription, status updates
- **Device.id (UUID)**: used in REST CRUD, binding, SSH endpoints
"""

from __future__ import annotations

import re
import time
import uuid
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Dict, FrozenSet, Optional, Protocol, Set, runtime_checkable

if TYPE_CHECKING:
    from .organization_context import OrganizationContext

PROTOCOL_VERSION = 1
SUPPORTED_PROTOCOL_VERSIONS = frozenset({1})  # G-072: version negotiation — add v2 here during rollout
MAX_MESSAGE_BYTES = 1_000_000
MAX_TS_DRIFT_SECONDS = 300  # ±5 分钟，防御时钟漂移和重放

CHANNEL_SAFE_PATTERN = re.compile(r"[^A-Za-z0-9\-\._]")

# Fingerprint 格式校验：允许字母、数字、连字符、下划线、点，最长 255 字符。
# WS auth handler 和 HTTP device API 共用此正则。
FINGERPRINT_SAFE = re.compile(r'^[A-Za-z0-9\-\._]{1,255}$')

SERVER_DEVICE_ID = "server"
SERVER_ROLE = "backend"

ALLOWED_ROLES = {"electron", "web", "mobile", "admin", "backend", "channel", "daemon", "device_runtime", "open_api"}

# 连接作用域：决定事件分发粒度
CONNECTION_SCOPE_USER = "user"           # 用户级（mobile/admin 客户端，接收 organization 事件）
CONNECTION_SCOPE_SESSION = "session"     # 会话级（订阅了特定 thread 的 Electron/Daemon）
CONNECTION_SCOPE_DEVICE = "device"       # 设备级（Daemon / device_runtime，仅接收设备相关事件）

ERROR_AUTH_REQUIRED = "WS_1000_AUTH_REQUIRED"
ERROR_AUTH_INVALID = "WS_1001_AUTH_INVALID"
ERROR_VERSION_UNSUPPORTED = "WS_1002_VERSION_UNSUPPORTED"
ERROR_SCHEMA_INVALID = "WS_1003_SCHEMA_INVALID"
ERROR_TYPE_UNKNOWN = "WS_1004_TYPE_UNKNOWN"
ERROR_PERMISSION_DENIED = "WS_1005_PERMISSION_DENIED"
ERROR_NOT_FOUND = "WS_1006_NOT_FOUND"
ERROR_RATE_LIMITED = "WS_1007_RATE_LIMITED"
ERROR_CONFLICT = "WS_1008_CONFLICT"
ERROR_TIMEOUT = "WS_1009_TIMEOUT"
ERROR_INTERNAL = "WS_1010_INTERNAL_ERROR"
ERROR_CONNECTION_LIMIT = "WS_1011_CONNECTION_LIMIT"
ERROR_SUBSCRIPTION_LIMIT = "WS_1012_SUBSCRIPTION_LIMIT"
ERROR_AUTH_TOKEN_EXPIRED = "WS_1013_TOKEN_EXPIRED"
ERROR_REPLAY_GAP = "WS_1014_REPLAY_GAP"

# ---- 连接与订阅限制 ----
MAX_CONNECTIONS_PER_USER = 10  # 每用户最大并发连接数
MAX_SUBSCRIPTIONS_PER_CONNECTION = 50  # 每连接最大订阅数


# ---------------------------------------------------------------------------
# Structural Protocol for WS Consumer
# ---------------------------------------------------------------------------
# Mixins and handler modules access GatewayConsumer attributes implicitly.
# This Protocol formalises the contract so that type-checkers can verify
# correctness when the consumer shape changes.
# ---------------------------------------------------------------------------
@runtime_checkable
class GatewayConsumerProtocol(Protocol):
    """Structural interface that Mixins/Handlers may rely on.

    Covers the subset of GatewayConsumer surface area accessed by
    handler factories and Mixin classes.  Auth handler is excluded
    because it accesses too many internal lifecycle methods.
    """

    # ---- identity ----
    authed: bool
    user: Any
    user_id: Optional[str]
    organization_ctx: "OrganizationContext"
    role: Optional[str]
    device_fingerprint: Optional[str]
    connection_scope: Optional[str]

    @property
    def organization_id(self) -> Optional[str]: ...
    @property
    def organization_ids(self) -> FrozenSet[str]: ...

    # ---- groups & subscriptions ----
    channel_name: str
    joined_groups: Set[str]
    subscriptions: Set[str]
    capabilities: Set[str]

    # ---- channel layer ----
    @property
    def channel_layer(self) -> Any: ...

    # ---- messaging helpers ----
    async def send(self, text_data: str = ..., bytes_data: bytes = ..., close: bool = ...) -> None: ...
    async def _send_envelope(self, envelope: Dict[str, Any]) -> None: ...
    async def _send_error(
        self, request_id: str, code: str, message: str,
        details: Optional[Dict[str, Any]] = ...,
    ) -> None: ...

    # ---- lifecycle helpers (used by auth & mixin) ----
    async def close(self, code: int = ...) -> None: ...
    def _track_task(self, coro: Any) -> None: ...


from apps.services.common.agent_protocol.namespace import (
    STREAM_CAPABILITY as _STREAM_CAP,
    ACTION_CAPABILITY as _ACTION_CAP,
)


class ContextSyncEvent:
    """context.sync topic 前缀 — 用于出站事件推送和订阅校验。"""

    PREFIX = "context.sync"


class DomainEvent:
    """跨域 WS 事件（完整路径）— 与前端 DomainEvents 对齐。"""

    DEVICE_STATUS = "device.status"
    DEVICE_UNBOUND = "device.unbound"
    CONTEXT_SYNC = ContextSyncEvent.PREFIX

TOPIC_CAPABILITIES = {
    ContextSyncEvent.PREFIX: ContextSyncEvent.PREFIX,
    _STREAM_CAP: _STREAM_CAP,
    # agent.session.{session_id} — session-level 订阅，复用 agent.stream capability
    # （与 agent.stream 同属 Chat 运行态订阅域，客户端仅需申请一次 capability）。
    "agent.session": _STREAM_CAP,
    f"{_ACTION_CAP}.device": _ACTION_CAP,
    _ACTION_CAP: _ACTION_CAP,
    "table.events": "table.events",
    "table.open": "table.open",
    "doc.events": "doc.events",
    "share.events": "share.events",
    "session.collaboration": "session.collaboration",
    "slide.events": "slide.events",
    "scheduled.tasks": "scheduled.tasks",
    "trace.stream": "trace.stream",
    "channel.inbound": "channel.inbound",
    "channel.outbound": "channel.outbound",
    "channel.outbound.ack": "channel.outbound",
    "channel.status": "channel.status",
    "docparse.events": "docparse.events",
    "asr.stream": "asr.stream",
    "tts.stream": "tts.stream",
    # Tracker：topic 为 tracker.events.{organization_id}（波次 4 Stage 2.3 一刀切，legacy goal.events / agenda.events 已下线）
    "tracker.events": "tracker.events",
    "ssh.stream": "ssh.stream",  # G-068: dedicated capability instead of reusing agent.stream
    "agent.external": "agent.action",
    "git.status": "git.status",
    "notifications": "notifications",
    "extension.events": "extension.events",
    "billing.events": "billing.events",
    "media.pipeline": "media.pipeline",
    "device.capabilities.refresh": "device.capabilities.refresh",
    # CMI-007: phone.* topics — TabPhone 设备事件推送
    "phone.sms": "phone.sms",
    "phone.media": "phone.media",
    "phone.call": "phone.call",
    "phone.notification": "phone.notification",
    "phone.agent": "phone.agent",
    "phone.sync": "phone.sync",
    "phone.mirror": "phone.mirror",
    "phone.emulator": "phone.emulator",
}


def now_ts() -> int:
    return int(time.time())


def new_event_id() -> str:
    return f"evt_{uuid.uuid4().hex}"


# W4.5 B3 · Stream Event ID 严格 ASCII 数字字符集
# 用集合显式枚举（不调 str.isdigit()）—— str.isdigit() 接受 Unicode digit 等价物
# （全角 U+FF10..U+FF19、阿拉伯-印度 U+0660..U+0669、扩展阿拉伯-印度 U+06F0..U+06F9
# 等），让前端 TS `/^\d+$/`（默认 ASCII-only）与后端在 Unicode digit 场景上分歧——
# 任一端走偏即触发跨设备/跨进程 catchup 静默失效（参看 W4c-L1 + wave45 fixture）。
#
# **为何用 frozenset+all 而不是 re.compile(r"^[0-9]+-[0-9]+$")**：
#   两种写法行为等价，性能差异在 stream id 短字符串场景可忽略。选 frozenset+all
#   的理由是**与 Swift/Kotlin/TS 形态对称**——Swift 用 `Set<Character>` +
#   `allSatisfy`、Kotlin 用 `c in '0'..'9'` + `all`，char-iter 形态贯穿 4 端，
#   交叉 review 时一眼能看出"是否在做同一件事"。test_wave45_isStreamEventId_cross_language.py
#   里同时跑 regex 参考实现 + 本现网 frozenset 实现，两份等价就在 fixture 上互证。
#
# 4 端契约 SSOT：
#   - Fixture：packages/agent-wire/src/cross-lang-fixtures/wave45-isStreamEventId.json
#   - TS：    packages/agent-wire/src/cross-lang-validators/isStreamEventId.ts
#   - Swift： packages/wire-codegen/generated/swift/StreamEventIdValidator.swift
#   - Kotlin：packages/wire-codegen/generated/kotlin/StreamEventIdValidator.kt
_STREAM_ID_ASCII_DIGITS = frozenset("0123456789")


def is_stream_event_id(event_id: str) -> bool:
    """
    Check if *event_id* is a Redis Stream ID (e.g. ``1702000000000-0``).

    Stream IDs are monotonically increasing and used by the event buffer
    for resume/replay.  Legacy UUID-based IDs (``evt_...``) return False.

    **W4.5 B3 contract (cross-lang strict)**: must match ``^[0-9]+-[0-9]+$``
    with ASCII-only digits—Unicode equivalents (fullwidth ``１７０２``,
    arabic-indic ``١٧٠٢``, extended arabic-indic ``۱۷۰۲``) are rejected.
    This is required to byte-by-byte match the TS / Swift / Kotlin
    implementations so that any client persisting a non-ASCII "stream-like"
    id will not silently break ``_handle_resume`` replay path.
    """
    if not event_id or not isinstance(event_id, str):
        return False
    parts = event_id.split("-")
    if len(parts) != 2:
        return False
    head, tail = parts
    if not head or not tail:
        return False
    return all(c in _STREAM_ID_ASCII_DIGITS for c in head) and all(
        c in _STREAM_ID_ASCII_DIGITS for c in tail
    )


@dataclass
class EnvelopeValidationError(Exception):
    code: str
    message: str
    details: Optional[Dict[str, Any]] = None
    request_id: Optional[str] = None


def build_envelope(
    message_type: str,
    request_id: str,
    payload: Dict[str, Any],
    /,
    *,
    device_id: str = SERVER_DEVICE_ID,
    role: str = SERVER_ROLE,
    event_id: Optional[str] = None,
    reply_to: Optional[str] = None,
    thread_id: Optional[str] = None,
    trace_id: Optional[str] = None,
    organization_id: Optional[str] = None,
    session_id: Optional[str] = None,
    table_id: Optional[str] = None,
    instance_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Construct a WS envelope dict with required + optional fields.

    .. warning::
       The first three parameters (``message_type``, ``request_id``, ``payload``)
       are **positional-only** (PEP 570 ``/`` marker). Calling them with
       keyword syntax raises :class:`TypeError`::

           # ✅ correct
           build_envelope(TrackerEvent.NOTIFICATION, new_event_id(), {"k": "v"})

           # ❌ WRONG — raises TypeError("got some positional-only arguments
           # passed as keyword arguments")
           build_envelope(message_type=..., request_id=..., payload=...)

       Historical context: R6-CROSS-1 (Wave 7) found 5 callers using keyword
       syntax whose ``TypeError`` was swallowed by an outer broad
       ``except Exception`` → ``logger.debug``, leaving Daemon "device offline"
       notification, Checkpoint dispatch, Goal notification step and SSH
       streaming output silently broken in production. Lint test
       :mod:`apps.services.common.ws.tests.test_build_envelope_no_kwargs_misuse`
       performs an AST static scan over ``apps/tabtin_django/apps`` and
       ``packages`` and fails the build if any ``build_envelope`` Call node
       passes ``message_type`` / ``request_id`` / ``payload`` as keyword args.
    """
    envelope: Dict[str, Any] = {
        "v": PROTOCOL_VERSION,
        "type": message_type,
        "request_id": request_id,
        "ts": now_ts(),
        "device_id": device_id,
        "role": role,
        "payload": payload,
    }

    optional_fields = {
        "event_id": event_id,
        "reply_to": reply_to,
        "thread_id": thread_id,
        "trace_id": trace_id,
        "organization_id": organization_id,
        "session_id": session_id,
        "table_id": table_id,
        "instance_id": instance_id,
    }
    for key, value in optional_fields.items():
        if value is not None:
            envelope[key] = value

    return envelope


def build_error(
    request_id: str,
    code: str,
    message: str,
    /,
    *,
    details: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    return build_envelope(
        "error",
        request_id,
        {
            "code": code,
            "message": message,
            "details": details or {},
        },
    )


def resolve_required_capability(topic: str) -> Optional[str]:
    """最长前缀匹配，顺序无关。"""
    best_prefix = ""
    best_capability = None
    for prefix, capability in TOPIC_CAPABILITIES.items():
        if (topic == prefix or topic.startswith(f"{prefix}.")) and len(prefix) > len(best_prefix):
            best_prefix = prefix
            best_capability = capability
    return best_capability


def validate_envelope(data: Any, *, received_at: Optional[float] = None) -> Dict[str, Any]:
    if not isinstance(data, dict):
        raise EnvelopeValidationError(
            ERROR_SCHEMA_INVALID,
            "envelope must be an object",
        )

    request_id = data.get("request_id")
    if not isinstance(request_id, str) or not request_id:
        raise EnvelopeValidationError(
            ERROR_SCHEMA_INVALID,
            "missing or invalid request_id",
            {"field": "request_id"},
        )

    version = data.get("v")
    # G-072: accept any version in SUPPORTED_PROTOCOL_VERSIONS for graceful rollout
    if version not in SUPPORTED_PROTOCOL_VERSIONS:
        raise EnvelopeValidationError(
            ERROR_VERSION_UNSUPPORTED,
            f"unsupported protocol version: {version} (supported: {sorted(SUPPORTED_PROTOCOL_VERSIONS)})",
            {"field": "v", "supported_versions": sorted(SUPPORTED_PROTOCOL_VERSIONS)},
            request_id=request_id,
        )

    message_type = data.get("type")
    if not isinstance(message_type, str) or not message_type:
        raise EnvelopeValidationError(
            ERROR_SCHEMA_INVALID,
            "missing or invalid type",
            {"field": "type"},
            request_id=request_id,
        )

    ts_value = data.get("ts")
    if not isinstance(ts_value, int):
        raise EnvelopeValidationError(
            ERROR_SCHEMA_INVALID,
            "missing or invalid ts",
            {"field": "ts"},
            request_id=request_id,
        )
    # G-067: ts 范围校验 — 拒绝偏离服务器接收时间超过 ±5 分钟的消息。
    # Relay backpressure Phase 0: validation must use the frame receive timestamp,
    # not a later business-processing timestamp, so server queue wait is not
    # misclassified as a client schema error.
    server_now = int(received_at if received_at is not None else time.time())
    drift_seconds = ts_value - server_now
    if abs(drift_seconds) > MAX_TS_DRIFT_SECONDS:
        raise EnvelopeValidationError(
            ERROR_SCHEMA_INVALID,
            "ts out of acceptable range",
            {
                "field": "ts",
                "client_ts": ts_value,
                "client_created_at": ts_value,
                "server_ts": server_now,
                "server_received_at": server_now,
                "drift_seconds": drift_seconds,
                "max_drift_seconds": MAX_TS_DRIFT_SECONDS,
            },
            request_id=request_id,
        )

    device_id = data.get("device_id")
    if not isinstance(device_id, str) or not device_id:
        raise EnvelopeValidationError(
            ERROR_SCHEMA_INVALID,
            "missing or invalid device_id",
            {"field": "device_id"},
            request_id=request_id,
        )

    role = data.get("role")
    if role not in ALLOWED_ROLES:
        raise EnvelopeValidationError(
            ERROR_SCHEMA_INVALID,
            "missing or invalid role",
            {"field": "role"},
            request_id=request_id,
        )

    payload = data.get("payload")
    if not isinstance(payload, dict):
        raise EnvelopeValidationError(
            ERROR_SCHEMA_INVALID,
            "payload must be an object",
            {"field": "payload"},
            request_id=request_id,
        )

    return data
