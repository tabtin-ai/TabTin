import { describe, expect, it, vi } from 'vitest'
import {
  RuntimeSessionFactory,
  RuntimeOwnerQuiescedError,
  type RuntimeSessionRequest,
} from '../src/runtime/runtime-session-factory.js'
import { executionOwnerScopeId } from '../src/runtime/execution-owner-lifecycle.js'
import {
  createRuntimeCacheKey,
  type RuntimeCacheKey,
} from '../src/runtime/runtime-cache-key.js'
import { RuntimeSessionRegistry } from '../src/runtime/runtime-session-registry.js'

interface BuildInput {
  label: string
  fail?: boolean
}

interface SessionState {
  manager: { id: string }
  budget: { spent: number }
}

interface TestSession {
  runtime: { id: string }
  state: SessionState
  cacheKey: RuntimeCacheKey
  mode: 'agent' | 'group'
  extraKey?: never
}

type Request = RuntimeSessionRequest<BuildInput, 'agent' | 'group', never>

function request(
  modelId: string,
  mode: 'agent' | 'group' = 'agent',
  input: BuildInput = { label: modelId },
  userId = 'user-1',
): Request {
  return {
    sessionId: 'session-1',
    mode,
    cacheKey: {
      modelId,
      workspaceRoot: '/workspace',
      owner: {
        userId,
        organizationId: 'organization-1',
      },
      spaceId: 'space-1',
    },
    input,
  }
}

function createFactory(adapter: {
  build: (context: {
    carryForward: SessionState | undefined
    input: BuildInput
    cacheKey: RuntimeCacheKey
    mode: 'agent' | 'group'
  }) => Promise<{ runtime: { id: string }; state: SessionState }>
  softReconfigure?: (
    existing: TestSession,
    request: Request,
  ) => Promise<void>
  canSoftReconfigure?: (existing: TestSession, request: Request) => boolean
  captureCarryForward?: (existing: TestSession) => SessionState
  teardownForRebuild?: (
    existing: TestSession,
    carryForward: SessionState | undefined,
  ) => Promise<void>
}) {
  return new RuntimeSessionFactory<
    BuildInput,
    TestSession,
    'agent' | 'group',
    SessionState
  >({
    build: async (context) => {
      const built = await adapter.build(context)
      return {
        runtime: built.runtime,
        state: built.state,
        cacheKey: context.cacheKey,
        mode: context.mode,
      }
    },
    getMode: (session) => session.mode,
    setMode: (session, mode) => {
      session.mode = mode
    },
    getCacheKey: (session) => session.cacheKey,
    softReconfigure: adapter.softReconfigure,
    canSoftReconfigure: adapter.canSoftReconfigure,
    captureCarryForward: adapter.captureCarryForward,
    teardownForRebuild: adapter.teardownForRebuild,
  })
}

describe('RuntimeSessionFactory', () => {
  it('reuses the same runtime when cache key and mode match', async () => {
    const build = vi.fn(async () => ({
      runtime: { id: 'runtime-1' },
      state: {
        manager: { id: 'manager-1' },
        budget: { spent: 0 },
      },
    }))
    const factory = createFactory({ build })

    const first = await factory.resolve(request('model-1'))
    const second = await factory.resolve(request('model-1'))

    expect(first.decision).toBe('rebuild')
    expect(second.decision).toBe('reuse')
    expect(second.session).toBe(first.session)
    expect(build).toHaveBeenCalledOnce()
  })

  it('soft-reconfigures mode without rebuilding runtime', async () => {
    const build = vi.fn(async () => ({
      runtime: { id: 'runtime-1' },
      state: {
        manager: { id: 'manager-1' },
        budget: { spent: 0 },
      },
    }))
    const softReconfigure = vi.fn(async () => undefined)
    const factory = createFactory({
      build,
      softReconfigure,
      canSoftReconfigure: () => true,
    })
    const first = await factory.resolve(request('model-1'))

    const switched = await factory.resolve(request('model-1', 'group'))

    expect(switched.decision).toBe('soft-reconfigure')
    expect(switched.session).toBe(first.session)
    expect(switched.session.mode).toBe('group')
    expect(softReconfigure).toHaveBeenCalledOnce()
    expect(build).toHaveBeenCalledOnce()
  })

  it('carries session-owned state across a rebuild', async () => {
    const manager = { id: 'manager-1' }
    const budget = { spent: 7 }
    const build = vi.fn(async (context: {
      carryForward: SessionState | undefined
      input: BuildInput
    }) => ({
      runtime: { id: `runtime-${context.input.label}` },
      state: context.carryForward ?? { manager, budget },
    }))
    const teardownForRebuild = vi.fn(async () => undefined)
    const factory = createFactory({
      build,
      captureCarryForward: existing => existing.state,
      teardownForRebuild,
    })
    await factory.resolve(request('model-1'))

    const rebuilt = await factory.resolve(request('model-2'))

    expect(rebuilt.decision).toBe('rebuild')
    expect(rebuilt.session.state.manager).toBe(manager)
    expect(rebuilt.session.state.budget).toBe(budget)
    expect(teardownForRebuild).toHaveBeenCalledOnce()
    expect(build.mock.calls[1]?.[0].carryForward).toEqual({ manager, budget })
  })

  it('retains carry-forward state when build fails so resolution can retry', async () => {
    const carried: SessionState = {
      manager: { id: 'manager-1' },
      budget: { spent: 3 },
    }
    const build = vi.fn(async (context: {
      carryForward: SessionState | undefined
      input: BuildInput
    }) => {
      if (context.input.fail) throw new Error('build failed')
      return {
        runtime: { id: `runtime-${context.input.label}` },
        state: context.carryForward ?? carried,
      }
    })
    const factory = createFactory({
      build,
      captureCarryForward: existing => existing.state,
      teardownForRebuild: async () => undefined,
    })
    await factory.resolve(request('model-1'))

    await expect(factory.resolve(request('model-2', 'agent', {
      label: 'failed',
      fail: true,
    }))).rejects.toThrow('build failed')
    expect(factory.sessions.has('session-1')).toBe(false)

    const retried = await factory.resolve(request('model-2', 'agent', {
      label: 'retried',
    }))
    expect(retried.session.state).toBe(carried)
    expect(build.mock.calls[2]?.[0].carryForward).toBe(carried)
  })

  it('never carries failed rebuild state into another owner', async () => {
    const ownerAState: SessionState = {
      manager: { id: 'owner-a-manager' },
      budget: { spent: 5 },
    }
    const build = vi.fn(async (context: {
      carryForward: SessionState | undefined
      input: BuildInput
    }) => {
      if (context.input.fail) throw new Error('build failed')
      return {
        runtime: { id: context.input.label },
        state: context.carryForward
          ?? (context.input.label === 'owner-a'
            ? ownerAState
            : {
                manager: { id: `${context.input.label}-manager` },
                budget: { spent: 0 },
              }),
      }
    })
    const factory = createFactory({
      build,
      captureCarryForward: existing => existing.state,
      teardownForRebuild: async () => undefined,
    })
    await factory.resolve(request('model-1', 'agent', { label: 'owner-a' }))

    await expect(factory.resolve(request('model-2', 'agent', {
      label: 'failed',
      fail: true,
    }))).rejects.toThrow('build failed')

    const ownerB = await factory.resolve(request(
      'model-2',
      'agent',
      { label: 'owner-b' },
      'user-2',
    ))
    expect(ownerB.session.state).not.toBe(ownerAState)
    expect(ownerB.session.state.manager.id).toBe('owner-b-manager')
    expect(build.mock.calls[2]?.[0].carryForward).toBeUndefined()
  })

  it('never carries a live session state into another owner', async () => {
    const build = vi.fn(async (context: {
      carryForward: SessionState | undefined
      input: BuildInput
    }) => ({
      runtime: { id: context.input.label },
      state: context.carryForward ?? {
        manager: { id: `${context.input.label}-manager` },
        budget: { spent: 0 },
      },
    }))
    const factory = createFactory({
      build,
      captureCarryForward: existing => existing.state,
      teardownForRebuild: async () => undefined,
    })
    await factory.resolve(request('model-1', 'agent', { label: 'owner-a' }))

    const ownerB = await factory.resolve(request(
      'model-1',
      'agent',
      { label: 'owner-b' },
      'user-2',
    ))
    expect(ownerB.session.state.manager.id).toBe('owner-b-manager')
    expect(build.mock.calls[1]?.[0].carryForward).toBeUndefined()
  })

  it('blocks new runtime resolution while an owner scope is quiesced', async () => {
    const factory = createFactory({
      build: async () => ({
        runtime: { id: 'runtime-1' },
        state: { manager: { id: 'm' }, budget: { spent: 0 } },
      }),
    })
    const owner = {
      userId: 'user-1',
      organizationId: 'organization-1',
    }
    const scopeId = executionOwnerScopeId(owner)
    expect(scopeId).toBe('user-1|organization-1')
    factory.quiesceScope(scopeId)

    await expect(factory.resolve(request('model-1'))).rejects.toBeInstanceOf(
      RuntimeOwnerQuiescedError,
    )
    factory.restoreScope(scopeId)
    await expect(factory.resolve(request('model-1'))).resolves.toMatchObject({
      decision: 'rebuild',
    })
  })

  it('snapshots owner identity before asynchronous runtime resolution', async () => {
    const factory = createFactory({
      build: async (context) => ({
        runtime: { id: context.cacheKey.owner.userId },
        state: { manager: { id: 'm' }, budget: { spent: 0 } },
      }),
    })
    const mutableRequest = request('model-1')
    const resolving = factory.resolve(mutableRequest)
    mutableRequest.cacheKey.owner.userId = 'mutated-user'

    const resolved = await resolving
    expect(resolved.session.cacheKey.owner.userId).toBe('user-1')
    expect(resolved.session.runtime.id).toBe('user-1')
  })

  it('accepts an injected shared session registry', async () => {
    const shared = new RuntimeSessionRegistry<TestSession>()
    const factory = new RuntimeSessionFactory<
      BuildInput,
      TestSession,
      'agent' | 'group',
      SessionState
    >({
      build: async (context) => ({
        runtime: { id: 'runtime-1' },
        state: { manager: { id: 'm' }, budget: { spent: 0 } },
        cacheKey: createRuntimeCacheKey(context.cacheKey),
        mode: context.mode,
      }),
      getMode: (session) => session.mode,
      setMode: (session, mode) => {
        session.mode = mode
      },
      getCacheKey: (session) => session.cacheKey,
    }, shared)

    await factory.resolve(request('model-1'))
    expect(shared.has('session-1')).toBe(true)
    expect(factory.sessions).toBe(shared)
  })
})
