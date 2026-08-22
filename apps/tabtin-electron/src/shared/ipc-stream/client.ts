/**
 * IpcStreamClient —— Renderer 侧的 IpcStream 入口。
 *
 * 用法（消费侧的唯一正确写法）：
 *   const stream = openIpcStream<MyEvent>(sessionId, {
 *     subscribe: (handler) => window.tabtin.myApi.onStreamEvent(handler),
 *     isTerminalEvent: (e) => e.type === 'lifecycle.end',
 *   })
 *   try {
 *     for await (const event of stream) {
 *       reducer.dispatch(event)
 *     }
 *     // 自然退出 = 业务终态 或 sentinel('completed') 任一到达
 *   } catch (err) {
 *     // IpcStreamRemoteError / IpcStreamStallError / IpcStreamAbortedError
 *   } finally {
 *     stream.close()  // 提前 break 时也确保 watchdog/listener 卸载
 *   }
 *
 * 三层退出条件：
 *   1. 业务终态：`isTerminalEvent(event) === true` —— 该事件 yield 出去后关闭
 *   2. Sentinel 帧：`{ terminal: {...} }` envelope 到达
 *      - reason='completed' / 'aborted' → iterator 自然结束
 *      - reason='errored' → `next()` reject `IpcStreamRemoteError`
 *   3. 心跳 watchdog：`heartbeatIdleMs` 内无任何 envelope → reject `IpcStreamStallError`
 *
 * 任何 envelope 到达（包括业务 event）都重置 watchdog timer——不会冤枉慢推理。
 */

import {
  isTerminalEnvelope,
  isHeartbeatEnvelope,
  type IpcStreamEnvelope,
} from './types'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Watchdog 触发：心跳间隔内无任何 envelope。 */
export class IpcStreamStallError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly idleMs: number,
  ) {
    super(
      `IpcStream session ${sessionId} idle for ${idleMs}ms (heartbeat watchdog triggered)`,
    )
    this.name = 'IpcStreamStallError'
  }
}

/** 主进程发来 reason='errored' sentinel。 */
export class IpcStreamRemoteError extends Error {
  constructor(
    public readonly sessionId: string,
    message: string,
  ) {
    super(message)
    this.name = 'IpcStreamRemoteError'
  }
}

/** 主进程发来 reason='aborted' sentinel。 */
export class IpcStreamAbortedError extends Error {
  constructor(public readonly sessionId: string) {
    super(`IpcStream session ${sessionId} aborted`)
    this.name = 'IpcStreamAbortedError'
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface OpenIpcStreamOptions<T> {
  /**
   * 业务自定义"什么 event 是流终态"。返回 true 时，iterator 会把这条事件
   * yield 出去之后关闭。**不能返回 true 后期望还能继续收事件**——这违反 invariant。
   *
   * 例：lifecycle 事件的 phase 是 end / error / terminated 时返回 true。
   */
  isTerminalEvent: (event: T) => boolean

  /**
   * IPC 订阅入口。返回 unsubscribe 函数。typically 由 preload 暴露的
   * `window.tabtin.xxx.onStreamEvent` 传入。
   *
   * handler 接收 envelope（不是裸事件）—— types.ts 的 IpcStreamEnvelope<T>。
   */
  subscribe: (handler: (envelope: IpcStreamEnvelope<T>) => void) => () => void

  /**
   * 心跳 watchdog 间隔（ms）。任何 envelope 到达都重置。
   *
   * - 默认 30000（30s）
   * - 设为 0 关闭 watchdog（不推荐，仅测试用）
   *
   * 30s 是经验值：LLM 慢推理在 30s 内通常能 emit 至少一条 reasoning / step 事件；
   * 如果 30s 没任何 envelope，多半是主进程崩了 / IPC 链路断了。
   */
  heartbeatIdleMs?: number

  /**
   * Telemetry hook —— watchdog 触发时调用。用于运营层观察真实卡顿率。
   * 默认无副作用，调用方按需注入。
   */
  onStall?: (info: { sessionId: string; idleMs: number }) => void

  /** Telemetry hook —— 收到 reason='aborted' sentinel 时调用。 */
  onAbort?: (info: { sessionId: string }) => void

  /** Telemetry hook —— 收到 reason='errored' sentinel 时调用。 */
  onRemoteError?: (info: { sessionId: string; message: string }) => void
}

export interface IpcStream<T> extends AsyncIterableIterator<T> {
  /** 提前关流（即便 `for await` 还没退出）。幂等。 */
  close(): void
  /** 当前是否已关闭（cleanup 已发生）。 */
  readonly closed: boolean
}

const DEFAULT_HEARTBEAT_IDLE_MS = 30_000

/**
 * 打开一个流式 IPC 通道，返回 AsyncIterableIterator<T>。
 *
 * @param sessionId 用于 envelope demux —— 同一 channel 多 session 互不串扰
 * @param options   订阅 + 终态判定 + watchdog
 */
export function openIpcStream<T>(
  sessionId: string,
  options: OpenIpcStreamOptions<T>,
): IpcStream<T> {
  const {
    isTerminalEvent,
    subscribe,
    heartbeatIdleMs = DEFAULT_HEARTBEAT_IDLE_MS,
    onStall,
    onAbort,
    onRemoteError,
  } = options

  type PendingError =
    | { kind: 'remote'; message: string }
    | { kind: 'stall'; idleMs: number }
    | { kind: 'aborted' }

  // 内部状态机
  const buffer: T[] = []
  let done = false
  let pendingError: PendingError | null = null
  let waitResolve: ((value: IteratorResult<T>) => void) | null = null
  let waitReject: ((reason: unknown) => void) | null = null
  let unsubscribe: (() => void) | null = null
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null
  let cleanedUp = false

  function clearWatchdog(): void {
    if (watchdogTimer !== null) {
      clearTimeout(watchdogTimer)
      watchdogTimer = null
    }
  }

  function armWatchdog(): void {
    if (heartbeatIdleMs <= 0) return
    clearWatchdog()
    watchdogTimer = setTimeout(() => {
      if (done) return
      pendingError = { kind: 'stall', idleMs: heartbeatIdleMs }
      done = true
      try { onStall?.({ sessionId, idleMs: heartbeatIdleMs }) } catch { /* telemetry best effort */ }
      flushWaiter()
    }, heartbeatIdleMs)
  }

  function flushWaiter(): void {
    const r = waitResolve
    const j = waitReject
    if (!r && !j) return
    waitResolve = null
    waitReject = null

    if (buffer.length > 0) {
      r?.({ value: buffer.shift()!, done: false })
      return
    }
    if (pendingError) {
      // 终态 reject —— 立刻 cleanup（释放 watchdog + listener）
      const e = pendingError
      cleanup()
      if (e.kind === 'remote') j?.(new IpcStreamRemoteError(sessionId, e.message))
      else if (e.kind === 'stall') j?.(new IpcStreamStallError(sessionId, e.idleMs))
      else j?.(new IpcStreamAbortedError(sessionId))
      return
    }
    if (done) {
      // 自然结束 —— 立刻 cleanup
      cleanup()
      r?.({ value: undefined as unknown as T, done: true })
    }
  }

  function handleEnvelope(envelope: IpcStreamEnvelope<T>): void {
    // demux：忽略其他 session 的事件（同 channel 多 session 共存）
    if (envelope.sessionId !== sessionId) return
    // 已关闭后到达的 envelope 直接吞（譬如业务终态先到、sentinel 后到）
    if (done || cleanedUp) return

    armWatchdog()

    if (isHeartbeatEnvelope(envelope)) return

    if (isTerminalEnvelope(envelope)) {
      done = true
      const t = envelope.terminal
      if (t.reason === 'errored') {
        pendingError = { kind: 'remote', message: t.error ?? 'remote stream error' }
        try { onRemoteError?.({ sessionId, message: pendingError.message }) } catch { /* best effort */ }
      } else if (t.reason === 'aborted') {
        pendingError = { kind: 'aborted' }
        try { onAbort?.({ sessionId }) } catch { /* best effort */ }
      }
      flushWaiter()
      return
    }

    // 业务事件入 buffer；如果是终态事件，标记 done（buffer 排空后 iterator 关闭）
    const event = envelope.event as T
    buffer.push(event)
    if (isTerminalEvent(event)) {
      done = true
    }
    flushWaiter()
  }

  function cleanup(): void {
    if (cleanedUp) return
    cleanedUp = true
    clearWatchdog()
    if (unsubscribe) {
      try { unsubscribe() } catch { /* best effort */ }
      unsubscribe = null
    }
    // 关键：cleanup 时若仍有 pending next() 在 await，必须主动唤醒它
    // —— 否则 Promise 永远 pending、引用链泄漏。
    //
    // 三种情况会触发"挂着的 next() + cleanup"：
    //   1. 调用方先 await stream.next() 再外部主动调 stream.close()
    //   2. for-await 进入 next() 等待时 iterator.return() 被调（譬如 break）
    //   3. iterator.throw() 被调
    //
    // 处理优先级跟 flushWaiter 保持一致：buffer 优先 → pendingError → done。
    // 这里 cleanup 已经标记 cleanedUp，不能再调 flushWaiter（其内部仍可能改
    // 状态）；直接同步处理 waiter。
    if (waitResolve || waitReject) {
      const r = waitResolve
      const j = waitReject
      waitResolve = null
      waitReject = null
      if (buffer.length > 0) {
        r?.({ value: buffer.shift()!, done: false })
      } else if (pendingError) {
        const e = pendingError
        if (e.kind === 'remote') j?.(new IpcStreamRemoteError(sessionId, e.message))
        else if (e.kind === 'stall') j?.(new IpcStreamStallError(sessionId, e.idleMs))
        else j?.(new IpcStreamAbortedError(sessionId))
      } else {
        // 主动 close —— 自然结束语义
        r?.({ value: undefined as unknown as T, done: true })
      }
    }
  }

  // 订阅 IPC + 启 watchdog
  unsubscribe = subscribe(handleEnvelope)
  armWatchdog()

  const iterator: IpcStream<T> = {
    [Symbol.asyncIterator](): IpcStream<T> {
      return iterator
    },

    next(): Promise<IteratorResult<T>> {
      if (cleanedUp) {
        return Promise.resolve({ value: undefined as unknown as T, done: true })
      }
      // buffer 优先：业务终态命中后 buffer 里仍可能有未消费的 final 事件
      if (buffer.length > 0) {
        return Promise.resolve({ value: buffer.shift()!, done: false })
      }
      if (pendingError) {
        // 终态 reject —— 立刻 cleanup（与 flushWaiter 保持对称）
        const e = pendingError
        cleanup()
        if (e.kind === 'remote') return Promise.reject(new IpcStreamRemoteError(sessionId, e.message))
        if (e.kind === 'stall') return Promise.reject(new IpcStreamStallError(sessionId, e.idleMs))
        return Promise.reject(new IpcStreamAbortedError(sessionId))
      }
      if (done) {
        // 自然结束 —— 立刻 cleanup（for-await 自然退出不会调 return()）
        cleanup()
        return Promise.resolve({ value: undefined as unknown as T, done: true })
      }
      // 没有数据、没出错、没结束 —— 挂起等下一条 envelope
      return new Promise<IteratorResult<T>>((resolve, reject) => {
        waitResolve = resolve
        waitReject = reject
      })
    },

    return(): Promise<IteratorResult<T>> {
      cleanup()
      return Promise.resolve({ value: undefined as unknown as T, done: true })
    },

    throw(err?: unknown): Promise<IteratorResult<T>> {
      cleanup()
      return Promise.reject(err)
    },

    close(): void {
      cleanup()
    },

    get closed(): boolean {
      return cleanedUp
    },
  }

  return iterator
}
