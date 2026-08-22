"""
Stage E — 持久化层

从 ChatService 提取的持久化相关方法：MySQL/PG 写入、补偿、trace 关联。
"""

from typing import Dict, Any, Optional, List
import logging
import time
import uuid as _uuid_mod

from .user_attachment_contract import canonical_user_blocks


def _stamp_block_arrival(blocks: List[dict]) -> List[dict]:
    """给 user content_block 补块级抵达事实（arrival_seq/arrived_at）。

    与 reassembler / relay 同口径：微秒尺度（JS Number 安全整数内）。
    历史回放排序以 block.arrival_seq 为权威；user 块缺该字段会回落到
    created_at 量级，与 assistant 的微秒级 arrival_seq 不可比，导致顺序错乱。
    """
    from django.utils import timezone as _tz

    base_seq = time.time_ns() // 1000
    arrived_at = _tz.now().isoformat()
    stamped: List[dict] = []
    for idx, block in enumerate(blocks):
        if not isinstance(block, dict):
            stamped.append(block)
            continue
        next_block = dict(block)
        if not isinstance(next_block.get("arrival_seq"), int):
            next_block["arrival_seq"] = base_seq + idx
        if not isinstance(next_block.get("arrived_at"), str):
            next_block["arrived_at"] = arrived_at
        stamped.append(next_block)
    return stamped

from apps.services.common.chat_stream_publisher import (
    ChatStreamPublisher as Publisher,
)

logger = logging.getLogger(__name__)


def _coerce_client_event_uuid(value: Optional[str]):
    """把客户端 client_message_id 字符串安全转成 ``uuid.UUID``。

    非合法 UUID 返回 None，调用方跳过
    ``ChatMessage.client_event_id`` 字段写入即可。
    """
    if not value:
        return None
    try:
        return _uuid_mod.UUID(str(value))
    except (ValueError, TypeError, AttributeError):
        return None


def resolve_sender_attribution(
    default_sender_user_id: str,
    app_context: Optional[Dict[str, Any]],
) -> tuple[str, Optional[Dict[str, Any]]]:
    """#7744 共享对话发言归属：解析用户消息的 ``(sender_user_id, 附加 metadata)``。

    shared-chat 端点以 **owner** 执行身份 dispatch（费用 / 设备 / 审批都归
    owner），但这条 user 消息的**发言人**是 grantee——端点在 ``app_context``
    里带 ``_shared_chat_by=<grantee_id>``，这里据此覆盖 sender 并生成
    ``{shared_chat: true, shared_chat_by, share_id}`` metadata 标记。

    既有调用方（Tracker / channel / delegation / IPC）不带该 key → 原样返回
    ``(default_sender_user_id, None)``，行为不变。
    """
    shared_chat_by = str((app_context or {}).get("_shared_chat_by") or "").strip()
    if not shared_chat_by:
        return default_sender_user_id, None
    metadata: Dict[str, Any] = {
        "shared_chat": True,
        "shared_chat_by": shared_chat_by,
    }
    share_id = (app_context or {}).get("share_id")
    if share_id:
        metadata["share_id"] = str(share_id)
    return shared_chat_by, metadata


# ────────────────────────────────────────────────────────
#  Thread / Session 持久化
# ────────────────────────────────────────────────────────

def ensure_thread_id(session, session_id: str) -> str:
    """
    获取或写入会话对应的 thread_id

    规则：默认使用 chat-session-{session_id}
    """
    if getattr(session, "thread_id", None):
        return session.thread_id

    thread_id = f"chat-session-{session_id}"
    session.thread_id = thread_id
    session.save(update_fields=["thread_id"])
    return thread_id


def persist_user_messages(
    session,
    messages: List[str],
    user_message_ids: Optional[List[str]],
    model_instance,
    blocks: Optional[list],
    attachments: Optional[list],
    sender_user_id: str = '',
    client_message_id: Optional[str] = None,
    extra_metadata: Optional[Dict[str, Any]] = None,
    reply_to_message_id: Optional[str] = None,
    reply_to_preview: Optional[Dict[str, Any]] = None,
) -> list:
    """创建或恢复用户 ChatMessage 记录，返回 ChatMessage 列表。"""
    from apps.chat.conversation.models import ChatMessage

    result: list = []
    id_map: Dict[str, Any] = {}
    if user_message_ids:
        existing = ChatMessage.objects.filter(session=session, id__in=user_message_ids)
        id_map = {str(item.id): item for item in existing}

    # Wave 1（iOS thin client）：把客户端 UUID 写进 ``client_event_id`` 字段，
    # 让 Daemon relay 回来的 ``agent.stream.user`` 事件在 relay_message_writer
    # 里按 ``(session, client_event_id)`` 唯一约束做幂等 upsert，合并到同一行
    # ChatMessage，避免 user 消息出现两条。同时保留 metadata.client_message_id
    # 以兼容旧消费者（如 channel_gateway / 老版前端）。
    _client_event_uuid = _coerce_client_event_uuid(client_message_id)

    from django.db import IntegrityError, transaction

    from apps.services.common.ws.handlers.content_block_reassembler import (
        derive_text_summary,
    )

    for idx, content in enumerate(messages):
        candidate_id = (user_message_ids[idx] if user_message_ids and idx < len(user_message_ids) else None)
        message_obj = id_map.get(candidate_id) if candidate_id else None
        if not message_obj:
            # W3 §3.3.1：ChatMessage 已收口为 content_blocks_json + text_summary，
            # 旧 content / blocks_json 字段已删除（TS-24 forward 路径此前静默失败）。
            text_content = content or ""
            content_blocks = canonical_user_blocks(text_content, blocks, attachments)
            content_blocks = _stamp_block_arrival(content_blocks)
            summary = derive_text_summary(content_blocks) or (
                text_content[:200] if text_content else ""
            )
            # v0.1 宪法 §5.1：ChatMessage.model 已退化为软引用 UUIDField + property，
            # 不再支持 ``model=instance`` FK 赋值；必须用 ``model_id=instance.id``。
            create_kwargs: Dict[str, Any] = dict(
                session=session,
                role="user",
                content_blocks_json=content_blocks,
                text_summary=summary,
                model_id=model_instance.id if model_instance else None,
            )
            if sender_user_id:
                create_kwargs["sender_user_id"] = sender_user_id
            if idx == 0 and reply_to_message_id:
                try:
                    reply_to_uuid = _uuid_mod.UUID(str(reply_to_message_id))
                    if ChatMessage.objects.filter(id=reply_to_uuid, session=session).exists():
                        create_kwargs["reply_to_id"] = reply_to_uuid
                except (ValueError, TypeError):
                    pass
            if idx == 0 and isinstance(reply_to_preview, dict):
                create_kwargs["reply_to_preview"] = reply_to_preview
            metadata = dict(extra_metadata or {})
            if idx == 0:
                if client_message_id:
                    metadata["client_message_id"] = client_message_id
                # 仅首条消息携带客户端 UUID（一次 send_message 调用 = 一条上行
                # 用户消息 + 可能多条 collect 队列旧消息合并；UUID 只代表此次
                # 入站的那条）。
                if _client_event_uuid is not None:
                    create_kwargs["client_event_id"] = _client_event_uuid
                    # 单一身份收口：用客户端 UUID 作 ChatMessage.id，与 relay
                    # 路径（_upsert_chat_message）及前端乐观 id 一致，落库与前端从创建
                    # 起同一个 id，消除 client_event_id≠server_id 分裂。撞库时下方
                    # IntegrityError 兜底按 client_event_id 复用既有行。
                    create_kwargs["id"] = _client_event_uuid
            if metadata:
                create_kwargs["metadata"] = metadata
            try:
                # 外层请求 / 测试可能已经处于 atomic block。唯一键冲突必须在
                # 独立 savepoint 内回滚，否则即使捕获 IntegrityError，连接仍被
                # 标记 needs_rollback，后续复用既有 client_event_id 的查询会失败。
                with transaction.atomic():
                    message_obj = ChatMessage.objects.create(**create_kwargs)
            except IntegrityError:
                # (session, client_event_id) 唯一约束撞库——
                # 极端竞态场景：Daemon 的 agent.stream.user relay 已先写入，
                # 或客户端重发但 Redis 5s 去重窗口已过。直接复用既有行，
                # relay 路径会用同一 server_id 回包让客户端 temp-id → server-id 闭合。
                if _client_event_uuid is None:
                    raise
                existing = ChatMessage.objects.filter(
                    session=session, client_event_id=_client_event_uuid,
                ).first()
                if existing is None:
                    raise
                logger.info(
                    "[persist_user_messages] Reused existing user msg by client_event_id=%s session=%s",
                    _client_event_uuid, session.id,
                )
                # daemon 回显可能先落空 blocks 行——补写 prompt 正文（TS-24）
                if content_blocks and not (existing.content_blocks_json or []):
                    existing.content_blocks_json = _stamp_block_arrival(content_blocks)
                    existing.text_summary = summary or existing.text_summary
                    existing.save(
                        update_fields=["content_blocks_json", "text_summary", "updated_at"],
                    )
                update_fields: List[str] = []
                if idx == 0 and reply_to_message_id and not getattr(existing, "reply_to_id", None):
                    try:
                        reply_to_uuid = _uuid_mod.UUID(str(reply_to_message_id))
                        if ChatMessage.objects.filter(id=reply_to_uuid, session=session).exists():
                            existing.reply_to_id = reply_to_uuid
                            update_fields.append("reply_to")
                    except (ValueError, TypeError):
                        pass
                if idx == 0 and isinstance(reply_to_preview, dict) and not existing.reply_to_preview:
                    existing.reply_to_preview = reply_to_preview
                    update_fields.append("reply_to_preview")
                if update_fields:
                    update_fields.append("updated_at")
                    existing.save(update_fields=update_fields)
                message_obj = existing
        result.append(message_obj)
    return result


def persist_error_message(
    session,
    content: str,
    *,
    error_category: str,
    model_instance=None,
    source_client_event_id: Optional[str] = None,
):
    """Persist a user-visible assistant error with the current W3 schema.

    Routing and queue failures used to write the removed ``content`` /
    ``agent_type`` / ``intent`` columns directly.  Keeping the construction in
    the persistence layer prevents those low-frequency error paths from
    drifting away from ``ChatMessage``'s ContentBlock contract again.
    """
    from apps.chat.conversation.models import ChatMessage
    from apps.services.common.ws.handlers.content_block_reassembler import (
        derive_text_summary,
    )

    text = str(content or "")
    content_blocks = _stamp_block_arrival([{"type": "text", "text": text}])
    metadata = {}
    if source_client_event_id:
        metadata["source_client_event_id"] = str(source_client_event_id)
    return ChatMessage.objects.create(
        session=session,
        role="assistant",
        message_kind="error_envelope",
        content_blocks_json=content_blocks,
        text_summary=derive_text_summary(content_blocks) or text[:200],
        error_info_json={
            "category": str(error_category or "internal_error"),
            "error_class": "routing_error",
            "error_message": text,
        },
        model_id=(model_instance.id if model_instance else None),
        metadata=metadata,
    )


def publish_user_messages_to_stream(thread_id: str, user_messages: list) -> None:
    """Mirror persisted user messages onto the session stream.

    Runtime still emits ``agent.stream.user`` for backwards compatibility and
    relay idempotency, but Django is the first component that *knows* the user
    row exists. Publishing here makes cross-device observers see the user
    bubble even if runtime routing is slow or fails after ingest.
    """
    from apps.services.common.agent_protocol.constants import AgentStreamEvent

    if not thread_id or not user_messages:
        return

    for msg in user_messages:
        try:
            client_event_id = getattr(msg, "client_event_id", None)
            metadata = getattr(msg, "metadata", None) or {}
            if not client_event_id and isinstance(metadata, dict):
                client_event_id = metadata.get("client_message_id")
            if not client_event_id:
                client_event_id = str(getattr(msg, "id", ""))

            content_blocks = list(getattr(msg, "content_blocks_json", None) or [])
            from apps.services.common.ws.handlers.content_block_reassembler import (
                derive_full_text_content,
            )

            content = derive_full_text_content(content_blocks) or (
                getattr(msg, "text_summary", None)
                or ""
            )

            payload: Dict[str, Any] = {
                "message_id": str(getattr(msg, "id", "")),
                "client_event_id": str(client_event_id),
                "content": content,
            }
            created_at = getattr(msg, "created_at", None)
            updated_at = getattr(msg, "updated_at", None)
            if created_at is not None:
                payload["created_at"] = created_at.isoformat() if hasattr(created_at, "isoformat") else str(created_at)
            if updated_at is not None:
                payload["updated_at"] = updated_at.isoformat() if hasattr(updated_at, "isoformat") else str(updated_at)
            if content_blocks:
                payload["blocks_json"] = content_blocks
                payload["content_blocks_json"] = content_blocks

            Publisher.publish_ws(thread_id, AgentStreamEvent.USER, payload)
        except Exception:
            logger.warning(
                "[persist_user_messages] Failed to publish user mirror event: "
                "thread=%s msg=%s",
                thread_id, getattr(msg, "id", None), exc_info=True,
            )


def spawn_title_thread(
    session_id: str,
    thread_id: str,
    user_message: str,
    *,
    force: bool = False,
    selected_model_id: Optional[str] = None,
) -> None:
    """
    入队标题生成任务（fire-and-forget）。

    历史：早期版本起一个 daemon thread 直接调 LLM。daemon thread 在进程退出
    （hot reload / deploy / worker recycle）时被立刻杀掉，生成请求**静默丢失**，
    没有 retry、没有 dead-letter、没有任何观测。dogfood 现场实测一批 session 卡在
    无标题状态。

    现在改成入队 Celery task ``conversation.generate_session_title``：
    - broker 持久化任务，进程重启不丢
    - 内部对瞬时错指数退避 retry；永久错直接 mark failed
    - failed 状态由 ``conversation.backfill_session_titles`` 周期任务退避重试
    - in_progress 卡死（broker 失败 / worker 崩溃）也被 backfill 捞起来

    保留函数名 ``spawn_title_thread`` 是为了不动所有调用点（chat_service / api/session.py），
    内部已经不再起 thread。

    标题事件经 :meth:`Publisher.publish_title_update` 走 ``publish_to_user``
    投递（``agent.user.title_updated``），用户在任一在线设备 5-60s 内可见，
    断网/离线 24h 内重连可补送（``USER_INBOX_TTL`` 详见
    ``apps/services/common/ws/bus.py``，与 publisher docstring 一致）。

    Args:
        session_id: ``ChatSession.id``
        thread_id: ``ChatSession.thread_id``，作为 envelope payload 透传给
            前端做缓存 invalidation。
        user_message: 首条用户消息内容；用于 LLM 生成标题。
        force: 默认 ``False`` 时 task 内部仍走 ``should_generate_title`` 校验
            （会话已有非默认标题时跳过）；``/generate-title`` view 在 UI
            主动 "重新生成标题" 入口可传 ``True`` 绕过校验。
    """
    from apps.chat.conversation.tasks import generate_session_title_task

    # 防连点 / 防重复入队：
    # SELECT FOR UPDATE 加锁后检查 status——如果已经 in_progress，跳过入队。
    # sendMessage + selectSession 兜底并发触发 / generate-title view 重复调用都会
    # 被这层去重接住，避免 N 个 LLM 调用 + N 次 publish_title_update 闪烁。
    try:
        _enqueue_atomically(
            session_id,
            generate_session_title_task,
            thread_id,
            user_message,
            force,
            selected_model_id,
        )
    except _AlreadyInProgress:
        logger.debug(
            "[TitleGen] skip enqueue (already in_progress) session=%s force=%s",
            session_id, force,
        )
        return
    except Exception:
        # 任何意外（broker 挂 / DB 抖 / 字段未 migrate）都不能阻断用户消息流。
        #
        # 处理思路：如果 _enqueue_atomically 在 mark in_progress **之后**才失败
        # （譬如 task.delay() 抛 BrokerError），session 已经持久化成 in_progress。
        # 这种状态卡死要让 backfill 能立即看到——通过 mark failed 走 4 小时退避
        # cooldown 路径而非 15 分钟 stale 检测（in_progress 卡死检测会因为
        # `_enqueue_atomically` 显式 bump updated_at 后变得不可靠，详见该函数注释）。
        #
        # WHERE title_generation_status='in_progress' 保证只在"真的卡在 mark
        # in_progress 之后失败"的场景下覆盖；如果其他并发请求已经把状态推到
        # done / failed，不要覆盖它们。
        logger.exception(
            "[TitleGen] failed to enqueue generate_session_title_task for session=%s "
            "(non-fatal, will be retried by backfill)",
            session_id,
        )
        try:
            from apps.chat.conversation.models import ChatSession
            ChatSession.objects.filter(
                id=session_id, title_generation_status='in_progress',
            ).update(
                title_generation_status='failed',
                title_generation_failed_at=timezone.now(),
            )
        except Exception:
            logger.exception(
                "[TitleGen] failed to mark session=%s as failed after enqueue error",
                session_id,
            )


def dispatch_title_generation_sync_first(
    session_id: str,
    thread_id: str,
    user_message: str,
    user_id: str,
    *,
    force: bool = False,
    selected_model_id: Optional[str] = None,
) -> None:
    """用请求携带的 ``user_message`` 同步生成标题并推送。

    须在 agent executor 等后台线程中调用——内部走同步 LLM HTTP。
    **不读库正文、不 Celery 兜底**：正文由调用方提供；失败则标 failed。

    幂等：与 Celery 入队路径共用 ``_try_mark_title_in_progress`` 锁。
    """
    from apps.chat.conversation.models import ChatSession
    from apps.chat.conversation.services.title_generator import TitleGeneratorService
    from apps.chat.conversation.tasks import _mark_title_generation_failed
    from apps.services.common.chat_stream_publisher import ChatStreamPublisher

    content = (user_message or "").strip()
    if not content:
        logger.warning(
            "[TitleGen] empty user_message, skip session=%s",
            session_id,
        )
        return

    sess = ChatSession.objects.filter(id=session_id).first()
    if not sess:
        return

    # 已有真实标题：修正 status 即可，别再生成。
    if not force and not TitleGeneratorService.should_auto_generate_title(sess):
        if sess.title_generation_status != 'done':
            ChatSession.objects.filter(id=session_id).update(
                title_generation_status='done',
                title_generation_failed_at=None,
            )
        return

    if not _try_mark_title_in_progress(session_id, force=force):
        return

    try:
        generation_kwargs = {"session": sess}
        if selected_model_id:
            generation_kwargs["requested_model_id"] = selected_model_id
        title = TitleGeneratorService.generate_title(
            [{"role": "user", "content": content}],
            **generation_kwargs,
        )
        if not title:
            _mark_title_generation_failed(session_id, reason='llm_returned_empty')
            logger.warning(
                "[TitleGen] LLM returned empty title session=%s",
                session_id,
            )
            return

        sess.title = title
        sess.title_generation_status = 'done'
        sess.title_generation_failed_at = None
        # 不 bump updated_at：后台写标题不是用户新活动。
        sess.save(update_fields=[
            'title',
            'title_generation_status',
            'title_generation_failed_at',
        ])
        ChatStreamPublisher.publish_title_update(
            user_id,
            session_id=str(sess.id),
            title=title,
            thread_id=thread_id,
        )
        logger.info("[TitleGen] generated session=%s title=%s", session_id, title)
    except Exception:
        logger.exception(
            "[TitleGen] sync title generation failed session=%s",
            session_id,
        )
        _mark_title_generation_failed(session_id, reason='sync_generation_failed')


class _AlreadyInProgress(Exception):
    """spawn_title_thread 入队前检测到已经在跑——跳过本次入队。"""


def _try_mark_title_in_progress(session_id: str, *, force: bool = False) -> bool:
    """原子获取标题生成锁：SELECT FOR UPDATE → 检查 status → mark in_progress。

    Celery 入队路径（``_enqueue_atomically``）与请求侧同步路径
    （``dispatch_title_generation_sync_first``）共用这把锁，保证多端 / backfill
    并发触发时只允许一路真正调 LLM，避免重复生成 + 重复 title_updated 闪烁。

    全部 sync 操作；async view 调用方应当用 ``asgiref.sync.sync_to_async``
    包一层再调，避免 SynchronousOnlyOperation。

    **重要**：mark in_progress 时显式 bump ``updated_at``——Django ``.update()``
    不会触发 ``auto_now=True``。如果不显式 bump，一个 5/9 创建的旧 session 今天
    被 mark in_progress，``updated_at`` 仍是 5/9，立即被 backfill 的 15 分钟卡死
    检测（``Q(title_generation_status='in_progress', updated_at__lt=15min ago)``）
    误判 → 同 sessionId 在另一个 task 里重复入队 → 双 LLM 调用 + title race。

    业务上 ``updated_at`` 在这里 bump 是 OK 的：前端排序口径已经迁到
    ``getSessionActivityTs = max(last_message_at, updated_at, created_at)``,
    last_message_at 才是真活跃时间，bump updated_at 只影响 stale 检测，不污染分组。

    Args:
        force: UI 主动"重新生成"时为 ``True``，允许对已 ``done`` 的会话重抢锁；
            非 force 时 ``done`` 也拒绝，避免把已完成会话重新拖回 in_progress。

    Returns:
        True  —— 成功抢到锁（调用方负责后续生成 / 入队）；
        False —— session 不存在、已在生成中、或（非 force 时）已生成完成，应跳过。
    """
    from django.db import transaction
    from django.utils import timezone as _timezone
    from apps.chat.conversation.models import ChatSession

    with transaction.atomic():
        row = (
            ChatSession.objects
            .select_for_update()
            .filter(id=session_id)
            .only('id', 'title_generation_status')
            .first()
        )
        if row is None:
            return False
        if row.title_generation_status == 'in_progress':
            return False
        if not force and row.title_generation_status == 'done':
            return False

        ChatSession.objects.filter(id=session_id).update(
            title_generation_status='in_progress',
            updated_at=_timezone.now(),
        )
    return True


def _enqueue_atomically(
    session_id: str,
    task,
    thread_id: str,
    user_message: str,
    force: bool,
    selected_model_id: Optional[str] = None,
) -> None:
    """抢到 in_progress 锁后入队 Celery task；已在生成中则抛 ``_AlreadyInProgress``。"""
    if not _try_mark_title_in_progress(session_id, force=force):
        raise _AlreadyInProgress()

    task_kwargs = dict(
        session_id=session_id,
        thread_id=thread_id,
        user_message=user_message,
        force=force,
    )
    if selected_model_id:
        task_kwargs["selected_model_id"] = selected_model_id
    task.delay(**task_kwargs)


# ────────────────────────────────────────────────────────
#  Trace 关联
# ────────────────────────────────────────────────────────

def lookup_latest_trace_id(thread_id: str) -> Optional[str]:
    """DB 兜底：查询 thread 上最新的 ExecutionTrace.trace_id。

    仅在 _execute_builtin_agent 未直接返回 trace_id 时使用（如异常路径）。
    在并发 trace 场景下可能返回错误的 trace，应优先使用确定性传递。
    """
    try:
        from apps.services.agent_engine.models import ExecutionTrace
        latest = ExecutionTrace.objects.filter(thread_id=thread_id).order_by("-started_at").first()
        return str(latest.trace_id) if latest else None
    except Exception:
        logger.debug("[ChatService] _lookup_latest_trace_id failed for thread %s", thread_id, exc_info=True)
        return None


def link_trace_to_messages(
    trace_id: Optional[str],
    user_message_ids: list,
    assistant_message,
) -> None:
    """将 trace_id 关联到用户消息和助手消息。"""
    if not trace_id:
        return
    from apps.chat.conversation.models import ChatMessage
    from django.utils import timezone
    ChatMessage.objects.filter(id__in=user_message_ids).update(
        trace_id=trace_id,
        updated_at=timezone.now(),
    )
    assistant_message.trace_id = trace_id
    assistant_message.save(update_fields=["trace_id", "updated_at"])


# ────────────────────────────────────────────────────────
#  Revert 清理 & PG 补偿
# ────────────────────────────────────────────────────────


def cleanup_reverted_messages(session) -> None:
    """
    物理清理软回滚标记的消息。

    在 session 处于 revert 状态时由 _process_message_sync_core 调用，
    在创建新用户消息之前执行：
    1. 根据 revert_message_id 确定要删除的消息集合
    2. 截断 PG ConversationState
    3. 物理删除 MySQL 消息
    4. 清除 session 的 revert 字段
    """
    from django.db import transaction
    from django.utils import timezone
    from apps.chat.conversation.models import ChatMessage

    with transaction.atomic():
        from apps.chat.conversation.models import ChatSession as _ChatSession
        from apps.chat.conversation.services.file_restore_finalize_lease import (
            require_no_pending_file_restore,
        )
        session = _ChatSession.objects.select_for_update().get(id=session.id)
        # Electron Host 尚未回填真实文件结果时，不能让下一条消息先物理清算
        # 对话；否则旧 Host 随后写盘会把文件落到已经前进的新时间线。
        require_no_pending_file_restore(session)

        # 目标缺失也必须在同一行锁和文件结果门禁之后处理。否则旧 Host 仍在
        # 回填文件时，这条早退会先清除回退态并放行新消息，造成对话/文件错位。
        revert_msg = session.messages.filter(id=session.revert_message_id).first()
        if not revert_msg:
            logger.warning(
                "[ChatService] cleanup: revert_message_id=%s not found, clearing revert state",
                session.revert_message_id,
            )
            session.revert_message_id = None
            session.revert_snapshot_hash = None
            session.revert_state_index = None
            session.revert_at = None
            session.revert_resource_state = None
            session.save(update_fields=[
                'revert_message_id', 'revert_snapshot_hash',
                'revert_state_index', 'revert_at', 'revert_resource_state', 'updated_at',
            ])
            return

        # 删除边界必须与 _build_revert_visible_message_filter 的可见边界严格对齐，
        # 否则软回退时可见、发新消息清算后被删（ 姊妹缺陷）：
        # - assistant 目标：可见含目标，故删除不含目标。
        # - user 目标：可见不含目标，故删除含目标一并删。
        from apps.chat.conversation.services.conversation_time import q_conversation_after

        is_assistant_target = revert_msg.role == 'assistant'
        messages_to_delete = session.messages.filter(
            q_conversation_after(revert_msg, include_target=not is_assistant_target)
        )
        state_index = session.revert_state_index

        reverted_tool_use_ids = {
            block.get("id")
            for blocks in messages_to_delete.values_list("content_blocks_json", flat=True)
            if isinstance(blocks, list)
            for block in blocks
            if (
                isinstance(block, dict)
                and block.get("type") == "tool_use"
                and isinstance(block.get("id"), str)
                and block.get("id")
            )
        }
        if session.thread_id and reverted_tool_use_ids:
            from apps.services.agent_engine.services.pending_interaction_service import (
                invalidate_single_hitl_interactions_for_timeline_rewrite,
            )

            invalidate_single_hitl_interactions_for_timeline_rewrite(
                session.thread_id,
                reverted_tool_use_ids,
            )

        deleted_count = messages_to_delete.count()
        messages_to_delete.delete()

        session.revert_message_id = None
        session.revert_snapshot_hash = None
        session.revert_at = None
        session.revert_resource_state = None
        session.append_revert_history({
            'type': 'cleanup',
            'cleanup_status': 'done',
            'deleted_count': deleted_count,
            'created_at': timezone.now().isoformat(),
        })
        session.save(update_fields=[
            'revert_message_id', 'revert_snapshot_hash',
            'revert_at', 'revert_resource_state', 'revert_history', 'updated_at',
        ])

    logger.info(
        "[ChatService] cleanup: deleted %d reverted messages (session=%s)",
        deleted_count, session.id,
    )

    pg_truncated = False
    if session.thread_id:
        try:
            from apps.services.agent_engine.models import ConversationState

            conv_state = ConversationState.objects.filter(
                thread_id=session.thread_id
            ).first()
            if conv_state and isinstance(conv_state.messages_json, list):
                effective_index = state_index
                if effective_index is None:
                    remaining_count = session.messages.count()
                    effective_index = min(
                        remaining_count * 2,
                        len(conv_state.messages_json),
                    )
                    logger.warning(
                        "Cleanup: revert_state_index is None, using fallback "
                        "index=%d (session=%s, thread=%s)",
                        effective_index, session.id, session.thread_id,
                    )
                conv_state.messages_json = conv_state.messages_json[:effective_index]
                conv_state.interrupt_state = None
                conv_state.save(update_fields=[
                    'messages_json', 'interrupt_state', 'updated_at',
                ])
                pg_truncated = True
            else:
                pg_truncated = True
        except Exception as exc:
            logger.error(
                "Cleanup: ConversationState truncation failed, "
                "revert_state_index retained for retry (session=%s): %s",
                session.id, exc,
            )
            session.append_revert_history({
                'type': 'cleanup',
                'cleanup_status': 'failed',
                'reason': str(exc)[:200],
                'created_at': timezone.now().isoformat(),
            })
            session.save(update_fields=['revert_history', 'updated_at'])

    if pg_truncated or not session.thread_id:
        session.revert_state_index = None
        session.save(update_fields=['revert_state_index', 'updated_at'])


def retry_pg_truncation(session) -> None:
    """PG 截断上次失败后的重试：revert_message_id 已清除但 revert_state_index 残留。

    版本守卫：若 PG messages_json 已被新请求追加消息（T1 失败与 T3 重试之间有 T2 写入），
    放弃截断以避免丢失 T2 的成功对话。
    """
    from django.db import transaction as _txn
    from django.utils import timezone
    from apps.chat.conversation.models import ChatSession as _ChatSession
    from apps.services.agent_engine.configuration import OrchestrationConfiguration

    _cfg = OrchestrationConfiguration.from_settings()
    failed_count = sum(
        1 for entry in (session.revert_history or [])
        if entry.get('type') == 'cleanup' and entry.get('cleanup_status') == 'failed'
    )
    if failed_count >= _cfg.max_cleanup_retries:
        logger.warning(
            "[ChatService] PG truncation abandoned after %d failures (session=%s)",
            failed_count, session.id,
        )
        with _txn.atomic():
            session = _ChatSession.objects.select_for_update().get(id=session.id)
            session.revert_state_index = None
            session.append_revert_history({
                'type': 'cleanup',
                'cleanup_status': 'abandoned',
                'reason': 'max_retries_exceeded',
                'created_at': timezone.now().isoformat(),
            })
            session.save(update_fields=['revert_state_index', 'revert_history', 'updated_at'])
        return

    state_index = session.revert_state_index
    if not session.thread_id:
        session.revert_state_index = None
        session.save(update_fields=['revert_state_index', 'updated_at'])
        return
    try:
        from apps.services.agent_engine.models import ConversationState
        conv_state = ConversationState.objects.filter(
            thread_id=session.thread_id
        ).first()
        if conv_state and isinstance(conv_state.messages_json, list):
            current_len = len(conv_state.messages_json)
            effective_index = state_index
            if effective_index is None:
                remaining_count = session.messages.count()
                effective_index = min(remaining_count * 2, current_len)

            _NEW_MSG_TOLERANCE = 2
            if effective_index is not None and current_len > effective_index + _NEW_MSG_TOLERANCE:
                logger.warning(
                    "[ChatService] PG truncation retry aborted: new messages detected "
                    "since T1 failure (session=%s, thread=%s, expected_len<=%d, actual_len=%d). "
                    "Clearing revert_state_index to prevent data loss.",
                    session.id, session.thread_id, effective_index + _NEW_MSG_TOLERANCE, current_len,
                )
                session.revert_state_index = None
                session.save(update_fields=['revert_state_index', 'updated_at'])
                return

            conv_state.messages_json = conv_state.messages_json[:effective_index]
            conv_state.interrupt_state = None
            conv_state.save(update_fields=['messages_json', 'interrupt_state', 'updated_at'])

        with _txn.atomic():
            session = _ChatSession.objects.select_for_update().get(id=session.id)
            session.revert_state_index = None
            session.append_revert_history({
                'type': 'cleanup',
                'cleanup_status': 'done',
                'created_at': timezone.now().isoformat(),
            })
            session.save(update_fields=['revert_state_index', 'revert_history', 'updated_at'])
        logger.info("[ChatService] PG truncation retry succeeded (session=%s)", session.id)
    except Exception as exc:
        logger.error("[ChatService] PG truncation retry failed (session=%s): %s", session.id, exc)
