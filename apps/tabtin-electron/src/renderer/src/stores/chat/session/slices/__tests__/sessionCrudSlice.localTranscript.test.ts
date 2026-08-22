/**
 *  本机会话正文以 runtime transcript 为权威的接入回归。
 *
 * 锁定：本机会话（探盘到 messages.jsonl）加载时正文来自 runtime transcript，
 * DB 只补非正文增强字段（usage / checkpoint 等）、绝不覆盖正文。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChatSession, ChatMessage } from '@tabtin/chat-client'
import { createSessionCrudActions, type SessionCrudStore } from '../sessionCrudSlice'

vi.mock('@/utils/logger', () => ({
  logger: { log: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ log: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))
vi.mock('../../../execution/chatTelemetry', () => ({ trackChatTelemetry: vi.fn() }))
vi.mock('../../../stream/handlers/historyRestoreHelper', () => ({
  restoreRuntimeStateFromHistory: () => ({ agentSteps: [], toolEvents: [], agentMode: null }),
}))
vi.mock('../../utils/evictSessionData', () => ({ evictChatStoreSessionData: vi.fn(() => ({})) }))
vi.mock('../../../messages/messageCache', () => ({
  getCachedMessages: vi.fn(async () => undefined),
  cacheMessages: vi.fn(),
  appendCachedMessages: vi.fn(),
  touchSessionMeta: vi.fn(),
}))
vi.mock('../../../messages/actions/titleGenerationDedupe', () => ({ requestTitleGenerationOnce: vi.fn() }))
vi.mock('../../../../useChatSplitStore', () => ({ useChatSplitStore: { getState: () => ({}) } }))
vi.mock('../../../../useSpaceContextTabsStore', () => ({ useSpaceContextTabsStore: { getState: () => ({}) } }))
vi.mock('../../../../useChatRuntimeStore', () => ({
  useChatRuntimeStore: {
    getState: () => ({
      reconcileSubagentRunsFromArchive: vi.fn(),
      evictSession: vi.fn(),
    }),
    setState: vi.fn(),
  },
}))
vi.mock('../../../../useSessionReadStore', () => ({
  useSessionReadStore: { getState: () => ({ markViewed: vi.fn() }) },
}))
vi.mock('@/services/sessionFreshness', () => ({ markSessionFresh: vi.fn(), markSessionStale: vi.fn() }))
vi.mock('@tabtin/smartsheet-ui/toast', () => ({ toast: vi.fn() }))
vi.mock('@/i18n', () => ({ default: { t: (k: string) => k } }))

// ：本机会话判据为 true，transcript 读取按用例注入；enrich 用真实实现。
vi.mock('@/services/localAgentClient', () => ({ isLocalRuntimeAvailable: () => true }))
vi.mock('@/services/localTranscript', async (importActual) => {
  const actual = await importActual<typeof import('@/services/localTranscript')>()
  return { ...actual, hasLocalTranscript: vi.fn(async () => true), readLocalTranscript: vi.fn() }
})

import { hasLocalTranscript, readLocalTranscript } from '@/services/localTranscript'

function makeSession(id: string, spaceId: string): ChatSession {
  return { id, space_id: spaceId, title: `session-${id}`, title_is_default: false } as unknown as ChatSession
}

describe('#4897 selectSession/loadSessionMessages 本机 transcript 权威', () => {
  const SPACE = 'space-1'
  const SESSION = 'session-local'

  type State = {
    sessions: ChatSession[]
    sessionsBySpaceId: Record<string, ChatSession[]>
    currentSessionId: string | null
    currentSessionIdBySpaceId: Record<string, string | null>
    messagesBySessionId: Record<string, ChatMessage[]>
    hasMoreBySessionId: Record<string, boolean>
    checkpointsBySessionId: Record<string, Record<string, string>>
    lastContextSyncFingerprintBySessionId: Record<string, string>
    isLoading: boolean
  }
  let state: State

  const setSessionMessages = vi.fn((sessionId: string, messages: ChatMessage[]) => {
    state.messagesBySessionId = { ...state.messagesBySessionId, [sessionId]: messages }
  })
  const get = () => ({
    ...state,
    setSessionMessages,
    applyLoadedMessages: (sid: string, messages: ChatMessage[]) => setSessionMessages(sid, messages),
    hydrateFromCache: (sid: string, messages: ChatMessage[]) => setSessionMessages(sid, messages),
    reconcileFromServer: (sid: string, _fetchEpoch: number, messages: ChatMessage[]) => {
      setSessionMessages(sid, messages)
      return { changed: true, newCount: messages.length, dropped: false }
    },
    clearSessionMessages: (sid: string) => setSessionMessages(sid, []),
    setCurrentSessionForSpace: vi.fn(),
  }) as unknown as SessionCrudStore
  const set = vi.fn((partial: unknown) => {
    const patch = typeof partial === 'function'
      ? (partial as (s: State) => Partial<State>)(state)
      : partial as Partial<State>
    state = { ...state, ...patch }
  })

  const listMock = vi.fn()
  const makeActions = () => createSessionCrudActions(get as never, set as never, {
    getChatClient: () => ({ messages: { list: listMock } }) as never,
    resolveActiveSpaceId: () => SPACE,
    emptySessions: [],
  })

  beforeEach(() => {
    state = {
      sessions: [makeSession(SESSION, SPACE)],
      sessionsBySpaceId: { [SPACE]: [makeSession(SESSION, SPACE)] },
      currentSessionId: null,
      currentSessionIdBySpaceId: {},
      messagesBySessionId: {},
      hasMoreBySessionId: {},
      checkpointsBySessionId: {},
      lastContextSyncFingerprintBySessionId: {},
      isLoading: false,
    }
    setSessionMessages.mockClear()
    listMock.mockReset()
    vi.mocked(hasLocalTranscript).mockReset()
    vi.mocked(hasLocalTranscript).mockResolvedValue(true)
    vi.mocked(readLocalTranscript).mockReset()
  })

  it('loadSessionMessages：正文来自 runtime，DB 只补 usage（不覆盖正文）', async () => {
    vi.mocked(readLocalTranscript).mockResolvedValue([
      { id: 'u1', role: 'user', content: 'runtime 指令', created_at: '2026-07-14T00:00:00.000Z' },
    ] as ChatMessage[])
    // DB 滞后：同一条消息正文不同 + 带 usage；应只取 usage，正文以 runtime 为准。
    listMock.mockResolvedValue({
      messages: [{ id: 'u1', role: 'user', content: 'DB 滞后正文', usage_json: { output_tokens: 7 } }],
      has_more: false,
    })

    await makeActions().loadSessionMessages(SESSION)

    const msgs = state.messagesBySessionId[SESSION]
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toBe('runtime 指令') // 正文 runtime 权威
    expect(msgs[0].usage_json).toEqual({ output_tokens: 7 }) // 增强字段来自 DB
  })

  it('selectSession（无缓存）：渲染 runtime transcript 正文', async () => {
    vi.mocked(readLocalTranscript).mockResolvedValue([
      { id: 'u1', role: 'user', content: '第一条指令', created_at: '2026-07-14T00:00:00.000Z' },
      { id: 'u2', role: 'user', content: '第二条指令', created_at: '2026-07-14T00:00:01.000Z' },
    ] as ChatMessage[])
    listMock.mockResolvedValue({ messages: [], has_more: false })

    await makeActions().selectSession(SPACE, SESSION)

    const msgs = state.messagesBySessionId[SESSION]
    expect(msgs.map(m => m.content)).toEqual(['第一条指令', '第二条指令'])
    // DB 无对应正文行 → 不新增、不删（正文来自 runtime）。
    expect(msgs).toHaveLength(2)
  })

  it('共享会话仍走 selectSession，但正文请求只附加 shareId 鉴权且不读取本机 transcript', async () => {
    listMock.mockResolvedValue({
      messages: [{ id: 'a1', role: 'assistant', content: '共享响应' }],
      has_more: false,
    })

    await makeActions().selectSession(SPACE, SESSION, {
      sharedAccess: { shareId: 'share-1' },
    })

    expect(readLocalTranscript).not.toHaveBeenCalled()
    expect(listMock).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({ limit: 50 }),
      { shareId: 'share-1' },
    )
    expect(state.messagesBySessionId[SESSION]?.[0]?.content).toBe('共享响应')
  })

  it('续接新任务打开时直接加载最新消息页', async () => {
    vi.mocked(hasLocalTranscript).mockResolvedValue(false)
    state.messagesBySessionId[SESSION] = [{
      id: 'cached-first-page',
      role: 'user',
      content: '缓存里的旧首屏',
      created_at: '2026-07-13T00:00:00.000Z',
    } as ChatMessage]
    const messages = Array.from({ length: 80 }, (_, index) => ({
      id: `m${index + 1}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `消息 ${index + 1}`,
      created_at: new Date(Date.UTC(2026, 6, 14, 0, 0, index)).toISOString(),
    })) as ChatMessage[]
    listMock
      .mockResolvedValueOnce({
        messages: messages.slice(0, 50),
        total: 80,
        has_more: true,
        oldest_id: 'm1',
        newest_id: 'm50',
      })
      .mockResolvedValueOnce({
        messages: messages.slice(30),
        total: 80,
        has_more: false,
        oldest_id: 'm31',
        newest_id: 'm80',
      })

    await makeActions().selectSession(SPACE, SESSION, {
      initialMessagePage: 'latest',
    })

    expect(listMock).toHaveBeenNthCalledWith(
      1,
      SESSION,
      expect.objectContaining({ limit: 50 }),
      undefined,
    )
    expect(listMock).toHaveBeenNthCalledWith(
      2,
      SESSION,
      expect.objectContaining({ limit: 50, offset: 30 }),
      undefined,
    )
    expect(state.messagesBySessionId[SESSION].map(message => message.id)).toEqual(
      messages.slice(30).map(message => message.id),
    )
    expect(state.messagesBySessionId[SESSION].map(message => message.id)).not.toContain('cached-first-page')
    expect(state.hasMoreBySessionId[SESSION]).toBe(true)
  })

  it('续接新任务打开时不把本机 transcript 当权威', async () => {
    vi.mocked(hasLocalTranscript).mockResolvedValue(true)
    vi.mocked(readLocalTranscript).mockResolvedValue([{
      id: 'local-hidden',
      role: 'system',
      content: '本机空快照',
      created_at: '2026-07-14T00:00:00.000Z',
      message_kind: 'environment_context',
      metadata: { share_briefing: true },
    } as ChatMessage])
    listMock.mockResolvedValue({
      messages: [{
        id: 'server-1',
        role: 'user',
        content: '服务端快照',
        created_at: '2026-07-14T00:00:01.000Z',
      }],
      has_more: false,
    })

    await makeActions().selectSession(SPACE, SESSION, {
      initialMessagePage: 'latest',
    })

    expect(readLocalTranscript).not.toHaveBeenCalled()
    expect(listMock).toHaveBeenCalled()
    expect(state.messagesBySessionId[SESSION].map(message => message.id)).toEqual(['server-1'])
  })

  it('本机 transcript 只有隐藏 briefing 时回落服务端快照', async () => {
    vi.mocked(hasLocalTranscript).mockResolvedValue(true)
    vi.mocked(readLocalTranscript).mockResolvedValue([{
      id: 'local-briefing',
      role: 'system',
      content: '会话快照',
      created_at: '2026-07-14T00:00:00.000Z',
      message_kind: 'environment_context',
      metadata: { share_briefing: true },
    } as ChatMessage])
    listMock.mockResolvedValue({
      messages: [{
        id: 'server-visible',
        role: 'user',
        content: '帮我继续写方案',
        created_at: '2026-07-14T00:00:01.000Z',
      }],
      has_more: false,
    })

    await makeActions().selectSession(SPACE, SESSION)

    expect(listMock).toHaveBeenCalled()
    expect(state.messagesBySessionId[SESSION].map(message => message.id)).toEqual(['server-visible'])
  })

  it('发完继续任务后本机短记录不能盖掉服务端快照', async () => {
    state.sessions = [{ ...makeSession(SESSION, SPACE), message_count: 88 }]
    state.sessionsBySpaceId = { [SPACE]: state.sessions }
    vi.mocked(readLocalTranscript).mockResolvedValue([
      {
        id: 'local-briefing',
        role: 'system',
        content: '会话快照',
        created_at: '2026-08-17T12:00:00.000Z',
        message_kind: 'environment_context',
        metadata: { share_briefing: true },
      },
      {
        id: 'new-user',
        role: 'user',
        content: '继续任务',
        created_at: '2026-08-17T13:37:54.000Z',
      },
      {
        id: 'new-asst',
        role: 'assistant',
        content: '目录里有一批 car_*.json',
        created_at: '2026-08-17T13:38:03.000Z',
      },
    ] as ChatMessage[])
    listMock.mockResolvedValue({
      messages: [
        {
          id: 'snap-1',
          role: 'user',
          content: '帮我做公司 AI 分身试点方案',
          created_at: '2026-08-17T12:00:01.000Z',
          metadata: { share_snapshot: true },
        },
        {
          id: 'snap-2',
          role: 'assistant',
          content: '方案已经写好',
          created_at: '2026-08-17T12:10:00.000Z',
          metadata: { share_snapshot: true },
        },
        {
          id: 'new-user',
          role: 'user',
          content: '继续任务',
          created_at: '2026-08-17T13:37:54.000Z',
        },
        {
          id: 'new-asst',
          role: 'assistant',
          content: '目录里有一批 car_*.json',
          created_at: '2026-08-17T13:38:03.000Z',
        },
      ],
      has_more: false,
    })

    await makeActions().selectSession(SPACE, SESSION)

    expect(listMock).toHaveBeenCalled()
    expect(state.messagesBySessionId[SESSION].map(message => message.id)).toEqual([
      'local-briefing',
      'snap-1',
      'snap-2',
      'new-user',
      'new-asst',
    ])
  })

  it('切回会话时本机短记录不能丢掉缓存里的 share_snapshot', async () => {
    state.hasMoreBySessionId[SESSION] = true
    state.messagesBySessionId[SESSION] = [
      {
        id: 'snap-1',
        role: 'user',
        content: '原任务',
        created_at: '2026-08-17T12:00:01.000Z',
        metadata: { share_snapshot: true },
      },
      {
        id: 'new-user',
        role: 'user',
        content: '继续任务',
        created_at: '2026-08-17T13:37:54.000Z',
      },
    ] as ChatMessage[]
    vi.mocked(readLocalTranscript).mockResolvedValue([
      {
        id: 'new-user',
        role: 'user',
        content: '继续任务',
        created_at: '2026-08-17T13:37:54.000Z',
      },
      {
        id: 'new-asst',
        role: 'assistant',
        content: '新回复',
        created_at: '2026-08-17T13:38:03.000Z',
      },
    ] as ChatMessage[])

    await makeActions().selectSession(SPACE, SESSION)

    expect(state.messagesBySessionId[SESSION].map(message => message.id)).toEqual([
      'snap-1',
      'new-user',
      'new-asst',
    ])
    expect(state.hasMoreBySessionId[SESSION]).toBe(true)
  })

  it('#6072：切回会话时用缓存补齐旧 transcript 缺失的 turn 身份', async () => {
    state.messagesBySessionId[SESSION] = [{
      id: 'a1',
      role: 'assistant',
      agent_id: 'agent-turn-a',
      content: '缓存正文',
      created_at: '2026-07-14T00:00:00.000Z',
    } as ChatMessage]
    vi.mocked(readLocalTranscript).mockResolvedValue([{
      id: 'a1',
      role: 'assistant',
      content: 'runtime 权威正文',
      created_at: '2026-07-14T00:00:00.000Z',
    } as ChatMessage])
    listMock.mockResolvedValue({ messages: [], has_more: false })

    await makeActions().selectSession(SPACE, SESSION)

    const [message] = state.messagesBySessionId[SESSION]
    expect(message.content).toBe('runtime 权威正文')
    expect(message.agent_id).toBe('agent-turn-a')
  })

  it('#8305：切回时用 await 后的 liveNow 保留 blocks，不用陈旧 cache', async () => {
    const staleBlocks = [{
      index: 1,
      block_id: 'blk-stale',
      block: { type: 'text', text: 'stale-prefix' },
      finalized: false,
    }] as NonNullable<ChatMessage['blocks']>
    const freshBlocks = [{
      index: 1,
      block_id: 'blk-fresh',
      block: { type: 'text', text: 'stale-prefix…and-more-streamed-after-await' },
      finalized: false,
    }] as NonNullable<ChatMessage['blocks']>

    state.messagesBySessionId[SESSION] = [
      {
        id: 'u1',
        role: 'user',
        content: '写长文',
        created_at: '2026-07-14T00:00:00.000Z',
      } as ChatMessage,
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        blocks: staleBlocks,
        created_at: '2026-07-14T00:00:01.000Z',
      } as ChatMessage,
    ]

    vi.mocked(readLocalTranscript).mockImplementation(async () => {
      // 模拟 await 期间流式继续写——live 已比进 selectSession 时的 cache 更新
      state.messagesBySessionId[SESSION] = [
        {
          id: 'u1',
          role: 'user',
          content: '写长文',
          created_at: '2026-07-14T00:00:00.000Z',
        } as ChatMessage,
        {
          id: 'a1',
          role: 'assistant',
          content: '',
          blocks: freshBlocks,
          created_at: '2026-07-14T00:00:01.000Z',
        } as ChatMessage,
      ]
      return [
        {
          id: 'u1',
          role: 'user',
          content: '写长文',
          created_at: '2026-07-14T00:00:00.000Z',
        } as ChatMessage,
        {
          id: 'a1',
          role: 'assistant',
          content: '',
          created_at: '2026-07-14T00:00:01.000Z',
        } as ChatMessage,
      ]
    })
    listMock.mockResolvedValue({ messages: [], has_more: false })

    await makeActions().selectSession(SPACE, SESSION)

    const assistant = state.messagesBySessionId[SESSION].find((m) => m.id === 'a1')
    expect(assistant?.blocks).toEqual(freshBlocks)
    expect((assistant?.blocks?.[0]?.block as { text?: string })?.text).toContain('after-await')
  })
})
