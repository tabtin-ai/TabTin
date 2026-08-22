"""
ExecutionContext — Agent 执行环境的统一描述

贯穿工具集 / System Prompt / Context Message / Skill 四层，
根据 Space 绑定设备状态 × 客户端类型的组合矩阵解析出统一的能力描述。

五种执行模式：
- device_online:    绑定设备且在线 → 全能力
- device_offline:   绑定设备但离线 → 降级到纯后端工具
- electron_direct:  无绑定设备、Electron 客户端 → Electron 自身执行
- daemon_direct:    无绑定设备、Daemon 客户端 → Daemon 直连执行
- backend_only:     无绑定设备、非 Electron/Daemon 客户端 → 纯后端 FC
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional

from apps.services.common.device_capability_registry import (
    CAPABILITY_GROUPS,
    DEVICE_AVAILABLE_STATUSES,
    has_capability_group,
    normalize_device_capabilities,
)
from apps.tabtinspace.services.execution_binding import resolve_execution_binding

logger = logging.getLogger(__name__)

_MAX_REMOTE_SERVERS = 50
_MAX_AGENT_CONFIG_BYTES = 65_536  # 64 KB

_WORKSPACE_DEVICE_FIELDS = (
    "id", "organization_id", "git_status",
    "device__capabilities", "device__status", "device__name",
    "device__fingerprint", "device__os_info", "device__device_type",
)

ExecutionMode = Literal[
    "device_online",
    "device_offline",
    "electron_direct",
    "daemon_direct",
    "backend_only",
]


@dataclass(frozen=True)
class ExecutionContext:
    """Agent 执行环境的统一描述，贯穿工具/Prompt/Context/Skill 四层。"""

    mode: ExecutionMode

    device_name: Optional[str] = None
    device_fingerprint: Optional[str] = None
    device_capabilities: tuple = ()
    device_os_platform: Optional[str] = None

    can_terminal: bool = False
    can_terminal_execute: bool = False
    can_terminal_read: bool = False
    can_terminal_write: bool = False
    can_terminal_list: bool = False
    can_browser: bool = False
    can_file: bool = False
    can_mcp: bool = False
    can_ssh: bool = False
    can_frontend_action: bool = False
    can_video_render_html: bool = False
    can_video_render_mg: bool = False
    can_video_export: bool = False
    can_desktop: bool = False
    can_device_screen: bool = False
    data_device_capabilities: tuple = ()

    capability_summary: str = ""
    unavailable_note: Optional[str] = None
    recovery_hint: Optional[str] = None

    @property
    def can_video_render(self) -> bool:
        """向后兼容：任一视频渲染能力可用即为 True。"""
        return self.can_video_render_html or self.can_video_render_mg or self.can_video_export

    @property
    def is_degraded(self) -> bool:
        """降级模式：设备离线或无设备（非 Electron 直连）。"""
        return self.mode in ("device_offline", "backend_only")

    @property
    def is_device_bound(self) -> bool:
        """是否绑定了设备（无论在线与否）。"""
        return self.mode in ("device_online", "device_offline")


_TERMINAL_READ_TOOL_NAMES = frozenset({"read_terminal_output", "list_terminal_sessions"})


def _build_data_device_tool_cap_map() -> dict[str, str]:
    """从统一工具能力映射中筛选出在 data device 上执行的工具及其所需能力。

    MCP 等 control device 工具不应受 data_device_capabilities 过滤影响。
    """
    from apps.services.common.device_capability_registry import (
        CAPABILITY_REGISTRY,
        expand_capability_alias,
        get_tool_capability_map,
    )

    result: dict[str, str] = {}
    for tool_name, cap_name in get_tool_capability_map().items():
        canonical = next(iter(sorted(expand_capability_alias(cap_name))), None)
        if canonical is None:
            continue
        meta = CAPABILITY_REGISTRY.get(canonical)
        if isinstance(meta, dict) and meta.get("category") == "data":
            result[tool_name] = cap_name
    return result


_DATA_DEVICE_TOOL_CAP_MAP: dict[str, str] | None = None


def _get_data_device_required_cap(tool_name: str) -> str | None:
    """查询工具在 data device 上执行时所需的能力，不在 data device 执行的返回 None。"""
    global _DATA_DEVICE_TOOL_CAP_MAP
    if _DATA_DEVICE_TOOL_CAP_MAP is None:
        _DATA_DEVICE_TOOL_CAP_MAP = _build_data_device_tool_cap_map()
    return _DATA_DEVICE_TOOL_CAP_MAP.get(tool_name)


def is_tool_allowed_for_execution_context(
    tool_name: str,
    execution_context: Optional[ExecutionContext],
) -> bool:
    """根据 ExecutionContext 判断工具是否应暴露给当前 Agent。

    1. Terminal 域：按 execute/read/write 细粒度裁剪。
    2. Device 域：按统一工具能力映射中声明的所需能力与
       data_device_capabilities 交叉过滤，避免暴露手机不具备的工具。
    """
    if execution_context is None:
        return True

    if tool_name == "execute_in_terminal":
        return bool(getattr(execution_context, "can_terminal_execute", False))
    if tool_name in _TERMINAL_READ_TOOL_NAMES:
        return bool(getattr(execution_context, "can_terminal_read", False))
    if tool_name == "write_to_terminal":
        return bool(getattr(execution_context, "can_terminal_write", False))

    required_cap = _get_data_device_required_cap(tool_name)
    if required_cap is not None:
        data_caps = set(execution_context.data_device_capabilities)
        if not data_caps:
            return False
        return required_cap in data_caps

    return True


_BACKEND_ONLY_SUMMARY = (
    "可用：数据分析(SQL)、知识检索(RAG)、文档创作、表格操作、视频生成、邮件等后端工具"
)
_BACKEND_ONLY_NOTE = (
    "当前无执行设备。终端、文件操作、浏览器等需要执行设备才能使用。"
)


@dataclass(frozen=True)
class SpaceSnapshot:
    """Space + 绑定设备的轻量快照，一次 DB 查询两处复用。"""

    space_id: str
    execution_agent_id: Optional[str] = None
    identity_user_id: Optional[str] = None
    agent_config: Dict[str, Any] = field(default_factory=dict)

    device_name: Optional[str] = None
    device_fingerprint: Optional[str] = None
    device_capabilities: Optional[List[str]] = None
    device_status: Optional[str] = None
    device_os_info: Dict[str, Any] = field(default_factory=dict)

    has_remote_servers: bool = False
    remote_servers: List[Dict[str, Any]] = field(default_factory=list)
    git_status: Optional[Dict[str, Any]] = None

    data_device_capabilities: List[str] = field(default_factory=list)
    has_data_device: bool = False

    agent_runtime_type: Optional[str] = None


def _check_user_space_access(user_id: str, space_id: str, organization_id) -> bool:
    """检查用户是否有 Space 的访问权限（viewer 及以上）。

    委托给统一的 check_space_access，覆盖 SpaceMembership + Agent Membership
    + Organization Owner 隐式权限 + API Key organization 约束。
    organization_id 参数保留以兼容现有调用方签名。
    """
    from apps.tabtinspace.services.base import check_space_access
    return check_space_access(user_id, space_id, 'viewer')


def fetch_space_snapshot(
    space_id: str,
    *,
    user_id: Optional[str] = None,
    execution_agent_id: Optional[str] = None,
    identity_user_id: Optional[str] = None,
) -> Optional[SpaceSnapshot]:
    """一次查询获取 Space 全部设备/SSH/Git 信息。

    Args:
        space_id: Space ID。
        user_id: 调用者的用户 ID。提供时会验证用户对该 Space 的访问权限，
                 无权限则返回 None。系统级调用可省略以跳过权限检查。
    Returns:
        SpaceSnapshot 或 None（Space 不存在 / 无权限时）。
    """
    try:
        from apps.tabtinspace.models import Workspace

        space = Workspace.objects.select_related(
            "device",
        ).filter(
            id=space_id,
        ).only(*_WORKSPACE_DEVICE_FIELDS).first()

        if not space:
            return None

        if user_id:
            organization_id = getattr(space, "organization_id", None)
            if not _check_user_space_access(user_id, space_id, organization_id):
                logger.warning(
                    "[fetch_space_snapshot] user %s has no access to space %s",
                    user_id, space_id,
                )
                return None

        binding = resolve_execution_binding(
            space=space,
            agent_id=execution_agent_id,
            organization_id=getattr(space, "organization_id", None),
            identity_user_id=identity_user_id or user_id,
        )
        execution_agent = binding.agent
        _raw_agent_config = (
            getattr(execution_agent, "agent_config", None)
            if execution_agent is not None
            else None
        )
        raw_config = _raw_agent_config if isinstance(_raw_agent_config, dict) else {}

        try:
            config_size = len(json.dumps(raw_config, ensure_ascii=False))
        except (TypeError, ValueError):
            config_size = 0
        if config_size > _MAX_AGENT_CONFIG_BYTES:
            logger.warning(
                "[fetch_space_snapshot] agent_config exceeds %d bytes (%d), truncating to empty for space %s",
                _MAX_AGENT_CONFIG_BYTES, config_size, space_id,
            )
            agent_config: Dict[str, Any] = {}
        else:
            agent_config = raw_config

        dev_name = dev_fp = dev_status = None
        dev_caps: Optional[List[str]] = None
        dev_os: Dict[str, Any] = {}

        device = binding.device
        agent_rt: Optional[str] = (
            getattr(device, "device_type", None) if device is not None else None
        )
        if device is not None:
            dev_name = device.name
            dev_fp = device.fingerprint
            raw_caps = device.capabilities
            if raw_caps is None:
                dev_caps = None
            elif isinstance(raw_caps, list):
                dev_caps = normalize_device_capabilities(raw_caps, device_type=device.device_type)
            else:
                dev_caps = []
            dev_status = device.status or "offline"
            # DEV-P1-07: Redis 有效时优先 Redis，统一初始加载与运行时刷新的数据源
            if dev_fp:
                try:
                    from apps.services.common.ws.bus import is_device_ws_connected
                    redis_online = is_device_ws_connected(dev_fp)
                    if redis_online and dev_status != "online":
                        logger.info("[fetch_space_snapshot] Redis says online but DB=%s, promoting to online: fp=%s", dev_status, dev_fp)
                        dev_status = "online"
                    elif not redis_online and dev_status == "online":
                        # E2E-FIX: Redis device_action_ready key 可能因心跳 TTL
                        # 竞态过期，但设备实际仍在线（DB=online 且 WS 连接存活）。
                        # 采用 fail-open 策略：保持 DB 的 online 状态，
                        # 与 is_device_ws_connected 中 Redis 故障时的 fail-open 逻辑一致。
                        # 最坏情况是向离线设备发送 action 并收到超时，
                        # 优于错误禁用 terminal/browser 工具导致 Agent 功能残缺。
                        logger.warning(
                            "[fetch_space_snapshot] Redis device_action_ready expired but "
                            "DB=online, fail-open keeping online: fp=%s", dev_fp,
                        )
                except Exception as exc:
                    logger.error("[fetch_space_snapshot] Redis check failed for fp=%s, keeping DB status=%s: %s", dev_fp, dev_status, exc)
            dev_os = device.os_info or {}

        has_remote = False
        remote_list: List[Dict[str, Any]] = []
        if dev_fp:
            try:
                from apps.tabtinspace.models import RemoteServer
                servers = RemoteServer.objects.filter(
                    device__fingerprint=dev_fp,
                    status="active",
                ).only("id", "name", "host", "port", "username")[:_MAX_REMOTE_SERVERS]
                remote_list = [
                    {
                        "id": str(s.id),
                        "name": s.name,
                        "host": s.host,
                        "port": s.port,
                        "username": s.username,
                    }
                    for s in servers
                ]
                has_remote = bool(remote_list)
            except Exception as exc:
                logger.debug("[fetch_space_snapshot] RemoteServer query failed: %s", exc)

        git_status_raw = getattr(space, "git_status", None)
        git_status = (
            git_status_raw
            if isinstance(git_status_raw, dict) and git_status_raw.get("is_repo")
            else None
        )

        data_device_caps: List[str] = []
        has_data_dev = False
        try:
            from apps.tabtinspace.models import Device

            organization_id = getattr(space, "organization_id", None)
            if organization_id:
                data_devices = Device.objects.filter(
                    organization_id=organization_id,
                    role="data",
                    status="online",
                ).only("capabilities", "device_type")[:10]
                aggregated: set[str] = set()
                for dd in data_devices:
                    has_data_dev = True
                    dd_caps = normalize_device_capabilities(
                        dd.capabilities, device_type=dd.device_type,
                    )
                    aggregated.update(dd_caps)
                data_device_caps = sorted(aggregated)
        except Exception as exc:
            logger.debug("[fetch_space_snapshot] data device query failed: %s", exc)

        return SpaceSnapshot(
            space_id=str(space_id),
            execution_agent_id=str(getattr(binding.agent, "id", "") or "") or None,
            identity_user_id=str(identity_user_id or user_id or "") or None,
            agent_config=agent_config,
            device_name=dev_name,
            device_fingerprint=dev_fp,
            device_capabilities=dev_caps,
            device_status=dev_status,
            device_os_info=dev_os,
            has_remote_servers=has_remote,
            remote_servers=remote_list,
            git_status=git_status,
            data_device_capabilities=data_device_caps,
            has_data_device=has_data_dev,
            agent_runtime_type=agent_rt,
        )
    except Exception as exc:
        logger.warning("[fetch_space_snapshot] Query failed: %s", exc)
        return None


class ExecutionContextResolver:
    """从 Space + client_type 解析 ExecutionContext。"""

    @staticmethod
    def resolve(
        *,
        client_type: Optional[str] = None,
        has_remote_servers: bool = False,
        # 设备原始字段（全部传入即视为有绑定设备）
        device_name: Optional[str] = None,
        device_fingerprint: Optional[str] = None,
        device_capabilities: Optional[List[str]] = None,
        device_status: Optional[str] = None,
        device_os_info: Optional[Dict[str, Any]] = None,
        # organization data device (mobile) capabilities
        data_device_capabilities: Optional[List[str]] = None,
    ) -> ExecutionContext:
        has_device = device_capabilities is not None
        if has_device:
            return ExecutionContextResolver._resolve_with_device(
                client_type=client_type or "server",
                name=device_name,
                fingerprint=device_fingerprint,
                capabilities=device_capabilities or [],
                status=device_status or "offline",
                os_info=device_os_info or {},
                has_remote_servers=has_remote_servers,
                data_device_capabilities=data_device_capabilities or [],
            )
        return ExecutionContextResolver._resolve_without_device(
            client_type or "electron",
            data_device_capabilities=data_device_capabilities or [],
        )

    @staticmethod
    def _resolve_with_device(
        *,
        client_type: str,
        name: Optional[str],
        fingerprint: Optional[str],
        capabilities: List[str],
        status: str,
        os_info: Dict[str, Any],
        has_remote_servers: bool,
        data_device_capabilities: Optional[List[str]] = None,
    ) -> ExecutionContext:
        caps = normalize_device_capabilities(capabilities)
        caps_tuple = tuple(caps)
        # W13 D6 短期实施：busy 视为可用——不再因 busy 把工具能力降级到只剩
        is_online = status in DEVICE_AVAILABLE_STATUSES
        os_platform = _extract_os_platform(os_info)
        has_local_session_mcp = client_type == "electron"
        has_device_screen = has_capability_group(
            data_device_capabilities or [], "screen_automation",
        )

        if is_online:
            can_terminal_execute = has_capability_group(caps, "terminal_execute")
            can_terminal_read = has_capability_group(caps, "terminal_read")
            can_terminal_write = has_capability_group(caps, "terminal_write")
            can_terminal_list = can_terminal_read
            has_terminal = can_terminal_execute or can_terminal_read or can_terminal_write
            has_browser = has_capability_group(caps, "browser")
            has_file = has_capability_group(caps, "file")
            has_mcp = has_capability_group(caps, "mcp")
            effective_mcp = has_mcp or has_local_session_mcp

            summary_parts: List[str] = []
            if has_terminal:
                if can_terminal_execute and can_terminal_read and can_terminal_write:
                    summary_parts.append("终端")
                elif can_terminal_execute:
                    summary_parts.append("终端执行")
                else:
                    summary_parts.append("终端会话")
            if has_browser:
                summary_parts.append("浏览器")
            if has_file:
                summary_parts.append("文件操作")
            if effective_mcp:
                summary_parts.append("本机 MCP")
            summary_parts.extend(["SQL", "RAG", "文档", "表格"])
            if has_remote_servers:
                summary_parts.append("SSH")

            mobile_parts = _build_mobile_summary(data_device_capabilities)
            if mobile_parts:
                summary_parts.append(f"手机({', '.join(mobile_parts)})")

            is_electron_client = client_type == "electron"
            return ExecutionContext(
                mode="device_online",
                device_name=name,
                device_fingerprint=fingerprint,
                device_capabilities=caps_tuple,
                device_os_platform=os_platform,
                can_terminal=has_terminal,
                can_terminal_execute=can_terminal_execute,
                can_terminal_read=can_terminal_read,
                can_terminal_write=can_terminal_write,
                can_terminal_list=can_terminal_list,
                can_browser=has_browser,
                can_file=has_file,
                can_mcp=effective_mcp,
                can_ssh=has_remote_servers,
                can_frontend_action=has_terminal or has_browser or has_file,
                can_video_render_html=is_electron_client,
                can_video_render_mg="video_render_mg" in caps,
                can_video_export="video_export" in caps,
                can_device_screen=has_device_screen,
                data_device_capabilities=tuple(data_device_capabilities or []),
                capability_summary=f"全部可用: {', '.join(summary_parts)}",
            )

        mobile_parts_offline = _build_mobile_summary(data_device_capabilities)
        mobile_suffix_offline = f"、手机({', '.join(mobile_parts_offline)})" if mobile_parts_offline else ""
        unavailable_note = (
            f"设备 {name} 当前离线。"
            "终端/浏览器/文件操作暂不可用，仅可使用后端工具。"
        )
        capability_summary = _BACKEND_ONLY_SUMMARY + mobile_suffix_offline
        recovery_hint = "设备恢复在线后将自动恢复全部能力。"
        if has_local_session_mcp:
            capability_summary = f"当前执行设备离线，但当前 Electron 会话仍可使用本机 MCP 与后端工具{mobile_suffix_offline}。"
            unavailable_note += " 当前 Electron 会话仍可使用本机 MCP。"
            recovery_hint = "设备恢复在线后将恢复其余前端能力；本机 MCP 连接当前仍可使用。"

        return ExecutionContext(
            mode="device_offline",
            device_name=name,
            device_fingerprint=fingerprint,
            device_capabilities=caps_tuple,
            device_os_platform=os_platform,
            can_terminal=False,
            can_terminal_execute=False,
            can_terminal_read=False,
            can_terminal_write=False,
            can_terminal_list=False,
            can_browser=False,
            can_file=False,
            can_mcp=has_local_session_mcp,
            can_ssh=False,
            can_frontend_action=False,
            can_video_render_html=has_local_session_mcp,
            can_video_render_mg=False,
            can_video_export=False,
            can_device_screen=has_device_screen,
            data_device_capabilities=tuple(data_device_capabilities or []),
            capability_summary=capability_summary,
            unavailable_note=unavailable_note,
            recovery_hint=recovery_hint,
        )

    @staticmethod
    def _resolve_without_device(
        client_type: str,
        data_device_capabilities: Optional[List[str]] = None,
    ) -> ExecutionContext:
        mobile_parts = _build_mobile_summary(data_device_capabilities)
        mobile_suffix = f"、手机({', '.join(mobile_parts)})" if mobile_parts else ""
        has_device_screen = has_capability_group(
            data_device_capabilities or [], "screen_automation",
        )

        data_caps_tuple = tuple(data_device_capabilities or [])

        if client_type == "electron":
            return ExecutionContext(
                mode="electron_direct",
                can_terminal=True,
                can_terminal_execute=True,
                can_terminal_read=True,
                can_terminal_write=True,
                can_terminal_list=True,
                can_browser=False,
                can_file=True,
                can_mcp=True,
                can_ssh=False,
                can_frontend_action=True,
                can_video_render_html=True,
                can_video_render_mg=False,
                can_video_export=False,
                can_desktop=True,
                can_device_screen=has_device_screen,
                data_device_capabilities=data_caps_tuple,
                capability_summary=f"Electron 直连: 终端、文件操作、本机 MCP 可用{mobile_suffix}",
            )

        if client_type == "daemon":
            return ExecutionContext(
                mode="daemon_direct",
                can_terminal=True,
                can_terminal_execute=True,
                can_terminal_read=True,
                can_terminal_write=True,
                can_terminal_list=True,
                can_browser=False,
                can_file=True,
                can_mcp=False,
                can_ssh=False,
                can_frontend_action=True,
                can_video_render_html=False,
                can_video_render_mg=False,
                can_video_export=False,
                can_device_screen=has_device_screen,
                data_device_capabilities=data_caps_tuple,
                capability_summary=f"Daemon 直连: 终端、文件操作可用{mobile_suffix}",
            )

        summary = _BACKEND_ONLY_SUMMARY
        if mobile_suffix:
            summary = f"{summary}{mobile_suffix}"
        return ExecutionContext(
            mode="backend_only",
            can_terminal=False,
            can_terminal_execute=False,
            can_terminal_read=False,
            can_terminal_write=False,
            can_terminal_list=False,
            can_browser=False,
            can_file=False,
            can_mcp=False,
            can_ssh=False,
            can_frontend_action=False,
            can_video_render_html=False,
            can_video_render_mg=False,
            can_video_export=False,
            can_device_screen=has_device_screen,
            data_device_capabilities=data_caps_tuple,
            capability_summary=summary,
            unavailable_note=_BACKEND_ONLY_NOTE,
        )


    @staticmethod
    def resolve_from_space(
        space_id: str,
        *,
        client_type: Optional[str] = None,
        agent_runtime_type: Optional[str] = None,
    ) -> ExecutionContext:
        """从 Space ID 一站式解析 ExecutionContext（含设备 + SSH 查询）。

        异常安全：内部捕获所有异常，保证返回可用的 ExecutionContext。
        无绑定设备时使用 snapshot 中的 agent_runtime_type（优先）或 client_type 降级。
        """
        fallback_ct = client_type or "server"
        snapshot = fetch_space_snapshot(space_id)
        effective_runtime = (
            (snapshot.agent_runtime_type if snapshot else None)
            or agent_runtime_type
            or fallback_ct
        )
        if not snapshot or snapshot.device_capabilities is None:
            return ExecutionContextResolver.resolve(
                client_type=effective_runtime,
                data_device_capabilities=snapshot.data_device_capabilities if snapshot else None,
            )
        return ExecutionContextResolver.resolve(
            client_type=effective_runtime,
            has_remote_servers=snapshot.has_remote_servers,
            device_name=snapshot.device_name,
            device_fingerprint=snapshot.device_fingerprint,
            device_capabilities=snapshot.device_capabilities,
            device_status=snapshot.device_status or "offline",
            device_os_info=snapshot.device_os_info,
            data_device_capabilities=snapshot.data_device_capabilities,
        )


_MOBILE_SUMMARY_ENTRIES: tuple[tuple[str, str], ...] = (
    ("contacts", "通讯录"),
    ("sms", "短信"),
    ("phone", "电话"),
    ("calendar", "日历"),
    ("notification", "通知"),
    ("location", "定位"),
    ("camera", "相机"),
    ("media_read", "媒体读取"),
    ("app_list", "应用列表"),
    ("screen_automation", "屏幕自动化"),
    ("app_management", "应用管理"),
    ("system_settings", "系统设置"),
)


def _build_mobile_summary(data_caps: Optional[List[str]]) -> List[str]:
    """从 organization data device 能力列表生成可读的移动能力描述片段。

    使用 CAPABILITY_GROUPS 中已定义的分组，避免硬编码能力集合。
    """
    if not data_caps:
        return []
    parts: List[str] = []
    for group_name, label in _MOBILE_SUMMARY_ENTRIES:
        group_caps = CAPABILITY_GROUPS.get(group_name, frozenset())
        if set(data_caps) & group_caps:
            parts.append(label)
    return parts


def _extract_os_platform(os_info: Dict[str, Any]) -> Optional[str]:
    """从 Device.os_info 提取规范化平台标识。

    返回值与 SKILL.md os_filter 使用的 Node.js process.platform 一致：
    "darwin" / "linux" / "win32"，避免中间转换层。
    """
    platform = os_info.get("platform") or os_info.get("os") or ""
    platform_lower = platform.lower()
    if "darwin" in platform_lower or "macos" in platform_lower or "mac" in platform_lower:
        return "darwin"
    if "linux" in platform_lower:
        return "linux"
    if platform_lower.startswith("win") or "windows" in platform_lower:
        return "win32"
    return platform.lower() if platform else None


__all__ = [
    "ExecutionContext",
    "ExecutionContextResolver",
    "ExecutionMode",
    "SpaceSnapshot",
    "fetch_space_snapshot",
    "is_tool_allowed_for_execution_context",
]
