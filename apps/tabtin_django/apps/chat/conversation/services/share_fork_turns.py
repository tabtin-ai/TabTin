"""共享任务 fork 快照 turns 收集。

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

from django.db.models import Q

from .fork_tool_id_remap import ForkToolIdMapper
from .transcript_snapshot import _MAX_TURNS, clean_snapshot_blocks

_DELIVERABLE_ARTIFACT_KINDS = frozenset({
    "local_file",
    "oss_file",
    "platform_resource",
})
_WIDGET_CONTENT_KEYS = ("code", "rendered_code", "image_url")
_SNAPSHOT_MESSAGE_KINDS = frozenset({"llm", "tool_artifact"})


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
    truncated = False
    tool_id_mapper = ForkToolIdMapper()
    qs = _share_visible_queryset(session).order_by("-created_at", "-id")
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
        turns.append({
            "role": "assistant" if message_kind == "tool_artifact" else msg.role,
            "text": text,
            "blocks": snapshot_blocks,
            "created_at": msg.created_at,
            "message_kind": message_kind,
        })
    turns.reverse()
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
