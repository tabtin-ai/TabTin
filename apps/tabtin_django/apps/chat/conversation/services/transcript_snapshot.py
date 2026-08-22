"""Agent 会话清洗快照（供 IM 交接材料冻结用）。

把一个 ChatSession 的完整消息历史（``content_blocks_json`` = Anthropic
ContentBlock[]）清洗成「可读、去敏、体积可控」的结构，供 IM 上下文交接把整段
Agent 会话作为 ``chat_session`` 材料冻结进交接包。

清洗口径（与用户确认的「清洗版全文」一致）：
- 保留 user / AI 的对话正文（text 块）。
- tool_use 只保留「调用了什么工具」的名称 + 人类标签，**丢弃原始 input 参数**
  （常含文件路径 / working_dir / 密钥等敏感信息）。
- thinking 内心独白整块丢弃。
- file / image / document 附件 → 保留结构化引用（file_id/url/filename/size），
  被交接人可下载且 Agent 可通过引用分析文件。无 file_id/url 的旧格式降级为占位标注。
- message_kind 属于 UI 隐藏的内部消息（environment_context /
  agent_profile_context / hitl_interaction / compaction_summary）整条跳过。
- 未识别块类型 → 兜底占位，避免正文静默丢失。

不复用 packages 里过时的 chat-export-md（它读老式 msg.content / msg.tool_calls，
未适配 W3 的 content_blocks_json）。
"""
from __future__ import annotations

import logging
from typing import Any

from .fork_tool_id_remap import (
    TOOL_USE_TYPES,
    ForkToolIdMapper,
    remap_content_blocks_json,
)

logger = logging.getLogger(__name__)

# 单条冻结快照的规模上限——超大会话截断并标注，避免 JSONField 膨胀（风险位见方案 §7）。
_MAX_TURNS = 500
_MAX_TEXT_CHARS = 4000

# UI 隐藏 / 不进人类可读记录的内部消息类型。
_HIDDEN_MESSAGE_KINDS = {
    "environment_context",
    "agent_profile_context",
    "system_prompt_context",
    "hitl_interaction",
    "compaction_summary",
}

# 工具名 → 人类标签（未列出的直接用工具名兜底）。
_TOOL_LABELS = {
    "read_file": "读取文件",
    "write_file": "写入文件",
    "edit_file": "编辑文件",
    "run_terminal": "执行命令",
    "run_command": "执行命令",
    "codebase_search": "搜索代码",
    "grep_search": "搜索文本",
    "web_search": "联网搜索",
    "web_fetch": "抓取网页",
    "list_dir": "浏览目录",
}


class SnapshotAccessError(PermissionError):
    """发起人无权读取目标会话（不能把别人的会话塞进交接包）。"""


def _tool_label(name: str) -> str:
    return _TOOL_LABELS.get(name, name or "工具")


def clean_snapshot_blocks(
    blocks: list[Any],
    *,
    tool_id_mapper: ForkToolIdMapper | None = None,
) -> tuple[str, list[dict]]:
    """清洗一条消息的 ContentBlock[]，保留可渲染结构供 fork / 接手复用。"""
    if not isinstance(blocks, list):
        return "", []
    mapper = tool_id_mapper or ForkToolIdMapper()
    remapped_blocks = remap_content_blocks_json(blocks, mapper)
    if not isinstance(remapped_blocks, list):
        return "", []

    texts: list[str] = []
    snapshot_blocks: list[dict] = []
    for block in remapped_blocks:
        if not isinstance(block, dict):
            continue
        btype = block.get("type", "")
        if btype == "thinking" or btype == "tool_result":
            continue
        if btype in TOOL_USE_TYPES:
            name = str(block.get("name") or "").strip()
            if not name:
                continue
            clean_block = dict(block)
            clean_block["type"] = btype
            if not isinstance(clean_block.get("id"), str) or not clean_block["id"]:
                clean_block["id"] = mapper.allocate(None)
            clean_block["name"] = name
            clean_block["input"] = {}
            clean_block.pop("arguments", None)
            clean_block.setdefault("label", _tool_label(name))
        else:
            clean_block = dict(block)

        if clean_block.get("type") == "text":
            text = clean_block.get("text")
            if isinstance(text, str) and text.strip():
                texts.append(text.strip())
            elif not text:
                continue
        snapshot_blocks.append(clean_block)

    return "\n\n".join(texts), snapshot_blocks


def _clean_blocks(blocks: list[Any]) -> tuple[str, list[dict], list[str]]:
    """从一条消息的 content_blocks_json 抽出 (正文, 工具列表, 附件占位)。"""
    texts: list[str] = []
    tools: list[dict] = []
    attachments: list[str] = []

    for block in blocks:
        if not isinstance(block, dict):
            continue
        btype = block.get("type", "")
        if btype == "text":
            text = block.get("text")
            if isinstance(text, str) and text.strip():
                texts.append(text.strip())
        elif btype == "thinking":
            continue  # 内心独白整块丢弃
        elif btype == "tool_use":
            name = str(block.get("name") or "")
            tools.append({"name": name, "label": _tool_label(name)})
        elif btype == "tool_result":
            continue  # 工具原始返回不搬运（可能含敏感数据）
        elif btype == "file":
            attachments.append({
                "type": "file",
                "file_id": block.get("file_id", ""),
                "filename": block.get("filename") or "未命名文件",
                "url": block.get("url", ""),
                "mime_type": block.get("mime_type", ""),
                "size": block.get("size", 0),
            })
        elif btype == "image":
            attachments.append({
                "type": "image",
                "file_id": block.get("file_id", ""),
                "filename": block.get("filename", ""),
                "url": block.get("url", ""),
                "mime_type": block.get("mime_type", "image/png"),
                "size": block.get("size", 0),
            } if block.get("file_id") or block.get("url") else "[图片]")
        elif btype == "document":
            title = block.get("title") or "附件"
            attachments.append({
                "type": "document",
                "file_id": block.get("file_id", ""),
                "filename": title,
                "url": block.get("url", ""),
                "mime_type": block.get("mime_type", ""),
                "size": block.get("size", 0),
            } if block.get("file_id") or block.get("url") else f"[附件: {title}]")
        else:
            attachments.append(f"[{btype or '内容'}]")

    joined = "\n\n".join(texts)
    if len(joined) > _MAX_TEXT_CHARS:
        joined = joined[:_MAX_TEXT_CHARS] + "…（已截断）"
    return joined, tools, attachments


def build_readable_transcript(session_id: str, viewer) -> dict:
    """读取并清洗一个 ChatSession 的历史，返回可冻结的快照结构。

    Args:
        session_id: 目标 ChatSession id。
        viewer: 发起人 User 实例（用其权限校验能否访问该会话）。

    Returns:
        {title, message_count, truncated, turns:[{role, text, tools, attachments}]}

    Raises:
        SnapshotAccessError: viewer 无权访问该会话。
        ValueError: 会话不存在。

    权限口径（Phase 1）：只允许转发「自己」的 user↔Agent 会话。ChatSession 是发起人
    个人资产，按 owner 校验即可，不走团队共享分支（团队 Space 会话共享另议）。
    """
    from uuid import UUID

    from ..models import ChatSession

    try:
        UUID(str(session_id))
    except (ValueError, TypeError, AttributeError):
        raise SnapshotAccessError("无权转发该会话或会话不存在")

    session = ChatSession.objects.filter(id=session_id, user=viewer).first()
    if session is None:
        raise SnapshotAccessError("无权转发该会话或会话不存在")

    qs = (
        session.messages
        .exclude(message_kind__in=_HIDDEN_MESSAGE_KINDS)
        .order_by("created_at", "id")
    )

    turns: list[dict] = []
    truncated = False
    tool_id_mapper = ForkToolIdMapper()
    for msg in qs.iterator():
        if len(turns) >= _MAX_TURNS:
            truncated = True
            break
        blocks = msg.content_blocks_json if isinstance(msg.content_blocks_json, list) else []
        text, tools, attachments = _clean_blocks(blocks)
        _snapshot_text, snapshot_blocks = clean_snapshot_blocks(
            blocks, tool_id_mapper=tool_id_mapper,
        )
        if not text and not tools and not attachments:
            continue  # 空转（纯 thinking / 纯 tool_result 合并消息）跳过
        turns.append({
            "role": msg.role,
            "text": text,
            "tools": tools,
            "attachments": attachments,
            "blocks": snapshot_blocks,
        })

    return {
        "title": session.title or "未命名会话",
        "message_count": len(turns),
        "truncated": truncated,
        "turns": turns,
    }
