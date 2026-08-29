"""共享任务 fork 快照 turns 收集（#7744）。

文档协同式共享下，grantee 经主鉴权 ``_get_session_with_shared_access``
读 owner 同一会话；本模块给 shared-fork 与任务转交收集可物化的 turns
和资源指针（供 ``session_materializer`` 创建接收人自己的会话）。

快照口径与 IM 交接「由我继续」共享同一清洗入口：
- 主时间线（排除 subagent_run_id 非空）``message_kind='llm'`` 且
  role ∈ {user, assistant} 的消息；
- 以及带可交付 rich 的 ``message_kind='tool_artifact'``（local_file /
  oss_file / platform_resource / 有内容的 widget）。纯文本占位产物气泡
  仍排除——那不是交付物，续接后也不该变成空卡片；
- 每条 turn 保留结构化 ``content_blocks_json``：text / tool_use / file 等块
  继续按正常聊天消息渲染；工具调用保留工具名与展示标签，但不搬运原始
  input / tool_result；
- 组织内全量透明：**不再做绝对路径打码**；thinking 内心独白与工具原始
  输入 / 返回仍不进快照（fork 是「继续任务」的干净起点，不是全量导出——
  grantee 要看完整过程直接进共享会话本体）。

块清洗复用 ``transcript_snapshot.clean_snapshot_blocks``（同一份 text /
ContentBlock 清洗规则），规模上限共用 _MAX_TURNS，避免两处口径漂移。
"""

from __future__ import annotations

import json
import mimetypes

from django.db.models import Q

from .fork_tool_id_remap import ForkToolIdMapper
from .transcript_snapshot import _MAX_TURNS, clean_snapshot_blocks
from .workspace_file.path import (
    basename_of,
    canonicalize_artifact_relative_path,
    is_deliverable_relative_path,
)
from .workspace_file.reference import strip_approval_note_prefix

_DELIVERABLE_ARTIFACT_KINDS = frozenset({
    "local_file",
    "oss_file",
    "platform_resource",
})
_WIDGET_CONTENT_KEYS = ("code", "rendered_code", "image_url")
_SNAPSHOT_MESSAGE_KINDS = frozenset({"llm", "tool_artifact"})
_FILE_MUTATION_TOOLS = frozenset({"write_file", "edit_file", "create_file"})
_DELETE_FILE_TOOL = "delete_file"
_TERMINAL_TOOLS = frozenset({"run_terminal", "run_terminal_command"})


def _block_payload(block: dict) -> dict:
    payload = block.get("payload")
    return payload if isinstance(payload, dict) else {}


def is_deliverable_rich_block(block: dict) -> bool:
    """对齐 Electron ``isDeliverableRichBlock``：可进产物卡的 rich 块。"""
    if not isinstance(block, dict):
        return False
    payload = _block_payload(block)
    artifact_kind = str(
        payload.get("artifact_kind") or block.get("artifact_kind") or ""
    ).strip()
    if artifact_kind in _DELIVERABLE_ARTIFACT_KINDS:
        return True
    kind = str(block.get("kind") or payload.get("kind") or "").strip()
    if kind != "widget":
        return False
    for key in _WIDGET_CONTENT_KEYS:
        value = payload.get(key) if payload.get(key) not in (None, "") else block.get(key)
        if isinstance(value, str) and value.strip():
            return True
    return False


def _deliverable_blocks(blocks: list) -> list[dict]:
    return [
        block for block in blocks
        if isinstance(block, dict) and is_deliverable_rich_block(block)
    ]


def _tool_result_payload(block: dict) -> dict | None:
    """解析成功的工具结果，供交接快照生成产物，不把原始结果带入快照。"""
    if not isinstance(block, dict) or block.get("is_error") is True:
        return None
    content = block.get("content")
    if isinstance(content, dict):
        payload = content
    elif isinstance(content, str):
        try:
            payload = json.loads(strip_approval_note_prefix(content).strip())
        except (TypeError, ValueError):
            return None
    else:
        return None
    if not isinstance(payload, dict) or payload.get("success") is False:
        return None
    return payload


def _successful_local_file_ops(blocks: list) -> list[dict]:
    """从工具真实成功记录中提取文件变更，生成交接候选。

    这是对既有 rich ``local_file`` 产物的兼容补齐：文件工具已经成功写盘，
    但旧消息没有产物块时，交接仍应能把该文件资源化。只接受成功的工具对，
    不解析助手自然语言，也不扫描工作区。
    """
    if not isinstance(blocks, list):
        return []
    results_by_id: dict[str, dict] = {}
    for raw in blocks:
        if not isinstance(raw, dict) or raw.get("type") != "tool_result":
            continue
        tool_id = str(raw.get("tool_use_id") or "")
        if tool_id:
            results_by_id[tool_id] = raw

    ops: list[dict] = []
    for raw in blocks:
        if not isinstance(raw, dict) or raw.get("type") != "tool_use":
            continue
        name = str(raw.get("name") or raw.get("tool_name") or "")
        result = results_by_id.get(str(raw.get("id") or ""))
        if result is None or _tool_result_payload(result) is None:
            continue
        tool_input = raw.get("input") or raw.get("arguments") or {}
        if not isinstance(tool_input, dict):
            tool_input = {}

        if name in _FILE_MUTATION_TOOLS or name == _DELETE_FILE_TOOL:
            path = tool_input.get("path") or tool_input.get("file_path")
            canonical = canonicalize_artifact_relative_path(str(path or ""))
            if not canonical or not is_deliverable_relative_path(canonical):
                continue
            ops.append({
                "relative_path": canonical,
                "deleted": name == _DELETE_FILE_TOOL,
            })
            continue

        if name not in _TERMINAL_TOOLS:
            continue
        payload = _tool_result_payload(result) or {}
        history = payload.get("file_history")
        if not isinstance(history, dict):
            continue
        for field, deleted in (("created_paths", False), ("modified_paths", False), ("deleted_paths", True)):
            paths = history.get(field)
            if not isinstance(paths, list):
                continue
            for path in paths:
                canonical = canonicalize_artifact_relative_path(str(path or ""))
                if not canonical:
                    continue
                if not deleted and not is_deliverable_relative_path(canonical):
                    continue
                ops.append({"relative_path": canonical, "deleted": deleted})

    return ops


def _local_file_artifact_block(relative_path: str) -> dict:
    return {
        "type": "tabtin_rich_content",
        "kind": "file",
        "payload": {
            "artifact_kind": "local_file",
            "relative_path": relative_path,
            "filename": basename_of(relative_path) or relative_path,
            "mime_type": mimetypes.guess_type(relative_path)[0]
            or "application/octet-stream",
        },
    }


def _share_visible_queryset(session):
    """fork 快照可见消息：主时间线 llm + 可交付 tool_artifact。"""
    return (
        session.messages
        .exclude(subagent_run_id__gt="")
        .filter(
            Q(message_kind="llm", role__in=("user", "assistant"))
            | Q(message_kind="tool_artifact", role="assistant")
        )
    )


def collect_share_turns(session, *, max_turns: int = _MAX_TURNS) -> tuple[list[dict], bool]:
    """全量收集任务快照 turns（供 fork / 转交物化新会话）。

    Returns:
        (turns, truncated)：turns 形如
        [{role, text, blocks, created_at, message_kind}]，
        blocks 为清洗后的可渲染 ContentBlock[]；空转（无正文 / 无工具 /
        无附件 / 无可交付产物）跳过。

    截断方向：超过 ``max_turns`` 时**保最新、丢最早**（倒序凑满后再翻回
    时间序）——fork 是为了继续任务，近期上下文最要紧；与交接快照
    ``build_readable_transcript`` 的丢弃方向一致。
    """
    turns: list[dict] = []
    sender_ids: set[str] = set()
    local_file_ops: list[dict] = []
    truncated = False
    tool_id_mapper = ForkToolIdMapper()
    qs = _share_visible_queryset(session).order_by("-created_at", "-id")
    # 产物不能受消息快照的 max_turns 截断影响：历史上下文可以只保最新轮，
    # 但交接资源必须覆盖源会话中最终仍存在的全部成功文件产物。
    for msg in _share_visible_queryset(session).order_by("created_at", "id").iterator():
        blocks = (
            msg.content_blocks_json
            if isinstance(msg.content_blocks_json, list) else []
        )
        local_file_ops.extend(_successful_local_file_ops(blocks))
    for msg in qs.iterator():
        if len(turns) >= max_turns:
            truncated = True
            break
        blocks = (
            msg.content_blocks_json
            if isinstance(msg.content_blocks_json, list) else []
        )
        message_kind = (
            msg.message_kind
            if msg.message_kind in _SNAPSHOT_MESSAGE_KINDS
            else "llm"
        )
        if message_kind == "tool_artifact" and not _deliverable_blocks(blocks):
            continue
        text, snapshot_blocks = clean_snapshot_blocks(
            blocks, tool_id_mapper=tool_id_mapper,
        )
        if message_kind == "tool_artifact":
            snapshot_blocks = _deliverable_blocks(snapshot_blocks)
            text = ""
        if not snapshot_blocks:
            continue
        sender_user_id = ""
        if message_kind == "llm" and msg.role == "user":
            from .sender_identity import resolve_sender_user_id

            sender_user_id = resolve_sender_user_id(
                msg,
                owner_user_id=str(session.user_id),
            )
            if sender_user_id:
                sender_ids.add(sender_user_id)
        turns.append({
            "role": "assistant" if message_kind == "tool_artifact" else msg.role,
            "text": text,
            "blocks": snapshot_blocks,
            "created_at": msg.created_at,
            "message_kind": message_kind,
            **({"sender_user_id": sender_user_id} if sender_user_id else {}),
            **({
                "sender_display_name": str((msg.metadata or {}).get("sender_display_name")).strip()
            } if msg.role == "user" and isinstance(msg.metadata, dict)
               and (msg.metadata or {}).get("sender_display_name") else {}),
        })
    turns.reverse()
    # 兼容历史文件工具消息：它们可能只有 tool_use/tool_result，没有 rich
    # local_file 块。把整个源会话最终仍存在的文件作为独立产物行加入快照，
    # 后续 prepare_local_file_handoffs 会负责上传并改写目标路径。
    surviving_local_files: dict[str, dict] = {}
    for op in local_file_ops:
        path = str(op["relative_path"])
        key = path.lower()
        if op["deleted"]:
            surviving_local_files.pop(key, None)
        else:
            surviving_local_files[key] = op
    existing_local_files: set[str] = set()
    for turn in turns:
        for block in turn.get("blocks", []):
            if not isinstance(block, dict) or block.get("kind") != "file":
                continue
            payload = _block_payload(block)
            if payload.get("artifact_kind") != "local_file":
                continue
            path = canonicalize_artifact_relative_path(
                str(payload.get("relative_path") or "")
            )
            if path:
                existing_local_files.add(path.lower())
    surviving_local_files = {
        key: op for key, op in surviving_local_files.items()
        if key not in existing_local_files
    }
    if surviving_local_files:
        turns.append({
            "role": "assistant",
            "text": "",
            "blocks": [
                _local_file_artifact_block(str(op["relative_path"]))
                for op in surviving_local_files.values()
            ],
            "created_at": None,
            "message_kind": "tool_artifact",
        })
    if sender_ids:
        from .sender_identity import load_sender_users, resolve_user_display_name

        users = load_sender_users(sender_ids)
        for turn in turns:
            sender_user_id = str(turn.get("sender_user_id") or "").strip()
            if not sender_user_id or turn.get("sender_display_name"):
                continue
            sender = users.get(sender_user_id)
            turn["sender_display_name"] = resolve_user_display_name(
                sender,
                sender_user_id,
            )
    return turns, truncated


def collect_share_resource_pointers(session, *, limit: int = 100) -> list[tuple[str, str]]:
    """收集与续接快照同口径的去重资源指针。"""
    from apps.tabtinspace.services.project_task_results import iter_resource_pointers

    pointers: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for message in _share_visible_queryset(session).only("content_blocks_json").iterator():
        for pointer in iter_resource_pointers(message.content_blocks_json):
            if pointer in seen:
                continue
            seen.add(pointer)
            pointers.append(pointer)
            if len(pointers) >= limit:
                return pointers
    return pointers
