import { describe, expect, it, vi } from 'vitest'
import { ConversationSupervisor } from '../src/conversation/conversation-supervisor.js'
import {
  ExecutionOwnerLifecycle,
  executionOwnerScopeId,
  type ExecutionOwner,
  type OwnerRuntimeBarrier,
} from '../src/runtime/execution-owner-lifecycle.js'
import { RuntimeSessionRegistry } from '../src/runtime/runtime-session-registry.js'

interface SessionState {
  owner: ExecutionOwner
  conversationId: string
}

const ownerA: ExecutionOwner = {
  userId: 'user-a',
  organizationId: 'organization-1',
  agentId: 'agent-1',
}
const ownerB: ExecutionOwner = {
  userId: 'user-b',
  organizationId: 'organization-1',
  agentId: 'agent-1',
}
const ownerC: ExecutionOwner = {
  userId: 'user-c',
  organizationId: 'organization-1',
  agentId: 'agent-1',
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function createHarness(options: {
  execute?: () => Promise<string>
  teardownSession?: (sessionId: string, session: SessionState) => Promise<void>
  disposeOwnerResources?: (owner: ExecutionOwner) => Promise<void>
  runtimeBarrier?: OwnerRuntimeBarrier
} = {}) {
  const sessions = new RuntimeSessionRegistry<SessionState>()
  const supervisor = new ConversationSupervisor<string, string, SessionState>({
    execute: options.execute ?? (async request => request),
  })
  const interruptSession = vi.fn(async () => undefined)
  const teardownSession = vi.fn(
    options.teardownSession ?? (async () => undefined),
  )
  const disposeOwnerResources = vi.fn(
    options.disposeOwnerResources ?? (async () => undefined),
  )
  const lifecycle = new ExecutionOwnerLifecycle({
    supervisor,
    sessions,
    runtimeBarrier: options.runtimeBarrier ?? {
      quiesceScope: () => undefined,
      restoreScope: () => undefined,
      waitForScopeIdle: async () => undefined,
    },
    initialOwner: ownerA,
    adapter: {
      getOwner: session => session.owner,
      getConversationIdentity: (sessionId, session) => ({
        sessionId,
        conversationId: session.conversationId,
      }),
      interruptSession,
      teardownSession,
      disposeOwnerResources,
    },
  })
  return {
    sessions,
    supervisor,
    lifecycle,
    interruptSession,
    teardownSession,
    disposeOwnerResources,
  }
}

describe('ExecutionOwnerLifecycle', () => {
  it('waits for the old owner in-flight query before tearing down sessions', async () => {
    const runningGate = deferred()
    const harness = createHarness({
      execute: async () => {
        await runningGate.promise
        return 'done'
      },
    })
    harness.sessions.set('session-1', {
      owner: ownerA,
      conversationId: 'conversation-1',
    })
    const running = harness.supervisor.submit({
      conversationId: 'conversation-1',
      sessionId: 'session-1',
      lifecycleScopeId: executionOwnerScopeId(ownerA),
      runId: 'run-1',
      request: 'query',
    })

    const replacing = harness.lifecycle.replace(ownerB)
    await Promise.resolve()
    expect(harness.interruptSession).toHaveBeenCalledOnce()
    expect(harness.teardownSession).not.toHaveBeenCalled()

    runningGate.resolve()
    await running
    await expect(replacing).resolves.toBe(true)
    expect(harness.teardownSession).toHaveBeenCalledOnce()
    expect(harness.sessions.has('session-1')).toBe(false)
    expect(harness.lifecycle.owner).toEqual(ownerB)
  })

  it('serializes concurrent owner replacements', async () => {
    const firstDisposeGate = deferred()
    const order: string[] = []
    const harness = createHarness({
      disposeOwnerResources: async (owner) => {
        order.push(`start:${owner.userId}`)
        if (owner.userId === ownerA.userId) await firstDisposeGate.promise
        order.push(`end:${owner.userId}`)
      },
    })

    const replaceWithB = harness.lifecycle.replace(ownerB)
    const replaceWithC = harness.lifecycle.replace(ownerC)
    await vi.waitFor(() => {
      expect(order).toEqual(['start:user-a'])
    })

    firstDisposeGate.resolve()
    await Promise.all([replaceWithB, replaceWithC])
    expect(order).toEqual([
      'start:user-a',
      'end:user-a',
      'start:user-b',
      'end:user-b',
    ])
    expect(harness.lifecycle.owner).toEqual(ownerC)
  })

  it('waits for runtime creation before taking the teardown snapshot', async () => {
    const runtimeIdle = deferred()
    const harness = createHarness({
      runtimeBarrier: {
        quiesceScope: vi.fn(),
        restoreScope: vi.fn(),
        waitForScopeIdle: () => runtimeIdle.promise,
      },
    })

    const replacing = harness.lifecycle.replace(ownerB)
    await Promise.resolve()
    harness.sessions.set('late-session', {
      owner: ownerA,
      conversationId: 'late-conversation',
    })
    expect(harness.teardownSession).not.toHaveBeenCalled()

    runtimeIdle.resolve()
    await replacing
    expect(harness.teardownSession).toHaveBeenCalledWith(
      'late-session',
      expect.anything(),
    )
    expect(harness.sessions.has('late-session')).toBe(false)
  })

  it('disposeOwner tears down sessions and dispatches disposeOwnerResources even without a matching current owner', async () => {
    const harness = createHarness()
    harness.sessions.set('session-fresh', {
      owner: ownerB,
      conversationId: 'conversation-b',
    })

    await harness.lifecycle.disposeOwner(ownerB)

    expect(harness.teardownSession).toHaveBeenCalledWith(
      'session-fresh',
      expect.anything(),
    )
    expect(harness.disposeOwnerResources).toHaveBeenCalledWith(
      expect.objectContaining({ userId: ownerB.userId }),
    )
    expect(harness.sessions.has('session-fresh')).toBe(false)
    // currentOwner (ownerA) is preserved because it does not match the
    // disposal target — disposeOwner is scoped to targetOwner only.
    expect(harness.lifecycle.owner).toEqual(ownerA)
  })

  it('disposeOwner clears currentOwner and restores the scope so the same account can re-authenticate', async () => {
    const restoreScope = vi.fn()
    const harness = createHarness({
      runtimeBarrier: {
        quiesceScope: vi.fn(),
        restoreScope,
        waitForScopeIdle: async () => undefined,
      },
    })

    await harness.lifecycle.disposeOwner(ownerA)

    expect(harness.lifecycle.owner).toBeUndefined()
    expect(restoreScope).toHaveBeenCalledWith(executionOwnerScopeId(ownerA))
  })

  it('keeps failed transitions retryable and ignores stale clear requests', async () => {
    let attempts = 0
    const harness = createHarness({
      teardownSession: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('teardown failed')
      },
    })
    harness.sessions.set('session-1', {
      owner: ownerA,
      conversationId: 'conversation-1',
    })

    await expect(harness.lifecycle.replace(ownerB)).rejects.toThrow(
      'Execution owner lifecycle step failed',
    )
    expect(harness.lifecycle.owner).toEqual(ownerA)
    expect(harness.sessions.has('session-1')).toBe(true)

    await expect(harness.lifecycle.replace(ownerB)).resolves.toBe(true)
    expect(harness.lifecycle.owner).toEqual(ownerB)
    expect(harness.sessions.has('session-1')).toBe(false)
    await expect(harness.lifecycle.clear(ownerA)).resolves.toBe(false)
    expect(harness.disposeOwnerResources).toHaveBeenCalledTimes(1)
    expect(harness.lifecycle.owner).toEqual(ownerB)
  })
})
