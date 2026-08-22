"""消息查询 API（W3 §3.3.5 ContentBlock[] 改造版）。

Wave 15 起，云端 Agent 编排层已完全下线：
- 消息发送（POST /messages）、AskUser 回答（POST /messages/answer）等写端点全部删除；
- 所有 Agent 执行由客户端本地 Runtime 接管，消息持久化由 relay ACK 驱动；
- 本模块仅保留纯数据查询（GET /messages 列表 + 游标分页 + around 上下文窗口）。

W3 §3.3.5 改造：
- ChatMessage 字段 `blocks_json` / `attachments_json` / `content` / `agent_type` /
  `intent` 等老字段已下线（Migration 0038 drop）；新字段 `content_blocks_json`
  （Anthropic ContentBlock[]）+ `text_summary` 等顶层结构化字段。
- `slim_blocks` 参数升级：可指定要 strip 哪些 block.type（譬如 thinking、
  large tool_result）；默认参数 `1/true` 保持向后兼容（slim 默认策略）。
- 新增 `summary_only` 参数：只返回 text_summary + 元数据，用于会话列表场景
  （bandwidth-sensitive；不返 content_blocks_json 减小响应体）。
- 新增端点 `GET /messages/{message_id}/blocks/{block_id}/full`：截断块的
  全文懒加载（v3 §3.3.8 超长 block 截断与冷存储）。
- ：`POST /sessions/{id}/withdraw-unanswered` 物理撤回未答 user（非 checkpoint 回退）。
"""

import uuid

from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from ninja import Body

from apps.i18n import _
from apps.i18n.response import success_response, error_response_with_status
from ..schemas import (
    ChatMessageSchema,
    CompactionCheckpointRequest,
    CompactionCheckpointResponse,
    MessageListResponse,
    WithdrawUnansweredRequest,
    WithdrawUnansweredResponse,
)
from ._common import (
    router, jwt_auth,
    MAX_MESSAGE_PAGE_SIZE,
    _get_session_with_shared_access,
    _build_checkpoint_record,
    _get_space_checkpoint_summaries,
    _build_revert_visible_message_filter,
)
# tool_result 合并 / 终态 supersede 的纯逻辑（channels-free 中立模块）——读时自愈
# 直接 import，不必再经 ws.handlers 包级 __init__ 把 channels + 全套 gateway handler
# 依赖拉进历史读取路径。
from ..tool_result_merge import (
    _is_terminal_tool_result_update,
    _merge_tool_result_block_into_message,
)

import logging

logger = logging.getLogger(__name__)


def _serialize_chat_message(msg) -> ChatMessageSchema:
    blocks = msg.content_blocks_json if isinstance(msg.content_blocks_json, list) else []
    return ChatMessageSchema(
        id=str(msg.id),
        role=msg.role,
        agent_id=str(msg.agent_id) if msg.agent_id else None,
        client_event_id=str(msg.client_event_id) if msg.client_event_id else None,
        content=msg.text_summary or '',
        content_blocks_json=blocks,
        attachments_json=[],
        agent_type=None,
        intent=None,
        trace_id=str(msg.trace_id) if msg.trace_id else None,
        model_id=str(msg.model_id) if msg.model_id else None,
        model_name=msg.model.model_name if getattr(msg, 'model', None) else (msg.model_name_snapshot or None),
        sender_user_id=getattr(msg, "_sender_user_id_for_response", None),
        sender_display_name=getattr(msg, "_sender_display_name_for_response", None),
        checkpoint_hash=msg.checkpoint_hash,
        checkpoint_state_index=msg.checkpoint_state_index,
        diff_summary=msg.diff_summary,
        checkpoint_record=None,
        agent_run_id=msg.agent_run_id or None,
        metadata=msg.metadata if msg.metadata else None,
        text_summary=msg.text_summary or None,
        stop_reason=msg.stop_reason or None,
        usage_json=msg.usage_json,
        error_info_json=msg.error_info_json,
        subagent_run_id=msg.subagent_run_id or None,
        model_name_snapshot=msg.model_name_snapshot or None,
        checkpoint_anchor_block_id=msg.checkpoint_anchor_block_id or None,
        checkpoint_anchor_block_index=msg.checkpoint_anchor_block_index,
        message_kind=msg.message_kind,
        has_artifacts=False,
        created_at=msg.created_at,
        updated_at=msg.updated_at,
    )


def _attach_sender_display_names(messages) -> None:
    """Annotate every user message with its canonical sender identity."""
    if not messages:
        return
    try:
        from django.contrib.auth import get_user_model
        sender_ids = {
            str(msg.sender_user_id)
            for msg in messages
            if getattr(msg, "role", None) == "user" and getattr(msg, "sender_user_id", "")
        }
        if not sender_ids:
            return

        users = {
            str(user.id): user
            for user in get_user_model().objects.filter(id__in=sender_ids)
        }
        for msg in messages:
            if getattr(msg, "role", None) != "user":
                continue
            sender_user_id = str(getattr(msg, "sender_user_id", "") or "")
            if not sender_user_id:
                continue
            sender = users.get(sender_user_id)
            setattr(msg, "_sender_user_id_for_response", sender_user_id)
            setattr(
                msg,
                "_sender_display_name_for_response",
                sender.get_display_name() if sender else sender_user_id[:8],
            )
    except Exception:
        logger.warning("attach sender display names failed", exc_info=True)


@router.post("/sessions/{session_id}/compaction-checkpoint", auth=jwt_auth, tags=["消息管理"])
def create_compaction_checkpoint(request, session_id: str, payload: CompactionCheckpointRequest):
    """持久化 runtime 生成的上下文压缩检查点。"""
    import uuid
    from django.db import IntegrityError, transaction
    from ..models import ChatMessage

    # ：写路径——session-share grantee 只读，不得写压缩检查点。
    session, _is_shared = _get_session_with_shared_access(
        session_id, request.auth, include_session_share=False,
    )
    if not session:
        return error_response_with_status("NOT_FOUND", message=_("chat.session_not_found"), status_code=404)

    try:
        compacted_up_to_message_id = str(uuid.UUID(payload.compacted_up_to_message_id))
    except ValueError:
        return error_response_with_status(
            "BAD_REQUEST",
            message="compacted_up_to_message_id must be a UUID",
            status_code=400,
        )

    boundary = session.messages.filter(id=compacted_up_to_message_id).first()
    if not boundary:
        return error_response_with_status(
            "BAD_REQUEST",
            message=_("chat.message_not_found"),
            status_code=400,
        )

    client_event_id = None
    if payload.client_event_id:
        try:
            client_event_id = str(uuid.UUID(payload.client_event_id))
        except ValueError:
            return error_response_with_status(
                "BAD_REQUEST",
                message="client_event_id must be a UUID",
                status_code=400,
            )

    metadata = {
        "compaction_source": payload.source,
        "compacted_up_to_message_id": str(boundary.id),
        "focus": payload.focus,
        "stats": payload.stats or {},
    }
    metadata = {key: value for key, value in metadata.items() if value is not None}
    content_blocks = [{"type": "text", "text": payload.summary}]

    try:
        with transaction.atomic():
            if client_event_id:
                existing = session.messages.filter(client_event_id=client_event_id).first()
                if existing:
                    return success_response(data=CompactionCheckpointResponse(
                        message=_serialize_chat_message(existing),
                    ).model_dump(mode='json'))

            msg = ChatMessage.objects.create(
                session=session,
                role='system',
                message_kind='compaction_summary',
                content_blocks_json=content_blocks,
                text_summary=payload.summary[:200],
                metadata=metadata,
                client_event_id=client_event_id,
                sender_user_id=str(request.auth.id),
            )
    except IntegrityError:
        if client_event_id:
            existing = session.messages.filter(client_event_id=client_event_id).first()
            if existing:
                return success_response(data=CompactionCheckpointResponse(
                    message=_serialize_chat_message(existing),
                ).model_dump(mode='json'))
        raise

    session.compaction_count = (session.compaction_count or 0) + 1
    session.last_compaction_at = timezone.now()
    session.save(update_fields=['compaction_count', 'last_compaction_at', 'updated_at'])

    return success_response(data=CompactionCheckpointResponse(
        message=_serialize_chat_message(msg),
    ).model_dump(mode='json'))

_TIMELINE_ORDER_SQL = """
COALESCE(
  (
    SELECT MIN(
      CASE
        WHEN (block->>'arrival_seq')::numeric >= 10000000000000000
          THEN FLOOR((block->>'arrival_seq')::numeric / 1000)::bigint
        ELSE (block->>'arrival_seq')::bigint
      END
    )
    FROM jsonb_array_elements(content_blocks_json) AS block
    WHERE (block->>'arrival_seq') ~ '^[0-9]+$'
  ),
  (EXTRACT(EPOCH FROM created_at) * 1000000)::bigint
)
"""


# 大字段 block.type → 在 slim 模式下要 strip 的字段集合（v3 §3.3.8）
_SLIM_FIELD_STRIP_RULES: dict[str, set[str]] = {
    'thinking': {'thinking', 'signature'},  # thinking 文本可能 30 KB+
    'tool_use': {'input'},                   # tool_use.input 可能 20 KB+
    'tool_result': {'content'},              # tool_result.content 可能 50 KB+
    'mcp_tool_use': {'input'},
    'mcp_tool_result': {'content'},
    # tabtin_rich_content.payload 可能含 100KB+ 表格/图像数据，slim 走表层 summary
    'tabtin_rich_content': {'payload'},
}


def _is_local_file_artifact_block(block: dict) -> bool:
    """Local-file artifacts keep payload in list responses because it is the open contract."""
    payload = block.get('payload')
    return (
        block.get('type') == 'tabtin_rich_content'
        and block.get('kind') == 'file'
        and isinstance(payload, dict)
        and payload.get('artifact_kind') == 'local_file'
    )


def _is_oss_file_artifact_block(block: dict) -> bool:
    """#5477：oss_file 交付物同样保留 payload（file_id / access_url 是打开契约）。"""
    payload = block.get('payload')
    return (
        block.get('type') == 'tabtin_rich_content'
        and block.get('kind') == 'file'
        and isinstance(payload, dict)
        and payload.get('artifact_kind') == 'oss_file'
    )


def _is_plan_block(block: dict) -> bool:
    """#2857：plan 卡片 block 的 payload 只存 plan_ref 指针 + 轻量展示字段（无正文），
    体积小且是卡片渲染 / 执行的唯一数据来源——slim 时保留 payload，否则重启后
    历史列表拿不到 plan_ref，卡片无法恢复。"""
    return (
        block.get('type') == 'tabtin_rich_content'
        and block.get('kind') == 'plan'
    )


def _slim_content_blocks(
    blocks: list, *, strip_types: set[str] | None = None,
) -> list:
    """W3 §3.3.5 升级：从 ContentBlock[] 中 strip 大字段，节省带宽。

    Args:
        blocks: ContentBlock[] dict 列表
        strip_types: 显式指定要 strip 的 block.type 集合；None 时走默认策略
            （所有 type 都按 _SLIM_FIELD_STRIP_RULES 处理）

    Returns:
        新的 blocks 列表（不修改原列表）；strip 的字段被替换为
        `_slim_marker: True`，前端按此标识懒加载完整内容
        （`GET /messages/{mid}/blocks/{bid}/full`）。
    """
    if not blocks:
        return blocks
    result = []
    for block in blocks:
        if not isinstance(block, dict):
            result.append(block)
            continue
        bt = block.get('type', '')
        if strip_types is not None and bt not in strip_types:
            result.append(block)
            continue
        rules = _SLIM_FIELD_STRIP_RULES.get(bt)
        if not rules:
            result.append(block)
            continue
        if (
            _is_local_file_artifact_block(block)
            or _is_oss_file_artifact_block(block)
            or _is_plan_block(block)
        ):
            result.append(block)
            continue
        slimmed = {k: v for k, v in block.items() if k not in rules}
        # 标记为已 slim，便于前端识别 + 懒加载
        slimmed['_slim_marker'] = True
        slimmed['_slim_stripped'] = sorted(list(rules))
        result.append(slimmed)
    return result


def _parse_strip_types(raw: str | None) -> set[str] | None:
    """parse `?strip_types=thinking,tool_result` 入参——None 表示走默认策略。"""
    if not raw:
        return None
    types = {t.strip() for t in raw.split(',') if t.strip()}
    return types if types else None


def _looks_like_terminal_running_result(block: dict) -> bool:
    """该 tool_result 是否是「后台命令的 running 快照」（待被终态 supersede）。

    判别（廉价子串，不解析 JSON）——三个条件叠加精确命中 running 快照：
      - content 是字符串；
      - 含 `session_id`（终端 tool_result 特征——running 快照与终态 content 都带
        PTY agent session_id，见 background-task-terminal-result.ts）；
      - 含 `running`（running 快照 content 必有 `"status":"running"`，见 shell.ts
        前台超时返回分支）；
      - **不含** `_terminal_update`（那是终态独有标记——已是终态则无需 supersede）。

    收紧到「必含 running」的意义：前台**已完成**的终端结果（status="completed"、带
    session_id、无 `_terminal_update`）不再被误算成 supersede 候选——否则任何含终端
    卡片的历史加载都会越过早退、对 PendingToolResult 多查一次（虽空查无害但与
    docstring「稳态零命中直接 return」不符）。普通 tool_result（read_file 等）content
    不含 `session_id`，更是直接短路 False。
    """
    content = block.get('content')
    if not isinstance(content, str):
        return False
    if 'session_id' not in content or 'running' not in content:
        return False
    if '_terminal_update' in content:
        return False
    return True


def _heal_missing_tool_results(session_id: str, messages: list) -> None:
    """messages.list 读取自愈（治本路线 B 第三道防线）。

    对本批 assistant message，从 PendingToolResult 兜底补救两类落库缺口：

      A) **补缺失**：有 tool_use 但缺配对 tool_result（乱序 / 写时 drain 漏掉）→
         把 pending 的 tool_result 合并进 content_blocks_json。
      B) **终态 supersede**（t1 反序竞态根治）：present 的 tool_result 还是「终端
         running 快照」（content 带 session_id、无 `_terminal_update`），而
         PendingToolResult 里有同 tool_use_id 的 `_terminal_update` 终态 → 原地把
         running 块**替换**成终态。

    为什么需要 B：后台命令终态走 out-of-query relay 直发，可能赛赢仍卡在 in-query
    流里、尚未落库的 running 快照——终态先到时目标 assistant 还没合并 running 块，
    merge 匹配不到 → stash 进 pending（agent_run_id=''）；随后 running 才合并进
    **已存在** assistant。旧 heal 只补「完全缺 tool_result」，running 块一旦存在该
    tool_use_id 就进了 present 集合、heal 永远跳过 → assistant 永久 `status:running`
    转圈，终态烂在 pending 直到 24h GC。B 路径在读取时一定能自愈成终态。

    两类都同时更新内存对象（让本次响应即带上）、持久化回 DB、删除已 drain 的
    pending。PendingToolResult 稳态为空，绝大多数请求此函数零命中（无缺失 /
    无 running 终端候选直接 return，无 pending 直接 return，不触发额外写）。失败
    仅 log 不抛——绝不能因自愈失败阻断历史读取主流程。
    """
    from apps.chat.conversation.models import PendingToolResult
    from django.db import transaction

    # 1. 扫本批 assistant，收集两类待 pending 补救的 tool_use_id：
    #    a) missing：有 tool_use 但缺配对 tool_result（补缺失）
    #    b) running 终端快照：present 的 tool_result 仍是 running 快照（待终态 supersede）
    missing_candidates: list[tuple] = []    # (msg, run_id, missing:set)
    supersede_candidates: list[tuple] = []  # (msg, running_tuids:set)
    all_wanted: set[str] = set()
    for msg in messages:
        if getattr(msg, 'role', None) != 'assistant':
            continue
        blocks = msg.content_blocks_json if isinstance(msg.content_blocks_json, list) else []
        present = {
            b.get('tool_use_id') for b in blocks
            if isinstance(b, dict) and b.get('type') == 'tool_result'
        }
        missing = {
            b.get('id') for b in blocks
            if isinstance(b, dict) and b.get('type') == 'tool_use'
            and b.get('id') and b.get('id') not in present
        }
        if missing:
            missing_candidates.append((msg, msg.agent_run_id or '', missing))
            all_wanted |= missing
        running_tuids = {
            b.get('tool_use_id') for b in blocks
            if isinstance(b, dict) and b.get('type') == 'tool_result'
            and b.get('tool_use_id') and _looks_like_terminal_running_result(b)
        }
        if running_tuids:
            supersede_candidates.append((msg, running_tuids))
            all_wanted |= running_tuids
    if not all_wanted:
        return

    # 2. 一次查 pending（session + tool_use_id IN，走 session 索引收敛行数）。
    pendings = list(
        PendingToolResult.objects.filter(
            session_id=session_id, tool_use_id__in=all_wanted,
        )
    )
    if not pendings:
        return
    pend_by_tuid: dict[str, list] = {}
    for p in pendings:
        pend_by_tuid.setdefault(p.tool_use_id, []).append(p)

    # consumed 跨两路共享：保证一个 pending 只被消费一次（防重复 append / 误删）。
    consumed: set[int] = set()

    # 3a. 补缺失（内存 append + 末尾批量 save，原逻辑）。
    drained_ids: list[int] = []
    dirty_msgs: list = []
    for msg, run_id, missing in missing_candidates:
        touched = False
        for tuid in missing:
            for p in pend_by_tuid.get(tuid, []):
                if p.id in consumed:
                    continue
                # run_id 匹配：精确同 run，或 pending 降级暂存（agent_run_id 为空）。
                if p.agent_run_id and run_id and p.agent_run_id != run_id:
                    continue
                block = p.block_json if isinstance(p.block_json, dict) else None
                # 防串台：终态块（agent_run_id='' 暂存）**不**走补缺失首次 append——
                # 补缺失无已存在块可比对 PTY session_id，跨 run 重用同
                # `run_terminal_command:N` 时会把 A 命令终态贴到 B 的卡片上。终态只许
                # 走 supersede 路径（3b，带 session_id 护栏）；这里跳过、不消费，保留
                # pending 等对应 running 快照落库后被 supersede。
                if block is not None and _is_terminal_tool_result_update(block):
                    continue
                consumed.add(p.id)
                drained_ids.append(p.id)
                if block is None:
                    continue  # 坏数据，清掉继续试同 tuid 下一条
                msg.content_blocks_json = [*(msg.content_blocks_json or []), block]
                touched = True
                # P2-2：一个 tool_use_id 只补一条有效结果——避免同 tuid 多条 pending
                # （如 run_id='' 降级暂存 + run_id=R 各一条）都 append 造成重复 block。
                break
        if touched:
            dirty_msgs.append(msg)

    # 3b. 终态 supersede（复用 writer 的 merge——自带 session_id 防串台 + 幂等 +
    #     原地替换 + 自 save）。仅「终态 pending」能盖 running 快照；非终态 pending
    #     不参与（不会误把 running 盖到 running）。
    superseded_ids: list[int] = []
    if supersede_candidates:
        for msg, running_tuids in supersede_candidates:
            for tuid in running_tuids:
                for p in pend_by_tuid.get(tuid, []):
                    if p.id in consumed:
                        continue
                    block = p.block_json if isinstance(p.block_json, dict) else None
                    if not isinstance(block, dict) or not _is_terminal_tool_result_update(block):
                        continue  # 只有 _terminal_update 终态能 supersede running
                    ok = _merge_tool_result_block_into_message(
                        matched=msg, tr_block=block,
                        tool_use_id=tuid, session_id=session_id,
                    )
                    if ok:
                        consumed.add(p.id)
                        superseded_ids.append(p.id)
                        break  # 该 msg+tuid 已 supersede 成功
                    # ok=False（防串台 session_id 不匹配 / save 失败）→ 保留 pending，
                    # 继续试同 tuid 的下一条（跨 run 重用时让正确 msg 命中）。

    if not drained_ids and not superseded_ids:
        return

    # 4. 持久化补缺失更新 + 删除已 drain / supersede 的 pending（best-effort）。
    #    supersede 路径的 save 已在 _merge_tool_result_block_into_message 内提交，
    #    这里只统一删 pending（删失败残留由 24h GC 兜底，supersede 幂等可重入）。
    try:
        with transaction.atomic():
            for msg in dirty_msgs:
                msg.save(update_fields=['content_blocks_json', 'updated_at'])
            PendingToolResult.objects.filter(id__in=drained_ids + superseded_ids).delete()
        logger.info(
            "[messages.list] tool_result 读取自愈: session=%s healed_msgs=%d drained=%d superseded=%d",
            session_id, len(dirty_msgs), len(drained_ids), len(superseded_ids),
        )
    except Exception:
        logger.warning(
            "[messages.list] tool_result 读取自愈持久化失败（响应仍含已补齐内容）: session=%s",
            session_id, exc_info=True,
        )


@router.get("/sessions/{session_id}/messages", auth=jwt_auth, tags=["消息管理"])
def get_messages(
    request,
    session_id: str,
    limit: int = 50,
    share_id: str | None = None,
):
    """
    获取会话的消息列表。

    支持三种分页模式：
    - 游标分页（推荐）：传 before=<message_id> 获取更早的消息
    - 游标分页：传 after=<message_id> 获取更新的消息
    - **Wave 5 R3-01 新增**：传 around=<message_id> 获取该消息上下文窗口
      （前 limit/2 + 该消息 + 后 limit/2，最多 limit 条；用于消息精确锚定跳转）
    - offset 分页（兼容）：传 offset=<int> 偏移量

    增量同步：传 updated_after=<ISO8601> 仅返回该时间之后新增/更新的消息。

    当 session 处于软回滚状态时，自动过滤掉已回滚的消息。

    **W1b 新增 ?expand_artifacts=false 默认懒加载**（PRD §3.6.4）：
    - 默认（false）：SQL 加 `WHERE message_kind != 'tool_artifact'`，**只返回**
      LLM 主消息 + error_envelope；响应里给每条 LLM message 附 `has_artifacts:
      true/false` 让前端知道"还有产物气泡待展开"。
    - 显式 `?expand_artifacts=true`：返回全部 ChatMessage（含 tool_artifact 行）。
    背景：5 次 web_search = 5 条 tool_artifact 行 × 5-10KB widget block = 响应
    50KB+；分页语义按 LLM message 计算 turn 才稳定，tool_artifact 不应影响
    rollback / scrollToMessage 路径。前端历史回放默认走 expand=false。
    """
    from django.db.models import BigIntegerField, Q
    from django.db.models.expressions import RawSQL
    from django.utils.dateparse import parse_datetime

    session, _is_shared = _get_session_with_shared_access(
        session_id,
        request.auth,
        include_session_share=True,
        session_share_id=share_id,
    )
    if not session:
        return error_response_with_status("NOT_FOUND", message=_("chat.session_not_found"), status_code=404)

    limit = min(max(1, limit), MAX_MESSAGE_PAGE_SIZE)

    # 保留原始游标：非法 UUID 仍选对应 cursor 模式并返回空窗，
    # 不得把 around=hitl-review-* 静默降级成 offset 全页。
    before_raw = request.GET.get('before')
    after_raw = request.GET.get('after')
    around_raw = request.GET.get('around')  # Wave 5 R3-01
    updated_after_str = request.GET.get('updated_after')
    updated_before_str = request.GET.get('updated_before')
    sync_watermark = timezone.now()
    if updated_before_str:
        parsed_watermark = parse_datetime(updated_before_str)
        if parsed_watermark:
            sync_watermark = parsed_watermark
    # W1b 协议层 message_kind 懒加载（PRD §3.6.4）——默认 false，前端按需 true
    expand_artifacts = request.GET.get('expand_artifacts', '').lower() in ('1', 'true', 'yes')
    # ：hitl_interaction 默认不下发——旧 Electron / iOS / Android 不认识该 kind，
    # 会渲染成空 assistant 幽灵行。懂它的新客户端显式传 ?include_hitl_facts=1
    # （chat-client MessageManager 默认携带），拿到审批/追问事实用于面板派生与恢复。
    include_hitl_facts = request.GET.get('include_hitl_facts', '').lower() in ('1', 'true', 'yes')

    def _as_message_uuid(raw: str | None) -> str | None:
        """解析消息游标为 UUID 字符串。

         / ：非法值（如历史 hitl-review-*）不得进 UUIDField filter。
        调用方在「原始参数非空但本函数返回 None」时按 anchor 不存在处理（空窗），
        不要当作未传游标去走 offset。
        """
        if not raw:
            return None
        try:
            return str(uuid.UUID(str(raw)))
        except (ValueError, TypeError, AttributeError):
            return None

    around_id = _as_message_uuid(around_raw)
    before_id = _as_message_uuid(before_raw)
    after_id = _as_message_uuid(after_raw)

    # v0.1 宪法 §5.1：ChatMessage.model 软引用 UUIDField，不能 prefetch_related。
    # 列表场景下方调用 ``attach_llm_models_to_messages(messages)`` 批量预加载。
    # 消息行只作为持久化容器；真正时间线由 content_blocks_json[].arrival_seq
    # 在客户端消费时拍平聚合。服务端分页仍必须按同一事实裁剪，否则 limit/around
    # 会先按入库时间漏掉前端重排所需的 LLM / artifact 行。
    qs = session.messages.annotate(
        _timeline_order=RawSQL(_TIMELINE_ORDER_SQL, [], output_field=BigIntegerField()),
    ).order_by('_timeline_order', 'created_at', 'id')

    # W1b：expand_artifacts=false 时 SQL 过滤掉 tool_artifact 行，避免响应体积
    # 失控。tool_artifact 始终走单独懒加载（前端展开"产物气泡"时按 agent_run_id
    # 拉 ?expand_artifacts=true 的同一 endpoint 或单独 endpoint，未来 Wave 8 决定）。
    # 注意：error_envelope 始终保留（用户需要看到错误文案）。
    if not expand_artifacts:
        qs = qs.exclude(message_kind='tool_artifact')
    if not include_hitl_facts:
        qs = qs.exclude(message_kind='hitl_interaction')

    # 子 Agent 主消息（subagent_run_id 非空）随父 session 一起返回——它们是子 Agent
    # 详情 Pane「历史恢复」的唯一数据源（本地 jsonl 已废弃，统一以 chat_message 为
    # SSoT，支持跨端/云端恢复）。**隔离改由前端统一执行**：
    #   - 主 Agent 时间线：materializeMessagesForTimeline 按 subagent_run_id 过滤掉子消息；
    #   - 子 Agent 详情：按 subagent_run_id 分组渲染；
    #   - 聚合卡：父 tool_use.input + 配对 tool_result 的 [子 Agent ID] 反查 subagent_run_id。
    # 这样隔离只剩前端一处契约（subagent_run_id），不再散落多处后端兜底 exclude。
    # 注：fork / rollback / context_assembler / message_count 仍各自 exclude(subagent_run_id)
    # ——那是「不喂进 LLM 上下文 / 不计入会话消息数」的正确性，与时间线显示无关。

    if session.revert_message_id:
        revert_msg = session.messages.filter(id=session.revert_message_id).first()
        if revert_msg:
            qs = qs.filter(_build_revert_visible_message_filter(session, revert_msg))

    if updated_after_str:
        updated_after_dt = parse_datetime(updated_after_str)
        if updated_after_dt:
            qs = qs.filter(
                updated_at__gt=updated_after_dt,
                updated_at__lte=sync_watermark,
            )

    total = qs.count()
    # 以原始参数是否出现决定分页模式：非法 UUID 与「合法但不存在」同为空窗。
    if around_raw:
        pagination_mode = 'cursor_around'
    elif before_raw:
        pagination_mode = 'cursor_before'
    elif after_raw:
        pagination_mode = 'cursor_after'
    else:
        pagination_mode = 'offset'
    offset = 0

    def _before_timeline(order_value, created_at, message_id):
        return (
            Q(_timeline_order__lt=order_value) |
            Q(_timeline_order=order_value, created_at__lt=created_at) |
            Q(_timeline_order=order_value, created_at=created_at, id__lt=str(message_id))
        )

    def _after_timeline(order_value, created_at, message_id):
        return (
            Q(_timeline_order__gt=order_value) |
            Q(_timeline_order=order_value, created_at__gt=created_at) |
            Q(_timeline_order=order_value, created_at=created_at, id__gt=str(message_id))
        )

    if pagination_mode == 'cursor_around':
        # Wave 5 R3-01：around=<message_id> 取该消息的上下文窗口
        # 行为：前 half + 该消息 + 后 half；目标消息不在 session / 非法 UUID 时返回空
        # 让前端 chatSessionNavigation.loadContextWindow 走通
        if not around_id:
            messages = []
        else:
            anchor = qs.filter(id=around_id).values('id', 'created_at', '_timeline_order').first()
            if not anchor:
                messages = []
            else:
                half = max(1, limit // 2)
                # 前 half（含 anchor 之前）
                before_qs = qs.filter(
                    _before_timeline(anchor['_timeline_order'], anchor['created_at'], anchor['id'])
                ).order_by('-_timeline_order', '-created_at', '-id')[:half]
                before_list = list(before_qs)
                before_list.reverse()
                # 后 half（含 anchor 之后）
                after_qs = qs.filter(
                    _after_timeline(anchor['_timeline_order'], anchor['created_at'], anchor['id'])
                ).order_by('_timeline_order', 'created_at', 'id')[:half]
                anchor_msg = qs.filter(id=around_id).first()
                messages = before_list + ([anchor_msg] if anchor_msg else []) + list(after_qs)
                # 截断到 limit（防御性）
                messages = messages[:limit]
    elif pagination_mode == 'cursor_before':
        if not before_id:
            messages = []
        else:
            cursor_msg = qs.filter(id=before_id).values('created_at', '_timeline_order').first()
            if cursor_msg:
                qs = qs.filter(
                    _before_timeline(cursor_msg['_timeline_order'], cursor_msg['created_at'], before_id)
                )
            messages = list(qs.order_by('-_timeline_order', '-created_at', '-id')[:limit])
            messages.reverse()
    elif pagination_mode == 'cursor_after':
        if not after_id:
            messages = []
        else:
            cursor_msg = qs.filter(id=after_id).values('created_at', '_timeline_order').first()
            if cursor_msg:
                qs = qs.filter(
                    _after_timeline(cursor_msg['_timeline_order'], cursor_msg['created_at'], after_id)
                )
            messages = list(qs[:limit])
    else:
        try:
            offset = int(request.GET.get('offset', 0))
            if offset < 0:
                offset = 0
        except (ValueError, TypeError):
            offset = 0
        messages = list(qs[offset:offset + limit])

    oldest_id = str(messages[0].id) if messages else None
    newest_id = str(messages[-1].id) if messages else None

    if not messages:
        has_more = False
    elif pagination_mode == 'cursor_around':
        # around 模式 has_more 表达"窗口外是否还有"——用前后两端探测
        first = messages[0]
        last = messages[-1]
        has_more = (
            qs.filter(
                _before_timeline(first._timeline_order, first.created_at, first.id)
            ).exists()
            or qs.filter(
                _after_timeline(last._timeline_order, last.created_at, last.id)
            ).exists()
        )
    elif pagination_mode == 'cursor_before':
        first = messages[0]
        has_more = qs.filter(
            _before_timeline(first._timeline_order, first.created_at, first.id)
        ).exists()
    elif pagination_mode == 'cursor_after':
        last = messages[-1]
        has_more = qs.filter(
            _after_timeline(last._timeline_order, last.created_at, last.id)
        ).exists()
    else:
        has_more = (offset + len(messages)) < total

    # W3 §3.3.5：slim_blocks 参数升级——支持显式指定 strip type
    # ?slim_blocks=1 → 默认策略（所有大字段都 strip）
    # ?slim_blocks=1&strip_types=thinking,tool_result → 只 strip 这些 type
    # ?summary_only=1 → 只返回 text_summary + 元数据，不返 content_blocks_json
    slim = request.GET.get('slim_blocks', '').lower() in ('1', 'true', 'yes')
    strip_types = _parse_strip_types(request.GET.get('strip_types'))
    summary_only = request.GET.get('summary_only', '').lower() in ('1', 'true', 'yes')

    # 治本（路线 B 第三道防线）：读取自愈——把暂存的 tool_result 补回缺结果的
    # assistant message，根治重载对话时部分终端卡片永久"结果正在同步…"。
    # 失败不抛，绝不阻断历史读取。M4：summary_only 模式不返 content_blocks_json，
    # heal 无意义且会引入无谓 DB 写，直接跳过。
    if not summary_only:
        try:
            _heal_missing_tool_results(str(session.id), messages)
        except Exception:
            logger.warning("[messages.list] tool_result 读取自愈异常（不阻断响应）", exc_info=True)

    # v0.1 宪法 §5.1：批量预加载软引用 LLMModel，让下方 msg.model 直接命中缓存
    from ..services.llm_model_loader import attach_llm_models_to_messages
    attach_llm_models_to_messages(messages)

    _attach_sender_display_names(messages)

    checkpoint_summaries_by_hash = _get_space_checkpoint_summaries(
        session,
        [
            msg.checkpoint_hash
            for msg in messages
            if msg.role == 'assistant' and msg.checkpoint_hash
        ],
    )

    # ── W1b has_artifacts 一次 SQL 计算（避免 N+1，PRD §3.6.4）────────────
    # 把本批 LLM 主消息的 agent_run_id 集合一次查"是否有同 run_id 的 tool_artifact"，
    # 让前端按需展开"产物气泡"。
    #
    # SQL：SELECT DISTINCT agent_run_id FROM chat_message
    #      WHERE session_id=? AND message_kind='tool_artifact' AND agent_run_id IN (...)
    #
    # 优化点：
    # - 只对 LLM 主消息计算（tool_artifact / error_envelope 自身 has_artifacts 始终 false）
    # - 查询走 session_id 索引（filter session）+ agent_run_id 单字段 db_index（IN 收敛）；
    #   message_kind 没建索引，靠 session_id 过滤后小集合扫描——单 session 通常 < 100 条消息，
    #   性能可接受（无需复合索引）
    # - 即便 expand_artifacts=true（tool_artifact 已在结果集中）也照算——前端
    #   未来可能想"标记 LLM 消息是否有 artifact"做高亮
    #
    # 极端场景：本批没 LLM 主消息（譬如只有 user / system / error_envelope）→ 跳过
    # 查询省 SQL（agent_run_ids 集合为空，has_artifacts 给所有消息都是 false）。
    from ..models import ChatMessage as _ChatMessage

    llm_run_ids = {
        msg.agent_run_id
        for msg in messages
        if msg.message_kind == 'llm' and msg.agent_run_id
    }
    from apps.agent.models import Agent
    agent_faces = {}
    for agent in Agent.objects.filter(
        id__in={msg.agent_id for msg in messages if msg.agent_id},
    ).only("id", "name", "settings"):
        settings = agent.settings if isinstance(agent.settings, dict) else {}
        avatar = settings.get("avatar_url")
        agent_faces[str(agent.id)] = {
            "name": (agent.name or "").strip() or None,
            "avatar": (avatar.strip() or None) if isinstance(avatar, str) else None,
        }
    run_ids_with_artifacts: set[str] = set()
    if llm_run_ids:
        run_ids_with_artifacts = set(
            _ChatMessage.objects.filter(
                session_id=session_id,
                message_kind='tool_artifact',
                agent_run_id__in=llm_run_ids,
            ).values_list('agent_run_id', flat=True).distinct()
        )

    def _build_blocks_for_response(msg) -> list:
        """根据 slim / summary_only 参数决定返回什么 blocks。"""
        if summary_only:
            return []
        raw = msg.content_blocks_json or []
        if not slim:
            return raw
        return _slim_content_blocks(raw, strip_types=strip_types)

    def _content_for_response(msg) -> str:
        """API `content` 字段：user 消息返回全文，其余角色仍用 text_summary（200 字）。

        user 气泡在 Electron 直接渲染 `message.content`（不走 content_blocks_json
        拼正文）。若此处误用 text_summary，mergeMessagesFromServer 用服务端版本
        覆盖本地乐观消息后，长提示词会在 UI 上被截断到 200 字。
        """
        if msg.role == 'user':
            from apps.services.common.ws.handlers.content_block_reassembler import (
                derive_full_text_content,
            )
            blocks = msg.content_blocks_json if isinstance(msg.content_blocks_json, list) else []
            full = derive_full_text_content(blocks)
            if full:
                return full
        return msg.text_summary or ''

    message_list = [
        ChatMessageSchema(
            id=str(msg.id),
            role=msg.role,
            agent_id=str(msg.agent_id) if msg.agent_id else None,
            agent_name=(agent_faces.get(str(msg.agent_id)) or {}).get("name") if msg.agent_id else None,
            agent_avatar=(agent_faces.get(str(msg.agent_id)) or {}).get("avatar") if msg.agent_id else None,
            client_event_id=str(msg.client_event_id) if msg.client_event_id else None,
            content=_content_for_response(msg),
            # W4c：API 字段名 `blocks_json` → `content_blocks_json`（对齐 W3 Model
            # ChatMessage.content_blocks_json 字段名；前端 W4c 同步切换
            # packages/tabtin-chat-client/src/types/message.ts ChatMessage 接口）
            content_blocks_json=_build_blocks_for_response(msg),
            # W3：attachments_json 已下线（并入 content_blocks_json 的 image/document/file 块）
            attachments_json=[],
            # W3：agent_type / intent 已下线
            agent_type=None,
            intent=None,
            trace_id=str(msg.trace_id) if msg.trace_id else None,
            model_id=str(msg.model_id) if msg.model_id else None,
            model_name=msg.model.model_name if msg.model else (msg.model_name_snapshot or None),
            sender_user_id=getattr(msg, "_sender_user_id_for_response", None),
            sender_display_name=getattr(msg, "_sender_display_name_for_response", None),
            checkpoint_hash=msg.checkpoint_hash,
            checkpoint_state_index=msg.checkpoint_state_index,
            diff_summary=msg.diff_summary,
            # 每条已完成 assistant turn 都是可回退的对话锚点。没有文件/资源
            # 快照时 _build_checkpoint_record 会返回 degraded，让客户端明确显示
            # "回退到这里"，同时如实说明外部副作用无法完整恢复。
            checkpoint_record=(
                _build_checkpoint_record(
                    msg,
                    space_checkpoint=checkpoint_summaries_by_hash.get(msg.checkpoint_hash or ''),
                )
                if msg.role == 'assistant'
                else None
            ),
            agent_run_id=msg.agent_run_id or None,
            metadata=msg.metadata if msg.metadata else None,
            # ── W3 §3.3.1 新顶层结构化字段 ────────────────────────────
            text_summary=msg.text_summary or None,
            stop_reason=msg.stop_reason or None,
            usage_json=msg.usage_json,
            error_info_json=msg.error_info_json,
            subagent_run_id=msg.subagent_run_id or None,
            model_name_snapshot=msg.model_name_snapshot or None,
            checkpoint_anchor_block_id=msg.checkpoint_anchor_block_id or None,
            checkpoint_anchor_block_index=msg.checkpoint_anchor_block_index,
            # ── W1b 协议层 message_kind 字段（PRD §3.6.1）────────────
            message_kind=msg.message_kind,
            # has_artifacts：仅 LLM 主消息可能 true（tool_artifact 自身不展开自己）
            has_artifacts=(
                msg.message_kind == 'llm'
                and bool(msg.agent_run_id)
                and msg.agent_run_id in run_ids_with_artifacts
            ),
            #  引用回复：reply_to_id 是 FK 列值（无需额外查询），preview 是快照
            reply_to_message_id=str(msg.reply_to_id) if msg.reply_to_id else None,
            reply_to_preview=msg.reply_to_preview if msg.reply_to_preview else None,
            created_at=msg.created_at,
            updated_at=msg.updated_at,
        )
        for msg in messages
    ]
    # PRD-04 Wave 5 任务 1：从 BillingRuntimeConfig 读 show_per_message_cost。
    # 没配置或读失败时保守返回 False，对齐 Django 侧默认（避免意外向用户暴露费用）。
    try:
        from apps.services.billing.services.runtime_config_service import BillingConfigService
        show_cost = bool(BillingConfigService.get('show_per_message_cost', False))
    except Exception:
        show_cost = False

    return success_response(data=MessageListResponse(
        messages=message_list,
        total=total,
        has_more=has_more,
        oldest_id=oldest_id,
        newest_id=newest_id,
        server_timestamp=sync_watermark,
        show_per_message_cost=show_cost,
    ).model_dump(mode='json'))


@router.get("/messages/{message_id}/blocks/{block_id}/full", auth=jwt_auth, tags=["消息管理"])
def get_block_full(request, message_id: str, block_id: str):
    """W3 §3.3.8 超长 block 全文懒加载端点。

    场景：API list 返回 `?slim_blocks=1` 时，大字段（thinking / tool_use.input /
    tool_result.content / tabtin_rich_content.payload）会被替换为
    `_slim_marker: True` 占位。前端"展开全部"按钮触发本端点拉完整内容。

    实现策略（W3 起步版本）：
    - daemon 端 v3 §3.3.8 截断 + 冷存策略尚未完整实施（拆 W3 后续迭代或 Wave 8）
    - 本端点直接返回 content_blocks_json 中对应 block_id 的完整体（未截断时返
      原数据；已截断时返截断后的 inline 部分——即与 list 默认 strip 相比
      此处不做额外 strip）
    - Schema：`{ "block": ContentBlock, "block_id": str, "is_full": bool }`
      `is_full=True` 表示已是完整内容；`False` 表示 daemon 端有截断，
      完整内容需走 S3 冷存（v3 §3.3.8 待实施）

    权限：与 list 端点共用 `_get_session_with_shared_access` 校验——只有 session
    所属用户 / shared 用户能拉本 message 的 block。
    """
    from ..models import ChatMessage

    msg = ChatMessage.objects.filter(pk=message_id).select_related('session').first()
    if not msg:
        return error_response_with_status(
            "NOT_FOUND", message=_("chat.message_not_found"), status_code=404,
        )

    session, _is_shared = _get_session_with_shared_access(
        str(msg.session_id), request.auth, include_session_share=True,
    )
    if not session:
        return error_response_with_status(
            "PERMISSION_DENIED",
            message=_("chat.session_access_denied"),
            status_code=403,
        )

    visible_qs = session.messages.exclude(subagent_run_id__gt='').filter(pk=msg.pk)
    if session.revert_message_id:
        revert_msg = session.messages.filter(id=session.revert_message_id).first()
        if revert_msg:
            visible_qs = visible_qs.filter(_build_revert_visible_message_filter(session, revert_msg))
    if not visible_qs.exists():
        return error_response_with_status(
            "NOT_FOUND",
            message=_("chat.message_not_found"),
            status_code=404,
        )

    blocks = msg.content_blocks_json or []
    target_block = None
    target_idx = None
    for idx, block in enumerate(blocks):
        if not isinstance(block, dict):
            continue
        if block.get('block_id') == block_id or block.get('id') == block_id:
            target_block = block
            target_idx = idx
            break

    if target_block is None:
        return error_response_with_status(
            "NOT_FOUND",
            message=_("chat.block_not_found"),
            status_code=404,
        )

    # is_full 判别：daemon 端截断时会留 `_truncated: True` 标识（v3 §3.3.8 约定）；
    # 暂未实施时所有 block 都是 full
    is_full = not target_block.get('_truncated', False)

    return success_response(data={
        "block": target_block,
        "block_id": block_id,
        "block_index": target_idx,
        "message_id": message_id,
        "is_full": is_full,
        "trimmed_at": (
            msg.content_blocks_trimmed_at.isoformat()
            if msg.content_blocks_trimmed_at else None
        ),
    })


@router.post(
    "/sessions/{session_id}/withdraw-unanswered",
    auth=jwt_auth,
    response={200: dict, 400: dict, 401: dict, 403: dict, 404: dict},
    tags=["消息"],
)
def withdraw_unanswered_turn(request, session_id: str, data: WithdrawUnansweredRequest = Body(...)):
    """#6154 Composer Stop 撤回未答轮次。

    物理删除该 user 及之后半截消息，**不**进入 checkpoint soft revert：
    不写 revert_message_id、不插「回退完成」系统气泡、不出现「恢复原状」横幅。
    由主进程 / runtime 在本地 transcript commit 后调用（非渲染进程直打）。

    ：删除逻辑下沉至 ``withdraw_unanswered_messages``（含服务端实质输出复判
    + 审计快照）；本端点仍要求 ``runtime_withdraw_applied`` 门禁。
    """
    from ..services.withdraw_unanswered import withdraw_unanswered_messages

    if not data.runtime_withdraw_applied:
        return error_response_with_status(
            "VALIDATION_ERROR",
            message=_("chat.withdraw_runtime_first_required", default="请先由 runtime 完成本地撤回"),
            status_code=400,
        )

    client_message_id = (data.client_message_id or "").strip()
    if not client_message_id:
        return error_response_with_status(
            "VALIDATION_ERROR",
            message=_("chat.client_message_id_required", default="client_message_id 必填"),
            status_code=400,
        )

    try:
        uuid.UUID(client_message_id)
    except (ValueError, TypeError):
        return error_response_with_status(
            "VALIDATION_ERROR",
            message=_("chat.client_message_id_invalid", default="client_message_id 非法"),
            status_code=400,
        )

    # ：写路径（撤回消息）——session-share grantee 只读，不放行。
    session, _is_shared = _get_session_with_shared_access(
        session_id, request.auth, include_session_share=False,
    )
    if not session:
        return error_response_with_status(
            "NOT_FOUND", message=_("chat.session_not_found"), status_code=404,
        )

    result = withdraw_unanswered_messages(
        session=session,
        client_message_id=client_message_id,
        actor=request.auth,
        source="electron_runtime",
    )
    deleted_count = int(result.get("deleted_count") or 0)
    restored_title = result.get("restored_title")

    logger.info(
        "[withdraw-unanswered] session=%s client=%s deleted=%s applied=%s reason=%s title_reset=%s",
        session_id,
        client_message_id,
        deleted_count,
        result.get("withdraw_applied"),
        result.get("reason"),
        bool(restored_title),
    )
    return success_response(data=WithdrawUnansweredResponse(
        success=True,
        deleted_count=deleted_count,
        title_reset=bool(restored_title),
        title=restored_title,
        title_generation_status="pending" if restored_title else None,
        message=(
            _("chat.withdraw_ok", default="已撤回未答消息")
            if deleted_count > 0
            else _("chat.withdraw_not_persisted", default="目标消息尚未落库，无需服务端删除")
        ),
    ).model_dump(mode="json"))
