"""Fork 会话 API"""

from uuid import UUID

from django.db.models import Q
from ninja import Body

from apps.i18n import _, get_text
from apps.i18n.response import success_response, error_response_with_status
from ..models import ChatSession, ChatMessage
from ..schemas import ForkSessionRequest
from ._common import (
    router, jwt_auth, logger,
    FORK_ASYNC_THRESHOLD, FORK_BATCH_SIZE,
    _get_session_with_shared_access,
    _session_to_schema,
    _visible_message_count,
)
from ..services.llm_model_loader import attach_llm_models_to_sessions


class _ForkPointResolution:
    __slots__ = ("message_id", "created_at", "message", "error", "error_code", "status_code")

    def __init__(
        self,
        *,
        message_id=None,
        created_at=None,
        message=None,
        error: str | None = None,
        error_code: str = "VALIDATION_ERROR",
        status_code: int = 400,
    ):
        self.message_id = message_id
        self.created_at = created_at
        self.message = message
        self.error = error
        self.error_code = error_code
        self.status_code = status_code


def _resolve_anchor_message(main_timeline, anchor_message_id):
    """把 Agent Host transcript anchor 解析为服务端 ChatMessage。

    Agent Host 的消息 id 是用户点击的 SSoT。服务端只做映射，不用时间或内容猜测：
    旧本地 user id 可落在 client_event_id / metadata.client_message_id；已收敛的
    runtime 消息可能在 metadata.message_id 中保存服务端 id。
    """
    if not anchor_message_id:
        return None

    filters = (
        Q(metadata__client_message_id=anchor_message_id)
        | Q(metadata__message_id=anchor_message_id)
    )
    try:
        anchor_uuid = UUID(str(anchor_message_id))
    except (TypeError, ValueError):
        anchor_uuid = None
    if anchor_uuid is not None:
        filters |= Q(id=anchor_uuid) | Q(client_event_id=anchor_uuid)

    return main_timeline.filter(filters).only(
        "id", "created_at", "role", "arrival_seq",
    ).first()


def _resolve_assistant_fork_point(
    main_timeline,
    message_id=None,
    *,
    fork_anchor_message_id=None,
) -> _ForkPointResolution:
    """Fork 点必须是 assistant。

    新客户端传 Agent Host transcript anchor；旧客户端传服务端 ChatMessage PK。
    不指定则收束到最后一条 assistant。
    """
    if fork_anchor_message_id:
        fork_msg = _resolve_anchor_message(main_timeline, fork_anchor_message_id)
        if not fork_msg:
            # 新客户端会同时携带可派生的服务端 ChatMessage PK。anchor 是本地上下文
            # SSoT；这里仅在服务端尚未写入 anchor metadata 时用 legacy PK 兜底。
            if not message_id:
                return _ForkPointResolution(
                    error=f"Fork anchor {fork_anchor_message_id} not found in session.",
                    error_code="NOT_FOUND",
                    status_code=404,
                )
        elif fork_msg.role != "assistant":
            return _ForkPointResolution(
                error="Fork point must be an assistant message; cannot fork from a user message.",
            )
        else:
            return _ForkPointResolution(
                message_id=fork_msg.id,
                created_at=fork_msg.created_at,
                message=fork_msg,
            )

    if message_id:
        fork_msg = main_timeline.filter(id=message_id).only(
            "id", "created_at", "role", "arrival_seq",
        ).first()
        if not fork_msg:
            return _ForkPointResolution(
                error=f"Message {message_id} not found in session.",
                error_code="NOT_FOUND",
                status_code=404,
            )
        if fork_msg.role != "assistant":
            return _ForkPointResolution(
                error="Fork point must be an assistant message; cannot fork from a user message.",
            )
        return _ForkPointResolution(
            message_id=fork_msg.id,
            created_at=fork_msg.created_at,
            message=fork_msg,
        )

    from ..services.conversation_time import conversation_point

    assistants = main_timeline.filter(role="assistant").only(
        "id", "created_at", "role", "arrival_seq",
    )
    last_assistant = max(assistants, default=None, key=lambda msg: (conversation_point(msg), str(msg.id)))
    if not last_assistant:
        return _ForkPointResolution(
            error="Cannot fork: session has no assistant message to use as fork point.",
        )
    return _ForkPointResolution(
        message_id=last_assistant.id,
        created_at=last_assistant.created_at,
        message=last_assistant,
    )


def _fork_boundary_queryset(main_timeline, fork_msg):
    """源会话 fork 可复制消息：以对话时间 arrival_seq 为权威边界。"""
    if not fork_msg:
        return main_timeline
    from ..services.conversation_time import q_conversation_before

    return main_timeline.filter(q_conversation_before(fork_msg, include_target=True))


def _sort_messages_by_conversation_time(messages):
    from ..services.conversation_time import conversation_point

    return sorted(messages, key=lambda msg: (conversation_point(msg), str(msg.id)))


@router.post("/sessions/{session_id}/fork", auth=jwt_auth, tags=["会话管理"])
def fork_session(request, session_id: str, data: ForkSessionRequest = Body(...)):
    """
    Fork 会话 —— 从指定消息处创建分支会话。

    复制源 session 的消息和 Agent 对话状态到新 session，
    新 session 从 fork 点开始可走不同方向。

    Fork 点必须是 assistant：
    - 指定 user message_id → 400
    - 不指定 message_id → 收束到时间线上最后一条 assistant
      （丢弃其后尚未得到回复的尾部 user）
    """
    # ：通用 fork 是完整复制（含状态），只对 owner / workspace 成员开放；
    # session-share grantee 的 fork 走 shared-fork 端点（can_fork 权限门 + 快照物化）。
    source_session, _is_shared = _get_session_with_shared_access(
        session_id, request.auth, include_session_share=False,
    )
    if not source_session:
        return error_response_with_status(
            "NOT_FOUND",
            message=get_text("chat.session_not_found", session_id=session_id),
            status_code=404,
        )

    # 软引用 LLMModel 预加载，让下方 source_session.current_model 直接命中缓存
    attach_llm_models_to_sessions([source_session])

    # ：ChatSession.space FK 已 Drop；权限与上下文以 workspace 为锚（id-reuse）。
    if not source_session.workspace_id:
        return error_response_with_status(
            "VALIDATION_ERROR", message="Source session has no workspace.", status_code=400,
        )
    from apps.tabtinspace.services.host_resolver import resolve_host
    space = resolve_host(source_session.workspace_id)
    if not space:
        return error_response_with_status(
            "VALIDATION_ERROR",
            message="Source session workspace has no compatible Space shell.",
            status_code=400,
        )

    # ：只读看别人对话时不允许 fork——fork 会创建新 session 并复制上下文，
    # 需要 editor 共写权限，viewer 只读访问不够。
    if str(source_session.user_id) != str(request.auth.id):
        from apps.tabtinspace.services.base import BaseService
        if not BaseService(user=request.auth).check_space_permission(str(space.id), 'editor'):
            return error_response_with_status(
                "FORBIDDEN",
                message="Fork requires editor permission on this shared conversation.",
                status_code=403,
            )

    # ── 空会话校验 ──────────────────────────────────────────────────
    # CH-5：与复制口径一致，主时间线不含子 Agent message。
    main_timeline = (
        ChatMessage.objects
        .filter(session=source_session)
        .exclude(subagent_run_id__gt='')
    )
    if not main_timeline.exists():
        return error_response_with_status(
            "VALIDATION_ERROR",
            message="Cannot fork an empty session.",
            status_code=400,
        )

    # ── 确定 fork 点（必须落在 assistant；禁止以 user 为分叉边界）──
    # 产品不变量：子会话历史不得以未完成的用户消息结尾，否则会出现相邻 user。
    resolved = _resolve_assistant_fork_point(
        main_timeline,
        data.message_id,
        fork_anchor_message_id=data.fork_anchor_message_id,
    )
    if resolved.error:
        return error_response_with_status(
            resolved.error_code,
            message=resolved.error,
            status_code=resolved.status_code,
        )
    fork_point_message_id = resolved.message_id
    fork_msg = resolved.message

    # ── 消息计数（用于判断是否异步） ────────────────────────────────
    # CH-5：fork 不复制子 Agent message（subagent_run_id 非空）——它们不属于主对话。
    msg_filter = _fork_boundary_queryset(main_timeline, fork_msg)

    total_msg_count = msg_filter.count()

    # ── 创建新 session + 同步复制包裹在事务内 ───────────────────────
    from django.db import transaction

    from apps.services.llm.services.capability_guard import is_llm_model_instance as _is_llm

    _fork_current = source_session.current_model if _is_llm(source_session.current_model, require_chat_mode=True) else None
    _fork_default = source_session.default_model if _is_llm(source_session.default_model, require_chat_mode=True) else _fork_current

    from ..services.fork_title import allocate_fork_session_title

    fork_warnings: list[str] = []
    tool_id_remap: dict[str, str] | None = None
    async_fork = total_msg_count > FORK_ASYNC_THRESHOLD
    msg_count = total_msg_count
    same_owner = str(source_session.user_id) == str(request.auth.id)

    with transaction.atomic():
        fork_title = allocate_fork_session_title(
            source_session=source_session,
            user=request.auth,
        )
        new_session = ChatSession.objects.create(
            user=request.auth,
            organization_id=source_session.organization_id,
            agent_id=source_session.agent_id,
            workspace_id=source_session.workspace_id,
            project_id=source_session.project_id,
            target_device_id=source_session.target_device_id if same_owner else "",
            target_device_installation_id=(
                source_session.target_device_installation_id if same_owner else ""
            ),
            agent_mode=source_session.agent_mode,
            # 数字编号占位；title_generation_status 保持 pending，
            # fork 后首次发新消息时走自动重命名（见 TitleGeneratorService）。
            title=fork_title,
            title_generation_status="pending",
            current_model_id=_fork_current.id if _fork_current else None,
            default_model_id=_fork_default.id if _fork_default else None,
            forked_from_id=source_session.id,
            fork_point_message_id=fork_point_message_id,
        )
        # _session_to_schema 会读 new_session.current_model；预注入 FK 缓存避免再查一次。
        from ..services.llm_model_loader import set_cached_session_models
        set_cached_session_models(new_session, current=_fork_current, default=_fork_default)

        if async_fork:
            new_session.fork_copy_status = 'pending'
            new_session.save(update_fields=['fork_copy_status', 'updated_at'])
            fork_warnings.append(
                "对话较长，消息正在后台复制，复制完成前请勿发送新消息",
            )
        else:
            source_messages = _sort_messages_by_conversation_time(list(msg_filter))
            msg_count, tool_id_remap = _fork_copy_messages_sync(
                source_messages, new_session, fork_point_message_id, space,
                warnings=fork_warnings,
            )

    if async_fork:
        from ..tasks import fork_copy_messages_async
        fork_copy_messages_async.delay(
            source_session_id=str(source_session.id),
            new_session_id=str(new_session.id),
            fork_point_message_id=str(fork_point_message_id) if fork_point_message_id else None,
            source_thread_id=source_session.effective_thread_id,
            space_id=str(space.id),
        )
    schema = _session_to_schema(new_session, message_count=msg_count)
    if fork_warnings:
        schema.warnings = fork_warnings
    # ：同步路径把 mapper 快照带给本机 fork；异步路径复制尚未完成，不返回。
    if tool_id_remap:
        schema.tool_id_remap = tool_id_remap
    return success_response(data=schema.model_dump(mode='json'))


@router.post("/sessions/{session_id}/unfork", auth=jwt_auth, tags=["会话管理"])
def unfork_session(request, session_id: str):
    """
    将 fork 子会话弹出为根级对话：清除 forked_from_id / fork_point_message_id。

    只改血缘元数据，不改动消息与 ConversationState。仅会话所有者可操作。
    """
    session = ChatSession.objects.filter(id=session_id, user=request.auth).first()
    if not session:
        return error_response_with_status(
            "NOT_FOUND",
            message=get_text("chat.session_not_found", session_id=session_id),
            status_code=404,
        )
    if not session.forked_from_id:
        return error_response_with_status(
            "VALIDATION_ERROR",
            message=get_text(
                "chat.session_not_forked",
                default="该对话不是分支对话，无法弹出为根级",
            ),
            status_code=400,
        )

    session.forked_from_id = None
    session.fork_point_message_id = None
    session.save(update_fields=["forked_from_id", "fork_point_message_id", "updated_at"])
    logger.info(
        "session unforked: session=%s user=%s",
        session_id,
        getattr(request.auth, "id", None),
    )
    # 与 get/update_session 一致带上 message_count，避免前端把缓存盖成 null 后误显草稿铅笔
    return success_response(
        data=_session_to_schema(
            session,
            message_count=_visible_message_count(session),
        ).model_dump(mode="json"),
    )


def _fork_copy_messages_sync(
    source_messages: list,
    new_session,
    fork_point_message_id,
    space,
    warnings: list | None = None,
) -> tuple[int, dict[str, str]]:
    """同步复制消息 + PG 状态 + ChatContext。返回 (消息数, tool id 映射快照)。"""
    from ..services.fork_tool_id_remap import (
        ForkToolIdMapper,
        remap_content_blocks_json,
    )
    from ..services.fork_message_id_remap import forked_message_id

    # W3 §3.3.1：fork 复制消息字段全量迁移到新字段集
    # blocks_json → content_blocks_json；attachments_json 已下线（并入 content_blocks）；
    # agent_type / intent 已下线；新增 text_summary / stop_reason / usage_json 等
    # 顶层字段一并复制
    original_timestamps = []
    new_messages = []
    #  引用回复：fork 重新生成消息 UUID → reply_to 这个 self-FK 必须重映射到
    # 新 session 的对应新 id，否则会悬空指向源 session。先建 旧id→新id 映射；被引用
    # 消息落在 fork 截断点之外（不在本次复制范围）时 reply_to 置 None，但 preview
    # 快照始终保留（气泡仍显示引用条，只是点击不能跳转）。
    id_map: dict = {}
    # ：整次 fork 共用一张 tool id 映射表，ChatMessage 与 ConversationState 一致。
    tool_id_mapper = ForkToolIdMapper()
    for msg in source_messages:
        id_map[str(msg.id)] = forked_message_id(new_session.id, msg.id)
    for msg in source_messages:
        original_timestamps.append(msg.created_at)
        remapped_reply_to = id_map.get(str(getattr(msg, 'reply_to_id', None))) if getattr(msg, 'reply_to_id', None) else None
        new_messages.append(ChatMessage(
            id=id_map[str(msg.id)],
            session=new_session,
            reply_to_id=remapped_reply_to,
            reply_to_preview=getattr(msg, 'reply_to_preview', None),
            role=msg.role,
            content_blocks_json=remap_content_blocks_json(
                getattr(msg, 'content_blocks_json', None),
                tool_id_mapper,
            ),
            text_summary=getattr(msg, 'text_summary', None),
            error_info_json=getattr(msg, 'error_info_json', None),
            usage_json=getattr(msg, 'usage_json', None),
            stop_reason=getattr(msg, 'stop_reason', None),
            subagent_run_id=getattr(msg, 'subagent_run_id', None),
            model_name_snapshot=getattr(msg, 'model_name_snapshot', None),
            checkpoint_anchor_block_id=getattr(msg, 'checkpoint_anchor_block_id', None),
            checkpoint_anchor_block_index=getattr(msg, 'checkpoint_anchor_block_index', None),
            content_blocks_trimmed_at=getattr(msg, 'content_blocks_trimmed_at', None),
            model_id=getattr(msg, 'model_id', None),
            trace_id=getattr(msg, 'trace_id', None),
            sender_user_id=getattr(msg, 'sender_user_id', None),
            agent_id=getattr(msg, 'agent_id', None),
            agent_run_id=getattr(msg, 'agent_run_id', None),
            checkpoint_hash=getattr(msg, 'checkpoint_hash', None),
            checkpoint_state_index=getattr(msg, 'checkpoint_state_index', None),
            diff_summary=getattr(msg, 'diff_summary', None),
            changed_files=getattr(msg, 'changed_files', None),
            message_kind=msg.message_kind,
            arrival_seq=getattr(msg, 'arrival_seq', None),
            metadata=dict(getattr(msg, 'metadata', None) or {}),
        ))
    if new_messages:
        ChatMessage.objects.bulk_create(new_messages, batch_size=FORK_BATCH_SIZE)
        for msg_obj, ts in zip(new_messages, original_timestamps):
            msg_obj.created_at = ts
        ChatMessage.objects.bulk_update(new_messages, ['created_at'], batch_size=FORK_BATCH_SIZE)
        # FTS Wave 1：bulk_create 不触发 post_save，必须显式写 Outbox
        # （PRD 4.3.B / 总控 R1-03）
        try:
            from apps.fts.services.sync_service import enqueue_messages_bulk_created
            for msg_obj in new_messages:
                msg_obj.session = new_session  # fork 目标 session 不在 select_related 链
            enqueue_messages_bulk_created(new_messages)
        except Exception:
            logger.exception("[FTS] fork bulk_create outbox enqueue failed")

    new_session.last_message_at = source_messages[-1].created_at if source_messages else None
    new_session.save(update_fields=['last_message_at'])

    _fork_copy_pg_state(
        source_messages,
        new_session,
        fork_point_message_id,
        warnings=warnings,
        tool_id_mapper=tool_id_mapper,
        message_id_remap=id_map,
    )
    # ：new_session 的 space 已是 UUID 软引用；直接沿用调用方注入的 Space 实例。
    _fork_copy_context(new_session, space, warnings=warnings)
    return len(new_messages), tool_id_mapper.snapshot()


def _fork_copy_pg_state(
    source_messages,
    new_session,
    fork_point_message_id,
    *,
    warnings=None,
    tool_id_mapper=None,
    message_id_remap=None,
):
    """复制 PG ConversationState，截断到 fork 点。"""
    try:
        from apps.services.agent_engine.models import ConversationState
        from ..services.fork_tool_id_remap import ForkToolIdMapper, remap_messages_json

        source_thread = new_session.forked_from_id
        if not source_thread:
            return
        src_session = ChatSession.objects.filter(id=source_thread).only('thread_id', 'id').first()
        if not src_session:
            return
        src_state = ConversationState.objects.filter(
            thread_id=src_session.effective_thread_id,
        ).first()
        if src_state:
            src_msgs = src_state.messages_json or []
            forked_msgs, truncation_failed = _truncate_pg_messages_at_fork_point(
                src_msgs, source_messages, fork_point_message_id,
            )
            if truncation_failed and warnings is not None:
                # ：截断点定位失败已做保守截断，提示用户新会话上下文可能缺失
                # 尾部若干轮（宁缺勿混——不会包含 fork 点之后的内容）。
                warnings.append(
                    "Agent 对话状态截断点定位失败，已保守截断，"
                    "新会话可能缺少 fork 点前的少量上下文",
                )
            # ：与 ChatMessage 共用 mapper；独立调用时再新建一张表。
            mapper = tool_id_mapper or ForkToolIdMapper()
            ConversationState.objects.create(
                thread_id=new_session.effective_thread_id,
                messages_json=remap_messages_json(
                    forked_msgs,
                    mapper,
                    {
                        str(source_id): str(target_id)
                        for source_id, target_id in (message_id_remap or {}).items()
                    },
                ),
                state_json=_fork_state_json(src_state.state_json),
                version=1,
            )
    except Exception:
        logger.warning("Failed to copy ConversationState for fork", exc_info=True)
        if warnings is not None:
            warnings.append("Agent 对话状态复制失败，新会话可能需要重新建立上下文")


def _fork_copy_context(new_session, space, *, warnings=None):
    """复制 ChatContext 到新 session。"""
    try:
        from ..models import ChatContext

        src_session = ChatSession.objects.filter(id=new_session.forked_from_id).first()
        if not src_session:
            ChatContext.objects.get_or_create(
                session=new_session,
                defaults={
                    "current_space_id": str(space.id) if space else "",
                    "current_project_id": new_session.project_id,
                },
            )
            return
        src_ctx = ChatContext.objects.filter(session=src_session).first()
        if src_ctx:
            ChatContext.objects.create(
                session=new_session,
                current_space_id=src_ctx.current_space_id,
                current_project_id=src_ctx.current_project_id,
                current_table_id=src_ctx.current_table_id,
                current_view_id=src_ctx.current_view_id,
                recent_spaces=src_ctx.recent_spaces,
                recent_tables=src_ctx.recent_tables,
                recent_views=src_ctx.recent_views,
                context_data=src_ctx.context_data,
            )
        else:
            ChatContext.objects.get_or_create(
                session=new_session,
                defaults={
                    "current_space_id": str(space.id) if space else "",
                    "current_project_id": new_session.project_id,
                },
            )
    except Exception:
        logger.warning("Failed to copy ChatContext for fork", exc_info=True)
        if warnings is not None:
            warnings.append("会话上下文复制失败，新会话可能缺少部分上下文信息")


def _truncate_pg_messages_at_fork_point(
    pg_msgs: list,
    mysql_messages: list,
    fork_point_message_id,
) -> tuple[list, bool]:
    """在 PG messages_json 中找到 fork 点并截断。

    MySQL ChatMessage 和 PG messages_json 行数不同（PG 含 system/tool/assistant，
    MySQL 不含 tool role），因此不能按索引直接对齐。

    策略：用 fork 点消息的 content 在 PG 消息列表中从后向前匹配定位，
    然后保留匹配位置之后紧跟的完整 assistant+tool 轮。

    返回 ``(forked_msgs, truncation_failed)``：

    - ``truncation_failed=False``：正常截断，或**合法全量**（无 fork 点 / 无
      MySQL 消息 = 从头 fork，本就应全量继承，不算失败）。
    - ``truncation_failed=True``：**该截断却匹配不上**——fork 点存在但
      content 在 PG 里定位不到。此时不再静默把 fork 点之后的历史一并搬入新会话
      （会污染新会话上下文），而是按 fork 点在 MySQL 里的**序位占比**保守估算
      PG 切点、宁少勿多截断，并返回 True 让调用方写 warning 提示用户。
    """
    if not pg_msgs:
        return [], False
    # 无 fork 点 / 无 MySQL 消息 = 从会话开头 fork，全量继承是正确语义，非失败。
    if not fork_point_message_id or not mysql_messages:
        return list(pg_msgs), False

    fork_msg = None
    fork_ordinal = None  # fork 点在 mysql_messages 中的序号（0-based）
    for idx, m in enumerate(mysql_messages):
        if hasattr(m, 'id') and str(m.id) == str(fork_point_message_id):
            fork_msg = m
            fork_ordinal = idx
            break
    # fork 点 id 在 MySQL 消息里都找不到 → 无从定位，全量继承（与历史行为一致，
    # 属"数据不完整"而非"匹配失败"，不额外告警避免噪音）。
    if not fork_msg:
        return list(pg_msgs), False

    # W3 §3.3.1：fork_msg.content 已 drop —— 用 text_summary 兜底匹配 PG 端
    # messages_json 的 content。source_messages 已按 fork 边界截到点击消息，因此
    # 这里从前向后找「同 role + 同 content 的第 N 次出现」，N 由 MySQL 截断序列中
    # 目标消息前同内容出现次数决定。不能从 PG 尾部倒查：重复回答会漂到后一次。
    fork_content = (
        getattr(fork_msg, 'text_summary', '') or getattr(fork_msg, 'content', '') or ''
    )
    fork_role = getattr(fork_msg, 'role', 'user')
    fork_content_norm = fork_content.strip()
    target_match_ordinal = 0
    for idx, m in enumerate(mysql_messages):
        if idx > fork_ordinal:
            break
        candidate_content = (
            getattr(m, 'text_summary', '') or getattr(m, 'content', '') or ''
        ).strip()
        if getattr(m, 'role', 'user') == fork_role and candidate_content == fork_content_norm:
            target_match_ordinal += 1

    match_idx = None
    seen_matches = 0
    for i, m in enumerate(pg_msgs):
        if target_match_ordinal <= 0:
            break
        if m.get("role") != fork_role:
            continue
        pg_text = _pg_message_text(m)
        if fork_content_norm and pg_text.strip() == fork_content_norm:
            seen_matches += 1
            if seen_matches == target_match_ordinal:
                match_idx = i
                break

    if match_idx is None:
        #  fail-visible：fork 点存在但 content 定位失败（text_summary 被压缩/
        # 改写、PG content 形态不兼容等）。不再静默全量——按 fork 点在 MySQL 中的
        # 序位占比保守映射到 PG 长度截断，宁可少继承几轮，也不把 fork 点之后的
        # 历史混进新会话。调用方据 True 写 warning 告知用户。
        conservative = _conservative_truncate_by_ordinal(
            pg_msgs, fork_ordinal, len(mysql_messages),
        )
        return conservative, True

    cut = match_idx + 1
    while cut < len(pg_msgs):
        role = pg_msgs[cut].get("role", "")
        if role == "user":
            break
        cut += 1

    return pg_msgs[:cut], False


def _pg_message_text(message: dict) -> str:
    content = message.get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        text_parts = [
            b.get("text", "")
            for b in content
            if isinstance(b, dict) and b.get("type") == "text"
        ]
        return "\n".join(text_parts)
    return ""


def _conservative_truncate_by_ordinal(pg_msgs: list, fork_ordinal, mysql_total: int) -> list:
    """content 匹配失败时的保守 PG 截断兜底。

    用 fork 点在 MySQL 消息序列里的序位占比映射到 PG 长度，取一个不超过该占比的
    保守切点，再回退到最近的「user 轮边界」上——保证切在完整对话轮之间、宁少勿多，
    绝不把 fork 点之后的内容带进新会话。
    """
    if not pg_msgs:
        return []
    if fork_ordinal is None or mysql_total <= 0:
        # 无从估算 → 极端保守，只留首条（通常是 system / 首个 user）。
        return pg_msgs[:1]
    # fork 点及其之前应保留，占比按 (ordinal+1)/total 映射到 PG。
    ratio = (fork_ordinal + 1) / mysql_total
    approx_cut = max(1, min(len(pg_msgs), int(len(pg_msgs) * ratio)))
    # 回退到 approx_cut 及之前最近的 user 轮起点之后的边界：从 approx_cut 往前找
    # 到上一条 user 之后的位置，确保切在轮边界、不截断半轮 assistant+tool。
    cut = approx_cut
    while cut > 1 and pg_msgs[cut - 1].get("role", "") != "user":
        cut -= 1
    return pg_msgs[:cut]


def _fork_state_json(src_state_json: dict) -> dict:
    """清理源 state_json 中不应继承到 fork session 的字段。"""
    from apps.services.agent_engine.state.fork_context import clean_state_for_fork
    return clean_state_for_fork(src_state_json)
