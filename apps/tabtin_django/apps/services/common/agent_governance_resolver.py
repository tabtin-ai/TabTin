"""Agent 执行配置 + 组织准入天花板 + 审批档读取器（fail-safe）。

两个读取维度、两个数据源：

- ``allow_yolo_mode`` / 组织准入天花板：读 **组织**
  ``Organization.settings.allow_member_yolo``。这是「成员能否使用宽松审批档
  （auto / full_access，含 legacy yolo）」的唯一组织级 gate。
- ``approval_grant``（ 三档审批）：读 **Agent**
  ``agent_config.security.approval_grant``；缺失时 legacy 映射
  ``allow_yolo_mode=true`` → ``'auto'``。组织未开放时，升档结果被夹回
  ``always_ask``（天花板只收紧、不替谁自动打开）。
- ``execution_limits``：逐键优先 **Workspace.execution_limits**；
  某键为 null / 缺省时回落 Agent
  ``agent_config.capabilities.overrides.cost.execution_limits``。
  ：Workspace 未启用（默认）时不回落 Agent；空配置不再表示「跟随产品硬默认」。
  ：Workspace 未启用（``enabled: false`` / 空且无数值）时不回落 Agent，
  表示本现场关闭执行限制。

fail-safe：任何异常 / 脏值 → 组织天花板 ``False``、grant ``always_ask``、
execution 全 ``None``（宁可多弹审批，不可误放行）。

Yolo / 宽松审批作用域（ + ）：

- 组织不开放 ``allow_member_yolo`` → 组织内任何成员都不能把对话升到
  auto / full_access（含旧 yolo 档）。
- 组织开放后，成员仍需在自己的对话里选档，并受 Agent ``approval_grant``
  升档闸门约束；一个成员的选择不影响其他成员。

原「团队基线层」（``Organization.settings.agent_defaults``）是"默认继承"，
已于 2026-06 下线；本组织天花板是"准入上限"（只收紧），语义不同。

本模块为**纯函数**、无 Django ORM 依赖（可被 migration / 单测安全 import）。
"""

from __future__ import annotations

from typing import Any, Dict, Optional

# execution_limits 的合法子键（per-key 读取维度）。
EXECUTION_LIMIT_KEYS = ("max_iterations_per_run", "max_credits_per_run")

# 组织准入天花板在 ``Organization.settings`` 里的键名。
ORG_ALLOW_MEMBER_YOLO_KEY = "allow_member_yolo"
ORG_ALLOW_MEMBER_YOLO_DEFAULT = True

#:  三档审批策略的合法档位（与 TS `@tabtin/agent-modes` APPROVAL_MODE_NAMES 对齐）。
APPROVAL_GRANT_VALUES = ("always_ask", "auto", "full_access")


def _normalized_agent_config(agent_config: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """把任意形状 agent_config 归一为 v2 形状，便于安全读取治理字段。"""
    from apps.tabtinspace.agent_config_v2 import migrate_v1_to_v2, V2_SCHEMA_VERSION

    if not isinstance(agent_config, dict):
        return migrate_v1_to_v2(None)
    if agent_config.get("schema_version") != V2_SCHEMA_VERSION:
        return migrate_v1_to_v2(agent_config)
    return agent_config


def _read_agent_allow_yolo(block: Optional[Dict[str, Any]]) -> Optional[bool]:
    """从 Agent ``security.allow_yolo_mode`` 读 bool；缺失/脏值 → None。

     legacy：写入 ``approval_grant`` 时会同步该字段；读 grant 缺失时回落。
    严格只认 ``bool``。
    """
    if isinstance(block, dict):
        security = block.get("security")
        if isinstance(security, dict):
            val = security.get("allow_yolo_mode")
            if isinstance(val, bool):
                return val
    return None


def resolve_allow_yolo_mode(organization_settings: Optional[Dict[str, Any]]) -> bool:
    """解析组织准入天花板：``organization_settings.allow_member_yolo``。

    True = 组织允许成员在对话里使用宽松审批档（auto / full_access / legacy yolo）。
    这是组织级唯一 gate。入参是 ``Organization.settings`` dict。

    fail-safe：非 dict / 缺失 / 非 bool 脏值 / 异常 → ``False``。
    """
    try:
        if isinstance(organization_settings, dict):
            val = organization_settings.get(ORG_ALLOW_MEMBER_YOLO_KEY)
            if isinstance(val, bool):
                return val
        return False
    except Exception:
        return False


def resolve_approval_grant(
    agent_config: Optional[Dict[str, Any]],
    organization_settings: Optional[Dict[str, Any]] = None,
) -> str:
    """解析 Agent 已授权的最高审批档位，并套组织天花板。

    优先读 ``security.approval_grant``；缺失 / 脏值时回落 legacy：
    Agent ``allow_yolo_mode=true`` → ``'auto'``，否则 ``'always_ask'``。

    组织未开放 ``allow_member_yolo`` 时，任何高于 ``always_ask`` 的结果夹回
    ``always_ask``（天花板只收紧）。``organization_settings`` 缺省时按未开放处理
    （fail-safe；调用方应传入 ``space.organization.settings``）。

    fail-safe：任何异常 → ``'always_ask'``。
    """
    try:
        cfg = _normalized_agent_config(agent_config)
        security = cfg.get("security")
        grant = "always_ask"
        if isinstance(security, dict):
            raw = security.get("approval_grant")
            if raw in APPROVAL_GRANT_VALUES:
                grant = raw
            else:
                agent_yolo = _read_agent_allow_yolo(cfg)
                if agent_yolo is True:
                    grant = "auto"
        if grant != "always_ask" and not resolve_allow_yolo_mode(organization_settings):
            return "always_ask"
        return grant
    except Exception:
        return "always_ask"


def _execution_limits_enabled(el: Dict[str, Any]) -> bool:
    """#8910：显式 ``enabled`` 优先；缺省时有任一数值键 → 视为启用（旧数据兼容）。"""
    enabled = el.get("enabled")
    if isinstance(enabled, bool):
        return enabled
    return any(el.get(key) is not None for key in EXECUTION_LIMIT_KEYS)


def resolve_execution_limits(
    agent_config: Optional[Dict[str, Any]] = None,
    workspace_execution_limits: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """逐键解析 ``execution_limits``。

    ：每个键独立——Workspace 非 null 优先，否则回落 Agent
    ``agent_config.capabilities.overrides.cost.execution_limits``（过渡兼容）。
    现场只设 iterations 时，credits 仍可吃 Agent 侧配置。

    ：若传入了 Workspace 字典且未启用执行限制（``enabled: false``，
    或空/无数值且无显式 enabled），**不回落 Agent**——本现场关闭上限。
    未传 Workspace（``None``）时仍走 Agent 侧（含 Agent ``enabled`` 门控）。
    """
    out: Dict[str, Any] = {k: None for k in EXECUTION_LIMIT_KEYS}
    try:
        from apps.tabtinspace.agent_config_v2 import get_capability_override

        cfg = _normalized_agent_config(agent_config)
        agent_el = get_capability_override(cfg, "cost", "execution_limits")
        agent_el = agent_el if isinstance(agent_el, dict) else {}

        if isinstance(workspace_execution_limits, dict):
            if not _execution_limits_enabled(workspace_execution_limits):
                return out
            workspace_el = workspace_execution_limits
        else:
            # 无 Workspace：仅 Agent；Agent 未启用 → 全 None
            if not _execution_limits_enabled(agent_el):
                return out
            workspace_el = {}

        for key in EXECUTION_LIMIT_KEYS:
            workspace_val = workspace_el.get(key)
            if workspace_val is not None:
                out[key] = workspace_val
                continue
            agent_val = agent_el.get(key)
            if agent_val is not None:
                out[key] = agent_val
        return out
    except Exception:
        return {k: None for k in EXECUTION_LIMIT_KEYS}


def compact_execution_limits(
    resolved: Optional[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    """把 resolved ``execution_limits`` 去掉 None 值；全空 → ``None``。"""
    if not isinstance(resolved, dict):
        return None
    compact = {
        k: v
        for k, v in resolved.items()
        if k in EXECUTION_LIMIT_KEYS and v is not None
    }
    return compact or None


__all__ = [
    "EXECUTION_LIMIT_KEYS",
    "ORG_ALLOW_MEMBER_YOLO_KEY",
    "ORG_ALLOW_MEMBER_YOLO_DEFAULT",
    "APPROVAL_GRANT_VALUES",
    "resolve_approval_grant",
    "resolve_allow_yolo_mode",
    "resolve_execution_limits",
    "compact_execution_limits",
]
