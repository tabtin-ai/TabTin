from __future__ import annotations

import logging
from functools import lru_cache
from typing import Any, Iterable

logger = logging.getLogger(__name__)

CONTROL_DEVICE_TYPES = frozenset({"electron", "daemon", "cloud"})
DEVICE_RUNTIME_TYPES = frozenset({"daemon", "cloud"})
DATA_DEVICE_TYPES = frozenset({"mobile", "iot"})

# W13 D6 短期实施：所有"能不能派任务到这台 control device"的判定都引用本常量。
# 产品方向：路由只看机器状态（online/offline），运行状态（busy）不应阻挡派发。
# 历史代码里散落着 `status == 'online'` / `status != 'online'` 等判断，
# 一律改读 ``DEVICE_AVAILABLE_STATUSES`` 以避免 busy 被当成 offline。
# 中长期会引入 ``Device.runtime_state`` 字段并删除 ``mark_busy/mark_idle``，
# 注意：data device 走另一条路径（_pick_organization_data_device 等），目前不会写入
# busy 状态，保持只筛 online 即可，**不要**把本常量套进 data device 查询。
DEVICE_AVAILABLE_STATUSES = frozenset({"online", "busy"})

USER_LEVEL_DEVICE_TYPES = frozenset({"electron"})
"""用户级设备：注册一次后跨所有 Organization 可见可绑定，不受 organization_id 过滤。"""

SUPPORTED_DEVICE_TYPES = CONTROL_DEVICE_TYPES | DATA_DEVICE_TYPES

DEVICE_TYPE_ALIASES: dict[str, str] = {
    "ios": "mobile",
    "android": "mobile",
}

DEVICE_ROLE_BY_TYPE: dict[str, str] = {
    "electron": "control",
    "daemon": "control",
    "cloud": "control",
    "mobile": "data",
    "iot": "data",
}

CAPABILITY_REGISTRY: dict[str, dict[str, Any]] = {
    "terminal_execute": {
        "label": "终端执行",
        "category": "control",
        "transport": "device_runtime",
    },
    "terminal_read": {
        "label": "终端读取",
        "category": "control",
        "transport": "device_runtime",
    },
    "terminal_write": {
        "label": "终端写入",
        "category": "control",
        "transport": "device_runtime",
    },
    "browser": {
        "label": "浏览器",
        "category": "control",
        "transport": "device_runtime",
    },
    "file": {
        "label": "文件",
        "category": "control",
        "transport": "device_runtime",
    },
    "code_search": {
        "label": "代码搜索",
        "category": "control",
        "transport": "device_runtime",
    },
    "git": {
        "label": "Git",
        "category": "control",
        "transport": "device_runtime",
    },
    "mcp": {
        "label": "本机 MCP",
        "category": "control",
        "transport": "session_electron",
    },
    "ssh": {
        "label": "SSH",
        "category": "control",
        "transport": "device_runtime",
    },
    "device_info": {
        "label": "设备信息",
        "category": "data",
        "transport": "device_runtime",
    },
    "battery": {
        "label": "电量",
        "category": "data",
        "transport": "device_runtime",
    },
    "network_info": {
        "label": "网络信息",
        "category": "data",
        "transport": "device_runtime",
    },
    # TODO: health 尚无对应工具实现（tool_registry 中无 GetHealthDataTool），
    #       暂标记为 planned，待实现后移除 status 并加入 mobile_all 聚合组。
    "health": {
        "label": "健康数据",
        "category": "data",
        "transport": "device_runtime",
        "status": "planned",
    },
    "location": {
        "label": "位置",
        "category": "data",
        "transport": "device_runtime",
    },
    # L1: standard-permission mobile capabilities
    "contacts": {
        "label": "通讯录",
        "category": "data",
        "transport": "device_runtime",
    },
    "sms_read": {
        "label": "短信读取",
        "category": "data",
        "transport": "device_runtime",
    },
    "sms_send": {
        "label": "短信发送",
        "category": "data",
        "transport": "device_runtime",
    },
    "call_log": {
        "label": "通话记录",
        "category": "data",
        "transport": "device_runtime",
    },
    "phone_call": {
        "label": "拨打电话",
        "category": "data",
        "transport": "device_runtime",
    },
    "calendar": {
        "label": "日历",
        "category": "data",
        "transport": "device_runtime",
    },
    "notification": {
        "label": "通知监听",
        "category": "data",
        "transport": "device_runtime",
    },
    "app_list": {
        "label": "应用列表",
        "category": "data",
        "transport": "device_runtime",
    },
    "media_read": {
        "label": "媒体读取（图片）",
        "category": "data",
        "transport": "device_runtime",
    },
    "media_read_video": {
        "label": "媒体读取（视频）",
        "category": "data",
        "transport": "device_runtime",
    },
    # L2: developer-mode capabilities (ADB privileged process)
    "screen_capture": {
        "label": "屏幕截图",
        "category": "data",
        "transport": "device_runtime",
    },
    "screen_ui_tree": {
        "label": "UI 树",
        "category": "data",
        "transport": "device_runtime",
    },
    "screen_input": {
        "label": "屏幕输入",
        "category": "data",
        "transport": "device_runtime",
    },
    "app_management": {
        "label": "应用管理",
        "category": "data",
        "transport": "device_runtime",
    },
    "system_settings": {
        "label": "系统设置",
        "category": "data",
        "transport": "device_runtime",
    },
    "gui": {
        "label": "GUI 环境",
        "category": "control",
        "transport": "device_runtime",
    },
    "html_render": {
        "label": "HTML 视频渲染",
        "category": "control",
        "transport": "session_electron",
    },
    "video_render_mg": {
        "label": "视频渲染",
        "category": "control",
        "transport": "device_runtime",
    },
    "video_export": {
        "label": "视频导出",
        "category": "control",
        "transport": "device_runtime",
    },
}

CAPABILITY_GROUPS: dict[str, frozenset[str]] = {
    "terminal": frozenset({"terminal_execute", "terminal_read", "terminal_write"}),
    "browser": frozenset({"browser"}),
    "file": frozenset({"file"}),
    "code_search": frozenset({"code_search"}),
    "git": frozenset({"git"}),
    "mcp": frozenset({"mcp"}),
    "ssh": frozenset({"ssh"}),
    "html_render": frozenset({"html_render"}),
    "video_render_mg": frozenset({"video_render_mg"}),
    "video_export": frozenset({"video_export"}),
    "device_info": frozenset({"device_info"}),
    "battery": frozenset({"battery"}),
    "network_info": frozenset({"network_info"}),
    "health": frozenset({"health"}),  # status=planned, 无工具实现，不在 mobile_all 中
    "location": frozenset({"location"}),
    # L1 mobile capabilities
    "contacts": frozenset({"contacts"}),
    "sms_read": frozenset({"sms_read"}),
    "sms_send": frozenset({"sms_send"}),
    "sms": frozenset({"sms_read", "sms_send"}),
    "call_log": frozenset({"call_log"}),
    "phone_call": frozenset({"phone_call"}),
    "phone": frozenset({"phone_call", "call_log"}),
    "calendar": frozenset({"calendar"}),
    "notification": frozenset({"notification"}),
    "app_list": frozenset({"app_list"}),
    "media_read": frozenset({"media_read", "media_read_video"}),
    # L2 mobile capabilities
    "screen_capture": frozenset({"screen_capture"}),
    "screen_ui_tree": frozenset({"screen_ui_tree"}),
    "screen_input": frozenset({"screen_input"}),
    "screen_automation": frozenset({"screen_capture", "screen_ui_tree", "screen_input"}),
    "app_management": frozenset({"app_management"}),
    "system_settings": frozenset({"system_settings"}),
    # Aggregate groups
    "mobile_l1": frozenset({
        "contacts", "sms_read", "sms_send", "call_log", "phone_call",
        "calendar", "notification", "app_list", "media_read", "media_read_video", "location",
    }),
    "mobile_l2": frozenset({
        "screen_capture", "screen_ui_tree", "screen_input",
        "app_management", "system_settings",
    }),
    "mobile_all": frozenset({
        "contacts", "sms_read", "sms_send", "call_log", "phone_call",
        "calendar", "notification", "app_list", "media_read", "media_read_video", "location",
        "screen_capture", "screen_ui_tree", "screen_input",
        "app_management", "system_settings",
        "device_info", "battery", "network_info",
    }),
}

CAPABILITY_ALIASES: dict[str, frozenset[str]] = {
    "terminal": CAPABILITY_GROUPS["terminal"],
    "terminal_io": frozenset({"terminal_read", "terminal_write"}),
    "filesystem": CAPABILITY_GROUPS["file"],
    "web": CAPABILITY_GROUPS["browser"],
}

MOBILE_P0_BLOCKED_CAPABILITIES = frozenset({
    "terminal_execute",
    "terminal_read",
    "terminal_write",
    "browser",
    "file",
    "code_search",
    "git",
    "mcp",
    "ssh",
})

EXTRA_TOOL_CAPABILITY_MAP: dict[str, str] = {
    "get_battery_info": "battery",
    "get_device_info": "device_info",
    "get_network_info": "network_info",
    "mcp_list_servers": "mcp",
    "mcp_list_tools": "mcp",
    "mcp_call_tool": "mcp",
    "mcp_list_resources": "mcp",
    "mcp_read_resource": "mcp",
    "mcp_list_prompts": "mcp",
    "mcp_get_prompt": "mcp",
    # L1 mobile tools
    "read_contacts": "contacts",
    "search_contacts": "contacts",
    "read_sms": "sms_read",
    "send_sms": "sms_send",
    "read_call_log": "call_log",
    "make_call": "phone_call",
    "read_calendar": "calendar",
    "get_location": "location",
    "read_notifications": "notification",
    "list_installed_apps": "app_list",
    "read_media": "media_read",
    # L2 mobile tools
    "screen_capture": "screen_capture",
    "screen_snapshot": "screen_capture",
    "screen_ui_tree": "screen_ui_tree",
    "screen_tap": "screen_input",
    "screen_tap_area": "screen_input",
    "screen_tap_element": "screen_input",
    "screen_long_press_element": "screen_input",
    "screen_find_element": "screen_ui_tree",
    "screen_get_context": "screen_ui_tree",
    "screen_swipe": "screen_input",
    "screen_long_press": "screen_input",
    "screen_type_text": "screen_input",
    "screen_type_in_element": "screen_input",
    "screen_type_secret": "screen_input",
    "screen_key_event": "screen_input",
    "screen_wait_for_idle": "screen_ui_tree",
    "screen_wait_for_element": "screen_ui_tree",
    "screen_launch_app": "app_management",
    "screen_open_app": "app_management",
    "screen_force_stop_app": "app_management",
    "set_system_setting": "system_settings",
    "get_system_setting": "system_settings",
    "set_stealth_mode": "screen_input",
    # Device management tools
    "launch_with_intent": "app_management",
    "save_to_device": "screen_capture",
    "get_automation_status": "device_info",
}


def normalize_device_type(device_type: str | None, *, default: str = "electron") -> str:
    """规范化设备类型字符串。

    空值/None 时使用 default 参数（默认 'electron' 为向后兼容）。
    调用方如需不同默认值（如 Daemon 激活场景默认 'daemon'），显式传 default。
    """
    raw = str(device_type or "").strip().lower()
    if not raw:
        return default
    return DEVICE_TYPE_ALIASES.get(raw, raw)


def is_user_level_device(device_type: str | None) -> bool:
    """判断设备类型是否为用户级（跨 Organization 可见）。"""
    if not device_type:
        return False
    return normalize_device_type(device_type) in USER_LEVEL_DEVICE_TYPES


def infer_device_role(device_type: str | None) -> str:
    normalized = normalize_device_type(device_type)
    return DEVICE_ROLE_BY_TYPE.get(normalized, "data")


def expand_capability_alias(capability: str | None) -> set[str]:
    """将能力别名展开为具体能力集合。

    多值别名（如 "terminal" → {"terminal_execute", "terminal_read", "terminal_write"}）
    返回的 set 无确定迭代顺序。调用方如需确定性结果应使用 sorted()。
    要求：同一别名展开的所有能力必须具有相同的 category 和 transport，
    否则 classify_capability_category / get_capability_transport 会 raise ValueError。
    """
    raw = str(capability or "").strip()
    if not raw:
        return set()
    if raw in CAPABILITY_ALIASES:
        return set(CAPABILITY_ALIASES[raw])
    return {raw}


def normalize_device_capabilities(
    capabilities: Iterable[str] | None,
    *,
    device_type: str | None = None,
) -> list[str]:
    known = set(CAPABILITY_REGISTRY.keys()) | set(CAPABILITY_ALIASES.keys())
    normalized: set[str] = set()
    for item in capabilities or []:
        if item and item not in known:
            logger.warning("[CapabilityRegistry] Unknown capability reported: %s", item)
        normalized.update(expand_capability_alias(item))

    if normalize_device_type(device_type) == "mobile":
        normalized.difference_update(MOBILE_P0_BLOCKED_CAPABILITIES)

    return sorted(cap for cap in normalized if cap)


def get_capability_group(group_name: str) -> frozenset[str]:
    if group_name in CAPABILITY_GROUPS:
        return CAPABILITY_GROUPS[group_name]
    expanded = expand_capability_alias(group_name)
    return frozenset(expanded)


def has_capability(capabilities: Iterable[str] | None, capability: str) -> bool:
    normalized = set(normalize_device_capabilities(capabilities))
    return bool(normalized & get_capability_group(capability))


def has_capability_group(capabilities: Iterable[str] | None, group_name: str) -> bool:
    normalized = set(normalize_device_capabilities(capabilities))
    return bool(normalized & get_capability_group(group_name))


def classify_capability_category(capability: str) -> str | None:
    """返回能力所属的 category（"control" / "data"）。

    多值别名（如 "terminal" → 3 个能力）会校验所有展开结果的 category 一致，
    不一致时 raise ValueError（fail-fast），单值时直接返回。
    """
    expanded = expand_capability_alias(capability)
    if not expanded:
        return None
    categories = set()
    for cap in sorted(expanded):
        meta = CAPABILITY_REGISTRY.get(cap)
        if isinstance(meta, dict) and meta.get("category"):
            categories.add(str(meta["category"]))
    if len(categories) > 1:
        raise ValueError(
            f"Alias '{capability}' expands to capabilities with mixed categories: {categories}"
        )
    return next(iter(categories), None)


def get_capability_transport(capability: str | None) -> str | None:
    """返回能力所需的 transport（"device_runtime" / "session_electron"）。

    多值别名会校验所有展开结果的 transport 一致，不一致时 raise ValueError。
    """
    expanded = expand_capability_alias(capability)
    if not expanded:
        return None
    transports = set()
    for cap in sorted(expanded):
        meta = CAPABILITY_REGISTRY.get(cap)
        if isinstance(meta, dict) and meta.get("transport"):
            transports.add(str(meta["transport"]))
    if len(transports) > 1:
        raise ValueError(
            f"Alias '{capability}' expands to capabilities with mixed transports: {transports}"
        )
    return next(iter(transports), None)


def list_platform_capabilities() -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for capability, meta in CAPABILITY_REGISTRY.items():
        items.append({
            "name": capability,
            **meta,
        })
    return items


@lru_cache(maxsize=1)
def get_tool_capability_map() -> dict[str, str]:
    from apps.services.tools import (
        get_tool_capability_map as get_manifest_tool_capability_map,
    )
    raw_map: dict[str, str] = {}
    for source_name, source_map in (
        ("manifest", get_manifest_tool_capability_map() or {}),
        ("extra", EXTRA_TOOL_CAPABILITY_MAP),
    ):
        for tool_name, capability in source_map.items():
            existing = raw_map.get(tool_name)
            if existing is not None and existing != capability:
                raise ValueError(
                    "Tool capability map conflict for "
                    f"{tool_name!r}: {existing!r} != {capability!r} ({source_name})"
                )
            raw_map[tool_name] = capability
    normalized: dict[str, str] = {}
    for tool_name, capability in raw_map.items():
        if not tool_name or not capability:
            continue
        expanded = expand_capability_alias(capability)
        if len(expanded) == 1:
            normalized[tool_name] = next(iter(sorted(expanded)))
        else:
            normalized[tool_name] = capability
    return normalized


def refresh_tool_capability_map() -> dict[str, str]:
    get_tool_capability_map.cache_clear()
    return get_tool_capability_map()


CLIENT_TYPE_TO_RUNTIME: dict[str, str] = {
    "electron": "electron",
    "daemon": "daemon",
    "web": "web",
    "ios": "mobile",
    "android": "mobile",
    "admindash": "web",
    "server": "server",
}


def resolve_runtime_type(client_type: str | None) -> str:
    """将 HTTP X-Client-Type 映射为 RuntimeType。

    注意：'server' 不映射为 'daemon'——Celery worker 等后端内部调用也用 'server'，
    与 Daemon 设备是不同语境。
    """
    if not client_type:
        return "server"
    return CLIENT_TYPE_TO_RUNTIME.get(client_type.strip().lower(), "server")


__all__ = [
    "CAPABILITY_ALIASES",
    "CAPABILITY_GROUPS",
    "CAPABILITY_REGISTRY",
    "CLIENT_TYPE_TO_RUNTIME",
    "CONTROL_DEVICE_TYPES",
    "DATA_DEVICE_TYPES",
    "DEVICE_AVAILABLE_STATUSES",
    "DEVICE_RUNTIME_TYPES",
    "DEVICE_ROLE_BY_TYPE",
    "DEVICE_TYPE_ALIASES",
    "EXTRA_TOOL_CAPABILITY_MAP",
    "MOBILE_P0_BLOCKED_CAPABILITIES",
    "SUPPORTED_DEVICE_TYPES",
    "USER_LEVEL_DEVICE_TYPES",
    "classify_capability_category",
    "expand_capability_alias",
    "get_capability_group",
    "get_capability_transport",
    "get_tool_capability_map",
    "has_capability",
    "has_capability_group",
    "infer_device_role",
    "is_user_level_device",
    "list_platform_capabilities",
    "normalize_device_capabilities",
    "normalize_device_type",
    "refresh_tool_capability_map",
    "resolve_runtime_type",
]
