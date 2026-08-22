"""
设备管理工具。

- LaunchWithIntentTool: 通过 Android Intent 启动系统功能或第三方 App
- SaveToDeviceTool: 下载 URL 文件保存到手机本地
- GetAutomationStatusTool: 查询自动化能力的实时状态
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from pydantic import BaseModel, Field

from apps.services.tools.domains.device.device_query_tools import DeviceQueryInput, _BaseDeviceQueryTool

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Input schemas
# ---------------------------------------------------------------------------


class LaunchWithIntentInput(DeviceQueryInput):
    action: str = Field(
        min_length=1,
        max_length=500,
        description=(
            "Android Intent action string "
            "(e.g. 'android.intent.action.VIEW', 'android.intent.action.SEND', "
            "'android.intent.action.SENDTO')"
        ),
    )
    data_uri: Optional[str] = Field(
        default=None,
        max_length=2000,
        description=(
            "Intent data URI "
            "(e.g. 'https://example.com', 'geo:37.7749,-122.4194', "
            "'mailto:user@example.com')"
        ),
    )
    mime_type: Optional[str] = Field(
        default=None,
        max_length=200,
        description="MIME type for the Intent (e.g. 'text/plain', 'image/*')",
    )
    target_package: Optional[str] = Field(
        default=None,
        max_length=200,
        description="Target app package name to restrict Intent delivery (e.g. 'com.android.chrome')",
    )
    extras: Optional[Dict[str, Any]] = Field(
        default=None,
        description="Extra key-value pairs to add to the Intent bundle",
    )


class SaveToDeviceInput(DeviceQueryInput):
    url: str = Field(
        min_length=1,
        max_length=2000,
        description="URL of the file to download and save to the device",
    )
    filename: Optional[str] = Field(
        default=None,
        max_length=255,
        description="Desired filename for the saved file (auto-generated from URL if not provided)",
    )
    save_to: str = Field(
        default="gallery",
        pattern=r"^(gallery|downloads)$",
        description="Target location: 'gallery' (photo album) or 'downloads' (download directory)",
    )


class GetAutomationStatusInput(DeviceQueryInput):
    pass


# ---------------------------------------------------------------------------
# Tool classes
# ---------------------------------------------------------------------------


class _DeviceManagementTool(_BaseDeviceQueryTool):
    """Device management tool base — review risk, write permission."""

    risk_level: str = "review"
    required_permission: str = "write"
    timeout: int = 120
    fallback_error: str = "Device operation failed"

    def run(self, *, user_id=None, current_space_id=None, **kwargs) -> Dict[str, Any]:
        return self._run_query(
            user_id=user_id,
            current_space_id=current_space_id,
            params=self._extract_device_params(kwargs),
            fallback_error=self.fallback_error,
        )


class LaunchWithIntentTool(_DeviceManagementTool):
    name: str = "launch_with_intent"
    description: str = (
        "通过 Android Intent 启动系统功能或第三方 App。"
        "可用于分享文件、打开 URL、发送邮件、导航等跨 App 协作场景。"
        "支持指定 action、data URI、MIME type、目标包名和 extras。"
    )
    args_schema: type[BaseModel] = LaunchWithIntentInput
    fallback_error: str = "Failed to launch intent on device"


class SaveToDeviceTool(_DeviceManagementTool):
    name: str = "save_to_device"
    description: str = (
        "将 URL 指向的文件下载保存到手机本地（相册或下载目录）。"
        "常用于保存截图、下载文件。"
        "save_to='gallery' 保存到相册，'downloads' 保存到下载目录。"
    )
    args_schema: type[BaseModel] = SaveToDeviceInput
    fallback_error: str = "Failed to save file to device"


class GetAutomationStatusTool(_BaseDeviceQueryTool):
    name: str = "get_automation_status"
    description: str = (
        "查询手机自动化能力的实时状态（ADB 连接、特权进程、可用能力列表）。"
        "用于在操作前确认设备就绪。"
        "返回包含连接状态、特权进程状态、可用能力列表的诊断信息。"
    )
    risk_level: str = "safe"
    required_permission: str = "read"
    args_schema: type[BaseModel] = GetAutomationStatusInput
    fallback_error: str = "Failed to get automation status from device"

    def run(
        self,
        user_id: Optional[str] = None,
        current_space_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        return self._run_query(
            user_id=user_id,
            current_space_id=current_space_id,
            fallback_error=self.fallback_error,
        )


__all__ = [
    "LaunchWithIntentTool",
    "SaveToDeviceTool",
    "GetAutomationStatusTool",
]
