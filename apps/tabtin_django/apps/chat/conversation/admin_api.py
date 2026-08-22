"""AdminDash 对话配置管理 API（v0.1 兼容路径）。

宪法 v0.1 §5.8 已将旧 chat 全局配置 50 字段拆 4 路：

- 27 字段 → `EngineRuntimeConfig`（pk=1 单例，本路由读写的对象；#3229 第三波
  又删 3 个上下文孤儿字段后现存 24 个）
- 10 字段 → prompt bundle / LLMSceneBinding（不再通过此路由配置）
- 13 字段 → 直接弃用

新前端的产品形态走 `apps/services/llm/admin/agent_config_router.py` 拆出的
5 个独立子端点（engine / context / guard / features / cleanup）。本文件保留
旧 `/auth/admin/chat/config` 单端点形式，仅为兼容老 AdminDash 客户端 ——
所有写入会被透传到 EngineRuntimeConfig 同名字段。

**已下线字段**（passing 进来会被忽略，不再做错误返回，避免老前端崩溃）：

- `system_*_prompt`（已迁 `packages/agent-runtime/src/prompts/engine/`）
- `title_*`（已迁 `bundled/title_generation/` + `LLMSceneBinding`）
- `subagent_*_model_id`（已迁 `LLMSceneBinding(_sub_agent_*)`）
- `feat_debug_mode` / `feat_prompt_cache_enabled` / `feat_otel_trace_enabled` / `feat_model_routing_enabled`
- `identity_override_mode` / `ctx_summary_max_tokens` / `title_enabled` / `title_retry_count`
"""

from typing import Optional

from ninja import Router
from ninja.errors import HttpError
from pydantic import BaseModel, ConfigDict, Field

from apps.users.auth.permissions import StaffAuth, SuperuserAuth

from .models import EngineRuntimeConfig

router = Router(auth=StaffAuth())


# ============ Schemas ============

# 与 EngineRuntimeConfig 同步：24 个运行时字段（7 引擎 + 4 上下文 + 4 安全护栏
# + 3 特性开关 + 3 子 Agent + 3 后台清理）。前端旧 schema 中其它字段在 v0.1
# 已下线，请走对应的新入口（见模块 docstring）。#3229 第三波删除的三个上下文
# 孤儿字段（ctx_pressure_medium / ctx_summary_keep_messages /
# ctx_emergency_keep_messages）passing 进来同样被忽略。
_RUNTIME_FIELDS: tuple[str, ...] = (
    # 引擎参数
    "engine_max_iterations",
    "engine_task_max_iterations",
    "engine_max_tool_calls",
    "engine_task_timeout",
    "engine_subagent_timeout",
    "engine_max_plan_steps",
    "engine_allow_clarification",
    # 上下文管理（：三档阈值经 prompt_forward 下发宿主，见 models.py 注释）
    "ctx_default_window_tokens",
    "ctx_pressure_high",
    "ctx_pressure_critical",
    "ctx_summary_trigger_fraction",
    # 安全护栏
    "guard_doom_loop_warn",
    "guard_doom_loop_break",
    "guard_tool_output_max_chars",
    "guard_max_compaction_attempts",
    # 特性开关
    "feat_parallel_tool_execution",
    "feat_tool_cache_enabled",
    "feat_tool_cache_max_entries",
    # 子 Agent
    "subagent_max_active",
    "subagent_queue_limit",
    "subagent_global_queue_limit",
    # 后台清理
    "cleanup_trace_retention_days",
    "cleanup_stale_subagent_minutes",
    "cleanup_blocks_retention_hours",
)


class EngineRuntimeConfigSchema(BaseModel):
    """对话全局配置响应（兼容旧 schema 名称，但仅暴露 EngineRuntimeConfig 字段）。"""

    model_config = ConfigDict(protected_namespaces=())

    engine_max_iterations: int
    engine_task_max_iterations: int
    engine_max_tool_calls: int
    engine_task_timeout: int
    engine_subagent_timeout: int
    engine_max_plan_steps: int
    engine_allow_clarification: bool

    ctx_default_window_tokens: int
    ctx_pressure_high: float
    ctx_pressure_critical: float
    ctx_summary_trigger_fraction: float

    guard_doom_loop_warn: int
    guard_doom_loop_break: int
    guard_tool_output_max_chars: int
    guard_max_compaction_attempts: int

    feat_parallel_tool_execution: bool
    feat_tool_cache_enabled: bool
    feat_tool_cache_max_entries: int

    subagent_max_active: int
    subagent_queue_limit: int
    subagent_global_queue_limit: int

    cleanup_trace_retention_days: int
    cleanup_stale_subagent_minutes: int
    cleanup_blocks_retention_hours: int

    updated_at: Optional[str] = None


class UpdateEngineRuntimeConfigRequest(BaseModel):
    """更新对话全局配置请求（v0.1 仅接受 EngineRuntimeConfig 字段）。"""

    model_config = ConfigDict(protected_namespaces=(), extra="ignore")

    engine_max_iterations: Optional[int] = Field(None, ge=0, le=100)
    engine_task_max_iterations: Optional[int] = Field(None, ge=0, le=100)
    engine_max_tool_calls: Optional[int] = Field(None, ge=0, le=50)
    engine_task_timeout: Optional[int] = Field(None, ge=0, le=3600)
    engine_subagent_timeout: Optional[int] = Field(None, ge=0, le=600)
    engine_max_plan_steps: Optional[int] = Field(None, ge=0, le=20)
    engine_allow_clarification: Optional[bool] = None

    ctx_default_window_tokens: Optional[int] = Field(None, ge=1000, le=2_000_000)
    ctx_pressure_high: Optional[float] = Field(None, ge=0, le=1)
    ctx_pressure_critical: Optional[float] = Field(None, ge=0, le=1)
    ctx_summary_trigger_fraction: Optional[float] = Field(None, ge=0, le=1)

    guard_doom_loop_warn: Optional[int] = Field(None, ge=1, le=20)
    guard_doom_loop_break: Optional[int] = Field(None, ge=2, le=30)
    guard_tool_output_max_chars: Optional[int] = Field(None, ge=1000, le=500_000)
    guard_max_compaction_attempts: Optional[int] = Field(None, ge=0, le=10)

    feat_parallel_tool_execution: Optional[bool] = None
    feat_tool_cache_enabled: Optional[bool] = None
    feat_tool_cache_max_entries: Optional[int] = Field(None, ge=0, le=1000)

    subagent_max_active: Optional[int] = Field(None, ge=1, le=10)
    subagent_queue_limit: Optional[int] = Field(None, ge=1, le=100)
    subagent_global_queue_limit: Optional[int] = Field(None, ge=1, le=1000)

    cleanup_trace_retention_days: Optional[int] = Field(None, ge=1, le=365)
    cleanup_stale_subagent_minutes: Optional[int] = Field(None, ge=1, le=60)
    cleanup_blocks_retention_hours: Optional[int] = Field(None, ge=1, le=720)


# ============ Helpers ============

def _config_to_schema(config: EngineRuntimeConfig) -> EngineRuntimeConfigSchema:
    data = {f: getattr(config, f) for f in _RUNTIME_FIELDS}
    data["updated_at"] = config.updated_at.isoformat() if config.updated_at else None
    return EngineRuntimeConfigSchema(**data)


def _validate_cross_field(config: EngineRuntimeConfig) -> str | None:
    """跨字段业务校验，返回错误消息或 None。

     三档阈值口径与 runtime ``pressure-router`` 一致：
    微压缩起点（high）<= 摘要档起点（trigger）< 紧急档起点（critical）。
    """
    if config.ctx_pressure_high > config.ctx_summary_trigger_fraction:
        return "上下文压力阈值错误：微压缩起点（high）不能大于摘要档起点（trigger fraction）"
    if config.ctx_summary_trigger_fraction >= config.ctx_pressure_critical:
        return "上下文压力阈值错误：摘要档起点（trigger fraction）必须小于紧急档起点（critical）"
    if config.guard_doom_loop_warn >= config.guard_doom_loop_break:
        return "Doom Loop 阈值错误：警告阈值必须小于终止阈值"
    return None


# ============ Endpoints ============

@router.get(
    "/chat/config",
    response=EngineRuntimeConfigSchema,
    auth=StaffAuth(),
    tags=["对话配置"],
)
def get_chat_config(request):
    """获取对话全局配置（兼容旧路径，实际读 EngineRuntimeConfig 单例）。"""

    config = EngineRuntimeConfig.get_config()
    return _config_to_schema(config)


@router.put(
    "/chat/config",
    response=EngineRuntimeConfigSchema,
    auth=SuperuserAuth(),
    tags=["对话配置"],
)
def update_chat_config(request, data: UpdateEngineRuntimeConfigRequest):
    """更新对话全局配置（仅写入 EngineRuntimeConfig 字段；老字段被忽略）。"""

    config = EngineRuntimeConfig.get_config()

    update_fields: list[str] = ["updated_at"]
    for field_name in _RUNTIME_FIELDS:
        value = getattr(data, field_name, None)
        if value is not None:
            setattr(config, field_name, value)
            update_fields.append(field_name)

    cross_err = _validate_cross_field(config)
    if cross_err:
        raise HttpError(400, cross_err)

    config.save(update_fields=update_fields)
    return _config_to_schema(config)
