/**
 * agentService — 对话 IPC/WS 的统一收口枢纽（ · ）。
 *
 * 一条 session 只有一条逻辑事件流。主进程负责物理传输与 event_id 去重；renderer
 * 只订阅一个 IPC channel，并把所有业务事件无条件投入唯一 handler。
 *
 * 对外唯一入口是 `getSessionController(sessionId)`：一条会话的所有出入站操作都是它的
 * 方法（`abort()` / `send()` / `attachStream()` / `submitApproval()` …）。对外接口
 * 只有操作语义，**不区分 local / remote**——传输路由（本机 runtime vs 后端网关）
 * 是 hub 内部决策（`resolveSendRoute`），与 abort 的「IPC 快路径 → WS 兜底」同精神。
 *
 * ### 出站：操作 → IPC vs WS
 * 用户操作此前各自决策「打本机 IPC 还是走后端 WS」，abort 曾只打本机导致遥控 run
 * 停不掉。`SessionController.abort()` 收口：先试本机 IPC 快路径，miss → 后端 WS
 * `chat.cancel` 兜底（Django forward 到真执行设备 + durable cancel marker）。
 *
 * `SessionController.send()` 对本机 runtime 只等待 host **accepted ACK**；
 * 整轮终态由常驻 hub 消化，busy / 排队镜像 `run_sync`。消息同步按消息身份与落库状态合并。
 */

import { getChatClient } from '../chatApi'
import {
  getLocalAgentClient,
  isLocalRuntimeAvailable,
  type LocalAgentStreamOptions,
  type LocalAgentStreamResult,
} from '../localAgentClient'
import { resolveExecutionTargetLocation, type SessionExecutionTarget } from '../remoteExecutionGuard'
import { cancelActiveRunForSession } from '../chatExtraApi'
import {
  IpcStreamStallError,
  IpcStreamRemoteError,
  IpcStreamAbortedError,
  isControlEnvelope,
  type IpcStreamEnvelope,
} from '@shared/ipc-stream'
import { isAgentStreamEvent } from '@tabtin/ws-gateway-client'
import { streamControlPorts } from './streamControlPorts'
import { createLogger } from '@/utils/logger'
//  阶段B：仅取类型（编译期擦除，无运行时 service→store 依赖）；handler 工厂
// 经 runtimeStoreAccess 由 store 侧注入，见 buildStreamHandlerDeps / attachStream。
import type {
  AgentStreamMessage,
  StreamHandlerDeps,
} from '@/stores/chat/stream/handlers/streamHandlerTypes'
import type { ChatClient, ChatSession } from '@tabtin/chat-client'
import type { ChatSessionTokenUsage } from '@/utils/chatSessionTokenUsage'
import { runtimeStoreAccess } from './runtimeStoreAccess'
import { getSessionMessagesFacade, type SessionMessagesFacade } from './sessionMessages'
import { rollbackRegistry, type RollbackActions } from './rollbackRegistry'
import {
  InboundEventDrain,
  INBOUND_DRAIN_MAX_PER_SLICE,
  INBOUND_DRAIN_MAX_PER_SLICE_DURING_HITL,
  isHighPriorityInboundMessage,
} from './inboundEventDrain'
import { getHitlStoreAccess } from '@stores/chat/shared/storeAccessRegistry'

const log = createLogger('ConversationExecution')

// ─── 入站流枢纽：模块级状态（ /  单源终态）──────────────────────
//
// 来源区分与仲裁**全部收口主进程**（AgentRealtime：本机在跑→WS 镜像丢弃、
// seq 缺口检测→control 帧）。渲染进程只剩**一条常驻源**：`streamSources.attachMainStream`
// 订阅唯一 IPC channel `agent-engine:stream-event`，收到的就是仲裁完的单一事件流，
// **不区分来源**、无 owner 仲裁。
//
// `send()` 只等待该 session 的统一执行终态；等待器不参与事件路由、不持有 UI callback，
// 因而不存在「主动轮 / 观察端」分支。所有事件无条件进入同一个 handler。

const EXECUTION_IDLE_WATCHDOG_MS = 30_000
/** probe 连续 unknown 的最大续期次数；超过后按真 stall 收口，避免无桥接时挂死。 */
const EXECUTION_UNKNOWN_PROBE_MAX_RENEWALS = 2
/**
 * probe 连续 busy 的最大续期次数。
 * 默认 idle=30s → 约 5 分钟；防止 demux 错配时 UI 无限挂起。
 */
const EXECUTION_BUSY_PROBE_MAX_RENEWALS = 10

/** Runtime 忙闲探测结果（ IPC watchdog）。 */
export type ExecutionRuntimeProbeResult = 'busy' | 'idle' | 'unknown'

/**
 * SessionExecutionWaiter 的可注入钩子——默认走 `agentEngine.getState` / abort；
 * 测试可替换，避免无差别改写其它 openIpcStream 的 30s 语义。
 */
export interface ExecutionWatchdogHooks {
  probeRuntime?: (
    sessionId: string,
  ) => Promise<ExecutionRuntimeProbeResult> | ExecutionRuntimeProbeResult
  onConfirmedStall?: (sessionId: string, idleMs: number) => void
  /** 测试用：覆盖 idle 间隔（生产默认 30s）。 */
  idleMs?: number
  /** 测试用：覆盖 busy 续期上限（生产默认 10）。 */
  busyProbeMaxRenewals?: number
}

let _executionWatchdogHooks: ExecutionWatchdogHooks = {}

/** Test-only：注入 Runtime probe / stall cancel / idleMs。 */
export function __setExecutionWatchdogHooksForTest(hooks: ExecutionWatchdogHooks): void {
  _executionWatchdogHooks = hooks
}

/** Test-only：恢复默认钩子。 */
export function __resetExecutionWatchdogHooksForTest(): void {
  _executionWatchdogHooks = {}
}

function normalizeHubSessionId(id: string): string {
  return id.startsWith('chat-session-') && id.length > 'chat-session-'.length
    ? id.slice('chat-session-'.length)
    : id
}

/** 常驻 hub demux：兼容 chat-session- 前缀；prompt_* 永不命中。 */
function envelopeMatchesSession(envelopeSessionId: string, hubSessionId: string): boolean {
  if (envelopeSessionId === hubSessionId) return true
  if (envelopeSessionId.startsWith('prompt_') || hubSessionId.startsWith('prompt_')) return false
  return normalizeHubSessionId(envelopeSessionId) === normalizeHubSessionId(hubSessionId)
}

async function defaultProbeRuntime(sessionId: string): Promise<ExecutionRuntimeProbeResult> {
  const getState = window.tabtin?.agentEngine?.getState
  if (typeof getState !== 'function') return 'unknown'
  try {
    const state = await Promise.resolve(getState({ sessionId }))
    if (!state || typeof state !== 'object') return 'unknown'
    // sessionId=null 表示本机未托管（遥控 / 未登记）——不能当 idle 误杀。
    if (state.sessionId == null && state.busy !== true) return 'unknown'
    return state.busy ? 'busy' : 'idle'
  } catch {
    return 'unknown'
  }
}

function defaultCancelOnStall(sessionId: string, idleMs: number): void {
  log.error('execution idle watchdog confirmed stall; cancelling runtime', {
    sessionId: sessionId.slice(0, 8),
    idleMs,
  })
  const abortRun = window.tabtin?.agentEngine?.abortRun
  if (typeof abortRun === 'function') {
    void Promise.resolve(abortRun(sessionId)).catch((err) => {
      log.warn('stall cancel via abortRun failed (non-blocking)', {
        sessionId: sessionId.slice(0, 8),
        err,
      })
    })
    return
  }
  const abort = window.tabtin?.agentEngine?.abort
  if (typeof abort === 'function') {
    void Promise.resolve(abort({ sessionId })).catch(() => undefined)
  }
}

/**
 * watchdog 发现 runtime 已 idle、hub 尚无 terminal：先收口投影，再延迟 hydrate。
 */
function scheduleWatchdogIdleMessageReconcile(sessionId: string): void {
  void (async () => {
    try {
      const { useChatStore } = await import('@/stores/chat/useChatStore')
      const { endSessionRun } = await import('@/stores/chat/stream/handlers/sessionCleanup')
      endSessionRun({
        sessionId,
        status: 'done',
        removeStreamingSession: useChatStore.getState().removeStreamingSession,
      })
      const { scheduleLostStreamHydrate } = await import('@/services/sessionFreshness')
      scheduleLostStreamHydrate(sessionId, 'watchdog-idle-settle')
    } catch (err) {
      log.warn('watchdog idle settle reconcile failed (non-blocking)', {
        sessionId: sessionId.slice(0, 8),
        err,
      })
    }
  })()
}

/**
 * send() 等待统一执行终态。
 *
 * ：保留 probe 型 idle watchdog 作真挂死保险丝——
 * - runtime idle → completed settle + hydrate（假失败）
 * - busy/unknown 续期耗尽 → StallError + cancel（真挂死）
 * 另：query ACK 后若仍无终态，立即 settle（不必再空等 30s）。
 */
class SessionExecutionWaiter {
  private settled = false
  private watchdog: ReturnType<typeof setTimeout> | null = null
  private unknownProbeRenewals = 0
  private busyProbeRenewals = 0
  private probeGeneration = 0
  readonly done: Promise<LocalAgentStreamResult>
  private resolveDone!: (result: LocalAgentStreamResult) => void
  private rejectDone!: (error: Error) => void

  constructor(
    private readonly sessionId: string,
    private readonly onSettle: () => void,
  ) {
    this.done = new Promise<LocalAgentStreamResult>((resolve, reject) => {
      this.resolveDone = resolve
      this.rejectDone = reject
    })
    // ：send() 尚未 await 时若 dispose/fail 抢先 settle，避免裸 unhandledrejection。
    // 后续 await 仍能读到同一终态（resolve/reject 语义不变）。
    void this.done.catch(() => undefined)
    this.touch()
  }

  get isSettled(): boolean {
    return this.settled
  }

  touch(): void {
    if (this.settled) return
    this.probeGeneration += 1
    if (this.watchdog) clearTimeout(this.watchdog)
    const idleMs = _executionWatchdogHooks.idleMs ?? EXECUTION_IDLE_WATCHDOG_MS
    this.watchdog = setTimeout(() => {
      void this.onWatchdogFired(idleMs)
    }, idleMs)
  }

  private async onWatchdogFired(idleMs: number): Promise<void> {
    if (this.settled) return
    const generation = this.probeGeneration
    const probe = _executionWatchdogHooks.probeRuntime ?? defaultProbeRuntime
    let result: ExecutionRuntimeProbeResult
    try {
      result = await probe(this.sessionId)
    } catch {
      result = 'unknown'
    }
    // touch / 终态可能在 await 期间发生——旧 generation 直接丢弃。
    if (this.settled || generation !== this.probeGeneration) return

    if (result === 'busy') {
      this.unknownProbeRenewals = 0
      this.busyProbeRenewals += 1
      const busyMax =
        _executionWatchdogHooks.busyProbeMaxRenewals ?? EXECUTION_BUSY_PROBE_MAX_RENEWALS
      if (this.busyProbeRenewals <= busyMax) {
        log.warn('execution idle watchdog deferred: runtime still busy', {
          sessionId: this.sessionId.slice(0, 8),
          idleMs,
          renewals: this.busyProbeRenewals,
          maxRenewals: busyMax,
        })
        this.touch()
        return
      }
      log.error('execution idle watchdog busy renewals exhausted; treating as stall', {
        sessionId: this.sessionId.slice(0, 8),
        idleMs,
        renewals: this.busyProbeRenewals,
        maxRenewals: busyMax,
      })
    } else if (result === 'unknown') {
      this.unknownProbeRenewals += 1
      if (this.unknownProbeRenewals <= EXECUTION_UNKNOWN_PROBE_MAX_RENEWALS) {
        log.warn('execution idle watchdog deferred: runtime probe unknown', {
          sessionId: this.sessionId.slice(0, 8),
          idleMs,
          renewals: this.unknownProbeRenewals,
        })
        this.touch()
        return
      }
    } else if (result === 'idle') {
      // 停在对话页常见路径：流/IPC 事件丢失但 runtime 已 idle（Agent 多半已落库）。
      // 按 completed settle + 补消息对账；禁止 StallError（误报发送失败并 abort 已结束 run）。
      // 真 stall 只留给 busy/unknown 续期耗尽。
      log.warn('execution idle watchdog: runtime idle without stream terminal — settling completed', {
        sessionId: this.sessionId.slice(0, 8),
        idleMs,
      })
      this.resolveCompleted()
      scheduleWatchdogIdleMessageReconcile(this.sessionId)
      return
    }

    const onStall = _executionWatchdogHooks.onConfirmedStall ?? defaultCancelOnStall
    try {
      onStall(this.sessionId, idleMs)
    } catch {
      /* cancel best effort */
    }
    this.fail(new IpcStreamStallError(this.sessionId, idleMs))
  }

  observeEvent(event: AgentStreamMessage): void {
    if (this.settled) return
    this.unknownProbeRenewals = 0
    this.busyProbeRenewals = 0
    this.touch()
    if (event.type !== 'agent.stream.lifecycle') return
    const phase = (event.payload as { phase?: string } | undefined)?.phase
    if (phase === 'end' || phase === 'error' || phase === 'terminated') this.resolve()
  }

  observeTerminal(terminal: { reason: 'completed' | 'errored' | 'aborted'; error?: string }): void {
    if (this.settled) return
    if (terminal.reason === 'errored') {
      this.fail(new IpcStreamRemoteError(this.sessionId, terminal.error ?? 'remote stream error'))
    } else if (terminal.reason === 'aborted') {
      this.fail(new IpcStreamAbortedError(this.sessionId))
    } else {
      this.resolve()
    }
  }

  /**
   *  / ：对账 / ACK / idle watchdog 确认成功时，按 completed 收口 send()，
   * 避免随后 busy-retain dispose 打成 IpcStreamAbortedError。
   */
  resolveCompleted(): void {
    this.resolve()
  }

  fail(error: Error): void {
    if (this.settled) return
    this.settled = true
    this.clearWatchdog()
    this.onSettle()
    this.rejectDone(error)
  }

  private resolve(): void {
    if (this.settled) return
    this.settled = true
    this.clearWatchdog()
    this.onSettle()
    this.resolveDone({ session_id: this.sessionId, thread_id: `chat-session-${this.sessionId}` })
  }

  private clearWatchdog(): void {
    this.probeGeneration += 1
    if (!this.watchdog) return
    clearTimeout(this.watchdog)
    this.watchdog = null
  }
}

/**
 * 单个 session 的入站流枢纽：唯一 handler + drain（ 单源终态）。
 *
 * 只承载唯一 handler、分片 drain 与执行终态等待器。
 */
/** push-notification 唤起的 user 事件触发子 Agent 对账。 */
function isPushNotificationUserEvent(event: AgentStreamMessage): boolean {
  if (event.type !== 'agent.stream.user') return false
  const payload = (event.payload ?? {}) as Record<string, unknown>
  return payload.triggered_by === 'push-notification'
}

/**
 * 这些事件会让统一 run projection 进入 busy。它们先入 InboundEventDrain、后写
 * projection，因此 hub 必须同步记录“busy 信号已入站但尚未 reduce”的窗口。
 */
function isPendingRunActiveSignal(event: AgentStreamMessage): boolean {
  if (event.type === 'agent.stream.lifecycle') {
    return (event.payload as { phase?: unknown } | undefined)?.phase === 'start'
  }
  return event.type === 'agent.stream.message_start'
    || event.type === 'agent.stream.message_queued'
    || event.type === 'agent.stream.message_dequeued'
}

class SessionStreamHub {
  /** 唯一 handler：所有事件无条件进入，去重在其内部（event_id/arrival_seq）。 */
  readonly handler: (message: AgentStreamMessage) => void
  /** ：入站分片 drain。高频事件先入队再按帧喂 handler，避免打穿主线程。 */
  readonly drain: InboundEventDrain
  private executionWaiter: SessionExecutionWaiter | null = null
  private pendingRunActiveSignals = 0
  /** dispose 重入门闩：flush 期间 handler→detach 可能再进 dispose。 */
  private disposing = false

  constructor(
    private readonly sessionId: string,
    private readonly handlerDeps: StreamHandlerDeps,
  ) {
    this.handler = runtimeStoreAccess.requireStreamHandlerFactory()(handlerDeps)
    this.drain = new InboundEventDrain(
      (message) => {
        try {
          // ：先 settle 执行等待器，再跑 handler。
          // handler 内 lifecycle.end → cleanup → busy-retain release → dispose 会同步拆 hub；
          // 若 observe 在后，成功终态会被 dispose 误判成 IpcStreamAbortedError。
          this.executionWaiter?.observeEvent(message)
          this.handler(message)
        } finally {
          if (isPendingRunActiveSignal(message)) {
            this.pendingRunActiveSignals = Math.max(0, this.pendingRunActiveSignals - 1)
          }
        }
      },
      {
        isHighPriority: isHighPriorityInboundMessage,
        getMaxPerSlice: () => {
          // 只为 HITL 期间收窄 drain 每帧预算而读 pending 状态；走中立 leaf
          // getHitlStoreAccess()，避免 agentService 顶部静态 import useChatStore
          // 形成 store↔service 循环依赖（ 阶段0）。register 未就绪时降级为普通预算。
          const hitl = getHitlStoreAccess()?.getState()
          if (
            hitl?.pendingApprovalBySessionId[this.sessionId] ||
            hitl?.pendingAskUserBySessionId[this.sessionId]
          ) {
            return INBOUND_DRAIN_MAX_PER_SLICE_DURING_HITL
          }
          return INBOUND_DRAIN_MAX_PER_SLICE
        },
      },
    )
  }

  /** 把一条事件投入统一 handler（去重 + 分发 + 分片 drain）。 */
  ingest(message: AgentStreamMessage): void {
    this.drain.enqueue(message)
  }

  /** 常驻单源的唯一分发点：不判断来源或发起端，所有业务事件进入同一 handler。 */
  dispatch(envelope: IpcStreamEnvelope<AgentStreamMessage>): void {
    const sessionId = this.sessionId
    // 兼容误带 chat-session- 前缀的 envelope；prompt_* 永不匹配常驻 hub。
    if (!envelopeMatchesSession(envelope.sessionId, sessionId)) return

    // 控制帧：主进程检测到 WS seq 缺口 → 安排一次补拉（busy defer 在执行侧）。
    if (isControlEnvelope(envelope)) {
      if (envelope.control === 'seq-gap') streamControlPorts.get()?.handleSeqGapControl(sessionId)
      return
    }

    if (envelope.terminal) {
      // 确保终态业务事件先完成 handler 写入，再结束 send() 的等待。
      this.drain.flushSync()
      // ：lifecycle cleanup 把 endedAt 写进 rAF pending；不先 flush 会读到旧快照，
      // 误以为未停表，再用 phase:'cancelled' 盖掉 lifecycle 已写的 phase:'done'。
      // hub 不能静态 import sessionCleanup / useChatRuntimeStore（反向依赖），经 leaf flush。
      runtimeStoreAccess.getAccess()?.flushRuntimeBatch()
      const runState = this.handlerDeps.get().runStateBySessionId?.[sessionId]
      if (runState?.startedAt != null && runState.endedAt == null) {
        const phase =
          envelope.terminal.reason === 'completed'
            ? 'done'
            : envelope.terminal.reason === 'errored'
              ? 'error'
              : 'cancelled'
        this.handlerDeps.get().updateRunStateForSession(sessionId, {
          phase,
          endedAt: Date.now(),
        })
      }
      // ：先 settle waiter，再 removeStreamingSession。
      // 后者可能经 busy-retain idle → detach → dispose；若 settle 在后会被误 abort。
      this.executionWaiter?.observeTerminal(envelope.terminal)
      this.handlerDeps.removeStreamingSession(sessionId, { clearSeqGapSync: true })
      return
    }
    if (envelope.heartbeat) {
      this.executionWaiter?.touch()
      return
    }
    if (!envelope.event) return
    const event = envelope.event
    if (!isAgentStreamEvent(event.type)) return

    if (isPendingRunActiveSignal(event)) this.pendingRunActiveSignals += 1
    this.drain.enqueue(event)

    if (isPushNotificationUserEvent(event)) {
      void runtimeStoreAccess.getAccess()?.reconcileSubagentRunsFromArchive(sessionId, {
        spaceId: this.handlerDeps.spaceId,
      })
    }
  }

  hasPendingRunActiveSignal(): boolean {
    return this.pendingRunActiveSignals > 0
  }

  /**
   * @deprecated  主发送路径只等 IPC ACK，不再 await 整轮。
   * 仅保留给 Tin / 显式 waiter / reconcile settle；禁止新主路径挂接。
   */
  waitForExecution(): SessionExecutionWaiter {
    this.executionWaiter?.fail(new IpcStreamAbortedError(this.sessionId))
    const waiter = new SessionExecutionWaiter(this.sessionId, () => {
      if (this.executionWaiter === waiter) this.executionWaiter = null
    })
    this.executionWaiter = waiter
    return waiter
  }

  hasUnsettledExecutionWaiter(): boolean {
    return !!this.executionWaiter && !this.executionWaiter.isSettled
  }

  /**
   *  / ：对账 / ACK / idle watchdog 按 completed 收口 send waiter。
   * 唯一 settle API；无 waiter 或已 settle 时 no-op。
   */
  settleExecutionCompleted(): boolean {
    const waiter = this.executionWaiter
    if (!waiter || waiter.isSettled) return false
    waiter.resolveCompleted()
    return true
  }

  dispose(): void {
    if (this.disposing) return
    this.disposing = true
    // ：先排空 drain，让队列里已有的 lifecycle.end 有机会 settle waiter；
    // 再对仍未 settle 的 waiter abort。旧序是先 abort 再 flush，会把「终态已在队列」
    // 的成功轮误报成 IpcStreamAbortedError（ 只覆盖正在 process 的路径）。
    this.drain.dispose()
    // ：拆管道 ≠ 用户取消。waiter 已 settle 则不动；
    // 仅未 settle 的强制拆除（clearStreamHub / 中途 teardown）才 abort。
    const waiter = this.executionWaiter
    this.executionWaiter = null
    if (waiter && !waiter.isSettled) {
      waiter.fail(new IpcStreamAbortedError(this.sessionId))
    }
  }
}

/** 当前 session 是否仍有未 settle 的 send 等待器。 */
export function hasUnsettledExecutionWaiter(sessionId: string): boolean {
  return !!_streamHubs.get(sessionId)?.hasUnsettledExecutionWaiter()
}

const _streamHubs = new Map<string, SessionStreamHub>()

/** 会话上下文（会变，用 getter 拿最新，避免重订阅）。 */
export interface ConversationStreamContext {
  spaceId?: string
  spaceName?: string
  sessionTitle?: string
}

/**
 * 接入一条来源时应用层需提供的**业务语义 deps**——不含任何 IPC / handler 细节。
 *
 * `get`/`set`（绑定运行时 store）、client cast、handler 构造等是 hub 内部知识，由
 * `buildStreamHandlerDeps` 在 hub 内填充；应用层只给上下文 getter + store 回调。
 */
export interface SessionStreamDeps {
  getContext: () => ConversationStreamContext
  client: { sessions: { get: (id: string) => Promise<ChatSession> } }
  addStreamingSession: (sessionId: string, runId?: string | null) => void
  removeStreamingSession: (
    sessionId: string,
    options?: {
      clearSeqGapSync?: boolean
      runId?: string | null
      dispatchToken?: string | null
    },
  ) => void
  updateSessionTokenUsageInCaches: (sessionId: string, usage: ChatSessionTokenUsage) => void
  updateSessionInCaches: (sessionId: string, patch: Partial<ChatSession>) => void
  onLifecycleEnd?: () => void
}

export interface StreamSourceHandle {
  /** 把一条事件投入统一 handler（内部去重 + 分发 + 分片 drain）。 */
  ingest: (message: AgentStreamMessage) => void
  /** 主进程转发来的 envelope 唯一分发点（：round/observer 收口到枢纽内部）。 */
  dispatch: (envelope: IpcStreamEnvelope<AgentStreamMessage>) => void
  /** busy 事件已入 drain、但投影尚未更新的同步竞态信号。 */
  hasPendingRunActiveSignal: () => boolean
  /** 常驻源卸载（会话切走 / hook 卸载）：dispose drain 并删除枢纽条目。 */
  detach: () => void
}

/** Test-only：streamSources busy-retain 与 hub 同步清空（避免双 Map 漂移）。 */
let _resetBusyRetainForTest: (() => void) | null = null

/**
 * streamSources 注册：确保 IPC onStreamEvent + watch 已挂上。
 * send() 只建 hub 不够——HMR dispose / 挂载竞态后会出现「有 hub 无 IPC」静默丢流。
 */
let _ensureLiveStreamIpc:
  | ((sessionId: string, deps?: SessionStreamDeps) => void | Promise<void>)
  | null = null

/** Test-only：由 streamSources 自注册，供 `__resetStreamHubsForTest` 一并清理。 */
export function __registerBusyRetainResetForTest(reset: () => void): void {
  _resetBusyRetainForTest = reset
}

/** 由 streamSources 自注册：send / gateway 路径幂等补挂 IPC 常驻源。 */
export function __registerEnsureLiveStreamIpc(
  ensure: (sessionId: string, deps?: SessionStreamDeps) => void | Promise<void>,
): void {
  _ensureLiveStreamIpc = ensure
}

/** Test-only：清空全部入站流枢纽。 */
export function __resetStreamHubsForTest(): void {
  for (const hub of _streamHubs.values()) {
    hub.dispose()
  }
  _streamHubs.clear()
  _resetBusyRetainForTest?.()
}

/** Test-only：同步排空所有 session 的入站 drain（断言 handler 调用前调用）。 */
export function __flushStreamDrainsForTest(): void {
  for (const hub of _streamHubs.values()) {
    hub.drain.flushSync()
  }
}

/** Test-only：经生产同一路径驱动单流 envelope。 */
export function __dispatchStreamEnvelopeForTest(
  sessionId: string,
  envelope: IpcStreamEnvelope<AgentStreamMessage>,
): void {
  _streamHubs.get(sessionId)?.dispatch(envelope)
}

/** Test-only：会话是否已 attach 常驻 stream hub。 */
export function __hasStreamHubForTest(sessionId: string): boolean {
  return _streamHubs.has(sessionId)
}

/**
 * SessionController 的消息门面：读取 / 合并 / 写入门控统一
 * 收口。定义与实现在 `./sessionMessages`（叶子级，避免消费方经 hub/index 成环），
 * 此处 re-export 保持 `SessionController.messages` 的类型入口不变。
 */
export type { SessionMessagesFacade } from './sessionMessages'

// ─── 出站：中止结果──────────────────────────────────────────────

export interface AbortRunResult {
  /** 本机 IPC abort 是否命中（true = run 在本机且已 abort）。 */
  localHit: boolean
  /** 是否发起了后端 chat.cancel 兜底。 */
  remoteRequested: boolean
  /** 后端是否接受了 chat.cancel（已 forward 或写入 durable cancel marker）。 */
  remoteAccepted: boolean
  /**
   * 后端 forward 到执行设备的份数（chat.cancel.ok 的 published）。
   * 0 = 设备离线/不可达（cancel marker 已落库，run 状态最终收敛，但当前
   * run 可能要等设备重连才真正停）。未发起远端时为 null。
   */
  remotePublished: number | null
}

// ─── 出站：runtime bridge（本机 IPC）──────────────────────────────────────

// 类型直接派生自全局 `window.tabtin.agentEngine`（TabTinAPI，由 preload 定义），
// 不手写 bridge 类型，避免与 preload 单源漂移。
type AgentEngineApi = NonNullable<Window['tabtin']>['agentEngine']

function requireAgentEngine(): AgentEngineApi {
  const bridge = window.tabtin?.agentEngine
  if (!bridge) {
    throw new Error('agentEngine bridge unavailable (no local runtime IPC)')
  }
  return bridge
}

/**
 * 本机 runtime IPC 通道是否可用（全局能力探测，非 per-session）。取代散落在各调用点
 * 的 `window.tabtin?.agentEngine?.xxx` 存在性判断。
 */
export function hasRuntimeBridge(): boolean {
  return !!window.tabtin?.agentEngine
}

type ChatGateway = ReturnType<ReturnType<typeof getChatClient>['getGateway']>

// ── 出站发送：统一入口的类型（传输路由是 hub 内部决策，对外不暴露 local/remote 方法）──

/**
 * 出站执行路由（`resolveSendRoute` 的判定结果）：
 *   - `runtime`：本机 runtime 执行（IPC 流式驱动）；
 *   - `gateway`：执行绑定在其他设备，经后端网关转发；
 *   - `unavailable`：非遥控且 Agent 配置关闭了本机 runtime——无可用执行端。
 */
export type SendRoute = 'runtime' | 'gateway' | 'unavailable'

/** `send()` 的入参：路由判定输入 + 两份惰性物料（只有被选中的一份会被构造）。 */
export interface SendExecution {
  /** 路由判定输入：执行 Space（遥控判定按它查执行绑定设备）。 */
  spaceId?: string
  /** 服务端签发的会话执行目标；存在时优先于旧 targetDeviceId。 */
  executionTarget?: SessionExecutionTarget | null
  /** 旧 Session 的冻结设备目标；仅在 executionTarget 缺失时参与兼容路由。 */
  targetDeviceId?: string | null
  /** 路由判定输入：Agent 配置（`use_local_runtime=false` 显式关闭本机执行）。 */
  agentConfig?: { use_local_runtime?: boolean } | null
  /**
   * gateway 路由的物料：wire payload + 请求选项。
   *
   * ：执行下沉主进程后不再需要调用方注入 gateway 实例——实际 WS 请求由主进程
   * `electronWsGateway` 经 `agent-engine:gateway-send` IPC 发出（出入站共用主进程连接）。
   */
  gatewayRequest?: () =>
    | {
      payload: Parameters<ChatGateway['request']>[1]
      requestOptions?: Parameters<ChatGateway['request']>[2]
    }
    | Promise<{
      payload: Parameters<ChatGateway['request']>[1]
      requestOptions?: Parameters<ChatGateway['request']>[2]
    }>
  /** runtime 路由的物料：本机执行的 message / deps / options。 */
  runtimeExecution?: () => (
    | {
      message: string
      deps: SessionStreamDeps
      options?: LocalAgentStreamOptions
    }
    | Promise<{
      message: string
      deps: SessionStreamDeps
      options?: LocalAgentStreamOptions
    }>
  )
}

/** `send()` 的判别联合结果：按实际路由携带对应产物。 */
export type SendOutcome =
  | { route: 'unavailable' }
  | { route: 'gateway'; response: Awaited<ReturnType<ChatGateway['request']>> }
  | { route: 'runtime'; result: LocalAgentStreamResult }

/**
 * 本机 runtime 是否可作为执行端（基础可用性 SSoT `isLocalRuntimeAvailable` +
 * Agent 配置显式降级）。原 sendMessageAction 内私有判定，随路由决策权收进 hub。
 */
function isRuntimeExecutionEnabled(agentConfig?: { use_local_runtime?: boolean } | null): boolean {
  if (!isLocalRuntimeAvailable()) return false
  if (agentConfig?.use_local_runtime === false) return false
  return true
}

// ─── SessionController：一条会话的执行控制器（对外唯一入口）────────────────
//
// 一条 session 的所有出入站操作都是它的方法，调用方 `getSessionController(sessionId)`
// 取用，签名不再重复携带 sessionId。无自身状态：真相在模块级 `_streamHubs` +
// `window.tabtin.agentEngine`，控制器只是绑定 sessionId 的门面，可随用随建、无需缓存。
//
// **出站 IPC↔WS 兜底位置按操作语义分层**：
//   - `abort`：renderer 侧 IPC 快路径 → 后端 WS `chat.cancel` 兜底（本控制器内）。
//   - HITL（`submitApproval` / `answerAskUser`）：renderer 只发 IPC；本地 resolver
//     miss → WS forward 由 **main 进程** `ElectronAgentHost.forwardUserResponseToBackend`
//     完成（，resolver 状态只有 main 知道），故本层只透传 IPC。
//   - `retryTool` / `pushContext`：后端无对应 WS 接口，仅本机 IPC。
//   - `send`：**单一入口**，路由（runtime IPC 流 / gateway WS 转发 / unavailable）由
//     `resolveSendRoute` 在 hub 内判定，调用方只提供两份惰性物料（被选中的一份才会
//     构造）；业务编排（乐观气泡 / 附件 / checkpoint）仍留在 sendMessageAction。
//
// **HITL 例外**：`submitApproval` / `answerAskUser` 按 `batchId`/`requestId` + `threadId`
// 定位，`threadId`（= `chat-session-${sessionId}`）与本控制器的 sessionId 正交，故这两个
// 方法保留显式 threadId 入参、不由 sessionId 推导——归入本控制器仅为调用聚合，不改语义。
export class SessionController {
  // ── 消息门面──

  /** 本会话消息列表的读取 / 合并 / 写入门面（委托叶子级 sessionMessages 模块）。 */
  readonly messages: SessionMessagesFacade

  constructor(private readonly sessionId: string) {
    this.messages = getSessionMessagesFacade(sessionId)
  }

  // ── 出站：回退的**连接层**────────────────────────────────────
  //
  // 职责边界：回退的业务编排（截断 / 资源恢复 / per-file 文件回退 / toast /
  // restoring 状态机）在 checkpointSlice；hub 只持有**跨进程 / 跨网络的通道**——
  // runtime IPC 时间线回退、transcript unrevert、run 取消（IPC + WS 组合）。
  // 对外操作入口（rollback / restoreAndEdit / unrevert 门面）经 rollbackRegistry
  // 复用 slice 的 enqueue 串行化 actions，不产生第二条执行路径。

  private requireRollbackActions(): RollbackActions {
    const actions = rollbackRegistry.get()
    if (!actions) throw new Error('rollback actions not registered (chat store not initialized)')
    return actions
  }

  /** 回退对话到指定消息（保留 assistant 目标本身 / 移除 user 目标及其后）。 */
  rollback(messageId: string, resourceRestorePlan?: Parameters<RollbackActions['rollbackToCheckpoint']>[2]): Promise<void> {
    return this.requireRollbackActions().rollbackToCheckpoint(messageId, this.sessionId, resourceRestorePlan)
  }

  /** 编辑并重发：回退到目标 user 消息之前并自动发送新内容。 */
  restoreAndEdit(
    messageId: string,
    newContent: string,
    attachments?: Parameters<RollbackActions['restoreAndEdit']>[2],
    contextBlocks?: Parameters<RollbackActions['restoreAndEdit']>[3],
  ): Promise<void> {
    return this.requireRollbackActions().restoreAndEdit(messageId, newContent, attachments, contextBlocks, this.sessionId)
  }

  /** 撤销回退（「恢复原状」）。 */
  unrevert(): Promise<void> {
    return this.requireRollbackActions().unrevertSession(this.sessionId)
  }

  /**
   * Runtime 权威时间线回退通道（IPC `agent-engine:rollback-session-timeline`）。
   * runtime 先写 REWIND 边界、成功后由主进程同步 Django rollback 投影——顺序
   * 契约在主进程实现；本方法只负责通道可用性与透传。参数组装（keepMessageCount /
   * occurrence 消歧 / space 归属）与结果解包语义属业务编排，留在 checkpointSlice。
   */
  rollbackSessionTimeline(
    payload: Omit<Parameters<AgentEngineApi['rollbackSessionTimeline']>[0], 'sessionId'>,
  ): ReturnType<AgentEngineApi['rollbackSessionTimeline']> {
    return requireAgentEngine().rollbackSessionTimeline({ ...payload, sessionId: this.sessionId })
  }

  /** 移除本机 transcript 的 rewind 软标记（unrevert 的 runtime 通道）。无 bridge 时抛错。 */
  unrevertTranscript(
    payload?: Omit<Parameters<AgentEngineApi['unrevertTranscript']>[0], 'sessionId'>,
  ): ReturnType<AgentEngineApi['unrevertTranscript']> {
    return requireAgentEngine().unrevertTranscript({ ...(payload ?? {}), sessionId: this.sessionId })
  }

  /**
   * 尽力取消本会话在飞 run（回退前置步骤）：本机 IPC abort + 后端 `chat.cancel`
   * 并行发起，超时/失败均吞掉（fire-safe），最后留一小段 settle 窗口让在途事件
   * 排空。与 `abort()` 的区别：abort 是用户主动中止（IPC 命中即返回）；本方法是
   * 回退管线的前置清场，两通道**同时**发起以求最大覆盖。
   */
  async cancelActiveRun(options: { timeoutMs: number; settleMs: number }): Promise<void> {
    const sessionId = this.sessionId
    const cancelTasks: Promise<unknown>[] = []

    const localAbort = typeof window !== 'undefined' ? window.tabtin?.agentEngine?.abort : undefined
    if (typeof localAbort === 'function') {
      cancelTasks.push(localAbort({ sessionId }).catch(() => undefined))
    }

    cancelTasks.push(
      Promise.race([
        cancelActiveRunForSession(sessionId),
        new Promise(resolve => setTimeout(resolve, options.timeoutMs)),
      ]).catch(() => undefined),
    )

    await Promise.allSettled(cancelTasks)
    await new Promise(resolve => setTimeout(resolve, options.settleMs))
  }

  // ── 入站：流枢纽 ──

  /**
   * 业务语义 deps → StreamHandlerDeps：`get`/`set` 绑定运行时 store、client cast、
   * sessionId 填充等 IPC/handler 细节都在此完成——这些是 hub 内部知识，不外泄到调用方。
   */
  private buildStreamHandlerDeps(deps: SessionStreamDeps): StreamHandlerDeps {
    const ctx = deps.getContext()
    // 运行时 store 经 leaf 注册表倒置取用（hub 不静态依赖 store）；构造发生在
    // attachStream/send 时，晚于 useChatRuntimeStore 注册，故 require 恒非空。
    const runtime = runtimeStoreAccess.requireAccess()
    return {
      sessionId: this.sessionId,
      spaceId: ctx.spaceId,
      spaceName: ctx.spaceName,
      sessionTitle: ctx.sessionTitle,
      get: runtime.get,
      set: runtime.set,
      client: deps.client as { sessions: { get: (id: string) => Promise<ChatSession> } } as ChatClient,
      addStreamingSession: deps.addStreamingSession,
      removeStreamingSession: deps.removeStreamingSession,
      updateSessionTokenUsageInCaches: deps.updateSessionTokenUsageInCaches,
      updateSessionInCaches: deps.updateSessionInCaches,
      onLifecycleEnd: () => deps.onLifecycleEnd?.(),
    }
  }

  /**
   * 接入本 session 的**常驻单源**到枢纽，返回投递句柄（ingest / detach）。
   *
   *  单源终态：来源区分与仲裁在主进程完成，渲染进程每会话只有这一条常驻源
   * （`streamSources.attachMainStream` 订阅唯一 IPC channel）。首次 attach 创建枢纽
   * （唯一 handler + drain）；detach（会话切走 / 卸载）dispose 并回收条目。
   */
  attachStream(deps: SessionStreamDeps): StreamSourceHandle {
    const sessionId = this.sessionId
    let hub = _streamHubs.get(sessionId)
    if (!hub) {
      hub = new SessionStreamHub(sessionId, this.buildStreamHandlerDeps(deps))
      _streamHubs.set(sessionId, hub)
    }
    const bound = hub
    return {
      ingest: (message: AgentStreamMessage) => bound.ingest(message),
      dispatch: (envelope: IpcStreamEnvelope<AgentStreamMessage>) => bound.dispatch(envelope),
      hasPendingRunActiveSignal: () => bound.hasPendingRunActiveSignal(),
      detach: () => {
        bound.dispose()
        _streamHubs.delete(sessionId)
      },
    }
  }

  /** 会话清理 / evict 时清掉本 session 的流枢纽。 */
  clearStreamHub(): void {
    const hub = _streamHubs.get(this.sessionId)
    if (hub) {
      hub.dispose()
      _streamHubs.delete(this.sessionId)
    }
  }

  /**
   * ：权威 runtime 已 idle 的对账收口前，把未 settle 的 SendMessage waiter
   * 按 completed resolve，避免随后 dispose 打成伪 abort。
   * @returns 是否实际 settle 了一个 unsettled waiter
   */
  settleExecutionCompleted(): boolean {
    return _streamHubs.get(this.sessionId)?.settleExecutionCompleted() ?? false
  }

  // ── 出站：中止 ──

  /**
   * 中止本会话当前的 Agent run（：出站执行下沉主进程）。
   *
   * 渲染进程只发**一次** IPC `agent-engine:abort-run`；本机 IPC 快路径 + 后端
   * `chat.cancel` 兜底都在主进程 `handleAbortRun` 内完成（出入站共用主进程 WS 连接）。
   *
   * fire-safe：任何一步失败都不抛，调用方（abortStream 乐观 UI 路径）按返回值留痕即可。
   * 真正的终态以 `message_stop(stop_reason=aborted)` / lifecycle cancelled 事件为准。
   */
  async abort(): Promise<AbortRunResult> {
    const sessionId = this.sessionId
    const result: AbortRunResult = {
      localHit: false,
      remoteRequested: false,
      remoteAccepted: false,
      remotePublished: null,
    }
    if (!sessionId) return result

    const bridge = window.tabtin?.agentEngine
    if (!bridge?.abortRun) {
      log.warn('[abortRun] abort-run bridge unavailable (no local runtime IPC)')
      return result
    }
    try {
      const res = await bridge.abortRun(sessionId)
      if (!res.localHit) {
        log.warn('[abortRun] 本机 runtime abort 未命中，主进程已走远端 chat.cancel 兜底', {
          sessionId: sessionId.slice(0, 8),
          remoteAccepted: res.remoteAccepted,
          remotePublished: res.remotePublished,
        })
      }
      return {
        localHit: !!res.localHit,
        remoteRequested: !!res.remoteRequested,
        remoteAccepted: !!res.remoteAccepted,
        remotePublished: typeof res.remotePublished === 'number' ? res.remotePublished : null,
      }
    } catch (err) {
      log.warn('[abortRun] abort-run IPC failed:', err)
      return result
    }
  }

  /**
   *  Composer Stop 撤回未答轮次：经 runtime IPC（abort + rewind commit +
   * 主进程投影），渲染进程不直打 Django。
   */
  withdrawUnansweredTurn(
    payload: Omit<Parameters<AgentEngineApi['withdrawUnansweredTurn']>[0], 'sessionId'>,
  ): ReturnType<AgentEngineApi['withdrawUnansweredTurn']> {
    return requireAgentEngine().withdrawUnansweredTurn({ ...payload, sessionId: this.sessionId })
  }

  /**
   * 中止被插队顶替的旧流（新流已起，旧流只做收尾、不向执行端之外传播）。
   * 实现细节：旧流必然在本机 runtime 上（只有本机流会被本窗口插队），走 IPC。
   */
  abortSupersededRun(): void {
    getLocalAgentClient().abort(this.sessionId)
  }

  // ── 出站：发送（单一入口，传输路由是 hub 内部决策）──

  /**
   * 本会话的出站执行路由（hub 唯一决策点，调用方不自行判断执行位置）：
   *   - `runtime`：本机 runtime 可执行 → IPC 流式驱动；
   *   - `gateway`：执行绑定在其他设备（遥控形态）→ 经后端网关转发；
   *   - `unavailable`：非遥控但 Agent 配置关闭了本机 runtime → 无可用执行端，
   *     调用方应提示用户（fail-visible，不静默换通道）。
   */
  resolveSendRoute(input: {
    spaceId?: string
    executionTarget?: SessionExecutionTarget | null
    targetDeviceId?: string | null
    agentConfig?: { use_local_runtime?: boolean } | null
  }): SendRoute {
    const targetLocation = resolveExecutionTargetLocation({
      target: input.executionTarget,
      legacyTargetDeviceId: input.targetDeviceId,
      spaceId: input.spaceId,
    })
    if (targetLocation === 'remote') return 'gateway'
    if (targetLocation === 'unresolved') return 'unavailable'
    if (!isRuntimeExecutionEnabled(input.agentConfig)) return 'unavailable'
    return 'runtime'
  }

  /**
   * 发送统一入口：一次调用，hub 按 `resolveSendRoute` 决定执行通道并消费对应物料。
   * 调用方提供两份**惰性**物料工厂（只有被路由选中的一份会被构造 / 执行）：
   *   - `runtimeExecution`：本机执行的 message / deps / options。
   *   - `gatewayRequest`：经后端网关转发的 wire payload。gateway 实例由调用方注入
   *     （保持依赖注入契约——不在本层自取模块单例）。
   *
   * 返回判别联合：runtime 路由回流式结果，gateway 路由回网关响应，unavailable
   * 原样返回让调用方 fail-visible。路由选中但对应物料缺失 = 编程错误，直接 throw。
   */
  async send(execution: SendExecution): Promise<SendOutcome> {
    const route = this.resolveSendRoute({
      spaceId: execution.spaceId,
      executionTarget: execution.executionTarget,
      targetDeviceId: execution.targetDeviceId,
      agentConfig: execution.agentConfig,
    })

    if (route === 'unavailable') return { route }

    if (route === 'gateway') {
      if (!execution.gatewayRequest) {
        throw new Error('send: routed to gateway but gatewayRequest material is missing')
      }
      const { payload, requestOptions } = await execution.gatewayRequest()
      // gateway 执行同样依赖 resident watcher 接收实时流。无 deps 时只重申已有 live；
      // 页面尚未挂载则由 useConversationStream 建立完整 attach。
      _ensureLiveStreamIpc?.(this.sessionId)
      // ：出站执行下沉主进程——经 electronWsGateway 发出 chat.send_message，
      // 渲染进程不再自持这条 WS 请求。requestOptions.organizationId 覆盖 auth org。
      const bridge = window.tabtin?.agentEngine
      if (!bridge?.gatewaySend) {
        throw new Error('send: gateway-send bridge unavailable (no local runtime IPC)')
      }
      const response = (await bridge.gatewaySend({
        messageType: 'chat.send_message',
        payload: payload as Record<string, unknown>,
        requestOptions: requestOptions as Record<string, unknown> | undefined,
      })) as Awaited<ReturnType<ChatGateway['request']>>
      return { route, response }
    }

    if (!execution.runtimeExecution) {
      throw new Error('send: routed to runtime but runtimeExecution material is missing')
    }
    const { message, deps, options } = await execution.runtimeExecution()
    // ：先在本模块实例建 hub，再补 IPC + watch（不能只 attachStream）。
    // 动态 import 避免 index ↔ streamSources 循环依赖；传入 handle 防止双实例漂移。
    const handle = this.attachStream(deps)
    const { ensureLiveStreamIpc } = await import('./streamSources')
    await ensureLiveStreamIpc(this.sessionId, deps, handle)
    // ensure 后再次确认：测试双实例 / teardown 竞态下允许重建本模块 hub。
    let hub = _streamHubs.get(this.sessionId)
    if (!hub) {
      this.attachStream(deps)
      hub = _streamHubs.get(this.sessionId)
    }
    if (!hub) throw new Error(`send: no resident stream for session ${this.sessionId}`)
    // ：host IPC 为 accepted ACK（入队/开始即返回）。不再把 ACK 当整轮结束，
    // 也不再占单槽 waitForExecution——多轮连发由 ConversationRunQueue 串行，
    // UI busy / 排队镜像 run_sync。流终态由常驻 hub handler 消化。
    try {
      const ack = await getLocalAgentClient().query(this.sessionId, message, options)
      if (!ack || typeof ack !== 'object') {
        throw new Error('send: runtime query returned empty ACK')
      }
      return {
        route,
        result: {
          session_id: this.sessionId,
          thread_id: this.sessionId,
          runId: ack.runId,
          runDisposition: ack.runDisposition,
          queuePosition: ack.queuePosition,
        },
      }
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err))
    }
  }

  // ── 出站：其它 per-session ──

  /** 重试失败的工具调用。仅本机 IPC（后端无对应 WS 接口）。 */
  retryTool(
    toolName: Parameters<AgentEngineApi['retryTool']>[1],
    args: Parameters<AgentEngineApi['retryTool']>[2],
  ): ReturnType<AgentEngineApi['retryTool']> {
    return requireAgentEngine().retryTool(this.sessionId, toolName, args)
  }

  /** fire-and-forget 推送 app context 到本机 runtime；无 bridge 时静默 no-op。 */
  pushContext(appContext: Parameters<AgentEngineApi['updateContext']>[1]): void {
    const bridge = window.tabtin?.agentEngine
    if (!bridge) return
    void bridge.updateContext(this.sessionId, appContext).catch(() => {})
  }

  // ── 出站：HITL（按 batchId/requestId + threadId 定位，见上方例外说明）──

  /** 提交审批批量决策（HITL）。IPC→WS 兜底在 main 进程完成，见类注释。 */
  submitApproval(
    batchId: Parameters<AgentEngineApi['submitHitlBatch']>[0],
    decisions: Parameters<AgentEngineApi['submitHitlBatch']>[1],
    threadId?: Parameters<AgentEngineApi['submitHitlBatch']>[2],
  ): ReturnType<AgentEngineApi['submitHitlBatch']> {
    return requireAgentEngine().submitHitlBatch(batchId, decisions, threadId)
  }

  /** 提交 ask_user 回答（HITL）。IPC→WS 兜底在 main 进程完成，见类注释。 */
  answerAskUser(
    requestId: Parameters<AgentEngineApi['submitAskUserResponse']>[0],
    response: Parameters<AgentEngineApi['submitAskUserResponse']>[1],
    threadId?: Parameters<AgentEngineApi['submitAskUserResponse']>[2],
  ): ReturnType<AgentEngineApi['submitAskUserResponse']> {
    return requireAgentEngine().submitAskUserResponse(requestId, response, threadId)
  }

  /**
   * （第二刀）：renderer dismiss HITL 面板 → main 收敛 pending 为
   * 「用户取消」终态。**只走本机**（不做 WS 兜底）——dismiss 是本机用户意图；
   * 跨端 race 的收敛由后端的 hitl_interaction 消息广播承担，本机成功即够。
   */
  cancelHitlInteraction(payload: Parameters<AgentEngineApi['cancelHitlInteraction']>[0]):
    ReturnType<AgentEngineApi['cancelHitlInteraction']> {
    return requireAgentEngine().cancelHitlInteraction(payload)
  }
}

/** 取指定 session 的执行控制器（无状态门面，随用随建）。 */
export function getSessionController(sessionId: string): SessionController {
  return new SessionController(sessionId)
}
