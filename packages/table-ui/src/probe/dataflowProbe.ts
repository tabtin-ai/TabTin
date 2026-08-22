/**
 * TabData（多维表）交互数据流探针（dev-only）
 *
 * 目标：让 AI / 自动化能在真实宿主里观测「用户手势 → 真实 handler → 乐观渲染 →
 * http → reconcile/回滚」这条**交互面**链路，而不依赖人工点 Canvas / copy 日志 / 截图。
 *
 * 设计与 TabDoc 的 `@tabtin/doc-editor` 探针同构（见 docs/agent/dataflow-verification.md）：
 *   - 探针只采集事件，host-agnostic；由宿主在 DEV 下显式 enableDataflowProbe() 启用
 *     （生产包永不启用 = 全程廉价 no-op）；
 *   - 各层（interaction / editing / clipboard / optimistic / http / reconcile / view）
 *     通过 recordProbeEvent() 喂事件；
 *   - 宿主注入 sink（Electron/Web dev → POST dev 中间件落文件）。
 *
 * 「区分来源」：每条事件带 origin（user 真人 / agent 探针 fireIntent / cli / probe / system），
 * 共享日志里多方在写时可据此摘出各自的数据流，并断言「AI 链路 == 用户链路」。
 *
 * 注：本文件与 doc-editor 的 dataflowProbe.ts 当前是「同构双生」。后续应抽到一个
 * 共享 probe-core（单一事实源 + 两端各投影一个 window adapter），见
 * docs/agent/tabdata-interaction-probe.md「后续：探针核心收敛」。本骨架 PR 先不动
 * doc-editor（避免影响已达 L4 的 TabDoc harness），泛化点已就位、收敛成本低。
 */

export type ProbeOrigin = 'user' | 'agent' | 'cli' | 'probe' | 'system'

/** 数据流节点（grid 分层）。预置常用值，允许扩展字符串。 */
export type ProbeComponent =
  | 'interaction'
  | 'selection'
  | 'editing'
  | 'clipboard'
  | 'optimistic'
  | 'http'
  | 'reconcile'
  | 'view'
  | 'dataset'
  | 'intent'
  | (string & {})

export type ProbeHost = 'web' | 'electron' | 'daemon' | 'unknown'

export interface ProbeEvent {
  /** 毫秒时间戳 */
  ts: number
  origin: ProbeOrigin
  component: ProbeComponent
  /** 节点内的事件名，如 'cell.commit' / 'cell.commitOk' / 'cell.rollback' / 'http.request' */
  event: string
  host: ProbeHost
  /** 跨层/跨服务关联 id（接 HTTP header 的 trace_id，串联服务端日志） */
  traceId?: string
  /** 一次会话/驱动批次 id，用于把一次验证跑批从别人的事件里摘出来 */
  sessionId?: string
  /** 关联的表 id（若有） */
  tableId?: string
  /** 关联的视图 id（若有） */
  viewId?: string
  /** 关联的记录 id（若有） */
  recordId?: string
  /** 该节点的关键数据流字段（保持可序列化、勿放大对象） */
  payload?: Record<string, unknown>
}

export interface ProbeIntentDescriptor {
  name: string
  description: string
}

export type ProbeSink = (events: ProbeEvent[]) => void

type IntentHandler = (args?: Record<string, unknown>) => unknown | Promise<unknown>

interface EnableOptions {
  host?: ProbeHost
  /** ring buffer 上限，默认 1000 */
  bufferLimit?: number
  /** sink 批量上送间隔(ms)，默认 400；设 0 表示每条立即上送 */
  flushIntervalMs?: number
  sessionId?: string
}

const DEFAULT_BUFFER_LIMIT = 1000
const DEFAULT_FLUSH_INTERVAL_MS = 400

interface ProbeState {
  enabled: boolean
  host: ProbeHost
  bufferLimit: number
  flushIntervalMs: number
  sessionId: string
  buffer: ProbeEvent[]
  pendingForSink: ProbeEvent[]
  flushTimer: ReturnType<typeof setTimeout> | null
  sink: ProbeSink | null
  /** 当前驱动批次来源：fireIntent 期间为 'agent'，否则默认 'user' */
  runOrigin: ProbeOrigin
  intents: Map<string, { handler: IntentHandler; description: string }>
}

const newSessionId = (): string =>
  `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

const state: ProbeState = {
  enabled: false,
  host: 'unknown',
  bufferLimit: DEFAULT_BUFFER_LIMIT,
  flushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS,
  sessionId: newSessionId(),
  buffer: [],
  pendingForSink: [],
  flushTimer: null,
  sink: null,
  runOrigin: 'user',
  intents: new Map(),
}

const scheduleSinkFlush = (): void => {
  if (!state.sink || state.pendingForSink.length === 0) return
  if (state.flushIntervalMs <= 0) {
    flushSink()
    return
  }
  if (state.flushTimer) return
  state.flushTimer = setTimeout(() => {
    state.flushTimer = null
    flushSink()
  }, state.flushIntervalMs)
}

const flushSink = (): void => {
  if (state.flushTimer) {
    clearTimeout(state.flushTimer)
    state.flushTimer = null
  }
  if (!state.sink || state.pendingForSink.length === 0) return
  const batch = state.pendingForSink
  state.pendingForSink = []
  try {
    state.sink(batch)
  } catch {
    // sink 异常不得影响业务；丢弃该批次
  }
}

/** 是否已启用（业务代码可用它在热路径上跳过构造 payload） */
export const isDataflowProbeEnabled = (): boolean => state.enabled

/**
 * 启用探针。仅应由宿主在 DEV 下调用（生产包不调用 = 探针全程 no-op）。
 * 重复调用做合并更新。
 */
export const enableDataflowProbe = (options: EnableOptions = {}): void => {
  state.enabled = true
  if (options.host) state.host = options.host
  if (typeof options.bufferLimit === 'number') {
    state.bufferLimit = Math.max(1, options.bufferLimit)
  }
  if (typeof options.flushIntervalMs === 'number') {
    state.flushIntervalMs = Math.max(0, options.flushIntervalMs)
  }
  if (options.sessionId) state.sessionId = options.sessionId
  attachWindowApi()
}

/** 注入 sink（宿主决定落到哪：dev 中间件文件 / console）。 */
export const setProbeSink = (sink: ProbeSink | null): void => {
  state.sink = sink
}

/** 记录一条数据流事件。未启用时为廉价 no-op。 */
export const recordProbeEvent = (
  event: Omit<ProbeEvent, 'ts' | 'host' | 'sessionId' | 'origin'> &
    Partial<Pick<ProbeEvent, 'ts' | 'host' | 'sessionId' | 'origin'>>,
): void => {
  if (!state.enabled) return
  const full: ProbeEvent = {
    ts: event.ts ?? Date.now(),
    origin: event.origin ?? state.runOrigin,
    component: event.component,
    event: event.event,
    host: event.host ?? state.host,
    traceId: event.traceId,
    sessionId: event.sessionId ?? state.sessionId,
    tableId: event.tableId,
    viewId: event.viewId,
    recordId: event.recordId,
    payload: event.payload,
  }
  state.buffer.push(full)
  if (state.buffer.length > state.bufferLimit) {
    state.buffer.splice(0, state.buffer.length - state.bufferLimit)
  }
  state.pendingForSink.push(full)
  scheduleSinkFlush()
}

/** 注册一个可被 fireIntent 触发的意图（由上层用 UI 同款 handler 注册）。 */
export const registerProbeIntent = (
  name: string,
  handler: IntentHandler,
  description = '',
): void => {
  state.intents.set(name, { handler, description })
}

/** 注销一个意图（组件卸载时调用，避免残留指向已卸载组件的 handler）。 */
export const unregisterProbeIntent = (name: string): void => {
  state.intents.delete(name)
}

export const listProbeIntents = (): ProbeIntentDescriptor[] =>
  Array.from(state.intents.entries()).map(([name, v]) => ({
    name,
    description: v.description,
  }))

/**
 * 触发一个意图。期间记录的事件默认标 origin='agent'，
 * 以便和用户手点(origin='user')区分。意图内若触发异步写入，handler 应自行 flush。
 */
export const fireProbeIntent = async (
  name: string,
  args?: Record<string, unknown>,
): Promise<unknown> => {
  const intent = state.intents.get(name)
  if (!intent) {
    throw new Error(
      `[tabdataProbe] 未知 intent: ${name}。可用: ${Array.from(state.intents.keys()).join(', ') || '(无)'}`,
    )
  }
  const prev = state.runOrigin
  state.runOrigin = 'agent'
  recordProbeEvent({ component: 'intent', event: 'intent.start', payload: { name, args } })
  try {
    const result = await intent.handler(args)
    recordProbeEvent({ component: 'intent', event: 'intent.end', payload: { name, ok: true } })
    return result
  } catch (error) {
    recordProbeEvent({
      component: 'intent',
      event: 'intent.error',
      payload: { name, message: error instanceof Error ? error.message : String(error) },
    })
    throw error
  } finally {
    state.runOrigin = prev
    flushSink()
  }
}

export interface ProbeDumpFilter {
  since?: number
  origin?: ProbeOrigin
  component?: ProbeComponent
  traceId?: string
  tableId?: string
  viewId?: string
  recordId?: string
}

/** 读取 ring buffer（可过滤）。 */
export const dumpProbeEvents = (filter: ProbeDumpFilter = {}): ProbeEvent[] =>
  state.buffer.filter((e) => {
    if (filter.since != null && e.ts < filter.since) return false
    if (filter.origin && e.origin !== filter.origin) return false
    if (filter.component && e.component !== filter.component) return false
    if (filter.traceId && e.traceId !== filter.traceId) return false
    if (filter.tableId && e.tableId !== filter.tableId) return false
    if (filter.viewId && e.viewId !== filter.viewId) return false
    if (filter.recordId && e.recordId !== filter.recordId) return false
    return true
  })

export const clearProbeEvents = (): void => {
  state.buffer = []
}

export const getProbeSessionId = (): string => state.sessionId

/** 强制把待上送事件刷给 sink（验证结束前调，确保落文件）。 */
export const flushProbe = (): void => {
  flushSink()
}

const HELP_TEXT = `window.__tabdataProbe — TabData 交互数据流探针 (dev-only)
  fireIntent(name, args?)  触发 UI 同款意图(标 origin=agent)，可用 intent 见 listIntents()
  listIntents()            列出可触发的意图
  dump(filter?)            读取数据流事件 {since,origin,component,traceId,tableId,viewId,recordId}
  clear()                  清空 ring buffer
  flush()                  立即把事件刷到 sink(落日志文件)
  sessionId()              当前会话 id(用于在共享日志里摘出本次跑批)
事件字段: {ts,origin,component,event,host,traceId,sessionId,tableId,viewId,recordId,payload}
  origin: user 真人 / agent 探针触发 / cli / probe / system
  component: interaction/selection/editing/clipboard/optimistic/http/reconcile/view/dataset`

interface WindowProbeApi {
  fireIntent: typeof fireProbeIntent
  listIntents: typeof listProbeIntents
  dump: typeof dumpProbeEvents
  clear: typeof clearProbeEvents
  flush: typeof flushProbe
  sessionId: () => string
  help: () => string
}

const attachWindowApi = (): void => {
  const g = globalThis as unknown as { __tabdataProbe?: WindowProbeApi }
  if (g.__tabdataProbe) return
  g.__tabdataProbe = {
    fireIntent: fireProbeIntent,
    listIntents: listProbeIntents,
    dump: dumpProbeEvents,
    clear: clearProbeEvents,
    flush: flushProbe,
    sessionId: getProbeSessionId,
    help: () => HELP_TEXT,
  }
}

/** 测试用：重置全部探针状态。 */
export const resetDataflowProbe = (): void => {
  if (state.flushTimer) {
    clearTimeout(state.flushTimer)
    state.flushTimer = null
  }
  state.enabled = false
  state.host = 'unknown'
  state.bufferLimit = DEFAULT_BUFFER_LIMIT
  state.flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS
  state.sessionId = newSessionId()
  state.buffer = []
  state.pendingForSink = []
  state.sink = null
  state.runOrigin = 'user'
  state.intents.clear()
  const g = globalThis as unknown as { __tabdataProbe?: WindowProbeApi }
  delete g.__tabdataProbe
}
