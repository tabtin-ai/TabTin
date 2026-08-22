"""
RAG Tool Registry - 向量检索工具注册中心
"""

import threading
from typing import List
import logging

from apps.services.tools import BaseTool
from apps.services.tools.domains.rag.rag_search import RagSearchTool

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
        _REGISTERED_TOOLS = [RagSearchTool()]
        logger.debug("[RAGToolRegistry] Loaded %s tools", len(_REGISTERED_TOOLS))


def get_all_tools() -> List[BaseTool]:
    """获取所有 RAG 工具"""
    _ensure_tools_loaded()
    return _REGISTERED_TOOLS


def get_tool_by_name(tool_name: str) -> BaseTool | None:
    """根据名称获取工具"""
    _ensure_tools_loaded()
    for tool in _REGISTERED_TOOLS:
        if tool.tool_name == tool_name:
            return tool
    logger.warning("[RAGToolRegistry] Tool not found: %s", tool_name)
    return None


__all__ = ["get_all_tools", "get_tool_by_name"]
