"""
agent_config v2 形状的 SSoT（Single Source of Truth）模块

Hilt W4 重写：删除旧授权字段（authorization_preset / capabilities.preset /
shell / filesystem / network / sql / device / audit overrides），
新形状保留 security（ ``approval_grant`` + legacy ``allow_yolo_mode``）
+ cost overrides + conversation。

#3836（2026-07）：组织准入天花板在 ``Organization.settings.allow_member_yolo``；
Agent 上不再有用户侧「Yolo 开关」，但 ``security.approval_grant`` /
legacy ``allow_yolo_mode`` 仍由  升档授权写入，不可当死数据清掉。

被以下模块共用：
- apps.tabtinspace.services.agent_service（DEFAULT 装配 + 校验）
- apps.tabtinspace.management.commands.migrate_agent_config_v2（dry-run）
- apps.tabtinspace.management.commands.migrate_auth_to_v3（Hilt 迁移）
- apps.tabtinspace.migrations.0044_agent_config_v2（数据迁移）
- 测试 fixture

设计取向：
- 纯函数，无 Django ORM 依赖（migration 安全 import）
- 幂等：cfg['schema_version'] == 2 → 直接返回不动
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any, Dict, List, Optional

V2_SCHEMA_VERSION = 2

CAPABILITY_GROUPS: List[str] = [
    "cost",
]

# Hilt W4 退役 capability 分组：产品侧已删、生产 reader 已不消费，仅作为
# 老 DB 行 / 旧客户端 bleed-back 的死数据残留。``strip_retired_agent_config_fields``
# 与数据迁移 0055 据此清场。``cost`` 是唯一存活分组，不在此列。
RETIRED_CAPABILITY_GROUPS: List[str] = [
    "shell", "filesystem", "network", "sql", "device", "audit",
]


def build_default_agent_config_v2() -> Dict[str, Any]:
    """构造 v2 默认 agent_config（Hilt 新形状）。

    ``security.allow_yolo_mode`` 默认 None（未显式授权）；#3503 读端经
    ``resolve_approval_grant`` 落 ``always_ask``。组织天花板在
    ``Organization.settings.allow_member_yolo``，不进本默认形状。
    """
    return {
        "schema_version": V2_SCHEMA_VERSION,
        "runtime_plane": "local",
        "security": {
            "allow_yolo_mode": None,
        },
        "capabilities": {
            "overrides": {
                "cost": {
                    "execution_limits": {
                        "max_iterations_per_run": None,
                        "max_credits_per_run": None,
                    },
                },
            },
        },
        "conversation": {
            "cross_turn_memory": True,
            "max_history_messages": 10,
        },
        "workspace_root": "",
        "git_status": {},
        "agent_backend": {
            "type": "builtin",
            "config_version": V2_SCHEMA_VERSION,
        },
    }


# ---------------------------------------------------------------------------
# capabilities 嵌套字段读取工具
# ---------------------------------------------------------------------------

def get_capability_override(
    config: Optional[Dict[str, Any]],
    cap_id: str,
    field_name: str,
    default: Any = None,
) -> Any:
    """读 ``config.capabilities.overrides.<cap_id>.<field_name>``。

    任何中间层缺失都返回 ``default``，安全用于"读 v2 嵌套字段"路径。
    业务调用方应优先使用本函数而非手写 chain ``.get(..., {}).get(..., {}).get(...)``。
    """
    if not isinstance(config, dict):
        return default
    capabilities = config.get("capabilities")
    if not isinstance(capabilities, dict):
        return default
    overrides = capabilities.get("overrides")
    if not isinstance(overrides, dict):
        return default
    cap_block = overrides.get(cap_id)
    if not isinstance(cap_block, dict):
        return default
    val = cap_block.get(field_name, default)
    return val


def set_capability_override(
    config: Dict[str, Any],
    cap_id: str,
    field_name: str,
    value: Any,
) -> None:
    """写 ``config.capabilities.overrides.<cap_id>.<field_name> = value``。

    自动补全中间层 dict（capabilities / overrides / cap block）。
    用于校验/写入路径——读路径请用 ``get_capability_override``。
    """
    config.setdefault("capabilities", {})
    if not isinstance(config["capabilities"], dict):
        config["capabilities"] = {}
    config["capabilities"].setdefault("overrides", {})
    if not isinstance(config["capabilities"]["overrides"], dict):
        config["capabilities"]["overrides"] = {}
    config["capabilities"]["overrides"].setdefault(cap_id, {})
    if not isinstance(config["capabilities"]["overrides"][cap_id], dict):
        config["capabilities"]["overrides"][cap_id] = {}
    config["capabilities"]["overrides"][cap_id][field_name] = value


# ---------------------------------------------------------------------------
# 内部工具：深合并（patch 进 base），用于 migrate_v1_to_v2 处理「假 v2」混合包
# ---------------------------------------------------------------------------

def _deep_merge_into(base: Dict[str, Any], patch: Dict[str, Any]) -> None:
    """递归把 patch 合并进 base。嵌套 dict 做深合并而非替换。

    与 `AgentService._deep_merge` 同语义；本模块独立维护一份避免引入
    跨 app import（agent_config_v2 被 migration 在 module load 期使用，
    必须保持零依赖纯函数）。
    """
    for key, value in patch.items():
        if (
            key in base
            and isinstance(base[key], dict)
            and isinstance(value, dict)
        ):
            _deep_merge_into(base[key], value)
        else:
            base[key] = deepcopy(value) if isinstance(value, (dict, list)) else value


# ---------------------------------------------------------------------------
# v1 → v2 转换（Hilt 重写：产出新形状，旧授权字段全部丢弃）
# ---------------------------------------------------------------------------

V1_TO_V2_CAPABILITY_MAP: Dict[str, tuple] = {
    "execution_limits": ("cost", "execution_limits"),
}

V1_SANDBOX_TO_V2_MAP: Dict[str, tuple] = {}


def migrate_v1_to_v2(cfg: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """把任意旧形状 agent_config 归一为 Hilt 新形状。

    幂等：schema_version == 2 时做清理但不破坏已有新字段。
    """
    if not isinstance(cfg, dict) or not cfg:
        return build_default_agent_config_v2()

    out = build_default_agent_config_v2()

    # security：保留  approval_grant + legacy allow_yolo_mode。
    # 兼容旧入参 yolo_mode；authorization_preset 仅在缺 security 信号时推断。
    if isinstance(cfg.get("security"), dict):
        src_sec = cfg["security"]
        out_sec = out.setdefault("security", {})
        ym = src_sec.get("allow_yolo_mode")
        if not isinstance(ym, bool):
            ym = src_sec.get("yolo_mode")
        if isinstance(ym, bool):
            out_sec["allow_yolo_mode"] = ym
        grant = src_sec.get("approval_grant")
        if grant in ("always_ask", "auto", "full_access"):
            out_sec["approval_grant"] = grant
    elif isinstance(cfg.get("authorization_preset"), str):
        if cfg["authorization_preset"] in ("full_auto", "server_auto"):
            out["security"]["allow_yolo_mode"] = True
            out["security"]["approval_grant"] = "auto"

    # workspace_root / git_status
    # 注意：Soul 概念已整体移除（总控计划 D4），不再 preserve ``soul`` 子树。
    # "soul" 仍保留在下方 _SKIP_KEYS 中，使旧数据里的该子树被静默丢弃而非透传。
    if isinstance(cfg.get("workspace_root"), str):
        out["workspace_root"] = cfg["workspace_root"]
    if isinstance(cfg.get("git_status"), dict):
        out["git_status"] = deepcopy(cfg["git_status"])

    # agent_backend
    v1_backend = cfg.get("agent_backend")
    if isinstance(v1_backend, dict):
        backend_out = deepcopy(v1_backend)
    else:
        backend_out = {}
    backend_out["type"] = "builtin"
    backend_out["config_version"] = V2_SCHEMA_VERSION
    for deprecated in ("execution_mode", "legacy_mode", "skip_permissions", "acp_config"):
        backend_out.pop(deprecated, None)
    out["agent_backend"] = backend_out

    # conversation
    conv = cfg.get("conversation")
    if isinstance(conv, dict):
        _deep_merge_into(out["conversation"], conv)
    else:
        ctm = cfg.get("cross_turn_memory")
        if isinstance(ctm, bool):
            out["conversation"]["cross_turn_memory"] = ctm
        mhm = cfg.get("max_history_messages")
        if isinstance(mhm, int):
            out["conversation"]["max_history_messages"] = mhm

    # cost overrides（唯一保留的 capability）
    el = cfg.get("execution_limits")
    if isinstance(el, dict):
        set_capability_override(out, "cost", "execution_limits", deepcopy(el))
    caps = cfg.get("capabilities")
    if isinstance(caps, dict):
        overrides = caps.get("overrides")
        if isinstance(overrides, dict):
            cost = overrides.get("cost")
            if isinstance(cost, dict):
                _deep_merge_into(
                    out["capabilities"]["overrides"].setdefault("cost", {}),
                    cost,
                )

    # approval_memo 保留（Hilt §5.3）
    memo = cfg.get("approval_memo")
    if isinstance(memo, dict):
        out["approval_memo"] = deepcopy(memo)

    # memory 子树保留
    if "memory" in cfg and cfg["memory"] is not None:
        out["memory"] = deepcopy(cfg["memory"])

    # 保留未知顶层字段
    _SKIP_KEYS = (
        "schema_version", "runtime_plane", "authorization_preset",
        "capabilities", "conversation", "soul", "agent_backend",
        "workspace_root", "git_status", "memory", "security",
        "execution_env", "permission_mode", "approval_memo",
        "terminal_mode", "operation_switches", "sandbox", "sql_mode",
        "execution_limits", "device_permissions", "authorization_rules",
        "cross_turn_memory", "max_history_messages",
    )
    for k, v in cfg.items():
        if k in _SKIP_KEYS:
            continue
        out[k] = deepcopy(v) if isinstance(v, (dict, list)) else v

    return out


# ---------------------------------------------------------------------------
# 退役字段清场（Hilt W4 收尾 · 阶段1 数据治理）
# ---------------------------------------------------------------------------

def strip_retired_agent_config_fields(
    cfg: Optional[Dict[str, Any]],
) -> tuple[Dict[str, Any], bool]:
    """从 agent_config 移除 Hilt W4 退役字段，返回 ``(new_cfg, changed)``。

    退役字段（产品已不消费，纯死数据）：
      - ``capabilities.overrides.{shell,filesystem,network,sql,device,audit}``
      - ``capabilities.preset``
      - 顶层 ``authorization_preset``（pop 前若 security 缺 grant/yolo 信号则抢救）
      - 顶层 ``soul``
      - ``security.yolo_mode``（v3 改名前的旧键；归一到 allow_yolo_mode 后丢弃）

    **保留**一切活跃字段：cost / security（``approval_grant`` + legacy
    ``allow_yolo_mode``）/ conversation / agent_backend / memory /
    workspace_root / git_status / approval_memo 等——尤其 ``approval_memo``
    与  的 ``approval_grant`` 是用户授权数据，本函数绝不触碰。

    纯函数：不改入参（deepcopy 后操作）；非 dict 原样返回。幂等：已清净的
    cfg 返回 ``changed=False``。被数据迁移 0055 与 ``migrate_auth_to_v3``
    command 共用，避免清理逻辑两处漂移。
    """
    if not isinstance(cfg, dict):
        return cfg, False  # type: ignore[return-value]

    out = deepcopy(cfg)
    changed = False

    # 1. 先从旧 authorization_preset 抢救 yolo/grant 信号（pop 前推断），仅在
    #    security 缺 allow_yolo_mode / approval_grant 时补，避免覆盖用户显式值。
    old_preset = out.get("authorization_preset")
    if isinstance(old_preset, str):
        sec = out.get("security")
        if not isinstance(sec, dict):
            sec = {}
            out["security"] = sec
        if "allow_yolo_mode" not in sec and "approval_grant" not in sec:
            if old_preset in ("full_auto", "server_auto"):
                sec["allow_yolo_mode"] = True
                sec["approval_grant"] = "auto"
                changed = True

    # 2. 顶层退役字段
    for key in ("authorization_preset", "soul"):
        if key in out:
            out.pop(key, None)
            changed = True

    # 3. 旧键 yolo_mode → allow_yolo_mode（保留  legacy 同步字段）
    sec = out.get("security")
    if isinstance(sec, dict):
        if "yolo_mode" in sec and "allow_yolo_mode" not in sec:
            sec["allow_yolo_mode"] = bool(sec.pop("yolo_mode"))
            changed = True
        elif sec.pop("yolo_mode", None) is not None:
            changed = True

    # 4. capabilities.preset + overrides 退役分组
    caps = out.get("capabilities")
    if isinstance(caps, dict):
        if "preset" in caps:
            caps.pop("preset", None)
            changed = True
        overrides = caps.get("overrides")
        if isinstance(overrides, dict):
            for grp in RETIRED_CAPABILITY_GROUPS:
                if grp in overrides:
                    overrides.pop(grp, None)
                    changed = True

    return out, changed


__all__ = [
    "V2_SCHEMA_VERSION",
    "CAPABILITY_GROUPS",
    "RETIRED_CAPABILITY_GROUPS",
    "build_default_agent_config_v2",
    "get_capability_override",
    "set_capability_override",
    "migrate_v1_to_v2",
    "strip_retired_agent_config_fields",
    "V1_TO_V2_CAPABILITY_MAP",
    "V1_SANDBOX_TO_V2_MAP",
]
