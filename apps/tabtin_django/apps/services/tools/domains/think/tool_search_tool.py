"""S19: tool_search — 按关键词搜索可用工具。

当工具数量很多时，部分专用 FC 工具（headless 浏览器、SQL、MCP 等）
不在初始 schema 中注册。Agent 通过 tool_search 按需发现并加载它们。

注：W5（2026-05-04）后业务能力（browser / slide / doc / memo / table / video 等）
已收敛到 `tabtin <command>` CLI，通过 run_terminal_command 调用，不再走 FC，
也不通过本工具发现——参见 `tabtin commands`。

搜索结果通过 state["_pending_tool_activations"] 激活，
由 NativeReactLoop._flush_pending_tool_activations 消费后
委托 DynamicToolManager.activate 将完整 schema 注入当前会话。
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional, Type

from langchain_core.tools import InjectedToolArg
from pydantic import BaseModel, Field
from typing_extensions import Annotated

from apps.services.tools import BaseTool
from apps.services.tools.error_envelope import json_tool_error

logger = logging.getLogger(__name__)

MAX_SEARCH_RESULTS = 10


class ToolSearchInput(BaseModel):
    """tool_search 参数定义。"""

    query: str = Field(
        description=(
            "Search keyword(s) to find specialized FC tools (e.g. headless browser, "
            "SQL, MCP server tools). Can be a tool name fragment, capability keyword, "
            "or description term. For TabTin business capabilities (browser / slide / "
            "doc / memo / table / video) use `tabtin commands` via run_terminal_command."
        ),
    )
    state: Annotated[dict, InjectedToolArg] = Field(
        default_factory=dict,
        description="Injected agent state (not user-facing).",
    )


class ToolSearchTool(BaseTool):
    """搜索延迟加载工具并激活匹配结果。"""

    category: str = "search"
    name: str = "tool_search"
    description: str = (
        "Search for available FC tools by keyword. "
        "Use this when you need a specialized FC tool that isn't in your current tool list "
        "(e.g. specialized headless / SQL / MCP server tools). "
        "Returns matching tool names and descriptions, "
        "and automatically makes them available for your next action. "
        "Note: TabTin business capabilities (browser / slide / doc / memo / table / video) "
        "are CLI commands accessed via `tabtin commands` + run_terminal_command, not FC tools."
    )
    args_schema: Type[BaseModel] = ToolSearchInput
    risk_level: str = "safe"  # type: ignore[assignment]

    deferred_registry: Dict[str, str] = Field(
        default_factory=dict,
        description="Deferred tool registry: {name: description}",
    )

    def run(self, query: str = "", state: Optional[dict] = None, **kwargs) -> Any:
        query = (query or "").strip().lower()
        if not query:
            return json_tool_error(
                "query is required",
                error_kind="missing_required_param",
                hint="Provide a keyword (tool name fragment or capability term) for tool_search.",
                retryable=False,
            )

        matches = self._search(query)

        if not matches:
            return json.dumps(
                {
                    "success": True,
                    "results": [],
                    "message": f"No tools found matching '{query}'.",
                },
                ensure_ascii=False,
            )

        matched_names = [m["name"] for m in matches]

        if isinstance(state, dict):
            from apps.services.agent_engine.state.state_types import get_dyn_tools
            dyn_pending = get_dyn_tools(state).pending_activations
            for name in matched_names:
                if name not in dyn_pending:
                    dyn_pending.append(name)
            logger.info(
                "[ToolSearch] Activated %d tools for query '%s': %s",
                len(matched_names),
                query,
                matched_names,
            )

        return json.dumps(
            {
                "success": True,
                "results": matches,
                "message": (
                    f"Found {len(matches)} tool(s). "
                    "They are now available for your next action."
                ),
            },
            ensure_ascii=False,
        )

    def _search(self, query: str) -> List[Dict[str, str]]:
        """匹配逻辑：query 中每个词都出现在工具名或描述中（AND 语义）。"""
        keywords = query.split()
        if not keywords:
            return []

        results: List[Dict[str, str]] = []
        for name, desc in self.deferred_registry.items():
            haystack = f"{name} {desc}".lower()
            if all(kw in haystack for kw in keywords):
                results.append({"name": name, "description": desc})
            if len(results) >= MAX_SEARCH_RESULTS:
                break
        return results

    def set_deferred_registry(self, registry: Dict[str, str]) -> None:
        """运行时更新延迟工具注册表（由 NativeReactLoop 调用）。"""
        object.__setattr__(self, "deferred_registry", dict(registry))


tool_search_tool = ToolSearchTool()
