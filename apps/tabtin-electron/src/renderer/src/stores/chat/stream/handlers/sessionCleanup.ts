/**
 * Unified session terminal cleanup — single source of truth for
 * all state that must be reset when a chat session ends (done / error / terminated / cancelled).
 *
 * ：busy（停止按钮）与计时（runState.endedAt）必须同一收口。
 * 业务路径应优先调 `endSessionRun`，禁止只调 `removeStreamingSession` 宣告「任务结束」
 * ——否则 UI 已空闲、footer 计时仍会跳。
 *
 * Callers: lifecycleHandler、abort cleanup、sessionRunReconcile、心跳对账、
 * WS reconnect 自愈、发送失败收口等。
 */

import { useChatRuntimeStore, flushRuntimeBatch } from '../../../useChatRuntimeStore'
import { markSessionSuspended } from '@/services/sessionSuspended'
import { cleanupWithPendingSyncCheck } from './seqTracker'
import { syncDerivedContentToChatMessage } from './syncMessageContent'
import { clearStreamTokenUsageForSession } from './streamTokenUsage'
import { clearSupersededRuns } from './supersededRuns'
import { clearActiveRunBinding } from '../../execution/activeRunBinding'
import type { AgentStep, AgentStepStatus, RunPhase } from '../../shared/types'
import {
  isSessionRunIdentityCurrent,
} from '../../execution/sessionRunProjection'

export type TerminalStatus = 'done' | 'error' | 'cancelled'

export interface TerminalCleanupOptions {
  sessionId: string
  /** lifecycle/terminal payload 对应的 run_id；用于拒绝旧轮迟到 cleanup。 */
  runId?: string | null
  /** 无 run_id 时使用派发 token 绑定本轮。 */
  dispatchToken?: string | null
  status: TerminalStatus
  errorMessage?: string
  removeStreamingSession: (
    sessionId: string,
    options?: {
      clearSeqGapSync?: boolean
      runId?: string | null
      dispatchToken?: string | null
    },
  ) => void
  /** 默认 false（与历史 cleanup 一致）；envelope.terminal 等需强制清 seq 时可传 true */
  clearSeqGapSync?: boolean
}

function resolveStepStatus(status: TerminalStatus): AgentStepStatus {
  if (status === 'cancelled') return 'cancelled'
  return status
}

function resolveRunPhase(status: TerminalStatus): RunPhase {
  if (status === 'cancelled') return 'cancelled'
  if (status === 'done') return 'done'
  return 'error'
}

/**
 * Reset all runtime state for a session that has reached a terminal state.
 *
 * Returns `true` if a pending seq-gap sync was detected (caller may want
 * to trigger an immediate message re-sync).
 */
export function cleanupSessionOnTerminal(opts: TerminalCleanupOptions): boolean {
  const {
    sessionId,
    runId = null,
    dispatchToken = null,
    status,
    errorMessage,
    removeStreamingSession,
    clearSeqGapSync = false,
  } = opts
  if (
    (runId || dispatchToken)
    && !isSessionRunIdentityCurrent(sessionId, { runId, dispatchToken })
  ) {
    return false
  }
  const now = Date.now()
  const hadPendingSync = cleanupWithPendingSyncCheck(sessionId)

  removeStreamingSession(sessionId, {
    clearSeqGapSync,
    ...(runId ? { runId } : {}),
    ...(dispatchToken ? { dispatchToken } : {}),
  })
  // ：busy 不由 markRunTerminal 写；本机靠 run_sync / reconcile，远控靠 run_state。
  flushRuntimeBatch()

  // ：清掉本 run 的流式 token 累加记录——无 DONE 的异常终止（crash /
  // watchdog stall）残留会污染下一 run 的 DONE 差额校正。正常路径 DONE 已
  // 消费并清空，此处 no-op。
  clearStreamTokenUsageForSession(sessionId)

  // 作废旧流 denylist：done/error 终态时旧 run 已 unwind，可清。
  // cancelled 常由 abortStream **乐观**先调一次——此时旧流仍在异步收尾，若此处清掉
  // superseded，尾部事件会穿过。superseded 仍留到 lifecycleHandler 终态再 settle；
  // ：cancelling 不再充当 drain 闸门，故下方 cancelled 路径也会 settle cancelling，
  // 尾部丢弃改由 abortGrace + superseded 承担。
  if (status !== 'cancelled') {
    clearSupersededRuns(sessionId)
    // ：终态后清 ActiveRunBinding；cancelled 乐观 cleanup 保留 interrupted 快照
    // 供迟到 DONE 归因。
    clearActiveRunBinding(sessionId)
  }

  const runtime = useChatRuntimeStore.getState()

  const stepStatus = resolveStepStatus(status)
  const prevSteps = runtime.agentStepsBySessionId[sessionId] ?? []
  if (prevSteps.some((s: AgentStep) => s.status === 'running')) {
    useChatRuntimeStore.setState(rs => ({
      agentStepsBySessionId: {
        ...rs.agentStepsBySessionId,
        [sessionId]: prevSteps.map((s: AgentStep) =>
          s.status === 'running'
            ? { ...s, status: stepStatus, durationMs: now - s.timestamp }
            : s
        ),
      },
    }))
  }
  // ：待办清单不再随会话终态改写状态——清单纯从 message.blocks 派生
  // （deriveTodoTimeline）。cancel/error 后未收尾的批保持原样留在 TodoPanel，
  // 如实反映"任务被打断、尚未做完"，不再事件驱动地强标 cancelled。

  // W4c · R3-P1-5：lifecycle 终态（cancelled / error / terminated）时主动给
  // 未 finalize 的 ContentBlock messages 收尾——否则 spinner 会"永远卡在
  // 流式态"（finalized=false, partial=false）。watchdog 兜底要等 120s 才
  // 触发，lifecycle 路径直接收尾让用户立即感知"已中断"。
  //
  // partialReason 路由：
  //   - status='cancelled' → 'aborted'（用户主动 cancel / lifecycle isCancelled）
  //   - status='error' / 'terminated' → 'stream_interrupted'（连接异常 / 服务端崩）
  //   - status='done' 不会进本分支（resolveRunPhase=done 不属未 finalize 兜底）
  //
  // **侧边栏 + footer 修复 v2（2026-05-17）**：runtime.messageStop 之后必须
  // 调一次 `syncDerivedContentToChatMessage` 把 derived text 同步到
  // `useChatStore.messagesBySessionId[sid][mid].content`——否则 cancel/error
  // 路径下被中断的 assistant 消息 footer 重新消失（回归到修复前 bug 状态）。
  // 正常 daemon emit message_stop 路径走 `contentBlockHandler.handleMessageStop`
  // 已经调过，这里给"daemon 没机会 emit message_stop"的兜底路径补齐。
  if (status === 'cancelled' || status === 'error') {
    const lifecyclePartialReason = status === 'cancelled' ? 'aborted' : 'stream_interrupted'
    // 测试场景下 mock store 可能不带 messageMetaBySessionId / messageStop——
    // 用安全访问跳过，不阻塞主清理路径。
    const sessionMetaMap = runtime.messageMetaBySessionId?.[sessionId] ?? {}
    const synchronizedMessageIds: string[] = []
    if (typeof runtime.messageStop === 'function') {
      for (const [messageId, meta] of Object.entries(sessionMetaMap)) {
        if (meta.finalized) continue
        // seq 用 Number.MAX_SAFE_INTEGER 保证不被 seq 倒退守卫 drop
        runtime.messageStop(sessionId, messageId, Number.MAX_SAFE_INTEGER, {
          partialReason: lifecyclePartialReason,
        })
        synchronizedMessageIds.push(messageId)
      }
    }

    // force-finalize 之后再同步 ChatMessage.content——必须放在 messageStop 调用
    // 之后，因为 messageStop 内部才会写 meta.text_summary / 标 finalized=true。
    // helper 抽到独立文件 `syncMessageContent.ts` 避免 sessionCleanup 静态依赖
    // 整个 contentBlockHandler 模块（拖入 useChatStore + 一大坨 chat store 间接依赖）。
    if (synchronizedMessageIds.length > 0) {
      // flushRuntimeBatch 已经在前面调过，这里 store state 是最新的
      try {
        for (const messageId of synchronizedMessageIds) {
          syncDerivedContentToChatMessage(sessionId, messageId)
        }
      } catch (err) {
        // fail-soft：helper 抛错（譬如 store 未初始化）时 footer 重新消失，
        // 但不阻塞主清理路径其他状态收尾。
        console.warn('[sessionCleanup] syncDerivedContentToChatMessage failed:', err)
      }
    }

    // ：abort / cancel 时 StreamManager._doAbortSession 先退订 WS，
    // daemon 随后 emit 的 tool_failed / lifecycle.end 在退订后到达会丢包，导致
    // in-flight ToolEvent（phase='start'）永远停在 "running"——ToolUseBlockView
    // 持续显示 "tool in flight" / terminal_command partial。这里强制把 phase='start'
    // 的 ToolEvent 收尾成 phase='error'(aborted_by_user)，让卡片立即切到"已停止"
    // 态；迟到的真实 lifecycle notice 仍会经 upsert merge 顶掉这条兜底。
    // 测试场景下 mock store 可能不带本方法——用 typeof 守门跳过，不阻塞主清理。
    if (typeof runtime.finalizeInFlightToolEventsForSession === 'function') {
      try {
        runtime.finalizeInFlightToolEventsForSession(sessionId)
      } catch (err) {
        console.warn('[sessionCleanup] finalizeInFlightToolEventsForSession failed:', err)
      }
    }
  }

  // ：cancel / done / error 同构 settle cancelling。旧逻辑在 cancelled 时保留
  // flag 等 lifecycle，但 abort 后退订后 lifecycle 常丢失 → cancelling 永久粘滞。
  runtime.setCancellingForSession(sessionId, false)
  runtime.updateRunStateForSession(sessionId, {
    phase: resolveRunPhase(status),
    endedAt: now,
    lastError: errorMessage,
  })

  // suspended 双写（ws-store 列表 + runtime per-session）统一走 utility，
  // 避免漏写一边导致 UI 状态不一致。
  markSessionSuspended(sessionId, false)

  return hadPendingSync
}

/**
 * ：对外唯一「结束一轮 run」seam。
 * 一次写齐 busy 收口 + `endedAt`（经 `cleanupSessionOnTerminal`）。
 */
export function endSessionRun(opts: TerminalCleanupOptions): boolean {
  return cleanupSessionOnTerminal(opts)
}

/**
 * ：发送失败 / 终态帧等路径——仅当本轮已开表且尚未停表时走完整收口；
 * 否则只清 busy（尚未 lifecycle start，或已由 lifecycle 写过 endedAt）。
 */
export function endSessionRunIfStarted(opts: TerminalCleanupOptions): boolean {
  const {
    sessionId,
    runId = null,
    dispatchToken = null,
    removeStreamingSession,
    clearSeqGapSync = false,
  } = opts
  // 与 envelope.terminal 同理：先 flush pending，再判断是否已停表。
  flushRuntimeBatch()
  const runState = useChatRuntimeStore.getState().runStateBySessionId[sessionId]
  if (runState?.startedAt == null || runState.endedAt != null) {
    removeStreamingSession(sessionId, {
      clearSeqGapSync,
      ...(runId ? { runId } : {}),
      ...(dispatchToken ? { dispatchToken } : {}),
    })
    return false
  }
  return cleanupSessionOnTerminal(opts)
}
