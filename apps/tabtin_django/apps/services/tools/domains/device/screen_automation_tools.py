"""
屏幕自动化工具 (L2)。

需要 Android 设备已启用 ADB 特权进程（开发者模式 + 无线调试配对）。
通过 DeviceRuntimeQueryService 向特权进程发送指令。
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

from apps.services.tools.domains.device.device_query_tools import (
    DeviceQueryInput,
    _BaseDeviceQueryTool,
    _device_tool_error,
)
from apps.services.tools.error_envelope import build_tool_error, tool_result_success

logger = logging.getLogger(__name__)


def _register_screenshot_file_usage(
    data: Dict[str, Any],
    *,
    user_id: Optional[str],
    space_id: Optional[str],
) -> None:
    """MAGENT-1: 为设备截图注册 FileUsage，关联到 Agent space。"""
    file_id = data.get("file_id", "")
    if not file_id:
        return
    try:
        from apps.services.oss.models import FileRecord, FileUsage
        record = FileRecord.objects.filter(id=file_id, status='completed').first()
        if not record:
            return
        FileUsage.add_usage(
            file_record=record,
            user_id=str(user_id) if user_id else '',
            module='orchestration',
            context_type='screenshot',
            context_id=str(space_id) if space_id else '',
        )
        logger.info("Multiagent 截图 FileUsage 已注册: file_id=%s, space=%s", file_id, space_id)
    except Exception as e:
        logger.error("Multiagent 截图 FileUsage 注册失败: file_id=%s, error=%s", file_id, e, exc_info=True)


# ---------------------------------------------------------------------------
# Input schemas
# ---------------------------------------------------------------------------


class ScreenCaptureInput(DeviceQueryInput):
    pass


class ScreenSnapshotInput(DeviceQueryInput):
    max_depth: int = Field(default=10, ge=1, le=50, description="Maximum UI tree depth to traverse")
    mode: str = Field(
        default="concise",
        pattern=r"^(raw|indexed|concise)$",
        description=(
            "UI tree output mode: 'concise' (default, only interactive/content elements with indices), "
            "'indexed' (all on-screen elements with indices), 'raw' (XML). "
            "Use 'indexed' or 'concise' to get element indices for screen_tap_element / screen_type_in_element."
        ),
    )


class ScreenUiTreeInput(DeviceQueryInput):
    max_depth: int = Field(default=10, ge=1, le=50, description="Maximum tree depth to traverse")
    mode: str = Field(
        default="raw",
        pattern=r"^(raw|indexed|concise)$",
        description=(
            "Output mode: 'raw' (XML), 'indexed' (parsed element list with indices), "
            "'concise' (only interactive/content elements with >=30% visible area). "
            "Use 'indexed' or 'concise' to get element indices for screen_tap_element / screen_type_in_element."
        ),
    )


class ScreenTapInput(DeviceQueryInput):
    x: int = Field(ge=0, le=10000, description="X coordinate to tap (pixels, or 0-1000 if normalized=true)")
    y: int = Field(ge=0, le=10000, description="Y coordinate to tap (pixels, or 0-1000 if normalized=true)")
    normalized: bool = Field(default=False, description="If true, x/y are normalized 0-1000 values mapped to screen dimensions")
    stealth: bool = Field(default=False, description="If true, add micro-jitter for anti-automation detection")


class ScreenTapAreaInput(DeviceQueryInput):
    x1: int = Field(ge=0, le=10000, description="Left edge of the target area (pixels)")
    y1: int = Field(ge=0, le=10000, description="Top edge of the target area (pixels)")
    x2: int = Field(ge=0, le=10000, description="Right edge of the target area (pixels)")
    y2: int = Field(ge=0, le=10000, description="Bottom edge of the target area (pixels)")
    stealth: bool = Field(default=False, description="If true, randomize tap within area safe zone for anti-automation detection")


class ScreenSwipeInput(DeviceQueryInput):
    start_x: int = Field(ge=0, le=10000, description="Start X coordinate (pixels, or 0-1000 if normalized=true)")
    start_y: int = Field(ge=0, le=10000, description="Start Y coordinate (pixels, or 0-1000 if normalized=true)")
    end_x: int = Field(ge=0, le=10000, description="End X coordinate (pixels, or 0-1000 if normalized=true)")
    end_y: int = Field(ge=0, le=10000, description="End Y coordinate (pixels, or 0-1000 if normalized=true)")
    duration_ms: int = Field(default=300, ge=1, le=30000, description="Swipe duration in ms (1-30000)")
    normalized: bool = Field(default=False, description="If true, coordinates are normalized 0-1000 values mapped to screen dimensions")
    stealth: bool = Field(default=False, description="If true, use Bezier curve path with Perlin noise for anti-automation detection")


class ScreenLongPressInput(DeviceQueryInput):
    x: int = Field(ge=0, le=10000, description="X coordinate (pixels, or 0-1000 if normalized=true)")
    y: int = Field(ge=0, le=10000, description="Y coordinate (pixels, or 0-1000 if normalized=true)")
    duration_ms: int = Field(default=1000, ge=100, le=30000, description="Press duration in ms (100-30000)")
    normalized: bool = Field(default=False, description="If true, x/y are normalized 0-1000 values mapped to screen dimensions")
    stealth: bool = Field(default=False, description="If true, add micro-jitter for anti-automation detection")


class ScreenTypeTextInput(DeviceQueryInput):
    text: str = Field(min_length=1, max_length=10000, description="Text to type on the device")
    stealth: bool = Field(default=False, description="If true, type word-by-word with random delays for anti-automation detection")

    @field_validator("text")
    @classmethod
    def validate_text_safe(cls, v: str) -> str:
        if "\x00" in v:
            raise ValueError("Text must not contain null characters (\\x00).")
        return v


class ScreenKeyEventInput(DeviceQueryInput):
    key_code: int = Field(ge=0, le=999, description="Android KeyEvent code (e.g. 4=Back, 3=Home)")


class ScreenWaitForIdleInput(DeviceQueryInput):
    timeout_ms: int = Field(default=5000, ge=500, le=60000, description="Maximum wait time in ms")
    include_text: bool = Field(
        default=False,
        description="If true, include text content in structural hash comparison. "
        "Use when waiting for text content to stabilize (e.g. page loading). "
        "Default false ignores volatile text like timestamps.",
    )
    stable_count: int = Field(
        default=3, ge=1, le=10,
        description="Number of consecutive stable UI tree snapshots required to consider idle. "
        "Higher values are more reliable but take longer. Default 3.",
    )


_UNSAFE_SETTING_VALUE_CHARS = frozenset(";|&`\\\n\r\t\x00")
_UNSAFE_APP_NAME_CHARS = frozenset("/\\;|&$`<>{}()\x00\n\r\t")


class ScreenOpenAppInput(DeviceQueryInput):
    app_name: str = Field(
        min_length=1, max_length=100,
        description="App name or keyword to search and open, e.g. '微信', 'WeChat', 'Chrome', 'Settings'",
    )

    @field_validator("app_name")
    @classmethod
    def validate_app_name(cls, v: str) -> str:
        for ch in v:
            if ch in _UNSAFE_APP_NAME_CHARS:
                raise ValueError(
                    f"App name contains forbidden character {ch!r}. "
                    f"Shell metacharacters and control characters are not allowed."
                )
        return v


class ScreenLaunchAppInput(DeviceQueryInput):
    package_name: str = Field(
        min_length=3, max_length=200,
        pattern=r"^[a-zA-Z][a-zA-Z0-9_.]+$",
        description="Package name of the app to launch",
    )


class ScreenForceStopAppInput(DeviceQueryInput):
    package_name: Optional[str] = Field(
        default=None,
        min_length=3, max_length=200,
        pattern=r"^[a-zA-Z][a-zA-Z0-9_.]+$",
        description="Package name of the app to force-stop. Required if app_name is not provided.",
    )
    app_name: Optional[str] = Field(
        default=None,
        min_length=1, max_length=100,
        description="Display name of the app to force-stop (e.g. '微信', 'Chrome'). "
                    "Will be resolved to a package name on-device. "
                    "If both app_name and package_name are provided, package_name takes priority.",
    )

    @model_validator(mode="after")
    def check_at_least_one(self) -> "ScreenForceStopAppInput":
        if not self.package_name and not self.app_name:
            raise ValueError("Either 'package_name' or 'app_name' must be provided")
        return self


import re as _re

# P1-SEC-4: 白名单模式 — key 只允许字母、数字、下划线、点号
_SETTING_KEY_PATTERN = _re.compile(r"^[a-zA-Z][a-zA-Z0-9_.]{0,253}[a-zA-Z0-9_]$")
# 明确拒绝的 shell / 注入字符
_SETTING_KEY_BLOCKED_CHARS = frozenset(";|&$`\"'\\<>(){}[]!\n\r\t")


class SetSystemSettingInput(DeviceQueryInput):
    namespace: str = Field(description="Setting namespace: system / secure / global", pattern=r"^(system|secure|global)$")
    key: str = Field(description="Setting key name (letters, digits, underscores, dots only)", min_length=1, max_length=255)
    value: str = Field(description="Setting value", max_length=256)

    @field_validator("value")
    @classmethod
    def validate_value_safe(cls, v: str) -> str:
        for ch in v:
            if ch in _UNSAFE_SETTING_VALUE_CHARS:
                raise ValueError(
                    f"Setting value contains forbidden shell control character {ch!r}."
                )
        return v

    @field_validator("key")
    @classmethod
    def validate_key_format(cls, v: str) -> str:
        if any(ch in _SETTING_KEY_BLOCKED_CHARS for ch in v):
            raise ValueError(
                f"Setting key contains forbidden characters. "
                f"Only letters, digits, underscores, and dots are allowed."
            )
        if not _SETTING_KEY_PATTERN.match(v):
            raise ValueError(
                f"Setting key '{v}' does not match the required format: "
                f"must start with a letter, contain only [a-zA-Z0-9_.], "
                f"and end with a letter, digit, or underscore."
            )
        return v


class SetStealthModeInput(DeviceQueryInput):
    enabled: bool = Field(description="Enable or disable stealth mode. When enabled, all screen interactions use human-like randomization (tap jitter, Bezier swipes, per-character typing delays) to avoid anti-automation detection.")


class GetSystemSettingInput(DeviceQueryInput):
    namespace: str = Field(description="Setting namespace: system / secure / global", pattern=r"^(system|secure|global)$")
    key: str = Field(description="Setting key name (letters, digits, underscores, dots only)", min_length=1, max_length=255)

    @field_validator("key")
    @classmethod
    def validate_key_format(cls, v: str) -> str:
        if any(ch in _SETTING_KEY_BLOCKED_CHARS for ch in v):
            raise ValueError(
                f"Setting key contains forbidden characters. "
                f"Only letters, digits, underscores, and dots are allowed."
            )
        if not _SETTING_KEY_PATTERN.match(v):
            raise ValueError(
                f"Setting key '{v}' does not match the required format: "
                f"must start with a letter, contain only [a-zA-Z0-9_.], "
                f"and end with a letter, digit, or underscore."
            )
        return v


class ScreenLongPressElementInput(DeviceQueryInput):
    index: int = Field(ge=1, le=10000, description="1-based element index from screen_ui_tree (indexed/concise mode)")
    duration_ms: int = Field(default=1000, ge=100, le=30000, description="Press duration in ms (100-30000)")
    stealth: bool = Field(default=False, description="If true, randomize press point within element safe zone")


class ScreenFindElementInput(DeviceQueryInput):
    text: Optional[str] = Field(
        default=None, min_length=1, max_length=500,
        description="Text to search for in element text, content description, or resource ID. "
        "Supports newline normalization (\\n treated as space). "
        "Optional if class_name or trait filters are used.",
    )
    partial: bool = Field(
        default=True,
        description="If true (default), match substring; if false, require exact match. "
        "Ignored when regex=true (regex always uses partial/containsMatch semantics).",
    )
    regex: bool = Field(
        default=False,
        description="If true, treat 'text' as a regex pattern (case-insensitive). "
        "Note: 'partial' is ignored when regex=true — regex always matches as containsMatch. "
        "Nested quantifiers like (a+)+ are rejected to prevent catastrophic backtracking. "
        "Useful for matching patterns like 'Price.*' or 'Button \\d+'.",
    )
    class_name: Optional[str] = Field(
        default=None, min_length=1, max_length=200,
        description="Filter by element class name (case-insensitive substring match). "
        "E.g. 'EditText', 'Button', 'ImageView', 'RecyclerView'.",
    )
    clickable: Optional[bool] = Field(default=None, description="Filter by clickable trait (true=only clickable, false=only non-clickable)")
    scrollable: Optional[bool] = Field(default=None, description="Filter by scrollable trait")
    editable: Optional[bool] = Field(default=None, description="Filter by editable trait (text input fields)")
    enabled: Optional[bool] = Field(default=None, description="Filter by enabled state (false=find disabled elements)")
    checked: Optional[bool] = Field(default=None, description="Filter by checked state (for checkboxes/switches)")
    selected: Optional[bool] = Field(default=None, description="Filter by selected state")
    focused: Optional[bool] = Field(default=None, description="Filter by focused state")
    anchor_index: int | None = Field(
        default=None, ge=1, le=10000,
        description="Optional: 1-based element index to use as spatial anchor. Requires 'direction'.",
    )
    direction: str | None = Field(
        default=None,
        pattern=r"^(below|above|left_of|right_of|near)$",
        description="Spatial filter direction relative to anchor: below / above / left_of / right_of / near",
    )
    sort_by: Optional[str] = Field(
        default=None,
        pattern=r"^(position|distance)$",
        description="Sort results: 'position' (top-to-bottom, left-to-right) or 'distance' (from anchor). "
        "Default: distance-sorted when anchor is used, unsorted otherwise.",
    )
    max_results: int = Field(
        default=20, ge=1, le=50,
        description="Maximum number of results to return (default 20, max 50).",
    )

    @model_validator(mode="after")
    def validate_search_params(self):
        if (self.anchor_index is None) != (self.direction is None):
            raise ValueError("anchor_index and direction must be provided together")
        if self.sort_by == "distance" and self.anchor_index is None:
            raise ValueError("sort_by='distance' requires anchor_index")
        has_text = self.text is not None
        has_class = self.class_name is not None
        has_trait = any(v is not None for v in [
            self.clickable, self.scrollable, self.editable,
            self.enabled, self.checked, self.selected, self.focused,
        ])
        if not has_text and not has_class and not has_trait:
            raise ValueError("At least one of 'text', 'class_name', or a trait filter is required")
        if self.regex and not has_text:
            raise ValueError("'regex' requires 'text' to be provided")
        if self.regex and has_text:
            self._validate_regex_safety(self.text)
        return self

    @staticmethod
    def _validate_regex_safety(pattern: str) -> None:
        """Compile-check and reject patterns prone to catastrophic backtracking."""
        import re as _re_local
        try:
            _re_local.compile(pattern)
        except _re_local.error as exc:
            raise ValueError(f"Invalid regex pattern: {exc}")
        if _re_local.search(r'[+*?}]\)[+*{]', pattern):
            raise ValueError(
                "Regex rejected: nested quantifiers (e.g. (a+)+, (a*)*) "
                "may cause catastrophic backtracking. Simplify the pattern."
            )


class ScreenGetContextInput(DeviceQueryInput):
    pass


class ScreenWaitForElementInput(DeviceQueryInput):
    text: str = Field(min_length=1, max_length=500, description="Text to search for (in element text, content description, or resource ID)")
    timeout_ms: int = Field(default=10000, ge=1000, le=60000, description="Maximum wait time in ms")
    partial: bool = Field(default=True, description="If true (default), match substring; if false, require exact match")


class ScreenTapElementInput(DeviceQueryInput):
    index: int = Field(ge=1, le=10000, description="1-based element index from screen_ui_tree (indexed/concise mode)")
    stealth: bool = Field(default=False, description="If true, randomize tap within element safe zone for anti-automation detection")


class ScreenTypeInElementInput(DeviceQueryInput):
    index: int = Field(ge=1, le=10000, description="1-based element index from screen_ui_tree (indexed/concise mode)")
    text: str = Field(min_length=1, max_length=10000, description="Text to type into the element")
    clear: bool = Field(default=False, description="If true, clear existing text before typing (may not work on all devices)")
    stealth: bool = Field(default=False, description="If true, use stealth mode: randomize tap, word-by-word typing with delays")


class ScreenTypeSecretInput(DeviceQueryInput):
    credential_id: str = Field(
        min_length=1,
        max_length=100,
        description="Credential ID from credential_lookup. The actual secret value is resolved server-side and never exposed to the AI.",
    )
    index: int = Field(ge=1, le=10000, description="1-based element index from screen_ui_tree (indexed/concise mode)")
    clear: bool = Field(default=True, description="If true (default), clear existing text before typing")
    field_name: str = Field(
        default="password",
        description="Which field to type from the credential: 'password' or 'username'",
        pattern=r"^(password|username)$",
    )


# ---------------------------------------------------------------------------
# Tool classes
# ---------------------------------------------------------------------------


class _ScreenTool(_BaseDeviceQueryTool):
    """L2 screen automation tool base."""

    category: str = "device"
    risk_level: str = "review"
    required_permission: str = "write"
    timeout: int = 120
    fallback_error: str = "Device operation failed"
    _registers_screenshot_usage: bool = False

    def run(self, *, user_id=None, current_space_id=None, **kwargs) -> Dict[str, Any]:
        result = self._run_query(
            user_id=user_id, current_space_id=current_space_id,
            params=self._extract_device_params(kwargs),
            fallback_error=self.fallback_error,
        )

        # MAGENT-1: 截图上传后注册 FileUsage，防止孤儿 OSS 文件
        if self._registers_screenshot_usage and result.get("success"):
            _register_screenshot_file_usage(
                result.get("data", {}),
                user_id=user_id,
                space_id=current_space_id,
            )

        return result


class ScreenCaptureTool(_ScreenTool):
    name: str = "screen_capture"
    description: str = (
        "Take a screenshot of the connected mobile device's current screen. "
        "Returns {image_url, file_id, size} — the image is uploaded to cloud storage. "
        "When available, the screenshot image will be displayed alongside the result. "
        "Prefer screen_snapshot (which includes UI tree) for understanding screen content."
    )
    required_permission: str = "read"
    args_schema: type[BaseModel] = ScreenCaptureInput
    fallback_error: str = "Failed to capture screen from device"
    _registers_screenshot_usage: bool = True


class ScreenSnapshotTool(_ScreenTool):
    name: str = "screen_snapshot"
    required_permission: str = "read"
    _registers_screenshot_usage: bool = True
    description: str = (
        "Take a combined screenshot + UI tree from the connected mobile device in one atomic call. "
        "Returns {image_url, has_screenshot, ui_tree, screen_width, screen_height, element_count, mode}. "
        "IMPORTANT: 'has_screenshot' may be false even when the call succeeds (e.g. OSS upload failure) — "
        "always check 'has_screenshot' rather than assuming 'success' means screenshot is available. "
        "In indexed/concise mode, element_count may be truncated at 300 without explicit indication. "
        "In raw mode, element_count is not present. "
        "Default mode='concise' returns only interactive/content elements with 1-based indices — "
        "ready for screen_tap_element / screen_type_in_element. "
        "Use this as your primary tool for understanding screen state. "
        "When available, the screenshot image will be displayed alongside the text data; "
        "always use the UI tree indices for precise element targeting."
    )
    args_schema: type[BaseModel] = ScreenSnapshotInput
    fallback_error: str = "Failed to take screen snapshot from device"


class ScreenUiTreeTool(_ScreenTool):
    name: str = "screen_ui_tree"
    required_permission: str = "read"
    description: str = (
        "Get the current UI accessibility tree from the connected mobile device. "
        "Supports 3 modes: 'raw' returns XML, 'indexed' returns a parsed element list "
        "with 1-based indices and bounds, 'concise' returns only interactive/content elements. "
        "Use 'indexed' or 'concise' mode to get element indices for screen_tap_element / screen_type_in_element."
    )
    args_schema: type[BaseModel] = ScreenUiTreeInput
    fallback_error: str = "Failed to get UI tree from device"


class ScreenTapTool(_ScreenTool):
    name: str = "screen_tap"
    description: str = (
        "Tap at a specific position on the mobile device screen. "
        "Supports both pixel coordinates and normalized coordinates (0-1000). "
        "Prefer screen_tap_element for indexed elements."
    )
    args_schema: type[BaseModel] = ScreenTapInput
    fallback_error: str = "Failed to tap on device screen"


class ScreenTapAreaTool(_ScreenTool):
    name: str = "screen_tap_area"
    description: str = (
        "Tap at the center of a rectangular area on the mobile device screen. "
        "Takes bounding box coordinates (x1, y1, x2, y2) in pixels and calculates "
        "an optimal tap point, with automatic obstruction detection when UI elements are cached. "
        "Use when you have element bounds from screen_find_element or screen_ui_tree but not an element index. "
        "Prefer screen_tap_element when element indices are available."
    )
    args_schema: type[BaseModel] = ScreenTapAreaInput
    fallback_error: str = "Failed to tap area on device screen"


class ScreenSwipeTool(_ScreenTool):
    name: str = "screen_swipe"
    description: str = (
        "Perform a swipe gesture on the mobile device screen. "
        "Supports both pixel coordinates and normalized coordinates (0-1000). "
        "Use for scrolling, swiping between pages, or pulling down notifications."
    )
    args_schema: type[BaseModel] = ScreenSwipeInput
    fallback_error: str = "Failed to swipe on device screen"


class ScreenLongPressTool(_ScreenTool):
    name: str = "screen_long_press"
    description: str = (
        "Perform a long press at a specific position on the mobile device screen. "
        "Supports both pixel coordinates and normalized coordinates (0-1000). "
        "Use for triggering context menus or drag operations."
    )
    args_schema: type[BaseModel] = ScreenLongPressInput
    fallback_error: str = "Failed to long press on device screen"


class ScreenLongPressElementTool(_ScreenTool):
    name: str = "screen_long_press_element"
    description: str = (
        "Long press a UI element by its 1-based index from screen_ui_tree (indexed/concise mode). "
        "Automatically calculates the element's center point. "
        "You must call screen_ui_tree or screen_snapshot with mode='indexed' or 'concise' first. "
        "Use for triggering context menus, drag operations, or element selection."
    )
    args_schema: type[BaseModel] = ScreenLongPressElementInput
    fallback_error: str = "Failed to long press element on device screen"


class ScreenFindElementTool(_ScreenTool):
    name: str = "screen_find_element"
    required_permission: str = "read"
    description: str = (
        "Search for UI elements with composable filters. Searches the cached element list "
        "from the last screen_ui_tree / screen_snapshot call. "
        "Filter by: text (substring/exact/regex), class_name (e.g. 'EditText', 'Button' — use short class name only, "
        "not full qualified name like 'android.widget.EditText'), "
        "and traits (clickable, scrollable, editable, enabled, checked, selected, focused). "
        "At least one filter is required; multiple filters are combined with AND logic. "
        "Text search matches element text, content description, and resource ID (including short form). "
        "Supports spatial filtering: anchor_index + direction to narrow results relative to a reference element. "
        "Results are sorted by distance from anchor when spatial filtering is used. "
        "Use sort_by='position' for top-to-bottom left-to-right ordering. "
        "IMPORTANT: the returned 'count' is the total matches (before max_results truncation), "
        "while 'elements' array contains at most max_results items. If count > len(elements), results were truncated. "
        "Examples: find all EditText fields (class_name='EditText'), "
        "find clickable buttons containing 'Submit' (text='Submit', clickable=true), "
        "find elements below a label (anchor_index=5, direction='below')."
    )
    risk_level: str = "safe"
    args_schema: type[BaseModel] = ScreenFindElementInput
    fallback_error: str = "Failed to search elements on device"


class ScreenGetContextTool(_ScreenTool):
    name: str = "screen_get_context"
    required_permission: str = "read"
    description: str = (
        "Get the current screen context: foreground app (package + activity), "
        "keyboard visibility, focused element, screen dimensions, "
        "and dialog detection (has_dialog, dialog_type: permission/bottom_sheet/alert/snackbar/dialog). "
        "Use before interacting with the device to understand the current state, "
        "or after an action to verify the expected app/screen is shown. "
        "May trigger a fresh UI tree dump if no cached data is available (adds ~1s latency)."
    )
    risk_level: str = "safe"
    args_schema: type[BaseModel] = ScreenGetContextInput
    fallback_error: str = "Failed to get screen context from device"


class ScreenTapElementTool(_ScreenTool):
    name: str = "screen_tap_element"
    description: str = (
        "Tap a UI element by its 1-based index from screen_ui_tree (indexed/concise mode). "
        "Automatically calculates the element's center point. "
        "You must call screen_ui_tree(mode='indexed' or 'concise') first to get element indices. "
        "If the UI has changed since the last screen_ui_tree call, call it again to refresh. "
        "Preferred over screen_tap when element indices are available."
    )
    args_schema: type[BaseModel] = ScreenTapElementInput
    fallback_error: str = "Failed to tap element on device screen"


class ScreenTypeInElementTool(_ScreenTool):
    name: str = "screen_type_in_element"
    description: str = (
        "Type text into a UI element by its 1-based index. Taps the element to focus, "
        "optionally clears existing text (clear=true uses Ctrl+A which requires Android 11+; "
        "on older devices clear may silently fail — verify with a follow-up snapshot). "
        "Check the response for 'warning' field — if present, focus may not have been confirmed "
        "and text could have been typed into the wrong element. "
        "Supports ASCII and CJK characters. "
        "You must call screen_ui_tree(mode='indexed' or 'concise') first to get element indices. "
        "Preferred over screen_tap + screen_type_text combo."
    )
    args_schema: type[BaseModel] = ScreenTypeInElementInput
    fallback_error: str = "Failed to type in element on device"


class ScreenTypeTextTool(_ScreenTool):
    name: str = "screen_type_text"
    description: str = (
        "Type text on the mobile device. Works with any focused text field. "
        "Supports both ASCII and CJK characters (via clipboard for non-ASCII). "
        "Use after tapping on a text field to enter text. "
        "Prefer screen_type_in_element when element indices are available."
    )
    args_schema: type[BaseModel] = ScreenTypeTextInput
    fallback_error: str = "Failed to type text on device"


class ScreenTypeSecretTool(_ScreenTool):
    """Securely type a credential into a UI element without exposing the value to the LLM.

    The credential is resolved server-side from the encrypted vault and sent
    directly to the device.  The LLM only sees the credential_id, never the
    actual password / username value.
    """

    name: str = "screen_type_secret"
    description: str = (
        "Securely type a stored credential (password/username) into a UI element "
        "without exposing the value to the AI. "
        "Call credential_lookup first to get the credential_id, then use this tool "
        "to type the credential into the target element. "
        "The actual credential value is resolved server-side and sent directly to the device. "
        "You must call screen_ui_tree(mode='indexed' or 'concise') first to get element indices."
    )
    args_schema: type[BaseModel] = ScreenTypeSecretInput
    risk_level: str = "review"
    fallback_error: str = "Failed to type secret into device element"

    def run(self, *, user_id=None, current_space_id=None, **kwargs) -> Dict[str, Any]:
        credential_id = kwargs.get("credential_id")
        index = kwargs.get("index")
        clear = kwargs.get("clear", True)
        field_name = kwargs.get("field_name", "password")

        if not credential_id:
            return _device_tool_error(
                "credential_id is required",
                error_kind="missing_required_param",
                hint="Call credential_lookup first, then pass credential_id to screen_type_secret.",
                retryable=False,
            )
        if index is None:
            return _device_tool_error(
                "index is required",
                error_kind="missing_required_param",
                hint="Call screen_ui_tree first to get an element index, then retry screen_type_secret.",
                retryable=False,
            )
        if not user_id:
            return _device_tool_error(
                "user_id is required",
                error_kind="runtime_misconfig",
                hint="Ensure the Agent session injects user_id before calling screen_type_secret.",
                retryable=False,
            )
        if not current_space_id:
            return _device_tool_error(
                "current_space_id is required",
                error_kind="runtime_misconfig",
                hint="Start the Agent inside a Space so current_space_id is injected.",
                retryable=False,
            )

        secret_value, resolve_error = self._resolve_credential(user_id, credential_id, field_name)
        if secret_value is None:
            kind = "resource_not_found"
            hint = "Use credential_lookup to find a valid credential_id, then retry."
            lower = (resolve_error or "").lower()
            if "expired" in lower:
                kind = "auth_failed"
                hint = "Ask the user to update the expired credential, then retry."
            elif "invalid credential_id format" in lower:
                kind = "invalid_param_format"
                hint = "Pass a UUID credential_id from credential_lookup."
            elif "empty" in lower or "field" in lower:
                kind = "invalid_param_format"
                hint = "Choose a non-empty field_name (username/password) for this credential."
            elif "decryption" in lower or "internal error" in lower:
                kind = "internal_error"
                hint = "Ask the user to re-save the credential, then retry once."
            return _device_tool_error(
                "Credential could not be used for secure typing.",
                error_kind=kind,
                hint=hint,
                retryable=kind == "internal_error",
            )

        result = self._run_query(
            user_id=user_id,
            current_space_id=current_space_id,
            params={"index": index, "text": secret_value, "clear": clear},
            fallback_error=self.fallback_error,
            action_override="screen_type_in_element",
        )

        return self._sanitize_response(result)

    @staticmethod
    def _sanitize_response(result: Dict[str, Any]) -> Dict[str, Any]:
        """Rebuild secret-action responses from a strict safe-field allowlist."""
        if result.get("success") is False:
            context = {
                "secret_typed": False,
                **{
                    key: result[key]
                    for key in ("device_type", "dispatch_reason", "degraded")
                    if key in result and result[key] is not None
                },
            }
            return build_tool_error(
                "Secure credential typing failed.",
                error_kind=str(result.get("error_kind") or "upstream_error"),
                hint=(
                    "Check the credential is current and the device is online, "
                    "then retry screen_type_secret once."
                ),
                retryable=bool(result.get("retryable", True)),
                upstream_code=(
                    str(result["upstream_code"])
                    if result.get("upstream_code")
                    else None
                ),
                context=context,
            )

        _safe = {"typed_in_index", "element_class", "method", "warning", "secret_typed"}
        data = result.get("data")
        if isinstance(data, dict):
            sanitized = {k: v for k, v in data.items() if k in _safe}
            sanitized["secret_typed"] = True
            result["data"] = sanitized
        return tool_result_success(result)

    @staticmethod
    def _resolve_credential(
        user_id: str, credential_id: str, field_name: str,
    ) -> tuple[Optional[str], str]:
        """Resolve a credential value from the encrypted vault.

        Returns (value, "") on success or (None, error_message) on failure.
        """
        import uuid as _uuid

        try:
            _uuid.UUID(credential_id)
        except (ValueError, AttributeError):
            return None, f"Invalid credential_id format: '{credential_id}'. Expected a UUID from credential_lookup."

        try:
            from apps.credential_vault.models import UserCredential
            from django.utils import timezone

            cred = UserCredential.objects.get(
                id=credential_id,
                user_id=user_id,
                is_active=True,
            )
            if cred.expires_at and cred.expires_at < timezone.now():
                return None, f"Credential '{credential_id}' has expired. Please update it."

            data = cred.encrypted_data or {}
            value = data.get(field_name, "")
            if not value:
                available = [k for k in ("username", "password") if data.get(k)]
                return None, (
                    f"Field '{field_name}' is empty for credential '{credential_id}'. "
                    f"Available fields: {available}"
                )
            return value, ""
        except UserCredential.DoesNotExist:
            logger.warning("Credential %s not found for user %s", credential_id, user_id)
            return None, (
                f"Credential '{credential_id}' not found or not accessible. "
                f"Use credential_lookup to find valid credentials."
            )
        except Exception as exc:
            exc_type = type(exc).__name__
            logger.exception("Failed to resolve credential %s [%s]", credential_id, exc_type)
            if "InvalidToken" in exc_type or "Fernet" in exc_type:
                return None, "Credential decryption failed — the encryption key may have changed. Please re-save the credential."
            return None, "Internal error resolving credential. Please try again."


class ScreenKeyEventTool(_ScreenTool):
    name: str = "screen_key_event"
    description: str = (
        "Send a key event to the mobile device. Common codes: "
        "3=Home, 4=Back, 24/25=Volume Up/Down, 26=Power, 66=Enter, 82=Menu, 187=Recents."
    )
    args_schema: type[BaseModel] = ScreenKeyEventInput
    fallback_error: str = "Failed to send key event to device"


class ScreenWaitForIdleTool(_ScreenTool):
    name: str = "screen_wait_for_idle"
    required_permission: str = "read"
    description: str = (
        "Wait for the mobile device screen to become idle (animations finished). "
        "Use between actions to ensure UI has settled before the next interaction. "
        "Set include_text=true to also wait for text content to stabilize "
        "(e.g. web page loading). Keep false (default) for layout-only idle detection, "
        "as dynamic text (clocks, counters) may prevent idle detection."
    )
    risk_level: str = "safe"
    args_schema: type[BaseModel] = ScreenWaitForIdleInput
    fallback_error: str = "Wait for idle timed out"


class ScreenWaitForElementTool(_ScreenTool):
    name: str = "screen_wait_for_element"
    required_permission: str = "read"
    description: str = (
        "Wait for a UI element matching the given text to appear on screen. "
        "Polls the UI tree at 1-second intervals until the element is found or timeout. "
        "Returns the matched element's index and properties when found. "
        "Use after navigation or app launch to wait for a specific screen/view to load. "
        "Supports partial match (default) or exact match."
    )
    risk_level: str = "safe"
    args_schema: type[BaseModel] = ScreenWaitForElementInput
    timeout: int = 180
    fallback_error: str = "Wait for element timed out"


class ScreenOpenAppTool(_ScreenTool):
    name: str = "screen_open_app"
    description: str = (
        "Open an app on the mobile device by its display name. "
        "Searches installed apps locally and launches the best match. "
        "Preferred over screen_launch_app when the package name is unknown. "
        "The app_name must be the app's display name (e.g. '微信', 'Chrome', '相机'), "
        "not a description of its function. "
        "If the match is ambiguous (AMBIGUOUS_MATCH), the response contains a 'candidates' list "
        "where each candidate has a 'package' field (not 'package_name') — use that value "
        "with screen_launch_app's 'package_name' parameter to launch the intended app. "
        "For vague requests, use list_installed_apps first to discover available apps."
    )
    args_schema: type[BaseModel] = ScreenOpenAppInput
    fallback_error: str = "Failed to open app on device"


class ScreenLaunchAppTool(_ScreenTool):
    name: str = "screen_launch_app"
    description: str = (
        "Launch an app on the mobile device by its exact package name. "
        "Use screen_open_app instead when you only know the app name. "
        "Use list_installed_apps to discover available packages."
    )
    args_schema: type[BaseModel] = ScreenLaunchAppInput
    fallback_error: str = "Failed to launch app on device"


class ScreenForceStopAppTool(_ScreenTool):
    name: str = "screen_force_stop_app"
    description: str = (
        "Force stop an app on the mobile device. "
        "Provide the package_name for reliable operation. "
        "app_name (display name) is also accepted and resolved on-device via AppNameResolver "
        "(works on Android 11+ where the privileged process is available). "
        "Returns whether the app was actually running before being stopped. "
        "Use when an app is unresponsive or needs to be restarted."
    )
    risk_level: str = "strict"
    required_permission: str = "admin"
    args_schema: type[BaseModel] = ScreenForceStopAppInput
    fallback_error: str = "Failed to force stop app on device"


class SetSystemSettingTool(_ScreenTool):
    name: str = "set_system_setting"
    description: str = (
        "Modify an Android system setting on the connected mobile device. "
        "Requires specifying the namespace (system/secure/global), key, and value."
    )
    risk_level: str = "strict"
    required_permission: str = "admin"
    args_schema: type[BaseModel] = SetSystemSettingInput
    fallback_error: str = "Failed to set system setting on device"


class GetSystemSettingTool(_ScreenTool):
    name: str = "get_system_setting"
    description: str = (
        "Read an Android system setting from the connected mobile device. "
        "Specify the namespace (system/secure/global) and key."
    )
    risk_level: str = "safe"
    required_permission: str = "read"
    args_schema: type[BaseModel] = GetSystemSettingInput
    fallback_error: str = "Failed to read system setting from device"


class SetStealthModeTool(_ScreenTool):
    name: str = "set_stealth_mode"
    description: str = (
        "Enable or disable stealth mode on the connected mobile device. "
        "When enabled, all screen interactions become human-like to avoid anti-automation detection: "
        "tap coordinates are randomized within a safe zone of each element, "
        "swipe gestures follow Bezier curves with Perlin noise jitter instead of straight lines, "
        "and text typing uses per-character delays mimicking human typing speed. "
        "Enable before interacting with apps that detect automated behavior (e.g. banking, social media). "
        "Disable when speed is more important than stealth (e.g. utility tasks). "
        "Stealth mode adds latency: ~50ms per tap, ~2x swipe duration, ~100-300ms per word typed."
    )
    risk_level: str = "safe"
    args_schema: type[BaseModel] = SetStealthModeInput
    fallback_error: str = "Failed to set stealth mode on device"


__all__ = [
    "ScreenCaptureTool",
    "ScreenSnapshotTool",
    "ScreenUiTreeTool",
    "ScreenTapTool",
    "ScreenTapAreaTool",
    "ScreenTapElementTool",
    "ScreenSwipeTool",
    "ScreenLongPressTool",
    "ScreenLongPressElementTool",
    "ScreenFindElementTool",
    "ScreenGetContextTool",
    "ScreenTypeTextTool",
    "ScreenTypeInElementTool",
    "ScreenTypeSecretTool",
    "ScreenKeyEventTool",
    "ScreenWaitForIdleTool",
    "ScreenWaitForElementTool",
    "ScreenOpenAppTool",
    "ScreenLaunchAppTool",
    "ScreenForceStopAppTool",
    "SetSystemSettingTool",
    "GetSystemSettingTool",
    "SetStealthModeTool",
]
