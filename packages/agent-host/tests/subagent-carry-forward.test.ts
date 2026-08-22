import { describe, expect, it, vi } from 'vitest'
import type { BudgetTracker } from '@tabtin/agent-runtime'
import {
  resolveSubagentCarryForward,
  resolveSubagentCompletionSpaceId,
  type SubagentManagerLike,
} from '../src/runtime/subagent-carry-forward.js'

function fakeTracker(label = 'tracker'): BudgetTracker {
  return { __label: label } as unknown as BudgetTracker
}

function fakeManager(opts: {
  disposed?: boolean
  hasBackground?: boolean
  hasCompletionBarrier?: boolean
  liveTracker?: BudgetTracker
  label?: string
}): SubagentManagerLike & { readonly __label: string } {
  return {
    __label: opts.label ?? 'manager',
    get isDisposed() {
      return !!opts.disposed
    },
    hasBackgroundRuns: () => !!opts.hasBackground,
    hasCompletionBarriers: () => !!opts.hasCompletionBarrier,
    getLiveDeps: () =>
      opts.liveTracker !== undefined ? { budgetTracker: opts.liveTracker } : undefined,
  }
}

describe('resolveSubagentCompletionSpaceId', () => {
  it('prefers live spaceId over manager snapshot / assembly / cli fallback', () => {
    expect(
      resolveSubagentCompletionSpaceId({
        liveSpaceId: 'space-live',
        liveManagerSpaceId: 'space-manager',
        assemblySpaceId: 'space-assembly',
        cliSpaceIdFallback: 'space-cli',
      }),
    ).toBe('space-live')
  })

  it('falls through in the documented order', () => {
    expect(
      resolveSubagentCompletionSpaceId({
        liveManagerSpaceId: 'space-manager',
        assemblySpaceId: 'space-assembly',
      }),
    ).toBe('space-manager')
    expect(
      resolveSubagentCompletionSpaceId({
        assemblySpaceId: 'space-assembly',
        cliSpaceIdFallback: 'space-cli',
      }),
    ).toBe('space-assembly')
    expect(
      resolveSubagentCompletionSpaceId({ cliSpaceIdFallback: 'space-cli' }),
    ).toBe('space-cli')
  })

  it('treats empty string as missing (space defense)', () => {
    expect(
      resolveSubagentCompletionSpaceId({
        liveSpaceId: '',
        liveManagerSpaceId: '',
        assemblySpaceId: 'space-assembly',
      }),
    ).toBe('space-assembly')
  })

  it('returns undefined when everything is missing (Daemon w/o CLI fallback)', () => {
    expect(
      resolveSubagentCompletionSpaceId({ cliSpaceIdFallback: null }),
    ).toBeUndefined()
    expect(resolveSubagentCompletionSpaceId({})).toBeUndefined()
  })
})

describe('resolveSubagentCarryForward', () => {
  const enqueueNotification = () => true

  it('reuses both manager and tracker when carryForward has background runs', () => {
    const liveTracker = fakeTracker('carry-tracker')
    const existing = fakeManager({
      hasBackground: true,
      liveTracker,
      label: 'existing',
    })
    const createBudgetTracker = vi.fn()
    const createSubagentManager = vi.fn()

    const result = resolveSubagentCarryForward({
      carryForwardSubagentManager: existing,
      liveSessionManager: undefined,
      maxConcurrentChildren: 5,
      maxQueueSize: 95,
      createBudgetTracker,
      createSubagentManager,
      parentThreadId: 'thread-1',
      spaceId: 'space-1',
      enqueueNotification,
    })

    expect(result.reusedBudgetTracker).toBe(true)
    expect(result.reusedManager).toBe(true)
    expect(result.budgetTracker).toBe(liveTracker)
    expect(result.subagentManager).toBe(existing)
    expect(createBudgetTracker).not.toHaveBeenCalled()
    expect(createSubagentManager).not.toHaveBeenCalled()
  })

  it('reuses manager but creates fresh tracker when no background runs', () => {
    const existing = fakeManager({ hasBackground: false, label: 'existing' })
    const freshTracker = fakeTracker('fresh-tracker')
    const createBudgetTracker = vi.fn(() => freshTracker)
    const createSubagentManager = vi.fn()

    const result = resolveSubagentCarryForward({
      carryForwardSubagentManager: existing,
      maxConcurrentChildren: 5,
      maxQueueSize: 95,
      createBudgetTracker,
      createSubagentManager,
      parentThreadId: 'thread-1',
      enqueueNotification,
    })

    expect(result.reusedManager).toBe(true)
    expect(result.reusedBudgetTracker).toBe(false)
    expect(result.subagentManager).toBe(existing)
    expect(result.budgetTracker).toBe(freshTracker)
    expect(createBudgetTracker).toHaveBeenCalledWith({
      maxConcurrentChildren: 5,
      maxQueueSize: 95,
    })
    expect(createSubagentManager).not.toHaveBeenCalled()
  })

  it('reuses both manager and tracker when carryForward has submitted completion barriers', () => {
    const liveTracker = fakeTracker('barrier-tracker')
    const existing = fakeManager({
      hasBackground: false,
      hasCompletionBarrier: true,
      liveTracker,
      label: 'existing',
    })
    const createBudgetTracker = vi.fn()
    const createSubagentManager = vi.fn()

    const result = resolveSubagentCarryForward({
      carryForwardSubagentManager: existing,
      maxConcurrentChildren: 5,
      maxQueueSize: 95,
      createBudgetTracker,
      createSubagentManager,
      parentThreadId: 'thread-barrier',
      enqueueNotification,
    })

    expect(result.reusedBudgetTracker).toBe(true)
    expect(result.reusedManager).toBe(true)
    expect(result.budgetTracker).toBe(liveTracker)
    expect(result.subagentManager).toBe(existing)
    expect(createBudgetTracker).not.toHaveBeenCalled()
    expect(createSubagentManager).not.toHaveBeenCalled()
  })

  it('creates fresh tracker and manager when existing is disposed', () => {
    const disposed = fakeManager({
      disposed: true,
      hasBackground: true,
      liveTracker: fakeTracker('should-be-ignored'),
    })
    const freshTracker = fakeTracker('fresh')
    const freshManager = fakeManager({ label: 'fresh-manager' })
    const createBudgetTracker = vi.fn(() => freshTracker)
    const createSubagentManager = vi.fn(() => freshManager)

    const result = resolveSubagentCarryForward({
      carryForwardSubagentManager: disposed,
      maxConcurrentChildren: 5,
      maxQueueSize: 95,
      createBudgetTracker,
      createSubagentManager,
      parentThreadId: 'thread-2',
      spaceId: 'space-2',
      enqueueNotification,
    })

    expect(result.reusedManager).toBe(false)
    expect(result.reusedBudgetTracker).toBe(false)
    expect(result.subagentManager).toBe(freshManager)
    expect(result.budgetTracker).toBe(freshTracker)
    expect(createSubagentManager).toHaveBeenCalledWith(
      expect.objectContaining({
        parentThreadId: 'thread-2',
        spaceId: 'space-2',
        budgetTracker: freshTracker,
        enqueueNotification,
      }),
    )
  })

  it('falls back to liveSessionManager when carryForward is missing', () => {
    const live = fakeManager({ hasBackground: false, label: 'live' })
    const freshTracker = fakeTracker('fresh')
    const createBudgetTracker = vi.fn(() => freshTracker)
    const createSubagentManager = vi.fn()

    const result = resolveSubagentCarryForward({
      liveSessionManager: live,
      maxConcurrentChildren: 5,
      maxQueueSize: 95,
      createBudgetTracker,
      createSubagentManager,
      parentThreadId: 'thread-3',
      enqueueNotification,
    })

    expect(result.reusedManager).toBe(true)
    expect(result.subagentManager).toBe(live)
    expect(createSubagentManager).not.toHaveBeenCalled()
  })

  it('creates both fresh when nothing exists', () => {
    const freshTracker = fakeTracker('fresh')
    const freshManager = fakeManager({ label: 'fresh-manager' })
    const createBudgetTracker = vi.fn(() => freshTracker)
    const createSubagentManager = vi.fn(() => freshManager)

    const result = resolveSubagentCarryForward({
      maxConcurrentChildren: 5,
      maxQueueSize: 95,
      createBudgetTracker,
      createSubagentManager,
      parentThreadId: 'thread-4',
      enqueueNotification,
    })

    expect(result.reusedManager).toBe(false)
    expect(result.reusedBudgetTracker).toBe(false)
    expect(result.subagentManager).toBe(freshManager)
    expect(result.budgetTracker).toBe(freshTracker)
  })

  it('falls back to fresh tracker when hasBackgroundRuns but getLiveDeps has no tracker', () => {
    const existing = fakeManager({ hasBackground: true, liveTracker: undefined })
    const freshTracker = fakeTracker('fresh')
    const createBudgetTracker = vi.fn(() => freshTracker)
    const createSubagentManager = vi.fn()

    const result = resolveSubagentCarryForward({
      carryForwardSubagentManager: existing,
      maxConcurrentChildren: 5,
      maxQueueSize: 95,
      createBudgetTracker,
      createSubagentManager,
      parentThreadId: 'thread-5',
      enqueueNotification,
    })

    expect(result.reusedManager).toBe(true)
    expect(result.reusedBudgetTracker).toBe(false)
    expect(result.budgetTracker).toBe(freshTracker)
    expect(result.subagentManager).toBe(existing)
  })
})
