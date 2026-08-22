import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'

const {
  abortStreamForSessionAndWait,
  abortRuntime,
  abortRunIpc,
  withdrawUnansweredTurnIpc,
  gatewayRequest,
  runtimeState,
  cleanupSessionOnTerminal,
  mockSendMessage,
} = vi.hoisted(() => ({
  abortStreamForSessionAndWait: vi.fn(),
  abortRuntime: vi.fn(),
  // ：出站 abort 下沉主进程后，渲染进程只发 agent-engine:abort-run 一次 IPC。
  abortRunIpc: vi.fn(),
  // ：撤回未答轮次经 runtime IPC。
  withdrawUnansweredTurnIpc: vi.fn(),
  gatewayRequest: vi.fn(),
  mockSendMessage: vi.fn(),
  runtimeState: {
    agentModeBySessionId: {} as Record<string, string>,
    runProjectionBySessionId: {} as Record<string, { busy: boolean; queuedRunIds: string[]; source: string; lastSyncAt: number }>,
    activeSubmittedMessageBySessionId: {} as Record<string, unknown>,
    toolEventsBySessionId: {} as Record<string, unknown[]>,
    trimToolEventsForSession: vi.fn(),
    markStreamingWidgetsInterruptedAndClearOthers: vi.fn(),
    setCancellingForSession: vi.fn(),
    moveActiveSubmittedMessageToInterruptedRecovery: vi.fn(),
    clearActiveSubmittedMessage: vi.fn(),
    evictSession: vi.fn(),
  },
  cleanupSessionOnTerminal: vi.fn(),
}))

vi.mock('../../services/chatApi', () => ({
  getChatClient: () => ({
    abortStreamForSessionAndWait,
    abortStreamAndWait: vi.fn(),
    abortStreamForSession: vi.fn(),
    abortStream: vi.fn(),
    getGateway: () => ({
      request: gatewayRequest,
    }),
  }),
}))

vi.mock('./shared/storeAccessRegistry', () => ({
  registerChatStoreCallbacks: vi.fn(),
  registerChatSessionAccess: vi.fn(),
  registerHitlStoreAccess: vi.fn(),
}))

vi.mock('../sessionResetRegistry', () => ({
  registerResetAction: vi.fn(),
}))

vi.mock('../../services/chatClientSingleton', () => ({
  setReconnectHandler: vi.fn(),
  getChatClientInstance: vi.fn(() => null),
}))

vi.mock('../deviceStatusEvents', () => ({
  onDeviceStatusMessage: vi.fn(),
}))

vi.mock('../../services/sessionFreshness', () => ({
  ensureSessionFresh: vi.fn(),
}))

vi.mock('../../services/sessionSuspended', () => ({
  markSessionsSuspended: vi.fn(),
}))

vi.mock('../useSessionFreshnessStore', () => ({
  useSessionFreshnessStore: {
    getState: () => ({}),
  },
}))

vi.mock('../useWsConnectionStore', () => ({
  useWsConnectionStore: {
    getState: () => ({
      removeSuspendedSession: vi.fn(),
    }),
  },
}))

vi.mock('../useAuthStore', () => ({
  useAuthStore: {
    getState: () => ({ accessToken: 'test-token' }),
  },
}))

vi.mock('../useSpaceStore', () => ({
  useSpaceStore: {
    getState: () => ({
      selectedSpace: null,
      spaces: [],
      selectedAgent: null,
      agentCache: {},
    }),
  },
}))

vi.mock('@/constants/layout', () => ({
  LayoutConstraints: {
    chat: {
      defaultWidth: 420,
      minWidth: 360,
      maxWidth: 940,
    },
    pinned: { defaultWidth: 320, minWidth: 240, maxWidth: 640 },
    chatSidePanel: { defaultWidth: 420, minWidth: 320, maxWidth: 940 },
    canvasSidePanel: { defaultWidth: 420, minWidth: 320, maxWidth: 940 },
    chatSessionList: { defaultWidth: 320, minWidth: 240, maxWidth: 640 },
  },
}))

vi.mock('@/i18n', () => ({
  default: {
    t: (key: string, fallback?: { defaultValue?: string }) => fallback?.defaultValue ?? key,
  },
}))

vi.mock('./execution/chatTelemetry', () => ({
  trackChatTelemetry: vi.fn(),
}))

vi.mock('./execution/streamingContent', () => ({
  streamingContent: {
    get: vi.fn(() => null),
    clear: vi.fn(),
    clearAll: vi.fn(),
  },
}))

vi.mock('./stream/handlers/seqTracker', () => ({
  cleanup: vi.fn(),
}))

vi.mock('./checkpoint/slices/checkpointSlice', () => ({
  createCheckpointActions: () => ({
    reconcileSessionState: vi.fn(),
  }),
}))

vi.mock('./session/slices/sessionCrudSlice', () => ({
  createSessionCrudActions: () => ({
    selectSession: vi.fn(),
    syncSessionMessagesFromServer: vi.fn(async () => undefined),
  }),
  shouldApplyGeneratedTitleUpdate: vi.fn(() => true),
}))

vi.mock('./hitl/slices/approvalSlice', () => ({
  createApprovalActions: () => ({}),
}))

vi.mock('./hitl/slices/askUserSlice', () => ({
  createAskUserActions: () => ({}),
}))

vi.mock('./session/slices/contextSyncSlice', () => ({
  createContextSyncActions: () => ({}),
}))

vi.mock('./session/actions/sessionLifecycleAction', () => ({
  createSessionLifecycleAction: () => ({}),
}))

vi.mock('./messages/actions/sendMessageAction', () => ({
  createSendMessageAction: () => mockSendMessage,
}))

vi.mock('../useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: {
    getState: () => ({
      itemsBySpace: {},
      activeKeyBySpace: {},
    }),
  },
}))

vi.mock('@tabtin/smartsheet-ui/toast', () => ({
  toast: vi.fn(),
}))

vi.mock('../../services/chatExtraApi', () => ({
  locateMessage: vi.fn(),
}))

vi.mock('../../services/powerService', () => ({
  preventSleep: vi.fn(),
  allowSleep: vi.fn(),
}))

vi.mock('@/utils/logger', () => ({
  logger: {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  createLogger: () => ({
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

vi.mock('../useWorkbenchSceneStore', () => ({
  fromWorkbenchSceneId: vi.fn(() => null),
  useWorkbenchSceneStore: {
    getState: () => ({ foregroundSceneId: null }),
    subscribe: () => () => {},
  },
}))

vi.mock('../useChatRuntimeStore', () => ({
  useChatRuntimeStore: {
    getState: () => runtimeState,
    setState: (partial: unknown) => {
      const next = typeof partial === 'function'
        ? (partial as (state: typeof runtimeState) => Partial<typeof runtimeState>)(runtimeState)
        : partial
      Object.assign(runtimeState, next)
    },
    // ：useChatStore bootstrap 订阅投影驱动防睡眠——mock 需提供 subscribe。
    subscribe: () => () => {},
  },
}))

vi.mock('./stream/handlers/sessionCleanup', () => ({
  cleanupSessionOnTerminal,
  // ：performCancelCleanup 改调 endSessionRun（实现上 ≡ cleanup）
  endSessionRun: cleanupSessionOnTerminal,
  endSessionRunIfStarted: cleanupSessionOnTerminal,
}))

import { useChatStore } from './useChatStore'
import { streamingContent } from './execution/streamingContent'
import { isSessionBusy } from './execution/sessionRunProjection'
import { __resetAbortGraceForTest, isWithinAbortGrace } from './stream/handlers/abortGrace'

describe('useChatStore abortStreamAndWait', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    abortStreamForSessionAndWait.mockResolvedValue({ cancelRequested: true, cancelCompleted: true })
    abortRuntime.mockResolvedValue({ success: true })
    // 默认本机命中：abort-run 一次 IPC 收口本机 + 远端兜底，返回 AbortRunResult。
    abortRunIpc.mockResolvedValue({ localHit: true, remoteRequested: false, remoteAccepted: false, remotePublished: null })
    withdrawUnansweredTurnIpc.mockResolvedValue({
      success: true,
      aborted: { localHit: true, remoteRequested: false, remoteAccepted: false, remotePublished: null },
      runtimeApplied: true,
      keepMessageCount: 0,
      backendProjected: true,
    })
    gatewayRequest.mockResolvedValue({ ok: true, type: 'chat.cancel.ok', payload: { published: 1 } })
    mockSendMessage.mockReset().mockResolvedValue(undefined)
    ;(window as unknown as { tabtin?: unknown }).tabtin = {
      agentEngine: {
        abort: abortRuntime,
        abortRun: abortRunIpc,
        withdrawUnansweredTurn: withdrawUnansweredTurnIpc,
      },
    }
    window.localStorage.clear()
    window.sessionStorage.clear()
    // ：执行态用单一投影驱动 isSessionBusy（取代已删的 streamingBySessionId）。
    runtimeState.runProjectionBySessionId = {
      'session-1': { busy: true, queuedRunIds: [], source: 'event', lastSyncAt: Date.now() },
    }
    useChatStore.setState({
      currentSessionId: 'session-1',
      messagesBySessionId: {
        'session-1': [{
          id: 'assistant-1',
          role: 'assistant',
          content: 'running',
          created_at: '2026-06-20T00:00:00.000Z',
          agent_type: null,
          intent: null,
        } as ChatMessage],
      },
      pendingApprovalBySessionId: {},
      pendingAskUserBySessionId: {},
    })
    runtimeState.moveActiveSubmittedMessageToInterruptedRecovery.mockReset()
    runtimeState.clearActiveSubmittedMessage.mockReset()
    runtimeState.activeSubmittedMessageBySessionId = {}
    runtimeState.toolEventsBySessionId = {}
    vi.mocked(streamingContent.get).mockReturnValue(undefined)
    __resetAbortGraceForTest()
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    delete (window as unknown as { tabtin?: unknown }).tabtin
  })

  it('abortStream 与 AndWait 一样写入 cancelling（丢弃尾部；#7669 不再用它禁 drain）', () => {
    useChatStore.getState().abortStream('session-1')

    expect(runtimeState.setCancellingForSession).toHaveBeenCalledWith('session-1', true)
    expect(cleanupSessionOnTerminal).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      status: 'cancelled',
    }))
    // /#9234：abort 不宣布闲；busy 等后续 run_sync idle / reconcile。
    expect(isSessionBusy('session-1')).toBe(true)
  })

  it('等待式 abort 会立即打到本地 runtime 并进入 cancelling 态', async () => {
    const result = await useChatStore.getState().abortStreamAndWait(4_000, 'session-1')

    expect(result).toEqual({ cancelRequested: true, cancelCompleted: true })
    expect(runtimeState.setCancellingForSession).toHaveBeenCalledWith('session-1', true)
    // ：本机 abort + 远端兜底收口主进程，渲染进程只发一次 abort-run IPC。
    expect(abortRunIpc).toHaveBeenCalledWith('session-1')
    expect(abortStreamForSessionAndWait).toHaveBeenCalledWith('session-1', 4_000)
    expect(cleanupSessionOnTerminal).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      status: 'cancelled',
    }))
    expect(isSessionBusy('session-1')).toBe(true)
    expect(useChatStore.getState().messagesBySessionId['session-1'][0]).toMatchObject({
      intent: 'interrupted',
    })
  })

  it('全局 abort 不为非 busy 的当前会话登记旧流屏障', async () => {
    runtimeState.runProjectionBySessionId = {
      'session-1': { busy: false, queuedRunIds: [], source: 'event', lastSyncAt: Date.now() },
    }

    await useChatStore.getState().abortStreamAndWait(4_000)

    expect(isWithinAbortGrace('session-1')).toBe(false)
    expect(runtimeState.setCancellingForSession).not.toHaveBeenCalledWith('session-1', true)
  })

  it('abort 立即收尾、不阻塞等旧流 unwind（插队立即响应）', async () => {
    const result = await useChatStore.getState().abortStreamAndWait(4_000, 'session-1')

    expect(result).toEqual({ cancelRequested: true, cancelCompleted: true })
    expect(isSessionBusy('session-1')).toBe(true)
  })

  it('等待式 abort 以 runtime 命中结果为准，不被 StreamManager 的监听清理结果卡住', async () => {
    abortStreamForSessionAndWait.mockResolvedValue({ cancelRequested: false, cancelCompleted: false })
    // 本机命中：abort-run 返回 localHit，无需远端兜底。
    abortRunIpc.mockResolvedValue({ localHit: true, remoteRequested: false, remoteAccepted: false, remotePublished: null })

    const result = await useChatStore.getState().abortStreamAndWait(4_000, 'session-1')

    expect(result).toEqual({ cancelRequested: true, cancelCompleted: true })
    // 渲染进程不再自持 chat.cancel——远端兜底在主进程 handleAbortRun 内完成。
    expect(gatewayRequest).not.toHaveBeenCalled()
  })

  it('等待式 abort 本机 miss 时以后端 chat.cancel accepted 作为可继续信号', async () => {
    abortStreamForSessionAndWait.mockResolvedValue({ cancelRequested: false, cancelCompleted: false })
    // 本机 miss → 主进程已发 chat.cancel 兜底并 accepted（published=0：设备离线但 marker 落库）。
    abortRunIpc.mockResolvedValue({ localHit: false, remoteRequested: true, remoteAccepted: true, remotePublished: 0 })

    const result = await useChatStore.getState().abortStreamAndWait(4_000, 'session-1')

    expect(result).toEqual({ cancelRequested: true, cancelCompleted: true })
    expect(abortRunIpc).toHaveBeenCalledWith('session-1')
  })

  it('停止并编辑会撤回本轮用户消息及之后半截助手，并登记恢复候选', async () => {
    runtimeState.moveActiveSubmittedMessageToInterruptedRecovery.mockReturnValue({
      clientMessageId: '642f0898-aec4-45d6-97ca-4538a8e9bf6f',
      localMessageId: 'temp-user-1',
      message: '请把这段内容改短',
    })
    useChatStore.setState({
      messagesBySessionId: {
        'session-1': [
          {
            id: 'older-user',
            role: 'user',
            content: '上一轮',
            created_at: '2026-06-20T00:00:00.000Z',
          } as ChatMessage,
          {
            id: 'temp-user-1',
            role: 'user',
            content: '请把这段内容改短',
            created_at: '2026-06-20T00:00:00.000Z',
            metadata: { client_message_id: '642f0898-aec4-45d6-97ca-4538a8e9bf6f' },
          } as ChatMessage,
          {
            id: 'assistant-1',
            role: 'assistant',
            content: '正在处理',
            created_at: '2026-06-20T00:00:01.000Z',
          } as ChatMessage,
        ],
      },
    })

    await useChatStore.getState().abortStreamForUserEdit('session-1')

    expect(runtimeState.moveActiveSubmittedMessageToInterruptedRecovery).toHaveBeenCalledWith('session-1')
    expect(withdrawUnansweredTurnIpc).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      clientMessageId: '642f0898-aec4-45d6-97ca-4538a8e9bf6f',
      localMessageId: 'temp-user-1',
      targetContent: '请把这段内容改短',
    }))
    expect(useChatStore.getState().messagesBySessionId['session-1']).toEqual([
      expect.objectContaining({ id: 'older-user' }),
    ])
  })

  it('withdraw 等待期间已建立 abort grace，阻止 late stream 重建助手消息', async () => {
    runtimeState.moveActiveSubmittedMessageToInterruptedRecovery.mockReturnValue({
      clientMessageId: '642f0898-aec4-45d6-97ca-4538a8e9bf6f',
      localMessageId: 'temp-user-1',
      message: '请把这段内容改短',
    })
    useChatStore.setState({
      messagesBySessionId: {
        'session-1': [
          {
            id: 'temp-user-1',
            role: 'user',
            content: '请把这段内容改短',
            created_at: '2026-06-20T00:00:00.000Z',
          } as ChatMessage,
        ],
      },
    })

    let resolveWithdraw: ((value: unknown) => void) | undefined
    withdrawUnansweredTurnIpc.mockReturnValue(new Promise(resolve => {
      resolveWithdraw = resolve
    }))

    const pendingAbort = useChatStore.getState().abortStreamForUserEdit('session-1')

    expect(isWithinAbortGrace('session-1')).toBe(true)
    expect(runtimeState.setCancellingForSession).toHaveBeenCalledWith('session-1', true)

    resolveWithdraw?.({ runtimeApplied: true, backendProjected: true })
    await pendingAbort
  })

  it('Composer Stop：尚无实质输出 → 撤回并回填', async () => {
    runtimeState.activeSubmittedMessageBySessionId = {
      'session-1': {
        clientMessageId: '642f0898-aec4-45d6-97ca-4538a8e9bf6f',
        localMessageId: 'temp-user-1',
        message: '请把这段内容改短',
      },
    }
    runtimeState.toolEventsBySessionId = {}
    runtimeState.moveActiveSubmittedMessageToInterruptedRecovery.mockReturnValue({
      clientMessageId: '642f0898-aec4-45d6-97ca-4538a8e9bf6f',
      localMessageId: 'temp-user-1',
      message: '请把这段内容改短',
    })
    vi.mocked(streamingContent.get).mockReturnValue(undefined)
    useChatStore.setState({
      messagesBySessionId: {
        'session-1': [
          {
            id: 'temp-user-1',
            role: 'user',
            content: '请把这段内容改短',
            created_at: '2026-06-20T00:00:00.000Z',
            metadata: { client_message_id: '642f0898-aec4-45d6-97ca-4538a8e9bf6f' },
          } as ChatMessage,
        ],
      },
    })

    await useChatStore.getState().abortStreamFromComposer('session-1')

    expect(runtimeState.moveActiveSubmittedMessageToInterruptedRecovery).toHaveBeenCalledWith('session-1')
    expect(withdrawUnansweredTurnIpc).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      clientMessageId: '642f0898-aec4-45d6-97ca-4538a8e9bf6f',
    }))
    expect(useChatStore.getState().messagesBySessionId['session-1']).toEqual([])
  })

  it('Composer Stop：已有流式正文 → 只停答不回填', async () => {
    runtimeState.activeSubmittedMessageBySessionId = {
      'session-1': {
        clientMessageId: '642f0898-aec4-45d6-97ca-4538a8e9bf6f',
        localMessageId: 'temp-user-1',
        message: '请把这段内容改短',
      },
    }
    runtimeState.toolEventsBySessionId = {}
    vi.mocked(streamingContent.get).mockReturnValue({
      messageId: 'assistant-1',
      content: '已经开始写了',
    })
    useChatStore.setState({
      messagesBySessionId: {
        'session-1': [
          {
            id: 'temp-user-1',
            role: 'user',
            content: '请把这段内容改短',
            created_at: '2026-06-20T00:00:00.000Z',
            metadata: { client_message_id: '642f0898-aec4-45d6-97ca-4538a8e9bf6f' },
          } as ChatMessage,
          {
            id: 'assistant-1',
            role: 'assistant',
            content: '已经开始写了',
            created_at: '2026-06-20T00:00:01.000Z',
          } as ChatMessage,
        ],
      },
    })

    await useChatStore.getState().abortStreamFromComposer('session-1')

    expect(runtimeState.clearActiveSubmittedMessage).toHaveBeenCalledWith('session-1')
    expect(runtimeState.moveActiveSubmittedMessageToInterruptedRecovery).not.toHaveBeenCalled()
    expect(withdrawUnansweredTurnIpc).not.toHaveBeenCalled()
    expect(useChatStore.getState().messagesBySessionId['session-1']).toEqual([
      expect.objectContaining({ id: 'temp-user-1' }),
      expect.objectContaining({ id: 'assistant-1' }),
    ])
  })
})
