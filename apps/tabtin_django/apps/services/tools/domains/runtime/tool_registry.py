"""
Runtime Tool Registry — 运行时协调原语

提供 Agent 执行过程中的协调能力：
- monitor_process: 启动长驻进程并实时接收 stdout
- stop_monitor: 停止运行中的 Monitor
- list_monitors: 列出当前会话的所有 Monitor
"""

import logging
from typing import List

from apps.services.tools import BaseTool
from apps.services.tools.domains.runtime.monitor_tool import (
    MonitorProcessTool,
    StopMonitorTool,
    ListMonitorsTool,
)

logger = logging.getLogger(__name__)


def get_all_tools() -> List[BaseTool]:
    return [
        MonitorProcessTool(),
        StopMonitorTool(),
        ListMonitorsTool(),
    ]


def get_tool_by_name(tool_name: str):
    for tool in get_all_tools():
        if tool.name == tool_name:
            return tool
    return None


__all__ = ["get_all_tools", "get_tool_by_name"]
