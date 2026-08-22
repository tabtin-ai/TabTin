/**
 * TurnEndLayoutPhase — 回合收尾内容高度预算状态机（纯逻辑，不写 DOM/scroll）。
 *
 * idle → committing → settling → released → idle。
 * 临时预算仅在 committing/settling；maxMs 硬释放防永久留白。
 */

export type TurnEndLayoutPhase = 'idle' | 'committing' | 'settling' | 'released'

export type TurnEndLayoutPhaseSnapshot = {
  phase: TurnEndLayoutPhase
  closingUiReady: boolean
  shouldHoldThinkingPreviewBudget: boolean
  shouldHoldClosingSpacer: boolean
}

export type TurnEndLayoutPhaseDeps = {
  now: () => number
  schedule: (cb: () => void, ms: number) => number
  cancel: (id: number) => void
  /** 同帧收集收尾 UI；默认 0。 */
  commitMs?: number
  /** 对齐 controller FOLLOW_SETTLE_MS；默认 120。 */
  settleMs?: number
  /** 对齐 FOLLOW_MAX_WAIT_MS；强制释放防永久留白；默认 360。 */
  maxMs?: number
}

export type TurnEndLayoutPhaseMachine = {
  beginTurnEnd(): void
  markClosingUiReady(): void
  release(): void
  getPhase(): TurnEndLayoutPhase
  shouldHoldThinkingPreviewBudget(): boolean
  shouldHoldClosingSpacer(): boolean
  getSnapshot(): TurnEndLayoutPhaseSnapshot
  subscribe(listener: () => void): () => void
  dispose(): void
}

const DEFAULT_COMMIT_MS = 0
const DEFAULT_SETTLE_MS = 120
const DEFAULT_MAX_MS = 360

function computeHoldThinkingPreviewBudget(phase: TurnEndLayoutPhase): boolean {
  return phase === 'committing' || phase === 'settling'
}

function computeHoldClosingSpacer(
  phase: TurnEndLayoutPhase,
  closingUiReady: boolean,
): boolean {
  return computeHoldThinkingPreviewBudget(phase) && !closingUiReady
}

function freezeSnapshot(
  phase: TurnEndLayoutPhase,
  closingUiReady: boolean,
): TurnEndLayoutPhaseSnapshot {
  return Object.freeze({
    phase,
    closingUiReady,
    shouldHoldThinkingPreviewBudget: computeHoldThinkingPreviewBudget(phase),
    shouldHoldClosingSpacer: computeHoldClosingSpacer(phase, closingUiReady),
  })
}

export function createTurnEndLayoutPhaseMachine(
  deps: TurnEndLayoutPhaseDeps,
): TurnEndLayoutPhaseMachine {
  const commitMs = deps.commitMs ?? DEFAULT_COMMIT_MS
  const settleMs = deps.settleMs ?? DEFAULT_SETTLE_MS
  const maxMs = deps.maxMs ?? DEFAULT_MAX_MS

  let phase: TurnEndLayoutPhase = 'idle'
  let closingUiReady = false
  let snapshot = freezeSnapshot(phase, closingUiReady)
  let disposed = false

  let commitTimerId: number | null = null
  let settleTimerId: number | null = null
  let maxTimerId: number | null = null
  let idleTimerId: number | null = null

  const listeners = new Set<() => void>()

  const notifyIfChanged = (): void => {
    const next = freezeSnapshot(phase, closingUiReady)
    if (
      next.phase === snapshot.phase
      && next.closingUiReady === snapshot.closingUiReady
      && next.shouldHoldThinkingPreviewBudget === snapshot.shouldHoldThinkingPreviewBudget
      && next.shouldHoldClosingSpacer === snapshot.shouldHoldClosingSpacer
    ) {
      return
    }
    snapshot = next
    for (const listener of listeners) listener()
  }

  const clearTimer = (id: number | null): null => {
    if (id != null) deps.cancel(id)
    return null
  }

  const cancelActiveTimers = (): void => {
    commitTimerId = clearTimer(commitTimerId)
    settleTimerId = clearTimer(settleTimerId)
    maxTimerId = clearTimer(maxTimerId)
    idleTimerId = clearTimer(idleTimerId)
  }

  const enterIdle = (): void => {
    if (disposed) return
    phase = 'idle'
    closingUiReady = false
    cancelActiveTimers()
    notifyIfChanged()
  }

  const release = (): void => {
    if (disposed) return
    if (phase === 'idle') return

    cancelActiveTimers()
    phase = 'released'
    // released/idle 均不持有预算；closingUiReady 可保留至 idle 重置
    notifyIfChanged()

    idleTimerId = deps.schedule(() => {
      idleTimerId = null
      if (disposed) return
      if (phase !== 'released') return
      enterIdle()
    }, 0)
  }

  const enterSettling = (): void => {
    if (disposed) return
    phase = 'settling'
    notifyIfChanged()

    settleTimerId = deps.schedule(() => {
      settleTimerId = null
      if (disposed) return
      release()
    }, settleMs)
  }

  const beginTurnEnd = (): void => {
    if (disposed) return

    cancelActiveTimers()
    closingUiReady = false
    phase = 'committing'
    notifyIfChanged()

    commitTimerId = deps.schedule(() => {
      commitTimerId = null
      if (disposed) return
      if (phase !== 'committing') return
      enterSettling()
    }, commitMs)

    maxTimerId = deps.schedule(() => {
      maxTimerId = null
      if (disposed) return
      release()
    }, maxMs)
  }

  const markClosingUiReady = (): void => {
    if (disposed) return
    if (closingUiReady) return
    closingUiReady = true
    notifyIfChanged()
  }

  const getPhase = (): TurnEndLayoutPhase => phase

  const shouldHoldThinkingPreviewBudget = (): boolean =>
    computeHoldThinkingPreviewBudget(phase)

  const shouldHoldClosingSpacer = (): boolean =>
    computeHoldClosingSpacer(phase, closingUiReady)

  const getSnapshot = (): TurnEndLayoutPhaseSnapshot => snapshot

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  const dispose = (): void => {
    disposed = true
    cancelActiveTimers()
    listeners.clear()
  }

  return {
    beginTurnEnd,
    markClosingUiReady,
    release,
    getPhase,
    shouldHoldThinkingPreviewBudget,
    shouldHoldClosingSpacer,
    getSnapshot,
    subscribe,
    dispose,
  }
}
