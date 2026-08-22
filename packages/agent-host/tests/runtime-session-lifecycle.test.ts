import { describe, expect, it, vi } from 'vitest'
import { ConversationSupervisor } from '../src/conversation/conversation-supervisor.js'
import { RuntimeSessionRegistry } from '../src/runtime/runtime-session-registry.js'
import { executionOwnerScopeId, type ExecutionOwner } from '../src/runtime/execution-owner-lifecycle.js'
import type { RuntimeCacheKey } from '../src/runtime/runtime-cache-key.js'
import type { RuntimeSessionRequest } from '../src/runtime/runtime-session-factory.js'
import type { RuntimeResourceFactory } from '../src/runtime/runtime-resource-factory.js'
import { DefaultRuntimeSessionLifecycle } from '../src/runtime/runtime-session-lifecycle.js'

type Mode = 'agent' | 'group'

interface BuildInput {
  label: string
  fail?: boolean
}

interface FakeSession {
  runtimeId: string
  cacheKey: RuntimeCacheKey
  mode: Mode
  owner: ExecutionOwner
  conversationId: string
  torn: boolean
}

type Request = RuntimeSessionRequest<BuildInput, Mode, never>

const ownerA: ExecutionOwner = { userId: 'user-a', organizationId: 'org-1', agentId: 'agent-1' }
const ownerB: ExecutionOwner = { userId: 'user-b', organizationId: 'org-1', agentId: 'agent-1' }

function request(modelId: string, mode: Mode = 'agent', owner: ExecutionOwner = ownerA): Request {
  return {
    sessionId: 'session-1',
    mode,
    cacheKey: {
      modelId,
      workspaceRoot: '/workspace',
      owner: { userId: owner.userId, organizationId: owner.organizationId },
      spaceId: 'space-1',
    },
    input: { label: modelId },
  }
}

function createHarness() {
  const sessions = new RuntimeSessionRegistry<FakeSession>()
  const supervisor = new ConversationSupervisor<string, string, FakeSession>({
    execute: async (r) => r,
  })
  let built = 0
  const interruptSession = vi.fn(async () => undefined)
  const teardownSession = vi.fn(async (_sessionId: string, session: FakeSession) => {
    session.torn = true
  })
  const disposeOwnerResources = vi.fn(async () => undefined)
  const resources: RuntimeResourceFactory<BuildInput, FakeSession, Mode, never, never> = {
    build: async (context) => {
      built += 1
      if (context.input.fail) throw new Error('build failed')
      return {
        runtimeId: `runtime-${built}`,
        cacheKey: context.cacheKey,
        mode: context.mode,
        owner: ownerFromCacheKey(context.cacheKey),
        conversationId: 'conversation-1',
        torn: false,
      }
    },
    getMode: (s) => s.mode,
    setMode: (s, mode) => { s.mode = mode },
    getCacheKey: (s) => s.cacheKey,
    getOwner: (s) => s.owner,
    getConversationIdentity: (sessionId, s) => ({ sessionId, conversationId: s.conversationId }),
    interruptSession,
    teardownSession,
    disposeOwnerResources,
  }
  const lifecycle = new DefaultRuntimeSessionLifecycle<
    BuildInput, FakeSession, Mode, never, never, string, string
  >({ resources, supervisor, sessions, initialOwner: ownerA })
  return { sessions, supervisor, lifecycle, interruptSession, teardownSession, disposeOwnerResources, builtCount: () => built }
}

function ownerFromCacheKey(cacheKey: RuntimeCacheKey): ExecutionOwner {
  return {
    userId: cacheKey.owner.userId,
    organizationId: cacheKey.owner.organizationId,
    agentId: 'agent-1',
  }
}

describe('DefaultRuntimeSessionLifecycle', () => {
  it('builds once then reuses on matching cache key', async () => {
    const h = createHarness()
    const first = await h.lifecycle.acquire(request('model-1'))
    const second = await h.lifecycle.acquire(request('model-1'))
    expect(first.decision).toBe('rebuild')
    expect(second.decision).toBe('reuse')
    expect(second.session).toBe(first.session)
    expect(h.builtCount()).toBe(1)
    expect(h.sessions.size).toBe(1)
  })

  it('rebuilds when the cache key changes', async () => {
    const h = createHarness()
    await h.lifecycle.acquire(request('model-1'))
    const rebuilt = await h.lifecycle.acquire(request('model-2'))
    expect(rebuilt.decision).toBe('rebuild')
    expect(h.builtCount()).toBe(2)
  })

  it('does not leave a half-built session on build failure', async () => {
    const h = createHarness()
    await expect(
      h.lifecycle.acquire({ ...request('model-1'), input: { label: 'x', fail: true } }),
    ).rejects.toThrow('build failed')
    expect(h.sessions.has('session-1')).toBe(false)
  })

  it('disposeSession interrupts, tears down and removes from the registry', async () => {
    const h = createHarness()
    await h.lifecycle.acquire(request('model-1'))
    await h.lifecycle.disposeSession({ sessionId: 'session-1', conversationId: 'conversation-1' })
    expect(h.interruptSession).toHaveBeenCalledOnce()
    expect(h.teardownSession).toHaveBeenCalledOnce()
    expect(h.sessions.has('session-1')).toBe(false)
  })

  it('replaceOwner tears down the previous owner sessions and disposes owner resources', async () => {
    const h = createHarness()
    await h.lifecycle.acquire(request('model-1', 'agent', ownerA))
    await h.lifecycle.replaceOwner(ownerB)
    expect(h.teardownSession).toHaveBeenCalledOnce()
    expect(h.disposeOwnerResources).toHaveBeenCalledOnce()
    expect(h.sessions.has('session-1')).toBe(false)
    expect(h.lifecycle.owner).toEqual(ownerB)
  })

  it('rejects acquire on a quiesced owner scope during teardown', async () => {
    const h = createHarness()
    await h.lifecycle.acquire(request('model-1', 'agent', ownerA))
    // Quiesce ownerA's runtime scope via the barrier the way owner teardown does.
    h.lifecycle.asRuntimeBarrier().quiesceScope(executionOwnerScopeId(ownerA))
    await expect(h.lifecycle.acquire(request('model-3', 'agent', ownerA))).rejects.toThrow(
      /quiesced/i,
    )
  })

  it('stop releases all remaining sessions exactly once', async () => {
    const h = createHarness()
    await h.lifecycle.acquire(request('model-1'))
    await h.lifecycle.stop()
    expect(h.sessions.size).toBe(0)
    expect(h.teardownSession).toHaveBeenCalled()
  })
})
