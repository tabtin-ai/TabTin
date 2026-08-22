"""
工具执行前的权限校验。

四层校验：
1. APP 可用性（app_id 是否在 CORE_APPS 或 PLATFORM_TOOL_APP_IDS 中）
2. 项目设置（用户/项目维度是否启用了该 APP）— 仅 CORE_APPS，平台工具跳过
3. space_id 归属校验（AC-008: 工具参数 space_id 须与 Agent 授权 space_id 一致）
4. API Token space_ids 约束（AC-009: Token 的 space_ids 范围校验）

系统工具白名单（SYSTEM_TOOLS_WITHOUT_APP_ID）：
  无 app_id 且无 space_id 时仍允许执行的 Agent 基础设施工具。
  这些工具不操作用户 Space 数据，属于 Agent 自身的思考 / 通信 / 发现能力。
  不在白名单中的无 app_id 工具，若调用时也无 space_id，将被 fail-close 拒绝。
"""
from __future__ import annotations

import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)
# 稳定 logger 名（非模块路径）：与 settings.LOGGING 约定的
# `apps.services.agent_engine.permission.audit` 对齐（Wave 11, 2026-04-17），
# 便于日志采集/监控按名字订阅工具权限审计事件。
_audit_logger = logging.getLogger("apps.services.agent_engine.permission.audit")

# Agent 基础设施工具：不依赖 app_id / space_id 即可安全执行。
# 新增无 app_id 的工具时，若确认不操作 Space 数据，可加入此白名单。
SYSTEM_TOOLS_WITHOUT_APP_ID: frozenset[str] = frozenset({
    # common 域 — Agent 通信与信息获取
    # 历史 ASK_USER_TOOL_NAME = "ask_question" 已随 Wave 11 云端 langgraph 下线 +
    # Wave 5 ask 三件套（ask_choice / ask_form / request_approval）拆分一并退场；
    # 三件套在 TS @tabtin/agent-runtime 端实现，Python ToolPermissionGuard 不再
    # 看到这些工具名（runtime 自有授权链路），无需在白名单内登记。
    "web_search",
    # todo 域 — Agent 任务管理
    "todo_write",
    # think 域 — 工具发现与子 Agent 编排
    # Wave 4.5（2026-05-10）：`think_tool` 已下线，让 LLM 的反思走原生 thinking block，不再外化成独立工具；本白名单同步移除。
    "tool_search",
    "task",
    # docparse 域 — 通用文档解析（无 Space 写入）
    "parse_document",
    # capabilities 域 — 工具发现 + 平台级搜索
    "discover_tools",
    "tabtin_search",  # Wave 4：统一搜索 FC（PRD 3.9.B）；与 web_search 同级，
                      # 不依赖某个 app；ACL 由 SearchTool 内部 thread_context
                      # 强制校验 + acl_service 三层 RBAC（详见 search_tool.py）
    # runtime 域 — 进程监控（后端 BaseTool，主动 publish_action 调度设备）
    "monitor_process",
    "stop_monitor",
    "list_monitors",
})

# Wave 6 M6.1：下列工具已随客户端 TS 实现迁移上线，Python 侧 AgentClientTool
# 版本已删除；白名单中的对应条目（web_fetch / web_fetch_batch / get_tabs_info /
# mcp_* 7 个）随之移除，不再进入 ToolHub 注册。


class ToolPermissionGuard:
    """工具权限校验器"""

    @staticmethod
    def _resolve_user_id(params: dict) -> Optional[str]:
        for key in ("user_id", "userId"):
            value = params.get(key)
            if isinstance(value, str) and value:
                return value
        return None

    @staticmethod
    def _resolve_space_id(params: dict) -> Optional[str]:
        for key in ("current_space_id", "space_id"):
            value = params.get(key)
            if isinstance(value, str) and value:
                return value
        return None

    @classmethod
    def _audit(
        cls,
        *,
        tool_name: str,
        app_id: str,
        action: str,
        allowed: bool,
        reason: str = "",
        user_id: Optional[str] = None,
        space_id: Optional[str] = None,
    ) -> None:
        level = logging.INFO if not allowed else logging.DEBUG
        _audit_logger.log(
            level,
            "[PermissionGuard] %s tool=%s app=%s user=%s space=%s reason=%s",
            action,
            tool_name,
            app_id,
            user_id or "-",
            space_id or "-",
            reason or "ok",
        )

    @classmethod
    def check_tool(cls, tool: Any, params: dict) -> Optional[str]:
        """
        执行权限校验。

        Returns:
            None 表示允许；字符串表示拒绝原因。
        """
        app_id = getattr(tool, "app_id", None)
        has_app_id = bool(app_id and isinstance(app_id, str))
        tool_name = getattr(tool, "name", None) or type(tool).__name__
        user_id = cls._resolve_user_id(params)
        space_id = cls._resolve_space_id(params)

        # ── Layer 1-2: APP 级校验（仅对声明了 app_id 的工具执行）──
        if has_app_id:
            # Layer 1: APP 可用性（核心 APP / 平台工具 APP / 虚拟 APP 始终可用）
            from apps.services.common.app_registry import CORE_APPS, PLATFORM_TOOL_APP_IDS, get_virtual_app_ids

            is_platform_tool = app_id in PLATFORM_TOOL_APP_IDS
            is_virtual_app = app_id in get_virtual_app_ids()

            if app_id not in CORE_APPS and not is_platform_tool and not is_virtual_app:
                cls._audit(
                    tool_name=tool_name,
                    app_id=app_id,
                    action="DENIED:unknown_app",
                    allowed=False,
                    reason="app_id not in CORE_APPS or PLATFORM_TOOL_APP_IDS, denied by default (AZ-8)",
                    user_id=user_id,
                    space_id=space_id,
                )
                return f"未授权的 APP: {app_id}（非核心 APP 需显式授权）"

            # Layer 2: 项目设置检查 — fail-close（FP-011）
            # 平台工具和虚拟 App 不通过 Space 设置管理，跳过 Layer 2
            if not is_platform_tool and not is_virtual_app:
                if not user_id or not space_id:
                    cls._audit(
                        tool_name=tool_name,
                        app_id=app_id,
                        action="DENIED:no_context",
                        allowed=False,
                        reason="missing user_id or space_id, denied by fail-close policy",
                        user_id=user_id,
                        space_id=space_id,
                    )
                    return f"权限校验失败: 缺少用户或空间上下文，无法验证 APP({app_id}) 是否启用"

                try:
                    from apps.tabtinspace.services.app_settings_service import AppSettingsService

                    enabled = AppSettingsService.resolve_enabled_app_ids(
                        user_id=user_id,
                        space_id=space_id,
                        available_app_ids={app_id},
                    )
                    if enabled is not None and app_id not in enabled:
                        reason = "disabled in space settings"
                        cls._audit(
                            tool_name=tool_name,
                            app_id=app_id,
                            action="DENIED:space_disabled",
                            allowed=False,
                            reason=reason,
                            user_id=user_id,
                            space_id=space_id,
                        )
                        return f"APP 未启用: {app_id}"
                except Exception as exc:
                    logger.warning(
                        "[PermissionGuard] AppSettingsService call failed (fail-close): %s", exc,
                    )
                    cls._audit(
                        tool_name=tool_name,
                        app_id=app_id,
                        action="DENIED:settings_error",
                        allowed=False,
                        reason=f"AppSettingsService error: {exc}",
                        user_id=user_id,
                        space_id=space_id,
                    )
                    return f"权限检查异常，操作被拒绝（APP: {app_id}）"
        else:
            # S3-03 + S3-FC: 无 app_id 工具的 fail-close 策略
            is_system_tool = tool_name in SYSTEM_TOOLS_WITHOUT_APP_ID
            if is_system_tool:
                _audit_logger.debug(
                    "[PermissionGuard] SYSTEM_TOOL tool=%s user=%s space=%s — "
                    "whitelisted, APP-level checks skipped",
                    tool_name, user_id or "-", space_id or "-",
                )
            elif space_id:
                # 有 space_id → Layer 3-4 仍能提供保护，允许继续
                logger.warning(
                    "[PermissionGuard] Tool '%s' has no app_id — "
                    "APP-level checks (Layer 1-2) skipped, "
                    "space-level checks (Layer 3-4) still enforced.",
                    tool_name,
                )
                _audit_logger.info(
                    "[PermissionGuard] NO_APP_ID tool=%s user=%s space=%s",
                    tool_name, user_id or "-", space_id or "-",
                )
            else:
                # fail-close: 非系统工具 + 无 app_id + 无 space_id → 拒绝
                cls._audit(
                    tool_name=tool_name,
                    app_id="(no_app_id)",
                    action="DENIED:no_app_no_space",
                    allowed=False,
                    reason="not in SYSTEM_TOOLS_WITHOUT_APP_ID and missing space_id (fail-close)",
                    user_id=user_id,
                    space_id=space_id,
                )
                return (
                    f"权限校验失败: 工具 {tool_name} 缺少 app_id 和 space_id，"
                    f"无法验证执行权限（fail-close 策略）"
                )

        # ── Layer 3-4: space 级校验（始终执行，不受 app_id 有无影响）──

        effective_app_id = app_id if has_app_id else "(no_app_id)"

        # Layer 3 (AC-008): space_id 归属校验
        # 工具参数中的 space_id 须与 Agent 授权的 current_space_id 一致，
        # 防止 LLM 被诱导覆盖 space_id 实现跨 Space 数据访问。
        agent_space_id = params.get("current_space_id")
        tool_space_id = params.get("space_id")
        if (
            tool_space_id
            and agent_space_id
            and str(tool_space_id) != str(agent_space_id)
        ):
            reason = (
                f"tool space_id={tool_space_id} != "
                f"agent current_space_id={agent_space_id}"
            )
            cls._audit(
                tool_name=tool_name,
                app_id=effective_app_id,
                action="DENIED:space_mismatch",
                allowed=False,
                reason=reason,
                user_id=user_id,
                space_id=space_id,
            )
            return (
                f"space_id 不匹配：工具参数 space_id ({tool_space_id}) "
                f"与当前 Agent 授权的 space_id ({agent_space_id}) 不一致"
            )

        # Layer 4 (AC-009): API Token space_ids 约束校验
        # 当 Agent 通过 API Token 发起时，token 的 space_ids 限定了可访问范围，
        # 此处校验工具目标 space 是否在 token 授权范围内。
        api_token_space_ids = params.get("_api_token_space_ids")
        if api_token_space_ids is not None and space_id:
            from apps.tabdata.auth_open_api import check_agent_space_constraint
            token_denied = check_agent_space_constraint(
                api_token_space_ids, space_id,
            )
            if token_denied:
                cls._audit(
                    tool_name=tool_name,
                    app_id=effective_app_id,
                    action="DENIED:token_space_constraint",
                    allowed=False,
                    reason=token_denied,
                    user_id=user_id,
                    space_id=space_id,
                )
                return token_denied

        cls._audit(
            tool_name=tool_name,
            app_id=effective_app_id,
            action="ALLOWED",
            allowed=True,
            user_id=user_id,
            space_id=space_id,
        )
        return None
