from __future__ import annotations

import logging
import threading
from typing import List

from apps.services.tools import BaseTool
from apps.services.tools.domains.web_scraper import get_web_scraper_tools

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
        _REGISTERED_TOOLS = get_web_scraper_tools()
        logger.debug("[WebScraperToolRegistry] Loaded %s tools", len(_REGISTERED_TOOLS))


def get_all_tools() -> List[BaseTool]:
    _ensure_tools_loaded()
    return _REGISTERED_TOOLS


def get_tool_by_name(tool_name: str) -> BaseTool | None:
    _ensure_tools_loaded()
    for tool in _REGISTERED_TOOLS:
        if tool.name == tool_name:
            return tool
    logger.warning("[WebScraperToolRegistry] Tool not found: %s", tool_name)
    return None


__all__ = ["get_all_tools", "get_tool_by_name"]
