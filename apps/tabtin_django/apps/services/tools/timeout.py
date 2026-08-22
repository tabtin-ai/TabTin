"""
resolve_tool_timeout — 统一的工具超时解析

从 orchestration.engine.tool_executor 提取的纯函数，无外部依赖。
"""

from __future__ import annotations

_TIMEOUT_BY_CATEGORY = {
    'terminal': 120,
    'browser': 120,
    'web': 60,
    'write_file': 60,
    'read_file': 30,
    'search': 30,
    'data_mutation': 120,
}
_DEFAULT_TOOL_TIMEOUT = 60


def resolve_tool_timeout(tool) -> int:
    """统一的超时解析入口：显式 timeout > category 默认 > 全局默认 60s。

    所有需要获取工具超时值的路径应调用此函数，而非直接读 tool.timeout。
    """
    explicit = getattr(tool, "timeout", 0)
    if explicit > 0:
        return explicit
    return _TIMEOUT_BY_CATEGORY.get(
        getattr(tool, "category", "") or "", _DEFAULT_TOOL_TIMEOUT
    )


__all__ = ["resolve_tool_timeout"]
