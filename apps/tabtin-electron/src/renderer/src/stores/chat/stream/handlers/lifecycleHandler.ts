/**
 * Lifecycle event handler — processes agent.stream.lifecycle events.
 *
 * Covers phases: start, session_resume_failed, retrying, recovering,
 * permission_timeout*, turn_start, turn_end, idle_timeout,
 * session_interrupted, heartbeat, cancelling, end/error/terminated.
 */

import i18n from '@/i18n'
import { extractChatSessionTokenUsage, omitMonotonicTokenFields } from '@/utils/chatSessionTokenUsage'
import { omitServerModelFieldsWhenLocalCodex } from '@/utils/preserveLocalCodexModelSelection'
import { useChatStore } from '@stores/chat/useChatStore'
import {
  ackLifecycleSessionViewedIfPresent,
  emitOrAckLifecycleTerminalNotification,
} from './lifecycleTerminalNotify'
import { compactNotificationSummary } from '@/services/compactNotificationSummary'
import { isSessionBusy } from '../../execution/sessionRunProjection'
import { scheduleTerminalRunReconcile } from '../../execution/sessionRunReconcile'
import type { ChatClient, ChatMessage, ChatSession } from '@tabtin/chat-client'
import type {
  AgentStepType,
  AgentStepStatus,
} from '../../shared/types'
import {
  payloadStr as str,
  payloadStrOpt as strOpt,
  payloadStrNull as strNull,
  payloadNum as num,
} from '../../shared/helpers'
import { cleanupSessionOnTerminal } from './sessionCleanup'
import { clearSupersededRuns } from './supersededRuns'
import { isWithinAbortGrace } from './abortGrace'
import { clearActiveThinking, clearAssistantErrorMeta } from './assistantSessionState'
import { handleError as handleErrorEvent } from './errorHandler'
import { clearToolCallArgsBuffers, gcStaleToolCallArgsBuffers } from './toolCallArgsBufferStore'
import { createLogger } from '@/utils/logger'
import type { AgentStreamMessage, HandlerContext } from './streamHandlerTypes'
import { trackChatTelemetry } from '../../execution/chatTelemetry'
import {
  findAssistantAfterPendingUser,
  isCheckpointAnchorAssistant,
  type CheckpointPendingContext,
} from '../../checkpoint/handlers/checkpointAnchor'
import { cacheMessages } from '../../messages/messageCache'
import {
  markUserMessageDelivered,
  resolveSourceClientEventId,
} from '../../messages/actions/messageStatusUpdates'

const log = createLogger('E2E:Lifecycle')

/**
 * 专题「Checkpoint 产品对齐」Gap 1 修复——
 *
 * 在 phase==='end' 分支被调用：从 useChatStore 原子消费 baseline pending context
 *（spaceId + baselineHashPromise + 本轮 user 标识），await baseline 拿 hash，然后调
 * createCheckpoint(sessionId, lastAssistantMessageId, ...)。
 *
 * 用动态 import 拿 useChatStore：与 checkpointHandler.ts / planProposalHandler.ts 等
 * 同款做法——避免 lifecycle handler 顶部静态 import 形成模块循环依赖。
 *
 * 幂等：FIFO consume 后该条 pending 即离开队列。重复 lifecycle.end
 * 会因队列空而 no-op。
 *
 * Fail-soft：拿不到 context（kickoff 未写入 / 已被消费）/ 同步后仍拿不到
 * lastAssistant / createCheckpoint 抛错 → log.warn 兜底，不阻塞。下一轮继续触发。
 */
function extractServerMessages(response: { messages?: ChatMessage[] } | ChatMessage[] | null | undefined): ChatMessage[] {
  if (Array.isArray(response)) return response
  return Array.isArray(response?.messages) ? response.messages : []
}

async function listVisibleServerMessages(
  sessionId: string,
  client: HandlerContext['client'],
  opts: { after?: string } = {},
): Promise<ChatMessage[] | null> {
  if (!client.messages?.list) return null

  const response = await client.messages.list(sessionId, { limit: 500, ...opts })
  return extractServerMessages(response)
}

function findLastPersistedAssistant(messages: ChatMessage[]): ChatMessage | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (isCheckpointAnchorAssistant(message)) return message
  }
  return null
}

/** 轮末建 checkpoint：list 只算锚点，不写 messagesBySessionId。导出供行为测。 */
export async function triggerCheckpointAfterLifecycleEnd(sessionId: string, client: HandlerContext['client']): Promise<void> {
  try {
    const { useChatStore } = await import('@stores/chat/useChatStore')
    const state = useChatStore.getState()
    // ：FIFO 消费，避免同会话连发覆盖；消费本身幂等（重复 end 第二次拿不到）
    const ctx = (
      typeof state.consumeCheckpointPendingContext === 'function'
        ? state.consumeCheckpointPendingContext(sessionId)
        : undefined
    ) as CheckpointPendingContext | undefined
    if (!ctx) {
      const remainingQueues = Object.keys(state.checkpointPendingContextBySessionId ?? {}).length
      log.warn('lifecycle.end: no checkpoint pending context, skip', {
        sessionId: sessionId.slice(0, 8),
        remainingSessionQueues: remainingQueues,
        bridgeAvailable: typeof window !== 'undefined' && !!window.tabtin?.checkpoint,
      })
      return
    }

    let messages: ChatMessage[] = []
    let lastAssistant: ChatMessage | null = null
    let stateIndexHint: number | undefined
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (ctx.userServerMessageId) {
          const afterMessages = await listVisibleServerMessages(sessionId, client, { after: ctx.userServerMessageId })
          if (!afterMessages) {
            log.warn('lifecycle.end: client cannot list visible messages, skip checkpoint', { sessionId: sessionId.slice(0, 8) })
            return
          }
          messages = afterMessages
          lastAssistant = findLastPersistedAssistant(afterMessages)
          if (lastAssistant) break
          if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 150))
          continue
        }

        const serverMessages = await listVisibleServerMessages(sessionId, client)
        if (!serverMessages) {
          log.warn('lifecycle.end: client cannot list visible messages, skip checkpoint', { sessionId: sessionId.slice(0, 8) })
          return
        }
        messages = serverMessages
        lastAssistant = findAssistantAfterPendingUser(messages, ctx)
        stateIndexHint = messages.length
        if (lastAssistant) break
        if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 150))
      }
    } catch (err) {
      log.warn('lifecycle.end: list visible messages before checkpoint failed, skip checkpoint', err)
      return
    }

    if (!lastAssistant) {
      log.warn('lifecycle.end: no visible persisted assistant after this user message, skip checkpoint', { sessionId: sessionId.slice(0, 8) })
      return
    }
    //  方案 A：list 结果只用于算 checkpoint 锚点 / stateIndexHint，
    // 禁止在此把服务端页权威写回 messagesBySessionId（那会盖掉 runtime live）。
    // 列表对齐只走 scheduleTerminalMessageReconcile → upsert 对账。

    let baselineHash: string | undefined
    try {
      baselineHash = await ctx.baselineHashPromise
    } catch {
      // baseline failed (non-blocking)：vs parent diff 仍可工作
      baselineHash = undefined
    }

    await useChatStore.getState().createCheckpoint(sessionId, lastAssistant.id, stateIndexHint, {
      spaceId: ctx.spaceId,
      baselineHash,
      kind: 'agent_turn_done',
    })
  } catch (err) {
    log.warn('triggerCheckpointAfterLifecycleEnd failed (non-blocking)', err)
  }
}

/**
 * ：轮末最多一次同一套 upsert 对账。
 * advanceWatermark 默认 true——统一 upsert 成功即推进水位，供后续 freshness
 * short-circuit；旧 forceFullLatest 的 hold 水位只为「半页校正不冒充已对齐」。
 */
function scheduleTerminalMessageReconcile(sessionId: string): void {
  void (async () => {
    await new Promise(resolve => setTimeout(resolve, 600))
    const { reconcileSessionMessages } = await import('@/services/sessionFreshness')
    if (isSessionBusy(sessionId)) return
    await reconcileSessionMessages(sessionId, {
      force: true,
      retry: false,
      silentOnError: true,
      reason: 'lifecycle-end',
    })
  })().catch(() => {})
}

function syncSessionMessagesAfterPendingGap(sessionId: string, hadPendingSync: boolean): void {
  if (!hadPendingSync) return
  import('@stores/chat/useChatStore').then(({ useChatStore }) => {
    useChatStore.getState().syncSessionMessagesFromServer(sessionId)
  }).catch(() => {})
}

function resolveLastAssistantMessageId(sessionId: string): string | undefined {
  try {
    const msgs = useChatStore.getState().messagesBySessionId?.[sessionId] ?? []
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      if (msgs[i]?.role === 'assistant' && msgs[i]?.id) return msgs[i].id
    }
  } catch {
    // ignore — 通知仍可跳到会话级
  }
  return undefined
}

/** ：本机 OS 通知 body 用末条 assistant 一句话摘要，不用全文。 */
function resolveLastAssistantNotificationSummary(sessionId: string): string {
  try {
    const msgs = useChatStore.getState().messagesBySessionId?.[sessionId] ?? []
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      const msg = msgs[i]
      if (msg?.role !== 'assistant') continue
      const content = typeof msg.content === 'string' ? msg.content : ''
      const summary = compactNotificationSummary(content)
      if (summary) return summary
    }
  } catch {
    // ignore — 回退会话标题 / 固定文案
  }
  return ''
}

/**
 * ：把本轮 lifecycle 耗时写入最后一条 assistant 的 metadata，
 * 供消息 footer（credits 旁）在 debug 开关下展示。仅客户端内存/消息缓存，不上云。
 */
function patchLastAssistantRoundDuration(sessionId: string, durationMs: number | undefined): void {
  if (durationMs == null || !Number.isFinite(durationMs) || durationMs < 0) return
  const messageId = resolveLastAssistantMessageId(sessionId)
  if (!messageId) return
  try {
    useChatStore.getState().patchMessageById(sessionId, messageId, (msg) => {
      if (msg.role !== 'assistant') return msg
      return {
        ...msg,
        metadata: {
          ...(msg.metadata ?? {}),
          round_duration_ms: durationMs,
        },
      }
    })
  } catch (err) {
    log.warn('patchLastAssistantRoundDuration failed (non-blocking)', err)
  }
}

export function handleLifecycleEvent(message: AgentStreamMessage, ctx: HandlerContext): void {
  const {
    sessionId,
    spaceId,
    sessionTitle,
    notifyPrefix,
    get,
    addStreamingSession,
    removeStreamingSession,
    client,
    updateSessionTokenUsageInCaches,
    updateSessionInCaches,
    onLifecycleEnd,
  } = ctx

  const payload = message.payload || {}
  const phase = payload.phase

  log.debug(`phase=${phase}`, {
    session: sessionId.slice(0, 8),
    run: payload.run_id, source: payload.source,
  })

  if (phase === 'start') {
    addStreamingSession(sessionId, strOpt(payload.run_id))
    // ：只认 source_client_event_id；#6675：经 markUserMessageDelivered 写入。
    const sourceClientEventId = resolveSourceClientEventId(payload)
    if (sourceClientEventId) {
      const store = useChatStore.getState()
      markUserMessageDelivered(sessionId, sourceClientEventId, {
        getMessages: () => store.messagesBySessionId[sessionId] ?? [],
        patchMessageById: store.patchMessageById,
      })
    }
    const stepsAtStart = get().agentStepsBySessionId[sessionId] ?? []
    const runningTransient = [...stepsAtStart].reverse().find(
      s => (s.id.startsWith('recovering-') || s.id.startsWith('retrying-')) && s.status === 'running',
    )
    if (runningTransient) {
      get().updateAgentStepForSession(sessionId, runningTransient.id, {
        status: 'done' as AgentStepStatus,
        durationMs: Date.now() - runningTransient.timestamp,
      })
    }
    get().updateRunStateForSession(sessionId, {
      runId: strNull(payload.run_id),
      phase: 'planning',
      startedAt: Date.now(),
      endedAt: null,
      completedToolCalls: 0,
      totalToolCalls: 0,
      lastError: undefined,
    })
    return
  }

  if (phase === 'session_resume_failed') {
    get().pushAgentStepForSession(sessionId, {
      id: `session-resume-failed-${Date.now()}`,
      type: 'lifecycle' as AgentStepType,
      title: i18n.t('chat:daemon.sessionResumeFailed', {
        defaultValue: 'Could not restore previous session — a new one has been started. You can continue chatting normally.',
      }),
      detail: strOpt(payload.detail),
      status: 'done' as AgentStepStatus,
      timestamp: Date.now(),
    })
    return
  }

  if (phase === 'retrying') {
    const steps = get().agentStepsBySessionId[sessionId] ?? []
    const existingRetry = [...steps].reverse().find(s => s.id.startsWith('retrying-'))
    if (existingRetry) {
      get().updateAgentStepForSession(sessionId, existingRetry.id, {
        title: strOpt(payload.detail) || i18n.t('chat:daemon.retrying', {
          defaultValue: 'Retrying connection...',
        }),
        timestamp: Date.now(),
      })
    } else {
      get().pushAgentStepForSession(sessionId, {
        id: `retrying-${Date.now()}`,
        type: 'lifecycle' as AgentStepType,
        title: strOpt(payload.detail) || i18n.t('chat:daemon.retrying', {
          defaultValue: 'Retrying connection...',
        }),
        status: 'running' as AgentStepStatus,
        timestamp: Date.now(),
      })
    }
    return
  }

  if (phase === 'recovering') {
    const steps = get().agentStepsBySessionId[sessionId] ?? []
    const existingRecovery = [...steps].reverse().find(s => s.id.startsWith('recovering-'))
    if (existingRecovery) {
      get().updateAgentStepForSession(sessionId, existingRecovery.id, {
        title: strOpt(payload.detail) || i18n.t('chat:daemon.recovering', {
          defaultValue: 'Agent process crashed, recovering automatically...',
        }),
        timestamp: Date.now(),
      })
    } else {
      get().pushAgentStepForSession(sessionId, {
        id: `recovering-${Date.now()}`,
        type: 'lifecycle' as AgentStepType,
        title: strOpt(payload.detail) || i18n.t('chat:daemon.recovering', {
          defaultValue: 'Agent process crashed, recovering automatically...',
        }),
        status: 'running' as AgentStepStatus,
        timestamp: Date.now(),
      })
    }
    return
  }

  if (phase === 'turn_start') {
    trackChatTelemetry('run.turn.start', {
      sessionId,
      runId: strOpt(payload.run_id),
      traceId: strOpt(payload.trace_id),
      turnId: strOpt(payload.turn_id),
      iteration: num(payload.iteration),
      startedAt: num(payload.started_at),
    }, {
      counterKey: 'run.turn.start',
      sessionId,
    })
    get().updateRunStateForSession(sessionId, {
      phase: 'planning',
    })
    // Widget 治理 Wave 2.5b §任务 3：buffer 多 turn 内累积内存防线。
    // 双触发点之一（turn_start）：兜底——如果上一轮 turn_end 因任何原因
    // 没 emit（譬如 LLM 异常 + 后端 graceful 直接进 turn_start），下一轮
    // 开始时清掉上一轮残留 buffer，避免长会话内存无界增长。
    // 阈值 2 秒确保不误清当前 turn_start 之后立刻到来的新 buffer——
    // 此时新 buffer 还没创建，gc 只看老 buffer 的 lastDeltaAt。
    gcStaleToolCallArgsBuffers(sessionId)
    return
  }

  if (phase === 'turn_end') {
    const turnStatus = str(payload.status, 'completed')
    const durationMs = num(payload.duration_ms)
    const toolCallCount = num(payload.tool_call_count) ?? 0
    trackChatTelemetry('run.turn.end', {
      sessionId,
      runId: strOpt(payload.run_id),
      traceId: strOpt(payload.trace_id),
      turnId: strOpt(payload.turn_id),
      iteration: num(payload.iteration),
      status: turnStatus,
      durationMs,
      toolCallCount,
      toolDurationMs: num(payload.tool_duration_ms),
    }, {
      counterKey: 'run.turn.end',
      sessionId,
    })
    if (payload.source === 'runtime') {
      get().pushAgentStepForSession(sessionId, {
        id: `turn-end-${payload.turn_id || Date.now()}`,
        type: 'lifecycle' as AgentStepType,
        title: i18n.t('chat:agentSteps.turnEnd', {
          status: turnStatus,
          duration: durationMs ? `${(durationMs / 1000).toFixed(1)}s` : '?',
          tools: toolCallCount,
        }),
        status: turnStatus === 'completed' ? 'done' as AgentStepStatus : 'error' as AgentStepStatus,
        timestamp: Date.now(),
        durationMs,
      })
    }
    // Widget 治理 Wave 2.5b §任务 3：buffer 多 turn 内累积内存防线。
    // 双触发点之一（turn_end）：本轮所有 LLM 流式 + 工具 execute 都收尾了，
    // 已 finalize 的 buffer 没必要再留——dev panel 在跨 turn 时切到下一轮
    // 是合理的 UX。in-flight 的 buffer（lastDeltaAt 离 now < 2 秒）会被
    // 阈值过滤保住——理论上不该存在但加一道防线。
    gcStaleToolCallArgsBuffers(sessionId)
    return
  }

  if (phase === 'idle_timeout') {
    const hadPendingSync = cleanupSessionOnTerminal({
      sessionId,
      runId: strOpt(payload.run_id),
      status: 'cancelled',
      removeStreamingSession,
    })
    scheduleTerminalRunReconcile(sessionId)
    // Widget 治理 Wave 2.5b §任务 3（自修复）：idle_timeout 是非正常 lifecycle
    // 终态——session 实际上已断连但前端只 removeStreamingSession 清不了 args
    // buffer。三视角 Review（真实用户视角 + 技术优雅度）双独立指出：不清的话
    // RichWidget `isStreaming` 永远转、in-memory buffer 跨 turn 累积。这正是
    // 任务 3 内存防线该闭环的子路径。reason='session_disconnected' 是显式
    // sentinel 协议为这条路径预留的语义（与 'session_ended' 区分）。
    clearToolCallArgsBuffers(sessionId, 'session_disconnected')
    get().pushAgentStepForSession(sessionId, {
      id: `idle-timeout-${Date.now()}`,
      type: 'lifecycle' as AgentStepType,
      title: i18n.t('chat:daemon.idleTimeout', {
        defaultValue: 'External Agent disconnected due to inactivity. Send a new message to reconnect.',
      }),
      status: 'done' as AgentStepStatus,
      timestamp: Date.now(),
    })
    syncSessionMessagesAfterPendingGap(sessionId, hadPendingSync)
    return
  }

  if (phase === 'session_interrupted') {
    const hadPendingSync = cleanupSessionOnTerminal({
      sessionId,
      runId: strOpt(payload.run_id),
      status: 'cancelled',
      removeStreamingSession,
    })
    scheduleTerminalRunReconcile(sessionId)
    // Widget 治理 Wave 2.5b §任务 3（自修复）：同 idle_timeout——session 被
    // Daemon 重启等强制中断，前端必须清 args buffer + 发 sentinel，否则
    // RichWidget 会卡在流式态 + buffer 长期残留。
    clearToolCallArgsBuffers(sessionId, 'session_disconnected')
    get().pushAgentStepForSession(sessionId, {
      id: `session-interrupted-${Date.now()}`,
      type: 'lifecycle' as AgentStepType,
      title: i18n.t('chat:daemon.sessionInterrupted', {
        defaultValue: 'Agent session was interrupted by a Daemon restart. Please re-send the prompt to continue.',
      }),
      status: 'done' as AgentStepStatus,
      timestamp: Date.now(),
    })
    emitOrAckLifecycleTerminalNotification({
      phase: 'session_interrupted',
      sessionId,
      spaceId,
      sessionTitle,
      notifyPrefix,
      sessionInterruptedBody:
        sessionTitle
        || i18n.t('chat:notification.agentSessionInterruptedBody', {
          defaultValue: '运行时服务器重启，会话已中断',
        }),
      completedTitle: i18n.t('chat:notification.agentCompleted', { defaultValue: 'Agent 任务完成' }),
      completedBody:
        sessionTitle
        || i18n.t('chat:notification.agentCompletedBody', { defaultValue: '对话已完成处理' }),
      errorTitle: i18n.t('chat:notification.agentError', { defaultValue: 'Agent 任务出错' }),
      interruptedTitle: i18n.t('chat:notification.agentSessionInterrupted', {
        defaultValue: 'Agent 会话已中断',
      }),
    })
    syncSessionMessagesAfterPendingGap(sessionId, hadPendingSync)
    return
  }

  if (phase === 'cancelling') {
    log.info('━━━ CANCELLING ━━━', { session: sessionId.slice(0, 8) })
    get().setCancellingForSession(sessionId, true)
    return
  }

  if (phase === 'end' || phase === 'error' || phase === 'terminated') {
    const lifecycleDurationMs = num(payload.duration_ms)
    trackChatTelemetry('run.lifecycle.end', {
      sessionId,
      runId: strOpt(payload.run_id),
      traceId: strOpt(payload.trace_id),
      phase,
      status: strOpt(payload.status),
      startedAt: num(payload.started_at),
      endedAt: num(payload.ended_at),
      durationMs: lifecycleDurationMs,
    }, {
      counterKey: 'run.lifecycle.end',
      sessionId,
      level: phase === 'error' ? 'error' : 'info',
    })
    // ：先把本轮耗时落到最后一条 assistant metadata，再走 cleanup。
    // 这样 footer 在 streaming 结束后立刻能读到定格值，不依赖 runState 仍是 last。
    patchLastAssistantRoundDuration(sessionId, lifecycleDurationMs)
    // ：phase=error 只打 telemetry；聊天气泡由 DONE → finalizeDoneEvent 唯一写入。
    if (phase === 'error') {
      try {
        handleErrorEvent(message, ctx)
      } catch (err) {
        log.warn('errorHandler injection failed', err)
      }
    }

    clearActiveThinking(sessionId)
    clearAssistantErrorMeta(sessionId)

    // Widget Wave 3（RFC §五 3.6）：先把 isCancelled 算出来，路由 widget mark 状态。
    // 计算放在 markStreamingWidgetsInterruptedAndClearOthers 之前——cleanup 调用要
    // 拿到 finalStatus，widget mark 也要拿到。
    // ：isCancelled 只影响 widget / 通知 / checkpoint，不再充当 drain 闸门。
    // abortGrace 覆盖「lifecycle 先到、cancelling 尚未可见」的竞态。
    const isCancelled = get().cancellingBySessionId[sessionId] === true
      || payload.status === 'cancelled'
      || isWithinAbortGrace(sessionId)

    const finalStatus = isCancelled
      ? 'cancelled' as const
      : (phase === 'error' || phase === 'terminated') ? 'error' as const : 'done' as const

    // Widget Wave 3（RFC §五 3.6）：cancel / error / terminated 时**保留**
    // streaming widget block + 标记 `interrupted_at`，让用户看到"已中断"badge
    // 而不是 widget 啪一下消失。非 widget kind（image / table_preview / file /
    // resource_ref）沿用原 clearRichContentBlocks 全清行为兼容。
    //
    // status 路由：
    //   - 用户主动 cancel → 'cancelled'
    //   - phase=='error'  → 'error'
    //   - phase=='terminated' → 'terminated'
    //   - phase=='end' 正常完成时 → mark 'unknown'，但实际不触发：final RICH_CONTENT
    //     已通过 upsert 把 placeholder 替换为带 finalCode 的 widget block，
    //     RichWidget 不会显示 interrupted UI（finalCode 优先级 > interrupted_at）。
    const widgetMarkStatus: 'cancelled' | 'error' | 'terminated' | 'unknown' =
      isCancelled
        ? 'cancelled'
        : phase === 'error'
          ? 'error'
          : phase === 'terminated'
            ? 'terminated'
            : 'unknown'
    get().markStreamingWidgetsInterruptedAndClearOthers(sessionId, widgetMarkStatus)
    // Widget Wave 1：清理流式 tool args partial 缓冲区——lifecycle 终态后
    // 任何 in-flight tool_use 都已结束（tool_use chunk 已 emit final），
    // 残留 buffer 只对调试有意义，按"会话终态即清"原则释放。
    //
    // Widget 治理 Wave 2.5b §任务 2：传具体 reason 让 sentinel 协议显式
    // 区分"正常完成 / 异常 / 强制终止"——消费方（Wave 3 cancel UI 等）能
    // 据此分支文案。isCancelled 用 session_ended（用户主动收尾，语义同
    // 自然完成；与 widget mark 'cancelled' 是不同维度——前者是 sentinel 协议
    // 的"buffer 清理原因"，后者是"widget 终态显示状态"）。
    const sentinelReason = phase === 'error'
      ? 'session_errored'
      : phase === 'terminated'
        ? 'session_terminated'
        : 'session_ended'
    clearToolCallArgsBuffers(sessionId, sentinelReason)
    // 兜底：session 终止时把所有残留 running 的 thinking step 标为 done，
    // 防止 STEP done 事件因任何原因未能更新 store 时 spinner 永远转。
    const stepsAtEnd = get().agentStepsBySessionId[sessionId] ?? []
    const now = Date.now()
    for (const step of stepsAtEnd) {
      if (step.type === 'thinking' && step.status === 'running') {
        get().updateAgentStepForSession(sessionId, step.id, {
          status: 'done' as AgentStepStatus,
          durationMs: now - step.timestamp,
        })
      }
    }
    const lifecycleErrorMessage = phase === 'error'
      ? str(payload.error_message ?? payload.detail ?? payload.error, 'Unknown error')
      : phase === 'terminated'
        ? str(payload.message, i18n.t('chat:messages.terminated', { defaultValue: 'Conversation terminated' }))
        : undefined

    log.info(`━━━ ${phase.toUpperCase()} ━━━`, {
      session: sessionId.slice(0, 8),
      error: phase === 'error' ? lifecycleErrorMessage : undefined,
    })

    const hadPendingSync = cleanupSessionOnTerminal({
      sessionId,
      runId: strOpt(payload.run_id),
      status: finalStatus,
      errorMessage: lifecycleErrorMessage,
      removeStreamingSession,
    })
    scheduleTerminalRunReconcile(sessionId)
    // settle 用户取消意图：cancelled 的乐观 cleanup 故意保留这两项，真正终态在此收口。
    get().setCancellingForSession(sessionId, false)
    clearSupersededRuns(sessionId)
    get().clearActiveSubmittedMessage(sessionId)
    scheduleTerminalMessageReconcile(sessionId)

    client.sessions.get(sessionId).then((freshSession: ChatSession) => {
      // 双轨写入：
      //   1. token 字段走单调路径（`updateSessionTokenUsageInCaches` 内 `Math.max`
      //      拦旧值回滚，防 race 写小值覆盖大值）；
      //   2. 其余字段走全量 merge——`omitMonotonicTokenFields` 把 token 字段
      //      剔掉再 patch，避免破坏 (1) 的单调保护。
      //
      // 不全量 merge 的代价：列表 UI 字段一直停在首次 list 拉取的快照——
      //   - `resolveSessionDisplayStatus` 看 `message_count===0` 永久判草稿；
      //   - Tracker Run 关联会话 `tracker_run.run_status` 卡旧值；
      //   - `last_message_preview` / `title` / `is_reverted` 也都不会刷新。
      // 之前只挑 token 写回，等于"打了 API 又把 90% 数据扔了"。
      const usage = extractChatSessionTokenUsage(freshSession)
      updateSessionTokenUsageInCaches(sessionId, usage)
      // 本机 Codex 选择未落库；GET 写回时勿用 Django 的平台模型盖掉。
      const localSession = useChatStore.getState().getSessionById(sessionId)
      updateSessionInCaches(
        sessionId,
        omitServerModelFieldsWhenLocalCodex(
          localSession,
          omitMonotonicTokenFields(freshSession),
        ),
      )
      // last_message_at 刷新可能晚于终态门闩的 markViewed；人仍在看时再 ack 一次，
      // 避免侧栏「新消息蓝点」在完成刷新后被重新点亮。
      ackLifecycleSessionViewedIfPresent(sessionId)
    }).catch((err: unknown) => {
      console.warn('[Chat] Failed to refresh session after lifecycle.end:', err)
    })

    if (isCancelled) {
      // User-initiated cancel — no system notification (user already knows)
    } else if (phase === 'end') {
      onLifecycleEnd()
      // 专题「Checkpoint 产品对齐」Gap 1 修复：直接从 store 消费 pending context
      // 触发 createCheckpoint——彻底解决 done/lifecycle.end closure race（done callback
      // 比 lifecycle handler 早 1 个 microtask 触发，旧的 onLifecycleEnd → 设
      // pendingCheckpointForRun=true 路径在 sendMessage 闭包返回后没人消费）。
      //
      // 设计要点：
      //   - 从 store 拿 (spaceId, baselineHashPromise)，await promise 拿 baselineHash
      //   - 从服务端可见 messages 中找“本轮 user 之后”的 assistant 作为 createCheckpoint 锚点
      //   - list 结果不写 messagesBySessionId；列表对齐只走下方 terminal upsert
      //   - FIFO consume pending，保证幂等（重复事件不会重复 commit）
      //   - 失败 fail-soft：log.warn 不阻塞（与 sendMessage onError 兜底路径同一容忍度）
      void triggerCheckpointAfterLifecycleEnd(sessionId, client)
      const terminalMessages = useChatStore.getState().messagesBySessionId[sessionId] ?? []
      void cacheMessages(sessionId, terminalMessages).catch(() => undefined)
      const completedSummary = resolveLastAssistantNotificationSummary(sessionId)
      emitOrAckLifecycleTerminalNotification({
        phase: 'end',
        sessionId,
        spaceId,
        sessionTitle,
        notifyPrefix,
        messageId: resolveLastAssistantMessageId(sessionId),
        dedupRef: strOpt(payload.trace_id) || strOpt(payload.run_id),
        // OS toast 无 typeLabel，title 保留状态句；body 用一句话摘要。
        completedTitle: i18n.t('chat:notification.agentCompleted', { defaultValue: 'Agent 任务完成' }),
        completedBody:
          completedSummary
          || sessionTitle
          || i18n.t('chat:notification.agentCompletedBody', { defaultValue: '对话已完成处理' }),
        errorTitle: i18n.t('chat:notification.agentError', { defaultValue: 'Agent 任务出错' }),
        interruptedTitle: i18n.t('chat:notification.agentTerminated', { defaultValue: 'Agent 已终止' }),
      })
    } else if (phase === 'error') {
      const errorSummary = compactNotificationSummary(lifecycleErrorMessage || '')
      emitOrAckLifecycleTerminalNotification({
        phase: 'error',
        sessionId,
        spaceId,
        sessionTitle,
        notifyPrefix,
        messageId: resolveLastAssistantMessageId(sessionId),
        dedupRef: strOpt(payload.trace_id) || strOpt(payload.run_id),
        errorBody:
          errorSummary
          || sessionTitle
          || i18n.t('chat:notification.agentErrorBody', { defaultValue: '处理过程中发生错误' }),
        completedTitle: i18n.t('chat:notification.agentCompleted', { defaultValue: 'Agent 任务完成' }),
        completedBody:
          resolveLastAssistantNotificationSummary(sessionId)
          || sessionTitle
          || i18n.t('chat:notification.agentCompletedBody', { defaultValue: '对话已完成处理' }),
        errorTitle: i18n.t('chat:notification.agentError', { defaultValue: 'Agent 任务出错' }),
        interruptedTitle: i18n.t('chat:notification.agentTerminated', { defaultValue: 'Agent 已终止' }),
      })
    } else if (phase === 'terminated') {
      const interruptedSummary = compactNotificationSummary(str(payload.message, ''))
      emitOrAckLifecycleTerminalNotification({
        phase: 'terminated',
        sessionId,
        spaceId,
        sessionTitle,
        notifyPrefix,
        messageId: resolveLastAssistantMessageId(sessionId),
        dedupRef: strOpt(payload.trace_id) || strOpt(payload.run_id),
        interruptedBody:
          interruptedSummary
          || sessionTitle
          || i18n.t('chat:notification.agentTerminatedBody', { defaultValue: '对话已被终止' }),
        completedTitle: i18n.t('chat:notification.agentCompleted', { defaultValue: 'Agent 任务完成' }),
        completedBody:
          resolveLastAssistantNotificationSummary(sessionId)
          || sessionTitle
          || i18n.t('chat:notification.agentCompletedBody', { defaultValue: '对话已完成处理' }),
        errorTitle: i18n.t('chat:notification.agentError', { defaultValue: 'Agent 任务出错' }),
        interruptedTitle: i18n.t('chat:notification.agentTerminated', { defaultValue: 'Agent 已终止' }),
      })
    }
    // ：lifecycle 只收口内容副作用；闲态由 run_sync → sessionRunProjection 宣布。
    // 在线排队在 host，离线 flush 只走 WS 重连 / 手动重发——此处不再 drain。

    syncSessionMessagesAfterPendingGap(sessionId, hadPendingSync)
  }
}
