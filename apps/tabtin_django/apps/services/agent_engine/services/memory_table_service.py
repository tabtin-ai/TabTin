"""
MemoryTableService — Space 级记忆配置的解析与查询

v2.0 记忆数据统一写入 TabMemo Memo 表，
此 Service 仅提供配置解析和启用状态判断。
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


class MemoryTableService:
    """管理 Space 级记忆配置的查询与解析。"""

    @classmethod
    def is_memory_enabled(cls, agent_config: Dict[str, Any]) -> bool:
        """判断 memory 功能是否启用（per-Agent，已废弃于决策 1）。"""
        memory = agent_config.get("memory", {})
        if not isinstance(memory, dict):
            return False
        return bool(memory.get("enabled", False))

    @classmethod
    def is_memory_enabled_for(cls, user_id, space_id) -> bool:
        """per-(user, organization) 记忆开关 —— 决策 1 IA 重构后的唯一权威。

        记忆开关从 per-Agent（agent_config.memory.enabled）统一到
        per-(user, organization)（TabMemo 记忆偏好 MemoRecordStyle）。从 space
        解析 organization，读 MemoRecordStyle.enabled；缺记录默认开启
        （与 MemoRecordStyle 默认一致）。
        """
        if not user_id or not space_id:
            return False
        from apps.services.billing.organization_resolver import resolve_organization_id_from_space
        organization_id = resolve_organization_id_from_space(str(space_id))
        return cls.is_memory_enabled_for_organization(user_id, organization_id)

    @classmethod
    def is_memory_enabled_for_organization(cls, user_id, organization_id) -> bool:
        if not user_id or not organization_id:
            return False
        from apps.tabmemo.services.record_style_service import load_effective_record_style

        cfg = load_effective_record_style(str(user_id), str(organization_id))
        return bool(cfg.get("enabled", True))

    @classmethod
    def get_memory_config(cls, agent_config: Dict[str, Any]) -> Dict[str, Any]:
        """从 agent_config 提取 memory 配置并填充默认值。"""
        from apps.tabtinspace.memory_defaults import resolve_full_memory_config

        memory = agent_config.get("memory", {})
        return resolve_full_memory_config(memory)

    @classmethod
    def resolve_memory_context(cls, state: dict) -> Optional[Dict[str, Any]]:
        """从 middleware state 中解析 memory 上下文。

        Returns:
            dict with keys: memory_config, space_id
            or None if memory is not enabled/configured.
        """
        space_id = state.get("current_space_id")
        if not space_id:
            return None

        from apps.services.agent_engine.services.execution_context import fetch_space_snapshot
        snapshot = fetch_space_snapshot(space_id)
        if not snapshot:
            return None

        agent_config = snapshot.agent_config
        if not cls.is_memory_enabled(agent_config):
            return None

        memory_config = cls.get_memory_config(agent_config)

        return {
            "space_id": space_id,
            "memory_config": memory_config,
        }
