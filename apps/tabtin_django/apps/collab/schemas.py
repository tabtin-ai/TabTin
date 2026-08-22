"""
Collab API 请求/响应 Schema

基于 django-ninja 的 Schema 定义。
"""
from datetime import datetime
from typing import Any, Optional
from uuid import UUID

from ninja import Schema


# ── 请求 ──────────────────────────────────────────────

class CollabPersistRequest(Schema):
    """collab-persist 通用请求体。changes 的内部结构由各模块 adapter 定义。"""
    changes: dict
    op_id: str = ""
    editor_type: str = "user"
    editor_id: str = ""
    editor_name: str = ""
    agent_run_id: str = ""
    system_policy: str = ""
    skip_version_history: bool = False


class CollabApplyOpsRequest(Schema):
    """Y.Doc-first apply-ops command request."""
    resource_type: str
    document_name: str
    op_id: str
    ops: list[dict]
    origin_id: str = ""
    editor_type: str = ""
    editor_id: str = ""
    editor_name: str = ""
    agent_run_id: str = ""
    system_policy: str = ""


class CreateNamedVersionRequest(Schema):
    name: str


class RenameVersionRequest(Schema):
    name: str


class TogglePinRequest(Schema):
    pinned: bool


class RestoreVersionRequest(Schema):
    version_id: UUID


class BatchRollbackRequest(Schema):
    agent_run_id: str


class CreateSpaceCheckpointRequest(Schema):
    space_id: UUID
    name: str = ""
    file_checkpoint_hash: str = ""
    agent_run_id: str = ""
    trigger: str = "manual"
    user_prompt: str = ""
    checkpoint_policy: Optional[dict] = None
    # 手动快照等无 agent_run 的路径：客户端显式写入创建时会话锚点，
    # 供浏览面板「跳转到对话」使用。
    anchor_session_id: str = ""
    anchor_message_id: str = ""
    # QC-08 / PRD §4.7：HTTP 入口透传 diff_summary，与 Daemon 路径对齐，
    # 使 `insertions + deletions >= 30` 的 LLM 增强触发条件能够命中。
    # Shape: { changed: int, insertions: int, deletions: int,
    #          files?: [{ file, insertions, deletions, binary }] }
    diff_summary: Optional[dict] = None


class RestoreSpaceCheckpointRequest(Schema):
    checkpoint_id: UUID


# ── 响应 ──────────────────────────────────────────────

class VersionHistoryItem(Schema):
    id: UUID
    module: str = ""
    is_snapshot: bool = True
    is_named: bool = False
    name: str = ""
    pinned: bool = False
    editor_type: str = ""
    editor_id: str = ""
    blob_size: int = 0
    created_at: Optional[datetime] = None
    expired_at: Optional[datetime] = None
    extra: dict = {}


class CollabAuthResponse(Schema):
    status: str
    data: dict


class CollabSnapshotResponse(Schema):
    status: str
    data: dict


class VersionListResponse(Schema):
    status: str
    data: list[dict]
    total: int = 0


class CollabPersistResponse(Schema):
    status: str
    data: dict = {}


# ── 对话锚点查询 ─────────────────────────────────────

class ConversationAnchorContext(Schema):
    """单条 ChangeLog 的对话上下文。

    `sub_conversations` 默认为 None（仅 `has_sub_conversations` 布尔标记）；
    调用方传 `include_sub_conversations=true` 时才会返回详情列表，
    避免页面级别 N+1 查询（详见 PRD §4.3.1 性能关键设计）。
    """
    session_id: Optional[str] = None
    assistant_message_id: Optional[str] = None
    user_message_id: Optional[str] = None
    user_prompt: Optional[str] = None
    intent_summary: Optional[str] = None
    has_sub_conversations: bool = False
    sub_conversations: Optional[list[dict]] = None


class ConversationAnchorItem(Schema):
    """conversation-anchors 列表中的单条记录。"""
    changelog_id: str
    checkpoint_commit_hash: Optional[str] = None
    change_type: str = ""
    summary: str = ""
    created_at: Optional[datetime] = None
    editor_type: str = ""
    editor_name: str = ""
    agent_run_id: str = ""
    context: Optional[ConversationAnchorContext] = None


class ConversationAnchorsResponse(Schema):
    """conversation-anchors 完整响应。"""
    items: list[ConversationAnchorItem]
    has_more: bool = False
    next_before: Optional[str] = None


# ── 决策上下文查询 ─────────────────────────────────────

class DecisionContextImpact(Schema):
    """Checkpoint 影响详情（文件 + 结构化资源）。

    字段与 CheckpointImpactDetailView（chat/conversation/schemas.py）对齐，
    但此处独立声明避免跨 app 耦合。
    """
    files: Optional[list] = None
    files_truncated: bool = False
    files_total_count: int = 0
    resources: Optional[list[dict]] = None
    resources_truncated: bool = False
    resources_total_count: int = 0


class DecisionContextPayload(Schema):
    """完整决策上下文载荷（PRD §4.3.3 `context` 字段）。"""
    user_prompt: Optional[str] = None
    user_message_id: Optional[str] = None
    assistant_message_id: Optional[str] = None
    agent_run_id: Optional[str] = None
    intent_summary: Optional[str] = None
    decision_summary: Optional[dict] = None
    sub_conversations: Optional[list[dict]] = None
    impact: Optional[DecisionContextImpact] = None


class DecisionContextResponse(Schema):
    """GET /collab/v1/space-checkpoint/{id}/decision-context 响应（PRD §4.3.3）。

    前端 CheckpointContextCard 在展开时调用，作为 WS 推送丢失/延迟时的
    兜底拉取通道（幂等，支持节流）。
    """
    checkpoint_id: str
    anchor_session_id: Optional[str] = None
    anchor_message_id: Optional[str] = None
    context: DecisionContextPayload
    version_refs: dict = {}
