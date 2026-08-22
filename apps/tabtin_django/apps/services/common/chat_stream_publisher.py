"""
ChatStreamPublisher — Agent 对话流 WebSocket 事件推送

从 ChatService 中抽取的独立推送层，负责所有 WS 事件的构建和发布。
ChatService / agent_api 等调用方通过本模块发送事件，不再自行拼装 WS 帧。

设计原则：
  - 所有方法为 @staticmethod，无实例状态
  - 仅依赖 ws.bus / ws.protocol / namespace，不依赖 Django 模型或 ChatService
  - _DeltaThrottle 通过构造函数注入 publisher 引用实现解耦
"""

from __future__ import annotations

import logging
import threading
import time
from collections import OrderedDict
from typing import Any, Dict, List, Optional, Tuple

from django.conf import settings as django_settings

from apps.services.common.agent_protocol.constants import (
    AgentStreamEvent,
    AgentUserEvent,
)
from apps.services.common.agent_protocol.namespace import (
    stream_event_type,
    stream_topic,
    user_event_type,
)
from apps.services.common.ws.bus import (
    publish_to_user,
    publish_ws_event,
    publish_ws_event_reliable,
)
from apps.services.common.ws.protocol import build_envelope, new_event_id

logger = logging.getLogger(__name__)

_SEQ_KEY_PREFIX = "stream:seq:"
_SEQ_KEY_TTL = 86400  # 24h sliding TTL as safety net


# Wave 5（R3-02）— 进程级 thread_id → organization_id LRU 缓存。
#
# 背景：
#   - Wave 3 前端事件分桶 `useBackgroundEventStore` 依赖 envelope.organization_id
#     做 per-organization 路由；
#   - 但 ChatStreamPublisher 历史上**不**注入 organization_id 到 envelope，前端
#     需要靠 chatApi 的 `resolveOrganizationIdFromChatStore` 反查 useChatStore.sessionsBySpaceId
#     —— 仅对"用户已访问过的 thread"有效，跨设备 / Daemon 后台启动 thread 推送
#     全部 fallback 失败被 drop。
#
# 修复策略：
#   - 在 ChatStreamPublisher._resolve_thread_organization 做一次性 DB 查询（thread →
#     ChatSession.organization_id 或 ExecutionRun.organization_id），结果以 (thread_id,
#     organization_id) 形式缓存；
#   - LRU 大小 1024（Goal/StreamingExecutor/SubAgent 等多源调用，进程级共享降低
#     冷启动 miss）；TTL 600 秒（thread → organization 关系稳定，不会变）；
#   - None 也缓存（避免被异常 thread_id 反复打 DB）；
#   - publish_ws 在原 envelope 基础上附加 organization_id 字段（若解析到）。
_ORGANIZATION_CACHE_MAX = 1024
_ORGANIZATION_CACHE_TTL_S = 600.0
_organization_cache: "OrderedDict[str, Tuple[Optional[str], float]]" = OrderedDict()
_organization_cache_lock = threading.Lock()


def _resolve_thread_organization(thread_id: str) -> Optional[str]:
    """thread_id → organization_id 解析（DB 查询，**不要**在热路径直接调用，先走缓存）。

    解析顺序：
      1. ChatSession.thread_id == thread_id（默认主路径）
      2. ChatSession.id == thread_id（剥离 chat-session- 前缀后）
      3. ExecutionRun.thread_id == thread_id（Goal 步骤、SubAgent 等）

    任何失败/异常 → 返回 None，上层不写 organization_id 字段。
    """
    if not thread_id:
        return None
    try:
        from apps.chat.conversation.models import ChatSession
        ws_id = ChatSession.objects.filter(
            thread_id=thread_id,
        ).values_list("organization_id", flat=True).first()
        if ws_id:
            return str(ws_id)

        if thread_id.startswith("chat-session-"):
            session_id = thread_id[len("chat-session-"):]
            ws_id = ChatSession.objects.filter(
                id=session_id,
            ).values_list("organization_id", flat=True).first()
            if ws_id:
                return str(ws_id)
    except Exception:
        logger.debug(
            "[ChatStreamPublisher] ChatSession organization lookup failed for thread=%s",
            thread_id, exc_info=True,
        )

    try:
        from apps.services.agent_engine.models import ExecutionRun
        ws_id = ExecutionRun.objects.filter(
            thread_id=thread_id,
        ).order_by("-started_at").values_list("organization_id", flat=True).first()
        if ws_id:
            return str(ws_id)
    except Exception:
        logger.debug(
            "[ChatStreamPublisher] ExecutionRun organization lookup failed for thread=%s",
            thread_id, exc_info=True,
        )

    return None


def _resolve_thread_organization_cached(thread_id: str) -> Optional[str]:
    """LRU 缓存包装。命中即用，未命中走 DB 后回填。"""
    if not thread_id:
        return None
    now = time.monotonic()
    with _organization_cache_lock:
        entry = _organization_cache.get(thread_id)
        if entry is not None:
            ws_id, expires_at = entry
            if expires_at > now:
                _organization_cache.move_to_end(thread_id)
                return ws_id
            _organization_cache.pop(thread_id, None)

    ws_id = _resolve_thread_organization(thread_id)

    with _organization_cache_lock:
        _organization_cache[thread_id] = (ws_id, now + _ORGANIZATION_CACHE_TTL_S)
        _organization_cache.move_to_end(thread_id)
        while len(_organization_cache) > _ORGANIZATION_CACHE_MAX:
            _organization_cache.popitem(last=False)
    return ws_id


def _invalidate_thread_organization_cache(thread_id: Optional[str] = None) -> None:
    """测试 / 异常恢复用：清空指定 thread 或全部缓存。"""
    with _organization_cache_lock:
        if thread_id is None:
            _organization_cache.clear()
        else:
            _organization_cache.pop(thread_id, None)


def _next_seq(thread_id: str) -> int:
    """Redis INCR 原子递增，跨进程安全的 per-thread 序列号。"""
    try:
        from django_redis import get_redis_connection
        redis_client = get_redis_connection("default")
        key = f"{_SEQ_KEY_PREFIX}{thread_id}"
        seq = redis_client.incr(key)
        redis_client.expire(key, _SEQ_KEY_TTL)
        return seq
    except Exception:
        logger.debug(
            "[ChatStreamPublisher] Redis INCR stream seq 失败，回退 0: thread_id=%s",
            thread_id,
            exc_info=True,
        )
        return 0


def _reset_seq(thread_id: str) -> None:
    """lifecycle start/end 时重置序列号，保证每轮 run 从 1 开始。"""
    try:
        from django_redis import get_redis_connection
        redis_client = get_redis_connection("default")
        redis_client.delete(f"{_SEQ_KEY_PREFIX}{thread_id}")
    except Exception as exc:
        logger.debug(
            "[ChatStreamPublisher] Redis 重置 stream seq 失败（序号可能沿用）: %s", exc,
        )


class ChatStreamPublisher:
    """Agent 对话流 WS 事件推送中心。"""

    # ------------------------------------------------------------------
    # 核心推送入口
    # ------------------------------------------------------------------

    # v0.4 W1.5（PRD 05 §7.4.1）：批量审批事件 approval_requested / approval_resolved
    # 走 reliable publish_ws，修复移动端弱网下丢事件的 bug。旧 review_required 已按
    # D6 一刀切删除（runtime 不再 emit；客户端面板已切到统一 approval 协议）。
    #
    # W3 §3.4：6 件套（message_* + content_block_*）边界 + 元事件 reliable publish：
    # - message_start / message_stop / content_block_start / content_block_stop：
    #   消息生命周期边界，弱网丢失会让 UI 状态机错乱（譬如 message_stop 丢了
    #   spinner 永远转）
    # - **message_delta**：携带 stop_reason / stop_sequence / usage（cumulative）
    #   ——Anthropic 协议下 usage 由 message_delta 携带（不是 message_stop），
    #   弱网/移动端丢失会让 ChatMessage.usage_json=None + stop_reason='' +
    #   error_info_json 反推失败。频率低（1 message 1-2 次），适合 reliable。
    # - content_block_delta：高频文本增量（1000 token/s 量级），丢一两个不影响
    #   整体——保持非 reliable 节省 bandwidth。
    # - message_committed：后端 ChatMessage 事务成功后的事实边界；客户端用它
    #   安全触发历史对齐，丢失会让观察端继续误把 message_stop 当落库完成。
    _CRITICAL_EVENTS = frozenset({
        AgentStreamEvent.LIFECYCLE,
        AgentStreamEvent.DONE,
        AgentStreamEvent.ASK_USER_REQUIRED,
        AgentStreamEvent.ASK_FORM_REQUIRED,
        AgentStreamEvent.REQUEST_APPROVAL_REQUIRED,
        AgentStreamEvent.APPROVAL_REQUESTED,
        AgentStreamEvent.APPROVAL_RESOLVED,
        # ：单 HITL 终态回流——与 *_REQUIRED 同为 critical，reliable 广播才能在
        # 重连重放里按 seq 顺序压住 *_required（弱网 / 多端不丢终态）。
        AgentStreamEvent.SINGLE_HITL_RESOLVED,
        AgentStreamEvent.PERSIST_ERROR,
        # User messages are the first visible fact in a turn. Observers must not
        # depend on the runtime echo to see them.
        AgentStreamEvent.USER,
        # W3 §3.4：6 件套边界 + message_delta（携带 stop_reason + usage）reliable
        AgentStreamEvent.MESSAGE_START,
        AgentStreamEvent.MESSAGE_DELTA,  # P0-2 修复：携带 stop_reason/usage，必 reliable
        AgentStreamEvent.MESSAGE_STOP,
        AgentStreamEvent.MESSAGE_COMMITTED,
        AgentStreamEvent.CONTENT_BLOCK_START,
        AgentStreamEvent.CONTENT_BLOCK_STOP,
    })

    _E2E_VERBOSE_EVENTS = frozenset({
        # W4.5 第三波 C1（2026-05-13）：AgentStreamEvent.TOOL 短名已物理删
        AgentStreamEvent.STEP,
        AgentStreamEvent.LIFECYCLE,
        AgentStreamEvent.DONE,
        AgentStreamEvent.ASK_USER_REQUIRED,
        AgentStreamEvent.ASK_FORM_REQUIRED,
        AgentStreamEvent.REQUEST_APPROVAL_REQUIRED,
        AgentStreamEvent.APPROVAL_REQUESTED,
        AgentStreamEvent.APPROVAL_RESOLVED,
        AgentStreamEvent.SYSTEM_NOTICE,
        AgentStreamEvent.TODO,
    })

    @staticmethod
    def publish_ws(
        thread_id: str,
        event_type: str,
        payload: Dict[str, Any],
        *,
        organization_id: Optional[str] = None,
        exclude_channel: Optional[str] = None,
    ) -> None:
        """统一 WS 事件推送入口：生成 event_id → 构建 envelope → 发布。

        seq 由 Redis INCR 原子递增生成（per-thread），无需调用方传入。

        ``exclude_channel``：可选 Channels ``channel_name``，透传给 bus，
        投递时跳过该连接（relay 抑制发送方回环）。

        Wave 5（R3-02）：
          - 若调用方传入 ``organization_id``，envelope 直接附带；
          - 否则走 ``_resolve_thread_organization_cached(thread_id)`` LRU + DB 解析；
          - 解析失败 → envelope 不带 organization_id（前端仍可走
            ``resolveOrganizationIdFromChatStore`` fallback 反查 useChatStore）。

        ## TODO[W3-perf-opt]：50ms delta 合并窗口

        v3 §3.4 提到"服务端 50ms 时间窗口的 delta 合并：同一
        (message_id, index, delta.type) 的多个连续 delta 拼成一个 → 移动端
        bandwidth 减半"。

        当前未实现——理由：
        1. 桌面端 / 局域网用户感知不到 bandwidth 节省
        2. 实施需要跨事件状态（per-(thread, msg, idx, type) 缓冲），与
           publish_ws 单事件无状态语义冲突——需要新加 publisher 实例化路径
        3. 前端 `_seq` 排序 + 累积逻辑能正确处理高频 delta，不影响功能

        优化时机：移动端 bandwidth 测试发现明显瓶颈再做。详见
        `apps/services/common/ws/handlers/relay_handler.py` 的 `EXCLUDED_FROM_TRACE`
        集合——这条已经把高频 content_block_delta 排除出 trace_event 写库
        （写库压力已解决，bandwidth 优化是下一层）。
        """
        try:
            seq = _next_seq(thread_id)
            if seq > 0:
                payload = {**payload, "_seq": seq}

            if event_type in ChatStreamPublisher._E2E_VERBOSE_EVENTS:
                _brief = {k: v for k, v in payload.items() if k in (
                    "phase", "tool_name", "tool_call_id", "step_type", "title",
                    "status", "run_id", "notice_type", "_seq",
                )}
                logger.debug(
                    "[E2E][Publisher] → WS push: type=%s thread=%s seq=%s brief=%s",
                    event_type, thread_id[:16], seq, _brief,
                )

            resolved_wt = organization_id or _resolve_thread_organization_cached(thread_id)

            event_id = new_event_id()
            envelope = build_envelope(
                stream_event_type(event_type),
                event_id,
                payload,
                thread_id=thread_id,
                organization_id=resolved_wt,
            )
            topic = stream_topic(thread_id)
            if event_type in ChatStreamPublisher._CRITICAL_EVENTS:
                try:
                    publish_ws_event_reliable(
                        topic, envelope, exclude_channel=exclude_channel,
                    )
                except Exception:
                    logger.error(
                        "[Publisher] WS %s reliable publish failed for thread=%s, "
                        "falling back to non-reliable",
                        event_type, thread_id, exc_info=True,
                    )
                    publish_ws_event(
                        topic, envelope, exclude_channel=exclude_channel,
                    )
            else:
                publish_ws_event(
                    topic, envelope, exclude_channel=exclude_channel,
                )
            from apps.chat.conversation.services.session_collaboration_events import (
                publish_runtime_event,
            )

            publish_runtime_event(
                thread_id,
                envelope,
                reliable=event_type in ChatStreamPublisher._CRITICAL_EVENTS,
            )
        except Exception as exc:
            logger.warning("[Publisher] WS %s publish failed: %s", event_type, exc)

    @staticmethod
    def publish_ws_reliable(
        thread_id: str,
        event_type: str,
        payload: Dict[str, Any],
        *,
        organization_id: Optional[str] = None,
        exclude_channel: Optional[str] = None,
    ) -> None:
        """终结事件的可靠推送入口。失败时抛 WsPublishError 让上层感知。"""
        seq = _next_seq(thread_id)
        if seq > 0:
            payload = {**payload, "_seq": seq}

        resolved_wt = organization_id or _resolve_thread_organization_cached(thread_id)

        event_id = new_event_id()
        envelope = build_envelope(
            stream_event_type(event_type),
            event_id,
            payload,
            thread_id=thread_id,
            organization_id=resolved_wt,
        )
        publish_ws_event_reliable(
            stream_topic(thread_id),
            envelope,
            exclude_channel=exclude_channel,
        )
        from apps.chat.conversation.services.session_collaboration_events import (
            publish_runtime_event,
        )

        publish_runtime_event(thread_id, envelope, reliable=True)

    # ------------------------------------------------------------------
    # 具体事件方法
    # ------------------------------------------------------------------

    @staticmethod
    def publish_assistant_event(
        thread_id: str,
        phase: str,
        content: str,
        message_id: Optional[str] = None,
        run_id: Optional[str] = None,
    ) -> None:
        payload: Dict[str, Any] = {"phase": phase, "content": content, "message_id": message_id}
        if run_id:
            payload["run_id"] = run_id
        ChatStreamPublisher.publish_ws(thread_id, AgentStreamEvent.ASSISTANT, payload)

    # ── W4.5 第三波 C1（2026-05-13）物理删 publish_reasoning_event ──
    # 引用了已物理删的 AgentStreamEvent.REASONING 短名，且 0 caller（云端
    # langgraph 时代的遗留 helper）。新协议下推理路径走 ContentBlock 6 件套
    # `thinking` / `redacted_thinking` 块（reassembler 自动落库 content_blocks_json）。

    @staticmethod
    def publish_stream_chunk(thread_id: str, content: str, *, run_id: Optional[str] = None):
        """推送单条文本 delta 事件。

        .. deprecated::
            已迁移到 ``agent.stream.assistant`` phase="delta"。
            请直接使用 :meth:`publish_assistant_event` 代替。
        """
        ChatStreamPublisher.publish_assistant_event(
            thread_id, phase="delta", content=content, run_id=run_id,
        )

    @staticmethod
    def publish_stream_done(
        thread_id: str,
        content: str,
        *,
        message_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        run_id: Optional[str] = None,
        source_client_event_id: Optional[str] = None,
    ):
        """推送 done 事件。"""
        # S2-040: 空字符串归一化为 None，统一"无 message_id"语义
        if not message_id:
            message_id = None
        logger.info(
            "[E2E][Publisher] ━━━ DONE ━━━ thread=%s msg_id=%s run=%s content_len=%d "
            "error_category=%s",
            thread_id[:16], message_id, run_id, len(content or ""),
            (metadata or {}).get("error_category", "none"),
        )
        payload: Dict[str, Any] = {"content": content, "message_id": message_id}
        if metadata:
            payload["metadata"] = metadata
        if run_id:
            payload["run_id"] = run_id
        if source_client_event_id:
            payload["source_client_event_id"] = source_client_event_id
        ChatStreamPublisher.publish_ws_reliable(thread_id, AgentStreamEvent.DONE, payload)

    @staticmethod
    def publish_stream_reply(thread_id: str, content: str, message_id: str | None = None):
        """推送流式回复事件（chunk + done + final assistant），用于同步路径。"""
        ChatStreamPublisher.publish_stream_chunk(thread_id, content)
        ChatStreamPublisher.publish_stream_done(thread_id, content, message_id=message_id)

        run_id = ChatStreamPublisher._lookup_latest_run_id(thread_id)
        ChatStreamPublisher.publish_assistant_event(
            thread_id=thread_id,
            phase="final",
            content=content,
            message_id=message_id,
            run_id=run_id,
        )

    @staticmethod
    def publish_system_notice(
        thread_id: str,
        content: str,
        *,
        run_id: Optional[str] = None,
        notice_type: Optional[str] = None,
    ) -> None:
        """推送系统提示事件（与 AI 回答分离显示）。"""
        payload: Dict[str, Any] = {"content": content}
        if run_id:
            payload["run_id"] = run_id
        if notice_type:
            payload["notice_type"] = notice_type
        ChatStreamPublisher.publish_ws(thread_id, AgentStreamEvent.SYSTEM_NOTICE, payload)

    # ── W4.5 第三波 C1（2026-05-13）物理删 publish_tool_timeout_event /
    #    publish_tool_heartbeat_event ──
    # 引用已物理删的 AgentStreamEvent.TOOL_TIMEOUT / TOOL_HEARTBEAT 短名，
    # 且 0 caller。新协议下"工具超时 / 心跳"提示走 SYSTEM_NOTICE 通用通道
    # （notice_type='tool_timeout' / 'tool_heartbeat'），与 6 类 tool_lifecycle
    # notice 同流。

    @staticmethod
    def publish_llm_heartbeat_event(
        thread_id: str,
        elapsed_seconds: float,
        *,
        run_id: Optional[str] = None,
        seconds_since_last_chunk: Optional[float] = None,
    ) -> None:
        """推送 LLM 调用心跳事件（前端据此判断 Agent 是否存活）。

        Args:
            seconds_since_last_chunk: 距上次流式 chunk 到达的秒数。
                None 表示非流式或尚无 chunk。前端可据此区分
                "模型在思考" 和 "流式输出可能卡住"。
        """
        payload: Dict[str, Any] = {
            "elapsed_seconds": round(elapsed_seconds, 1),
        }
        if run_id:
            payload["run_id"] = run_id
        if seconds_since_last_chunk is not None:
            payload["seconds_since_last_chunk"] = round(seconds_since_last_chunk, 1)
        ChatStreamPublisher.publish_ws(thread_id, AgentStreamEvent.LLM_HEARTBEAT, payload)

    # ── W4.5 第三波 C1（2026-05-13）物理删 publish_content_reset ──
    # 引用已物理删的 AgentStreamEvent.CONTENT_RESET 短名，且 0 caller。
    # 新协议下"截断重试清空 partial 内容"由 message_stop(stop_reason='aborted')
    # + 新一轮 message_start 自然表达。

    # Wave 6 清理（路径权限治理 + ask_question 收敛）：
    # 历史 ``publish_ask_user_required`` 是云端 langgraph runtime 的 ask_user 中断
    # 推送入口，唯一调用方在已废止的 ``result_finalizer._finalize_ask_user``。
    # 本地 runtime（Daemon → relay）直接 emit ``ask_choice_required`` /
    # ``ask_form_required`` / ``request_approval_required`` 三件套，不再经过
    # 中央 dispatch；method 因此一并退役（D3 不留兼容）。

    # ── W4.5 第三波 C1（2026-05-13）物理删 publish_tool_event ──
    # 引用已物理删的 AgentStreamEvent.TOOL 短名，且 0 caller。新协议下工具
    # 执行 lifecycle 走 ContentBlock 6 件套（content_block_start/delta/stop
    # with block.type='tool_use'）+ SYSTEM_NOTICE notice_type='tool_*'（参考
    # tool-orchestration.ts::makeToolLifecycleNotice）。
    #
    # publish_step_event 仍保留：daemon `query.ts` 仍 emit thinking step，本
    # helper 留作 Django 端构造测试事件用（无生产 caller，但 W5/W6 step 链路
    # 清理前保留）。

    @staticmethod
    def publish_step_event(
        thread_id: str,
        step_type: str,
        title: str,
        *,
        run_id: Optional[str] = None,
        status: str = "running",
        detail: Optional[str] = None,
        step_id: Optional[str] = None,
    ) -> None:
        payload: Dict[str, Any] = {
            "step_type": step_type,
            "title": title,
            "status": status,
        }
        if step_id:
            payload["step_id"] = step_id
        if run_id:
            payload["run_id"] = run_id
        if detail:
            payload["detail"] = detail
        ChatStreamPublisher.publish_ws(thread_id, AgentStreamEvent.STEP, payload)

    @staticmethod
    def publish_todo_event(
        thread_id: str,
        todos: list,
        *,
        run_id: Optional[str] = None,
    ) -> None:
        """推送 todo 列表更新事件。"""
        payload: Dict[str, Any] = {"todos": todos}
        if run_id:
            payload["run_id"] = run_id
        ChatStreamPublisher.publish_ws(thread_id, AgentStreamEvent.TODO, payload)
        logger.info(
            "[Publisher] WS todo published: thread=%s run_id=%s count=%d",
            thread_id,
            run_id,
            len(todos) if isinstance(todos, list) else 0,
        )

    _TERMINAL_LIFECYCLE_PHASES = frozenset(("end", "error", "terminated"))

    @staticmethod
    def publish_lifecycle_event(
        thread_id: str,
        phase: str,
        *,
        run_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> None:
        if phase == "start":
            _reset_seq(thread_id)

        payload: Dict[str, Any] = {"phase": phase}
        if run_id:
            payload["run_id"] = run_id
        if task_id:
            payload["task_id"] = task_id
        if phase in ChatStreamPublisher._TERMINAL_LIFECYCLE_PHASES:
            ChatStreamPublisher.publish_ws_reliable(thread_id, AgentStreamEvent.LIFECYCLE, payload)
            _reset_seq(thread_id)
        else:
            ChatStreamPublisher.publish_ws(thread_id, AgentStreamEvent.LIFECYCLE, payload)

    @staticmethod
    def publish_title_update(
        user_id: str,
        *,
        session_id: str,
        title: str,
        thread_id: Optional[str] = None,
    ) -> None:
        """用户级广播：会话标题更新（``agent.user.title_updated``）。

        语义上**不是** stream 事件——标题归属于会话，但事件的逻辑接收者是
        用户本人：用户切走会话或刷新页面后仍应收到，离线设备上线后应能
        补送。所以走 ``publish_to_user(user_id, envelope, buffer_offline=True)``
        投递到 channel layer group ``user.{user_id}``（前端 auth.ok 时已自动
        join，无需 syncSubscriptions）；``buffer_offline=True`` 把 envelope
        写进 Redis 用户级 inbox（``USER_INBOX_MAX_LEN=100`` /
        ``USER_INBOX_TTL=86400``，详见 ``ws/bus.py``），断网/离线 24h 内
        重连可补送；超 24h 的极端场景由 ``offline_recovery_hint`` 兜底。

        Args:
            user_id: 标题归属的 ``ChatSession.user_id``，必须非空——否则
                payload 写不进 ``user.{user_id}`` group，事件会被丢弃。
            session_id: 会话 ID，前端按此做 store 更新主键。
            title: LLM 生成的新标题。
            thread_id: 可选，仅作为 payload 字段透传给前端做缓存 invalidation；
                标题事件不再 bind 到 ``agent.stream.{thread_id}`` topic。

        失败处理：``publish_to_user`` 内部捕获所有异常并返回 False；本函数
        不向上抛错，标题写库已是事实源，前端最终会通过 inbox 补送或下次
        加载会话拉到正确标题。
        """
        if not user_id:
            logger.warning(
                "[Publisher] publish_title_update skipped: empty user_id "
                "(session=%s title=%r)",
                session_id, title,
            )
            return

        payload: Dict[str, Any] = {
            "session_id": session_id,
            "title": title,
        }
        if thread_id:
            payload["thread_id"] = thread_id

        envelope = build_envelope(
            user_event_type(AgentUserEvent.TITLE_UPDATED),
            new_event_id(),
            payload,
        )
        publish_to_user(user_id, envelope)

    @staticmethod
    def publish_team_session_created(
        member_user_ids: List[str],
        *,
        space_id: str,
        session_payload: Dict[str, Any],
    ) -> None:
        """已退役：不再向其他成员广播私有执行 session。

        历史  曾把完整 session schema（含 id）推给同 Project 其他成员，
        与「原始 Agent 执行对话仅责任人可见」边界冲突。Project / TabChat 升级
        路径不得再调用本方法；保留空实现以免旧 import 崩，并打诊断日志。

        共享面（Task / 评论 / 责任人主动呈递结果）走各自事件通道，不经本方法。
        恢复事实源仍是按当前用户过滤的 ``sessions.list``。
        """
        session_id = ""
        if isinstance(session_payload, dict):
            session_id = str(session_payload.get("id") or "")[:8]
        logger.info(
            "[Publisher] publish_team_session_created skipped (privacy): "
            "space=%s session=%s member_count=%d",
            (space_id or "")[:8] or "-",
            session_id or "-",
            len(member_user_ids or []),
        )
        return

    # Wave 2 续作 (charter v1.8 §6.4 §3.4)：删除 maybe_publish_agenda_goal_sub_progress
    # —— 它发送的 TrackerEvent.STEP_SUB_PROGRESS 在单 Skill 执行模型下已没有订阅方
    # （前端死事件订阅同步删除；tracker 端 tracker_notification.py 也删除了对应 notify_*
    # 方法）。step_run_id 字段在 StepRun 模型 drop 后永远为空，整个方法是死路径。

    # ------------------------------------------------------------------
    # 内部辅助
    # ------------------------------------------------------------------

    @staticmethod
    def _lookup_latest_run_id(thread_id: str) -> Optional[str]:
        """DB 兜底：查询 thread 上最新的 ExecutionRun.run_id。"""
        try:
            from apps.services.agent_engine.services.run_service import RunService
            run = RunService.get_latest_run(thread_id)
            return str(run.run_id) if run else None
        except Exception:
            logger.debug("[Publisher] _lookup_latest_run_id failed for %s", thread_id)
            return None


class DeltaThrottle:
    """Batches rapid assistant deltas to reduce WS frame count.

    Flushes when accumulated content exceeds ``char_limit`` characters
    or ``interval`` seconds have elapsed since the last flush.

    **W4.5 第三波 C1（2026-05-13）**：reasoning 通路已物理删——`publish_reasoning_event`
    随 `AgentStreamEvent.REASONING` 短名一并下线（新协议下推理走 ContentBlock
    6 件套 `thinking` 块）。本类保留 assistant 通路供云端 langgraph 时代仅存的
    `publish_assistant_event` caller（result_finalizer）使用。
    """

    def __init__(self, *,
                 interval: float | None = None,
                 char_limit: int | None = None):
        self._interval = interval if interval is not None else getattr(
            django_settings, 'DELTA_THROTTLE_INTERVAL', 0.10
        )
        self._char_limit = char_limit if char_limit is not None else getattr(
            django_settings, 'DELTA_THROTTLE_CHAR_LIMIT', 50
        )
        self._assistant_buf = ""
        self._last_flush: float = time.monotonic()
        self._thread_id: Optional[str] = None
        self._run_id: Optional[str] = None

    def configure(self, thread_id: str, run_id: Optional[str] = None):
        self._thread_id = thread_id
        self._run_id = run_id

    def set_run_id(self, run_id: Optional[str]):
        self._run_id = run_id

    def push_assistant(self, content: str):
        self._assistant_buf += content
        if len(self._assistant_buf) >= self._char_limit:
            self._flush_assistant()

    def maybe_flush(self):
        """Flush if interval has elapsed."""
        if time.monotonic() - self._last_flush >= self._interval:
            self.flush()

    def flush(self):
        self._flush_assistant()
        self._last_flush = time.monotonic()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.flush()
        return False

    def _flush_assistant(self):
        buf = self._assistant_buf
        if not buf or not self._thread_id:
            return
        self._assistant_buf = ""
        ChatStreamPublisher.publish_assistant_event(
            self._thread_id, "delta", buf, run_id=self._run_id,
        )

