"""
设备工具注册表

CMI-027: 此模块注册 Django **device 域**工具。

    Django Agent → DeviceRuntimeQueryService → ActionTransport（WebSocket）→
    设备侧 **device_runtime** 执行 action。
    适用场景：服务端 7×24、渠道消息回调、定时任务（Scheduler/Celery）、
    无桌面/headless 环境；依赖 Space 已绑定且在线的能力设备，走服务端鉴权与审计。
"""
from __future__ import annotations

from typing import List

from apps.services.tools import BaseTool

from .device_management_tools import (
    GetAutomationStatusTool,
    LaunchWithIntentTool,
    SaveToDeviceTool,
)
from .device_query_tools import (
    GetBatteryInfoTool,
    GetDeviceInfoTool,
    GetNetworkInfoTool,
)
from .mobile_data_tools import (
    GetLocationTool,
    ListInstalledAppsTool,
    MakeCallTool,
    ReadCalendarTool,
    ReadCallLogTool,
    ReadContactsTool,
    ReadMediaTool,
    ReadNotificationsTool,
    ReadSmsTool,
    SearchContactsTool,
    SendSmsTool,
)
from .screen_automation_tools import (
    GetSystemSettingTool,
    ScreenCaptureTool,
    ScreenFindElementTool,
    ScreenForceStopAppTool,
    ScreenGetContextTool,
    ScreenKeyEventTool,
    ScreenLaunchAppTool,
    ScreenOpenAppTool,
    ScreenLongPressElementTool,
    ScreenLongPressTool,
    ScreenSnapshotTool,
    ScreenSwipeTool,
    ScreenTapAreaTool,
    ScreenTapElementTool,
    ScreenTapTool,
    ScreenTypeInElementTool,
    ScreenTypeSecretTool,
    ScreenTypeTextTool,
    ScreenUiTreeTool,
    ScreenWaitForElementTool,
    ScreenWaitForIdleTool,
    SetStealthModeTool,
    SetSystemSettingTool,
)


# P1-FUN-5: 权限等级定义
# read  = 读取类（查询设备信息、读取数据）— viewer 权限即可
# write = 修改类（发短信、打电话、屏幕操作）— editor 权限
# admin = 危险操作（强制停止应用、修改系统设置）— admin 权限
PERMISSION_LEVELS = ("read", "write", "admin")


def get_all_tools() -> List[BaseTool]:
    return [
        # L0: zero-permission
        GetDeviceInfoTool(),
        GetBatteryInfoTool(),
        GetNetworkInfoTool(),
        # L1: standard permissions
        ReadContactsTool(),
        SearchContactsTool(),
        ReadSmsTool(),
        SendSmsTool(),
        ReadCallLogTool(),
        MakeCallTool(),
        ReadCalendarTool(),
        ReadNotificationsTool(),
        ListInstalledAppsTool(),
        ReadMediaTool(),
        GetLocationTool(),
        # L2: screen automation (ADB privileged process)
        ScreenCaptureTool(),
        ScreenSnapshotTool(),
        ScreenUiTreeTool(),
        ScreenTapTool(),
        ScreenTapAreaTool(),
        ScreenTapElementTool(),
        ScreenLongPressElementTool(),
        ScreenSwipeTool(),
        ScreenLongPressTool(),
        ScreenFindElementTool(),
        ScreenGetContextTool(),
        ScreenTypeTextTool(),
        ScreenTypeInElementTool(),
        ScreenTypeSecretTool(),
        ScreenKeyEventTool(),
        ScreenWaitForIdleTool(),
        ScreenWaitForElementTool(),
        ScreenLaunchAppTool(),
        ScreenOpenAppTool(),
        ScreenForceStopAppTool(),
        SetSystemSettingTool(),
        GetSystemSettingTool(),
        SetStealthModeTool(),
        # Device management
        LaunchWithIntentTool(),
        SaveToDeviceTool(),
        GetAutomationStatusTool(),
    ]


def get_tools_by_permission(level: str) -> List[BaseTool]:
    """返回指定权限等级的所有工具。"""
    return [t for t in get_all_tools() if getattr(t, "required_permission", "read") == level]


def get_tool_permission_map() -> dict[str, str]:
    """返回 {tool_name: required_permission} 映射。"""
    return {t.name: getattr(t, "required_permission", "read") for t in get_all_tools()}


__all__ = ["get_all_tools", "get_tools_by_permission", "get_tool_permission_map", "PERMISSION_LEVELS"]
