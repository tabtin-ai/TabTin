"""W2.1 数据迁移：把 ``Agent.agent_config`` 与
``SoulPreset.agent_config_overrides`` 从 v1 形状（顶层 terminal_mode /
operation_switches / sandbox / sql_mode / execution_limits / ...）重塑为
v2 嵌套形状（schema_version=2 / runtime_plane / capabilities.overrides 7
分组 / conversation / soul / agent_backend / 顶层 workspace_root + git_status）。

▣ 不可逆 migration：未实现 reverse_code，与 W2.1.0 决议 §4.2 + D-tech-3
  「不留 v1 兼容层」一致。

▣ 幂等性：``cfg.get('schema_version') == 2`` 直接跳过本行，可安全重跑。

▣ 生效范围：
  - tabtinspace_agent.agent_config（每条记录）
  - tabtinspace_soulpreset.agent_config_overrides（每条记录）

▣ 边界处理：
  - permission_mode legacy 字段 → 与 authorization_preset 一致性校验后丢弃
  - agent_backend.type 历史脏值 → 统一 'builtin'
  - memory 子树 → **保留**（D2 / TabMemo 后续专题清理）
  - execution_env / execution_mode / legacy_mode / skip_permissions / acp_config → 删除

▣ 转换函数：复用 apps.tabtinspace.agent_config_v2.migrate_v1_to_v2 纯函数
  （无 ORM 依赖，migration 安全 import）。

W2.1.0 决议 §4。
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any, Dict, Optional

from django.db import migrations


# ---------------------------------------------------------------------------
# SoulPreset.agent_config_overrides v1 → v2 normalize（**partial patch**）
# ---------------------------------------------------------------------------
#
# Agent.agent_config 是完整 cfg —— 直接 ``migrate_v1_to_v2`` 把 v1 → 完整 v2。
# 但 SoulPreset.agent_config_overrides 是「应用 Soul 时 deep-merge 到 agent
# config 上的 partial patch」—— 不能引入 v2 default 字段（否则一旦应用 Soul，
# 会把 default 值覆盖到用户已自定义的字段上）。
#
# 因此 ``_normalize_soul_overrides_to_v2`` 只**搬位置**，不补 default：
#   v1 顶层 terminal_mode/operation_switches/sandbox/sql_mode/...
#     → v2 capabilities.overrides.<cap>.<field>
#   v1 cross_turn_memory/max_history_messages → v2 conversation.<field>
#   v1 execution_env / permission_mode → 删除
#   v1 memory.* 子树 → 保留（TabMemo 后续专题清理）
#
# 与 ``apps.tabtinspace.agent_config_v2.migrate_v1_to_v2`` 的语义差异：
#   - 不调用 build_default_agent_config_v2（不补默认）
#   - 不强制写 schema_version（因为 patch 不应有顶层 schema_version 字段）
#   - 不强制 agent_backend.type='builtin'（patch 通常不带 agent_backend）

# v1 顶层 / sandbox 子字典 → v2 (cap_id, field_name) 映射
#
# **SSoT 在** ``apps.tabtinspace.agent_config_v2`` 模块（``V1_TO_V2_CAPABILITY_MAP``
# / ``V1_SANDBOX_TO_V2_MAP``）。本 migration 通过 lazy getter 引用，避免在
# module load 时触发跨 app import（Django MigrationLoader 偏好 migration module
# 顶层零依赖）。修改字段映射时只改 ``agent_config_v2.py`` 一处，本 migration
# 自动同步——避免 SSoT 双份漂移。
def _get_v1_top_to_v2_path():
    from apps.tabtinspace.agent_config_v2 import V1_TO_V2_CAPABILITY_MAP
    return V1_TO_V2_CAPABILITY_MAP


def _get_v1_sandbox_to_v2_path():
    from apps.tabtinspace.agent_config_v2 import V1_SANDBOX_TO_V2_MAP
    return V1_SANDBOX_TO_V2_MAP


def _set_capability_path(
    out: Dict[str, Any], cap_id: str, field_name: str, value: Any,
) -> None:
    out.setdefault("capabilities", {})
    out["capabilities"].setdefault("overrides", {})
    out["capabilities"]["overrides"].setdefault(cap_id, {})
    out["capabilities"]["overrides"][cap_id][field_name] = value


def _normalize_soul_overrides_to_v2(
    cfg: Optional[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    """把 v1 形状的 SoulPreset.agent_config_overrides partial patch 转 v2 partial patch。

    幂等：``cfg.get('schema_version') == 2`` 或已含 capabilities 嵌套 → 直接 deepcopy 返回。
    """
    if not isinstance(cfg, dict) or not cfg:
        return cfg

    if cfg.get("schema_version") == 2:
        return deepcopy(cfg)

    # 检测是否已是 v2 形状（capabilities/conversation 已存在 + 无 v1 顶层字段）
    has_v2_block = isinstance(cfg.get("capabilities"), dict) or isinstance(
        cfg.get("conversation"), dict
    )
    has_v1_top = any(
        k in cfg for k in (
            "terminal_mode", "operation_switches", "sandbox", "sql_mode",
            "execution_limits", "device_permissions", "authorization_rules",
            "cross_turn_memory", "max_history_messages",
            "execution_env", "permission_mode",
        )
    )
    if has_v2_block and not has_v1_top:
        # 已是 v2 patch，直接返回
        return deepcopy(cfg)

    out: Dict[str, Any] = {}

    # 顶层字段保留（authorization_preset / soul / workspace_root / git_status）
    for top_key in (
        "authorization_preset", "soul", "workspace_root", "git_status",
        "runtime_plane", "agent_backend",
    ):
        if top_key in cfg:
            v = cfg[top_key]
            out[top_key] = deepcopy(v) if isinstance(v, (dict, list)) else v

    # capabilities.preset 与 authorization_preset 同步（如果原 patch 有顶层 preset）
    if "authorization_preset" in cfg and isinstance(cfg["authorization_preset"], str):
        out.setdefault("capabilities", {})
        out["capabilities"]["preset"] = cfg["authorization_preset"]

    # 已有 v2 capabilities 块直接保留
    if isinstance(cfg.get("capabilities"), dict):
        existing = deepcopy(cfg["capabilities"])
        if "capabilities" in out:
            # 合并已有 preset + incoming overrides
            existing.setdefault("preset", out["capabilities"].get("preset"))
            out["capabilities"] = existing
        else:
            out["capabilities"] = existing

    # conversation 块：合并 v1 顶层 + 已有 v2 块
    conversation: Dict[str, Any] = {}
    if isinstance(cfg.get("conversation"), dict):
        conversation.update(deepcopy(cfg["conversation"]))
    if isinstance(cfg.get("cross_turn_memory"), bool):
        conversation["cross_turn_memory"] = cfg["cross_turn_memory"]
    if isinstance(cfg.get("max_history_messages"), int):
        conversation["max_history_messages"] = cfg["max_history_messages"]
    if conversation:
        out["conversation"] = conversation

    # v1 顶层独立字段 → v2 capabilities.overrides 嵌套
    # （SSoT 在 agent_config_v2.V1_TO_V2_CAPABILITY_MAP）
    for v1_key, (cap_id, field_name) in _get_v1_top_to_v2_path().items():
        v1_val = cfg.get(v1_key)
        if v1_val is None:
            continue
        if isinstance(v1_val, dict):
            _set_capability_path(out, cap_id, field_name, deepcopy(v1_val))
        elif isinstance(v1_val, list):
            _set_capability_path(out, cap_id, field_name, list(v1_val))
        else:
            _set_capability_path(out, cap_id, field_name, v1_val)

    # v1 sandbox 子字典展开（SSoT 在 agent_config_v2.V1_SANDBOX_TO_V2_MAP）
    v1_sandbox = cfg.get("sandbox")
    if isinstance(v1_sandbox, dict):
        for sub_key, (cap_id, field_name) in _get_v1_sandbox_to_v2_path().items():
            sub_val = v1_sandbox.get(sub_key)
            if sub_val is None:
                continue
            if isinstance(sub_val, list):
                _set_capability_path(out, cap_id, field_name, list(sub_val))
            else:
                _set_capability_path(out, cap_id, field_name, sub_val)

    # memory 子树保留（partial patch 的 memory 仍可能被 deep-merge 到 agent cfg）
    if "memory" in cfg and cfg["memory"] is not None:
        out["memory"] = deepcopy(cfg["memory"])

    # legacy 字段删除：execution_env / permission_mode（D2 决议）
    # 不显式 copy；out 中也不会包含

    # 保留其它未知字段（避免污染未在映射表中的扩展字段，如 personality 等）
    _SKIP_KEYS = {
        "schema_version", "execution_env", "permission_mode",
        "terminal_mode", "operation_switches", "sandbox",
        "sql_mode", "execution_limits", "device_permissions",
        "authorization_rules", "cross_turn_memory", "max_history_messages",
        "authorization_preset", "capabilities", "conversation",
        "soul", "workspace_root", "git_status", "runtime_plane",
        "agent_backend", "memory",
    }
    for k, v in cfg.items():
        if k in _SKIP_KEYS:
            continue
        out[k] = deepcopy(v) if isinstance(v, (dict, list)) else v

    return out


def _migrate_agent_configs(apps, schema_editor):
    """正向 RunPython：所有 Agent.agent_config + SoulPreset.agent_config_overrides
    重塑为 v2 形状。

    Agent.agent_config 用 ``migrate_v1_to_v2`` 全 default 转换；
    SoulPreset.agent_config_overrides 用 ``_normalize_soul_overrides_to_v2``
    保持 partial patch 语义（不引入 v2 default 字段污染 deep-merge 目标）。
    """
    # 在 migration 内部 import 纯函数（不触碰 ORM 模型，避免循环）。
    from apps.tabtinspace.agent_config_v2 import (
        V2_SCHEMA_VERSION,
        migrate_v1_to_v2,
    )

    Agent = apps.get_model("tabtinspace", "Agent")
    SoulPreset = apps.get_model("tabtinspace", "SoulPreset")

    # ── tabtinspace_agent.agent_config ────────────────────────────
    # iterator() 防止大表载入内存；只查需要的两列。
    for agent in Agent.objects.using(schema_editor.connection.alias).only(
        "id", "agent_config"
    ).iterator():
        cfg = agent.agent_config
        if not isinstance(cfg, dict):
            # 形态异常（None / list / str）→ 写入 v2 default 兜底
            new_cfg = migrate_v1_to_v2(None)
            Agent.objects.using(schema_editor.connection.alias).filter(
                pk=agent.pk
            ).update(agent_config=new_cfg)
            continue
        if cfg.get("schema_version") == V2_SCHEMA_VERSION:
            continue
        new_cfg = migrate_v1_to_v2(cfg)
        Agent.objects.using(schema_editor.connection.alias).filter(
            pk=agent.pk
        ).update(agent_config=new_cfg)

    # ── tabtinspace_soulpreset.agent_config_overrides ──────────────
    # SoulPreset 数据通常 < 100 条，直接遍历。
    for preset in SoulPreset.objects.using(
        schema_editor.connection.alias
    ).only("id", "agent_config_overrides").iterator():
        cfg = preset.agent_config_overrides
        if not isinstance(cfg, dict) or not cfg:
            continue
        if cfg.get("schema_version") == V2_SCHEMA_VERSION:
            continue
        new_cfg = _normalize_soul_overrides_to_v2(cfg)
        SoulPreset.objects.using(schema_editor.connection.alias).filter(
            pk=preset.pk
        ).update(agent_config_overrides=new_cfg)

    # 不在 migration 内打印（保持 silent）。统计数据由 dry-run 命令呈现。


class Migration(migrations.Migration):

    dependencies = [
        ("tabtinspace", "0043_add_device_app_install_snapshot"),
    ]

    operations = [
        # 仅数据迁移，不改 schema（agent_config 仍是 JSONField）。
        migrations.RunPython(
            _migrate_agent_configs,
            reverse_code=migrations.RunPython.noop,
            # ▲ noop：本 migration 不可逆，反向降级回 v1 不在本 wave 范围
            # （W2.1.0 决议 §4.2 + D-tech-3）。如需回滚 v1，需手工脚本。
        ),
    ]
