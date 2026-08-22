/**
 * forkSession 必须在云端 fork 成功后立刻分叉本机归档。
 *
 * 回归： 在改 selectSession 签名时误删了 forkLocalSessionArchive 调用。
 * 后果：fork 后发消息会从零建本机 transcript，切走再切回时按  权威覆盖，
 * fork 点前历史从 UI 消失（DB 仍完好）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChatSession } from '@tabtin/chat-client'
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
  getCachedMessages: vi.fn(),
  cacheMessages: vi.fn(),
  appendCachedMessages: vi.fn(),
  touchSessionMeta: vi.fn(),
}))
vi.mock('../../../messages/actions/titleGenerationDedupe', () => ({ requestTitleGenerationOnce: vi.fn() }))
vi.mock('../../../../useChatSplitStore', () => ({ useChatSplitStore: { getState: () => ({}) } }))
vi.mock('../../../../useSpaceContextTabsStore', () => ({ useSpaceContextTabsStore: { getState: () => ({}) } }))
vi.mock('../../../../useChatRuntimeStore', () => ({
  useChatRuntimeStore: { getState: () => ({ reconcileSubagentRunsFromArchive: vi.fn(), evictSession: vi.fn() }), setState: vi.fn() },
}))
vi.mock('../../../../useSessionReadStore', () => ({
  useSessionReadStore: { getState: () => ({ markViewed: vi.fn() }) },
}))
vi.mock('@/services/sessionFreshness', () => ({ markSessionFresh: vi.fn(), markSessionStale: vi.fn() }))
vi.mock('@tabtin/smartsheet-ui/toast', () => ({ toast: vi.fn() }))
vi.mock('@/i18n', () => ({ default: { t: (k: string) => k } }))
vi.mock('@/services/localAgentClient', () => ({ isLocalRuntimeAvailable: () => true }))

const { forkLocalSessionArchive } = vi.hoisted(() => ({
  forkLocalSessionArchive: vi.fn(async () => ({
    copied: true,
    skipped: false,
    remappedToolIds: 2,
    truncatedAtForkPoint: true,
  })),
}))

vi.mock('@/services/localTranscript', () => ({
  hasLocalTranscript: vi.fn(async () => false),
  readLocalTranscript: vi.fn(async () => null),
  enrichWithServerMetadata: vi.fn((local: unknown) => local),
  forkLocalSessionArchive,
}))

function makeSession(id: string, spaceId: string, orgId = 'org-1'): ChatSession {
  return {
    id,
    space_id: spaceId,
    organization_id: orgId,
    title: `session-${id}`,
    fork_count: 0,
  } as unknown as ChatSession
}

describe('forkSession 本机归档分叉契约', () => {
  const SPACE = 'space-1'
  const SOURCE = 'session-source'
  const FORKED = 'session-forked'
  const FORK_POINT = 'msg-assistant-3'
  const RAW_FORK_POINT = 'local-msg-assistant-3'

  let state: {
    sessions: ChatSession[]
    sessionsBySpaceId: Record<string, ChatSession[]>
    forkingSessionId: string | null
    currentSessionId: string | null
    messagesBySessionId: Record<string, unknown[]>
    isLoading: boolean
  }

  const selectSession = vi.fn(async () => undefined)
  const forkMock = vi.fn()

  const get = () =>
    ({
      ...state,
      selectSession,
      setCurrentSessionForSpace: vi.fn(),
      setSessionMessages: vi.fn(),
      applyLoadedMessages: vi.fn(),
      hydrateFromCache: vi.fn(),
      clearSessionMessages: vi.fn(),
    }) as unknown as SessionCrudStore

  const set = vi.fn((partial: unknown) => {
    const patch =
      typeof partial === 'function'
        ? (partial as (s: typeof state) => Partial<typeof state>)(state)
        : (partial as Partial<typeof state>)
    state = { ...state, ...patch }
  })

  const makeActions = () =>
    createSessionCrudActions(get as never, set as never, {
      getChatClient: () =>
        ({
          sessions: { fork: forkMock },
          messages: { list: vi.fn(async () => ({ messages: [] })) },
        }) as never,
      resolveActiveSpaceId: () => SPACE,
      emptySessions: [],
    })

  beforeEach(() => {
    state = {
      sessions: [makeSession(SOURCE, SPACE)],
      sessionsBySpaceId: { [SPACE]: [makeSession(SOURCE, SPACE)] },
      forkingSessionId: null,
      currentSessionId: SOURCE,
      messagesBySessionId: {},
      isLoading: false,
    }
    forkMock.mockReset()
    selectSession.mockReset()
    forkLocalSessionArchive.mockClear()
    set.mockClear()
  })

  it('云端 fork 成功后用 Agent Host anchor 分叉本机归档', async () => {
    state.messagesBySessionId = {
      [SOURCE]: [
        {
          id: RAW_FORK_POINT,
          role: 'assistant',
          metadata: { message_id: FORK_POINT },
        },
      ],
    }
    const newSession = {
      ...makeSession(FORKED, SPACE),
      forked_from_id: SOURCE,
      fork_point_message_id: FORK_POINT,
      tool_id_remap: { tu_old: 'tu_new' },
      message_count: 3,
      fork_copy_status: 'complete',
    } as ChatSession
    forkMock.mockResolvedValue(newSession)

    const actions = makeActions()
    const result = await actions.forkSession(SPACE, SOURCE, RAW_FORK_POINT)

    expect(result?.id).toBe(FORKED)
    expect(forkMock).toHaveBeenCalledWith(SOURCE, {
      fork_anchor_message_id: RAW_FORK_POINT,
      message_id: FORK_POINT,
    })
    expect(forkLocalSessionArchive).toHaveBeenCalledTimes(1)
    expect(forkLocalSessionArchive).toHaveBeenCalledWith(SOURCE, FORKED, {
      spaceId: SPACE,
      organizationId: 'org-1',
      forkAnchorMessageId: RAW_FORK_POINT,
      toolIdRemap: { tu_old: 'tu_new' },
    })
  })
})
