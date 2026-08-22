/**
 * streamSources — agentService 的常驻单源接入（无 React， 单源终态）。
 *
 * ## 渲染进程只剩一条常驻源，且不区分来源
 *
 * 来源区分与仲裁**全部收口主进程** AgentRealtime（按 `event_id` 去重、
 * seq 缺口检测发 control 帧）。渲染进程只：
 *   1. `attachStream(deps)` 挂唯一常驻源（唯一 handler + drain）；
 *   2. `watchSession(sessionId)` 告诉主进程登记这条 session 的 IPC 投递 target；
 *   3. 订阅唯一 IPC channel，把收到的 envelope 交给**枢纽的唯一分发点** `handle.dispatch`。
 *
 * `SessionStreamHub.dispatch` 对所有业务事件一视同仁地投入唯一 handler。本文件只是
 * 「订阅 IPC + 转交 dispatch」的薄壳，无来源、发起端或活跃轮判断。
 *
 * ##  busy-retain：后台 busy 会话保留终态可达性
 *
 * UI 只挂载当前会话时，切走会 detach → 旧实现立即 `unwatchSession`，主进程撕掉
 * 本地 fan-out，迟到的 lifecycle.end/error/terminated 进不了投影，侧栏蓝圈
 * 只能靠点回对账或 45s sweep。busy 会话或仍有未终态子代理时，UI detach 后改为
 * **retain**：保持 IPC target + hub + IPC listener。父轮 idle 不得拆观察，直到
 * 子代理也全部终态。遥控会话的后端观察由主进程执行路径开启。
 *
 * ##  watch 代次 / ensureLiveStreamIpc
 *
 * StrictMode / 重挂时旧 `watchSession` Promise 晚到不得补偿 `unwatch` 拆掉新 live。
 * `send()` 路径在 `query` 前必须保证 hub + onStreamEvent + watch（不能只 attachStream）。
 */

import type { IpcStreamEnvelope } from '@shared/ipc-stream'
import type { AgentStreamMessage } from '@/stores/chat/stream/handlers/streamHandlerTypes'
import {
  getSessionController,
  __registerBusyRetainResetForTest,
  __registerEnsureLiveStreamIpc,
  type SessionStreamDeps,
  type StreamSourceHandle,
} from './index'
import {
  isSessionBusy,
  onSessionRunProjectionIdle,
} from '@/stores/chat/execution/sessionRunProjection'
import { reconcileSessionRunState } from '@/stores/chat/execution/sessionRunReconcile'
import { runtimeStoreAccess } from './runtimeStoreAccess'
import { createLogger } from '@/utils/logger'

/** 常驻源接入参数——只需业务语义 deps；来源/传输细节主进程与枢纽内部处理。 */
export type ConversationStreamDeps = SessionStreamDeps

export interface ConversationStreamAccess {
  /** sharedsession: 入口当前绑定的共享卡；普通任务入口不传。 */
  shareId?: string
}

const log = createLogger('AgentStreamSources')
const WATCH_RETRY_INITIAL_MS = 1_000
const WATCH_RETRY_MAX_MS = 30_000
/** retain-only 会话定期对账；正常终态仍优先走实时流。 */
const BUSY_RETAIN_RECONCILE_MS = 30_000
/** 只告警、不清 busy：当前远端没有可安全确认 idle 的权威源。 */
const BUSY_RETAIN_OBSERVABILITY_TIMEOUT_MS = 5 * 60_000
/** send() 前等待 watch 确认的上限——超时仍继续发送，靠权威 idle settle 兜底。 */
const WATCH_CONFIRM_TIMEOUT_MS = 3_000

interface LiveAttach {
  handle: StreamSourceHandle
  unsub: (() => void) | undefined
  /** 当前 UI（useConversationStream）引用计数。 */
  uiRefs: number
  /** UI 已离开但仍 busy：保留观察意图直到投影 idle。 */
  retainedForBusy: boolean
  /** watch IPC 只有 success=true 才算确认，失败时指数退避重试。 */
  watchConfirmed: boolean
  watchInFlight: boolean
  /** ：每次发起 watch 递增；stale Promise 不得确认或拆新 live。 */
  watchGeneration: number
  watchAttempts: number
  watchRetryTimer: ReturnType<typeof setTimeout> | null
  retainStartedAt: number | null
  retainMonitorTimer: ReturnType<typeof setTimeout> | null
  retainTimeoutObserved: boolean
  /** 等待 watchConfirmed 的 resolve 队列（ensureLiveStreamIpc）。 */
  watchConfirmWaiters: Array<() => void>
  access: ConversationStreamAccess | undefined
}

function sessionHasActiveSubagentRuns(sessionId: string): boolean {
  const runs = runtimeStoreAccess.getAccess()?.get().subagentRunsBySessionId?.[sessionId] ?? []
  return runs.some((run) =>
    run.status === 'pending' || run.status === 'queued' || run.status === 'running',
  )
}

function shouldRetainSessionObservation(sessionId: string, live: LiveAttach): boolean {
  return isSessionBusy(sessionId)
    || live.handle.hasPendingRunActiveSignal()
    || sessionHasActiveSubagentRuns(sessionId)
}

const _liveAttaches = new Map<string, LiveAttach>()

function callUnwatch(sessionId: string): void {
  try {
    void Promise.resolve(window.tabtin?.agentEngine?.unwatchSession?.(sessionId)).catch((err) => {
      log.warn('unwatchSession failed (non-blocking)', {
        sessionId: sessionId.slice(0, 8),
        err,
      })
    })
  } catch (err) {
    log.warn('unwatchSession threw (non-blocking)', {
      sessionId: sessionId.slice(0, 8),
      err,
    })
  }
}

function notifyWatchConfirmed(live: LiveAttach): void {
  const waiters = live.watchConfirmWaiters
  live.watchConfirmWaiters = []
  for (const resolve of waiters) resolve()
}

function scheduleWatchRetry(sessionId: string, live: LiveAttach): void {
  if (_liveAttaches.get(sessionId) !== live || live.watchRetryTimer !== null) return
  const delay = Math.min(
    WATCH_RETRY_INITIAL_MS * (2 ** Math.max(0, live.watchAttempts - 1)),
    WATCH_RETRY_MAX_MS,
  )
  live.watchRetryTimer = setTimeout(() => {
    live.watchRetryTimer = null
    requestWatch(sessionId, live)
  }, delay)
}

function requestWatch(sessionId: string, live: LiveAttach): void {
  if (
    _liveAttaches.get(sessionId) !== live
    || live.watchConfirmed
    || live.watchInFlight
  ) {
    return
  }
  const watchSession = window.tabtin?.agentEngine?.watchSession
  if (!watchSession) {
    live.watchAttempts += 1
    log.warn('watchSession bridge unavailable; scheduling retry', {
      sessionId: sessionId.slice(0, 8),
      attempt: live.watchAttempts,
    })
    scheduleWatchRetry(sessionId, live)
    return
  }

  live.watchInFlight = true
  live.watchAttempts += 1
  live.watchGeneration += 1
  const generation = live.watchGeneration
  try {
    const watchRequest = live.access?.shareId
      ? watchSession(sessionId, { shareId: live.access.shareId })
      : watchSession(sessionId)
    void Promise.resolve(watchRequest)
      .then((result) => {
        if (_liveAttaches.get(sessionId) === live && live.watchGeneration === generation) {
          live.watchInFlight = false
        }
        const current = _liveAttaches.get(sessionId)
        // ：旧 live 的 watch 晚到时——
        // - 若已有新 live：禁止补偿 unwatch（否则拆掉新 watcher，事件全丢）
        // - 仅当 session 上已无任何 live 时才补偿 unwatch（真正的 teardown 竞态）
        if (current !== live) {
          if (result?.success && current == null) callUnwatch(sessionId)
          return
        }
        if (generation !== live.watchGeneration) return
        if (result?.success) {
          live.watchConfirmed = true
          live.watchAttempts = 0
          notifyWatchConfirmed(live)
          return
        }
        log.warn('watchSession was not accepted; scheduling retry', {
          sessionId: sessionId.slice(0, 8),
          attempt: live.watchAttempts,
        })
        scheduleWatchRetry(sessionId, live)
      })
      .catch((err) => {
        if (_liveAttaches.get(sessionId) === live && live.watchGeneration === generation) {
          live.watchInFlight = false
        }
        if (_liveAttaches.get(sessionId) !== live) return
        if (generation !== live.watchGeneration) return
        log.warn('watchSession failed; scheduling retry', {
          sessionId: sessionId.slice(0, 8),
          attempt: live.watchAttempts,
          err,
        })
        scheduleWatchRetry(sessionId, live)
      })
  } catch (err) {
    live.watchInFlight = false
    log.warn('watchSession threw; scheduling retry', {
      sessionId: sessionId.slice(0, 8),
      attempt: live.watchAttempts,
      err,
    })
    scheduleWatchRetry(sessionId, live)
  }
}

function createLiveAttach(
  sessionId: string,
  deps: ConversationStreamDeps,
  existingHandle?: StreamSourceHandle,
  access?: ConversationStreamAccess,
): LiveAttach {
  // 优先使用调用方（同模块 SessionController）已建好的 handle，避免
  // 动态 import 下 index 双实例时 hub 建在错误的 _streamHubs 上。
  const handle = existingHandle ?? getSessionController(sessionId).attachStream(deps)
  const unsub = window.tabtin?.agentEngine?.onStreamEvent?.(
    (data) => handle.dispatch(data as unknown as IpcStreamEnvelope<AgentStreamMessage>),
  )
  const live: LiveAttach = {
    handle,
    unsub,
    uiRefs: 0,
    retainedForBusy: false,
    watchConfirmed: false,
    watchInFlight: false,
    watchGeneration: 0,
    watchAttempts: 0,
    watchRetryTimer: null,
    retainStartedAt: null,
    retainMonitorTimer: null,
    retainTimeoutObserved: false,
    watchConfirmWaiters: [],
    access,
  }
  _liveAttaches.set(sessionId, live)
  return live
}

function ensureIpcListener(sessionId: string, live: LiveAttach): void {
  if (live.unsub) return
  live.unsub = window.tabtin?.agentEngine?.onStreamEvent?.(
    (data) => live.handle.dispatch(data as unknown as IpcStreamEnvelope<AgentStreamMessage>),
  )
  if (!live.unsub) {
    log.warn('onStreamEvent bridge unavailable while ensuring live IPC', {
      sessionId: sessionId.slice(0, 8),
    })
  }
}

function waitForWatchConfirmed(sessionId: string, live: LiveAttach, timeoutMs: number): Promise<void> {
  if (_liveAttaches.get(sessionId) !== live) return Promise.resolve()
  if (live.watchConfirmed) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const idx = live.watchConfirmWaiters.indexOf(onConfirm)
      if (idx >= 0) live.watchConfirmWaiters.splice(idx, 1)
      log.warn('watchSession confirm timed out; proceeding with send', {
        sessionId: sessionId.slice(0, 8),
        timeoutMs,
      })
      resolve()
    }, timeoutMs)
    const onConfirm = () => {
      clearTimeout(timer)
      resolve()
    }
    live.watchConfirmWaiters.push(onConfirm)
  })
}

function teardownLiveAttach(sessionId: string, detachHandle = true): void {
  const live = _liveAttaches.get(sessionId)
  if (!live) return
  if (live.watchRetryTimer !== null) clearTimeout(live.watchRetryTimer)
  if (live.retainMonitorTimer !== null) clearTimeout(live.retainMonitorTimer)
  live.watchGeneration += 1
  notifyWatchConfirmed(live)
  live.unsub?.()
  // pending/confirmed 均发 unwatch：若无新 live，stale watch success 才会再补偿。
  callUnwatch(sessionId)
  if (detachHandle) live.handle.detach()
  _liveAttaches.delete(sessionId)
}

function stopBusyRetainMonitor(live: LiveAttach): void {
  if (live.retainMonitorTimer !== null) clearTimeout(live.retainMonitorTimer)
  live.retainMonitorTimer = null
  live.retainStartedAt = null
  live.retainTimeoutObserved = false
}

function reconcileRetainedSession(sessionId: string, live: LiveAttach): void {
  const access = runtimeStoreAccess.getAccess()
  void Promise.all([
    reconcileSessionRunState(sessionId, 'busy-retain'),
    access?.reconcileSubagentRunsFromArchive(sessionId) ?? Promise.resolve(),
  ]).finally(() => {
    if (_liveAttaches.get(sessionId) !== live) return
    releaseBusySessionRetain(sessionId)
  })
}

function scheduleBusyRetainMonitor(sessionId: string, live: LiveAttach): void {
  if (
    _liveAttaches.get(sessionId) !== live
    || !live.retainedForBusy
    || live.uiRefs > 0
    || live.retainMonitorTimer !== null
  ) {
    return
  }
  live.retainMonitorTimer = setTimeout(() => {
    live.retainMonitorTimer = null
    if (
      _liveAttaches.get(sessionId) !== live
      || !live.retainedForBusy
      || live.uiRefs > 0
    ) {
      return
    }

    const retainedFor = Date.now() - (live.retainStartedAt ?? Date.now())
    if (
      retainedFor >= BUSY_RETAIN_OBSERVABILITY_TIMEOUT_MS
      && !live.retainTimeoutObserved
    ) {
      live.retainTimeoutObserved = true
      // 不能把“超时”当成“远端 idle”；日志进入诊断包，明确当前仍在等权威终态。
      log.warn('busy-retain exceeded observability timeout; keeping busy until authoritative terminal', {
        sessionId: sessionId.slice(0, 8),
        retainedForMs: retainedFor,
        watchConfirmed: live.watchConfirmed,
      })
    }

    reconcileRetainedSession(sessionId, live)
    scheduleBusyRetainMonitor(sessionId, live)
  }, BUSY_RETAIN_RECONCILE_MS)
}

function enterBusyRetain(sessionId: string, live: LiveAttach): void {
  live.retainedForBusy = true
  live.retainStartedAt ??= Date.now()
  // 本机权威即时对账；遥控 miss 明确保持 busy，不会误清。
  reconcileRetainedSession(sessionId, live)
  scheduleBusyRetainMonitor(sessionId, live)
}

/**
 * 投影 busy→idle 后释放 retain-only 观察（无 UI 引用才拆）。
 * 由 sessionRunProjection 的 idle 钩子调用；也可测试直接调。
 */
export function releaseBusySessionRetain(sessionId: string): void {
  const live = _liveAttaches.get(sessionId)
  if (!live?.retainedForBusy) return
  if (live.uiRefs > 0) return
  if (shouldRetainSessionObservation(sessionId, live)) return
  teardownLiveAttach(sessionId)
}

/**
 * Test-only：清空 busy-retain 登记。
 * @param detachHandles 为 true（默认）时顺带 detach hub；由 `__resetStreamHubsForTest`
 *   回调时传 false——hub 已在那边 dispose，避免双重 dispose。
 */
export function __resetBusyRetainForTest(detachHandles = true): void {
  for (const sessionId of [..._liveAttaches.keys()]) {
    teardownLiveAttach(sessionId, detachHandles)
  }
  resetIdleListener()
}

/** Test-only：是否仍因 busy 保留观察。 */
export function __isBusyRetainedForTest(sessionId: string): boolean {
  const live = _liveAttaches.get(sessionId)
  return !!live?.retainedForBusy && live.uiRefs === 0
}

/** Test-only：遥控 retain 超时是否已进入可观测降级态。 */
export function __isBusyRetainTimeoutObservedForTest(sessionId: string): boolean {
  return !!_liveAttaches.get(sessionId)?.retainTimeoutObserved
}

/** Test-only：当前 live 的 watch 代次（竞态单测用）。 */
export function __getWatchGenerationForTest(sessionId: string): number {
  return _liveAttaches.get(sessionId)?.watchGeneration ?? -1
}

/** Test-only：当前 session 是否已 watchConfirmed。 */
export function __isWatchConfirmedForTest(sessionId: string): boolean {
  return !!_liveAttaches.get(sessionId)?.watchConfirmed
}

/**
 * ：保证该 session 已有 hub + IPC listener + 已发起（并尽量确认）IPC target。
 * 供 `SessionController.send` 在 `query` 前调用——修复「有 hub、无 IPC / 无 watcher」。
 * 不增减 uiRefs；UI 侧仍由 `attachMainStream` / `useConversationStream` 管理引用。
 *
 * @param existingHandle 调用方已在**同一模块实例**上 `attachStream` 得到的 handle；
 *   传入可避免动态 import 导致的双 `_streamHubs` 漂移。
 */
/**
 * 确保 IPC onStreamEvent + IPC target 已挂（不增减 uiRefs）。
 * send() 在 query 前 await；gateway / 注入路径可 fire-and-forget。
 *
 * - 已有 live：幂等重申 watcher（修僵尸 confirmed）+ 等待确认
 * - 无 live：补建 IPC（send-path recovery / HMR dispose）
 */
export async function ensureLiveStreamIpc(
  sessionId: string,
  deps?: ConversationStreamDeps,
  existingHandle?: StreamSourceHandle,
): Promise<void> {
  let live = _liveAttaches.get(sessionId)
  if (!live) {
    if (!deps) return
    live = createLiveAttach(sessionId, deps, existingHandle)
    if (!existingHandle) {
      live.retainedForBusy = true
      live.retainStartedAt = Date.now()
      scheduleBusyRetainMonitor(sessionId, live)
      log.warn('ensureLiveStreamIpc: re-attached IPC after missing live attach (send-path recovery)', {
        sessionId: sessionId.slice(0, 8),
      })
    }
    requestWatch(sessionId, live)
  } else {
    live.retainedForBusy = false
    stopBusyRetainMonitor(live)
    if (existingHandle && live.handle !== existingHandle) {
      live.unsub?.()
      live.handle = existingHandle
      live.unsub = undefined
    }
    ensureIpcListener(sessionId, live)
    // 每次发送幂等重申 watcher，修复「renderer confirmed、主进程已无 target」
    live.watchConfirmed = false
    requestWatch(sessionId, live)
  }
  await waitForWatchConfirmed(sessionId, live, WATCH_CONFIRM_TIMEOUT_MS)
}

/**
 * 接入会话的常驻单源：挂枢纽常驻源 + 声明 IPC 投递意图 + 订阅唯一 IPC channel，
 * 收到的 envelope 一律转交 `handle.dispatch`。
 *
 * detach 时若投影仍 busy → 进入 busy-retain（不 unwatch），保证后台终态可达。
 */
export function attachMainStream(
  sessionId: string,
  deps: ConversationStreamDeps,
  access?: ConversationStreamAccess,
): () => void {
  let live = _liveAttaches.get(sessionId)
  if (!live) {
    live = createLiveAttach(sessionId, deps, undefined, access)
    // 先登记 live + IPC listener，再发 watch；拒绝/异常不会留下“假 watcher”。
    requestWatch(sessionId, live)
  } else {
    // 从 busy-retain / send-path recovery 切回 UI：复用既有 hub / watch / IPC listener
    live.retainedForBusy = false
    stopBusyRetainMonitor(live)
    ensureIpcListener(sessionId, live)
    requestWatch(sessionId, live)
  }
  live.uiRefs += 1

  return () => {
    const current = _liveAttaches.get(sessionId)
    if (!current) return
    current.uiRefs = Math.max(0, current.uiRefs - 1)
    if (current.uiRefs > 0) return

    // ：后台仍 busy → 保留终态可达性，不撕 watch / hub
    if (!access?.shareId && shouldRetainSessionObservation(sessionId, current)) {
      enterBusyRetain(sessionId, current)
      return
    }
    teardownLiveAttach(sessionId)
  }
}

let _removeIdleListener: (() => void) | null = null

function installIdleListener(): void {
  if (_removeIdleListener) return
  _removeIdleListener = onSessionRunProjectionIdle((sessionId) => {
    const access = runtimeStoreAccess.getAccess()
    void (access?.reconcileSubagentRunsFromArchive(sessionId) ?? Promise.resolve()).finally(() => {
      releaseBusySessionRetain(sessionId)
    })
  })
}

function resetIdleListener(): void {
  _removeIdleListener?.()
  _removeIdleListener = null
  installIdleListener()
}

/** HMR/module dispose：释放 listener 与全部 watcher，不重装。 */
function disposeStreamSources(): void {
  for (const sessionId of [..._liveAttaches.keys()]) {
    teardownLiveAttach(sessionId)
  }
  _removeIdleListener?.()
  _removeIdleListener = null
}

// 投影 idle 时自动释放 retain-only 观察（模块加载即登记；测试环境同样需要）。
installIdleListener()

// 与 `__resetStreamHubsForTest` 同步，避免测试里 hub 清空后仍复用僵死 live attach。
__registerBusyRetainResetForTest(() => {
  __resetBusyRetainForTest(false)
})
__registerEnsureLiveStreamIpc(ensureLiveStreamIpc)

if (import.meta.hot) {
  import.meta.hot.dispose(disposeStreamSources)
}
