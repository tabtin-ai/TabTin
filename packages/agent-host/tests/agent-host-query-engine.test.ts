import { describe, expect, it, vi } from 'vitest'
import type { StreamEvent } from '@tabtin/agent-runtime'
import { AgentHost } from '../src/agent-host.js'
import type { AgentPlatformAdapter } from '../src/agent-platform-adapter.js'
import type { RuntimeResourceFactory } from '../src/runtime/runtime-resource-factory.js'
import type { RuntimeCacheKey } from '../src/runtime/runtime-cache-key.js'
import type {
  DeliveryTransportPort,
  LocalStreamPort,
} from '../src/delivery/delivery-transport-port.js'
import type { QueryTurnDataPort } from '../src/conversation/query-turn-pipeline.js'
import type { HostQuery } from '../src/conversation/host-query.js'
import type { ExecutionOwner } from '../src/runtime/execution-owner-lifecycle.js'

type Mode = 'agent'
interface BuildInput { label: string }
interface FakeSession {
  runtime: { query(params: unknown): AsyncIterable<StreamEvent> }
  cacheKey: RuntimeCacheKey
  mode: Mode
  owner: ExecutionOwner
  conversationId: string
  policyContext: { currentAgentMode: string; isGroupSpace: boolean; requestedApprovalMode?: unknown }
  agentConfigV3: null
  abortController: AbortController
}

const owner: ExecutionOwner = { userId: 'user-1', organizationId: 'org-1', agentId: 'agent-1' }

function noopTransportPort(): AgentPlatformAdapter<unknown, unknown, FakeSession>['transport'] {
  return {
    subscribe: () => undefined,
    unsubscribe: () => undefined,
    onEnvelope: () => () => undefined,
  }
}

async function* runtimeStream(): AsyncIterable<StreamEvent> {
  yield { type: 'agent.stream.lifecycle', payload: { phase: 'start', trace_id: 't1' } } as StreamEvent
  yield { type: 'agent.stream.assistant', payload: { phase: 'final', text: 'hi' } } as StreamEvent
  yield { type: 'agent.stream.done', payload: {} } as StreamEvent
}

function buildSession(cacheKey: RuntimeCacheKey, mode: Mode): FakeSession {
  return {
    runtime: { query: runtimeStream },
    cacheKey,
    mode,
    owner,
    conversationId: 'conversation-1',
    policyContext: { currentAgentMode: 'agent', isGroupSpace: false },
    agentConfigV3: null,
    abortController: new AbortController(),
  }
}

function fakeSessionView(session: FakeSession) {
  return {
    abortController: session.abortController,
    pauseController: { waitIfPaused: async () => undefined },
    sessionStorage: {
      hasPendingRewind: () => false,
      commitRewind: async () => null,
      ensureBlockBackfillFromTranscript: async () => undefined,
      recordUserMessage: async () => undefined,
      appendUserBlockRecord: async () => undefined,
      restoreMessages: async () => [],
      loadBlockRecords: async () => [],
      appendStreamEvent: async () => undefined,
    },
    eventStorage: { truncateFrom: async () => undefined, append: async () => undefined },
    snapshotStorage: { append: async () => undefined },
    toolProvider: { setSubagentTraceWiring: () => undefined },
    eventEmitter: { buildStream: (e: StreamEvent) => e },
    eventInterceptor: undefined as ((e: StreamEvent) => void) | undefined,
  }
}

function hostQuery(): HostQuery<BuildInput, Mode, never> {
  return {
    identity: { conversationId: 'conversation-1', sessionId: 'session-1', runId: 'run-1', owner },
    runtime: {
      sessionId: 'session-1',
      mode: 'agent',
      cacheKey: { modelId: 'model-1', owner: { userId: owner.userId, organizationId: owner.organizationId } },
      input: { label: 'x' },
    },
    turn: { prompt: 'hello', clientMessageId: 'cme-1' },
    policy: { agentMode: 'agent' },
  }
}

function noopAdapter(): AgentPlatformAdapter<unknown, unknown, FakeSession> {
  return {
    transport: noopTransportPort(),
    logger: { debug: () => undefined, warn: () => undefined, error: () => undefined },
    commands: {
      forward: () => undefined,
      cancel: () => undefined,
      cancelSubagent: () => undefined,
      userResponse: () => undefined,
      permission: () => undefined,
      actionRequest: () => undefined,
    },
  }
}

function transportCapturing(relayed: StreamEvent[][], localEmitted: StreamEvent[]): DeliveryTransportPort {
  const localStream: LocalStreamPort = {
    emit: (e) => localEmitted.push(e),
    close: () => undefined,
    fail: () => undefined,
    shouldAbortIteration: () => false,
  }
  return {
    openLocalStream: () => localStream,
    sendRelayBatch: async (_ctx, events) => { relayed.push(events as StreamEvent[]); return { messageIds: ['m1'] } },
    createOutboxStore: () => ({ persist: () => undefined, drain: async function* () { return }, remove: () => undefined }),
    subscribeReconnect: () => () => undefined,
  }
}

function resourceFactory(streamFor: (s: FakeSession) => () => AsyncIterable<StreamEvent>): {
  resources: RuntimeResourceFactory<BuildInput, FakeSession, Mode, never, never>
  interruptSpy: ReturnType<typeof vi.fn>
} {
  const interruptSpy = vi.fn(async (_id: string, s: FakeSession) => { s.abortController.abort() })
  const resources: RuntimeResourceFactory<BuildInput, FakeSession, Mode, never, never> = {
    build: async (ctx) => {
      const s = buildSession(ctx.cacheKey, ctx.mode)
      s.runtime = { query: streamFor(s) }
      return s
    },
    getMode: (s) => s.mode,
    setMode: (s, m) => { s.mode = m },
    getCacheKey: (s) => s.cacheKey,
    getOwner: (s) => s.owner,
    getConversationIdentity: (sessionId, s) => ({ sessionId, conversationId: s.conversationId }),
    interruptSession: interruptSpy,
    teardownSession: async () => undefined,
    disposeOwnerResources: async () => undefined,
  }
  return { resources, interruptSpy }
}

function dataPortBuilder(relayed: StreamEvent[][], localEmitted: StreamEvent[]) {
  const views = new WeakMap<FakeSession, ReturnType<typeof fakeSessionView>>()
  return ({ lifecycle, delivery }: {
    lifecycle: QueryTurnDataPort<FakeSession, BuildInput, Mode, never>['lifecycle']
    delivery: QueryTurnDataPort<FakeSession, BuildInput, Mode, never>['delivery']
  }): QueryTurnDataPort<FakeSession, BuildInput, Mode, never> => ({
    lifecycle,
    delivery,
    log: { info: () => undefined, warn: () => undefined },
    sessionView: (s) => {
      let v = views.get(s)
      if (!v) { v = fakeSessionView(s); views.set(s, v) }
      return v
    },
    runtimeOf: (s) => s.runtime,
    organizationIdOf: () => 'org-1',
    fetchAuthoritative: async () => null,
    prepareRuntimeAttachments: async () => [],
    buildQueryParams: (base) => base,
    appendStreamEventToSessionStorage: async () => undefined,
    buildLifecycleErrorEvent: () => ({ type: 'agent.stream.lifecycle', payload: { phase: 'error' } } as StreamEvent),
    projectPersistedEvent: () => ({ type: 'agent.stream.message_persisted', payload: {} } as StreamEvent),
    // silence unused capture
    ...(relayed && localEmitted ? {} : {}),
  })
}

describe('AgentHost composed deep-module query engine (end to end)', () => {
  it('composeQueryEngine drives a HostQuery through all three deep modules', async () => {
    const localEmitted: StreamEvent[] = []
    const relayed: StreamEvent[][] = []
    const transport = transportCapturing(relayed, localEmitted)
    const { resources } = resourceFactory(() => runtimeStream)

    const host = await AgentHost.start(noopAdapter())
    host.composeQueryEngine({
      resources,
      deliveryTransport: transport,
      initialOwner: owner,
      buildDataPort: dataPortBuilder(relayed, localEmitted),
    })

    const result = await host.submitHostQuery(hostQuery() as unknown as HostQuery<unknown, string, never>)

    expect(result.success).toBe(true)
    expect(localEmitted.some((e) => e.type === 'agent.stream.done')).toBe(true)
    expect(localEmitted.some((e) => e.type === 'agent.stream.assistant')).toBe(true)
    await vi_waitRelay(relayed)
    expect(localEmitted.some((e) => e.type === 'agent.stream.message_persisted')).toBe(true)
    expect(host.isBusy('conversation-1')).toBe(false)
    await host.stop()
  })

  it('disposeExecutionOwner cancels an in-flight composed run (shared supervisor)', async () => {
    const localEmitted: StreamEvent[] = []
    const relayed: StreamEvent[][] = []
    const transport = transportCapturing(relayed, localEmitted)
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const { resources, interruptSpy } = resourceFactory(() => async function* () {
      yield { type: 'agent.stream.lifecycle', payload: { phase: 'start' } } as StreamEvent
      await gate
      yield { type: 'agent.stream.done', payload: {} } as StreamEvent
    })

    const host = await AgentHost.start(noopAdapter())
    host.composeQueryEngine({
      resources,
      deliveryTransport: transport,
      initialOwner: owner,
      buildDataPort: dataPortBuilder(relayed, localEmitted),
    })

    const running = host.submitHostQuery(hostQuery() as unknown as HostQuery<unknown, string, never>)
    await vi.waitFor(() => expect(localEmitted.length).toBeGreaterThan(0))

    const disposing = host.disposeExecutionOwner(owner)
    await new Promise((r) => setTimeout(r, 10))
    release()
    const result = await running
    await disposing

    expect(interruptSpy).toHaveBeenCalled()
    expect(result.success).toBe(false)
    expect(host.isBusy('conversation-1')).toBe(false)
    await host.stop()
  })
})

async function vi_waitRelay(relayed: StreamEvent[][]): Promise<void> {
  for (let i = 0; i < 50 && relayed.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 5))
  }
  expect(relayed.length).toBeGreaterThan(0)
}
