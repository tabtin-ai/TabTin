/**
 * dual-platform-parity.test.ts — behavioral parity between an electron-like host
 * (local viewer stream present) and a daemon-like host (headless, no local UI).
 *
 * Review 指出缺"同一 HostQuery + 相同 fake Port 脚本 → 两端相同 runtime 调用序列 /
 * StreamEvent 序列 / 终态 / 清理序列"的行为 parity 测试。
 *
 * 这里用**同一个 HostQuery**、同一份 runtime 事件脚本跑两遍，唯一变量是
 * DeliveryTransportPort.openLocalStream 的返回：
 *   - electron-like：返回一个本地 LocalStreamPort（有本地 UI 观测流）
 *   - daemon-like：返回 undefined（无头，无本地 UI）
 *
 * 断言两端的 runtime.query 调用序列 / StreamEvent 序列 / 终态 / 清理钩子序列
 * **完全一致**；差异**只允许**出现在 transport 层（本地 stream 有/无）。
 *
 * 用真实的 DefaultDeliveryCoordinator（而非 fake delivery），这样 openLocalStream
 * 的平台差异真的会流经 coordinator——这才是行为 parity（而非源码文本对齐）。
 */

import { describe, expect, it, vi } from 'vitest'
import type { QueryParams, StreamEvent } from '@tabtin/agent-runtime'
import {
  DefaultQueryTurnPipeline,
  type QueryTurnDataPort,
} from '../src/conversation/query-turn-pipeline.js'
import { ConversationSupervisor } from '../src/conversation/conversation-supervisor.js'
import { DefaultDeliveryCoordinator } from '../src/delivery/delivery-coordinator.js'
import type {
  DeliveryTransportPort,
  LocalStreamPort,
  RelayTransportAck,
} from '../src/delivery/delivery-transport-port.js'
import type { HostQuery, HostQueryPolicyInput, HostQueryResult } from '../src/conversation/host-query.js'
import type { RuntimeSessionLifecycle } from '../src/runtime/runtime-session-lifecycle.js'
import type { ExecutionOwner } from '../src/runtime/execution-owner-lifecycle.js'

type Mode = 'agent'
type Platform = 'electron' | 'daemon'

const owner: ExecutionOwner = { userId: 'user-1', organizationId: 'org-1', agentId: 'agent-1' }

interface FakeSession {
  runtime: { query(params: QueryParams): AsyncIterable<StreamEvent> }
  policyContext: { currentAgentMode: string; isGroupSpace: boolean; requestedApprovalMode?: unknown }
  agentConfigV3: { schema_version: number; runtime_plane: string; security: { allow_yolo_mode?: boolean; approval_grant?: string } } | null
  abortController: AbortController
}

/** One canonical HostQuery reused verbatim across both platforms. */
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
    turn: {
      prompt: 'hello',
      clientMessageId: 'cmid-1',
    },
    policy: { agentMode: 'agent' } satisfies HostQueryPolicyInput,
  }
}

function fakeSessionView(session: FakeSession, onAppendStreamEvent: (event: StreamEvent) => void) {
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
      appendStreamEvent: async (e: StreamEvent) => { onAppendStreamEvent(e) },
    },
    eventStorage: { truncateFrom: async () => undefined, append: async () => undefined },
    snapshotStorage: { append: async () => undefined },
    toolProvider: { setSubagentTraceWiring: () => undefined },
    eventEmitter: { buildStream: (e: StreamEvent) => e },
    eventInterceptor: undefined as ((e: StreamEvent) => void) | undefined,
  }
}

/** Platform-neutral behavioral trace (must be identical across platforms). */
interface BehaviorRecord {
  /** Ordered runtime.query base params (buildQueryParams input). */
  runtimeQueryParams: QueryParams[]
  /** Ordered StreamEvent types the pipeline delivered (persist sink → this port). */
  deliveredEventTypes: string[]
  /** Single terminal result of the turn. */
  result: HostQueryResult
  /** Ordered per-turn cleanup hooks. */
  cleanupSeq: string[]
}

/** Transport-level trace (differences here are the ONLY allowed platform delta). */
interface TransportRecord {
  openLocalStreamCalls: number
  localEmittedTypes: string[]
  localCloseReason: 'completed' | 'aborted' | null
  localFailed: string[]
  relayBatches: string[][]
}

function createParityTransport(platform: Platform): {
  transport: DeliveryTransportPort
  record: TransportRecord
} {
  const record: TransportRecord = {
    openLocalStreamCalls: 0,
    localEmittedTypes: [],
    localCloseReason: null,
    localFailed: [],
    relayBatches: [],
  }
  const localStream: LocalStreamPort = {
    emit: (e) => record.localEmittedTypes.push(e.type),
    fail: (err) => record.localFailed.push(err.message),
    close: (reason) => { record.localCloseReason = reason },
    shouldAbortIteration: () => false,
  }
  const transport: DeliveryTransportPort = {
    openLocalStream: () => {
      record.openLocalStreamCalls += 1
      return platform === 'electron' ? localStream : undefined
    },
    sendRelayBatch: async (_ctx, events): Promise<RelayTransportAck> => {
      record.relayBatches.push(events.map((e) => e.type))
      return {}
    },
    createOutboxStore: () => ({
      persist: () => undefined,
      // eslint-disable-next-line require-yield
      drain: async function* () { return },
      remove: () => undefined,
    }),
    subscribeReconnect: () => () => undefined,
  }
  return { transport, record }
}

interface Harness {
  pipeline: DefaultQueryTurnPipeline<FakeSession, { label: string }, Mode, never>
  behavior: BehaviorRecord
  transport: TransportRecord
}

function createHarness(
  platform: Platform,
  genFactory: (params: QueryParams) => AsyncIterable<StreamEvent>,
): Harness {
  const behavior: BehaviorRecord = {
    runtimeQueryParams: [],
    deliveredEventTypes: [],
    result: { success: false },
    cleanupSeq: [],
  }
  const session: FakeSession = {
    runtime: { query: (params) => genFactory(params) },
    policyContext: { currentAgentMode: 'agent', isGroupSpace: false },
    agentConfigV3: null,
    abortController: new AbortController(),
  }
  const { transport, record } = createParityTransport(platform)
  const delivery = new DefaultDeliveryCoordinator({ transport })

  const lifecycle: RuntimeSessionLifecycle<{ label: string }, FakeSession, Mode, never> = {
    acquire: async () => ({ decision: 'rebuild', session }),
    updateLivePolicy: async () => undefined,
    disposeSession: async () => { behavior.cleanupSeq.push('disposeSession') },
    replaceOwner: async () => true,
    disposeOwner: async () => undefined,
    stop: async () => undefined,
  }

  const views = new WeakMap<FakeSession, ReturnType<typeof fakeSessionView>>()
  const ports: QueryTurnDataPort<FakeSession, { label: string }, Mode, never> = {
    lifecycle,
    delivery,
    log: { info: () => undefined, warn: () => undefined },
    sessionView: (s) => {
      let v = views.get(s)
      if (!v) {
        v = fakeSessionView(s, (e) => behavior.deliveredEventTypes.push(e.type))
        views.set(s, v)
      }
      return v
    },
    runtimeOf: (s) => s.runtime,
    organizationIdOf: () => 'org-1',
    fetchAuthoritative: async () => null,
    prepareRuntimeAttachments: async () => [],
    buildQueryParams: (base) => { behavior.runtimeQueryParams.push(base); return base },
    // persist sink → session storage; recorded via fakeSessionView appendStreamEvent.
    appendStreamEventToSessionStorage: async (s, e) => {
      const v = ports.sessionView(s)
      await v.sessionStorage.appendStreamEvent(e)
    },
    buildLifecycleErrorEvent: () => ({ type: 'agent.stream.lifecycle', payload: { phase: 'error' } } as StreamEvent),
    flushTurnStorage: () => { behavior.cleanupSeq.push('flushTurnStorage') },
    onTurnFinally: () => { behavior.cleanupSeq.push('onTurnFinally') },
  }

  const supervisor = new ConversationSupervisor<
    HostQuery<{ label: string }, Mode, never>,
    HostQueryResult,
    FakeSession
  >()
  const pipeline = new DefaultQueryTurnPipeline({ ports, supervisor })
  return { pipeline, behavior, transport: record }
}

// A deterministic success script reused across platforms.
async function* successGen(): AsyncIterable<StreamEvent> {
  yield { type: 'agent.stream.lifecycle', payload: { phase: 'start', trace_id: 't1' } } as StreamEvent
  yield { type: 'agent.stream.assistant', payload: { phase: 'final', text: 'hi' } } as StreamEvent
  yield { type: 'agent.stream.done', payload: {} } as StreamEvent
}

describe('dual-platform parity', () => {
  it('success turn produces identical runtime/StreamEvent/terminal/cleanup across electron & daemon', async () => {
    const electron = createHarness('electron', successGen)
    const daemon = createHarness('daemon', successGen)

    // 同一个 HostQuery（结构相同）跑两遍。
    electron.behavior.result = await electron.pipeline.submit(hostQuery())
    daemon.behavior.result = await daemon.pipeline.submit(hostQuery())
    await electron.pipeline.waitForPendingFinalize('conversation-1')
    await daemon.pipeline.waitForPendingFinalize('conversation-1')

    // ── 行为 parity：两端必须完全一致 ──
    // runtime.query 调用序列与参数一致。`signal` 是每个 session 独立的
    // AbortController 实例（两端本就是不同对象），比对时剥离，只对齐语义字段。
    const stripRuntimeLocalPorts = (params: QueryParams[]) =>
      params.map(({ signal: _signal, waitIfPaused: _waitIfPaused, ...rest }) => rest)
    expect(stripRuntimeLocalPorts(daemon.behavior.runtimeQueryParams)).toEqual(
      stripRuntimeLocalPorts(electron.behavior.runtimeQueryParams),
    )
    expect(electron.behavior.runtimeQueryParams).toHaveLength(1)
    expect(electron.behavior.runtimeQueryParams[0]?.prompt).toBe('hello')
    expect(electron.behavior.runtimeQueryParams[0]?.clientMessageId).toBe('cmid-1')
    expect(typeof electron.behavior.runtimeQueryParams[0]?.waitIfPaused).toBe('function')
    expect(typeof daemon.behavior.runtimeQueryParams[0]?.waitIfPaused).toBe('function')
    // StreamEvent 序列一致。
    expect(daemon.behavior.deliveredEventTypes).toEqual(electron.behavior.deliveredEventTypes)
    expect(electron.behavior.deliveredEventTypes).toEqual([
      'agent.stream.lifecycle',
      'agent.stream.assistant',
      'agent.stream.done',
    ])
    // 终态一致（succeeded）。
    expect(daemon.behavior.result).toEqual(electron.behavior.result)
    expect(electron.behavior.result).toEqual({ success: true })
    // 清理钩子序列一致。
    expect(daemon.behavior.cleanupSeq).toEqual(electron.behavior.cleanupSeq)
    expect(electron.behavior.cleanupSeq).toEqual(['flushTurnStorage', 'onTurnFinally'])

    // relay 序列也一致（两端都把同样的事件转发到 relay）。
    expect(daemon.transport.relayBatches).toEqual(electron.transport.relayBatches)

    // ── 差异只允许出现在 transport 层（本地 stream 有/无）──
    // electron 有本地流：openLocalStream 命中、有本地 emit、终态 close('completed')。
    expect(electron.transport.openLocalStreamCalls).toBe(1)
    expect(electron.transport.localEmittedTypes).toEqual([
      'agent.stream.lifecycle',
      'agent.stream.assistant',
      'agent.stream.done',
    ])
    expect(electron.transport.localCloseReason).toBe('completed')
    // daemon 无本地流：openLocalStream 返回 undefined，没有任何本地 emit / close。
    expect(daemon.transport.openLocalStreamCalls).toBe(1)
    expect(daemon.transport.localEmittedTypes).toEqual([])
    expect(daemon.transport.localCloseReason).toBeNull()
  })

  it('aborted turn produces identical behavior across electron & daemon (only local sentinel differs)', async () => {
    let releaseElectron!: () => void
    let releaseDaemon!: () => void

    function gatedGen(release: (fn: () => void) => void): () => AsyncIterable<StreamEvent> {
      return async function* () {
        yield { type: 'agent.stream.lifecycle', payload: { phase: 'start' } } as StreamEvent
        await new Promise<void>((r) => release(r))
        // ：中断后主循环仍 drain 终态白名单，done 会被投递。
        yield { type: 'agent.stream.done', payload: {} } as StreamEvent
      }
    }

    const electron = createHarness('electron', gatedGen((r) => { releaseElectron = r }))
    const daemon = createHarness('daemon', gatedGen((r) => { releaseDaemon = r }))

    const electronRun = electron.pipeline.submit(hostQuery())
    await vi.waitFor(() => expect(electron.behavior.deliveredEventTypes.length).toBeGreaterThan(0))
    electron.pipeline.abort({ conversationId: 'conversation-1', sessionId: 'session-1' })
    releaseElectron()
    electron.behavior.result = await electronRun

    const daemonRun = daemon.pipeline.submit(hostQuery())
    await vi.waitFor(() => expect(daemon.behavior.deliveredEventTypes.length).toBeGreaterThan(0))
    daemon.pipeline.abort({ conversationId: 'conversation-1', sessionId: 'session-1' })
    releaseDaemon()
    daemon.behavior.result = await daemonRun

    await electron.pipeline.waitForPendingFinalize('conversation-1')
    await daemon.pipeline.waitForPendingFinalize('conversation-1')

    // ── 行为 parity ──
    expect(daemon.behavior.deliveredEventTypes).toEqual(electron.behavior.deliveredEventTypes)
    // ：abort 后仍投递终态白名单（本测 gen 在中断后只再 yield done）。
    expect(electron.behavior.deliveredEventTypes).toEqual([
      'agent.stream.lifecycle',
      'agent.stream.done',
    ])
    // 终态一致（aborted → success:false + aborted:true，无 error 文案）。
    expect(daemon.behavior.result).toEqual(electron.behavior.result)
    expect(electron.behavior.result).toEqual({ success: false, aborted: true })
    // 清理序列一致。
    expect(daemon.behavior.cleanupSeq).toEqual(electron.behavior.cleanupSeq)
    expect(electron.behavior.cleanupSeq).toEqual(['flushTurnStorage', 'onTurnFinally'])
    expect(daemon.transport.relayBatches).toEqual(electron.transport.relayBatches)

    // ── 差异只在 transport 层 ──
    expect(electron.transport.localCloseReason).toBe('aborted')
    expect(daemon.transport.localCloseReason).toBeNull()
    expect(daemon.transport.localEmittedTypes).toEqual([])
  })
})
