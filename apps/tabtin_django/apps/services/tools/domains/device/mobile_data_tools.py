"""
移动设备数据查询工具 (L1)。

通过 DeviceRuntimeQueryService 向 Android/iOS 设备发送数据查询请求，
覆盖通讯录、短信、通话记录、日历、通知、应用列表、定位等标准权限能力。
"""

from __future__ import annotations

import logging
from typing import Annotated, Any, Dict, Literal, Optional

from pydantic import BaseModel, Field, field_validator

from apps.services.common.state.injected_state import InjectedState
from apps.services.tools.domains.device.device_query_tools import (
    _BaseDeviceQueryTool,
    _device_tool_error,
)

logger = logging.getLogger("device_audit")

# ---------------------------------------------------------------------------
# SMS 应用层速率限制 (HF2)
# ---------------------------------------------------------------------------
_SMS_RATE_LIMIT_PER_HOUR = 50
_SMS_RATE_KEY_TTL = 3600


def _check_sms_rate_limit(user_id: str) -> bool:
    """检查用户每小时短信发送是否超限。返回 True 表示允许发送。"""
    try:
        from django_redis import get_redis_connection
        client = get_redis_connection("default")
    except Exception:
        logger.warning("sms_rate_limit_skip | user=%s reason=redis_unavailable", user_id)
        return True

    key = f"sms_rate:{user_id}"
    try:
        current = client.incr(key)
        if current == 1:
            client.expire(key, _SMS_RATE_KEY_TTL)
        return current <= _SMS_RATE_LIMIT_PER_HOUR
    except Exception:
        logger.warning("sms_rate_limit_skip | user=%s reason=redis_error", user_id)
        return True


# ---------------------------------------------------------------------------
# Input schemas
# ---------------------------------------------------------------------------


class _MobileBaseInput(BaseModel):
    user_id: Annotated[Optional[str], InjectedState("user_id")] = Field(
        default=None, description="User ID (auto-injected)",
    )
    current_space_id: Annotated[Optional[str], InjectedState("current_space_id")] = Field(
        default=None, description="Space ID (auto-injected)",
    )


class ReadContactsInput(_MobileBaseInput):
    limit: int = Field(default=50, ge=1, le=500, description="Maximum number of contacts to return (1-500)")


class SearchContactsInput(_MobileBaseInput):
    query: str = Field(min_length=1, description="Name to search for in contacts")
    limit: int = Field(default=20, ge=1, le=200, description="Maximum results (1-200)")


class ReadSmsInput(_MobileBaseInput):
    limit: int = Field(default=20, ge=1, le=200, description="Maximum number of messages (1-200)")
    filter: Literal["inbox", "sent", "all"] = Field(
        default="inbox",
        description="SMS filter: 'inbox' (received), 'sent' (sent), or 'all' (both)",
    )


class SendSmsInput(_MobileBaseInput):
    to: str = Field(
        min_length=3, max_length=30,
        description="Recipient phone number (digits, optional leading +, spaces/hyphens/parentheses allowed)",
    )
    message: str = Field(
        max_length=500,
        description="SMS body text (max 500 chars ≈ 7 UCS-2 segments; longer texts are split into multiple billable SMS)",
    )

    @field_validator("to")
    @classmethod
    def validate_phone_to(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Phone number cannot be empty or all whitespace")
        if not any(c.isdigit() for c in v):
            raise ValueError("Phone number must contain at least one digit")
        return v


class ReadCallLogInput(_MobileBaseInput):
    limit: int = Field(default=20, ge=1, le=200, description="Maximum number of call records (1-200)")


class MakeCallInput(_MobileBaseInput):
    number: str = Field(
        min_length=3, max_length=20,
        description="Phone number to call (digits, optional leading +, spaces/hyphens/parentheses allowed). "
        "Max 20 characters to match device-side validation.",
    )

    @field_validator("number")
    @classmethod
    def validate_phone_number(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Phone number cannot be empty or all whitespace")
        if not any(c.isdigit() for c in v):
            raise ValueError("Phone number must contain at least one digit")
        return v


class ReadCalendarInput(_MobileBaseInput):
    days_ahead: int = Field(default=7, ge=1, le=365, description="Days into the future to fetch events (1-365)")
    limit: int = Field(default=50, ge=1, le=200, description="Maximum events (1-200)")


class ReadNotificationsInput(_MobileBaseInput):
    limit: int = Field(default=20, ge=1, le=100, description="Maximum notifications (1-100)")
    package: Optional[str] = Field(default=None, description="Filter by app package name")


class ListInstalledAppsInput(_MobileBaseInput):
    filter: Literal["user", "system", "all"] = Field(
        default="user",
        description="App filter: 'user' (user-installed), 'system' (system apps), or 'all' (both)",
    )
    search: Optional[str] = Field(default=None, description="Search apps by name or package (case-insensitive substring)")
    limit: int = Field(default=50, ge=1, le=500, description="Maximum number of apps to return")


class ReadMediaInput(_MobileBaseInput):
    type: Literal["images", "videos"] = Field(
        default="images",
        description="Media type to query: 'images' or 'videos'",
    )
    limit: int = Field(default=20, ge=1, le=200, description="Maximum number of media items (1-200)")
    offset: int = Field(default=0, ge=0, description="Number of items to skip for pagination")


class GetLocationInput(_MobileBaseInput):
    high_accuracy: bool = Field(default=False, description="Use GPS for higher accuracy")


# ---------------------------------------------------------------------------
# Tool classes
# ---------------------------------------------------------------------------


class _MobileDataTool(_BaseDeviceQueryTool):
    """L1 mobile tool base — forwards user params to the device."""

    risk_level: str = "safe"
    timeout: int = 30


class ReadContactsTool(_MobileDataTool):
    name: str = "read_contacts"
    risk_level: str = "review"
    description: str = (
        "Read the phone contacts from the connected mobile device. "
        "Returns {contacts: [{name, phone, type}, ...], count}. "
        "Note: 'type' is a localized string from the device (e.g. 'Mobile'/'手机') — "
        "do not rely on exact string values for programmatic matching. "
        "Use when the user wants to look up someone's number or browse their contacts."
    )
    args_schema: type[BaseModel] = ReadContactsInput

    def run(self, *, user_id=None, current_space_id=None, **kwargs) -> Dict[str, Any]:
        return self._run_query(
            user_id=user_id, current_space_id=current_space_id,
            params=self._extract_device_params(kwargs),
            fallback_error="Failed to read contacts from device",
        )


class SearchContactsTool(_MobileDataTool):
    name: str = "search_contacts"
    risk_level: str = "review"
    description: str = (
        "Search the phone contacts by name on the connected mobile device. "
        "Use when the user asks to find a specific person's phone number."
    )
    args_schema: type[BaseModel] = SearchContactsInput

    def run(self, *, user_id=None, current_space_id=None, **kwargs) -> Dict[str, Any]:
        return self._run_query(
            user_id=user_id, current_space_id=current_space_id,
            params=self._extract_device_params(kwargs),
            fallback_error="Failed to search contacts on device",
        )


class ReadSmsTool(_MobileDataTool):
    name: str = "read_sms"
    risk_level: str = "review"
    description: str = (
        "Read recent SMS messages from the connected mobile device. "
        "Returns {messages: [{address, body, date, type}, ...], count, filter}. "
        "'date' is epoch milliseconds (13-digit integer). 'address' may be empty string if unavailable. "
        "Supports filtering by inbox/sent/all. "
        "Use when the user asks to check their text messages or look for a verification code."
    )
    args_schema: type[BaseModel] = ReadSmsInput

    def run(self, *, user_id=None, current_space_id=None, **kwargs) -> Dict[str, Any]:
        return self._run_query(
            user_id=user_id, current_space_id=current_space_id,
            params=self._extract_device_params(kwargs),
            fallback_error="Failed to read SMS from device",
        )


class SendSmsTool(_MobileDataTool):
    name: str = "send_sms"
    description: str = (
        "Send an SMS message from the connected mobile device. "
        "Use when the user explicitly asks to send a text message to someone."
    )
    risk_level: str = "strict"
    required_permission: str = "write"
    args_schema: type[BaseModel] = SendSmsInput

    def run(self, *, user_id=None, current_space_id=None, **kwargs) -> Dict[str, Any]:
        if user_id and not _check_sms_rate_limit(user_id):
            logger.warning(
                "sms_rate_limited | user=%s space=%s limit=%d/hour",
                user_id, current_space_id, _SMS_RATE_LIMIT_PER_HOUR,
            )
            return _device_tool_error(
                f"SMS rate limit exceeded — max {_SMS_RATE_LIMIT_PER_HOUR} messages per hour.",
                upstream_code="RATE_LIMITED",
            )
        return self._run_query(
            user_id=user_id, current_space_id=current_space_id,
            params=self._extract_device_params(kwargs),
            fallback_error="Failed to send SMS from device",
        )


class ReadCallLogTool(_MobileDataTool):
    name: str = "read_call_log"
    risk_level: str = "review"
    description: str = (
        "Read recent call history from the connected mobile device, "
        "including incoming, outgoing, and missed calls with timestamps and duration. "
        "Returns {calls: [{number, name, type, date, duration}, ...], count}. "
        "'date' is epoch milliseconds (13-digit integer). 'duration' is in seconds. "
        "'type' is one of: incoming, outgoing, missed, rejected, blocked. "
        "Use when the user asks about recent calls or who called them."
    )
    args_schema: type[BaseModel] = ReadCallLogInput

    def run(self, *, user_id=None, current_space_id=None, **kwargs) -> Dict[str, Any]:
        return self._run_query(
            user_id=user_id, current_space_id=current_space_id,
            params=self._extract_device_params(kwargs),
            fallback_error="Failed to read call log from device",
        )


class MakeCallTool(_MobileDataTool):
    name: str = "make_call"
    description: str = (
        "Initiate a phone call from the connected mobile device. "
        "Use only when the user explicitly asks to call someone."
    )
    risk_level: str = "strict"
    required_permission: str = "write"
    args_schema: type[BaseModel] = MakeCallInput

    def run(self, *, user_id=None, current_space_id=None, **kwargs) -> Dict[str, Any]:
        return self._run_query(
            user_id=user_id, current_space_id=current_space_id,
            params=self._extract_device_params(kwargs),
            fallback_error="Failed to initiate call from device",
        )


class ReadCalendarTool(_MobileDataTool):
    name: str = "read_calendar"
    risk_level: str = "review"
    description: str = (
        "Read upcoming calendar events from the connected mobile device. "
        "Returns {events: [{title, start, end, location, description, calendar_name}, ...], count}. "
        "Timestamps ('start', 'end') are epoch milliseconds UTC (13-digit integer). "
        "'days_ahead=1' fetches from today's midnight to tomorrow's midnight in the device's local timezone. "
        "Use when the user asks about their schedule, meetings, or appointments."
    )
    args_schema: type[BaseModel] = ReadCalendarInput

    def run(self, *, user_id=None, current_space_id=None, **kwargs) -> Dict[str, Any]:
        return self._run_query(
            user_id=user_id, current_space_id=current_space_id,
            params=self._extract_device_params(kwargs),
            fallback_error="Failed to read calendar from device",
        )


class ReadNotificationsTool(_MobileDataTool):
    name: str = "read_notifications"
    risk_level: str = "review"
    description: str = (
        "Read recent notifications from the connected mobile device. "
        "Can filter by app package name. "
        "Use when the user asks about recent alerts, messages, or app notifications."
    )
    args_schema: type[BaseModel] = ReadNotificationsInput

    def run(self, *, user_id=None, current_space_id=None, **kwargs) -> Dict[str, Any]:
        return self._run_query(
            user_id=user_id, current_space_id=current_space_id,
            params=self._extract_device_params(kwargs),
            fallback_error="Failed to read notifications from device",
        )


class ListInstalledAppsTool(_MobileDataTool):
    name: str = "list_installed_apps"
    risk_level: str = "review"
    timeout: int = 60
    description: str = (
        "List installed apps on the connected mobile device. "
        "Can filter to show user apps, system apps, or all. "
        "Use the 'search' parameter to find specific apps by name or package. "
        "Use when the user asks what apps are installed or when you need to "
        "discover available apps before opening one."
    )
    args_schema: type[BaseModel] = ListInstalledAppsInput

    def run(self, *, user_id=None, current_space_id=None, **kwargs) -> Dict[str, Any]:
        return self._run_query(
            user_id=user_id, current_space_id=current_space_id,
            params=self._extract_device_params(kwargs),
            fallback_error="Failed to list apps from device",
        )


class ReadMediaTool(_MobileDataTool):
    name: str = "read_media"
    risk_level: str = "review"
    description: str = (
        "Read media files (images or videos) from the connected mobile device. "
        "Returns a list of media items with file name, size, date, and content URI. "
        "Supports pagination via limit and offset. "
        "Use when the user asks to browse photos, find images, or list videos on the device."
    )
    args_schema: type[BaseModel] = ReadMediaInput

    def run(self, *, user_id=None, current_space_id=None, **kwargs) -> Dict[str, Any]:
        return self._run_query(
            user_id=user_id, current_space_id=current_space_id,
            params=self._extract_device_params(kwargs),
            fallback_error="Failed to read media from device",
        )


class GetLocationTool(_MobileDataTool):
    name: str = "get_location"
    risk_level: str = "review"
    description: str = (
        "Get the current geographic location of the connected mobile device. "
        "Returns latitude, longitude, and accuracy. "
        "Use when the user asks where their phone is or needs location info."
    )
    args_schema: type[BaseModel] = GetLocationInput

    def run(self, *, user_id=None, current_space_id=None, **kwargs) -> Dict[str, Any]:
        return self._run_query(
            user_id=user_id, current_space_id=current_space_id,
            params=self._extract_device_params(kwargs),
            fallback_error="Failed to get location from device",
        )


__all__ = [
    "ReadContactsTool",
    "SearchContactsTool",
    "ReadSmsTool",
    "SendSmsTool",
    "ReadCallLogTool",
    "MakeCallTool",
    "ReadCalendarTool",
    "ReadNotificationsTool",
    "ListInstalledAppsTool",
    "ReadMediaTool",
    "GetLocationTool",
]
