"""企业微信办公工具集。

提供通讯录查询、日程管理、待办管理、会议管理、消息历史等
企微办公能力，注册到 ToolHub 供 Agent 调用。
"""

from apps.services.tools import BaseTool

from .contact_tools import WecomContactLookupTool
from .schedule_tools import (
    WecomListSchedulesTool,
    WecomCreateScheduleTool,
    WecomCheckAvailabilityTool,
)
from .todo_tools import (
    WecomListTodosTool,
    WecomCreateTodoTool,
    WecomUpdateTodoTool,
)
from .meeting_tools import (
    WecomListMeetingsTool,
    WecomCreateMeetingTool,
    WecomCancelMeetingTool,
)
from .message_tools import (
    WecomGetChatListTool,
    WecomGetMessagesTool,
)


def get_wechat_work_tools() -> list[BaseTool]:
    """返回企业微信工具列表，供 ToolHub 注册使用。"""
    return [
        # 通讯录
        WecomContactLookupTool(),
        # 日程
        WecomListSchedulesTool(),
        WecomCreateScheduleTool(),
        WecomCheckAvailabilityTool(),
        # 待办
        WecomListTodosTool(),
        WecomCreateTodoTool(),
        WecomUpdateTodoTool(),
        # 会议
        WecomListMeetingsTool(),
        WecomCreateMeetingTool(),
        WecomCancelMeetingTool(),
        # 消息
        WecomGetChatListTool(),
        WecomGetMessagesTool(),
    ]


__all__ = [
    "WecomContactLookupTool",
    "WecomListSchedulesTool",
    "WecomCreateScheduleTool",
    "WecomCheckAvailabilityTool",
    "WecomListTodosTool",
    "WecomCreateTodoTool",
    "WecomUpdateTodoTool",
    "WecomListMeetingsTool",
    "WecomCreateMeetingTool",
    "WecomCancelMeetingTool",
    "WecomGetChatListTool",
    "WecomGetMessagesTool",
    "get_wechat_work_tools",
]
