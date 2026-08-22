"""
Multiagent 可观测性模块。

提供结构化错误分类等能力。
"""

from apps.services.agent_engine.observability.error_category import (
    AgentErrorCategory,
    record_error_event,
)

__all__ = [
    "AgentErrorCategory",
    "record_error_event",
]
