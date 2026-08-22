"""
RetrieveToolResultTool — 检索被截断的大型工具结果的完整内容。

当工具输出超过落盘阈值（默认 80K 字符）时，完整结果会被存入
Redis / state fallback，消息中仅保留 head+tail 预览。Agent 可通过
本工具按 tool_call_id（精确）或 tool_name + recency（模糊）回溯
获取完整内容，支持字符/行偏移、grep 搜索。
"""

from __future__ import annotations

import logging
import re
from typing import Annotated, Any, Dict, List, Optional

from pydantic import BaseModel, Field

from apps.services.common.state.injected_state import InjectedState
from apps.services.tools import BaseTool

logger = logging.getLogger(__name__)

_DEFAULT_LIMIT = 45_000
_GREP_CONTEXT_LINES = 3


class RetrieveToolResultInput(BaseModel):
    tool_call_id: Optional[str] = Field(
        default=None,
        description=(
            "The tool_call_id shown in the '[工具结果已存档]' banner. "
            "Preferred for precise retrieval."
        ),
    )
    tool_name: Optional[str] = Field(
        default=None,
        description=(
            "Tool name to search by (e.g. 'run_terminal_command'). "
            "Used with 'recency' when tool_call_id is unavailable."
        ),
    )
    recency: int = Field(
        default=1,
        description="Which match to return when searching by tool_name (1 = most recent).",
    )
    offset: int = Field(
        default=0,
        description="Start position for the returned chunk (0-based). Interpretation depends on 'mode'.",
    )
    limit: int = Field(
        default=_DEFAULT_LIMIT,
        description="Maximum size of the returned chunk. In 'char' mode: characters; in 'line' mode: lines.",
    )
    mode: str = Field(
        default="char",
        description="Pagination mode: 'char' (character offset/limit) or 'line' (line offset/limit).",
    )
    grep: Optional[str] = Field(
        default=None,
        description="Search pattern (plain text or regex). Returns matching lines with surrounding context.",
    )

    # -- InjectedState（对 LLM 不可见，由 ToolExecutor 自动注入） --
    tool_result_store: Annotated[Optional[dict], InjectedState("_tool_result_store")] = Field(
        default=None, description="Auto-injected",
    )
    archived_result_index: Annotated[Optional[list], InjectedState("_archived_result_index")] = Field(
        default=None, description="Auto-injected",
    )
    run_id: Annotated[Optional[str], InjectedState("run_id")] = Field(
        default=None, description="Auto-injected",
    )


class RetrieveToolResultTool(BaseTool):
    name: str = "retrieve_tool_result"
    description: str = (
        "Retrieve the full content of a previously archived (truncated) tool result. "
        "Use when you see '[工具结果已存档]' in a tool response. "
        "Supports precise lookup by tool_call_id, fuzzy lookup by tool_name + recency, "
        "character/line pagination, and grep search."
    )
    risk_level: str = "safe"
    requires_permission: bool = False
    timeout: int = 15
    args_schema: type[RetrieveToolResultInput] = RetrieveToolResultInput

    def run(
        self,
        tool_call_id: Optional[str] = None,
        tool_name: Optional[str] = None,
        recency: int = 1,
        offset: int = 0,
        limit: int = _DEFAULT_LIMIT,
        mode: str = "char",
        grep: Optional[str] = None,
        tool_result_store: Optional[dict] = None,
        archived_result_index: Optional[list] = None,
        run_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        from apps.services.common.tool_result_storage import (
            get_persisted_result,
            get_persisted_result_by_name,
        )

        state_proxy: dict = {
            "_tool_result_store": tool_result_store or {},
            "_archived_result_index": archived_result_index or [],
            "run_id": run_id or "",
        }

        result: Optional[str] = None
        resolved_id: str = ""

        if tool_call_id:
            resolved_id = tool_call_id
            result = get_persisted_result(
                tool_call_id=tool_call_id,
                state=state_proxy,
                run_id=run_id or "",
            )
        elif tool_name:
            result = get_persisted_result_by_name(
                tool_name=tool_name,
                recency=recency,
                state=state_proxy,
                run_id=run_id or "",
            )
            if result is not None:
                index = state_proxy.get("_archived_result_index", [])
                matches = [
                    e for e in reversed(index)
                    if e.get("tool_name") == tool_name
                ]
                if recency >= 1 and recency <= len(matches):
                    resolved_id = matches[recency - 1].get("tool_call_id", "")
        else:
            return {
                "success": False,
                "error": "请提供 tool_call_id 或 tool_name 参数。",
            }

        if result is None:
            return {
                "success": False,
                "error": "结果已过期或不存在。请重新执行原始命令。",
            }

        total_chars = len(result)

        if grep:
            return self._grep_result(result, grep, total_chars, resolved_id)

        if mode == "line":
            return self._slice_lines(result, offset, limit, total_chars, resolved_id)

        return self._slice_chars(result, offset, limit, total_chars, resolved_id)

    # ------------------------------------------------------------------
    # 内部分片方法
    # ------------------------------------------------------------------

    @staticmethod
    def _slice_chars(
        content: str, offset: int, limit: int, total: int, tool_call_id: str,
    ) -> Dict[str, Any]:
        chunk = content[offset: offset + limit]
        has_more = total > offset + limit
        return {
            "success": True,
            "content": chunk,
            "tool_call_id": tool_call_id,
            "total_chars": total,
            "offset": offset,
            "length": len(chunk),
            "has_more": has_more,
        }

    @staticmethod
    def _slice_lines(
        content: str, offset: int, limit: int, total_chars: int, tool_call_id: str,
    ) -> Dict[str, Any]:
        lines = content.split("\n")
        total_lines = len(lines)
        selected = lines[offset: offset + limit]
        chunk = "\n".join(selected)
        has_more = total_lines > offset + limit
        return {
            "success": True,
            "content": chunk,
            "tool_call_id": tool_call_id,
            "total_chars": total_chars,
            "total_lines": total_lines,
            "offset": offset,
            "lines_returned": len(selected),
            "has_more": has_more,
        }

    @staticmethod
    def _grep_result(
        content: str, pattern: str, total_chars: int, tool_call_id: str,
    ) -> Dict[str, Any]:
        lines = content.split("\n")
        try:
            compiled = re.compile(pattern)
        except re.error:
            compiled = re.compile(re.escape(pattern))

        hit_indices: List[int] = [
            i for i, line in enumerate(lines) if compiled.search(line)
        ]

        if not hit_indices:
            return {
                "success": True,
                "content": "",
                "tool_call_id": tool_call_id,
                "total_chars": total_chars,
                "matches": 0,
                "message": f"未找到匹配 '{pattern}' 的行。",
            }

        context = _GREP_CONTEXT_LINES
        included: set = set()
        for idx in hit_indices:
            for j in range(max(0, idx - context), min(len(lines), idx + context + 1)):
                included.add(j)

        output_lines: List[str] = []
        prev = -2
        for idx in sorted(included):
            if idx > prev + 1:
                output_lines.append("---")
            prefix = ">" if idx in hit_indices else " "
            output_lines.append(f"{prefix} {idx + 1}: {lines[idx]}")
            prev = idx

        chunk = "\n".join(output_lines)
        return {
            "success": True,
            "content": chunk,
            "tool_call_id": tool_call_id,
            "total_chars": total_chars,
            "matches": len(hit_indices),
        }


__all__ = ["RetrieveToolResultTool"]
