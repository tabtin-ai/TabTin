"""
services.tools — 工具基础设施 + 域实现统一入口

提供 BaseTool / ToolHub / TraceableBaseTool 等核心工具基类和注册表。
Agent 引擎（apps.services.agent_engine）通过回调注入 trace、权限、
路由等运行时能力；本包 import-time 不依赖引擎层。

包导入时不触发工具注册，减少循环依赖风险。

目录结构:
  - services.tools.base / hub / traceable / client — Layer 0/1 基础设施
  - services.tools.domains/ — 所有域工具实现（Wave 9a 从原 orchestration.tools 迁入）

历史兼容:
  - W10e 前存在的 apps.orchestration.tools re-export shim 已于 2026-04-17
    随 orchestration 极简化一并删除；所有调用方现在直接从
    ``apps.services.tools`` / ``apps.services.tools.domains`` 导入。

re-export 策略:
  - Layer 0/1 的基类和注册表直接从 services.tools 子模块加载
  - action-tools manifest / registry / device 权限表等函数通过
    lazy import 从 services.tools.domains 加载
"""

__all__ = [
    # Layer 0 — 协议 & 元数据
    "ToolProtocol",
    "ToolRegistryProtocol",
    "ToolMetadata",
    # Layer 1 — 基类
    "TraceableBaseTool",
    "BaseTool",
    "ClientTool",
    "HybridTool",
    "AgentClientTool",
    "FrontendActionTool",
    # Layer 1 — 注册表
    "ToolHub",
    # 工具超时
    "resolve_tool_timeout",
    # ContextVar API
    "set_tool_authorization_rules",
    "set_tool_permission_decisions",
    "set_subagent_deny_tools",
    "reset_tool_permission_context",
    # re-export: action-tools manifest
    "load_action_tool_manifest",
    "refresh_action_tool_manifest",
    "get_action_tool_manifest",
    "get_tool_capability_map",
    # re-export: action-tools registry
    "get_all_action_tools",
    "refresh_manifest_tools",
    # re-export: device tool permission map
    "get_tool_permission_map",
    # re-export: shared utilities
    "invalidate_user_cache",
    # bootstrap helper
    "ensure_builtin_tools_registered",
]


def __getattr__(name: str):
    _g = globals()

    if name in ("ToolProtocol", "ToolRegistryProtocol"):
        from apps.services.tools.protocol import ToolProtocol, ToolRegistryProtocol
        _g["ToolProtocol"] = ToolProtocol
        _g["ToolRegistryProtocol"] = ToolRegistryProtocol
        return _g[name]

    if name == "ToolMetadata":
        from apps.services.tools.metadata import ToolMetadata
        _g["ToolMetadata"] = ToolMetadata
        return ToolMetadata

    if name == "TraceableBaseTool":
        from apps.services.tools.traceable import TraceableBaseTool
        _g["TraceableBaseTool"] = TraceableBaseTool
        return TraceableBaseTool

    if name in ("BaseTool", "ClientTool", "HybridTool",
                 "set_tool_authorization_rules", "set_tool_permission_decisions",
                 "set_subagent_deny_tools", "reset_tool_permission_context"):
        from apps.services.tools import base as _base
        for _n in ("BaseTool", "ClientTool", "HybridTool",
                    "set_tool_authorization_rules", "set_tool_permission_decisions",
                    "set_subagent_deny_tools", "reset_tool_permission_context"):
            _g[_n] = getattr(_base, _n)
        return _g[name]

    if name in ("AgentClientTool", "FrontendActionTool"):
        from apps.services.tools.client import AgentClientTool, FrontendActionTool
        _g["AgentClientTool"] = AgentClientTool
        _g["FrontendActionTool"] = FrontendActionTool
        return _g[name]

    if name == "ToolHub":
        from apps.services.tools.hub import ToolHub
        _g["ToolHub"] = ToolHub
        return ToolHub

    if name == "resolve_tool_timeout":
        from apps.services.tools.timeout import resolve_tool_timeout
        _g["resolve_tool_timeout"] = resolve_tool_timeout
        return resolve_tool_timeout

    # ── re-export: action-tools manifest ──
    if name in ("load_action_tool_manifest", "refresh_action_tool_manifest",
                "get_action_tool_manifest", "get_tool_capability_map"):
        from apps.services.tools.domains.action_tool_manifest import (
            load_action_tool_manifest,
            refresh_action_tool_manifest,
            get_action_tool_manifest,
            get_tool_capability_map,
        )
        _g["load_action_tool_manifest"] = load_action_tool_manifest
        _g["refresh_action_tool_manifest"] = refresh_action_tool_manifest
        _g["get_action_tool_manifest"] = get_action_tool_manifest
        _g["get_tool_capability_map"] = get_tool_capability_map
        return _g[name]

    # ── re-export: action-tools registry ──
    if name in ("get_all_action_tools", "refresh_manifest_tools"):
        from apps.services.tools.domains.action_tool_registry import (
            get_all_action_tools,
            refresh_manifest_tools,
        )
        _g["get_all_action_tools"] = get_all_action_tools
        _g["refresh_manifest_tools"] = refresh_manifest_tools
        return _g[name]

    # ── re-export: device tool permission map ──
    if name == "get_tool_permission_map":
        from apps.services.tools.domains.device.tool_registry import get_tool_permission_map
        _g["get_tool_permission_map"] = get_tool_permission_map
        return get_tool_permission_map

    # ── re-export: shared utilities ──
    if name == "invalidate_user_cache":
        from apps.services.tools.domains._shared import invalidate_user_cache
        _g["invalidate_user_cache"] = invalidate_user_cache
        return invalidate_user_cache

    # ── bootstrap: import the domains.registry shim ──
    if name == "ensure_builtin_tools_registered":
        def ensure_builtin_tools_registered():
            """Import the (now no-op) domain registry shim.

            W6 (2026-05-04): historically this triggered registration of
            ~25 builtin tool domains into ToolHub. After ToolHub retirement
            this is a no-op kept solely to avoid AttributeError at legacy
            call sites; it imports the shim once for any future side
            effects but no providers are registered.
            """
            import apps.services.tools.domains.registry  # noqa: F401
        _g["ensure_builtin_tools_registered"] = ensure_builtin_tools_registered
        return ensure_builtin_tools_registered

    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__():
    return sorted(list(globals().keys()) + __all__)
