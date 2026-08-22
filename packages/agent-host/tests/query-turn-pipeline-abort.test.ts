/**
 * ：用户停止（abort signal）时 throw 必须映射为 kind:'aborted'，不得收成 failed。
 */
import { describe, expect, it, vi } from 'vitest'
import type { QueryParams, StreamEvent } from '@tabtin/agent-runtime'
import { DefaultQueryTurnPipeline, type QueryTurnDataPort } from '../src/conversation/query-turn-pipeline.js'
import { ConversationSupervisor } from '../src/conversation/conversation-supervisor.js'
import type { HostQuery, HostQueryResult } from '../src/conversation/host-query.js'
import type { DeliveryCoordinator, DeliveryTurn } from '../src/delivery/delivery-coordinator.js'
import type { RuntimeSessionLifecycle } from '../src/runtime/runtime-session-lifecycle.js'
import type { ExecutionOwner } from '../src/runtime/execution-owner-lifecycle.js'

type Mode = 'agent'

interface FakeSession {
  runtime: { query(params: unknown): AsyncIterable<StreamEvent> }
  policyContext: { currentAgentMode: string; isGroupSpace: boolean }
  agentConfigV3: null
  abortController: AbortController
}

const owner: ExecutionOwner = { userId: 'user-1', organizationId: 'org-1', agentId: 'agent-1' }

function hostQuery(): HostQuery<{ label: string }, Mode, never> {
  return {
    identity: {
      conversationId: 'conversation-1',
      sessionId: 'session-1',
      runId: 'run-1',
      owner,
    },
    runtime: {
      sessionId: 'session-1',
      mode: 'agent',
      cacheKey: { modelId: 'model-1', owner: { userId: owner.userId, organizationId: owner.organizationId } },
      input: { label: 'x' },
    },
    turn: { prompt: 'hello' },
    policy: { agentMode: 'agent' },
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

type Ports = QueryTurnDataPort<FakeSession, { label: string }, Mode, never>

function createHarness(session: FakeSession, options?: { pendingRewind?: boolean }) {
  const completes: unknown[] = []
  let pendingRewind = options?.pendingRewind === true
  const commitRewind = vi.fn(async () => {
    pendingRewind = false
    return 123
  })
  const truncateFrom = vi.fn(async () => undefined)
  const recordUserMessage = vi.fn(async () => undefined)
  const appendUserBlockRecord = vi.fn(async () => undefined)
  const emitted: StreamEvent[] = []
  const delivery: DeliveryCoordinator = {
    openTurn: (): DeliveryTurn => ({
      emit: async (event) => { emitted.push(event) },
      emitRouted: async (event) => { emitted.push(event) },
      emitTransient: async (event) => { emitted.push(event) },
      complete: async (o) => { completes.push(o) },
      settleRelay: async () => undefined,
      cancel: async () => undefined,
    }),
    publishHostEvent: async () => undefined,
    flushScope: async () => undefined,
    kickRecoverAndBackfill: async () => undefined,
    stop: async () => undefined,
  }
  const lifecycle: RuntimeSessionLifecycle<{ label: string }, FakeSession, Mode, never> = {
    acquire: async () => ({ decision: 'rebuild', session }),
    updateLivePolicy: async () => undefined,
    disposeSession: async () => undefined,
    replaceOwner: async () => true,
    disposeOwner: async () => undefined,
    stop: async () => undefined,
  }
  const views = new WeakMap<FakeSession, ReturnType<typeof fakeSessionView>>()
  const ports: Ports = {
    lifecycle,
    delivery,
    log: { info: () => undefined, warn: () => undefined },
    sessionView: (s) => {
      let v = views.get(s)
      if (!v) {
        v = fakeSessionView(s)
        v.sessionStorage.hasPendingRewind = () => pendingRewind
        v.sessionStorage.commitRewind = commitRewind
        v.sessionStorage.recordUserMessage = recordUserMessage
        v.sessionStorage.appendUserBlockRecord = appendUserBlockRecord
        v.eventStorage.truncateFrom = truncateFrom
        views.set(s, v)
      }
      return v
    },
    runtimeOf: (s) => s.runtime,
    organizationIdOf: () => 'org-1',
    fetchAuthoritative: async () => null,
    prepareRuntimeAttachments: async () => [],
    buildQueryParams: (base: QueryParams) => base,
    appendStreamEventToSessionStorage: async () => undefined,
    buildLifecycleErrorEvent: () =>
      ({ type: 'agent.stream.lifecycle', payload: { phase: 'error' } }) as StreamEvent,
    onQueued: vi.fn(),
    onTurnFinally: vi.fn(),
  }
  const supervisor = new ConversationSupervisor<
    HostQuery<{ label: string }, Mode, never>,
    HostQueryResult,
    FakeSession
  >()
  return {
    pipeline: new DefaultQueryTurnPipeline({ ports, supervisor }),
    completes,
    commitRewind,
    truncateFrom,
    recordUserMessage,
    appendUserBlockRecord,
    emitted,
  }
}

describe('DefaultQueryTurnPipeline ·  abort 不得映射为 failed', () => {
  it('开跑前已 abort 时提交 staged rewind，但不写入用户消息', async () => {
    const session: FakeSession = {
      runtime: {
        query: async function* () {
          yield { type: 'agent.stream.lifecycle', payload: { phase: 'start' } } as StreamEvent
        },
      },
      policyContext: { currentAgentMode: 'agent', isGroupSpace: false },
      agentConfigV3: null,
      abortController: new AbortController(),
    }
    session.abortController.abort()
    const h = createHarness(session, { pendingRewind: true })

    await h.pipeline.submit(hostQuery())

    expect((h.completes[0] as { kind: string } | undefined)?.kind).toBe('aborted')
    expect(h.commitRewind).toHaveBeenCalledTimes(1)
    expect(h.truncateFrom).toHaveBeenCalledWith(123)
    expect(h.recordUserMessage).not.toHaveBeenCalled()
    expect(h.appendUserBlockRecord).not.toHaveBeenCalled()
  })

  it('signal 已 abort 后 runtime throw → outcome.kind=aborted', async () => {
    const session: FakeSession = {
      runtime: {
        query: async function* () {
          yield { type: 'agent.stream.lifecycle', payload: { phase: 'start' } } as StreamEvent
          session.abortController.abort()
          throw new Error('teardown noise after user stop')
        },
      },
      policyContext: { currentAgentMode: 'agent', isGroupSpace: false },
      agentConfigV3: null,
      abortController: new AbortController(),
    }
    const h = createHarness(session)
    await h.pipeline.submit(hostQuery())
    expect((h.completes[0] as { kind: string } | undefined)?.kind).toBe('aborted')
    expect(h.emitted.filter((event) => event.type === 'agent.stream.done')).toEqual([
      {
        type: 'agent.stream.done',
        payload: {
          run_id: 'run-1',
          stop_reason: 'aborted',
          error: true,
          error_class: 'ABORT',
          error_message: 'Run aborted by user.',
          suggested_action: 'retry_later',
          host_confirmed: true,
        },
      },
    ])
  })

  it('丢弃 signal 后到达的 runtime DONE，但仍由 host 确认一个权威 ABORT terminal', async () => {
    const session: FakeSession = {
      runtime: {
        query: async function* () {
          yield { type: 'agent.stream.lifecycle', payload: { phase: 'start' } } as StreamEvent
          session.abortController.abort()
          yield {
            type: 'agent.stream.done',
            payload: { run_id: 'run-1', stop_reason: 'aborted', error_class: 'ABORT' },
          } as StreamEvent
        },
      },
      policyContext: { currentAgentMode: 'agent', isGroupSpace: false },
      agentConfigV3: null,
      abortController: new AbortController(),
    }
    const h = createHarness(session)

    await h.pipeline.submit(hostQuery())

    expect(h.emitted.filter((event) => event.type === 'agent.stream.done')).toHaveLength(1)
    expect(h.emitted.find((event) => event.type === 'agent.stream.done')?.payload).toMatchObject({
      run_id: 'run-1',
      error_class: 'ABORT',
      host_confirmed: true,
    })
  })

  it('未 abort 的真错误仍映射为 failed', async () => {
    const session: FakeSession = {
      runtime: {
        query: async function* () {
          yield { type: 'agent.stream.lifecycle', payload: { phase: 'start' } } as StreamEvent
          throw new Error('runtime boom')
        },
      },
      policyContext: { currentAgentMode: 'agent', isGroupSpace: false },
      agentConfigV3: null,
      abortController: new AbortController(),
    }
    const h = createHarness(session)
    await h.pipeline.submit(hostQuery())
    expect((h.completes[0] as { kind: string } | undefined)?.kind).toBe('failed')
  })
})
