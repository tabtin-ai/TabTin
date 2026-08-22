"""业务模型 → ES 文档的转换（PRD 3.8 / 4.4 / 4.5）。

职责：
    - 对 6 类业务模型定义 `to_*_document(instance) -> dict`，严格对照
      `apps.fts.index_definitions` 的 mapping 字段
    - 按 PRD 要求派生 `creator_type` / `organization_id` / `session_title`
      等索引字段
    - 不触发额外数据库查询（2026-04-17 QC 修复后）
    - 对某些"不该索引"的记录（system/tool 消息、trashed/is_deleted
      记录）返回 `None`，由 signal 决定写 delete 还是跳过

调用约束：
    - signal handler 调用前必须确认字段已赋值（`transaction.on_commit`
      后业务数据已落库）
    - `organization_id` 可能需要跨表读取（ChatMessage → Session → Space 等），
      调用方应用 `select_related` 避免 N+1

D4 约定（总控 Wave 0 → Wave 1 启动提示）：
    - `object_scope_id` 在 Wave 1 **不填充**（不是写 None，而是在
      document 里直接省略该 key），Wave 2 ACL 定型后再补。
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import TYPE_CHECKING, Any, Iterable, Optional

from apps.fts.index_definitions import (
    INDEX_DEFINITIONS,
    get_index_name,
    get_messages_alias,
    get_monthly_index_name,
)

if TYPE_CHECKING:  # pragma: no cover - 仅类型提示
    from apps.chat.conversation.models import ChatMessage, ChatSession
    from apps.tabchat.models import Conversation
    from apps.tabchat.models import Message as ImMessage
    from apps.tabmemo.models import Memo
    from apps.tabtinspace.models import Agent, ContextItem, Space

logger = logging.getLogger(__name__)

__all__ = [
    # 单条转换
    "to_message_document",
    "to_resource_document",
    "to_agent_document",
    "to_space_document",
    "to_memo_document",
    "to_im_document",
    # 索引寻址
    "resolve_message_index_name",
    "resolve_upsert_index_name",
    # 辅助判断
    "should_index_chat_message",
    "should_index_memo",
    "should_index_resource",
    "should_index_im_message",
    "should_index_agent",
    "should_index_space",
    # 便捷批量
    "enqueue_messages_bulk_created",
]


# ── 通用 helper ────────────────────────────────────────────────
def _iso(dt: datetime | None) -> str | None:
    """ES 的 `date` 字段接受 ISO 8601 字符串或 epoch_millis。统一用 ISO。"""
    if dt is None:
        return None
    return dt.isoformat()


def _str_or_none(value: Any) -> str | None:
    """UUID / int / None → str 或 None（空串/None 合并返回 None）。"""
    if value is None:
        return None
    s = str(value)
    return s if s else None


# ── 1. ChatMessage（MySQL）→ tabtin-messages ───────────────────
_CHAT_INDEXED_ROLES: frozenset[str] = frozenset({"user", "assistant"})


def should_index_chat_message(msg: "ChatMessage") -> bool:
    """决定一条 ChatMessage 是否进入搜索索引。

    Wave 1 约束（PRD 3.8.B）：
        - `role='user'`：creator_type='user'，索引
        - `role='assistant'`：creator_type='agent'，索引
        - `role='system'` / `role='tool'` / 其他：不索引（噪音/内部）

    返回 False 的场景由 signal 视作 "空操作"（不写 outbox）。

    ：hitl_interaction 事实行（text_summary 恒空、内容在 metadata.hitl）
    不索引——空文档不可搜，只添噪音。
    """
    if getattr(msg, "message_kind", "") == "hitl_interaction":
        return False
    return (msg.role or "").lower() in _CHAT_INDEXED_ROLES


def _chat_creator_type(msg: "ChatMessage") -> str:
    role = (msg.role or "").lower()
    if role == "assistant":
        return "agent"
    return "user"


def to_message_document(msg: "ChatMessage") -> Optional[dict[str, Any]]:
    """转换 ChatMessage → `tabtin-messages` 文档。

    字段严格对齐 PRD 4.4 + `MESSAGES_MAPPING`。session_title 按 R0-08
    冗余存储；rename 时触发 update_by_query。

    返回 `None` 表示该消息不应入索引（由 `should_index_chat_message`
    判定，例如 system/tool 消息）。
    """
    if not should_index_chat_message(msg):
        return None

    session = getattr(msg, "session", None)
    session_id = getattr(msg, "session_id", None)
    organization_id = None
    space_id = None
    session_title = ""
    session_status = ""
    session_revert_state_index: int | None = None
    agent_id = None

    if session is not None:
        organization_id = _str_or_none(getattr(session, "organization_id", None))
        # ：ChatSession.space FK 已 Drop；索引 space_id 填 workspace_id。
        space_id = _str_or_none(getattr(session, "workspace_id", None))
        session_title = session.title or ""
        session_status = session.status or ""
        session_revert_state_index = getattr(session, "revert_state_index", None)
        # 只索引消息落库时固化的实际执行者。用户消息没有执行者时保持空，
        # 禁止回落会话当前指针，否则切 Agent 后重建索引会改写历史归属。
        agent_id = _str_or_none(getattr(msg, "agent_id", None))

    doc: dict[str, Any] = {
        "message_id": str(msg.id),
        "session_id": _str_or_none(session_id),
        "organization_id": organization_id,
        "space_id": space_id,
        "user_id": _str_or_none(getattr(msg, "sender_user_id", None) or ""),
        "creator_type": _chat_creator_type(msg),
        "agent_id": agent_id,
        "role": msg.role or "",
        # W3 §3.3.1：ChatMessage.content 已 drop —— FTS 索引消息内容用 text_summary
        # （全文检索完整体由 content_blocks_json 提取，未来 W3+迭代）
        "content": msg.text_summary or "",
        "session_title": session_title,
        "session_status": session_status,
        "created_at": _iso(msg.created_at),
    }
    if session_revert_state_index is not None:
        doc["session_revert_state_index"] = session_revert_state_index

    # ADR-16：Wave 2 回滚消息过滤主键。直接读 ChatMessage 模型字段，
    # 不需要 COUNT 查询；strict 允许 None 时省略
    checkpoint_state_index = getattr(msg, "checkpoint_state_index", None)
    if checkpoint_state_index is not None:
        doc["checkpoint_state_index"] = checkpoint_state_index

    # tool_call_summary / tool_names：Wave 1 留空（strict 允许字段缺省）
    return doc


# ── 2. ContextItem（PG）→ tabtin-resources ─────────────────────
def should_index_resource(item: "ContextItem") -> bool:
    """trash 即删除索引，不 upsert（Wave 1 由 signal 层把 trash 转 delete）。"""
    if getattr(item, "trashed_at", None) is not None:
        return False
    return True


def _resource_creator_type(item: "ContextItem") -> str:
    """R1-10 Wave 2 决策：Agent 产物推断（PRD 3.8.B）。

    ``metadata['creator_type']`` 是唯一事实源。Agent 已不再绑定 system
    user，不能再通过 ``created_by_id`` 与 Agent 所有者相等来猜测产物身份。
    """
    metadata = getattr(item, "metadata", None) or {}
    if isinstance(metadata, dict):
        explicit = (metadata.get("creator_type") or "").strip().lower()
        if explicit == "agent":
            return "agent"

    return "user"


def to_resource_document(item: "ContextItem") -> Optional[dict[str, Any]]:
    """转换 ContextItem → `tabtin-resources` 文档（PRD 4.5）。

    **D4 约定**：`object_scope_id` 字段 Wave 1 不填充。Wave 2 ACL 定型
    后再决定填 share.id 还是 keyword null。
    """
    if not should_index_resource(item):
        return None

    host = getattr(item, "workspace", None) or getattr(item, "project", None)
    #  / ：org-only 无 workspace/project 宿主，须读 item.organization_id
    organization_id = _str_or_none(getattr(item, "organization_id", None))
    if organization_id is None and host is not None:
        organization_id = _str_or_none(getattr(host, "organization_id", None))
    host_id = getattr(item, "workspace_id", None) or getattr(item, "project_id", None)

    # ContextItem 没有 visibility 字段；用 host 上下文推导 Wave 1 默认 private
    visibility = "private"

    doc: dict[str, Any] = {
        "item_id": str(item.id),
        "item_type": item.item_type or "",
        "title": item.title or "",
        "preview": item.preview or "",
        "resource_id": item.resource_id or "",
        "space_id": _str_or_none(host_id),
        "organization_id": organization_id,
        "creator_type": _resource_creator_type(item),
        "creator_id": _str_or_none(getattr(item, "created_by_id", None)),
        "is_archived": bool(item.is_archived),
        "trashed_at": _iso(item.trashed_at),
        "visibility": visibility,
        # D4：object_scope_id 不设
        "created_at": _iso(item.created_at),
        "updated_at": _iso(item.updated_at),
    }
    return doc


# ── 3. Agent（PG）→ tabtin-agents ──────────────────────────────
def should_index_agent(agent: "Agent") -> bool:
    """is_active=False 的 Agent 不索引（用户视角不可达）。"""
    return bool(getattr(agent, "is_active", True))


def to_agent_document(agent: "Agent") -> Optional[dict[str, Any]]:
    if not should_index_agent(agent):
        return None

    # ：space_ids 来自会话最近现场 + Project 成员关系，不再读 Workspace.agent。
    space_ids: list[str] = []
    try:
        from apps.chat.conversation.models import ChatSession
        from apps.tabtinspace.models import SpaceMembership

        qs_sessions = (
            ChatSession.objects.filter(agent_id=agent.id, workspace_id__isnull=False)
            .order_by("-updated_at")
            .values_list("workspace_id", flat=True)
            .distinct()[:20]
        )
        space_ids.extend(str(v) for v in qs_sessions)
        membership_field = "workspace_id"
        qs_memberships = (
            SpaceMembership.objects
            .filter(agent_id=agent.id, is_active=True)
            .values_list(membership_field, flat=True)
        )
        for sid in qs_memberships:
            if sid is None:
                continue
            s = str(sid)
            if s not in space_ids:
                space_ids.append(s)
    except Exception:  # pragma: no cover - 不让 ACL 失败阻塞同步
        logger.warning("[FTS] agent space_ids lookup failed agent=%s", agent.id, exc_info=True)

    return {
        "agent_id": str(agent.id),
        "name": agent.name or "",
        "description": getattr(agent, "goal", "") or "",
        "type": agent.type or "",
        "organization_id": _str_or_none(getattr(agent, "organization_id", None)),
        "user_id": _str_or_none(getattr(agent, "owner_user_id", None)),
        "space_ids": space_ids,
        "created_at": _iso(agent.created_at),
    }


# ── 4. Workspace / Project（PG）→ tabtin-spaces ────────────────
def should_index_space(space) -> bool:
    """trashed 宿主不索引（Workspace 无 trashed_at，恒为可索引）。"""
    if getattr(space, "trashed_at", None) is not None:
        return False
    return True


def to_space_document(space) -> Optional[dict[str, Any]]:
    """#6342：索引文档兼容 Workspace + Project（旧 Space.type 口径）。"""
    if not should_index_space(space):
        return None
    from apps.tabtinspace.models import Project, Workspace

    if isinstance(space, Project):
        host_type = "team_space"
        description = space.description or ""
        is_archived = bool(space.is_archived)
    elif isinstance(space, Workspace):
        host_type = "workspace"
        description = ""
        is_archived = False
    else:
        host_type = getattr(space, "type", None) or ""
        description = getattr(space, "description", None) or ""
        is_archived = bool(getattr(space, "is_archived", False))
    return {
        "space_id": str(space.id),
        "name": space.name or "",
        "description": description,
        "type": host_type,
        "is_archived": is_archived,
        "organization_id": _str_or_none(getattr(space, "organization_id", None)),
        "created_at": _iso(space.created_at),
    }


# ── 5. Memo（PG）→ tabtin-memos ────────────────────────────────
def should_index_memo(memo: "Memo") -> bool:
    """status != active（archived/trashed）不索引。"""
    status = getattr(memo, "status", "") or ""
    if status != "active":
        return False
    if getattr(memo, "trashed_at", None) is not None:
        return False
    return True


def _memo_creator_type(memo: "Memo") -> str:
    """按 source 判 Agent 产物。

    2026-04-17 产品 Review 收紧：
        - **只**按 `source='agent'` 判 'agent'；memo_type 是类型学标签
          （笔记/书签/洞察/摘要/技能），**不**作为 creator_type 的依据
        - 用户可手写 memo_type='insight' 的笔记（产品允许），原来 memo_type
          兜底会把用户手写 insight 误标为 'agent'，违反 PRD 3.8.B "只看我说的"
          筛选语义
        - 代价：Agent 产物**必须**把 Memo.source 正确设为 'agent'；否则
          creator_type 判 'user'。这依赖 business 层 skill 正确传参
    """
    source = getattr(memo, "source", "") or ""
    if source == "agent":
        return "agent"
    return "user"


def to_memo_document(memo: "Memo") -> Optional[dict[str, Any]]:
    if not should_index_memo(memo):
        return None
    return {
        "memo_id": str(memo.id),
        "content": getattr(memo, "content_plaintext", "") or "",
        "tags": list(memo.tags or []),
        "ai_tags": list(memo.ai_tags or []),
        "status": memo.status or "",
        "memo_type": memo.memo_type or "",
        "source": memo.source or "",
        "is_pinned": bool(memo.is_pinned),
        "trashed_at": _iso(memo.trashed_at),
        "space_id": _str_or_none(getattr(memo, "space_id", None)),
        "organization_id": _str_or_none(getattr(memo, "organization_id", None)),
        "user_id": _str_or_none(getattr(memo, "owner_id", None)),
        "creator_type": _memo_creator_type(memo),
        "created_at": _iso(memo.created_at),
        "updated_at": _iso(memo.updated_at),
    }


# ── 6. tabchat.Message（PG）→ tabtin-im ────────────────────────
def should_index_im_message(msg: "ImMessage") -> bool:
    """is_deleted=True 的 IM 消息不索引。"""
    if getattr(msg, "is_deleted", False):
        return False
    return True


def to_im_document(msg: "ImMessage") -> Optional[dict[str, Any]]:
    if not should_index_im_message(msg):
        return None

    conversation = getattr(msg, "conversation", None)
    conversation_name = ""
    organization_id = None
    space_id = None
    if conversation is not None:
        conversation_name = conversation.name or ""
        organization_id = _str_or_none(getattr(conversation, "organization_id", None))
        space_id = _str_or_none(getattr(conversation, "space_id", None))

    return {
        "message_id": str(msg.id),
        "conversation_id": _str_or_none(getattr(msg, "conversation_id", None)),
        "conversation_name": conversation_name,
        "sender_id": msg.sender_id or "",
        "creator_type": "user",  # P0：IM 仅用户发送
        "space_id": space_id,
        "content": msg.content or "",
        "is_deleted": bool(msg.is_deleted),
        "organization_id": organization_id,
        "created_at": _iso(msg.created_at),
    }


# ── 索引物理名解析（PRD 4.5 月度 rollover） ─────────────────────
def resolve_message_index_name(created_at: datetime | None) -> str:
    """ChatMessage 的物理月度索引名（按创建时间路由）。

    注意：alias `tabtin-messages` 聚合全部月度索引，**读**走 alias；
    **写**必须明确到物理索引名（bulk 的 index 字段），否则 ES 对多月份
    alias 的 bulk index 会 400。
    """
    return get_monthly_index_name("messages", created_at)


def resolve_upsert_index_name(logical: str, instance: Any = None) -> str:
    """根据逻辑索引名返回 bulk upsert 时使用的物理索引名。

    - `messages` → 按 instance.created_at 计算月度物理名
    - 其他 → alias 名（`tabtin-<logical>`）
    """
    if logical == "messages":
        created_at = getattr(instance, "created_at", None)
        return resolve_message_index_name(created_at)
    base = INDEX_DEFINITIONS[logical]["base_name"]
    return get_index_name(base)


# ── Bulk-create 路径显式 outbox 写入（PRD 4.3.B / R1-03） ───────
def enqueue_messages_bulk_created(messages: Iterable["ChatMessage"]) -> int:
    """ChatMessage 批量创建后显式写 FTS Outbox。

    Django `bulk_create` 不触发 `post_save`，因此不走 signal 管道。
    调用方（fork / 会话迁移 / 批量导入）**必须**在 bulk_create 完成
    后调用本函数，否则搜索索引会丢整批消息。

    幂等性：对同一消息重复调用只会多写几条 outbox，flush task
    会合并（按 doc_id + action 最后一条胜出）。

    返回写入 outbox 的行数（可用于上层日志/指标）。
    """
    # 延迟 import 避免 app loading 顺序问题
    from apps.fts.client import is_engine_enabled
    if not is_engine_enabled():
        return 0

    from django.db import transaction
    from apps.fts.services.outbox_service import write_outbox

    alias = get_messages_alias()
    count = 0
    for msg in messages:
        session = getattr(msg, "session", None)
        organization_id = (
            _str_or_none(getattr(session, "organization_id", None)) if session else None
        )
        try:
            write_outbox(
                db="default",
                index_name=alias,
                doc_id=str(msg.id),
                action="upsert",
                organization_id=organization_id,
            )
            count += 1
        except Exception:
            logger.exception(
                "[FTS] enqueue_messages_bulk_created failed for message_id=%s",
                getattr(msg, "id", None),
            )
    # R1-17 Wave 1 优化：bulk_create 后立即 `transaction.on_commit` 发 flush，
    # 避免 fork 10 万消息场景下只能等 beat 5s 兜底（单租户污染全局队列）。
    # 业务事务提交后同步 flush；失败不影响业务返回值。
    if count > 0:
        try:
            from apps.fts.tasks import flush_outbox_task
            transaction.on_commit(
                lambda: flush_outbox_task.delay(db="default"),
                using="default",
            )
        except Exception:
            logger.exception("[FTS] enqueue_messages_bulk_created schedule flush failed")
    return count
