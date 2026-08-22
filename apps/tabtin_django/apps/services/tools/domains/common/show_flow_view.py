"""聊天原生层级流程视图；复用 widget 富内容契约以兼容旧客户端。"""

import html
import json
import secrets
import time
from collections import defaultdict
from typing import Annotated, Any, Literal, Optional

from pydantic import BaseModel, Field, model_validator

from apps.services.tools import BaseTool

try:
    from langchain_core.tools.base import InjectedToolCallId
except Exception:  # pragma: no cover
    class InjectedToolCallId:  # type: ignore[no-redef]
        pass


SHOW_FLOW_VIEW_TOOL_NAME = "show_flow_view"
FlowStatus = Literal["pending", "active", "complete", "blocked", "skipped"]


class FlowViewNode(BaseModel):
    id: str = Field(..., min_length=1, max_length=120)
    parent_id: Optional[str] = Field(None, max_length=120)
    label: str = Field(..., min_length=1, max_length=240)
    detail: Optional[str] = Field(None, max_length=2000)
    status: FlowStatus = "pending"


class ShowFlowViewInput(BaseModel):
    # 字段顺序是流式产品契约：进度与标题先出现，nodes 后续逐个完整到达。
    loading_message: Optional[str] = Field(None, max_length=240)
    title: str = Field(..., min_length=1, max_length=240)
    summary: str = Field(..., min_length=1, max_length=500)
    nodes: list[FlowViewNode] = Field(..., min_length=1, max_length=100)
    tool_call_id: Annotated[Optional[str], InjectedToolCallId()] = None

    @model_validator(mode="after")
    def validate_graph(self) -> "ShowFlowViewInput":
        ids = [node.id for node in self.nodes]
        if len(ids) != len(set(ids)):
            raise ValueError("duplicate node id")
        by_id = {node.id: node for node in self.nodes}
        for node in self.nodes:
            if node.parent_id and node.parent_id not in by_id:
                raise ValueError(f"missing parent node: {node.parent_id}")
            seen = {node.id}
            parent_id = node.parent_id
            while parent_id:
                if parent_id in seen:
                    raise ValueError(f"cycle detected at node: {node.id}")
                seen.add(parent_id)
                parent_id = by_id[parent_id].parent_id
        positions = {node.id: index for index, node in enumerate(self.nodes)}
        for index, node in enumerate(self.nodes):
            if node.parent_id and positions[node.parent_id] >= index:
                raise ValueError(
                    f"parent node must appear before child: {node.id}"
                )
        return self


def _widget_id() -> str:
    return f"flow_{int(time.time() * 1000):x}_{secrets.token_hex(3)}"


def _fallback_html(title: str, nodes: list[FlowViewNode]) -> str:
    children: dict[Optional[str], list[FlowViewNode]] = defaultdict(list)
    for node in nodes:
        children[node.parent_id].append(node)

    def render(parent_id: Optional[str] = None) -> str:
        siblings = children.get(parent_id, [])
        if not siblings:
            return ""
        items = []
        for node in siblings:
            detail = f"<p>{html.escape(node.detail)}</p>" if node.detail else ""
            items.append(
                f"<li><strong>{html.escape(node.label)}</strong>"
                f"{detail}{render(node.id)}</li>"
            )
        return f"<ol>{''.join(items)}</ol>"

    return f"<section><h3>{html.escape(title)}</h3>{render()}</section>"


class ShowFlowViewTool(BaseTool):
    """已弃用的兼容工具；不得重新注册到 Agent Chat 通用工具表。"""

    name: str = SHOW_FLOW_VIEW_TOOL_NAME
    description: str = (
        "已弃用的 Flow View 兼容工具，仅为旧调用方保留；不得注册到 Agent Chat 通用工具表。"
        "新的飞书画板流程随 TabDoc 导入并显示为静态文本树。"
    )
    execution_mode: str = "server"
    # 展示与持久化有副作用，不能标 safe 后进入参数尚未完成的预执行路径。
    risk_level: str = "medium"
    required_permissions: list[str] = []
    timeout: int = 30
    args_schema: type[ShowFlowViewInput] = ShowFlowViewInput

    def run(self, **kwargs: Any) -> str:
        params = ShowFlowViewInput.model_validate(kwargs)
        widget_id = _widget_id()
        nodes = [node.model_dump(exclude_none=True) for node in params.nodes]
        block: dict[str, Any] = {
            "type": "rich_content",
            "kind": "widget",
            "summary": params.summary,
            "widget_id": widget_id,
            "widget_variant": "flow_view",
            "format": "html",
            "code": _fallback_html(params.title, params.nodes),
            "flow_view": {"version": 1, "title": params.title, "nodes": nodes},
        }
        if params.loading_message:
            block["loading_message"] = params.loading_message
        if params.tool_call_id:
            block["tool_call_id"] = params.tool_call_id
        return json.dumps({
            "success": True,
            "widget_id": widget_id,
            "summary": params.summary,
            "_block": block,
            "__llm_strip__": ["_block"],
        }, ensure_ascii=False)


__all__ = [
    "FlowViewNode",
    "ShowFlowViewInput",
    "ShowFlowViewTool",
    "SHOW_FLOW_VIEW_TOOL_NAME",
]
