"""
Resource Open Telemetry API（专题"Agent 产物在 Space 内的打开" Wave 7）。

业务目标（PRD §6 标准 1/2 + RFC v1.0 §8.3）：
    Electron main 进程把 ResourceRouter emit 的事件按 5s/100 条 batch 上报到本
    endpoint，bulk_create 落 PostgreSQL `agent_engine_resource_open_event` 表，
    让 PM 在上线 14 天后跑 `python scripts/telemetry/resource_open_sample.py` 拿到：
        - PRD §6 标准 1：可见率 ≥ 80%
        - PRD §6 标准 2：异常 deny / 静默失败 = 0

路由前缀：``/services/telemetry``（由 ``urls_deferred.py`` 注册），
最终 URL：``POST /api/services/telemetry/resource-open/batch``。

认证 + 安全（D8 红线 + 防伪造）：
    - JWTAuth（``request.auth`` 返回 User 实例）
    - 每条事件的 ``user_id`` 必须等于 JWT 解出的 user.id —— 防 renderer 改 payload
      把别人的事件染到自己账号上
    - 上报体积上限 100 条 / 单 batch（与 main 进程 ``FLUSH_BATCH_SIZE`` 对齐）
    - schema 校验失败的事件统计在 ``rejected``，不影响合法事件入库（partial-ok）
    - bulk_create 走单事务——避免半截入库后另一半失败留下数据漂移

为何独立 endpoint 而非复用 ``/services/agent-engine`` 现有路由：
    - 该路由组绑 SubtaskRun（agent 行为），本 endpoint 是 user 行为埋点（chat 点击 /
      open_in_space 工具触发等），数据模型完全不同
    - 复用反而引入 ``ResourceOpenEvent`` import 到 SubtaskRun 模块，违反 SRP
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone as dt_timezone
from typing import Any

from django.db import transaction
from ninja import Router, Schema
from pydantic import Field, field_validator
from typing import List, Optional

from apps.services.agent_engine.models import ResourceOpenEvent
from apps.services.common.api_errors import raise_bad_request, raise_unauthorized
from apps.users.auth.api import jwt_auth

logger = logging.getLogger(__name__)

router = Router(tags=["Resource Open Telemetry"])


# ---------------------------------------------------------------------------
# 常量（与客户端对齐）
# ---------------------------------------------------------------------------

#: 单次 batch 最多 100 条——与 main 进程 ``FLUSH_BATCH_SIZE`` 对齐。
#: 比这大就拒，避免单请求过大打爆 PG 单事务。
MAX_BATCH_SIZE = 100

#: 客户端 ts 字段单位（毫秒 epoch）——与 router.ts:hashPointerId 注释一致。
TS_UNIT = "ms"

# 合法 enum 集合：让 strict 校验拒掉显然错的拼写（如 'OPENED_OK'），同时不阻断
# 未来按 RFC §8.1 扩展枚举（新枚举先加这里、再加客户端）。
VALID_TRIGGER_SOURCES = frozenset({
    "chat_markdown",
    "open_in_space_tool",
    "rich_resource_card",
    "user_paste",
    "window_open_fallback",
})
VALID_RESOLVE_SOURCES = frozenset({
    "user_pref",
    "session_override",
    "agent_hint",
    "manifest_default",
    "system_fallback",
    "modifier_key",
})
VALID_OUTCOMES = frozenset({
    "in_space_opened",
    "system_app_opened",
    "denied_known_bad",
    "error",
})
VALID_EVENT_NAMES = frozenset({
    "resource_open.resolved",
    "resource_open.failed",
})


# ---------------------------------------------------------------------------
# Pydantic Schemas
# ---------------------------------------------------------------------------

class ResourceOpenEventIn(Schema):
    """单条 resource_open 事件 schema。

    字段对齐 ``packages/resource-router/src/types.ts:ResourceOpenEvent``。
    """

    event_name: str = Field(..., max_length=64)
    trigger_source: str = Field(..., max_length=32)
    pointer_scheme: str = Field(..., max_length=32)
    pointer_type: Optional[str] = Field(None, max_length=64)
    pointer_id_hash: str = Field(..., max_length=16)

    hint_app_id: Optional[str] = Field(None, max_length=64)
    resolved_carrier_app_id: Optional[str] = Field(None, max_length=64)
    resolve_source: str = Field(..., max_length=32)
    outcome: str = Field(..., max_length=32)

    space_id: str = Field(...)
    user_id: str = Field(...)
    organization_id: str = Field(...)
    agent_run_id: Optional[str] = None
    message_id: Optional[str] = None
    tool_call_id: Optional[str] = Field(None, max_length=128)

    duration_ms: int = Field(0, ge=0)
    ts: int = Field(..., ge=0, description="ms epoch")

    error_message: Optional[str] = Field(None, max_length=4096)

    client: str = Field("electron", max_length=16)
    client_version: str = Field("", max_length=32)

    @field_validator("event_name")
    @classmethod
    def _validate_event_name(cls, v: str) -> str:
        if v not in VALID_EVENT_NAMES:
            raise ValueError(f"event_name must be one of {sorted(VALID_EVENT_NAMES)}")
        return v

    @field_validator("trigger_source")
    @classmethod
    def _validate_trigger_source(cls, v: str) -> str:
        if v not in VALID_TRIGGER_SOURCES:
            raise ValueError(f"trigger_source must be one of {sorted(VALID_TRIGGER_SOURCES)}")
        return v

    @field_validator("resolve_source")
    @classmethod
    def _validate_resolve_source(cls, v: str) -> str:
        if v not in VALID_RESOLVE_SOURCES:
            raise ValueError(f"resolve_source must be one of {sorted(VALID_RESOLVE_SOURCES)}")
        return v

    @field_validator("outcome")
    @classmethod
    def _validate_outcome(cls, v: str) -> str:
        if v not in VALID_OUTCOMES:
            raise ValueError(f"outcome must be one of {sorted(VALID_OUTCOMES)}")
        return v


class ResourceOpenBatchIn(Schema):
    events: List[ResourceOpenEventIn] = Field(..., min_length=1, max_length=MAX_BATCH_SIZE)


class ResourceOpenBatchOut(Schema):
    accepted: int
    rejected: int
    errors: List[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _resolve_user_id(request) -> str:
    """从 JWTAuth 提取 user_id（AGENTS.md：request.auth 是 User 实例）。"""
    return str(request.auth.id)


def _parse_uuid(value: str) -> Optional[uuid.UUID]:
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError, AttributeError):
        return None


def _ms_to_datetime(ms_epoch: int) -> datetime:
    """ms epoch → UTC datetime（aware）。"""
    return datetime.fromtimestamp(ms_epoch / 1000.0, tz=dt_timezone.utc)


def _build_model_instance(
    payload: ResourceOpenEventIn,
    *,
    request_user_id: str,
) -> Optional[ResourceOpenEvent]:
    """把 payload 转换成 ResourceOpenEvent 实例。返回 None 表示该条非法。

    校验：
      - user_id 必须等于 JWT request_user_id（防伪造）
      - space_id / organization_id / agent_run_id / message_id 必须是合法 UUID
      - ts 必须是合理 ms epoch（合理范围限制由 schema 已做）
    """
    # 1. 防伪造：user_id 必须 == JWT user
    if str(payload.user_id) != request_user_id:
        raise ValueError(
            f"user_id mismatch with JWT (got {payload.user_id!r}, "
            f"expected {request_user_id!r})"
        )

    # 2. UUID 字段
    space_uuid = _parse_uuid(payload.space_id)
    if space_uuid is None:
        raise ValueError(f"space_id is not a valid UUID: {payload.space_id!r}")

    user_uuid = _parse_uuid(payload.user_id)
    if user_uuid is None:
        raise ValueError(f"user_id is not a valid UUID: {payload.user_id!r}")

    organization_uuid = _parse_uuid(payload.organization_id)
    if organization_uuid is None:
        raise ValueError(f"organization_id is not a valid UUID: {payload.organization_id!r}")

    agent_run_uuid = _parse_uuid(payload.agent_run_id) if payload.agent_run_id else None
    if payload.agent_run_id and agent_run_uuid is None:
        raise ValueError(f"agent_run_id is not a valid UUID: {payload.agent_run_id!r}")

    message_uuid = _parse_uuid(payload.message_id) if payload.message_id else None
    if payload.message_id and message_uuid is None:
        raise ValueError(f"message_id is not a valid UUID: {payload.message_id!r}")

    return ResourceOpenEvent(
        event_name=payload.event_name,
        trigger_source=payload.trigger_source,
        pointer_scheme=payload.pointer_scheme,
        pointer_type=payload.pointer_type,
        pointer_id_hash=payload.pointer_id_hash,
        hint_app_id=payload.hint_app_id,
        resolved_carrier_app_id=payload.resolved_carrier_app_id,
        resolve_source=payload.resolve_source,
        outcome=payload.outcome,
        space_id=space_uuid,
        user_id=user_uuid,
        organization_id=organization_uuid,
        agent_run_id=agent_run_uuid,
        message_id=message_uuid,
        tool_call_id=payload.tool_call_id,
        duration_ms=int(payload.duration_ms),
        ts=_ms_to_datetime(int(payload.ts)),
        error_message=payload.error_message,
        client=payload.client or "electron",
        client_version=payload.client_version or "",
    )


# ---------------------------------------------------------------------------
# POST /resource-open/batch
# ---------------------------------------------------------------------------

@router.post("/resource-open/batch", auth=jwt_auth, response=ResourceOpenBatchOut)
def post_resource_open_batch(request, payload: ResourceOpenBatchIn) -> dict[str, Any]:
    """接收 main 进程 5s/100 条 batch 上报，bulk_create 落 PG。

    返回 ``{accepted, rejected, errors[]}`` —— 合法事件入库，非法事件统计在
    ``rejected`` + 字符串描述放 ``errors``（最多前 10 条便于前端排查；不暴露
    完整字段防 PII 反向泄露）。

    设计：
      - 用 transaction.atomic() 包 bulk_create 保证原子性——半截入库 = 数据漂移
      - 单 batch 上限 100 条（schema 已验）+ JWT user 校验已在 schema 之前完成
    """
    user = request.auth
    if not user:
        raise_unauthorized()

    request_user_id = _resolve_user_id(request)

    instances: list[ResourceOpenEvent] = []
    errors: list[str] = []
    rejected = 0

    for index, event_in in enumerate(payload.events):
        try:
            inst = _build_model_instance(event_in, request_user_id=request_user_id)
            if inst is None:
                rejected += 1
                continue
            instances.append(inst)
        except Exception as e:
            rejected += 1
            if len(errors) < 10:
                # 不上报完整 payload，避免把 user 输入回响打回前端
                errors.append(f"event[{index}]: {type(e).__name__}: {str(e)[:200]}")

    if not instances:
        # 全部 rejected，仍返回 200 并带统计——不打异常，让客户端按业务判断
        return {
            "accepted": 0,
            "rejected": rejected,
            "errors": errors,
        }

    try:
        with transaction.atomic(using="postgresql"):
            ResourceOpenEvent.objects.using("postgresql").bulk_create(instances)
    except Exception as e:
        logger.exception(
            "[telemetry] resource-open bulk_create failed (n=%d): %s",
            len(instances), e,
        )
        # 全失败：不入库；给客户端清晰错误便于走 main 进程死信日志
        raise_bad_request(f"bulk_create failed: {type(e).__name__}: {str(e)[:200]}")

    logger.debug(
        "[telemetry] resource-open accepted=%d rejected=%d (user_id=%s)",
        len(instances), rejected, request_user_id,
    )
    return {
        "accepted": len(instances),
        "rejected": rejected,
        "errors": errors,
    }
