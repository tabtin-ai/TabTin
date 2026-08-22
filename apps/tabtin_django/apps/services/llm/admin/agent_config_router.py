"""Agent 产品配置 API — v0.1 AdminDash

拆 chat-config 单端点为 5 个独立端点：engine / context / guard / features / cleanup。
读写 EngineRuntimeConfig 单例。
"""

import logging

from ninja import Router, Schema
from ninja.errors import HttpError
from typing import Optional

from apps.i18n.response import success_response
from apps.users.auth.permissions import StaffAuth

from apps.chat.conversation.models import EngineRuntimeConfig

logger = logging.getLogger(__name__)

router = Router(tags=["Admin Agent Config"], auth=StaffAuth())


def _get_config() -> EngineRuntimeConfig:
    obj, _ = EngineRuntimeConfig.objects.get_or_create(pk=1)
    return obj


ENGINE_FIELDS = [
    'engine_max_iterations', 'engine_task_max_iterations', 'engine_max_tool_calls',
    'engine_task_timeout', 'engine_subagent_timeout', 'engine_max_plan_steps',
    'engine_allow_clarification', 'subagent_max_active', 'subagent_queue_limit',
    'subagent_global_queue_limit',
]

#  第三波：三档阈值经 prompt_forward 下发宿主（语义映射见
# conversation/models.py EngineRuntimeConfig 注释）；孤儿字段
# ctx_pressure_medium / ctx_summary_keep_messages / ctx_emergency_keep_messages
# 已随 migration 0054 删除。
CTX_FIELDS = [
    'ctx_default_window_tokens', 'ctx_pressure_high',
    'ctx_pressure_critical', 'ctx_summary_trigger_fraction',
]

GUARD_FIELDS = [
    'guard_doom_loop_warn', 'guard_doom_loop_break', 'guard_tool_output_max_chars',
    'guard_max_compaction_attempts',
]

FEATURES_FIELDS = [
    'feat_parallel_tool_execution', 'feat_tool_cache_enabled', 'feat_tool_cache_max_entries',
]

CLEANUP_FIELDS = [
    'cleanup_trace_retention_days', 'cleanup_stale_subagent_minutes',
    'cleanup_blocks_retention_hours',
]


def _extract_fields(obj, fields):
    return {f: getattr(obj, f) for f in fields}


def _update_fields(data: dict, fields: list):
    config = _get_config()
    updated = []
    for f in fields:
        if f in data and data[f] is not None:
            setattr(config, f, data[f])
            updated.append(f)
    if updated:
        config.save(update_fields=updated + ['updated_at'])
    return config


def _validate_ctx_thresholds(config: EngineRuntimeConfig) -> str | None:
    """三档阈值校验，与 admin_api._validate_cross_field / runtime pressure-router 同口径。

    排序：微压缩起点（high）<= 摘要档起点（trigger）< 紧急档起点（critical）。
    范围：三档均须落在 (0, 1]。违反排序的配置 prompt_forward 会拒绝下发
    （_resolve_pressure_threshold_fields 返回 None），必须在写入前拦截。
    """
    thresholds = (
        config.ctx_pressure_high,
        config.ctx_summary_trigger_fraction,
        config.ctx_pressure_critical,
    )
    if any(t <= 0 or t > 1 for t in thresholds):
        return "上下文压力阈值错误：阈值必须在 (0, 1] 区间内"
    if config.ctx_pressure_high > config.ctx_summary_trigger_fraction:
        return "上下文压力阈值错误：微压缩起点（high）不能大于摘要档起点（trigger fraction）"
    if config.ctx_summary_trigger_fraction >= config.ctx_pressure_critical:
        return "上下文压力阈值错误：摘要档起点（trigger fraction）必须小于紧急档起点（critical）"
    return None


class EngineConfigPayload(Schema):
    engine_max_iterations: Optional[int] = None
    engine_task_max_iterations: Optional[int] = None
    engine_max_tool_calls: Optional[int] = None
    engine_task_timeout: Optional[int] = None
    engine_subagent_timeout: Optional[int] = None
    engine_max_plan_steps: Optional[int] = None
    engine_allow_clarification: Optional[bool] = None
    subagent_max_active: Optional[int] = None
    subagent_queue_limit: Optional[int] = None
    subagent_global_queue_limit: Optional[int] = None


class ContextConfigPayload(Schema):
    ctx_default_window_tokens: Optional[int] = None
    ctx_pressure_high: Optional[float] = None
    ctx_pressure_critical: Optional[float] = None
    ctx_summary_trigger_fraction: Optional[float] = None


class GuardConfigPayload(Schema):
    guard_doom_loop_warn: Optional[int] = None
    guard_doom_loop_break: Optional[int] = None
    guard_tool_output_max_chars: Optional[int] = None
    guard_max_compaction_attempts: Optional[int] = None


class FeaturesConfigPayload(Schema):
    feat_parallel_tool_execution: Optional[bool] = None
    feat_tool_cache_enabled: Optional[bool] = None
    feat_tool_cache_max_entries: Optional[int] = None


class CleanupConfigPayload(Schema):
    cleanup_trace_retention_days: Optional[int] = None
    cleanup_stale_subagent_minutes: Optional[int] = None
    cleanup_blocks_retention_hours: Optional[int] = None


@router.get("/admin/agent-config/engine")
def get_engine_config(request):
    return success_response(data=_extract_fields(_get_config(), ENGINE_FIELDS))


@router.put("/admin/agent-config/engine")
def update_engine_config(request, payload: EngineConfigPayload):
    config = _update_fields(payload.dict(exclude_none=True), ENGINE_FIELDS)
    return success_response(data=_extract_fields(config, ENGINE_FIELDS))


@router.get("/admin/agent-config/context")
def get_context_config(request):
    return success_response(data=_extract_fields(_get_config(), CTX_FIELDS))


@router.put("/admin/agent-config/context")
def update_context_config(request, payload: ContextConfigPayload):
    config = _get_config()
    data = payload.dict(exclude_none=True)
    updated = [f for f in CTX_FIELDS if f in data]
    for f in updated:
        setattr(config, f, data[f])
    err = _validate_ctx_thresholds(config)
    if err:
        raise HttpError(400, err)
    if updated:
        config.save(update_fields=updated + ['updated_at'])
    return success_response(data=_extract_fields(config, CTX_FIELDS))


@router.get("/admin/agent-config/guard")
def get_guard_config(request):
    return success_response(data=_extract_fields(_get_config(), GUARD_FIELDS))


@router.put("/admin/agent-config/guard")
def update_guard_config(request, payload: GuardConfigPayload):
    config = _update_fields(payload.dict(exclude_none=True), GUARD_FIELDS)
    return success_response(data=_extract_fields(config, GUARD_FIELDS))


@router.get("/admin/agent-config/features")
def get_features_config(request):
    return success_response(data=_extract_fields(_get_config(), FEATURES_FIELDS))


@router.put("/admin/agent-config/features")
def update_features_config(request, payload: FeaturesConfigPayload):
    config = _update_fields(payload.dict(exclude_none=True), FEATURES_FIELDS)
    return success_response(data=_extract_fields(config, FEATURES_FIELDS))


@router.get("/admin/agent-config/cleanup")
def get_cleanup_config(request):
    return success_response(data=_extract_fields(_get_config(), CLEANUP_FIELDS))


@router.put("/admin/agent-config/cleanup")
def update_cleanup_config(request, payload: CleanupConfigPayload):
    config = _update_fields(payload.dict(exclude_none=True), CLEANUP_FIELDS)
    return success_response(data=_extract_fields(config, CLEANUP_FIELDS))
