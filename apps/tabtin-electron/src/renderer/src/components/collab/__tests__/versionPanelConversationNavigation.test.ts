import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockEnterChatSession,
  mockFindSpaceIdForSession,
  mockGetAgentRunConversation,
  mockNavigateToMessage,
  mockSetChatSidePanelCollapsed,
  mockToast,
  chatState,
} = vi.hoisted(() => ({
  mockEnterChatSession: vi.fn().mockResolvedValue(1),
  mockFindSpaceIdForSession: vi.fn(),
  mockGetAgentRunConversation: vi.fn(),
  mockNavigateToMessage: vi.fn().mockResolvedValue(undefined),
  mockSetChatSidePanelCollapsed: vi.fn(),
  mockToast: vi.fn(),
  chatState: {
    sessionsBySpaceId: {} as Record<string, Array<{ id: string; space_id?: string | null }>>,
    sessions: [] as Array<{ id: string; space_id?: string | null }>,
  },
}))

vi.mock('@services/chatSessionNavigation', () => ({
  enterChatSession: mockEnterChatSession,
}))

vi.mock('@tabtin/config', () => ({
  joinApiPath: (...parts: string[]) => parts.join('/').replace(/\/+/g, '/').replace('https:/', 'https://'),
}))

vi.mock('@services/notificationNavigation', () => ({
  findSpaceIdForSession: mockFindSpaceIdForSession,
}))

vi.mock('@services/chatExtraApi', () => ({
  getAgentRunConversation: mockGetAgentRunConversation,
}))

vi.mock('@tabtin/smartsheet-ui/toast', () => ({
  toast: mockToast,
}))

vi.mock('@stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => ({
      ...chatState,
      navigateToMessage: mockNavigateToMessage,
    }),
  },
}))

vi.mock('@stores/useUIStore', () => ({
  useUIStore: {
    getState: () => ({
      setChatSidePanelCollapsed: mockSetChatSidePanelCollapsed,
    }),
  },
}))

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
  }),
}))

import { navigateToConversationFromVersionPanel } from '../versionPanelConversationNavigation'

describe('navigateToConversationFromVersionPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    chatState.sessionsBySpaceId = {}
    chatState.sessions = []
    mockEnterChatSession.mockResolvedValue(1)
    mockFindSpaceIdForSession.mockReturnValue(undefined)
  })

  it('uses API space_id in fresh store state', async () => {
    mockGetAgentRunConversation.mockResolvedValue({
      session_id: 'session-1',
      space_id: 'space-1',
      organization_id: 'organization-1',
      user_message_id: 'user-msg-1',
      assistant_message_id: 'assistant-msg-1',
      user_prompt: '改文档',
      created_at: '2026-06-06T00:00:00Z',
    })

    await navigateToConversationFromVersionPanel('run-1')

    expect(mockFindSpaceIdForSession).not.toHaveBeenCalled()
    expect(mockSetChatSidePanelCollapsed).toHaveBeenCalledWith(false)
    expect(mockEnterChatSession).toHaveBeenCalledWith('space-1', 'session-1', {
      organizationId: 'organization-1',
    })
    expect(mockNavigateToMessage).toHaveBeenCalledWith('session-1', 'assistant-msg-1')
  })

  it('still fetches API anchor when options already include session and message', async () => {
    mockGetAgentRunConversation.mockResolvedValue({
      session_id: 'session-from-options',
      space_id: 'space-from-api',
      organization_id: 'organization-from-api',
      user_message_id: 'user-msg-from-api',
      assistant_message_id: 'assistant-msg-from-api',
      user_prompt: null,
      created_at: null,
    })

    await navigateToConversationFromVersionPanel('run-2', {
      sessionId: 'session-from-options',
      messageId: 'message-from-options',
    })

    expect(mockEnterChatSession).toHaveBeenCalledWith('space-from-api', 'session-from-options', {
      organizationId: 'organization-from-api',
    })
    expect(mockNavigateToMessage).toHaveBeenCalledWith('session-from-options', 'message-from-options')
  })

  it('does not pair an option session with a different API session space', async () => {
    mockGetAgentRunConversation.mockResolvedValue({
      session_id: 'parent-session',
      space_id: 'parent-space',
      organization_id: 'parent-organization',
      user_message_id: 'parent-user-msg',
      assistant_message_id: 'parent-assistant-msg',
      user_prompt: null,
      created_at: null,
    })
    mockFindSpaceIdForSession.mockReturnValue('child-space-from-cache')

    await navigateToConversationFromVersionPanel('parent-run', {
      sessionId: 'child-session',
      messageId: 'child-message',
    })

    expect(mockFindSpaceIdForSession).toHaveBeenCalledWith({}, 'child-session')
    expect(mockEnterChatSession).toHaveBeenCalledWith('child-space-from-cache', 'child-session', {
      organizationId: undefined,
    })
    expect(mockNavigateToMessage).toHaveBeenCalledWith('child-session', 'child-message')
  })

  it('falls back to cached session space when API has no space_id', async () => {
    mockGetAgentRunConversation.mockResolvedValue({
      session_id: 'session-3',
      space_id: null,
      organization_id: null,
      user_message_id: 'user-msg-3',
      assistant_message_id: null,
      user_prompt: null,
      created_at: null,
    })
    mockFindSpaceIdForSession.mockReturnValue('space-from-cache')

    await navigateToConversationFromVersionPanel('run-3')

    expect(mockFindSpaceIdForSession).toHaveBeenCalledWith({}, 'session-3')
    expect(mockEnterChatSession).toHaveBeenCalledWith('space-from-cache', 'session-3', {
      organizationId: undefined,
    })
    expect(mockNavigateToMessage).toHaveBeenCalledWith('session-3', 'user-msg-3')
  })

  it('does not enter chat when neither API nor options resolves a session', async () => {
    mockGetAgentRunConversation.mockResolvedValue(null)

    await navigateToConversationFromVersionPanel('run-missing')

    expect(mockEnterChatSession).not.toHaveBeenCalled()
    expect(mockNavigateToMessage).not.toHaveBeenCalled()
    expect(mockSetChatSidePanelCollapsed).not.toHaveBeenCalled()
  })

  it('does not enter chat when the anchor is hidden by session revert', async () => {
    mockGetAgentRunConversation.mockResolvedValue({
      session_id: 'session-reverted',
      space_id: 'space-reverted',
      organization_id: 'organization-reverted',
      user_message_id: 'user-msg-reverted',
      assistant_message_id: 'assistant-msg-reverted',
      user_prompt: null,
      created_at: null,
      is_reverted_out: true,
      revert_message_id: 'revert-msg',
    })

    await navigateToConversationFromVersionPanel('run-reverted')

    expect(mockSetChatSidePanelCollapsed).not.toHaveBeenCalled()
    expect(mockEnterChatSession).not.toHaveBeenCalled()
    expect(mockNavigateToMessage).not.toHaveBeenCalled()
    expect(mockToast).toHaveBeenCalledWith({
      title: '这条对话已被回退隐藏',
      description: '请先取消回退，或从回退历史中查看当时的上下文。',
      variant: 'destructive',
    })
  })
})
