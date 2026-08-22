/**
 * ConversationRunQueue — per-session 串行执行器 + FIFO 队列。
 *
 * runtime 层「session 是否忙」的**唯一真相源**。每个 session 同一时刻至多跑一个
 * query；并发提交自动 FIFO 入队，运行中的 query settle 后自动 drain 下一条。
 *
 * 天然覆盖审批 / askUser 挂起：提交的 run 任务在其 query generator 完全 settle
 * 前一直 pending，session 因此保持 busy——不需要单独的 pendingApproval 影子态。
 *
 * 设计取舍（对齐  决策）：
 *   - 不持久化：纯内存，进程重启即清空（与当前前端队列一致）。
 *   - 无硬上限：与当前前端 messageQueue 行为一致（不设显式 cap）。
 *   - busy 定义 = 有 running 或队列非空；释放由 run 的 settle 驱动，调用方应在
 *     query **streaming 逻辑终态**时 settle（relay flush / storage dispose 后台化，
 *     见 DefaultQueryTurnPipeline seal/storage 链——busy≈streaming；
 *     DeliveryTurn.complete 内 relay ACK 异步 settle）。
 */

export interface ConversationRunQueueEvents {
  /** 提交被排在运行中的 query 之后。position 为 1 基队列深度。 */
  onEnqueued?: (sessionId: string, runId: string, position: number) => void
  /** 一个 run 开始执行（fromQueue=true 表示由队列 drain 触发）。 */
  onStarted?: (sessionId: string, runId: string, fromQueue: boolean) => void
  /** session 归于空闲（无 running 且队列空）。 */
  onIdle?: (sessionId: string) => void
}

interface PendingRun {
  runId: string
  run: () => Promise<void>
  /** 该排队项被 clearQueued 丢弃（永不执行）时用于释放调用方的 done await。 */
  resolveDone: () => void
  markCancelled: () => void
}

interface SessionSlot {
  running: boolean
  queue: PendingRun[]
}

export interface SubmitResult {
  /** 立即执行还是入队。 */
  status: 'started' | 'queued'
  /** started=0；queued 为 1 基队列位置。 */
  position: number
  /**
   * 本次提交的 run **settle 后** resolve（无论立即执行还是排队后执行；run 抛错
   * 也会 resolve，不 reject——错误由 run 自身处理）。调用方 await 它即可保持
   * 「发送返回 = 该轮执行完成」的原有语义，同时享受忙则入队。
   */
  done: Promise<void>
  /** true 表示该排队项被 clearQueued 丢弃、从未执行。 */
  wasCancelled(): boolean
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((res) => { resolve = res })
  return { promise, resolve }
}

export class ConversationRunQueue {
  private readonly slots = new Map<string, SessionSlot>()

  constructor(private readonly events: ConversationRunQueueEvents = {}) {}

  /** session 是否忙（有 running 或有排队）。runtime 侧 busy 真相。 */
  isBusy(sessionId: string): boolean {
    const slot = this.slots.get(sessionId)
    return !!slot && (slot.running || slot.queue.length > 0)
  }

  /** 当前排队深度（不含正在运行的）。 */
  queueDepth(sessionId: string): number {
    return this.slots.get(sessionId)?.queue.length ?? 0
  }

  /** 当前所有 busy（running 或有排队）的 sessionId，供全局状态查询 / 对账。 */
  busySessionIds(): string[] {
    const ids: string[] = []
    for (const [sessionId, slot] of this.slots) {
      if (slot.running || slot.queue.length > 0) ids.push(sessionId)
    }
    return ids
  }

  /**
   * 提交一个 run：空闲即刻执行，否则 FIFO 入队。
   *
   * `run` 是 thunk——入队时不调用，轮到时才执行（承载真实 handleQueryInternal）。
   * run 抛错不会打断队列：仍会 drain 下一条（错误由 run 自身处理 / 上报）。
   */
  submit(sessionId: string, runId: string, run: () => Promise<void>): SubmitResult {
    let slot = this.slots.get(sessionId)
    if (!slot) {
      slot = { running: false, queue: [] }
      this.slots.set(sessionId, slot)
    }

    const done = createDeferred()
    let cancelled = false
    const wasCancelled = () => cancelled
    const wrapped = async () => {
      try {
        await run()
      } finally {
        done.resolve()
      }
    }

    if (!slot.running && slot.queue.length === 0) {
      slot.running = true
      this.events.onStarted?.(sessionId, runId, false)
      void this.execute(sessionId, wrapped)
      return { status: 'started', position: 0, done: done.promise, wasCancelled }
    }

    slot.queue.push({
      runId,
      run: wrapped,
      resolveDone: done.resolve,
      markCancelled: () => { cancelled = true },
    })
    const position = slot.queue.length
    this.events.onEnqueued?.(sessionId, runId, position)
    return { status: 'queued', position, done: done.promise, wasCancelled }
  }

  private async execute(sessionId: string, run: () => Promise<void>): Promise<void> {
    try {
      await run()
    } catch {
      // run 自身负责错误处理 / 上报；队列层只保证不因单条失败而卡死。
    } finally {
      this.drainNext(sessionId)
    }
  }

  private drainNext(sessionId: string): void {
    const slot = this.slots.get(sessionId)
    if (!slot) return
    const next = slot.queue.shift()
    if (!next) {
      slot.running = false
      this.slots.delete(sessionId)
      this.events.onIdle?.(sessionId)
      return
    }
    // running 保持 true，直接接力下一条。
    this.events.onStarted?.(sessionId, next.runId, true)
    void this.execute(sessionId, next.run)
  }

  /**
   * 丢弃某 session 尚未开始的排队项（abort / reset / session 切换用）。
   * 不影响正在运行的 run。返回被丢弃的 runId 列表，供上层通知前端。
   */
  clearQueued(sessionId: string): string[] {
    const slot = this.slots.get(sessionId)
    if (!slot || slot.queue.length === 0) return []
    const dropped = slot.queue.map((q) => q.runId)
    // 释放被丢弃项调用方的 done await（这些 run 永不执行）。
    for (const q of slot.queue) {
      q.markCancelled()
      q.resolveDone()
    }
    slot.queue = []
    if (!slot.running) {
      this.slots.delete(sessionId)
      this.events.onIdle?.(sessionId)
    }
    return dropped
  }

  /** 当前所有排队项的 runId（含指定 session），供前端投影 / 调试。 */
  queuedRunIds(sessionId: string): string[] {
    return this.slots.get(sessionId)?.queue.map((q) => q.runId) ?? []
  }

  /**
   * 将指定排队项移到队首（插队），不丢弃其它项、不动 running。
   * 与 abort active 组合后，当前轮 settle 即 drain 到该 run（ Host 级插队）。
   */
  promote(sessionId: string, runId: string): { promoted: boolean; queuePosition: number } {
    const slot = this.slots.get(sessionId)
    if (!slot || slot.queue.length === 0) {
      return { promoted: false, queuePosition: 0 }
    }
    const index = slot.queue.findIndex((q) => q.runId === runId)
    if (index < 0) {
      return { promoted: false, queuePosition: 0 }
    }
    if (index > 0) {
      const [item] = slot.queue.splice(index, 1)
      slot.queue.unshift(item)
    }
    return { promoted: true, queuePosition: 1 }
  }

  /**
   * 丢弃单条尚未开始的排队项（抽屉「移除 / 撤回编辑」）。
   * 不影响 running 与其它排队项。未命中时返回 false。
   */
  dropQueued(sessionId: string, runId: string): boolean {
    const slot = this.slots.get(sessionId)
    if (!slot || slot.queue.length === 0) return false
    const index = slot.queue.findIndex((q) => q.runId === runId)
    if (index < 0) return false
    const [dropped] = slot.queue.splice(index, 1)
    dropped.markCancelled()
    dropped.resolveDone()
    if (!slot.running && slot.queue.length === 0) {
      this.slots.delete(sessionId)
      this.events.onIdle?.(sessionId)
    }
    return true
  }
}
