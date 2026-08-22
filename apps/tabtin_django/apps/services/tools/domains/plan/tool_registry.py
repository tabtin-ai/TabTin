"""
Plan 工具域注册（Wave 1-C）

与既有 tabdoc / common 等域的注册形态保持一致：lazy load + 线程安全。
"""

from __future__ import annotations

import logging
import threading
from typing import List

from apps.services.tools import BaseTool

from . import get_plan_tools

logger = logging.getLogger(__name__)

_REGISTERED_TOOLS: List[BaseTool] | None = None
_TOOLS_LOCK = threading.Lock()


def _ensure_tools_loaded() -> None:
    global _REGISTERED_TOOLS
    if _REGISTERED_TOOLS is not None:
        return
    with _TOOLS_LOCK:
        if _REGISTERED_TOOLS is not None:
            return
        _REGISTERED_TOOLS = get_plan_tools()
        logger.debug("[PlanToolRegistry] Loaded %s tools", len(_REGISTERED_TOOLS))


def get_all_tools() -> List[BaseTool]:
    _ensure_tools_loaded()
    return _REGISTERED_TOOLS or []


def get_tool_by_name(tool_name: str) -> BaseTool | None:
    _ensure_tools_loaded()
    for tool in _REGISTERED_TOOLS or []:
        if tool.tool_name == tool_name:
            return tool
    return None


__all__ = ["get_all_tools", "get_tool_by_name"]
