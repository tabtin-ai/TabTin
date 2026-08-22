"""
System table definitions — DEPRECATED & REMOVED

历史上为每个 Space 预建 7 张系统表（app_registry, execution_log,
task_list, conversation_log, agent_soul, key_matters, user_preferences）。
经评估这些表在产品中从未被 Agent 实际使用，已全部移除。

Agent 配置现统一由 Space.agent_config (JSONField) 管理；
App 注册信息由 Unified Skills + tool_registry JSON 提供。
"""

from typing import Any

SystemTableDef = dict[str, Any]

ALL_SYSTEM_TABLES: list[SystemTableDef] = []
