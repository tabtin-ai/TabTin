/**
 * ：SessionController.send 只等 host accepted ACK，不再挂 SessionExecutionWaiter。
 * 真挂死 / busy 续期由 SessionRunReconcile sweep 与 run_sync 投影承接；
 * 本文件回归「send = dispatch ACK」契约，避免再把 ACK 当整轮结束。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createStreamMessageHandler } from '@/stores/chat/stream/handlers/streamMessageHandler'
import {
  getSessionController,
  __resetStreamHubsForTest,
  __resetExecutionWatchdogHooksForTest,
  hasUnsettledExecutionWaiter,
  type SessionStreamDeps,
} from '../index'
import { runtimeStoreAccess } from '../runtimeStoreAccess'

vi.mock('@/stores/chat/stream/handlers/streamMessageHandler', () => ({
  createStreamMessageHandler: vi.fn(() => vi.fn()),
}))

vi.mock('@/stores/useChatRuntimeStore', () => ({
  useChatRuntimeStore: { getState: () => ({}), setState: () => {} },
}))

vi.mock('../../chatApi', () => ({
  getChatClient: vi.fn(() => ({
    getGateway: () => ({ request: vi.fn() }),
  })),
}))

const localQuerySpy = vi.fn()
vi.mock('../../localAgentClient', () => ({
  getLocalAgentClient: vi.fn(() => ({
    stream: vi.fn(),
    query: localQuerySpy,
    abort: vi.fn(),
  })),
  isLocalRuntimeAvailable: () => true,
}))

vi.mock('../../remoteExecutionGuard', () => ({
  resolveExecutionTargetLocation: () => 'local',
}))

vi.mock('@/services/sessionFreshness', () => ({
  hydrateAfterLostStream: vi.fn(() => Promise.resolve()),
  scheduleLostStreamHydrate: vi.fn(),
}))

vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => ({ removeStreamingSession: vi.fn() }),
  },
}))
vi.mock('@/stores/chat/stream/handlers/sessionCleanup', () => ({
  endSessionRun: vi.fn(),
}))

vi.mock('../streamSources', () => ({
  ensureLiveStreamIpc: vi.fn(async () => {}),
  __resetBusyRetainForTest: vi.fn(),
}))

const SID = 'sess-watchdog-1'
const ACCEPTED_ACK = {
  runId: 'run-1',
  runDisposition: 'started',
  queuePosition: 0,
}

function deps(): SessionStreamDeps {
  return {
    getContext: () => ({}),
    client: {} as never,
    addStreamingSession: () => {},
    removeStreamingSession: () => {},
    updateSessionTokenUsageInCaches: () => {},
    updateSessionInCaches: () => {},
  }
}

beforeEach(() => {
  __resetStreamHubsForTest()
  __resetExecutionWatchdogHooksForTest()
  runtimeStoreAccess.registerAccess({
    get: () => ({}) as never,
    set: (() => {}) as never,
    flushRuntimeBatch: () => {},
    reconcileSubagentRunsFromArchive: async () => {},
  })
  runtimeStoreAccess.registerStreamHandlerFactory((d) => createStreamMessageHandler(d))
  localQuerySpy.mockReset().mockResolvedValue(ACCEPTED_ACK)
  vi.stubGlobal('window', { tabtin: { agentEngine: {} } })
})

afterEach(() => {
  __resetExecutionWatchdogHooksForTest()
  runtimeStoreAccess.resetAccessForTest()
  runtimeStoreAccess.resetStreamHandlerFactoryForTest()
  vi.unstubAllGlobals()
})

describe('SessionController.send · accepted ACK only ', () => {
  it('query ACK 后立即返回，不占 execution waiter', async () => {
    const { hydrateAfterLostStream } = await import('@/services/sessionFreshness')
    getSessionController(SID).attachStream(deps())
    const outcome = await getSessionController(SID).send({
      runtimeExecution: () => ({ message: 'hi', deps: deps() }),
    })
    expect(outcome).toEqual({
      route: 'runtime',
      result: {
        session_id: SID,
        thread_id: SID,
        ...ACCEPTED_ACK,
      },
    })
    expect(hasUnsettledExecutionWaiter(SID)).toBe(false)
    expect(hydrateAfterLostStream).not.toHaveBeenCalled()
  })

  it('query 挂起时 send 也挂起；ACK 后即 resolve（与流终态无关）', async () => {
    let resolveQuery!: () => void
    localQuerySpy.mockImplementation(
      () => new Promise<typeof ACCEPTED_ACK>((resolve) => {
        resolveQuery = () => resolve(ACCEPTED_ACK)
      }),
    )
    getSessionController(SID).attachStream(deps())
    const sendPromise = getSessionController(SID).send({
      runtimeExecution: () => ({ message: 'queued', deps: deps() }),
    })
    await vi.waitFor(() => expect(localQuerySpy).toHaveBeenCalled())
    expect(hasUnsettledExecutionWaiter(SID)).toBe(false)
    resolveQuery()
    await expect(sendPromise).resolves.toEqual({
      route: 'runtime',
      result: {
        session_id: SID,
        thread_id: SID,
        ...ACCEPTED_ACK,
      },
    })
  })
})
