"""从投影 turns 物化新会话的公共服务。

通用能力：把一段「已脱敏 / 已冻结」的对话 turns 抄写成某用户自己的
Agent × Workspace 新会话。当前消费方是共享任务 shared-fork；后续「接力
take-over」会用冻结快照 turns 调同一函数——因此参数不绑死 share 概念，
来源信息统一走 ``source_meta``（{source_type, source_id, ...}）。

落库结构（按时间序 / Agent 上下文序）：
1. 一条人可读 briefing（``metadata.share_briefing=true``）；
2. 一条 LLM 契约（``metadata.share_contract=true``）：
   ``build_user_context_wrapper`` 存在时用它包 contract_payload（wrapper type
   由 ``contract_wrapper_type`` 指定，默认 "session-share-fork"，接力
   take-over 传 "handoff-take-over"），否则退化为结构化 JSON 文本；
3. 快照消息：每个 turn 一条 ChatMessage（保留原 created_at，
   ``metadata.share_snapshot=true``，content_blocks_json 优先使用清洗后的
   结构化 blocks，兼容旧调用方的 text-only turn）。

briefing / 契约走 ``role=system`` + ``message_kind=environment_context``——
与既有环境注入同通道：UI 隐藏、进 LLM 历史（recovery + cross-turn），
并排在快照**之前**作为上下文开头。

**不写 ConversationState**：接收人首轮发消息时走「无 PG 状态」的恢复口径，
由 runtime 从 ChatMessage 历史重建上下文——与 v1 接力（take-over）同策略，
物化层不伪造一份可能与快照口径不一致的引擎状态。
"""

from __future__ import annotations

import json
import logging
from datetime import timedelta

from django.db import transaction
from django.utils import timezone

from ..models import ChatContext, ChatMessage, ChatSession

logger = logging.getLogger(__name__)

_TITLE_MAX_LEN = 255
_TEXT_SUMMARY_MAX_LEN = 200
_BULK_BATCH_SIZE = 500
_TOOL_ONLY_TEXT_SUMMARY = "[工具调用]"

_DEFAULT_CONTRACT_WRAPPER_TYPE = "session-share-fork"


def _resolve_agent_default_mode(agent) -> str:
    """对齐 create_session 的口径：会话初始 agent_mode 取 Agent 模板默认
    （Agent.settings.default_mode，），缺省为空串（前端回退自身默认）。"""
    try:
        settings = agent.settings or {}
        return str(settings.get("default_mode") or "")
    except Exception:
        return ""


def _build_contract_body(contract_payload: dict, wrapper_type: str) -> str:
    """契约消息正文：优先用 user_context_wrapper 包裹（与 runtime 注入格式
    对齐，便于跨轮识别）；wrapper 不可用时退化为结构化 JSON 文本。"""
    payload_text = json.dumps(contract_payload, ensure_ascii=False, indent=2)
    try:
        from apps.services.agent_execution.user_context_wrapper import (
            build_user_context_wrapper,
        )
    except ImportError:
        build_user_context_wrapper = None
    if build_user_context_wrapper is not None:
        return build_user_context_wrapper(wrapper_type, payload_text)
    return f"[{wrapper_type}]\n{payload_text}"


def _anchor_context_messages_before_snapshots(
    context_messages: list[ChatMessage],
    snapshot_timestamps: list,
) -> None:
    """把 briefing / 契约的 created_at 锚到最早快照之前，保证上下文开头。"""
    if not context_messages:
        return
    earliest = None
    for ts in snapshot_timestamps:
        if ts is None:
            continue
        if earliest is None or ts < earliest:
            earliest = ts
    if earliest is None:
        # 无快照时间戳：用当前时刻往前排，仍保持 briefing → contract 序
        earliest = timezone.now()
    dirty: list[ChatMessage] = []
    total = len(context_messages)
    for index, msg in enumerate(context_messages):
        # briefing 更靠前：earliest - N 秒、earliest - (N-1) …
        msg.created_at = earliest - timedelta(seconds=total - index)
        dirty.append(msg)
    ChatMessage.objects.bulk_update(dirty, ["created_at"], batch_size=_BULK_BATCH_SIZE)


def materialize_session_from_turns(
    *,
    user,
    organization_id: str,
    agent,
    workspace,
    title: str,
    turns: list[dict],
    briefing_text: str,
    contract_payload: dict,
    source_meta: dict,
    contract_wrapper_type: str = _DEFAULT_CONTRACT_WRAPPER_TYPE,
) -> ChatSession:
    """把投影 turns 物化成 ``user`` 自己的新 ChatSession。

    Args:
        user: 新会话 owner（接收人）。
        organization_id: 新会话组织归属。
        agent: 接收人自己的 Agent 实例（调用方已完成归属校验）。
        workspace: 接收人自己的 Workspace 实例（可为 None = observer 会话）。
        title: 新会话标题（超长截断）。
        turns: [{role, text?, blocks?, created_at?, message_kind?}]；
            role 仅接受 user / assistant，其余角色行跳过；
            ``message_kind='tool_artifact'`` 落成产物行（TurnArtifactsCard
            主数据源），其余默认 ``llm``；blocks 与 text 均为空的行跳过。
        briefing_text: 人可读的来源说明（environment_context 正文）。
        contract_payload: LLM 契约载荷（dict），随契约 environment_context 落库。
        source_meta: 来源信息 {source_type, source_id, ...}，写进各消息
            metadata 供 briefing / 契约措辞与审计追溯；不绑死 share 概念。

    Returns:
        新建的 ChatSession（title_generation_status 保持 pending，对齐 fork
        姿势：首轮新消息触发自动重命名）。
    """
    source_meta = dict(source_meta or {})

    with transaction.atomic():
        session = ChatSession.objects.create(
            user=user,
            organization_id=str(organization_id),
            agent_id=agent.id,
            workspace_id=workspace.id if workspace is not None else None,
            agent_mode=_resolve_agent_default_mode(agent),
            title=(title or "")[:_TITLE_MAX_LEN],
        )

        # ── 上下文开头：briefing + 契约（UI 隐藏，喂 LLM）──────────────
        context_messages: list[ChatMessage] = []
        briefing_text = (briefing_text or "").strip()
        if briefing_text:
            context_messages.append(ChatMessage.objects.create(
                session=session,
                role="system",
                message_kind="environment_context",
                content_blocks_json=[{"type": "text", "text": briefing_text}],
                text_summary=briefing_text[:_TEXT_SUMMARY_MAX_LEN],
                metadata={"share_briefing": True, "source": source_meta},
            ))

        contract_body = _build_contract_body(
            contract_payload or {}, contract_wrapper_type,
        )
        context_messages.append(ChatMessage.objects.create(
            session=session,
            role="system",
            message_kind="environment_context",
            content_blocks_json=[{"type": "text", "text": contract_body}],
            text_summary=contract_body[:_TEXT_SUMMARY_MAX_LEN],
            metadata={"share_contract": True, "source": source_meta},
        ))

        # ── 快照消息（保留原 created_at，排在上下文注入之后）──────────
        snapshot_messages: list[ChatMessage] = []
        original_timestamps: list = []
        for turn in turns or []:
            if not isinstance(turn, dict):
                continue
            role = turn.get("role")
            text = turn.get("text")
            raw_kind = str(turn.get("message_kind") or "llm").strip()
            message_kind = raw_kind if raw_kind in {"llm", "tool_artifact"} else "llm"
            if message_kind == "tool_artifact":
                role = "assistant"
            elif role not in ("user", "assistant"):
                continue
            text = text if isinstance(text, str) else ""
            blocks = turn.get("blocks")
            if isinstance(blocks, list):
                content_blocks = [block for block in blocks if isinstance(block, dict)]
            else:
                content_blocks = []
            if not content_blocks and text.strip():
                content_blocks = [{"type": "text", "text": text}]
            if not content_blocks:
                continue
            text_summary = text[:_TEXT_SUMMARY_MAX_LEN]
            if not text_summary and any(
                isinstance(block, dict)
                and str(block.get("type") or "").endswith("tool_use")
                for block in content_blocks
            ):
                text_summary = _TOOL_ONLY_TEXT_SUMMARY
            snapshot_messages.append(ChatMessage(
                session=session,
                role=role,
                message_kind=message_kind,
                content_blocks_json=content_blocks,
                text_summary=text_summary,
                metadata={"share_snapshot": True, "source": source_meta},
            ))
            original_timestamps.append(turn.get("created_at"))

        if snapshot_messages:
            ChatMessage.objects.bulk_create(
                snapshot_messages, batch_size=_BULK_BATCH_SIZE,
            )
            # auto_now_add 会覆盖 created_at；对齐 fork 复制姿势，bulk_update
            # 回写原对话时间。
            dirty: list[ChatMessage] = []
            for msg, ts in zip(snapshot_messages, original_timestamps):
                if ts is not None:
                    msg.created_at = ts
                    dirty.append(msg)
            if dirty:
                ChatMessage.objects.bulk_update(
                    dirty, ["created_at"], batch_size=_BULK_BATCH_SIZE,
                )
            from .workspace_file import index_message_workspace_file_refs

            for msg in snapshot_messages:
                index_message_workspace_file_refs(msg)

        _anchor_context_messages_before_snapshots(
            context_messages, original_timestamps,
        )

        # ── ChatContext 初始化（对齐 create_session 姿势；无协作 Project）──
        try:
            ChatContext.objects.get_or_create(
                session=session,
                defaults={"current_project_id": None},
            )
        except Exception:
            logger.warning(
                "materialize_session_from_turns: init ChatContext failed session=%s",
                session.id, exc_info=True,
            )

        session.last_message_at = (
            original_timestamps[-1]
            if original_timestamps and original_timestamps[-1] is not None
            else session.created_at
        )
        session.save(update_fields=["last_message_at"])

    # FTS Outbox：bulk_create 不触发 post_save，显式补投（对齐 fork 姿势；
    # 失败不阻断物化主流程）。
    if snapshot_messages:
        try:
            from apps.fts.services.sync_service import enqueue_messages_bulk_created

            for msg in snapshot_messages:
                msg.session = session
            enqueue_messages_bulk_created(snapshot_messages)
        except Exception:
            logger.exception("[FTS] materialize bulk_create outbox enqueue failed")

    return session
