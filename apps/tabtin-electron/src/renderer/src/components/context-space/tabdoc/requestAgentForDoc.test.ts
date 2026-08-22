import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  chatState,
  createSessionMock,
  sendMessageMock,
  setChatSidePanelCollapsedMock,
  setActiveKeyMock,
  logWarnMock,
  requestAppCollaborationMock,
} = vi.hoisted(() => ({
  chatState: {
    currentSessionId: null as string | null,
  },
  createSessionMock: vi.fn(),
  sendMessageMock: vi.fn(),
  setChatSidePanelCollapsedMock: vi.fn(),
  setActiveKeyMock: vi.fn(),
  logWarnMock: vi.fn(),
  requestAppCollaborationMock: vi.fn(),
}))

vi.mock('@/services/requestAppCollaboration', () => ({
  requestAppCollaboration: requestAppCollaborationMock,
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: vi.fn(),
}))

vi.mock('@/i18n', () => ({
  default: {
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
  },
}))

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({
    warn: logWarnMock,
  }),
}))

vi.mock('@/stores/useOrganizationStore', () => ({
  useOrganizationStore: {
    getState: () => ({ selectedOrganization: { id: 'organization-1' } }),
  },
}))

vi.mock('@/stores/useUIStore', () => ({
  useUIStore: {
    getState: () => ({ setChatSidePanelCollapsed: setChatSidePanelCollapsedMock }),
  },
}))

vi.mock('@/stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: {
    getState: () => ({
      setActiveKey: setActiveKeyMock,
    }),
  },
}))

vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => ({
      ...chatState,
      createSession: createSessionMock,
      sendMessage: sendMessageMock,
    }),
  },
}))

import { requestAgentForDoc } from './requestAgentForDoc'

describe('requestAgentForDoc', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    chatState.currentSessionId = null
    createSessionMock.mockImplementation(async () => {
      chatState.currentSessionId = 'session-1'
    })
    sendMessageMock.mockResolvedValue(undefined)
  })

  it('发送文档 AI 任务时打开正式协作确认', async () => {
    await requestAgentForDoc('space-1', '  帮我把这份周报润色成对外同步版本  ')

    expect(requestAppCollaborationMock).toHaveBeenCalledWith({
      sourceLabel: '文档',
      spaceId: 'space-1',
      prompt: '  帮我把这份周报润色成对外同步版本  ',
    })
    expect(createSessionMock).not.toHaveBeenCalled()
  })
})
