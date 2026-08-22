"""
Common Tool Registry - 通用工具注册中心

提供跨域共享的通用工具：
- WebSearchTool: Web 搜索（从 code 域迁移，属通用能力）
- PresentToUserTool / ShowWidgetTool: 富内容展示

RetrieveToolResultTool 已随 agent-runtime W3（2026-05-10）退役——TS 端不再
暴露该 FC；本 registry 不再注册，避免复活到 LLM inventory。模块
``tool_result_retrieve.py`` 仍保留作内部退役兜底，勿重新挂回 get_all_tools。

历史 ask_question 工具（manifest metadata 壳，run() 不会被实际调用）已随
Wave 11 云端 langgraph 下线 + Wave 5 ask 三件套（ask_choice / ask_form /
request_approval）拆分一并清除——三件套在 TS @tabtin/agent-runtime 端实现，
Python 端不再镜像注册。
"""

import threading
from typing import List
import logging

from apps.services.tools import BaseTool
from apps.services.tools.domains.common.web_search import WebSearchTool
from apps.services.tools.domains.common.present_to_user import PresentToUserTool
from apps.services.tools.domains.common.show_widget import ShowWidgetTool

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
        _REGISTERED_TOOLS = [
            PresentToUserTool(),
            ShowWidgetTool(),
            WebSearchTool(),
        ]
        logger.debug("[CommonToolRegistry] Loaded %s tools", len(_REGISTERED_TOOLS))


def get_all_tools() -> List[BaseTool]:
    """获取所有通用工具"""
    _ensure_tools_loaded()
    return _REGISTERED_TOOLS


def get_tool_by_name(tool_name: str) -> BaseTool | None:
    """根据名称获取工具"""
    _ensure_tools_loaded()
    for tool in _REGISTERED_TOOLS:
        if tool.tool_name == tool_name:
            return tool
    logger.warning("[CommonToolRegistry] Tool not found: %s", tool_name)
    return None


__all__ = ["get_all_tools", "get_tool_by_name"]
