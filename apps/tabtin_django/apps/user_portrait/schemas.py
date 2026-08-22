"""
User Portrait API Schema 定义（v0.2 per-Organization）。

请求/响应 schema，使用 Pydantic（通过 ninja 集成）。
"""

from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from ninja import Schema


class PortraitOut(Schema):
    """画像详情响应（GET /me/{organization_id}）。"""

    id: str
    user_id: str
    organization_id: str
    agent_id: str = ""
    content_md: str
    version: int
    last_distilled_at: Optional[datetime] = None
    last_distill_status: str
    last_distill_error: str = ""
    pending_hints_count: int = 0
    # /#4118 门控：记忆总闸关闭时 content_md 恒空，前端据此判断"这份画像
    # 是否真的空"还是"总闸关闭看不到"，避免误以为 Agent 从未生成过任何内容。
    memory_enabled: bool = True
    created_at: datetime
    updated_at: datetime


class HintSubmitRequest(Schema):
    """提交 hint（POST /me/{organization_id}/hint）。"""

    text: str


class DistillTriggerRequest(Schema):
    """主动触发蒸馏（POST /me/{organization_id}/distill）。"""

    # 保留为空——后续可加 force / model_override 等参数
    pass


class SnapshotOut(Schema):
    """画像历史快照（GET /me/{organization_id}/snapshots）。"""

    id: str
    version_at_snapshot: int
    content_md: str
    trigger_reason: str
    input_summary: dict
    created_at: datetime


class SnapshotListOut(Schema):
    items: List[SnapshotOut]
    count: int
