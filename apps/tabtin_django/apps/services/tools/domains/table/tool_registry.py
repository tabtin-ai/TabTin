"""
Table Tool Registry - 表格分析工具注册中心

注意：table 域只包含表格专属工具。
"""

import threading
from typing import List
import logging

from apps.services.tools import BaseTool
from apps.services.tools.domains.table import get_all_table_operation_tools

logger = logging.getLogger(__name__)

_REGISTERED_TOOLS: List[BaseTool] | None = None
_TOOLS_LOCK = threading.Lock()


def _ensure_tools_loaded():
    global _REGISTERED_TOOLS
    if _REGISTERED_TOOLS is not None:
        return
    with _TOOLS_LOCK:
        if _REGISTERED_TOOLS is not None:
            return
        base_tools = get_all_table_operation_tools()
        for tool in base_tools:
            if not getattr(tool, "app_id", None):
                object.__setattr__(tool, "app_id", "tabdata")
        _REGISTERED_TOOLS = base_tools
        logger.debug("[TableToolRegistry] Loaded %s tools", len(_REGISTERED_TOOLS))


def get_all_tools() -> List[BaseTool]:
    _ensure_tools_loaded()
    return _REGISTERED_TOOLS


def get_tool_by_name(tool_name: str) -> BaseTool | None:
    _ensure_tools_loaded()
    for tool in _REGISTERED_TOOLS:
        if tool.tool_name == tool_name:
            return tool
    logger.warning("[TableToolRegistry] Tool not found: %s", tool_name)
    return None


def get_tool_info() -> List[dict]:
    _ensure_tools_loaded()
    info = []
    for tool in _REGISTERED_TOOLS:
        info.append({
            "name": tool.tool_name,
            "description": tool.description,
            "timeout": tool.timeout,
            "requires_permission": tool.requires_permission,
            "class_name": tool.__class__.__name__,
        })
    return info


__all__ = ["get_all_tools", "get_tool_by_name", "get_tool_info"]
