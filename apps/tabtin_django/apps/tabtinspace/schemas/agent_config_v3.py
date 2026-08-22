"""
AgentUpdate.agent_config 入参的强类型 Pydantic schema（v3 PRD §5.2.5 + DR-17）。

设计动机
---------
此前 `AgentUpdate.agent_config: Optional[Dict[str, Any]]` 是裸 dict, 仅靠
`@field_validator` `_reject_legacy_yolo_mode` 单点拦截已知老字段。
攻击载荷如 `{"security":{...},"capabilities":{"overrides":{"shell":{"yolo_mode":true}}}}`
会顺利通过 schema → `_deep_merge` 写入 DB。当前 reader 暂未消费该路径,
但违反 DR-17"任何用户可控 JSON 必须有 Pydantic 强类型 schema 守门"。

本 schema 配合 `AgentUpdate` 把入参收紧:
- 顶层 `extra='forbid'` 拒绝任意未知字段(如旧 `yolo_mode` / `sandbox` / 等
  历史包袱)
- 嵌套 `security` / `capabilities.overrides.cost` 等"产品当前活跃字段"逐层 typed +
  `extra='forbid'`
- 历史/待治理的嵌套字段(`capabilities.overrides.{shell,filesystem,network,sql,
  device,audit}` / `memory` / `approval_memo` 内部 entries)暂以 `Dict[str, Any]`
  形式存在,但**位置固定**——不会越级穿透到顶层。这种"先框住骨架,内部 dict
  逐 PR 收紧"的策略避免一次性强类型化大量历史字段。

Defense in depth
----------------
service 层 `_validate_and_merge_config` + `migrate_v1_to_v2` 仍是兜底:
- v1 形状自动 promote 到 v2
- 非法值规整为合法默认
- service 层 schema_version 强制 v2

本 schema 是 API 边界第一层。任意改动需同步 verify:
- 现有 4 处 frontend `updateAgent` callsite(AgentSecurityPanel /
  ExecutionLimitsPanel / YoloBanner / MemoryPanel)payload 形状仍合法
- service 层兼容性测试 (test_pr3_allow_yolo_mode_and_audit) 通过

未来收紧 TODO
-------------
- `approval_memo.entries` 当前是 `Dict[str, Dict[str, Any]]`;
  `ApprovalMemoEntry` shape (decision/created_at/updated_at/approver_user_id/
  reason) 稳定后可独立强类型化(approval_memo_service.py:_normalize_memo)
- `capabilities.overrides.{shell,filesystem,network,sql,device,audit}` 是 v1
  遗留 capability 分组;Hilt W4 重写时仅保留 `cost`,其余仍可能从老 DB 行中
  bleed 回来。等 v1 数据迁移 100% 完成后可强类型化为各自 schema
- `memory` 子树字段较多(observer/injection/working_memory/skill_evolution);
  TabMemo 专题清理时一起收紧
"""

from __future__ import annotations

from typing import Any, Dict, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


# ---------------------------------------------------------------------------
# security 子树 —— 攻击窗口最高的字段,严格强类型
# ---------------------------------------------------------------------------


class SecuritySchema(BaseModel):
    """v3 PRD §5.1.1: Agent 级 yolo gate。

    ``extra='forbid'`` 自然挡掉 legacy ``yolo_mode`` —— 旧字段不会出现在
    本 schema 的字段列表里,任何携带它的请求一律 422。

     三档审批策略: 新增 ``approval_grant``(Agent 已授权的最高审批档位,
    首次升档就地确认后由客户端写入)。``allow_yolo_mode`` 保留为读兼容 legacy
    gate —— ``allow_yolo_mode=true`` 读时等价 ``approval_grant='auto'``
    (见 ``agent_governance_resolver.resolve_approval_grant``)。
    """

    model_config = ConfigDict(extra="forbid")

    allow_yolo_mode: Optional[bool] = Field(
        default=None,
        description="Agent 级 yolo gate(默认 false)。#3503 起为读兼容 legacy 字段,新写入用 approval_grant。",
    )
    approval_grant: Optional[Literal["always_ask", "auto", "full_access"]] = Field(
        default=None,
        description="#3503: Agent 已授权的最高审批档位。null=未显式授权(读 legacy allow_yolo_mode 兜底)。",
    )


# ---------------------------------------------------------------------------
# capabilities.overrides.cost —— v3 默认形状中保留的唯一 capability 分组
# ---------------------------------------------------------------------------


class ExecutionLimitsSchema(BaseModel):
    """``capabilities.overrides.cost.execution_limits`` 字段。"""

    model_config = ConfigDict(extra="forbid")

    max_iterations_per_run: Optional[int] = Field(
        default=None,
        description="单次 run 最大迭代数(service 层夹紧到 [1, 500])",
    )
    max_credits_per_run: Optional[float | int | str] = Field(
        default=None,
        description="单次 run 最大 credit(service 层夹紧到 (0, 10000])",
    )


class CostOverrideSchema(BaseModel):
    model_config = ConfigDict(extra="forbid")

    execution_limits: Optional[ExecutionLimitsSchema] = None


class CapabilitiesOverridesSchema(BaseModel):
    """capability overrides 集合。

    cost 强类型化;其余 v1 遗留分组以 ``Dict[str, Any]`` 形式占位——它们位置固定
    在 ``overrides`` 下,不会被攻击者用作越级穿透到顶层的跳板,而 service 层
    ``_validate_capability_overrides`` 仍逐字段做白名单 sanitize。

    TODO(v3 follow-up): 等老 DB 行 v1 字段 100% migrate 完成后,把 shell /
    filesystem / network / sql / device / audit 也强类型化(参考 cost 的写法)。
    """

    model_config = ConfigDict(extra="forbid")

    cost: Optional[CostOverrideSchema] = None
    # TODO: 各分组待逐个强类型化。当前 service 层有 `_validate_capability_overrides`
    # 做字段白名单 + 值合法性夹紧,本 schema 层先框住"必须是 dict"的形状,
    # 防越级穿透。
    shell: Optional[Dict[str, Any]] = None
    filesystem: Optional[Dict[str, Any]] = None
    network: Optional[Dict[str, Any]] = None
    sql: Optional[Dict[str, Any]] = None
    device: Optional[Dict[str, Any]] = None
    audit: Optional[Dict[str, Any]] = None


class CapabilitiesSchema(BaseModel):
    model_config = ConfigDict(extra="forbid")

    overrides: Optional[CapabilitiesOverridesSchema] = None
    # preset 是 W4 重写前的字段,UI 仍偶尔 echo 回;service 层 pop / 校验。
    # Schema 层 Optional 保留,避免 frontend 旧 store 状态触发 422。
    preset: Optional[str] = None


# ---------------------------------------------------------------------------
# conversation
# ---------------------------------------------------------------------------


class ConversationSchema(BaseModel):
    model_config = ConfigDict(extra="forbid")

    cross_turn_memory: Optional[bool] = None
    max_history_messages: Optional[int] = Field(default=None, ge=0, le=500)


# ---------------------------------------------------------------------------
# agent_backend
# ---------------------------------------------------------------------------


class AgentBackendSchema(BaseModel):
    """agent_backend 协议字段。service 层会强制 type='builtin' + config_version。"""

    model_config = ConfigDict(extra="forbid")

    type: Optional[str] = None
    config_version: Optional[int] = None


# ---------------------------------------------------------------------------
# 顶层 schema
# ---------------------------------------------------------------------------


class AgentConfigUpdateSchema(BaseModel):
    """``AgentUpdate.agent_config`` 入参 schema。

    顶层 ``extra='forbid'`` 拒绝任意未知字段:
    - 旧 v1 顶层(``terminal_mode`` / ``operation_switches`` / ``sandbox`` /
      ``sql_mode`` / ``execution_limits`` / ``device_permissions`` /
      ``authorization_rules`` / ``cross_turn_memory`` / ``max_history_messages``)
      一律 422。前端 PR3 后已全部走 v2 形状(嵌套 security / capabilities /
      conversation),任何遗留 v1 顶层视为旧客户端 bug。
    - 未知字段(如假想 ``sandbox`` / ``permission_bypass`` 等攻击向量)同样 422。

    保留 ``authorization_preset`` 仅作"旧 DB 行 bleed 回 frontend 后再 PUT
    回来"的兼容路径;service 层 ``_validate_and_merge_config`` 会 pop 掉它。
    """

    model_config = ConfigDict(extra="forbid")

    # v3 默认形状字段
    schema_version: Optional[int] = Field(
        default=None,
        description="形状版本号(service 层强制 fixed=2,客户端传入会被覆盖)",
    )
    runtime_plane: Optional[str] = Field(
        default=None,
        pattern=r"^(local|cloud)$",
        description="执行平面",
    )
    security: Optional[SecuritySchema] = None
    capabilities: Optional[CapabilitiesSchema] = None
    conversation: Optional[ConversationSchema] = None
    workspace_root: Optional[str] = None
    agent_backend: Optional[AgentBackendSchema] = None

    # bleed-back 兼容字段(只读,但前端可能 echo)
    git_status: Optional[Dict[str, Any]] = None
    # ``soul`` 已随 Soul 概念整体移除（强类型 SoulSchema 已删、模型/表/API/UI 全无），
    # 但它与 ``authorization_preset`` 同属 **bleed-back**：老 DB 行 / 旧客户端整包
    # respread agent_config 时可能仍带 soul 子树。若不在 schema 层接受，顶层
    # ``extra='forbid'`` 会**先于** service 层 422（Pydantic 校验早于 handler，
    # service 的 ``pop('soul')`` 对 API 输入路径够不着）。故这里保留为容忍字段，
    # service 层 ``_validate_and_merge_config`` 再 ``pop('soul')`` 静默丢弃——
    # 既不复活 Soul，又让 respread / 旧客户端不 422。
    soul: Optional[Dict[str, Any]] = Field(
        default=None,
        description=(
            "已废弃（Soul 概念移除）。仅为容忍 bleed-back / 旧客户端 respread 不"
            "触发 422；service 层 pop 丢弃，不写库。"
        ),
    )
    authorization_preset: Optional[str] = Field(
        default=None,
        description=(
            "W4 已删除;service 层会 pop 掉。schema 层保留接受是为了让"
            "frontend respread 老 DB 行不触发 422。"
        ),
    )

    # 复杂嵌套字段 —— TODO 后续 PR 收紧
    memory: Optional[Dict[str, Any]] = Field(
        default=None,
        description=(
            "Memory 子树。TODO(v3 follow-up): observer / injection /"
            "working_memory / skill_evolution 字段较多,TabMemo 专题清理时再"
            "强类型化。当前 service 层 `_validate_and_merge_config` 逐字段"
            "做白名单 + 值合法性夹紧。"
        ),
    )
    approval_memo: Optional[Dict[str, Any]] = Field(
        default=None,
        description=(
            "Approval memo (PRD 05 §7.3)。TODO(v3 follow-up): entries 形状"
            "(decision / created_at / updated_at / approver_user_id / reason)"
            "稳定后可独立 strict schema 化;参考 ApprovalMemoService。当前由"
            "ApprovalMemoService.set_entry / clear_entry 走专用 endpoint,"
            "本 schema 接受 bleed-back 形状即可。"
        ),
    )


__all__ = [
    "AgentBackendSchema",
    "AgentConfigUpdateSchema",
    "CapabilitiesOverridesSchema",
    "CapabilitiesSchema",
    "ConversationSchema",
    "CostOverrideSchema",
    "ExecutionLimitsSchema",
    "SecuritySchema",
]
