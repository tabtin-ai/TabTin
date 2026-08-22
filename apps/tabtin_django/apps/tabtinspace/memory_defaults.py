"""
Memory 配置默认值 — 唯一权威来源 (Single Source of Truth)

所有 Memory 相关默认值必须从此模块导入，禁止在其他位置硬编码。

消费者:
    - tabtinspace.services.space_service (Space 创建/更新校验)
    - apps.services.agent_engine.services.memory_table_service (配置解析与合并)
    - apps.services.agent_engine.middleware.compaction_coordinator (运行时回退)
    - tabtinspace.routers.shared._serialize_space_data (API 返回时填充)
    - 前端 packages/app-shell MEMORY_DEFAULTS_V2 (需手动同步)
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any, Dict, Set

VALID_MEMORY_VERSIONS: Set[str] = {"v2.0"}

VALID_OBSERVER_MODES: Set[str] = {"auto", "selective", "off"}

VALID_SESSION_SUMMARIZATION_STRATEGIES: Set[str] = {"auto_condense", "native", "prune_only"}

VALID_CONFLICT_STRATEGIES: Set[str] = {"latest_wins", "manual", "keep_both"}

MEMORY_DEFAULTS_V2: Dict[str, Any] = {
    "enabled": False,
    "version": "v2.0",

    "working_memory": {
        "strategy": "auto_condense",
        "pressure_threshold": 0.75,
        "emergency_keep_messages": 8,
        "max_summary_tokens": 1024,
        "pre_compaction_extract": True,
        "summary_to_task_memory": True,
    },

    "observer": {
        "mode": "auto",
        "dedup_threshold": 0.75,
        "incremental_interval": 10,
        "idle_timeout_minutes": 30,
        "override_detection": True,
    },

    "injection": {
        "auto_inject": True,
        "max_memory_tokens": 2000,
        "pinned_max_ratio": 0.30,
        "today_session_max_ratio": 0.40,
        "today_window_hours": 18,
        "similarity_threshold": 0.6,
        "recency_half_life_days": 14,
        "pressure_downgrade": True,
        "error_pitfall_recall": True,
    },

    "maintenance": {
        "compaction_interval_hours": 6,
        "importance_adjust_interval_hours": 12,
        "conflict_detection": True,
        "conflict_strategy": "latest_wins",
        "capacity_limit_fragments": 5000,
        "capacity_limit_task_summaries": 1000,
    },

    "tools": {
        "search_enabled": True,
        "delete_enabled": True,
        "write_enabled": False,
    },
}


def get_memory_defaults_v2() -> Dict[str, Any]:
    """返回 v2.0 默认值的深拷贝。"""
    return deepcopy(MEMORY_DEFAULTS_V2)


def get_session_summarization_defaults() -> Dict[str, Any]:
    """返回 session_summarization/working_memory 子配置的深拷贝。"""
    return deepcopy(MEMORY_DEFAULTS_V2["working_memory"])


def get_memory_version(raw: Any) -> str:
    """从 memory 配置中读取版本，默认 v2.0。"""
    if isinstance(raw, dict):
        v = raw.get("version", "v2.0")
        return v if v in VALID_MEMORY_VERSIONS else "v2.0"
    return "v2.0"


def resolve_full_memory_config(raw: Any) -> Dict[str, Any]:
    """将部分 memory 配置合并为完整配置（缺失字段用默认值填充）。"""
    if not isinstance(raw, dict):
        return get_memory_defaults_v2()

    defaults = MEMORY_DEFAULTS_V2
    result: Dict[str, Any] = {
        "enabled": raw.get("enabled", defaults["enabled"]),
        "version": "v2.0",
    }
    for section in ("working_memory", "observer", "injection", "maintenance",
                     "tools"):
        section_raw = raw.get(section, {})
        if not isinstance(section_raw, dict):
            section_raw = {}
        result[section] = {**defaults[section], **section_raw}

    return result


__all__ = [
    "MEMORY_DEFAULTS_V2",
    "VALID_MEMORY_VERSIONS",
    "VALID_OBSERVER_MODES",
    "VALID_SESSION_SUMMARIZATION_STRATEGIES",
    "VALID_CONFLICT_STRATEGIES",
    "get_memory_defaults_v2",
    "get_session_summarization_defaults",
    "get_memory_version",
    "resolve_full_memory_config",
]
