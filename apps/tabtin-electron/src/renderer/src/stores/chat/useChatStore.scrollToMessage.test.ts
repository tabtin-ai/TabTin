import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'

// ：跳转到未加载的旧消息应经后端 around= 端点自动加载上下文窗口，
// 而不是只弹「请向上滚动」把加载责任甩给用户。本测试锁定 scrollToMessage /
// navigateToMessage 的自动加载行为，防止两条跳转路径再次退回「只写 target」。

const { mockMessagesList, mockSelectSession, mockToast } = vi.hoisted(() => ({
  mockMessagesList: vi.fn(),
  mockSelectSession: vi.fn(async () => undefined),
  mockToast: vi.fn(),
}))

vi.mock('../../services/chatApi', () => ({
  getChatClient: () => ({
    messages: { list: mockMessagesList },
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
  useSessionFreshnessStore: { getState: () => ({}) },
}))

vi.mock('../useWsConnectionStore', () => ({
  useWsConnectionStore: {
    getState: () => ({ removeSuspendedSession: vi.fn() }),
  },
}))

vi.mock('../useAuthStore', () => ({
  useAuthStore: { getState: () => ({ accessToken: 'test-token' }) },
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
    chat: { defaultWidth: 420, minWidth: 360, maxWidth: 940 },
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
  createCheckpointActions: () => ({ reconcileSessionState: vi.fn() }),
}))

vi.mock('./session/slices/sessionCrudSlice', () => ({
  createSessionCrudActions: () => ({
    selectSession: mockSelectSession,
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
  createSendMessageAction: () => vi.fn(),
}))

vi.mock('../useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: {
    getState: () => ({ itemsBySpace: {}, activeKeyBySpace: {} }),
  },
}))

vi.mock('@tabtin/smartsheet-ui/toast', () => ({
  toast: mockToast,
}))

vi.mock('../../services/chatExtraApi', () => ({}))

vi.mock('../../services/powerService', () => ({
  preventSleep: vi.fn(),
  allowSleep: vi.fn(),
}))

vi.mock('@/utils/logger', () => ({
  logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createLogger: () => ({ log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

vi.mock('../useWorkbenchSceneStore', () => ({
  fromWorkbenchSceneId: vi.fn(() => null),
  useWorkbenchSceneStore: { getState: () => ({ foregroundSceneId: null }) },
}))

vi.mock('../useChatRuntimeStore', () => ({
  useChatRuntimeStore: {
    getState: () => ({ evictSession: vi.fn() }),
    setState: vi.fn(),
    // ：useChatStore bootstrap 订阅投影驱动防睡眠——mock 需提供 subscribe。
    subscribe: () => () => {},
  },
}))

vi.mock('./stream/handlers/sessionCleanup', () => ({
  cleanupSessionOnTerminal: vi.fn(),
}))

import { useChatStore } from './useChatStore'

const SESSION = 'sess-1'

function makeMessage(id: string, createdAt: string): ChatMessage {
  return {
    id,
    session_id: SESSION,
    role: 'assistant',
    content_blocks_json: [],
    created_at: createdAt,
    updated_at: createdAt,
  } as unknown as ChatMessage
}

async function flush(): Promise<void> {
  // scrollToMessage 是 fire-and-forget（void run()）；等两拍微任务让内部
  // selectSession + around 加载 + set 全部结算。
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('useChatStore 跳转自动加载窗口外消息', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    window.sessionStorage.clear()
    useChatStore.setState({
      currentSessionId: SESSION,
      currentSessionIdBySpaceId: {},
      messagesBySessionId: {},
      scrollTargetMessageId: null,
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('scrollToMessage：目标不在窗口时经 around 端点加载并定位', async () => {
    useChatStore.getState().setSessionMessages(SESSION, [makeMessage('a', '2026-01-01T00:00:00Z')])
    mockMessagesList.mockResolvedValueOnce({
      messages: [
        makeMessage('target', '2026-01-01T00:05:00Z'),
        makeMessage('b', '2026-01-01T00:06:00Z'),
      ],
    })

    useChatStore.getState().scrollToMessage(SESSION, 'target')
    await flush()

    expect(mockMessagesList).toHaveBeenCalledWith(SESSION, { around: 'target', limit: 20 })
    const msgs = useChatStore.getState().messagesBySessionId[SESSION] ?? []
    expect(msgs.some(m => m.id === 'target')).toBe(true)
    expect(useChatStore.getState().scrollTargetMessageId).toBe('target')
  })

  it('scrollToMessage：目标已在窗口时不发起 around 请求', async () => {
    useChatStore.getState().setSessionMessages(SESSION, [makeMessage('target', '2026-01-01T00:00:00Z')])

    useChatStore.getState().scrollToMessage(SESSION, 'target')
    await flush()

    expect(mockMessagesList).not.toHaveBeenCalled()
    expect(useChatStore.getState().scrollTargetMessageId).toBe('target')
  })

  it('scrollToMessage：anchor 不存在（around 返空）时提示且不写 scrollTarget', async () => {
    useChatStore.getState().setSessionMessages(SESSION, [makeMessage('a', '2026-01-01T00:00:00Z')])
    mockMessagesList.mockResolvedValueOnce({ messages: [] })

    useChatStore.getState().scrollToMessage(SESSION, 'ghost')
    await flush()

    expect(mockMessagesList).toHaveBeenCalledWith(SESSION, { around: 'ghost', limit: 20 })
    expect(mockToast).toHaveBeenCalledWith({ title: 'chat:navigate.messageNotFound' })
    expect(useChatStore.getState().scrollTargetMessageId).toBeNull()
  })

  it('scrollToMessage：loadContextWindow 透传为 around limit', async () => {
    useChatStore.getState().setSessionMessages(SESSION, [makeMessage('a', '2026-01-01T00:00:00Z')])
    mockMessagesList.mockResolvedValueOnce({ messages: [makeMessage('target', '2026-01-01T00:05:00Z')] })

    useChatStore.getState().scrollToMessage(SESSION, 'target', { loadContextWindow: 50 })
    await flush()

    expect(mockMessagesList).toHaveBeenCalledWith(SESSION, { around: 'target', limit: 50 })
  })

  it('scrollToMessage：around 请求失败时只提示加载失败、不写 scrollTarget（避免二次误报）', async () => {
    useChatStore.getState().setSessionMessages(SESSION, [makeMessage('a', '2026-01-01T00:00:00Z')])
    mockMessagesList.mockRejectedValueOnce(new Error('network down'))

    useChatStore.getState().scrollToMessage(SESSION, 'target')
    await flush()

    expect(mockToast).toHaveBeenCalledWith({ title: 'chat:navigate.messageLoadFailed' })
    expect(mockToast).toHaveBeenCalledTimes(1)
    expect(useChatStore.getState().scrollTargetMessageId).toBeNull()
  })

  it('navigateToMessage：目标不在窗口时经 around 端点加载并定位', async () => {
    useChatStore.getState().setSessionMessages(SESSION, [makeMessage('a', '2026-01-01T00:00:00Z')])
    mockMessagesList.mockResolvedValueOnce({ messages: [makeMessage('target', '2026-01-01T00:05:00Z')] })

    await useChatStore.getState().navigateToMessage(SESSION, 'target')

    expect(mockMessagesList).toHaveBeenCalledWith(SESSION, { around: 'target', limit: 20 })
    expect(useChatStore.getState().scrollTargetMessageId).toBe('target')
  })
})
