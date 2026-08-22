"""
Action result schema (WS-first).

HTTP action-result endpoint has been removed; use WS message:
`agent.action.result`。
"""

from typing import Optional

from ninja import Schema
from pydantic import Field


class ActionResultSchema(Schema):
    """动作执行结果"""
    success: bool
    trace_id: Optional[str] = None
    clean_html: Optional[str] = None
    skeleton_html: Optional[str] = None  # 可选：骨架 HTML
    title: Optional[str] = None
    url: Optional[str] = None
    content_length: Optional[int] = None  # 可选：内容长度
    error: Optional[str] = None
    error_code: Optional[str] = None
    data: Optional[dict] = None  # ✅ 新增：支持嵌套数据（如 snapshot）

    # 🔥 Browser execute_act 专用字段
    executed_actions: Optional[list] = None
    frontend_execution_time_ms: Optional[int] = None
    page_url: Optional[str] = None
    page_title: Optional[str] = None
    snapshot: Optional[dict] = None
    diff: Optional[dict] = None
    screenshot_base64: Optional[str] = None  # 🔥 新增：Act 执行后的截图（v1.2）

    # 🔥 ObserveNode 专用字段
    observed_elements: Optional[list] = None

    # EF-23: truncateResult() 添加的截断标记。
    # Pydantic v2 不支持 _ 开头的字段名，必须用 alias 绕过。
    truncated: Optional[bool] = Field(None, alias='_truncated')
