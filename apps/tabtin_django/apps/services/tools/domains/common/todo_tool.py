"""
TodoWrite Tool — Agent 待办事项写入工具

让 Agent 创建和更新待办事项列表，用于规划和追踪复杂多步任务的进度。
支持 merge=true 增量合并和 merge=false 全量替换两种模式。
"""

from typing import Any, Dict, List, Literal

from pydantic import BaseModel, Field

from apps.services.tools import BaseTool

TodoStatus = Literal["pending", "in_progress", "completed", "cancelled"]

VALID_STATUSES: set[str] = {"pending", "in_progress", "completed", "cancelled"}

STATUS_ALIASES: dict[str, str] = {
    "todo": "pending",
    "not_started": "pending",
    "open": "pending",
    "new": "pending",
    "doing": "in_progress",
    "working": "in_progress",
    "active": "in_progress",
    "started": "in_progress",
    "done": "completed",
    "finished": "completed",
    "complete": "completed",
    "closed": "completed",
    "resolved": "completed",
    "skip": "cancelled",
    "skipped": "cancelled",
    "removed": "cancelled",
    "dropped": "cancelled",
    "cancel": "cancelled",
}


def _normalize_status(raw: str) -> str:
    """将 LLM 常见的非标状态值归一化为标准枚举。"""
    cleaned = raw.strip().lower().replace("-", "_").replace(" ", "_")
    if cleaned in VALID_STATUSES:
        return cleaned
    return STATUS_ALIASES.get(cleaned, cleaned)


class TodoItem(BaseModel):
    id: str = Field(description="Unique identifier for the TODO item")
    content: str = Field(description="The description/content of the todo item")
    status: str = Field(
        description="The current status: pending | in_progress | completed | cancelled"
    )


class TodoWriteInput(BaseModel):
    merge: bool = Field(
        description=(
            "Whether to merge the todos with the existing todos. "
            "If true, the todos will be merged into the existing todos based on the id field. "
            "You can leave unchanged properties undefined. "
            "If false, the new todos will replace the existing todos."
        )
    )
    todos: List[TodoItem] = Field(
        description="Array of TODO items to update or create",
        min_length=1,
    )


class TodoWriteTool(BaseTool):
    """Updates the todo list for planning and tracking complex multi-step tasks."""

    name: str = "todo_write"
    description: str = (
        "Updates the todo list. Provide a list of todo items, each with an id, content, and status. "
        "Provide merge=true to update existing tasks.\n\n"
        "### Guidelines\n"
        "- At most one task can be in_progress at a time.\n"
        "- Cancel tasks that are no longer needed immediately.\n"
        "- Prefer creating the first todo as in_progress\n"
        "- Batch todo updates with other tool calls in parallel"
    )
    args_schema: type[TodoWriteInput] = TodoWriteInput
    timeout: int = 5
    requires_permission: bool = False
    available_modes: tuple = ("agent", "plan", "study", "group")

    _is_state_writer: bool = True
    _state_key: str = "todos"

    def run(self, merge: bool, todos: List[Dict[str, Any]], **kwargs) -> Dict[str, Any]:
        if not todos:
            return {"success": False, "error": "todos array cannot be empty"}

        normalized: List[Dict[str, str]] = []
        for item in todos:
            if isinstance(item, BaseModel):
                item = item.model_dump()
            raw_status = str(item.get("status", "pending"))
            status = _normalize_status(raw_status)
            if status not in VALID_STATUSES:
                return {
                    "success": False,
                    "error": (
                        f"Invalid status '{raw_status}' for todo '{item.get('id')}'. "
                        f"Must be one of: {', '.join(sorted(VALID_STATUSES))}"
                    ),
                }
            normalized.append({
                "id": str(item.get("id", "")),
                "content": str(item.get("content", "")),
                "status": status,
            })

        in_progress_count = sum(1 for t in normalized if t["status"] == "in_progress")
        if in_progress_count > 1:
            return {
                "success": False,
                "error": f"At most one task can be in_progress at a time (found {in_progress_count})",
            }

        return {
            "success": True,
            "merge": merge,
            "todos": normalized,
            "count": len(normalized),
            "summary": self._build_summary(normalized),
        }

    @staticmethod
    def _build_summary(todos: List[Dict[str, str]]) -> str:
        counts: dict[str, int] = {}
        for t in todos:
            counts[t["status"]] = counts.get(t["status"], 0) + 1
        parts = []
        for s in ("in_progress", "pending", "completed", "cancelled"):
            if counts.get(s):
                parts.append(f"{s}: {counts[s]}")
        return ", ".join(parts)


todo_write_tool = TodoWriteTool()

__all__ = ["TodoWriteTool", "todo_write_tool"]
