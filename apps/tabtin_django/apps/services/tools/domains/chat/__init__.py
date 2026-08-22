"""
Chat 命名空间 —— Wave 6 M6.1 清理后仅保留表格权限检查工具。

原前端交互工具（GetTabsInfoTool）随客户端 TS 实现上线而删除。
`TablePermissionChecker` 不是 ToolHub 工具，而是被多个域的 BaseTool
复用的权限检查 helper。
"""

from .permission_checker import TablePermissionChecker

__all__ = [
    'TablePermissionChecker',
]
