import { describe, expect, it, vi } from 'vitest'
import {
  createTurnEndLayoutPhaseMachine,
  type TurnEndLayoutPhaseSnapshot,
} from '../turnEndLayoutPhase'

function createManualTimer(nowRef: { current: number }) {
  let nextId = 1
  const pending = new Map<number, { fireAt: number; callback: () => void }>()
  return {
    schedule(callback: () => void, delayMs: number): number {
      const id = nextId++
      pending.set(id, { fireAt: nowRef.current + delayMs, callback })
      return id
    },
    cancel(id: number): void {
      pending.delete(id)
    },
    advance(ms: number): void {
      nowRef.current += ms
      const due = [...pending.entries()]
        .filter(([, item]) => item.fireAt <= nowRef.current)
        .sort((a, b) => a[1].fireAt - b[1].fireAt)
      for (const [id, item] of due) {
        if (!pending.has(id)) continue
        pending.delete(id)
        item.callback()
      }
    },
    get size() {
      return pending.size
    },
    get entries() {
      return [...pending.entries()].map(([id, item]) => ({
        id,
        delay: item.fireAt - nowRef.current,
        fireAt: item.fireAt,
        callback: item.callback,
      }))
    },
  }
}

function createHarness(options?: {
  commitMs?: number
  settleMs?: number
  maxMs?: number
}) {
  const nowRef = { current: 1_000 }
  const timer = createManualTimer(nowRef)
  const machine = createTurnEndLayoutPhaseMachine({
    now: () => nowRef.current,
    schedule: timer.schedule,
    cancel: timer.cancel,
    commitMs: options?.commitMs,
    settleMs: options?.settleMs,
    maxMs: options?.maxMs,
  })
  return { machine, timer, nowRef }
}

function expectFrozenSnapshot(snapshot: TurnEndLayoutPhaseSnapshot): void {
  expect(Object.isFrozen(snapshot)).toBe(true)
}

describe('turnEndLayoutPhase', () => {
  it('starts idle and ignores release while idle', () => {
    const m = createTurnEndLayoutPhaseMachine({
      now: () => 0,
      schedule: vi.fn(),
      cancel: vi.fn(),
    })
    expect(m.getPhase()).toBe('idle')
    expect(m.getSnapshot()).toEqual({
      phase: 'idle',
      closingUiReady: false,
      shouldHoldThinkingPreviewBudget: false,
      shouldHoldClosingSpacer: false,
    })
    m.release()
    expect(m.getPhase()).toBe('idle')
  })

  it('beginTurnEnd: idle → committing → settling after commit window', () => {
    const timers: Array<{ id: number; cb: () => void; ms: number }> = []
    let id = 1
    const m = createTurnEndLayoutPhaseMachine({
      now: () => 1000,
      schedule: (cb, ms) => {
        const timerId = id++
        timers.push({ id: timerId, cb, ms })
        return timerId
      },
      cancel: (timerId) => {
        const i = timers.findIndex((t) => t.id === timerId)
        if (i >= 0) timers.splice(i, 1)
      },
      commitMs: 0,
      settleMs: 120,
      maxMs: 360,
    })
    m.beginTurnEnd()
    expect(m.getPhase()).toBe('committing')
    // commitMs=0 → 立即进入 settling
    timers.shift()!.cb()
    expect(m.getPhase()).toBe('settling')
  })

  it('release during settling → released then idle; budget helpers flip', () => {
    const m = createTurnEndLayoutPhaseMachine({
      now: () => 0,
      schedule: vi.fn(() => 1),
      cancel: vi.fn(),
      commitMs: 50,
      settleMs: 120,
      maxMs: 360,
    })
    m.beginTurnEnd()
    expect(m.shouldHoldThinkingPreviewBudget()).toBe(true)
    expect(m.shouldHoldClosingSpacer()).toBe(true)
    m.markClosingUiReady()
    m.release()
    expect(m.getPhase()).toBe('released')
    expect(m.shouldHoldThinkingPreviewBudget()).toBe(false)
    expect(m.shouldHoldClosingSpacer()).toBe(false)
  })

  it('maxMs forces release to avoid permanent blank space', () => {
    const timers: Array<{ cb: () => void; ms: number }> = []
    const m = createTurnEndLayoutPhaseMachine({
      now: () => 0,
      schedule: (cb, ms) => {
        timers.push({ cb, ms })
        return timers.length
      },
      cancel: vi.fn(),
      commitMs: 50,
      settleMs: 120,
      maxMs: 360,
    })
    m.beginTurnEnd()
    const maxTimer = timers.find((t) => t.ms === 360)
    expect(maxTimer).toBeTruthy()
    maxTimer!.cb()
    expect(['released', 'idle']).toContain(m.getPhase())
    expect(m.shouldHoldClosingSpacer()).toBe(false)
  })

  it('second beginTurnEnd while active restarts window without stacking forever', () => {
    const cancel = vi.fn()
    const m = createTurnEndLayoutPhaseMachine({
      now: () => 0,
      schedule: vi.fn(() => 7),
      cancel,
      commitMs: 50,
      settleMs: 120,
      maxMs: 360,
    })
    m.beginTurnEnd()
    m.beginTurnEnd()
    expect(cancel).toHaveBeenCalled()
    expect(m.getPhase()).toBe('committing')
  })

  it('defaults commitMs=0 settleMs=120 maxMs=360', () => {
    const { machine, timer } = createHarness()
    machine.beginTurnEnd()
    expect(machine.getPhase()).toBe('committing')
    const delays = timer.entries.map((e) => e.delay).sort((a, b) => a - b)
    expect(delays).toEqual([0, 360])

    timer.advance(0)
    expect(machine.getPhase()).toBe('settling')
    const settleDelays = timer.entries.map((e) => e.delay).sort((a, b) => a - b)
    expect(settleDelays).toContain(120)
    expect(settleDelays).toContain(360)
  })

  it('markClosingUiReady only flips spacer flag and does not release', () => {
    const { machine, timer } = createHarness({ commitMs: 50 })
    machine.beginTurnEnd()
    expect(machine.shouldHoldClosingSpacer()).toBe(true)
    expect(machine.shouldHoldThinkingPreviewBudget()).toBe(true)

    machine.markClosingUiReady()
    expect(machine.getPhase()).toBe('committing')
    expect(machine.getSnapshot().closingUiReady).toBe(true)
    expect(machine.shouldHoldClosingSpacer()).toBe(false)
    expect(machine.shouldHoldThinkingPreviewBudget()).toBe(true)
    expect(timer.size).toBeGreaterThan(0)
  })

  it('settle timer releases after settleMs', () => {
    const { machine, timer } = createHarness({ commitMs: 0, settleMs: 120, maxMs: 360 })
    machine.beginTurnEnd()
    timer.advance(0)
    expect(machine.getPhase()).toBe('settling')

    timer.advance(120)
    expect(machine.getPhase()).toBe('released')
    expect(machine.shouldHoldThinkingPreviewBudget()).toBe(false)
    expect(machine.shouldHoldClosingSpacer()).toBe(false)

    timer.advance(0)
    expect(machine.getPhase()).toBe('idle')
  })

  it('caches frozen snapshots and only notifies subscribers on change', () => {
    const { machine, timer } = createHarness({ commitMs: 0 })
    const listener = vi.fn()
    const unsubscribe = machine.subscribe(listener)

    const initial = machine.getSnapshot()
    expectFrozenSnapshot(initial)
    expect(machine.getSnapshot()).toBe(initial)
    expect(listener).not.toHaveBeenCalled()

    machine.beginTurnEnd()
    const committing = machine.getSnapshot()
    expect(committing).not.toBe(initial)
    expectFrozenSnapshot(committing)
    expect(committing).toEqual({
      phase: 'committing',
      closingUiReady: false,
      shouldHoldThinkingPreviewBudget: true,
      shouldHoldClosingSpacer: true,
    })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(machine.getSnapshot()).toBe(committing)

    // 无状态变化：重复 mark 不通知
    machine.markClosingUiReady()
    const ready = machine.getSnapshot()
    expect(ready).not.toBe(committing)
    expect(ready.closingUiReady).toBe(true)
    expect(ready.shouldHoldClosingSpacer).toBe(false)
    expect(listener).toHaveBeenCalledTimes(2)

    machine.markClosingUiReady()
    expect(machine.getSnapshot()).toBe(ready)
    expect(listener).toHaveBeenCalledTimes(2)

    timer.advance(0)
    const settling = machine.getSnapshot()
    expect(settling.phase).toBe('settling')
    expect(settling.closingUiReady).toBe(true)
    expect(listener).toHaveBeenCalledTimes(3)

    unsubscribe()
    machine.release()
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('dispose cancels timers; stale callbacks and commands do not revive state', () => {
    const { machine, timer } = createHarness({ commitMs: 50, settleMs: 120, maxMs: 360 })
    const listener = vi.fn()
    machine.subscribe(listener)

    machine.beginTurnEnd()
    const before = machine.getSnapshot()
    expect(before.phase).toBe('committing')
    expect(timer.size).toBeGreaterThan(0)

    const staleCallbacks = timer.entries.map((e) => e.callback)
    machine.dispose()
    expect(timer.size).toBe(0)
    expect(machine.getSnapshot()).toBe(before)
    expect(listener).toHaveBeenCalledTimes(1)

    for (const cb of staleCallbacks) cb()
    expect(machine.getPhase()).toBe('committing')
    expect(machine.getSnapshot()).toBe(before)
    expect(listener).toHaveBeenCalledTimes(1)

    machine.beginTurnEnd()
    machine.markClosingUiReady()
    machine.release()
    expect(machine.getPhase()).toBe('committing')
    expect(machine.getSnapshot()).toBe(before)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(timer.size).toBe(0)
  })

  it('second begin resets closingUiReady and restarts timers without stacking', () => {
    const { machine, timer } = createHarness({ commitMs: 50, settleMs: 120, maxMs: 360 })
    machine.beginTurnEnd()
    machine.markClosingUiReady()
    expect(machine.getSnapshot().closingUiReady).toBe(true)
    expect(timer.size).toBe(2)

    machine.beginTurnEnd()
    expect(machine.getPhase()).toBe('committing')
    expect(machine.getSnapshot().closingUiReady).toBe(false)
    expect(machine.shouldHoldClosingSpacer()).toBe(true)
    expect(timer.size).toBe(2)
  })
})
