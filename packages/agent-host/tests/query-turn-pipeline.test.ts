import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ContentBlockEvents,
  StreamEvents,
  type QueryParams,
  type StreamEvent,
} from '@tabtin/agent-runtime'
import { DefaultQueryTurnPipeline, type QueryTurnDataPort } from '../src/conversation/query-turn-pipeline.js'
import { ConversationSupervisor } from '../src/conversation/conversation-supervisor.js'
import { SessionPauseController } from '../src/delivery/session-pause-controller.js'
import type { HostQuery, HostQueryPolicyInput, HostQueryResult } from '../src/conversation/host-query.js'
import type {
  DeliveryCoordinator,
  DeliveryTurn,
  DeliveryTurnContext,
} from '../src/delivery/delivery-coordinator.js'
import { routeDeliveryEvent } from '../src/delivery/delivery-event-routing.js'
import type { RuntimeSessionLifecycle } from '../src/runtime/runtime-session-lifecycle.js'
import type { ExecutionOwner } from '../src/runtime/execution-owner-lifecycle.js'
import { buildAgentProfileHook } from '../src/hooks/agent-profile-hook.js'
import {
  AttributionStore,
  bindAttributionStore,
  clearAgentDisplayNamesForTests,
  clearMessageAgentAttributionsForTests,
  unbindAttributionStoreForTests,
} from '../src/state/index.js'

type Mode = 'agent'

const testAttribution = new AttributionStore()

beforeEach(() => {
  testAttribution.clearForTests()
  bindAttributionStore(() => testAttribution)
})

afterEach(() => {
  clearAgentDisplayNamesForTests()
  clearMessageAgentAttributionsForTests()
  unbindAttributionStoreForTests()
})

interface FakeAgentConfigV3 {
  schema_version: number
  runtime_plane: string
  security: { allow_yolo_mode?: boolean; approval_grant?: string }
}

interface FakeWorkspaceSnapshot {
  sources: {
    sandbox?: string
    workingDir?: string
    sessionApprovedPaths?: string[]
    attachedFiles?: string[]
  }
  allowedPaths: string[]
  allowedFiles?: string[]
  [extra: string]: unknown
}

interface FakeSession {
  runtime: { query(params: unknown): AsyncIterable<StreamEvent> }
  policyContext: { currentAgentMode: string; isGroupSpace: boolean; requestedApprovalMode?: unknown }
  agentConfigV3: FakeAgentConfigV3 | null
  workspaceSnapshot?: FakeWorkspaceSnapshot
  appContext?: unknown
  agentProfile?: HostQueryPolicyInput['agentProfile']
  abortController: AbortController
  pauseController?: { waitIfPaused(signal?: AbortSignal): Promise<void> }
}

const owner: ExecutionOwner = { userId: 'user-1', organizationId: 'org-1', agentId: 'agent-1' }

function hostQuery(overrides: {
  conversationId?: string
  sessionId?: string
  runId?: string
  relaySessionId?: string
  clientMessageId?: string
  senderUserId?: string
  prompt?: string
  displayMessage?: string
  triggeredBy?: HostQuery<{ label: string }, Mode, never>['turn']['triggeredBy']
  userMessageBlocks?: Array<Record<string, unknown>>
  attachments?: HostQuery<{ label: string }, Mode, never>['turn']['attachments']
  policy?: HostQueryPolicyInput
} = {}): HostQuery<{ label: string }, Mode, never> {
  return {
    identity: {
      conversationId: overrides.conversationId ?? 'conversation-1',
      sessionId: overrides.sessionId ?? 'session-1',
      runId: overrides.runId ?? 'run-1',
      owner,
    },
    runtime: {
      sessionId: overrides.sessionId ?? 'session-1',
      mode: 'agent',
      cacheKey: { modelId: 'model-1', owner: { userId: owner.userId, organizationId: owner.organizationId } },
      input: { label: 'x' },
    },
    turn: {
      prompt: overrides.prompt ?? 'hello',
      ...(overrides.displayMessage !== undefined ? { displayMessage: overrides.displayMessage } : {}),
      ...(overrides.triggeredBy ? { triggeredBy: overrides.triggeredBy } : {}),
      ...(overrides.userMessageBlocks ? { userMessageBlocks: overrides.userMessageBlocks } : {}),
      ...(overrides.attachments ? { attachments: overrides.attachments } : {}),
      ...(overrides.relaySessionId ? { relaySessionId: overrides.relaySessionId } : {}),
      ...(overrides.clientMessageId ? { clientMessageId: overrides.clientMessageId } : {}),
      ...(overrides.senderUserId ? { senderUserId: overrides.senderUserId } : {}),
    },
    policy: overrides.policy ?? { agentMode: 'agent' },
  }
}

function makeSession(query: (params: unknown) => AsyncIterable<StreamEvent>): FakeSession {
  return {
    runtime: { query },
    policyContext: { currentAgentMode: 'agent', isGroupSpace: false },
    agentConfigV3: null,
    abortController: new AbortController(),
  }
}

/**
 * Richer session with a mutable `agentConfigV3` + `workspaceSnapshot`, so the
 * absorbed PD-13 authoritative mutate (formerly query-execution-pipeline) can be
 * observed black-box through `submit()`.
 */
function makePolicySession(query: (params: unknown) => AsyncIterable<StreamEvent>): FakeSession {
  return {
    runtime: { query },
    policyContext: { currentAgentMode: 'agent', isGroupSpace: false },
    agentConfigV3: { schema_version: 3, runtime_plane: 'local', security: { allow_yolo_mode: false } },
    workspaceSnapshot: {
      sources: { sandbox: '/sandbox', workingDir: '/wd-old', sessionApprovedPaths: [], attachedFiles: [] },
      allowedPaths: ['/sandbox', '/wd-old'],
      allowedFiles: [],
      spaceSessionId: 'space-1',
    },
    appContext: undefined,
    abortController: new AbortController(),
  }
}

function fakeSessionView(session: FakeSession) {
  const appendedUserBlocks: unknown[] = []
  ;(session as FakeSession & { __appendedUserBlocks?: unknown[] }).__appendedUserBlocks = appendedUserBlocks
  return {
    abortController: session.abortController,
    pauseController: session.pauseController ?? { waitIfPaused: async () => undefined },
    sessionStorage: {
      hasPendingRewind: () => false,
      commitRewind: async () => null,
      ensureBlockBackfillFromTranscript: async () => undefined,
      recordUserMessage: async () => undefined,
      appendUserBlockRecord: async (message: unknown) => { appendedUserBlocks.push(message) },
      restoreMessages: async () => [],
      loadBlockRecords: async () => [],
      appendStreamEvent: async () => undefined,
    },
    eventStorage: { truncateFrom: async () => undefined, append: async () => undefined },
    snapshotStorage: { append: async () => undefined },
    toolProvider: {
      setSubagentTraceWiring: (emit?: (event: StreamEvent) => Promise<void>) => {
        ;(session as FakeSession & { __subagentTraceEmitter?: typeof emit }).__subagentTraceEmitter = emit
      },
    },
    eventEmitter: { buildStream: (e: StreamEvent) => e },
    eventInterceptor: undefined as ((e: StreamEvent) => void) | undefined,
  }
}

type Ports = QueryTurnDataPort<FakeSession, { label: string }, Mode, never>

interface HarnessOverrides {
  fetchAuthoritative?: Ports['fetchAuthoritative']
  reconcileAllowedPaths?: Ports['reconcileAllowedPaths']
  buildEffectivePrompt?: Ports['buildEffectivePrompt']
  onTurnError?: Ports['onTurnError']
  prepareTurnInputs?: Ports['prepareTurnInputs']
  acquire?: RuntimeSessionLifecycle<{ label: string }, FakeSession, Mode, never>['acquire']
  deliveryEmit?: (event: StreamEvent) => Promise<void>
}

function createHarness(session: FakeSession, overrides: HarnessOverrides = {}) {
  const emitted: StreamEvent[] = []
  const transientEmitted: StreamEvent[] = []
  const hostEvents: StreamEvent[] = []
  const hostEventContexts: Array<{ sessionId: string; conversationId: string }> = []
  const completes: unknown[] = []
  const cancels: number[] = []
  const infoLogs: string[] = []
  const queryParams: QueryParams[] = []
  const deliveryTurnContexts: DeliveryTurnContext[] = []
  const delivery: DeliveryCoordinator = {
    openTurn: (context): DeliveryTurn => {
      deliveryTurnContexts.push(context)
      return {
        emit: async (e) => {
          emitted.push(e)
          await overrides.deliveryEmit?.(e)
        },
        emitRouted: async (e, routedContext) => {
          if (routeDeliveryEvent(e, routedContext.source) === 'durable') {
            emitted.push(e)
            await overrides.deliveryEmit?.(e)
            return
          }
          transientEmitted.push(e)
        },
        emitTransient: async (e) => { transientEmitted.push(e) },
        complete: async (o) => { completes.push(o) },
        settleRelay: async () => undefined,
        cancel: async () => { cancels.push(1) },
      }
    },
    publishHostEvent: async (context, event) => {
      hostEventContexts.push({
        sessionId: context.sessionId,
        conversationId: context.conversationId,
      })
      hostEvents.push(event)
    },
    flushScope: async () => undefined,
    kickRecoverAndBackfill: async () => undefined,
    stop: async () => undefined,
  }
  const lifecycle: RuntimeSessionLifecycle<{ label: string }, FakeSession, Mode, never> = {
    acquire: overrides.acquire ?? (async () => ({ decision: 'rebuild', session })),
    updateLivePolicy: async () => undefined,
    disposeSession: async () => undefined,
    replaceOwner: async () => true,
    disposeOwner: async () => undefined,
    stop: async () => undefined,
  }
  const onQueued = vi.fn()
  const onTurnTerminalPersisted = vi.fn()
  const onTurnStreamingDone = vi.fn()
  const onTurnError = vi.fn()
  const onTurnFinally = vi.fn()
  const views = new WeakMap<FakeSession, ReturnType<typeof fakeSessionView>>()
  const ports: Ports = {
    lifecycle,
    delivery,
    log: { info: (m) => { infoLogs.push(m) }, warn: () => undefined },
    sessionView: (s) => {
      let v = views.get(s)
      if (!v) { v = fakeSessionView(s); views.set(s, v) }
      return v
    },
    runtimeOf: (s) => s.runtime,
    organizationIdOf: () => 'org-1',
    fetchAuthoritative: overrides.fetchAuthoritative ?? (async () => null),
    reconcileAllowedPaths: overrides.reconcileAllowedPaths,
    prepareTurnInputs: overrides.prepareTurnInputs,
    buildEffectivePrompt: overrides.buildEffectivePrompt,
    prepareRuntimeAttachments: async () => [],
    buildQueryParams: (base) => { queryParams.push(base); return base },
    appendStreamEventToSessionStorage: async () => undefined,
    buildLifecycleErrorEvent: () => ({
      type: 'agent.stream.lifecycle',
      payload: { phase: 'error', run_id: 'runtime-local-run-1' },
    } as StreamEvent),
    onQueued,
    onTurnTerminalPersisted,
    onTurnStreamingDone,
    onTurnError: overrides.onTurnError ?? onTurnError,
    onTurnFinally,
  }
  const supervisor = new ConversationSupervisor<
    HostQuery<{ label: string }, Mode, never>,
    HostQueryResult,
    FakeSession
  >()
  const pipeline = new DefaultQueryTurnPipeline({ ports, supervisor })
  return {
    pipeline,
    emitted,
    transientEmitted,
    hostEvents,
    hostEventContexts,
    completes,
    cancels,
    onQueued,
    onTurnTerminalPersisted,
    onTurnStreamingDone,
    onTurnError,
    onTurnFinally,
    infoLogs,
    queryParams,
    deliveryTurnContexts,
  }
}

async function* successGen(): AsyncIterable<StreamEvent> {
  yield { type: 'agent.stream.lifecycle', payload: { phase: 'start', trace_id: 't1' } } as StreamEvent
  yield { type: 'agent.stream.done', payload: {} } as StreamEvent
}

describe('DefaultQueryTurnPipeline', () => {
  it('runs a full turn to a single succeeded terminal', async () => {
    const session = makeSession(successGen)
    const h = createHarness(session)
    const result = await h.pipeline.submit(hostQuery())
    expect(result.success).toBe(true)
    expect(h.emitted.some((e) => e.type === 'agent.stream.done')).toBe(true)
    expect(h.completes).toHaveLength(1)
    expect((h.completes[0] as { kind: string }).kind).toBe('succeeded')
    expect(h.queryParams[0]).not.toHaveProperty('runId')
    expect(h.queryParams[0]?.hostRunId).toBe('run-1')
    expect(h.deliveryTurnContexts[0]?.businessRunId).toBe('run-1')
    await h.pipeline.waitForPendingFinalize('conversation-1')
    expect(h.onTurnStreamingDone).toHaveBeenCalledOnce()
    expect(h.onTurnTerminalPersisted).toHaveBeenCalledWith(
      'session-1',
      expect.any(Object),
      expect.objectContaining({ type: StreamEvents.DONE }),
    )
    expect(h.onTurnStreamingDone).toHaveBeenCalledWith(
      'session-1',
      expect.any(Object),
      { success: true },
    )
    expect(h.onTurnFinally).toHaveBeenCalledOnce()
    expect(h.onTurnTerminalPersisted.mock.invocationCallOrder[0])
      .toBeLessThan(h.onTurnStreamingDone.mock.invocationCallOrder[0]!)
    // streaming done 必须先于后台 finally，才能在队列接力前释放轮次资源。
    expect(h.onTurnStreamingDone.mock.invocationCallOrder[0])
      .toBeLessThan(h.onTurnFinally.mock.invocationCallOrder[0]!)
  })

  it('持久化/投递失败时 streaming done 明确携带失败结果', async () => {
    const session = makeSession(successGen)
    const h = createHarness(session, {
      deliveryEmit: async (event) => {
        if (event.type === StreamEvents.DONE) throw new Error('persist failed')
      },
    })

    const result = await h.pipeline.submit(hostQuery())

    expect(result).toMatchObject({ success: false, error: 'persist failed' })
    expect(h.onTurnStreamingDone).toHaveBeenCalledWith(
      'session-1',
      expect.any(Object),
      expect.objectContaining({ success: false, error: 'persist failed' }),
    )
  })

  it('routes subagent trace observer events through transient delivery', async () => {
    const traceEvent = {
      type: ContentBlockEvents.CONTENT_BLOCK_DELTA,
      payload: { subagent_run_id: 'child-1' },
    } as StreamEvent
    const session = makeSession(async function* () {
      const emitTrace = (session as FakeSession & {
        __subagentTraceEmitter?: (event: StreamEvent) => Promise<void>
      }).__subagentTraceEmitter
      await emitTrace?.(traceEvent)
      yield { type: StreamEvents.DONE, payload: {} } as StreamEvent
    })
    const h = createHarness(session)

    await h.pipeline.submit(hostQuery())

    expect(h.transientEmitted).toEqual([traceEvent])
    expect(h.emitted).not.toContain(traceEvent)
  })

  it('routes subagent visible message facts through durable delivery', async () => {
    const messageFact = {
      type: StreamEvents.PERSIST_MESSAGE,
      payload: {
        message_id: 'child-message-1',
        role: 'assistant',
        message_kind: 'llm',
        blocks_json: [{ type: 'text', text: 'child visible history' }],
        subagent_run_id: 'child-1',
      },
    } as StreamEvent
    const session = makeSession(async function* () {
      const emitTrace = (session as FakeSession & {
        __subagentTraceEmitter?: (event: StreamEvent) => Promise<void>
      }).__subagentTraceEmitter
      await emitTrace?.(messageFact)
      yield { type: StreamEvents.DONE, payload: {} } as StreamEvent
    })
    const h = createHarness(session)

    await h.pipeline.submit(hostQuery())

    expect(h.emitted).toContain(messageFact)
    expect(h.transientEmitted).not.toContain(messageFact)
  })

  it('#7879 Host 在投递边界绑定共享发言人，runtime 参数保持业务无关', async () => {
    const session = makeSession(async function* () {
      yield {
        type: StreamEvents.USER,
        payload: { client_event_id: 'message-1', content: '来自共享访问者' },
      } as StreamEvent
      yield { type: StreamEvents.DONE, payload: {} } as StreamEvent
    })
    const h = createHarness(session)

    await h.pipeline.submit(hostQuery({
      clientMessageId: 'message-1',
      senderUserId: 'grantee-user-1',
    }))

    expect(h.queryParams[0]).not.toHaveProperty('senderUserId')
    expect(h.emitted.find((event) => event.type === StreamEvents.USER)?.payload)
      .toMatchObject({ client_event_id: 'message-1', sender_user_id: 'grantee-user-1' })
  })

  it('holds the runtime at the session pause gate before an iteration', async () => {
    const pauseController = new SessionPauseController()
    pauseController.pause()
    let iterationStarted = false
    const session = makeSession(async function* (params) {
      const queryParams = params as QueryParams
      await queryParams.waitIfPaused?.(queryParams.signal ?? new AbortController().signal)
      iterationStarted = true
      yield { type: 'agent.stream.done', payload: {} } as StreamEvent
    })
    session.pauseController = pauseController
    const h = createHarness(session)

    const running = h.pipeline.submit(hostQuery({
      runId: 'run-pause-1',
      relaySessionId: 'conversation-1',
    }))
    await vi.waitFor(() => expect(h.queryParams).toHaveLength(1))
    await vi.waitFor(() => expect(h.emitted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: StreamEvents.LIFECYCLE,
        payload: expect.objectContaining({
          phase: 'paused',
          run_id: 'run-pause-1',
          thread_id: 'conversation-1',
        }),
      }),
    ])))
    expect(iterationStarted).toBe(false)

    pauseController.resume()
    await expect(running).resolves.toEqual({ success: true })
    expect(iterationStarted).toBe(true)
  })

  it('#6559 appendUserBlockRecord 写入 context 引用块（保留 LLM wrapper + 追加引用）', async () => {
    const session = makeSession(successGen)
    const h = createHarness(session)
    const contextBlock = {
      type: 'table_selection',
      preview: 'WT827 子记录 live 验收',
      table_id: 'table-1',
    }
    const prompt = '这是什么\n\n<context type="referenced">schema</context>'
    const result = await h.pipeline.submit(hostQuery({
      prompt,
      userMessageBlocks: [{ type: 'text', text: '这是什么' }, contextBlock],
    }))
    expect(result.success).toBe(true)
    const appended = (session as FakeSession & { __appendedUserBlocks?: Array<{ content: unknown }> })
      .__appendedUserBlocks
    expect(appended).toHaveLength(1)
    const content = appended![0].content
    expect(Array.isArray(content)).toBe(true)
    const blocks = content as Array<Record<string, unknown>>
    // 无 displayMessage 时写侧仍保留 effectivePrompt（含 wrapper）；非 text context 追加；text 块不重复。
    expect(blocks).toEqual([
      { type: 'text', text: prompt },
      contextBlock,
    ])
  })

  it('continuation 空 displayMessage 不把续跑提示写入 transcript', async () => {
    const session = makeSession(successGen)
    const h = createHarness(session)
    const prompt = '上一轮回复失败了。请直接根据已有对话继续完成回复，不要让用户重复刚才的问题。'
    const result = await h.pipeline.submit(hostQuery({
      prompt,
      displayMessage: '',
      triggeredBy: 'continuation',
    }))
    expect(result.success).toBe(true)
    const appended = (session as FakeSession & { __appendedUserBlocks?: Array<{ content: unknown }> })
      .__appendedUserBlocks
    // ：空 user 不落盘，避免下一轮发给 Kimi/K3 时 400。
    expect(appended).toHaveLength(0)
  })

  it('continuation 在 USER 事件上补 triggered_by，不写入 QueryParams.triggeredBy', async () => {
    async function* userThenDone(): AsyncIterable<StreamEvent> {
      yield {
        type: StreamEvents.USER,
        payload: { client_event_id: 'user-1', content: '' },
      } as StreamEvent
      yield { type: StreamEvents.DONE, payload: {} } as StreamEvent
    }
    const session = makeSession(userThenDone)
    const h = createHarness(session)
    const result = await h.pipeline.submit(hostQuery({
      prompt: '上一轮回复失败了。请直接根据已有对话继续完成回复，不要让用户重复刚才的问题。',
      displayMessage: '',
      triggeredBy: 'continuation',
      senderUserId: 'user-1',
    }))
    expect(result.success).toBe(true)
    expect(h.queryParams[0]?.triggeredBy).toBeUndefined()
    const userEvent = h.emitted.find((event) => event.type === StreamEvents.USER)
    expect(userEvent?.payload).toMatchObject({
      triggered_by: 'continuation',
      sender_user_id: 'user-1',
    })
  })

  it('#8294 有 displayMessage 时 transcript 只落可见正文，不落 Tracker 模板 prompt', async () => {
    const session = makeSession(successGen)
    const h = createHarness(session)
    const instruction = 'test'
    const prompt = [
      '## 任务',
      instruction,
      '',
      '请独立完成以上任务并汇报结果。如有合适的 Skill 可用，可自行搜索并调用（skills_search / skills_read）。',
    ].join('\n')
    const result = await h.pipeline.submit(hostQuery({
      prompt,
      displayMessage: instruction,
    }))
    expect(result.success).toBe(true)
    const appended = (session as FakeSession & { __appendedUserBlocks?: Array<{ content: unknown }> })
      .__appendedUserBlocks
    expect(appended).toHaveLength(1)
    expect(appended![0].content).toBe(instruction)
  })

  it('rejects empty content before touching the runtime', async () => {
    const session = makeSession(() => { throw new Error('should not run') })
    const h = createHarness(session)
    const result = await h.pipeline.submit(hostQuery({ prompt: '' }))
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/prompt or attachments/)
    expect(h.completes).toHaveLength(0)
  })

  it('openTurn 前 setup 失败也回传携权威 run_id 的 failed terminal', async () => {
    const session = makeSession(successGen)
    const h = createHarness(session, {
      fetchAuthoritative: async () => {
        throw new Error('config unavailable')
      },
    })

    const result = await h.pipeline.submit(hostQuery({
      sessionId: 'prompt-task-1',
      relaySessionId: 'chat-session-uuid-1',
      policy: { agentMode: 'agent', agentId: 'agent-1' },
    }))

    expect(result).toMatchObject({ success: false, error: 'config unavailable' })
    expect(h.completes).toHaveLength(0)
    expect(h.hostEventContexts).toEqual([
      {
        sessionId: 'chat-session-uuid-1',
        conversationId: 'chat-session-uuid-1',
      },
    ])
    expect(h.hostEvents).toEqual([
      {
        type: 'agent.stream.done',
        payload: {
          run_id: 'run-1',
          stop_reason: 'host_setup_failed',
          error: true,
          error_class: 'HOST_SETUP_ERROR',
          error_message: 'config unavailable',
          host_confirmed: true,
          setup_step: 'fetch_authoritative',
        },
      },
    ])
  })

  it('runtime 首次 next 即失败时由 DeliveryTurn 持有业务配对，runtime 事件保持本地 id', async () => {
    const session = makeSession(async function* () {
      throw new Error('runtime failed before start')
    })
    const h = createHarness(session)

    const result = await h.pipeline.submit(hostQuery())

    expect(result).toMatchObject({ success: false, error: 'runtime failed before start' })
    await h.pipeline.waitForPendingFinalize('conversation-1')
    expect(h.completes).toHaveLength(1)
    expect(
      (h.completes[0] as {
        lifecycleErrorEvent?: StreamEvent
      }).lifecycleErrorEvent?.payload,
    ).toMatchObject({ run_id: 'runtime-local-run-1', phase: 'error' })
    expect(h.deliveryTurnContexts[0]?.businessRunId).toBe('run-1')
    expect(h.queryParams[0]).not.toHaveProperty('runId')
  })

  it('rejects missing sessionId', async () => {
    const session = makeSession(successGen)
    const h = createHarness(session)
    const result = await h.pipeline.submit(hostQuery({ sessionId: '' }))
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/sessionId/)
  })

  it('serializes runs on the same conversation (FIFO)', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const order: string[] = []
    async function* gated(tag: string): AsyncIterable<StreamEvent> {
      order.push(`start:${tag}`)
      await gate
      yield { type: 'agent.stream.done', payload: {} } as StreamEvent
      order.push(`end:${tag}`)
    }
    // Distinct sessions per run but same conversation → queue serializes them.
    const sessionA = makeSession(() => gated('a'))
    const h = createHarness(sessionA)
    const first = h.pipeline.submit(hostQuery({ runId: 'run-1', sessionId: 'session-1' }))
    const second = h.pipeline.submit(hostQuery({ runId: 'run-2', sessionId: 'session-1' }))
    await Promise.resolve()
    expect(h.onQueued).toHaveBeenCalledOnce()
    release()
    await Promise.all([first, second])
    expect(order[0]).toBe('start:a')
  })

  it('maps a runtime failure to a single failed terminal', async () => {
    const session = makeSession(async function* () {
      yield { type: 'agent.stream.lifecycle', payload: { phase: 'start' } } as StreamEvent
      throw new Error('runtime boom')
    })
    const h = createHarness(session)
    const result = await h.pipeline.submit(hostQuery())
    expect(result.success).toBe(false)
    expect(result.error).toBe('runtime boom')
    await h.pipeline.waitForPendingFinalize('conversation-1')
    expect((h.completes[0] as { kind: string }).kind).toBe('failed')
    expect(h.onTurnError).toHaveBeenCalledOnce()
    expect(h.onTurnError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'runtime boom' }),
      expect.objectContaining({ identity: expect.objectContaining({ runId: 'run-1' }) }),
      false,
    )
    // 吸收自 query-skeleton "afterQuery 必然跑"语义：失败路径也必须触达 finally
    // 清理钩子（onTurnFinally）。
    expect(h.onTurnFinally).toHaveBeenCalledOnce()
  })

  it('busy≈streaming：complete 立即返回时 submit 立即 idle（relay settle 异步）', async () => {
    const session = makeSession(successGen)
    let releaseSettle!: () => void
    const settleGate = new Promise<void>((r) => { releaseSettle = r })
    const emitted: StreamEvent[] = []
    const completes: unknown[] = []
    const settles: number[] = []
    const onTurnFinally = vi.fn()
    const delivery: DeliveryCoordinator = {
      openTurn: (): DeliveryTurn => ({
        emit: async (e) => { emitted.push(e) },
        emitRouted: async (e) => { emitted.push(e) },
        emitTransient: async (e) => { emitted.push(e) },
        // 对齐真实 DeliveryTurn：complete 立即 seal 返回，settle 后台挂起
        complete: async (o) => {
          completes.push(o)
          void settleGate.then(() => { settles.push(1) })
        },
        settleRelay: async () => { await settleGate },
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
        if (!v) { v = fakeSessionView(s); views.set(s, v) }
        return v
      },
      runtimeOf: (s) => s.runtime,
      organizationIdOf: () => 'org-1',
      fetchAuthoritative: async () => null,
      prepareRuntimeAttachments: async () => [],
      buildQueryParams: (base) => base,
      appendStreamEventToSessionStorage: async () => undefined,
      buildLifecycleErrorEvent: () => ({
        type: 'agent.stream.lifecycle',
        payload: { phase: 'error' },
      } as StreamEvent),
      onTurnFinally,
    }
    const supervisor = new ConversationSupervisor<
      HostQuery<{ label: string }, Mode, never>,
      HostQueryResult,
      FakeSession
    >()
    const pipeline = new DefaultQueryTurnPipeline({ ports, supervisor })

    const started = Date.now()
    const result = await pipeline.submit(hostQuery())
    expect(result.success).toBe(true)
    expect(Date.now() - started).toBeLessThan(500)
    expect(pipeline.getState('conversation-1').busy).toBe(false)
    expect(completes).toHaveLength(1)
    expect(settles).toHaveLength(0)
    expect(emitted.some((e) => e.type === 'agent.stream.done')).toBe(true)

    await pipeline.waitForPendingFinalize('conversation-1')
    expect(onTurnFinally).toHaveBeenCalledOnce()
    expect(settles).toHaveLength(0)

    releaseSettle()
    await settleGate
    expect(settles).toHaveLength(1)
  })

  it('队列 drain 不挡 loop：上轮 relay settle 挂起时下轮仍立刻 acquire', async () => {
    let releaseSettle!: () => void
    const settleGate = new Promise<void>((r) => { releaseSettle = r })
    let turn = 0
    const acquireOrder: number[] = []
    const session = makeSession(async function* () {
      yield { type: 'agent.stream.assistant', payload: { content: `t${turn}` } } as StreamEvent
      yield {
        type: 'agent.stream.done',
        payload: { run_id: `run-${turn}`, stop_reason: 'end_turn' },
      } as StreamEvent
    })
    const delivery: DeliveryCoordinator = {
      openTurn: (): DeliveryTurn => ({
        emit: async () => undefined,
        emitRouted: async () => undefined,
        emitTransient: async () => undefined,
        complete: async () => {
          // 对齐真实 complete：立即返回，不 await settle
          void settleGate
        },
        settleRelay: async () => { await settleGate },
        cancel: async () => undefined,
      }),
      publishHostEvent: async () => undefined,
      flushScope: async () => undefined,
      kickRecoverAndBackfill: async () => undefined,
      stop: async () => undefined,
    }
    const lifecycle: RuntimeSessionLifecycle<{ label: string }, FakeSession, Mode, never> = {
      acquire: async () => {
        acquireOrder.push(++turn)
        return { decision: 'rebuild', session }
      },
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
        if (!v) { v = fakeSessionView(s); views.set(s, v) }
        return v
      },
      runtimeOf: (s) => s.runtime,
      organizationIdOf: () => 'org-1',
      fetchAuthoritative: async () => null,
      prepareRuntimeAttachments: async () => [],
      buildQueryParams: (base) => base,
      appendStreamEventToSessionStorage: async () => undefined,
      buildLifecycleErrorEvent: () => ({
        type: 'agent.stream.lifecycle',
        payload: { phase: 'error' },
      } as StreamEvent),
    }
    const supervisor = new ConversationSupervisor<
      HostQuery<{ label: string }, Mode, never>,
      HostQueryResult,
      FakeSession
    >()
    const pipeline = new DefaultQueryTurnPipeline({ ports, supervisor })

    const first = pipeline.submit(hostQuery({ runId: 'run-1', prompt: 'first' }))
    await vi.waitFor(() => expect(pipeline.getState('conversation-1').busy).toBe(true))
    const second = pipeline.submit(hostQuery({ runId: 'run-2', prompt: 'second' }))

    await vi.waitFor(() => expect(acquireOrder).toEqual([1, 2]))
    expect(acquireOrder[1]).toBe(2)

    const r1 = await first
    const r2 = await second
    expect(r1.success).toBe(true)
    expect(r2.success).toBe(true)

    releaseSettle()
    await pipeline.waitForPendingFinalize('conversation-1')
  })

  it('队列 drain 不挡 loop：上轮 storage dispose 挂起时下轮仍立刻 acquire', async () => {
    let releaseStorage!: () => void
    const storageGate = new Promise<void>((r) => { releaseStorage = r })
    let turn = 0
    const acquireOrder: number[] = []
    const session = makeSession(async function* () {
      yield { type: 'agent.stream.assistant', payload: { content: `t${turn}` } } as StreamEvent
      yield {
        type: 'agent.stream.done',
        payload: { run_id: `run-${turn}`, stop_reason: 'end_turn' },
      } as StreamEvent
    })
    const delivery: DeliveryCoordinator = {
      openTurn: (): DeliveryTurn => ({
        emit: async () => undefined,
        emitRouted: async () => undefined,
        emitTransient: async () => undefined,
        complete: async () => undefined,
        settleRelay: async () => undefined,
        cancel: async () => undefined,
      }),
      publishHostEvent: async () => undefined,
      flushScope: async () => undefined,
      kickRecoverAndBackfill: async () => undefined,
      stop: async () => undefined,
    }
    const lifecycle: RuntimeSessionLifecycle<{ label: string }, FakeSession, Mode, never> = {
      acquire: async () => {
        acquireOrder.push(++turn)
        return { decision: 'rebuild', session }
      },
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
        if (!v) { v = fakeSessionView(s); views.set(s, v) }
        return v
      },
      runtimeOf: (s) => s.runtime,
      organizationIdOf: () => 'org-1',
      fetchAuthoritative: async () => null,
      prepareRuntimeAttachments: async () => [],
      buildQueryParams: (base) => base,
      appendStreamEventToSessionStorage: async () => undefined,
      buildLifecycleErrorEvent: () => ({
        type: 'agent.stream.lifecycle',
        payload: { phase: 'error' },
      } as StreamEvent),
      flushTurnStorage: async () => { await storageGate },
    }
    const supervisor = new ConversationSupervisor<
      HostQuery<{ label: string }, Mode, never>,
      HostQueryResult,
      FakeSession
    >()
    const pipeline = new DefaultQueryTurnPipeline({ ports, supervisor })

    const first = pipeline.submit(hostQuery({ runId: 'run-1', prompt: 'first' }))
    await vi.waitFor(() => expect(pipeline.getState('conversation-1').busy).toBe(true))
    const second = pipeline.submit(hostQuery({ runId: 'run-2', prompt: 'second' }))

    await vi.waitFor(() => expect(acquireOrder).toEqual([1, 2]))
    expect(acquireOrder[1]).toBe(2)

    const r1 = await first
    const r2 = await second
    expect(r1.success).toBe(true)
    expect(r2.success).toBe(true)

    releaseStorage()
    await pipeline.waitForPendingFinalize('conversation-1')
  })

  it('keeps the failed terminal result when the error observer throws', async () => {
    const session = makeSession(async function* () {
      throw new Error('runtime boom')
    })
    const h = createHarness(session, {
      onTurnError: async () => { throw new Error('observer unavailable') },
    })

    await expect(h.pipeline.submit(hostQuery())).resolves.toEqual({
      success: false,
      error: 'runtime boom',
    })
    await h.pipeline.waitForPendingFinalize('conversation-1')
    expect((h.completes[0] as { kind: string }).kind).toBe('failed')
    expect(h.onTurnFinally).toHaveBeenCalledOnce()
  })

  it('accepts a turn with attachments and no prompt text', async () => {
    // 迁移自 query-skeleton.test：仅附件（无正文）也应通过 submit 前置校验。
    const session = makeSession(successGen)
    const h = createHarness(session)
    const result = await h.pipeline.submit(
      hostQuery({ prompt: '', attachments: [{ type: 'image', url: 'https://example.com/a.png' }] }),
    )
    expect(result.success).toBe(true)
    await h.pipeline.waitForPendingFinalize('conversation-1')
    expect(h.completes).toHaveLength(1)
  })

  it('aborts an in-flight run via abort()', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const session = makeSession(async function* () {
      yield { type: 'agent.stream.lifecycle', payload: { phase: 'start' } } as StreamEvent
      await gate
      yield { type: 'agent.stream.done', payload: {} } as StreamEvent
    })
    const h = createHarness(session)
    const running = h.pipeline.submit(hostQuery())
    await vi.waitFor(() => expect(h.emitted.length).toBeGreaterThan(0))
    h.pipeline.abort({ conversationId: 'conversation-1', sessionId: 'session-1' })
    release()
    const result = await running
    expect(result.success).toBe(false)
    expect(result.aborted).toBe(true)
    await h.pipeline.waitForPendingFinalize('conversation-1')
    expect((h.completes[0] as { kind: string }).kind).toBe('aborted')
  })
})

// 吸收自 query-execution-pipeline.test：PD-13 权威读取 + session 就地 mutate 现内联
// 进 QueryTurnPipeline.runTurn，改为经 submit() 黑盒驱动、断言 session 被就地改写。
describe('DefaultQueryTurnPipeline · PD-13 authoritative mutate', () => {
  it('atomically consumes the host-prepared turn snapshot', async () => {
    const providerMessages: Array<{ role: string; content: unknown }> = []
    let session: FakeSession
    session = makePolicySession(async function* () {
      const state = {
        messages: [{ role: 'user', content: '当前任务' }],
      }
      const hook = buildAgentProfileHook({
        getAgentProfile: () => session.agentProfile,
      })
      await hook.beforeIteration?.({ state } as never)
      providerMessages.push(...state.messages)
      yield { type: 'agent.stream.done', payload: {} } as StreamEvent
    })
    const initial = hostQuery({
      policy: { agentMode: 'agent', appContext: { source: 'wire' } },
    })
    const preparedProfile = {
      agentName: '小Tin',
      customRules: '先理解目标，再直接推进。',
      workspaceRules: '修改后必须验证。',
    }
    const fetchAuthoritative = vi.fn(async () => ({
      security: { allow_yolo_mode: false },
    }))
    const acquire = vi.fn(async () => ({ decision: 'rebuild' as const, session }))
    const h = createHarness(session, {
      acquire,
      fetchAuthoritative,
      prepareTurnInputs: async ({ query }) => ({
        runtime: { ...query.runtime, input: { label: 'prepared' } },
        policy: {
          ...query.policy,
          agentId: 'agent-prepared',
          workspaceId: 'workspace-prepared',
          isGroupSpace: true,
          workspaceSnapshot: { sources: { workingDir: '/wd-prepared' } },
          appContext: { source: 'host-state' },
          agentProfile: preparedProfile,
        },
      }),
    })

    const result = await h.pipeline.submit(initial)

    expect(result.success).toBe(true)
    expect(fetchAuthoritative).toHaveBeenCalledWith({
      agentId: 'agent-prepared',
      sessionId: 'session-1',
      workspaceId: 'workspace-prepared',
    })
    expect(acquire).toHaveBeenCalledWith(expect.objectContaining({ input: { label: 'prepared' } }))
    expect(session.policyContext.isGroupSpace).toBe(true)
    expect(session.workspaceSnapshot?.sources.workingDir).toBe('/wd-prepared')
    expect(session.appContext).toEqual({ source: 'host-state' })
    expect(session.agentProfile).toEqual(preparedProfile)
    expect(initial.policy?.appContext).toEqual({ source: 'wire' })
    const profileTextOf = (content: unknown): string => (
      typeof content === 'string' ? content : JSON.stringify(content)
    )
    const profileMessages = providerMessages.filter(message =>
      profileTextOf(message.content).includes('<context type="agent-profile"'),
    )
    expect(profileMessages).toHaveLength(1)
    expect(profileTextOf(profileMessages[0]?.content)).toContain('小Tin')
    expect(profileTextOf(profileMessages[0]?.content)).toContain('先理解目标，再直接推进。')
  })

  it('does not acquire or partially mutate a session when host preparation fails', async () => {
    const session = makePolicySession(successGen)
    const acquire = vi.fn(async () => ({ decision: 'rebuild' as const, session }))
    const h = createHarness(session, {
      acquire,
      prepareTurnInputs: async () => {
        throw new Error('host turn state unavailable')
      },
    })

    const result = await h.pipeline.submit(hostQuery())

    expect(result).toEqual({ success: false, error: 'host turn state unavailable' })
    expect(acquire).not.toHaveBeenCalled()
    expect(session.appContext).toBeUndefined()
    expect(session.agentProfile).toBeUndefined()
  })

  it('reads authoritative config and mutates session in place before the loop', async () => {
    const session = makePolicySession(successGen)
    const fetchAuthoritative = vi.fn(async () => ({
      security: { allow_yolo_mode: true, approval_grant: 'auto' as const },
    }))
    const h = createHarness(session, {
      fetchAuthoritative,
      buildEffectivePrompt: async ({ query }) => `${query.turn.prompt}::with-attachments`,
    })

    const result = await h.pipeline.submit(
      hostQuery({
        policy: {
          agentId: 'agent-1',
          agentMode: 'yolo',
          approvalMode: 'auto',
          isGroupSpace: false,
          yoloModeFromWire: false,
          workspaceSnapshot: { sources: { workingDir: '/wd-new' } },
          appContext: { userName: 'alice' },
        },
      }),
    )

    expect(result.success).toBe(true)
    expect(fetchAuthoritative).toHaveBeenCalledWith({
      agentId: 'agent-1',
      sessionId: 'session-1',
      workspaceId: undefined,
    })
    // security mutate applied
    expect(session.agentConfigV3?.security.allow_yolo_mode).toBe(true)
    expect(session.agentConfigV3?.security.approval_grant).toBe('auto')
    expect(session.policyContext.currentAgentMode).toBe('yolo')
    // ：wire approval_mode 已退化为兼容字段，不再成为权限数据源。
    expect(session.policyContext.requestedApprovalMode).toBeUndefined()
    // workspace mutate applied (allowedPaths re-derived from sources)
    expect(session.workspaceSnapshot?.sources.workingDir).toBe('/wd-new')
    expect(new Set(session.workspaceSnapshot?.allowedPaths ?? [])).toEqual(
      new Set(['/sandbox', '/wd-new']),
    )
    // appContext written
    expect(session.appContext).toEqual({ userName: 'alice' })
    // effectivePrompt flows into runtime.query params
    expect(h.queryParams[0]?.prompt).toBe('hello::with-attachments')
  })

  it('透传 policy.workspaceId 给 fetchAuthoritative（ ForWorkspace）', async () => {
    const session = makePolicySession(successGen)
    const fetchAuthoritative = vi.fn(async () => ({
      security: { allow_yolo_mode: true, approval_grant: 'full_access' as const },
    }))
    const h = createHarness(session, { fetchAuthoritative })

    await h.pipeline.submit(
      hostQuery({
        policy: {
          agentId: 'agent-1',
          approvalMode: 'full_access',
          workspaceId: 'workspace-full',
        },
      }),
    )

    expect(fetchAuthoritative).toHaveBeenCalledWith({
      agentId: 'agent-1',
      sessionId: 'session-1',
      workspaceId: 'workspace-full',
    })
    expect(session.agentConfigV3?.security.approval_grant).toBe('full_access')
  })

  it('emits yolo mismatch telemetry when client claim != authoritative', async () => {
    const session = makePolicySession(successGen)
    const h = createHarness(session, {
      fetchAuthoritative: async () => ({ security: { allow_yolo_mode: false } }),
    })
    await h.pipeline.submit(
      hostQuery({ policy: { agentId: 'agent-2', yoloModeFromWire: true } }),
    )
    expect(h.infoLogs.some((m) => m.includes('mismatch'))).toBe(true)
  })

  it('does not emit yolo telemetry when client claim matches authoritative', async () => {
    const session = makePolicySession(successGen)
    const h = createHarness(session, {
      fetchAuthoritative: async () => ({ security: { allow_yolo_mode: true } }),
    })
    await h.pipeline.submit(
      hostQuery({ policy: { agentId: 'agent-2', yoloModeFromWire: true } }),
    )
    expect(h.infoLogs.some((m) => m.includes('mismatch'))).toBe(false)
  })

  it('skips authoritative fetch when agentId is missing (legacy session)', async () => {
    const session = makePolicySession(successGen)
    const fetchAuthoritative = vi.fn(async () => null)
    const h = createHarness(session, { fetchAuthoritative })
    await h.pipeline.submit(hostQuery({ policy: { agentMode: 'agent' } }))
    expect(fetchAuthoritative).not.toHaveBeenCalled()
    // authoritativeAllowYolo defaults false → security mutate writes false
    expect(session.agentConfigV3?.security.allow_yolo_mode).toBe(false)
  })

  it('does not touch workspace when incoming snapshot is missing', async () => {
    const session = makePolicySession(successGen)
    const before = session.workspaceSnapshot?.sources.workingDir
    const h = createHarness(session, { fetchAuthoritative: async () => null })
    await h.pipeline.submit(hostQuery({ policy: { agentId: 'agent-x' } }))
    expect(session.workspaceSnapshot?.sources.workingDir).toBe(before)
  })

  it('falls back to turn.prompt when no buildEffectivePrompt port is provided', async () => {
    const session = makePolicySession(successGen)
    const h = createHarness(session, { fetchAuthoritative: async () => null })
    await h.pipeline.submit(hostQuery({ prompt: 'raw-prompt', policy: { agentMode: 'agent' } }))
    expect(h.queryParams[0]?.prompt).toBe('raw-prompt')
  })

  it('#9234 beginSubmit 接受空 prompt + userMessageBlocks（preset/@）', () => {
    const session = makePolicySession(successGen)
    const h = createHarness(session, { fetchAuthoritative: async () => null })
    const accepted = h.pipeline.beginSubmit(hostQuery({
      prompt: '',
      userMessageBlocks: [{ type: 'composer_preset', preset_id: 'skill.demo' }],
    }))
    expect(accepted.ok).toBe(true)
    if (accepted.ok) {
      expect(accepted.acceptance.runDisposition).toBe('started')
    }

    const rejected = h.pipeline.beginSubmit(hostQuery({
      prompt: '',
      userMessageBlocks: undefined,
      attachments: undefined,
    }))
    expect(rejected.ok).toBe(false)
  })
})
