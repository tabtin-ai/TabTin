"""
Action Tools Registry (manifest-based)

Builds frontend proxy tools from action-tools manifest.json.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field, create_model, ConfigDict

from apps.services.tools.client import AgentClientTool
from apps.services.agent_engine.agents.subagent.policy import filter_subagent_tools
from apps.services.tools.domains.action_tool_manifest import (
    load_action_tool_manifest,
    refresh_action_tool_manifest,
)

logger = logging.getLogger(__name__)


class _ManifestInput(BaseModel):
    model_config = ConfigDict(extra="allow")


_MAX_SCHEMA_DEPTH = 10


def _resolve_schema_type(
    schema: Dict[str, Any],
    *,
    parent_name: str = "",
    field_name: str = "",
    _depth: int = 0,
) -> Any:
    if _depth > _MAX_SCHEMA_DEPTH:
        logger.warning(
            "[ActionToolsRegistry] Schema nesting depth exceeded limit (>%d) at %s.%s, "
            "falling back to Dict[str, Any]",
            _MAX_SCHEMA_DEPTH, parent_name, field_name,
        )
        return Dict[str, Any]

    enum_values = schema.get("enum")
    if enum_values and isinstance(enum_values, list):
        str_values = [v for v in enum_values if isinstance(v, str)]
        if str_values:
            return Literal[tuple(str_values)]

    schema_type = schema.get("type")
    if isinstance(schema_type, list):
        if "null" in schema_type:
            schema_type = next((item for item in schema_type if item != "null"), None)
        else:
            schema_type = schema_type[0] if schema_type else None

    if schema_type == "string":
        return str
    if schema_type == "number":
        return float
    if schema_type == "integer":
        return int
    if schema_type == "boolean":
        return bool
    if schema_type == "array":
        items = schema.get("items") or {}
        item_type = (
            _resolve_schema_type(
                items,
                parent_name=parent_name,
                field_name=f"{field_name}_item" if field_name else "item",
                _depth=_depth + 1,
            )
            if isinstance(items, dict)
            else Any
        )
        return List[item_type]
    if schema_type == "object":
        if schema.get("properties") and parent_name and field_name:
            return _build_nested_model(parent_name, field_name, schema, _depth=_depth + 1)
        return Dict[str, Any]
    return Any


def _build_model_from_properties(
    model_name: str,
    schema: Dict[str, Any],
    parent_name: str = "",
    _depth: int = 0,
) -> type[BaseModel]:
    """从 JSON Schema properties 构建 Pydantic model（共享核心逻辑）。"""
    properties = schema.get("properties") or {}
    required = set(schema.get("required") or [])
    fields: Dict[str, Any] = {}

    for fname, fschema in properties.items():
        fschema = fschema or {}
        if fschema.get("internal"):
            continue
        ftype = _resolve_schema_type(
            fschema, parent_name=parent_name, field_name=fname, _depth=_depth,
        )
        is_required = fname in required
        default_value = fschema.get("default", ...)
        if not is_required:
            if default_value is ...:
                default_value = None
            ftype = Optional[ftype]
        fields[fname] = (
            ftype,
            Field(default=default_value, description=fschema.get("description")),
        )

    if not fields:
        return create_model(model_name, __base__=_ManifestInput)
    return create_model(model_name, __base__=_ManifestInput, **fields)


def _build_nested_model(
    parent_name: str, field_name: str, schema: Dict[str, Any], *, _depth: int = 0,
) -> type[BaseModel]:
    safe = "".join(
        w.capitalize() for w in field_name.replace("-", "_").split("_") if w
    )
    model_name = f"{parent_name}_{safe}"
    return _build_model_from_properties(
        model_name, schema, parent_name=model_name, _depth=_depth,
    )


def _build_args_schema(tool_name: str, parameters: Dict[str, Any]) -> type[BaseModel]:
    return _build_model_from_properties(
        f"{tool_name}Input", parameters, parent_name=tool_name,
    )


# TS 侧 riskLevel 声明优先（_resolve_manifest_risk_level 第一优先级）。
# 此字典仅作为紧急覆写的逃生舱：当某工具的 TS 声明缺失或错误时，可在此
# 硬编码 override。正常情况下保持为空，所有风险等级应在前端 manifest 声明。
_MANIFEST_RISK_LEVELS: Dict[str, str] = {}


_RISK_NORMALIZE = {"dangerous": "strict"}
_VALID_RISKS = frozenset({"safe", "review", "strict"})


def _resolve_manifest_risk_level(
    tool_name: str,
    declared_risk: str | None = None,
) -> str:
    """声明式优先：manifest riskLevel > 硬编码字典 > 默认 review"""
    # 1) 开发者在前端 TypeScript 中声明的 riskLevel
    if declared_risk:
        normalized = _RISK_NORMALIZE.get(declared_risk, declared_risk)
        if normalized in _VALID_RISKS:
            return normalized
        logger.warning(
            "[ActionToolsRegistry] Tool %s declared invalid riskLevel=%r, falling back to dict",
            tool_name, declared_risk,
        )
    # 2) 硬编码字典（历史兼容 / 安全兜底）
    if tool_name in _MANIFEST_RISK_LEVELS:
        return _MANIFEST_RISK_LEVELS[tool_name]
    # 3) 默认
    return "review"


def _build_manifest_tool(tool_meta: Dict[str, Any]) -> AgentClientTool:
    tool_name = tool_meta.get("name", "unknown_tool")
    tool_description = tool_meta.get("description", "")
    parameters = tool_meta.get("parameters") or {}
    tool_args_schema = _build_args_schema(tool_name, parameters)
    resolved_risk = _resolve_manifest_risk_level(
        tool_name, declared_risk=tool_meta.get("riskLevel"),
    )

    resolved_modes = None if resolved_risk == "safe" else ("agent",)

    tool_headless = tool_meta.get("headless", True)

    class ManifestActionTool(AgentClientTool):
        name: str = tool_name
        description: str = tool_description
        timeout: int = 0
        category: Optional[str] = tool_meta.get("category")
        risk_level: str = resolved_risk
        requires_permission: bool = True
        args_schema: type[BaseModel] = tool_args_schema
        app_id: str = tool_meta.get("appId", "unknown")
        tags: List[str] = tool_meta.get("tags") or []
        optional: bool = bool(tool_meta.get("optional"))
        available_modes: tuple | None = resolved_modes
        headless: bool = tool_headless

        def run(self, **kwargs) -> Any:  # type: ignore[override]
            return self.execute(**kwargs)

    return ManifestActionTool()


_MANIFEST_TOOLS: List[AgentClientTool] | None = None
_MANIFEST_LOAD_ERROR: str | None = None


def _check_cross_domain_name_collisions(action_tool_names: set) -> None:
    """惰性校验：action-tools 工具名是否与后端 ToolHub 工具重名。"""
    try:
        from apps.services.tools import ToolHub
        backend_names = set()
        for domain in ToolHub.list_domains():
            if domain == "action-tools":
                continue
            for tool in ToolHub.get_tools(domain):
                name = getattr(tool, "name", None) or getattr(tool, "tool_name", None)
                if name:
                    backend_names.add(name)
        collisions = action_tool_names & backend_names
        if collisions:
            logger.warning(
                "[ActionToolsRegistry] action-tools have name collisions with backend domains, "
                "may cause execution ambiguity: %s",
                sorted(collisions),
            )
    except Exception as e:
        logger.debug("[ActionToolsRegistry] Cross-domain name collision check skipped: %s", e)


def _ensure_manifest_tools_loaded() -> None:
    global _MANIFEST_TOOLS, _MANIFEST_LOAD_ERROR
    if _MANIFEST_TOOLS is not None:
        return

    manifest = load_action_tool_manifest()
    error = manifest.get("error")
    manifest_path = manifest.get("path", "unknown")

    if error:
        _MANIFEST_LOAD_ERROR = error
        logger.warning(
            "[ActionToolsRegistry] Manifest load failed: %s (path=%s)",
            error,
            manifest_path
        )

    tools_meta = manifest.get("tools") or []
    built_tools: List[AgentClientTool] = []
    seen_names = set()
    for tool_meta in tools_meta:
        if not isinstance(tool_meta, dict):
            continue
        tool_name = tool_meta.get("name")
        if not isinstance(tool_name, str) or not tool_name.strip():
            logger.warning("[ActionToolsRegistry] Skipping invalid tool name: %s", tool_meta)
            continue
        if tool_name in seen_names:
            logger.warning("[ActionToolsRegistry] Duplicate tool name skipped: %s", tool_name)
            continue
        seen_names.add(tool_name)
        try:
            built_tools.append(_build_manifest_tool(tool_meta))
        except Exception as exc:
            logger.warning(
                "[ActionToolsRegistry] Failed to build tool %r, skipping: %s",
                tool_name, exc,
            )
            continue
    _MANIFEST_TOOLS = built_tools

    if not _MANIFEST_TOOLS:
        logger.warning(
            "[ActionToolsRegistry] Manifest tool list is empty (path=%s, error=%s). "
            "Make sure to run 'pnpm -C packages/action-tools build && pnpm -C packages/action-tools export-manifest'",
            manifest_path,
            error
        )
    else:
        logger.info(
            "[ActionToolsRegistry] Loaded %d tools (path=%s)",
            len(_MANIFEST_TOOLS),
            manifest_path
        )
        _check_cross_domain_name_collisions(seen_names)


def get_all_action_tools(
    app_ids: Optional[List[str]] = None,
    optional_tool_allowlist: Optional[Dict[str, Any]] = None,
    runtime_type: Optional[str] = None,
) -> List[AgentClientTool]:
    """
    获取前端 action-tools 工具列表（来源：action-tools/manifest.json）

    Args:
        app_ids: 允许的 app ID 列表
            - None: 返回所有工具（不过滤）
            - []: 返回空列表（用户禁用所有工具）
            - ['browser', 'terminal']: 只返回指定 app 的工具
        optional_tool_allowlist: 可选工具白名单（用于过滤 optional=true 的工具）
        runtime_type: 客户端运行时类型（electron/daemon/server/web/mobile）
            - 'electron': 返回所有工具（含 GUI-only）
            - 其他值: 排除 headless=False 的 GUI-only 工具

    Returns:
        过滤后的工具列表
    """
    _ensure_manifest_tools_loaded()

    all_tools = _MANIFEST_TOOLS or []

    if not all_tools and _MANIFEST_LOAD_ERROR:
        logger.warning(
            "[ActionToolsRegistry] Tool list is empty, manifest load error: %s",
            _MANIFEST_LOAD_ERROR,
        )

    # None 表示不过滤，返回所有工具
    if app_ids is None:
        tools = _filter_optional_tools(all_tools, optional_tool_allowlist)
        tools = _filter_headless_tools(tools, runtime_type)
        return filter_subagent_tools(tools)

    # 空列表表示用户禁用了所有工具
    if not app_ids:
        logger.debug("[ActionToolsRegistry] app_ids is empty, returning empty tool list")
        return []

    # 按 app_ids 过滤
    allowed = {app_id for app_id in app_ids if app_id}
    filtered = [
        tool for tool in all_tools
        if getattr(tool, "app_id", None) in allowed
    ]
    filtered = _filter_optional_tools(filtered, optional_tool_allowlist)
    filtered = _filter_headless_tools(filtered, runtime_type)

    logger.debug(
        "[ActionToolsRegistry] Filtered tools: app_ids=%s, runtime_type=%s, result=%d/%d",
        allowed, runtime_type, len(filtered), len(all_tools),
    )

    return filter_subagent_tools(filtered)


def _filter_optional_tools(
    tools: List[AgentClientTool],
    allowlist: Optional[Dict[str, Any]] = None,
) -> List[AgentClientTool]:
    """过滤 optional 标记的工具——仅白名单内的才保留"""
    if not any(getattr(t, "optional", False) for t in tools):
        return tools
    try:
        from apps.services.tools.domains.optional_tools import is_optional_tool_allowed
    except ImportError:
        # optional_tools 不可用时，保留所有非 optional 工具
        return [t for t in tools if not getattr(t, "optional", False)]
    return [
        tool for tool in tools
        if not getattr(tool, "optional", False)
        or is_optional_tool_allowed(
            getattr(tool, "name", None),
            getattr(tool, "app_id", None),
            allowlist=allowlist,
            audit=True,
        )
    ]


def _filter_headless_tools(
    tools: List[AgentClientTool],
    runtime_type: Optional[str] = None,
) -> List[AgentClientTool]:
    """非 Electron 运行时排除 headless=False 的 GUI-only 工具。"""
    if not runtime_type or runtime_type == "electron":
        return tools
    before = len(tools)
    result = [
        t for t in tools
        if getattr(t, "headless", True) is not False
    ]
    excluded = before - len(result)
    if excluded:
        logger.info(
            "[ActionToolsRegistry] Excluded %d GUI-only tools for runtime_type=%s",
            excluded, runtime_type,
        )
    return result


def get_tool_by_name(tool_name: str) -> Optional[AgentClientTool]:
    _ensure_manifest_tools_loaded()
    for tool in _MANIFEST_TOOLS or []:
        if tool.tool_name == tool_name:
            return tool
    return None


def refresh_manifest_tools() -> None:
    """串联清除三层缓存（LRU → _MANIFEST_TOOLS → ToolHub），下次获取时重新构建。"""
    global _MANIFEST_TOOLS, _MANIFEST_LOAD_ERROR
    _MANIFEST_TOOLS = None
    _MANIFEST_LOAD_ERROR = None
    refresh_action_tool_manifest()
    try:
        from apps.services.common.device_capability_registry import refresh_tool_capability_map
        refresh_tool_capability_map()
    except ValueError:
        raise
    except Exception as exc:
        logger.warning(
            "[ActionToolsRegistry] Failed to refresh tool capability map cache: %s",
            exc,
            exc_info=True,
        )
    from apps.services.tools import ToolHub
    ToolHub.clear_cache()


__all__ = ["get_all_action_tools", "get_tool_by_name", "refresh_manifest_tools"]
