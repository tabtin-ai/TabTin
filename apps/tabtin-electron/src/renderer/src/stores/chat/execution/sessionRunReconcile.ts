/**
 * sessionRunReconcile — 会话执行态的**对账与自愈**（ 阶段 3）。
 *
 * 投影层（sessionRunProjection）平时靠流事件驱动；事件一丢（流中途断裂 / WS 断连 /
 * 终态信号缺失）投影就会永久漂移——停止按钮失效、消息永久排队。本模块提供「向权威
 * 源重新确认真实状态」的能力：
 *
 *   - 权威源：本机 runtime 的 `agent-engine:get-state`（`ConversationRunQueue.isBusy` +
 *     `queuedRunIds`，阶段 1 已对准）。
 *   - 对账动作：权威 busy → 覆写投影（必要时补回 streaming 标记）；权威 idle 且
 *     本机确实托管过该 session → 走单一终态收口（cleanupSessionOnTerminal）。
 *     ：在线排队在 host，闲态由 run_sync 宣布；本机对账不再 drain 前端队。
 *
 * ## 触发点
 *
 *   1. 会话流挂载（useConversationStream resident 分片 mount）——切换 / 打开会话
 *      时校一次，断流期间切走再切回能立刻自愈。
 *   2. WS 重连（useChatStore 的 setReconnectHandler）——断连窗口丢的终态事件靠
 *      重连后对账补。
 *   3. 周期巡检（sweep，30s）——投影 busy 但长时间无新写入的会话主动对账，覆盖
 *      「流中途断裂且用户停在当前会话」的场景（内容级 watchdog 只盯未 finalize
 *      的 message，流断在 message_start 之前时它完全不触发——#4985 实测正是这种）。
 *   4. busy-retain（UI 切走仍 busy）——立即对本机权威对账一次；同时
 *      `streamSources` 保留 watch，保证遥控 / 本机迟到终态仍可达投影。
 *
 * ## 为什么可以放心多触发
 *
 * 对账是**查询**而非猜测：runtime 说 busy 就维持 busy，说 idle 才收口。长工具执行 /
 * HITL 挂起等「安静但仍在跑」的场景，get-state 会如实返回 busy——多查无害。
 *
 * ## 边界（ 方案 A）
 *
 *   - 本机托管会话：busy 权威 = `agent.stream.run_sync`；本机 get-state 对账 /
 *     force_idle 仅作丢包兜底（`runtime-mirror-override`，不占 host seq）。
 *   - 远控 / 跨设备旁观：busy SSoT = 服务端 `run_state`（ACK / WS /
 *     HTTP snapshot）。本机 get-state miss 时**禁止** force_idle，改为
 *     `sessions.get` → `applySessionRunStateSnapshot`。
 */

import { useChatRuntimeStore, flushRuntimeBatch } from '@/stores/useChatRuntimeStore'
import { getSessionController, hasRuntimeBridge } from '@/services/agentService'
import { createLogger } from '@/utils/logger'
import { trackChatTelemetry } from './chatTelemetry'
import {
  applyRunReconcile,
  applySessionRunStateEvent,
  getSessionRunProjection,
  isActiveRunStatus,
  isChatSessionRunState,
  isSessionRunIdentityCurrent,
} from './sessionRunProjection'
import type { ChatSessionRunState } from '@tabtin/chat-client'

const log = createLogger('SessionRunReconcile')

/** 同一 session 两次对账的最小间隔（触发点可能重叠，节流防 IPC 打爆）。 */
const MIN_RECONCILE_INTERVAL_MS = 5_000
/** lifecycle 终态可能先于 Host queue finally；只补一次短暂复查覆盖该竞态。 */
const TERMINAL_RECONCILE_RETRY_MS = 1_000
/** 周期巡检间隔。 */
const SWEEP_INTERVAL_MS = 30_000
/** 投影 busy 且距最近一次写入超过该时长才纳入巡检对账（活跃流不用查）。 */
const SWEEP_STALE_AFTER_MS = 45_000

const _inFlight = new Map<string, Promise<void>>()
const _lastReconcileAt = new Map<string, number>()
const _terminalRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const _terminalReconcileGeneration = new Map<string, number>()

export type ReconcileReason =
  | 'session-attach'
  | 'ws-reconnect'
  | 'sweep'
  | 'watchdog'
  | 'manual'
  /** lifecycle 已观察到终态：绕过常规节流，立即核对 Host queue。 */
  | 'terminal-observed'
  /** ：UI 切走后 busy-retain——本机权威即时对账；遥控 miss 不误清。 */
  | 'busy-retain'

/**
 * 对一条会话做一次执行态对账（fire-safe：任何失败只记日志，不抛）。
 *
 * @returns 本次是否实际发起了查询（被节流 / 无 bridge 时 false）。
 */
export async function reconcileSessionRunState(
  sessionId: string,
  reason: ReconcileReason = 'manual',
): Promise<boolean> {
  if (!sessionId) return false
  // 无本机 runtime IPC（纯远程客户端形态）——没有可查询的本机权威，跳过。
  if (!hasRuntimeBridge()) return false

  const force = reason === 'terminal-observed'
  const inflight = _inFlight.get(sessionId)
  if (inflight) {
    await inflight
    if (!force) return false
  }
  const last = _lastReconcileAt.get(sessionId) ?? 0
  if (!force && Date.now() - last < MIN_RECONCILE_INTERVAL_MS) return false
  _lastReconcileAt.set(sessionId, Date.now())

  const task = doReconcile(sessionId, reason)
    .catch((err) => {
      log.warn('reconcile failed (non-blocking)', { sessionId: sessionId.slice(0, 8), reason, err })
    })
    .finally(() => {
      _inFlight.delete(sessionId)
    })
  _inFlight.set(sessionId, task)
  await task
  return true
}

/**
 * lifecycle 已明确观察到终态时，主动向 Host 队列核对执行态。
 *
 * 首次查询不受常规 5 秒节流影响；若 lifecycle 比 queue finally 更早到达，首次仍
 * 返回 busy，则 1 秒后仅复查一次。这里不根据 lifecycle 自行改 busy，只有 Host
 * 明确返回 idle 才走既有 force-idle 收口，因此不会误杀长工具或新一轮执行。
 */
export function scheduleTerminalRunReconcile(sessionId: string): void {
  if (!sessionId) return

  const generation = (_terminalReconcileGeneration.get(sessionId) ?? 0) + 1
  _terminalReconcileGeneration.set(sessionId, generation)
  const previousTimer = _terminalRetryTimers.get(sessionId)
  if (previousTimer) clearTimeout(previousTimer)
  _terminalRetryTimers.delete(sessionId)

  void reconcileSessionRunState(sessionId, 'terminal-observed').finally(() => {
    if (_terminalReconcileGeneration.get(sessionId) !== generation) return
    if (!getSessionRunProjection(sessionId)?.busy) return

    const timer = setTimeout(() => {
      _terminalRetryTimers.delete(sessionId)
      if (_terminalReconcileGeneration.get(sessionId) !== generation) return
      if (!getSessionRunProjection(sessionId)?.busy) return
      void reconcileSessionRunState(sessionId, 'terminal-observed')
    }, TERMINAL_RECONCILE_RETRY_MS)
    _terminalRetryTimers.set(sessionId, timer)
  })
}

async function doReconcile(sessionId: string, reason: ReconcileReason): Promise<void> {
  const projectionAtRequest = getSessionRunProjection(sessionId)
  const reconcileIdentity = {
    runId: projectionAtRequest?.localRunId
      ?? (projectionAtRequest?.localDispatchToken
        ? null
        : projectionAtRequest?.authoritativeRunState?.run_id ?? null),
    dispatchToken: projectionAtRequest?.localDispatchToken ?? null,
  }
  const res = await window.tabtin!.agentEngine.getState({ sessionId })
  if (!isSessionRunIdentityCurrent(sessionId, reconcileIdentity)) {
    log.debug('reconcile: ignored stale runtime response for an older run', {
      sessionId: sessionId.slice(0, 8),
      reason,
    })
    return
  }
  const projection = getSessionRunProjection(sessionId)
  const projectionBusy = !!projection?.busy
  const hostedLocally = res.sessionId === sessionId

  // ：busy / idle 都必须先验本机托管。miss 时禁止 applyRunReconcile
  // 写入 runtimeBusy（会锁死服务端权威）；远控 / 旁观只走 HTTP run_state。
  if (!hostedLocally) {
    if (projectionBusy) {
      log.info('reconcile: session not hosted locally — HTTP run_state reconcile', {
        sessionId: sessionId.slice(0, 8),
        reason,
        reportedBusy: !!res.busy,
      })
      await reconcileRemoteRunStateFromHttp(sessionId, reason)
    }
    return
  }

  if (res.busy) {
    // 本机权威说在跑 / 排队 → 覆写投影（丢包兜底，runtime-mirror-override）。
    if (!projectionBusy) {
      log.warn('reconcile: runtime busy but renderer thought idle — restoring busy state', {
        sessionId: sessionId.slice(0, 8), reason,
      })
    }
    applyRunReconcile(
      sessionId,
      { busy: true, queuedRunIds: res.queuedRunIds },
      reconcileIdentity,
    )
    // ：若曾被误写 endedAt（假终态），权威仍 busy 时重新开表，避免「按钮在跑、计时已定格」。
    // updateRunStateForSession 走 batch，必须 flush 后 UI / 后续读才见 endedAt=null。
    const runState = useChatRuntimeStore.getState().runStateBySessionId[sessionId]
    if (runState?.endedAt != null) {
      useChatRuntimeStore.getState().updateRunStateForSession(sessionId, { endedAt: null })
      flushRuntimeBatch()
    }
    return
  }

  const { useChatStore } = await import('@/stores/chat/useChatStore')

  if (projectionBusy) {
    // 投影 busy 但 runtime idle = 终态信号丢失 → 单一终态收口。
    log.warn('reconcile: projection busy but runtime idle — forcing terminal cleanup', {
      sessionId: sessionId.slice(0, 8), reason, source: projection?.source,
    })
    trackChatTelemetry('run.reconcile.force_idle', { sessionId, reason }, {
      counterKey: 'run.reconcile.force_idle',
      sessionId,
      level: 'warn',
    })
    // ：权威已 idle 时先 completed-settle SendMessage waiter，再 endSessionRun。
    // 否则 busy-retain idle 钩子 dispose 会把未 settle 的 send 打成 IpcStreamAbortedError。
    const settledSend = getSessionController(sessionId).settleExecutionCompleted()
    if (settledSend) {
      log.info('reconcile: settled unsettled SendMessage waiter as completed before force_idle', {
        sessionId: sessionId.slice(0, 8), reason,
      })
    }
    const { endSessionRun } = await import('../stream/handlers/sessionCleanup')
    // status 用 'cancelled' 而非 'error'：run 在执行端已结束（可能是正常完成，
    // 只是终态信号丢失），标 error 会把 running steps 翻成错误态、写 lastError，
    // 让用户误以为「出错了」。'cancelled' 语义 =「被打断收尾」：未 finalize 的
    // 消息标「已中断」badge、steps 标 cancelled，不产生错误观感；真实内容随
    // 终态后的消息重同步（scheduleLostStreamHydrate / drain）补齐。
    // ：权威 idle 收口统一走 endSessionRun（写终态 overlay → busy=false）。
    endSessionRun({
      sessionId,
      ...reconcileIdentity,
      status: 'cancelled',
      removeStreamingSession: useChatStore.getState().removeStreamingSession,
    })
    // ：仍需 applyRunReconcile(busy:false) 把投影 queuedRunIds 对齐到
    // runtime 空队列。旧 reducer 会顺带清掉终态 overlay → busy 从 stale
    // running 复活；新 reducer 会保留/安装终态 overlay 并只清队列。
    applyRunReconcile(
      sessionId,
      { busy: false, queuedRunIds: [] },
      reconcileIdentity,
    )
    // ：对账收口不经 lifecycle.end，须补与 lifecycle 同口径的消息列表对账。
    const { scheduleLostStreamHydrate } = await import('@/services/sessionFreshness')
    scheduleLostStreamHydrate(sessionId, 'reconcile-force-idle')
  }

  // ：在线排队在 host；闲态由 run_sync 宣布。本机对账不再 drain 前端队。
}

/**
 *  方案 A：远控 / 旁观投影 busy 但本机 runtime miss 时，向服务端拉
 * `ChatSession.run_state` 收口。禁止对本机 miss 调 force_idle / applyRunReconcile
 *（避免写入 runtimeBusy 锁死服务端权威）。
 */
async function reconcileRemoteRunStateFromHttp(
  sessionId: string,
  reason: ReconcileReason,
): Promise<void> {
  try {
    const { getChatClient } = await import('@/services/chatApi')
    const session = await getChatClient().sessions.get(sessionId)
    const { useChatStore } = await import('@/stores/chat/useChatStore')
    // updateSessionInCaches → applySessionRunStateSnapshot（busy 只认 authoritative）
    useChatStore.getState().updateSessionInCaches(sessionId, {
      run_state: session.run_state ?? null,
    })

    const next = getSessionRunProjection(sessionId)
    const serverStatus = (session.run_state as ChatSessionRunState | null | undefined)?.status
    const serverStillActive = serverStatus ? isActiveRunStatus(serverStatus) : false

    trackChatTelemetry('run.reconcile.remote_http', {
      sessionId,
      reason,
      serverStatus: serverStatus ?? null,
      busyAfter: !!next?.busy,
    }, {
      counterKey: 'run.reconcile.remote_http',
      sessionId,
      level: 'info',
    })

    // 只认 HTTP 返回的权威状态。禁止用 next.busy 拦住：snapshot 若因
    // sequence/run_id 未能推进，仍应进入终态副作用，并尽量纠正投影。
    if (serverStillActive) {
      log.info('reconcile remote HTTP: server still active, keep busy', {
        sessionId: sessionId.slice(0, 8), reason, serverStatus,
      })
      return
    }

    // 投影仍 busy 但服务端已终态/空：强制推进 authoritative（抬 sequence），
    // 保证 isSessionBusy 收口，且不写 runtimeBusy。
    if (getSessionRunProjection(sessionId)?.busy) {
      const auth = getSessionRunProjection(sessionId)?.authoritativeRunState
      const terminalFromServer = session.run_state
        && isChatSessionRunState(session.run_state)
        && !isActiveRunStatus(session.run_state.status)
        ? session.run_state
        : null
      if (terminalFromServer) {
        applySessionRunStateEvent(sessionId, {
          ...terminalFromServer,
          sequence: Math.max(
            terminalFromServer.sequence,
            (auth?.sequence ?? 0) + 1,
          ),
        })
      } else if (auth && isActiveRunStatus(auth.status)) {
        applySessionRunStateEvent(sessionId, {
          ...auth,
          status: 'cancelled',
          sequence: auth.sequence + 1,
          revision: 1,
          ended_at: new Date().toISOString(),
          state_changed_at: new Date().toISOString(),
        })
      }
    }

    // 服务端已终态 / 无 run：补与本机 force_idle 同口径的副作用（不清 runtimeBusy 路径）
    log.warn('reconcile remote HTTP: server idle — terminal cleanup side effects', {
      sessionId: sessionId.slice(0, 8), reason, serverStatus,
    })
    const settledSend = getSessionController(sessionId).settleExecutionCompleted()
    if (settledSend) {
      log.info('reconcile remote HTTP: settled SendMessage waiter before cleanup', {
        sessionId: sessionId.slice(0, 8),
      })
    }
    const { endSessionRun } = await import('../stream/handlers/sessionCleanup')
    endSessionRun({
      sessionId,
      runId: next?.localRunId
        ?? (session.run_state as ChatSessionRunState | null | undefined)?.run_id
        ?? null,
      dispatchToken: next?.localDispatchToken ?? null,
      status: 'cancelled',
      removeStreamingSession: useChatStore.getState().removeStreamingSession,
    })
    const { scheduleLostStreamHydrate } = await import('@/services/sessionFreshness')
    scheduleLostStreamHydrate(sessionId, 'reconcile-remote-http')
  } catch (err) {
    log.warn('reconcile remote HTTP failed (non-blocking)', {
      sessionId: sessionId.slice(0, 8), reason, err,
    })
  }
}

// ── 周期巡检 ─────────────────────────────────────────────────────────────

let _sweepTimer: ReturnType<typeof setInterval> | null = null

function sweepTick(): void {
  const projections = useChatRuntimeStore.getState().runProjectionBySessionId ?? {}
  const staleBefore = Date.now() - SWEEP_STALE_AFTER_MS
  for (const [sessionId, entry] of Object.entries(projections)) {
    if (!entry.busy) continue
    if (entry.lastSyncAt > staleBefore) continue
    void reconcileSessionRunState(sessionId, 'sweep')
  }
}

/** 启动周期巡检（幂等）。生产由本模块底部 self-init 调；测试自行控制。 */
export function startRunProjectionSweep(): void {
  if (_sweepTimer !== null) return
  _sweepTimer = setInterval(sweepTick, SWEEP_INTERVAL_MS)
}

export function stopRunProjectionSweep(): void {
  if (_sweepTimer !== null) {
    clearInterval(_sweepTimer)
    _sweepTimer = null
  }
}

/** Test-only：手动触发一次巡检扫描。 */
export function __sweepTickForTest(): void {
  sweepTick()
}

/** Test-only：清空节流 / in-flight 登记。 */
export function __resetReconcileForTest(): void {
  _inFlight.clear()
  _lastReconcileAt.clear()
  for (const timer of _terminalRetryTimers.values()) clearTimeout(timer)
  _terminalRetryTimers.clear()
  _terminalReconcileGeneration.clear()
}

// Self-init：与 watchdog 同款三门禁（useChatRuntimeStore __isTestEnv 口径）——
// 只在真实渲染进程启动，vitest / Node test runner / storybook 均不留 interval 句柄。
const __isTestEnv =
  (typeof import.meta !== 'undefined' && import.meta?.env?.MODE === 'test')
  || (typeof process !== 'undefined' && process?.env?.VITEST === 'true')
  || (typeof process !== 'undefined' && process?.env?.NODE_ENV === 'test')
if (typeof window !== 'undefined' && !__isTestEnv) {
  startRunProjectionSweep()
}
