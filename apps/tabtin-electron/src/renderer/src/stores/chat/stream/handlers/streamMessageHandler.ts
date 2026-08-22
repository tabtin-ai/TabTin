/**
 * Stream message handler — processes all agent.stream.* events.
 *
 * **Wave 4a 重写**：从老协议（assistant/reasoning/tool/step/tool_call_args_delta/
 * content_reset 等）切换到 Anthropic Messages API 对齐的 6 件套（message_start/
 * delta/stop + content_block_start/delta/stop）。
 *
 * 删除（W4a A+B 节物理删除，禁止保留双协议兼容）：
 *   - ASSISTANT / REASONING / CONTENT_RESET 分发（功能由 content_block_* 替代）
 *   - TOOL / STEP / TOOL_TIMEOUT 分发（功能由 content_block_* + SYSTEM_NOTICE 替代）
 *   - TOOL_CALL_ARGS_DELTA 分发（功能由 content_block_delta(input_json_delta) 替代）
 *
 * 保留：
 *   - LIFECYCLE / SUBAGENT_* / SYSTEM_NOTICE / CHECKPOINT_* / PLAN_PROPOSAL /
 *     CAPABILITY_EVENT / TODO / SSH_OUTPUT / COMPACTION / DONE
 *   - USER（skill_invoke 注入路径）
 *
 * W4.5 第二波 B2 已物理删 listener + wire 常量：
 *   - RICH_CONTENT 在 packages/agent-wire/src/events.ts 已删常量定义；
 *     daemon 真实 emit 路径是 ContentBlock `tabtin_rich_content` 块（通过
 *     content_block_start/delta/stop 三件套），由本文件下方 `contentBlockHandler`
 *     接管。`appendRichContentBlocks` / `upsertRichContentBlocksByToolCallId`
 *     这两个 store action 仍保留——它们由 `contentBlockHandler` 的镜像逻辑
 *     （把 ContentBlock `tabtin_rich_content` 块映射到 richContentBlocksBySessionId）
 *     调用，承担 widget placeholder/final 字段合并职责。
 *
 * **W4.5 第三波 C1（2026-05-13）**：wire 层 9 个老协议常量物理删后，本文件中
 * 残留的 TOOL_TIMEOUT 兜底桥也一并清掉——daemon 0 emit + Django 0 caller +
 * RELAY 白名单已移除该短名，链路从源头封死，不再需要 Renderer 兜底。
 *
 * **#6832**：PLAN / MODE / tool_stream_id / audit_cap 辅助吞掉路径已删
 * （PLAN/MODE 全仓 0 emit；audit_cap 仍由 runtime emit 供 TraceEvent，
 *  客户端广播在 Django RELAY + 本地 AgentRealtime 边界拦截）。
 *
 * 新加：
 *   - 6 件套 → contentBlockHandler（W4a F 节）
 *   - 在 content_block_start(tool_use) 时把 widget placeholder 创建迁过来（W2.5 等价）
 *   - 在 content_block_delta(input_json_delta) 时同步喂 widget buffer（feedInputJsonDelta）
 *
 * Event 子分发器：
 *   lifecycleHandler        — LIFECYCLE
 *   contentBlockHandler     — 6 件套（W4a 新增）
 *   subagentHandler         — SUBAGENT_*
 *   systemHandler           — SYSTEM_NOTICE / CONTEXT_PRESSURE / MONITOR_STATUS / LLM_HEARTBEAT
 *   checkpointHandler       — CHECKPOINT_FAILED / CHECKPOINT_SUCCESS
 *   miscHandler             — TODO / SSH_OUTPUT / COMPACTION / DONE
 */

import type { ChatClient, ChatMessage, ChatSession } from '@tabtin/chat-client'
import { AgentStreamEvents } from '@tabtin/ws-gateway-client'
import { isSystemAuthoredMessage } from '../../domain/messageRolePolicy'
import { isContentBlockEvent, ContentBlockEvents, StreamEvents } from '@tabtin/agent-wire'
import { createLogger } from '@/utils/logger'
import { handleLifecycleEvent } from './lifecycleHandler'
import { handleSubagentEvent } from '../../subagent/handlers/subagentHandler'
import { handleSubagentStreamEvent } from '../../subagent/handlers/subagentStreamHandler'
import { handleSystemEvent } from './systemHandler'
import { handleCheckpointEvent } from '../../checkpoint/handlers/checkpointHandler'
import { handleMiscEvent } from './miscHandler'
import { handleModeSwitchProposalEvent } from './modeSwitchProposalHandler'
import { handleCapabilityEvent } from './capabilityEventHandler'
import { handleContentBlockEvent } from './contentBlockHandler'
import { isWithinAbortGrace, isWithdrawalPending } from './abortGrace'
import { clearSupersededRuns, isRunSuperseded } from './supersededRuns'
import { applyBlocksArrival } from '@/stores/chat/domain/messageTimelineOrder'
import { getClientMessageId } from '@/stores/chat/domain/messageIdentity'
import { getChatStoreCallbacks } from '../../shared/storeAccessRegistry'
import { handleHitlStreamEvent } from '../../hitl/handlers/hitlStreamHandlers'
import { markStreamEventSeen } from './streamEventDedup'
import { reconcilePersistedMessageIds } from './syntheticUserIdReconcile'
import {
  consumeSelfRollbackBroadcast,
  isSessionRestoring,
  readSessionMessages,
} from '@/services/agentService/messageWriteGate'
import { applyRuntimeRunSync } from '../../execution/sessionRunProjection'
import { AgentRunSyncPayloadSchema } from '@tabtin/agent-wire'
import { useChatStore } from '../../useChatStore'
import { requestTitleGenerationOnSend } from '../../messages/actions/titleGenerationDedupe'
import { resolveSessionForSend } from '../../messages/actions/sendDispatchInputs'
import { getChatClient } from '@/services/chatApi'
import { trackSendTimingTelemetry } from '../../execution/sendTimingTrace'
import type {
  AgentStreamMessage,
  HandlerContext,
  StreamHandlerDeps,
  StreamHandlerStore,
} from './streamHandlerTypes'

export type { AgentStreamMessage, HandlerContext, StreamHandlerDeps, StreamHandlerStore } from './streamHandlerTypes'

const log = createLogger('E2E:Stream')

/**
 * MESSAGE_COMMITTED（relay 落库确认）的对账（ 收窄 / ）。
 *
 * - store 中已有该 `message_id`：live 内容已在场，只补 server id 身份映射；
 * - store 中没有该消息：走唯一 upsert 对账入口补齐。
 */
function reconcileAfterMessageCommitted(sessionId: string, payload: Record<string, unknown> | undefined): void {
  const messageId = typeof payload?.message_id === 'string' ? payload.message_id : ''
  const serverId = typeof payload?.server_id === 'string' ? payload.server_id : ''
  const hasLocalMessage = !!messageId && readSessionMessages(sessionId).some(message => message.id === messageId)
  if (hasLocalMessage) {
    if (serverId && messageId !== serverId) {
      getChatStoreCallbacks()?.linkServerMessageId(sessionId, messageId, serverId)
    }
    return
  }
  void (async () => {
    const { reconcileSessionMessages } = await import('@/services/sessionFreshness')
    await reconcileSessionMessages(sessionId, {
      force: true,
      retry: false,
      silentOnError: true,
      reason: 'message-committed',
    })
  })().catch(() => {})
}

/**
 *  / ：观察端回退广播后的对齐——只走唯一 upsert 对账。
 * upsert 不删本地独有行；观察端「回退后幽灵气泡」见 follow-up（结构性截断未接此路径）。
 *
 * ：**发起端跳过**——本机刚截断过，再对账易与软过滤竞态。
 */
function reconcileAfterRollback(sessionId: string): void {
  if (consumeSelfRollbackBroadcast(sessionId) || isSessionRestoring(sessionId)) {
    log.info('[rollback] self-initiated broadcast, skip reconcile', {
      session: sessionId.slice(0, 8),
    })
    return
  }
  void (async () => {
    const { reconcileSessionMessages } = await import('@/services/sessionFreshness')
    await reconcileSessionMessages(sessionId, {
      force: true,
      retry: false,
      silentOnError: true,
      reason: 'rollback-broadcast',
    })
  })().catch(() => {})
}

export function createStreamMessageHandler(deps: StreamHandlerDeps) {
  const { sessionId } = deps

  const ctx: HandlerContext = {
    ...deps,
    notifyPrefix: deps.spaceName ? `${deps.spaceName} · ` : '',
  }

  return (message: AgentStreamMessage) => {
    const eventType = message?.type
    if (!eventType) return

    // ──  / ：跨源（IPC + WS）统一去重（最高优先级，所有路由之前）────────
    //
    // 本窗口发起的 turn 同时走 IPC（sendMessageAction）与 relay→WS（observer mirror）
    // 两路；跨端（mobile 发起、本端旁观）只走 WS。两路喂入同一份 handler，靠事件源
    // （agent-runtime `stamp-event.ts`）统一分配的**身份键** `event_id` 做「先到先处理、
    // 后到丢弃」。
    //
    // 为什么用 event_id 而非 arrival_seq：arrival_seq 兼任排序 + 去重，被包装
    // （SUBAGENT_STREAM_EVENT 把原事件塞进 child_event）时顶层缺失、经 sink 出口
    // `ensureArrivalSeq` 补了**新**序号 → 同一逻辑事件的 IPC 包装副本与 WS 原始副本
    // key 不一致 → 子代理 transcript 去重失效、主总结后被重放。event_id 是纯身份，
    // 一次发射分配一次；包装事件由 forwardSubagentStreamToParent 把内层 event_id 提升到
    // wrapper 顶层、sink 幂等不重造，故两路同一事件 event_id 一致。
    //
    // key 提取只读顶层 `event_id`，不下钻事件类型：包装/原始/嵌套的顶层 event_id 天然
    // 相等（继承自最内层发射），无需 per-type 特判。daemon retry 走新 event_id → 不会
    // 误杀；Django relay 整包透传 payload → 两路同一事件 event_id 一致。
    //
    // **无 event_id / arrival_seq 的事件一律放行**：host 合成（message_persisted / host
    // catch errorEvent）、Django 自发（message_committed）等没有 runtime 身份键，各有
    // 独立幂等/兜底路径，去重它们会误伤。event_id 缺失时回落 arrival_seq（老 daemon /
    // 老数据）。
    const eventId = typeof message.payload?.event_id === 'string' && message.payload.event_id
      ? message.payload.event_id
      : undefined
    const arrivalSeq = typeof message.payload?.arrival_seq === 'number'
      ? message.payload.arrival_seq
      : undefined
    const dedupKey = eventId ?? arrivalSeq
    if (dedupKey !== undefined && !markStreamEventSeen(sessionId, dedupKey)) return

    // ──  A1：persist_message 是后端**持久化专用**事件，渲染端一律忽略 ──
    // live 视图由 6 件套（IPC）驱动；刷新后从 DB 读取（DB 由 persist_message 落库）。
    // 必须排在子代理隔离 guard 之前——否则带 subagent_run_id 的 persist_message
    // 会被误当子代理 transcript 路由进 live store。
    if (eventType === 'agent.stream.persist_message') return

    // ── 子 Agent 事件统一隔离（消除「对话结束后又跳到对话中」）──────────────
    //
    // daemon `forwardChildEventToTrace` 给**每个**子 Agent 事件（lifecycle /
    // content_block / message / user…）注入 `subagent_run_id`，经 relay → Django →
    // 在父 thread topic 重发 → WS observer 收到这些**带 subagent_run_id 的 raw 事件**。
    // 若不拦截，父 handler 会把它们当父事件处理——典型恶果：子 Agent 的
    // `lifecycle phase=start` 触发父 `addStreamingSession` → 父轮明明结束了又被翻回
    // 「对话中」（CDP 实证：父 done 后 5 个子 run 的 lifecycle start 涌入父 session）。
    //
    // 契约：**任何带 `subagent_run_id` 的事件都属于子 Agent**，只进子 live store
    // （供详情 Pane），绝不进父时间线 / 父 run 态。`subagent_*` 聚合元事件
    // （SUBAGENT_STARTED/PROGRESS/… 与 SUBAGENT_STREAM_EVENT 本身）除外——它们由
    // subagentHandler / subagentStreamHandler 专门处理，下方各自路由。
    const subagentRunId = typeof message.payload?.subagent_run_id === 'string'
      ? message.payload.subagent_run_id
      : ''
    if (subagentRunId && !eventType.startsWith('agent.stream.subagent')) {
      handleSubagentStreamEvent({
        type: AgentStreamEvents.SUBAGENT_STREAM_EVENT,
        payload: {
          subagent_run_id: subagentRunId,
          child_event: { type: eventType, payload: message.payload ?? {} },
        },
      }, ctx)
      return
    }

    // ── Wave 4a · ContentBlock 6 件套（最高优先级，最高频）─────────
    // 高频事件——content_block_delta 在 1000 token/s 流式时每秒上千条。
    // 必须在所有 logging / 路由判断之前**最早**处理，避免 console 被打爆。
    // contentBlockHandler 内部用 zod safeParse 校验 + store CRUD（已 immutable
    // shallow clone）+ widget buffer feed（in-memory Map，0 Zustand 重渲染）。
    if (isContentBlockEvent(eventType)) {
      // 作废旧流拦截：用户中断（停止 / 插队 / 停止并重新生成）后，被中断那条 run
      // 的 generator 还在异步 unwind，尾部 message_start / content_block_* 会经本
      // 共享入口写 store——新建气泡、灌内容，且拿到中断后的 arrival_seq 排到时间线
      // 最底部，落在更新的用户消息之后（消息错乱根因）。中断时其 run 标识已登记为
      // superseded，这里两路（IPC + WS）一致丢弃其尾部；新流是不同 run，照常通过。
      //
      // **key 必须用 trace_id 而非 run_id**：envelope-emitter 只在 message_start 贴
      // `run_id`，其余 content-block 事件（content_block_start/delta/stop、message_delta
      // /stop）的 envelopeBase 只带 `trace_id`。而 query.ts `this.traceId = this.runId`
      // ——trace_id 恒等于 run_id 且是每个事件都带的 per-run 常量。只认 run_id 会漏掉
      // 除 message_start 外的全部内容事件（旧流内容照样渲染，即本次现象）。
      const runKey = typeof message.payload?.run_id === 'string' && message.payload.run_id
        ? message.payload.run_id
        : (typeof message.payload?.trace_id === 'string' ? message.payload.trace_id : '')

      // ：全量回退管线进行中（restoringSessionId）丢弃全部 content-block，
      // 与 commitServerMerge 的 restoring 门控对称——避免 abort grace（~5s）过后、
      // 文件 rewind 未完成时 late message_start 经 ensureAssistantMessage 插回空壳。
      if (isSessionRestoring(sessionId)) return

      // ：撤回 runtime transcript 期间，旧流可能在任意时长内抵达；
      // 不能依赖 5 秒 abort grace，否则慢 IPC 会重新建 assistant 壳。
      if (isWithdrawalPending(sessionId)) return

      // 用户刚点停止：宽限期内丢弃全部 content-block（含尚无 assistant / 未登记
      // run_id 的 pre-stream message_start），避免撤回后仍打字。
      const userCancelling = ctx.get().cancellingBySessionId[sessionId] === true
      const inAbortGrace = isWithinAbortGrace(sessionId)
      if (inAbortGrace) return

      const sessionBusy = getChatStoreCallbacks()?.isSessionBusy?.(sessionId) === true
      // 宽限期外仍 cancelling 且 content 仍到 → 底层 abort 很可能未生效（ miss）。
      // 清 cancelling + superseded 并恢复渲染，避免正文永久黑洞；成功停止应在
      // grace 内由 lifecycle 收口，通常走不到这里。
      if (userCancelling) {
        // ：不再用 addStreamingSession 自愈 busy；cancelling 清理仍保留。
        // busy 只认 host run_sync。若 abort 未生效，后续 run_sync(running) 会纠偏按钮。
        log.warn('[E2E] streaming self-heal: abort miss after grace — clear cancelling (busy via run_sync)', {
          session: sessionId.slice(0, 8),
          sessionBusy,
        })
        ctx.get().setCancellingForSession(sessionId, false)
        clearSupersededRuns(sessionId)
      } else if (runKey && isRunSuperseded(sessionId, runKey)) {
        return
      } else if (eventType === ContentBlockEvents.MESSAGE_START && !sessionBusy) {
        // ：禁止 message_start 写 busy（曾与 terminal 误清形成双状态机竞态）。
        log.debug('[E2E] message_start on non-busy session (busy owned by run_sync)', {
          session: sessionId.slice(0, 8),
        })
      }
      handleContentBlockEvent(message, ctx)
      return
    }

    // ：生产包勿用 warn 刷屏——warn 始终走 console，会占满诊断环形缓冲并加重主线程。
    // DEV 才打；生产仅进 logCollector（debug → recordLog），默认不打 console。
    // ：子 Agent 包一层后的 delta / 进度是 token 级洪峰，每条 debug 都会
    // console → 主进程 IPC，DEV 必现卡死。与主 Agent content-block 一样跳过。
    if (
      eventType !== AgentStreamEvents.SUBAGENT_STREAM_EVENT
      && eventType !== AgentStreamEvents.SUBAGENT_PROGRESS
    ) {
      log.debug(`[E2E] ← ${eventType}`, {
        session: sessionId.slice(0, 8),
        phase: (message.payload as Record<string, unknown>)?.phase,
        tool: (message.payload as Record<string, unknown>)?.tool_name,
      })
    }

    if (eventType === StreamEvents.MESSAGE_COMMITTED) {
      const committedPayload = message.payload as Record<string, unknown> | undefined
      reconcileAfterMessageCommitted(sessionId, committedPayload)
      return
    }
    if (eventType === 'agent.stream.message_persisted') {
      reconcilePersistedMessageIds(sessionId, message)
      return
    }

    // ── ：本机执行态独立 sync（busy = status !== idle）────────────
    if (eventType === StreamEvents.RUN_SYNC) {
      const accepted = applyRuntimeRunSync(sessionId, message.payload)
      if (accepted) {
        const parsed = AgentRunSyncPayloadSchema.safeParse(message.payload)
        if (parsed.success) {
          const { run_id: activeRunId, queued_run_ids: queuedRunIds } = parsed.data
          const chatStore = useChatStore.getState()
          // run_sync 只更新 Host 执行态。Outgoing payload 的删除权属于 USER echo
          // 或明确 cancel/drop，避免 ACK queued 后被旧 queued_run_ids 误删。
          chatStore.reconcileHostPendingWithRunSync(sessionId, queuedRunIds, activeRunId)
        }
      }
      return
    }

    // ── ：本机已停发 MESSAGE_QUEUED/DEQUEUED；旧包若仍到达则忽略。
    if (eventType === StreamEvents.MESSAGE_QUEUED || eventType === StreamEvents.MESSAGE_DEQUEUED) {
      return
    }

    if (eventType === StreamEvents.LLM_USAGE) {
      return
    }

    // ──  对话回退 / 撤销全端收敛 ───────────────────────────────
    // Django apply 成功后广播；观察端（其他设备 / 窗口）走「从服务端全量重拉」
    // 收敛；发起端本机已按 runtime 权威截断，跳过（，见 reconcileAfterRollback）。
    if (eventType === StreamEvents.ROLLBACK || eventType === StreamEvents.UNREVERT) {
      const rollbackState = (message.payload as { rollback_state?: unknown })?.rollback_state
      if (rollbackState && typeof rollbackState === 'object') {
        ctx.updateSessionInCaches(sessionId, { rollback_state: rollbackState } as Partial<ChatSession>)
      }
      reconcileAfterRollback(sessionId)
      return
    }

    // ── lifecycle ──────────────────────────────────────────────
    if (eventType === AgentStreamEvents.LIFECYCLE) {
      log.debug('← LIFECYCLE', { session: sessionId.slice(0, 8), phase: message.payload?.phase, run: message.payload?.run_id })
      handleLifecycleEvent(message, ctx)
      return
    }

    // ── user (local runtime echo / cross-device observer / injected messages) ───
    if (eventType === AgentStreamEvents.USER) {
      const payload = message.payload || {}
      const content = typeof payload.content === 'string'
        ? payload.content
        : (typeof payload.text === 'string' ? payload.text : '')
      const contentBlocks = Array.isArray(payload.content_blocks_json)
        ? payload.content_blocks_json
        : (Array.isArray(payload.blocks_json) ? payload.blocks_json : undefined)
      const attachments = Array.isArray(payload.attachments_json)
        ? payload.attachments_json
        : undefined
      if (!content && !contentBlocks?.length && !attachments?.length) return

      const isSkillInvoke = payload.source === 'skill_invoke'
      const isPushNotification = payload.triggered_by === 'push-notification'
      // Runtime 内部 context / system-prompt 注入：透传 message_kind 到 store，
      // 让 MessageBubble 在 live 流式期间直接隐藏，避免闪现成用户气泡。
      const internalContextKind =
        payload.message_kind === 'environment_context'
        || payload.message_kind === 'agent_profile_context'
        || payload.message_kind === 'system_prompt_context'
          ? payload.message_kind
          : undefined
      const clientEventId = typeof payload.client_event_id === 'string' && payload.client_event_id
        ? payload.client_event_id
        : undefined
      const messageId = typeof payload.message_id === 'string' && payload.message_id
        ? payload.message_id
        : undefined
      const msgId =
        messageId
        ?? clientEventId
        ?? `${isPushNotification ? 'push-user' : isSkillInvoke ? 'skill-user' : 'observed-user'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const userMsg: ChatMessage = {
        id: msgId,
        role: isSystemAuthoredMessage({
          message_kind: typeof payload.message_kind === 'string'
            ? payload.message_kind as ChatMessage['message_kind']
            : undefined,
          metadata: payload.metadata && typeof payload.metadata === 'object'
            ? payload.metadata as Record<string, unknown>
            : undefined,
          source: payload.source,
          triggered_by: payload.triggered_by,
        }) ? 'system' : 'user',
        client_event_id: clientEventId,
        ...(internalContextKind ? { message_kind: internalContextKind } : {}),
        content,
        created_at: typeof payload.created_at === 'string' && payload.created_at
          ? payload.created_at
          : new Date().toISOString(),
        content_blocks_json: applyBlocksArrival(
          contentBlocks
            ? contentBlocks as ChatMessage['content_blocks_json']
            : [{ type: 'text', text: content }],
          // daemon emit 时分配的权威 arrival_seq(,USER payload 顶层);
          // 缺失时 applyBlocksArrival 回落本地单调微秒。
          typeof payload.arrival_seq === 'number' ? payload.arrival_seq : undefined,
        ),
        ...(attachments ? { attachments_json: attachments as ChatMessage['attachments_json'] } : {}),
        metadata: {
          ...(isSkillInvoke ? { source: 'skill_invoke' } : {}),
          ...(typeof payload.triggered_by === 'string' && payload.triggered_by
            ? { triggered_by: payload.triggered_by }
            : {}),
          ...(typeof payload.tool_call_id === 'string' ? { tool_call_id: payload.tool_call_id } : {}),
          ...(clientEventId ? { client_event_id: clientEventId, client_message_id: clientEventId } : {}),
          ...(messageId && messageId !== msgId ? { message_id: messageId } : {}),
        },
      }
      // 必须同步写入：后台 push / 跨端观察的事件序列是 user → assistant。
      // 如果异步写 store，assistant message_start 可能先 append，UI 顺序会倒。
      const chatCallbacks = getChatStoreCallbacks()
      if (!chatCallbacks) {
        log.warn('Cannot inject observed user message: chat store callbacks not registered')
        return
      }
      // ：started 路径气泡已在 ACK 上屏；此处 upsert 只补 arrival_seq。
      // queued 抽屉项在 run 真正开始时由 USER 摘除并首次进时间线。
      const chatStore = useChatStore.getState()
      const pendingMatch = clientEventId
        ? chatStore.removeHostPendingByClientEventId(sessionId, clientEventId)
        : null
      const pendingSendStatus = (
        pendingMatch?.userMessage as ChatMessage & { sendStatus?: string } | undefined
      )?.sendStatus
      const upsertMsg: ChatMessage = pendingMatch
        ? {
            ...userMsg,
            id: pendingMatch.userMessage.id,
            content: pendingMatch.userMessage.content || userMsg.content,
            metadata: {
              ...(pendingMatch.userMessage.metadata as Record<string, unknown> | null | undefined),
              ...(userMsg.metadata as Record<string, unknown> | null | undefined),
            },
            ...(pendingSendStatus ? { sendStatus: pendingSendStatus } : { sendStatus: 'sending' }),
          } as ChatMessage
        : userMsg
      const existingMessages = chatStore.messagesBySessionId[sessionId] ?? []
      const alreadyOnTimeline = existingMessages.some((m) => (
        m.id === upsertMsg.id
        || (clientEventId != null && (
          m.id === clientEventId
          || getClientMessageId(m) === clientEventId
        ))
      ))
      chatCallbacks.upsertObservedUserMessage(sessionId, upsertMsg)
      if (!internalContextKind && !alreadyOnTimeline) {
        trackSendTimingTelemetry('message.send.user_visible', {
          sessionId,
          userMessageId: upsertMsg.id,
          fromHostPending: Boolean(pendingMatch),
        }, null, {
          counterKey: 'message.send.user_visible',
          sessionId,
        })
      }
      if (pendingMatch?.titleText.trim()) {
        requestTitleGenerationOnSend({
          sessionId,
          userMessage: pendingMatch.titleText.trim(),
          getMessages: () => useChatStore.getState().messagesBySessionId[sessionId] ?? [],
          getChatClient,
          getSession: () => resolveSessionForSend(useChatStore.getState(), sessionId) ?? null,
        })
      }
      log.debug(`← USER (${isPushNotification ? 'push-notification' : isSkillInvoke ? 'skill_invoke' : 'observed'})`, {
        session: sessionId.slice(0, 8),
        content: content.slice(0, 60),
      })
      return
    }

    // ── system notice / context pressure / monitor / heartbeat ────────
    // W4.5 第三波 C1（2026-05-13）：移除 `AgentStreamEvents.TOOL_TIMEOUT` 桥
    // 分支——wire 层 `StreamEvents.TOOL_TIMEOUT` 已物理删（daemon 0 emit、
    // Django publish_tool_timeout_event 也 0 caller 早是死代码）；防 silent drop
    // 的兜底由 wire 常量删除 + Django RELAY 白名单移除从源头消除（即便有人
    // 重新引入 publisher，也会被 RELAY_ALLOWED_SHORT_NAMES 拦截下来）。
    if (
      eventType === AgentStreamEvents.SYSTEM_NOTICE ||
      eventType === AgentStreamEvents.CONTEXT_PRESSURE ||
      eventType === AgentStreamEvents.MONITOR_STATUS ||
      eventType === AgentStreamEvents.LLM_HEARTBEAT
    ) {
      handleSystemEvent(message, ctx)
      return
    }

    // ── LLM request snapshot (Phase 3 · Debug Observability) ──
    if (eventType === AgentStreamEvents.LLM_REQUEST || eventType === StreamEvents.LLM_SNAPSHOT) {
      const p = message.payload
      if (p && typeof p.runId === 'string' && typeof p.iteration === 'number' && typeof p.model === 'string') {
        ctx.get().pushSnapshotForSession(ctx.sessionId, p as unknown as import('../../shared/types').LLMCallSnapshot)
      }
      return
    }

    // ── checkpoint ────────────────────────────────────────────
    // 注意：DECISION_SUMMARY_READY / FAILED 已迁移到 agent.session topic，
    // 由 useChatSessionEventStream 消费，不再从 agent.stream 流入。
    if (
      eventType === AgentStreamEvents.CHECKPOINT_FAILED ||
      eventType === AgentStreamEvents.CHECKPOINT_SUCCESS
    ) {
      handleCheckpointEvent(message, ctx)
      return
    }

    // ：plan 卡片改为持久化 `tabtin_rich_content` kind='plan' block（走 content_block
    // 事件的常规链路落库 + 渲染），不再有独立的 plan_proposal 流事件分支。

    if (eventType === StreamEvents.MODE_SWITCH_PROPOSAL) {
      handleModeSwitchProposalEvent(message, ctx)
      return
    }

    // ── Wave 3：模型能力降级 / 警告 banner（capability_downgrade /
    //    capability_warning）。同 plan_exit 的处理模式：单分支字符串字面量
    //    判断，等 ws-gateway-client 后续把它收编进 enum 时再合并。
    if (eventType === 'agent.stream.capability_event') {
      handleCapabilityEvent(message, ctx)
      return
    }

    // ── misc: todo / ssh / compaction / done ─────────────────
    // ：PLAN / MODE 已从 wire 删除；TODO 仍路由到 miscHandler（Electron
    // 侧 swallow；iOS/Android 仍依赖，见 ）。
    if (
      eventType === AgentStreamEvents.TODO ||
      eventType === AgentStreamEvents.SSH_OUTPUT ||
      eventType === AgentStreamEvents.COMPACTION ||
      eventType === AgentStreamEvents.DONE
    ) {
      if (eventType === AgentStreamEvents.DONE) {
        // FR-06：本地 Runtime 把错误归因写在 DONE payload **顶层**
        // (`error` / `error_class` / `error_message` / `suggested_action` / `trace_id`)；
        // 云端 orchestration 历史路径把它放在 `payload.metadata.error_category`。
        // debug 行同时检查两处，避免 grep 排障时漏掉本地路径的错误信号。
        const payload = (message.payload ?? {}) as Record<string, unknown>
        const meta = (payload.metadata ?? {}) as Record<string, unknown>
        const hasError = !!(payload.error || payload.error_class || meta.error_category)
        log.debug('← DONE', {
          session: sessionId.slice(0, 8),
          msgId: payload.message_id,
          hasError,
          errorClass: payload.error_class ?? meta.error_category,
        })
      }
      handleMiscEvent(message, ctx)
      return
    }

    // ── SUBAGENT_STREAM_EVENT（PRD §4.18 子 Agent 实时流）──────────────
    // 必须在下面 `startsWith('agent.stream.subagent_')` 通配兜底之前 early-return——
    // 否则会被路由到 subagentHandler 的 statusMap 检查 silent ignore（事件名以
    // subagent_ 开头但不在那个 handler 的预期事件集里）。
    //
    // 本事件是子 Agent 实时 transcript 通道：runtime forward 子 envelope，
    // subagentStreamHandler 拆包后写入 useSubagentLiveStore，让 SubagentDetailPane
    // 跟主对话同款 token-by-token 实时显示。与 subagentHandler（管 metadata /
    // 卡片 / approval）正交互补。
    if (eventType === AgentStreamEvents.SUBAGENT_STREAM_EVENT) {
      handleSubagentStreamEvent(message, ctx)
      return
    }

    // ── HITL: approval_requested / approval_resolved / ask 三件套 ─────
    // 所有 session 的单一事件流都走本 handler，不再区分主动 send / observer。
    if (handleHitlStreamEvent(message, {
      sessionId,
      spaceId: ctx.spaceId,
      spaceName: ctx.spaceName,
      sessionTitle: ctx.sessionTitle,
    })) {
      return
    }

    // ── subagent events ──────────────────────────────────────
    // 包含 4 件套（PROGRESS/STARTED/FAILED/COMPLETED）+ PRD 06 协调三件套
    // （HITL_REQUIRED/QUEUED/MODEL_CALL）+ SPEAKER_PUSH_MESSAGE。前者用
    // startsWith 兜住，后者**不在 subagent_ 前缀**里（事件名是 speaker_push_message），
    // 必须显式判断——否则它会落到末尾 default 分支被 silent drop。
    // W4a-L28 修复：subagentHandler 现在显式识别全部 7 个事件 + default 兜底。
    if (
      eventType.startsWith('agent.stream.subagent_') ||
      eventType === AgentStreamEvents.SPEAKER_PUSH_MESSAGE
    ) {
      handleSubagentEvent(message, ctx)
      return
    }

    // ── default：未识别事件强信号 ────────────────────────────
    // W4.5 曾升 warn 以便开发期发现 silent drop；#5261 生产 resume 回放会夹带
    // 大量 `agent.stream.step` 等未知类型，每条 warn 刷屏会参与卡死。
    // 每 session×eventType 只 warn 一次，其余降 debug。
    const unknownKey = `${sessionId}\0${eventType}`
    if (!_unknownStreamEventWarned.has(unknownKey)) {
      _unknownStreamEventWarned.add(unknownKey)
      if (_unknownStreamEventWarned.size > 200) {
        const first = _unknownStreamEventWarned.values().next().value
        if (first !== undefined) _unknownStreamEventWarned.delete(first)
      }
      log.warn('[E2E] unknown event type — handler missing or wire schema regression', {
        session: sessionId.slice(0, 8),
        eventType,
      })
    } else {
      log.debug('[E2E] unknown event type (sampled)', {
        session: sessionId.slice(0, 8),
        eventType,
      })
    }
  }
}

/** 未知 stream 事件 warn 去重。 */
const _unknownStreamEventWarned = new Set<string>()
