"""
Chat Service — 对话编排薄壳

4 阶段流水线：prepare → ingest → contextualize → route(dispatch_external)。
所有 Agent 执行均在客户端设备上完成，Django 只做路由/计费/持久化。
"""

from typing import Dict, Any, NamedTuple, Optional, List

import logging
import time
import uuid

from apps.services.common.api_errors import (
    MSG_MESSAGES_REQUIRED, MSG_SESSION_NOT_FOUND,
    raise_bad_request, raise_not_found,
)
from apps.services.common.agent_protocol.constants import TIN_AGENT_NAME
from apps.services.agent_engine.services.message_intake import (
    build_client_message_id,
    build_dedupe_response,
    load_queue_settings,
    build_queue_payload,
    enqueue_payload_once,
    persist_dedupe_result,
    push_queue_error,
    drain_queue_until_safely_released,
)
from apps.services.agent_engine.services.persistence_pipeline import (
    ensure_thread_id,
    persist_user_messages,
    publish_user_messages_to_stream,
    spawn_title_thread,
    cleanup_reverted_messages,
    retry_pg_truncation,
)
from apps.services.agent_engine.services.billing_gateway import run_billing_precheck
from apps.services.agent_execution.model_resolver import (
    resolve_model as _resolve_model,
    resolve_agent_name as _resolve_agent_name,
)
from apps.services.agent_execution.context_assembler import (
    assemble_full_context as _assemble_full_context,
)
from apps.services.agent_execution.reply_context import (
    extract_persist_reply_kwargs_from_app_context,
)
from apps.services.agent_engine.services.agent_router import (
    resolve_route as _resolve_route,
    handle_routing_decision as _handle_routing_decision,
)

logger = logging.getLogger(__name__)


def _schedule_queue_recovery(
    *,
    session_id: str,
    user_id: str,
    thread_id: str,
) -> bool:
    """投递可靠 recovery 任务；Celery worker 内重新抢锁和加载 ORM。"""
    from apps.services.agent_engine.tasks.queue_recovery import recover_chat_queue

    try:
        recover_chat_queue.apply_async(
            kwargs={
                "session_id": session_id,
                "user_id": user_id,
                "thread_id": thread_id,
            },
        )
        return True
    except Exception:
        logger.exception(
            "[ChatService] Failed to dispatch queue recovery task: thread=%s",
            thread_id,
        )
        return False


def _recover_queue_inline_after_schedule_failure(
    *,
    session,
    user,
    thread_id: str,
    queue_service,
    queue_settings: Dict[str, Any],
) -> bool:
    """Celery 投递失败时在请求进程内保证队列仍有明确 owner。

    若原 owner 仍持锁，Redis 的原子 handoff 会看到刚入队的 payload；若原
    owner 已释放，则本请求重新抢锁并同步 drain。只有 Redis 故障 / drain
    失败才返回 False，让 WS 返回可重试 NAK，而不是假 queued ACK。
    """
    from apps.services.agent_engine.services.message_queue_service import (
        LockResult,
        LockWatchdog,
    )

    fallback_token = uuid.uuid4().hex
    lock_ttl = int(queue_settings.get("lock_ttl", 600) or 600)
    lock_result = queue_service.acquire_lock(
        thread_id,
        fallback_token,
        ttl=lock_ttl,
    )
    if lock_result == LockResult.HELD_BY_OTHER:
        # 当前 owner 与原子 handoff 脚本共同保证 payload 不会成为孤儿。
        return True
    if lock_result != LockResult.ACQUIRED:
        return False

    try:
        with LockWatchdog(
            queue_service,
            thread_id,
            fallback_token,
            lock_ttl,
        ) as watchdog:
            drain_queue_until_safely_released(
                session=session,
                user=user,
                thread_id=thread_id,
                queue_service=queue_service,
                queue_settings=queue_settings,
                lock_token=fallback_token,
                watchdog=watchdog,
                process_fn=ChatService._process_message_sync_core,
                error_fn=push_queue_error,
            )
        return True
    except Exception:
        logger.exception(
            "[ChatService] Inline queue recovery failed: thread=%s",
            thread_id,
        )
        queue_service.release_lock(thread_id, fallback_token)
        return False


class ChatService:
    """
    对话服务 — 编排薄壳

    职责：
    - 4 阶段流水线编排（prepare → ingest → contextualize → route/dispatch）
    - 消息队列管理（锁、去重、排队）
    - 各阶段具体逻辑委托给独立子服务
    """

    DEFAULT_AGENT = TIN_AGENT_NAME

    # ────────────────────────────────────────────────────────
    #  阶段数据结构
    # ────────────────────────────────────────────────────────

    class _PrepareResult(NamedTuple):
        model_instance: Any
        model_fell_back: bool
        final_model_id: Optional[str]
        user_selected_model: bool
        resolved_agent_name: str
        effective_thread_id: str
        config: Dict[str, Any]
        ws_id: str
        uid: str

    @staticmethod
    def _resolve_execution_context(*, session, user):
        from apps.services.agent_execution.team_space_execution import (
            resolve_chat_execution_context,
        )

        return resolve_chat_execution_context(session=session, initiator_user=user)

    @staticmethod
    def _owner_execution_unavailable_response(execution_context):
        from apps.services.agent_execution.team_space_execution import (
            build_owner_execution_unavailable_response,
        )

        return build_owner_execution_unavailable_response(execution_context)

    class _IngestResult(NamedTuple):
        user_messages: list
        user_message_ids_list: list
        is_first_message: bool

    # ────────────────────────────────────────────────────────
    #  阶段方法（薄委托）
    # ────────────────────────────────────────────────────────

    @staticmethod
    def _stage_prepare(
        *, session, user, messages, model_id, thread_id,
        agent_name, execution_profile, app_context, client_type,
        execution_user=None,
    ):
        """Stage 1: 数据修复 + 模型解析 + 计费预检。"""
        if session.revert_message_id:
            cleanup_reverted_messages(session)
        elif session.revert_state_index is not None:
            retry_pg_truncation(session)

        resolved = _resolve_model(session, model_id)
        resolved_agent_name = _resolve_agent_name(agent_name)
        # W10: ``AgentRegistry.get_agent`` was the gate to the now-deleted
        # builtin TinAgent / ReactAgent. Downstream stages (ingest /
        # contextualize / route) only consume ``resolved_agent_name`` (a
        # string label used for trace tagging and routing); no caller reads
        # ``prep.agent`` anymore. Skipping the registry lookup avoids a
        # ``ValueError: Agent 'tin' 未注册`` since W10 removed
        # ``apps.py._register_agents``.
        effective_thread_id = thread_id or ensure_thread_id(session, str(session.id))
        config = {"configurable": {"thread_id": effective_thread_id}}

        billing = run_billing_precheck(
            execution_user or user, session, resolved.instance,
            effective_thread_id, app_context, client_type, execution_profile,
        )
        if not billing.passed:
            return billing.result

        return ChatService._PrepareResult(
            model_instance=resolved.instance,
            model_fell_back=resolved.fell_back,
            final_model_id=str(resolved.instance.id) if resolved.instance else None,
            user_selected_model=model_id is not None,
            resolved_agent_name=resolved_agent_name,
            effective_thread_id=effective_thread_id,
            config=config,
            ws_id=billing.ws_id,
            uid=billing.uid,
        )

    @staticmethod
    def _stage_ingest(
        *, session, user, messages, prep, user_message_ids,
        blocks, attachments, client_message_id, execution_profile, app_context,
        execution_context=None,
    ):
        """Stage 2: 用户消息持久化 + 标题生成。"""
        from apps.chat.conversation.models import ChatMessage
        from apps.services.agent_engine.services.persistence_pipeline import (
            resolve_sender_attribution,
        )

        #  共享对话（轻量分支同口径）：shared-chat 以 owner 身份进入，
        # app_context._shared_chat_by 命中时这条 user 消息 sender=grantee 并
        # 合并 shared_chat metadata；既有调用方不带该 key，行为不变。
        sender_user_id, shared_chat_metadata = resolve_sender_attribution(
            str(user.id) if user else '', app_context,
        )
        extra_metadata = (
            execution_context.to_message_metadata()
            if execution_context is not None else None
        )
        if shared_chat_metadata:
            extra_metadata = {**(extra_metadata or {}), **shared_chat_metadata}

        user_messages = persist_user_messages(
            session, messages, user_message_ids, prep.model_instance, blocks, attachments,
            sender_user_id=sender_user_id,
            client_message_id=client_message_id,
            extra_metadata=extra_metadata,
            **extract_persist_reply_kwargs_from_app_context(app_context),
        )
        user_message_ids_list = [msg.id for msg in user_messages]
        logger.info("[ChatService] User messages: %s", " | ".join(messages))
        publish_user_messages_to_stream(prep.effective_thread_id, user_messages)

        previous_count = (
            ChatMessage.objects.filter(session=session)
            .exclude(id__in=user_message_ids_list)
            .count()
        )
        is_first_message = previous_count == 0

        from apps.services.agent_engine.execution_profile import get_profile, PROFILE_CONVERSATIONAL
        profile = get_profile(execution_profile or PROFILE_CONVERSATIONAL)
        if is_first_message and profile.enable_title_generation:
            spawn_title_thread(
                str(session.id),
                prep.effective_thread_id,
                messages[0],
                selected_model_id=(
                    str(prep.model_instance.id) if prep.model_instance else None
                ),
            )

        return ChatService._IngestResult(
            user_messages=user_messages,
            user_message_ids_list=user_message_ids_list,
            is_first_message=is_first_message,
        )

    @staticmethod
    def _stage_contextualize(
        *, session, user, prep, ingest, messages, blocks,
        app_context, client_type, execution_profile,
        api_token_space_ids, agent_mode,
        execution_context=None,
        client_message_id: Optional[str] = None,
    ):
        """Stage 3: 上下文组装 + 权限 + Agent state 构建 → 委托 context_assembler。

        ``client_message_id``（阶段 6 议题 2）：本轮 user message 的客户端 UUID，
        传给 ``assemble_full_context`` 让 referenced wrapper 能挂 ``stale_after_turn``，
        实现跨轮过期检测。
        """
        return _assemble_full_context(
            session=session, user=user,
            effective_thread_id=prep.effective_thread_id,
            model_instance=prep.model_instance,
            model_fell_back=prep.model_fell_back,
            final_model_id=prep.final_model_id,
            user_selected_model=prep.user_selected_model,
            resolved_agent_name=prep.resolved_agent_name,
            is_first_message=ingest.is_first_message,
            messages=messages, blocks=blocks,
            app_context=app_context, client_type=client_type,
            execution_profile=execution_profile,
            api_token_space_ids=api_token_space_ids,
            agent_mode=agent_mode,
            execution_context=execution_context,
            client_message_id=client_message_id,
        )

    @staticmethod
    def _stage_route(
        *, session, user, prep, ingest, ctx,
        app_context, client_type, execution_profile,
        attachments,
        messages: Optional[List[str]] = None,
        # ：Host 拼装用原始 blocks（勿用 contextualize 写过 _resolved_text 的副本）
        blocks: Optional[list] = None,
        execution_context=None,
        client_message_id: Optional[str] = None,
        # PR4-yolo (PRD v3 §5.6)：消息 body 透传的 AgentMode 走到 dispatch_external，
        # 落到 thread_context._agent_mode_var 给 publish_action 链路读到。
        agent_mode: Optional[str] = None,
        # ：审批档位，与 agent_mode 同链路透传。
        approval_mode: Optional[str] = None,
    ):
        """Stage 4: 路由决策 → 委托 agent_router。"""
        # ：外部 Host 只收用户原文；Django contextualize 的 plain_text
        # （含 referenced/preset 拼装）不得再进 prompt.forward，否则与 Host 双拼。
        host_prompt = "\n".join(messages) if messages else ctx.plain_text
        host_blocks = blocks if blocks is not None else ctx.blocks
        routing = _resolve_route(
            session=session, user=user,
            # 执行现场的唯一来源是 ChatSession.workspace_id。ChatContext 记录的是
            # 用户当前资源/协作上下文，不能反向决定 Agent 在哪个目录执行。
            workspace_id=getattr(session, "workspace_id", None),
            input_state=ctx.input_state, plain_text=host_prompt,
            model_id=prep.final_model_id, model_instance=prep.model_instance,
            effective_thread_id=prep.effective_thread_id,
            user_messages=ingest.user_messages,
            blocks=host_blocks, attachments=attachments,
            client_type=client_type, execution_profile=execution_profile,
            app_context=app_context,
            # M2.5 方案 B（P1.3）：客户端 UUID 一路透传到 DaemonAgentHost。
            client_message_id=client_message_id,
            # PR4-yolo：AgentMode 透传到 agent_router → AgentDispatcher → ContextVar。
            agent_mode=agent_mode,
            # ：审批档位透传到 agent_router → AgentDispatcher → forward payload。
            approval_mode=approval_mode,
            execution_context=execution_context,
        )
        return _handle_routing_decision(
            routing,
            session=session,
            effective_thread_id=prep.effective_thread_id,
            model_instance=prep.model_instance,
            user_messages=ingest.user_messages,
        )

    # ────────────────────────────────────────────────────────
    #  主流水线
    # ────────────────────────────────────────────────────────

    @staticmethod
    def _process_message_sync_core(
        *,
        session,
        user,
        messages: List[str],
        model_id: Optional[str],
        thread_id: Optional[str] = None,
        user_message_ids: Optional[List[str]] = None,
        agent_name: Optional[str] = None,
        blocks: Optional[list] = None,
        attachments: Optional[list] = None,
        client_type: Optional[str] = None,
        execution_profile: Optional[str] = None,
        app_context: Optional[Dict[str, Any]] = None,
        agent_mode: Optional[str] = None,
        #  三档审批策略：对话级请求的审批档位（always_ask/auto/full_access），
        # 与 agent_mode 正交。透传到 forward payload 给设备 host 派生 judge 三档。
        approval_mode: Optional[str] = None,
        api_token_space_ids: Optional[List[str]] = None,
        client_message_id: Optional[str] = None,
    ) -> Dict[str, str]:
        if not messages:
            raise_bad_request(MSG_MESSAGES_REQUIRED)

        _core_t0 = time.monotonic()
        _sid = str(session.id)[:8]
        execution_context = ChatService._resolve_execution_context(
            session=session,
            user=user,
        )
        unavailable_response = ChatService._owner_execution_unavailable_response(
            execution_context,
        )
        if unavailable_response is not None:
            return unavailable_response

        # Stage 1: Prepare
        prep = ChatService._stage_prepare(
            session=session, user=user, messages=messages, model_id=model_id,
            thread_id=thread_id, agent_name=agent_name,
            execution_profile=execution_profile, app_context=app_context,
            client_type=client_type,
            execution_user=execution_context.execution_owner_user,
        )
        _core_t1 = time.monotonic()
        logger.info("[TTFT] Stage1(prepare): %.0fms | s=%s", (_core_t1 - _core_t0) * 1000, _sid)
        if isinstance(prep, dict):
            return prep

        # Stage 2: Ingest
        ingest = ChatService._stage_ingest(
            session=session, user=user, messages=messages, prep=prep,
            user_message_ids=user_message_ids, blocks=blocks,
            attachments=attachments, client_message_id=client_message_id,
            execution_profile=execution_profile,
            app_context=app_context,
            execution_context=execution_context,
        )
        _core_t2 = time.monotonic()
        logger.info("[TTFT] Stage2(ingest): %.0fms | s=%s", (_core_t2 - _core_t1) * 1000, _sid)

        # Stage 3: Contextualize
        ctx = ChatService._stage_contextualize(
            session=session, user=user, prep=prep, ingest=ingest,
            messages=messages, blocks=blocks,
            app_context=app_context, client_type=client_type,
            execution_profile=execution_profile,
            api_token_space_ids=api_token_space_ids,
            agent_mode=agent_mode,
            execution_context=execution_context,
            # 阶段 6 议题 2：透传 client_message_id 让 prepare_message_content 给
            # referenced wrapper 挂 stale_after_turn，跨轮过期可识别。
            client_message_id=client_message_id,
        )
        _core_t3 = time.monotonic()
        logger.info("[TTFT] Stage3(contextualize): %.0fms | s=%s", (_core_t3 - _core_t2) * 1000, _sid)

        # Stage 4: Route → dispatch to external device
        route_result = ChatService._stage_route(
            session=session, user=user, prep=prep, ingest=ingest, ctx=ctx,
            app_context=app_context, client_type=client_type,
            execution_profile=execution_profile, attachments=attachments,
            # ：原文 + 原始 blocks 给 Host，避免 contextualize 双拼
            messages=messages,
            blocks=blocks,
            execution_context=execution_context,
            # M2.5 方案 B（P1.3）：把客户端生成的 message UUID 一路透传到
            # DaemonAgentHost，runtime 主轮 yield USER 事件时用此 id 闭合
            # temp id → server id 映射。详见
            client_message_id=client_message_id,
            # PR4-yolo (PRD v3 §5.6)：AgentMode 透传给路由层。
            agent_mode=agent_mode,
            # ：审批档位透传给路由层。
            approval_mode=approval_mode,
        )
        _core_t4 = time.monotonic()
        logger.info("[TTFT] Stage4(route+dispatch): %.0fms | 全链路: %.0fms | s=%s",
                     (_core_t4 - _core_t3) * 1000, (_core_t4 - _core_t0) * 1000, _sid)
        if route_result is not None:
            return route_result

        from apps.services.common.i18n import error_generic
        logger.error("[ChatService] Route returned None — no backend handled the message: s=%s", _sid)
        return {
            # Stage 2 已经持久化 USER；NAK 必须带回该事实 ID，让移动端闭合
            # optimistic 气泡并只重试执行，而不是误判整条消息未保存。
            "message_id": (
                str(ingest.user_messages[0].id)
                if ingest.user_messages else ""
            ),
            "reply": error_generic(),
            "model_id": None,
            "model_name": None,
            "trace_id": None,
            "error_category": "route_none",
            "retryable": True,
        }

    # ────────────────────────────────────────────────────────
    #  公共入口（签名不变）
    # ────────────────────────────────────────────────────────

    @staticmethod
    def send_message_sync(
        session_id: str,
        user,
        message: str,
        model_id: Optional[str] = None,
        agent_name: Optional[str] = None,
        blocks: Optional[list] = None,
        attachments: Optional[list] = None,
        client_type: Optional[str] = None,
        execution_profile: Optional[str] = None,
        app_context: Optional[Dict[str, Any]] = None,
        agent_mode: Optional[str] = None,
        #  三档审批策略：对话级请求的审批档位（always_ask/auto/full_access）。
        approval_mode: Optional[str] = None,
        api_token_space_ids: Optional[List[str]] = None,
        client_message_id: Optional[str] = None,
    ) -> Dict[str, str]:
        """
        发送消息（同步版本）

        Args:
            session_id: 会话ID
            user: 用户对象
            message: 用户消息
            model_id: 指定使用的模型 UUID（可选，覆盖会话默认）
            agent_name: Agent 名称（当前仅支持 tin，可选）
            client_type: 客户端类型（electron / ios / android / web / server）
            execution_profile: 执行模式（conversational / task / oneshot）
            app_context: 显式 App 上下文（task/oneshot 模式用）。
            api_token_space_ids: OpenAPI Token 的 space_ids 约束（AC-009）。
            client_message_id: 前端生成的消息唯一标识（UUID）。

        Returns:
            {
                "message_id": "消息ID",
                "reply": "AI回复",
                "model_id": "实际使用的模型 UUID",
                "model_name": "实际使用的模型名称"
            }
        """
        from apps.chat.conversation.models import ChatSession, ChatMessage
        from apps.services.agent_engine.services.message_queue_service import (
            MessageQueueService, LockWatchdog, LockResult,
            QueueEnqueueError, QueueEnqueueStatus,
            _process_lock_fallback,
        )

        _sync_t0 = time.monotonic()

        # Wave 1（iOS thin client）：客户端 UUID 与 Redis 5 秒 SHA1 去重桶解耦。
        # 入参 ``client_message_id`` 是客户端事件 UUID（持久化用），持锁主路径
        # 里另用独立变量 ``dedupe_key`` 做 Redis 去重，绝不再覆盖入参。
        # 兼容老调用方传 None / 空串（如 lightweight_dispatch / 部分单测）：
        # 先归一化再兜底 uuid4()，确保 _process_message_sync_core 始终拿到合法
        # UUID 一路透传给 persistence_pipeline / DaemonAgentHost。
        provided_client_message_id = (client_message_id or "").strip() or None
        client_message_id = provided_client_message_id or str(uuid.uuid4())
        # GUI 客户端重投必须以其稳定事件 UUID 去重；只有旧调用方没提供 UUID
        # 时才退回 5 秒内容桶。旧实现始终用内容 SHA1，两个不同事件的同文消息
        # 会互相吞掉，而同一事件跨 5 秒又会重复执行。
        dedupe_key = provided_client_message_id or build_client_message_id(
            session_id,
            str(user.id),
            message,
        )

        # v0.1 宪法 §5.1：current_model / default_model 是软引用 UUIDField，不再 prefetch_related。
        # context 是 OneToOne 反向关联，仍可 prefetch。
        session = ChatSession.objects.prefetch_related("context").filter(
            id=session_id,
            user=user,
        ).first()
        if not session:
            from apps.chat.conversation.api import _get_session_with_shared_access
            # ：send 即驱动执行（副作用）——session-share grantee 不得直呼；
            # shared-chat 端点以 owner 身份进入，workspace 共享成员保持原行为。
            session, _is_shared = _get_session_with_shared_access(
                session_id, user, include_session_share=False,
            )
            if not session:
                raise_not_found(MSG_SESSION_NOT_FOUND)
        # 下游 model_resolver / 工具调用会读 session.current_model / default_model，
        # 这里一次 attach 把 LLMModel 注入缓存避免后续 N+1
        from apps.chat.conversation.services.llm_model_loader import attach_llm_models_to_sessions
        attach_llm_models_to_sessions([session])
        execution_context = ChatService._resolve_execution_context(
            session=session,
            user=user,
        )
        unavailable_response = ChatService._owner_execution_unavailable_response(
            execution_context,
        )
        if unavailable_response is not None:
            return unavailable_response

        thread_id = ensure_thread_id(session, session_id)
        _sync_t1 = time.monotonic()
        logger.info("[TTFT] session查询: %.0fms | session=%s", (_sync_t1 - _sync_t0) * 1000, session_id)

        queue_service = MessageQueueService()
        queue_settings = load_queue_settings(queue_service)
        lock_token = uuid.uuid4().hex
        lock_ttl = int(queue_settings.get("lock_ttl", 600))
        lock_result = queue_service.acquire_lock(
            thread_id,
            lock_token,
            ttl=lock_ttl,
        )
        _sync_t2 = time.monotonic()
        logger.info("[TTFT] 锁获取: %.0fms result=%s | session=%s", (_sync_t2 - _sync_t1) * 1000, lock_result.name if hasattr(lock_result, 'name') else lock_result, session_id)

        if lock_result == LockResult.REDIS_ERROR:
            _fallback_acquired = _process_lock_fallback.try_acquire(thread_id)
            if not _fallback_acquired:
                logger.warning(
                    "[ChatService] Redis unavailable and process-level lock "
                    "held by another thread: thread=%s (rejecting duplicate)",
                    thread_id,
                )
                from apps.services.common.i18n import error_generic
                return {
                    "message_id": "",
                    "reply": error_generic(),
                    "model_id": None,
                    "model_name": None,
                    "_rejected_concurrent": True,
                }

            logger.warning(
                "[ChatService] Redis unavailable, falling back to process-level "
                "lock for sync processing: thread=%s", thread_id,
            )
            try:
                try:
                    from django.utils import timezone
                    import datetime as _dt
                    _DEDUPE_WINDOW = _dt.timedelta(seconds=10)
                    _cutoff = timezone.now() - _DEDUPE_WINDOW
                    _dup_user_msg = None
                    if provided_client_message_id:
                        try:
                            _client_uuid = uuid.UUID(provided_client_message_id)
                        except (ValueError, TypeError, AttributeError):
                            _client_uuid = None
                        if _client_uuid is not None:
                            _dup_user_msg = ChatMessage.objects.filter(
                                session=session,
                                role="user",
                                client_event_id=_client_uuid,
                            ).first()
                    if _dup_user_msg is None and not provided_client_message_id:
                        # 仅兼容没有稳定 ID 的旧调用方；W3 正文字段是
                        # text_summary，禁止再查询已删除的 content。
                        _dup_user_msg = (
                            ChatMessage.objects
                            .filter(
                                session=session,
                                role="user",
                                text_summary=message,
                                created_at__gte=_cutoff,
                            )
                            .order_by("-created_at")
                            .first()
                        )
                    if _dup_user_msg:
                        persisted_response = build_dedupe_response(
                            session,
                            str(_dup_user_msg.id),
                            client_message_id=provided_client_message_id,
                        )
                        persisted_metadata = (
                            (_dup_user_msg.metadata or {}).get(
                                "chat_delivery_result_v1"
                            )
                            if isinstance(_dup_user_msg.metadata, dict)
                            else None
                        )
                        if isinstance(persisted_metadata, dict) and persisted_response:
                            logger.info(
                                "[ChatService] REDIS_ERROR stable dedupe hit: session=%s user=%s",
                                session_id,
                                _dup_user_msg.id,
                            )
                            return persisted_response

                        # 兼容尚未写 delivery metadata 的旧缓存：只把真正的
                        # assistant 当回复读取，USER 本身绝不当 assistant。
                        _dup_assistant = (
                            ChatMessage.objects
                            .filter(
                                session=session, role="assistant",
                                created_at__gte=_dup_user_msg.created_at,
                            )
                            .order_by("created_at")
                            .first()
                        )
                        if _dup_assistant:
                            logger.info(
                                "[ChatService] REDIS_ERROR dedupe hit: session=%s "
                                "returning existing assistant msg=%s",
                                session_id, _dup_assistant.id,
                            )
                            legacy_response = build_dedupe_response(
                                session,
                                str(_dup_assistant.id),
                            )
                            if legacy_response:
                                return legacy_response
                except Exception as _dedupe_exc:
                    logger.warning(
                        "[ChatService] REDIS_ERROR dedupe check failed, proceeding: %s",
                        _dedupe_exc,
                    )

                result = ChatService._process_message_sync_core(
                    session=session,
                    user=user,
                    messages=[message],
                    model_id=model_id,
                    thread_id=thread_id,
                    agent_name=agent_name,
                    blocks=blocks,
                    attachments=attachments,
                    client_type=client_type,
                    execution_profile=execution_profile,
                    app_context=app_context,
                    agent_mode=agent_mode,
                    approval_mode=approval_mode,
                    api_token_space_ids=api_token_space_ids,
                    client_message_id=client_message_id,
                )
                if not result.get("error_category"):
                    persist_dedupe_result(
                        session,
                        client_message_id,
                        result,
                    )
                return result
            finally:
                _process_lock_fallback.release(thread_id)

        if lock_result == LockResult.HELD_BY_OTHER:
            resolved = _resolve_model(session, model_id)
            model_instance = resolved.instance
            resolved_model_id = str(model_instance.id) if model_instance else None
            resolved_model_name = model_instance.model_name if model_instance else None
            try:
                _event_uuid = uuid.UUID(client_message_id)
            except (ValueError, TypeError, AttributeError):
                _event_uuid = None
            user_existed = bool(
                _event_uuid
                and ChatMessage.objects.filter(
                    session=session,
                    role="user",
                    client_event_id=_event_uuid,
                ).exists()
            )
            # 与主路径共用 W3 持久化契约；先落库并立即广播 user mirror，观察端
            # 不必等前一轮执行结束才看到这条已受理消息。
            # ：排队分支同样应用 shared-chat 发言归属（与 _stage_ingest 对齐）。
            from apps.services.agent_engine.services.persistence_pipeline import (
                resolve_sender_attribution,
            )
            sender_user_id, shared_chat_metadata = resolve_sender_attribution(
                str(user.id) if user else "",
                app_context,
            )
            queue_extra_metadata = (
                execution_context.to_message_metadata()
                if execution_context is not None
                else None
            )
            if shared_chat_metadata:
                queue_extra_metadata = {
                    **(queue_extra_metadata or {}),
                    **shared_chat_metadata,
                }
            user_message = persist_user_messages(
                session,
                [message],
                None,
                model_instance,
                blocks,
                attachments,
                sender_user_id=sender_user_id,
                client_message_id=client_message_id,
                extra_metadata=queue_extra_metadata,
                **extract_persist_reply_kwargs_from_app_context(app_context),
            )[0]
            queued_result = {
                "message_id": str(user_message.id),
                "reply": "[queued] Message queued. Auto-reply will follow shortly.",
                "model_id": resolved_model_id,
                "model_name": resolved_model_name,
                "trace_id": None,
                "delivery": "queued",
                "execution_state": "awaiting_run",
            }
            payload = build_queue_payload(
                message=message,
                model_id=resolved_model_id,
                user_message_id=str(user_message.id),
                agent_name=agent_name,
                blocks=blocks,
                attachments=attachments,
                client_type=client_type,
                execution_profile=execution_profile,
                app_context=app_context,
                agent_mode=agent_mode,
                approval_mode=approval_mode,
                client_message_id=client_message_id,
                dedupe_key=dedupe_key,
            )
            try:
                enqueue_result = enqueue_payload_once(
                    queue_service,
                    thread_id,
                    payload,
                    queue_settings,
                    dedupe_key=dedupe_key,
                    queued_result=queued_result,
                )
            except QueueEnqueueError:
                if not user_existed:
                    publish_user_messages_to_stream(thread_id, [user_message])
                logger.exception(
                    "[ChatService] Queue enqueue unavailable: thread=%s client_event_id=%s",
                    thread_id,
                    client_message_id,
                )
                return {
                    "message_id": str(user_message.id),
                    "reply": "Message was saved, but the execution queue is unavailable.",
                    "model_id": resolved_model_id,
                    "model_name": resolved_model_name,
                    "trace_id": None,
                    "error_category": "queue_unavailable",
                    "retryable": True,
                }

            if enqueue_result.status == QueueEnqueueStatus.DUPLICATE:
                response = build_dedupe_response(
                    session,
                    enqueue_result.cached_result,
                    client_message_id=client_message_id,
                )
                if response:
                    return response
                return {
                    "message_id": str(user_message.id),
                    "reply": "This message is already being processed.",
                    "model_id": resolved_model_id,
                    "model_name": resolved_model_name,
                    "trace_id": None,
                    "_rejected_concurrent": True,
                }

            if not user_existed:
                publish_user_messages_to_stream(thread_id, [user_message])

            if enqueue_result.status == QueueEnqueueStatus.FULL:
                return {
                    "message_id": str(user_message.id),
                    "reply": "Message was saved, but the execution queue is full.",
                    "model_id": resolved_model_id,
                    "model_name": resolved_model_name,
                    "trace_id": None,
                    "error_category": "queue_full",
                    "retryable": True,
                }

            # 请求线程只投递恢复任务并立即 ACK。Celery 任务会重新抢锁：若原
            # owner 仍在执行则延迟重试；若 owner 已在尾部窗口释放则接管 drain。
            recovery_scheduled = _schedule_queue_recovery(
                session_id=str(session.id),
                user_id=str(user.id),
                thread_id=thread_id,
            )
            if recovery_scheduled:
                return queued_result

            if not _recover_queue_inline_after_schedule_failure(
                session=session,
                user=user,
                thread_id=thread_id,
                queue_service=queue_service,
                queue_settings=queue_settings,
            ):
                return {
                    "message_id": str(user_message.id),
                    "reply": "Message was saved, but queue recovery could not be started.",
                    "model_id": resolved_model_id,
                    "model_name": resolved_model_name,
                    "trace_id": None,
                    "error_category": "queue_recovery_unavailable",
                    "retryable": True,
                }

            recovered = build_dedupe_response(
                session,
                queue_service.get_dedupe_result(thread_id, dedupe_key),
                client_message_id=client_message_id,
            )
            return recovered or queued_result

        # lock_result == LockResult.ACQUIRED
        with LockWatchdog(queue_service, thread_id, lock_token, lock_ttl) as _wd:
            try:
                # GUI 客户端以稳定 client_event_id 去重；老调用方未提供 ID 时
                # 才使用内容时间桶。入参 UUID 仍一路透传到持久化与 runtime。
                dedupe_result = queue_service.get_dedupe_result(thread_id, dedupe_key)
                if dedupe_result:
                    response = build_dedupe_response(
                        session,
                        dedupe_result,
                        client_message_id=provided_client_message_id,
                    )
                    if response:
                        return response
                if provided_client_message_id:
                    persisted_response = build_dedupe_response(
                        session,
                        None,
                        client_message_id=provided_client_message_id,
                    )
                    if persisted_response:
                        queue_service.set_dedupe_result(
                            thread_id,
                            dedupe_key,
                            persisted_response,
                            ttl=int(queue_settings.get("dedupe_ttl", 300) or 300),
                        )
                        return persisted_response

                dedupe_ttl = int(queue_settings.get("dedupe_ttl", 300))
                pending = queue_service.set_dedupe_pending(
                    thread_id,
                    dedupe_key,
                    ttl=dedupe_ttl,
                    worker_id=lock_token,
                )
                if not pending:
                    for _ in range(3):
                        time.sleep(0.2)
                        dedupe_result = queue_service.get_dedupe_result(thread_id, dedupe_key)
                        if dedupe_result:
                            response = build_dedupe_response(
                                session,
                                dedupe_result,
                                client_message_id=provided_client_message_id,
                            )
                            if response:
                                return response
                    if queue_service.try_reclaim_stale_pending(thread_id, dedupe_key, ttl=dedupe_ttl):
                        pending = queue_service.set_dedupe_pending(
                            thread_id, dedupe_key,
                            ttl=dedupe_ttl, worker_id=lock_token,
                        )
                    else:
                        dedupe_result = queue_service.get_dedupe_result(thread_id, dedupe_key)
                        if dedupe_result:
                            response = build_dedupe_response(
                                session,
                                dedupe_result,
                                client_message_id=provided_client_message_id,
                            )
                            if response:
                                return response

                    if not pending:
                        # pending 仍被别的 worker 持有，或 Redis 写入失败。没有
                        # 原子 owner 身份就绝不能继续 dispatch；让客户端稍后重试。
                        return {
                            "message_id": "",
                            "reply": "This message is already being processed.",
                            "model_id": None,
                            "model_name": None,
                            "trace_id": None,
                            "_rejected_concurrent": True,
                        }

                try:
                    result = ChatService._process_message_sync_core(
                        session=session,
                        user=user,
                        messages=[message],
                        model_id=model_id,
                        thread_id=thread_id,
                        agent_name=agent_name,
                        blocks=blocks,
                        attachments=attachments,
                        client_type=client_type,
                        execution_profile=execution_profile,
                        app_context=app_context,
                        agent_mode=agent_mode,
                        approval_mode=approval_mode,
                        api_token_space_ids=api_token_space_ids,
                        client_message_id=client_message_id,
                    )
                except Exception:
                    queue_service.clear_dedupe_pending(
                        thread_id,
                        dedupe_key,
                        lock_token,
                    )
                    raise
                if result.get("error_category"):
                    # 业务错误只代表 USER 可能已落库，不代表执行成功。不能把
                    # USER id 固化成 dedupe success，否则同一 5 秒窗口再次提交会
                    # 被 build_dedupe_response 误 ACK。清掉当前 pending，让重试
                    # 重新得到真实路由 / 计费 NAK（无论错误是否 retryable）。
                    queue_service.clear_dedupe_pending(
                        thread_id,
                        dedupe_key,
                        lock_token,
                    )
                elif (
                    result.get("message_id")
                    or result.get("task_id")
                    or result.get("_remote_agent_task_id")
                    or result.get("dispatched_external")
                ):
                    queue_service.set_dedupe_result(
                        thread_id,
                        dedupe_key,
                        result,
                        ttl=max(
                            int(queue_settings.get("dedupe_ttl", 300) or 300),
                            int(queue_settings.get("queue_ttl", 0) or 0),
                        ),
                    )
                    persist_dedupe_result(
                        session,
                        client_message_id,
                        result,
                    )

                return result
            finally:
                try:
                    drain_queue_until_safely_released(
                        session=session,
                        user=user,
                        thread_id=thread_id,
                        queue_service=queue_service,
                        queue_settings=queue_settings,
                        lock_token=lock_token,
                        watchdog=_wd,
                        process_fn=ChatService._process_message_sync_core,
                        error_fn=push_queue_error,
                    )
                except Exception as drain_exc:
                    logger.error(
                        "[ChatService] Queue drain failed in finally block "
                        "(thread=%s): %s", thread_id, drain_exc, exc_info=True,
                    )
                    # Best-effort fallback for Redis/script failures.  Normal
                    # flow releases inside drain_queue_until_safely_released.
                    queue_service.release_lock(thread_id, lock_token)



__all__ = ['ChatService']
