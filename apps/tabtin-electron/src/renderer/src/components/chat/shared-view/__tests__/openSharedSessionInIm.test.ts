import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  openResourceTab: vi.fn(),
  expandCanvasForScope: vi.fn(),
  setSharedAccess: vi.fn(),
  activateConversation: vi.fn(() => true),
  setCurrentTab: vi.fn(),
  imState: {
    currentConversationId: 'conversation-current' as string | null,
    lastOpenedConversationIdByOrganization: {
      'organization-1': 'conversation-last',
    } as Record<string, string>,
    conversations: [
      { id: 'conversation-last', organization_id: 'organization-1' },
      { id: 'conversation-current', organization_id: 'organization-1' },
    ],
  },
}))

vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: {
    getState: () => ({ openResourceTab: mocks.openResourceTab }),
  },
}))

vi.mock('@/services/openResourceLink', () => ({
  expandCanvasForScope: mocks.expandCanvasForScope,
}))

vi.mock('@/stores/chat/session/sessionAccessStore', () => ({
  useSessionAccessStore: {
    getState: () => ({ setSharedAccess: mocks.setSharedAccess }),
  },
}))

vi.mock('@/stores/useIMStore', () => ({
  useIMStore: {
    getState: () => mocks.imState,
  },
}))

vi.mock('@/components/layout/primaryNavigation', () => ({
  resolveLastOpenedConversationId: (input: {
    organizationId: string | null
    lastOpenedConversationIdByOrganization: Record<string, string>
    conversations: Array<{ id: string; organization_id: string }>
  }) => {
    if (!input.organizationId) return null
    const rememberedId = input.lastOpenedConversationIdByOrganization[input.organizationId]
    if (!rememberedId) return null
    return input.conversations.some(conversation => (
      conversation.id === rememberedId
      && conversation.organization_id === input.organizationId
    ))
      ? rememberedId
      : null
  },
}))

vi.mock('@stores/useSpaceListStore', () => ({
  useSpaceListStore: {
    getState: () => ({ activateConversation: mocks.activateConversation }),
  },
}))

vi.mock('@stores/useMainNavStore', () => ({
  useMainNavStore: {
    getState: () => ({ setCurrentTab: mocks.setCurrentTab }),
  },
}))

import {
  openSharedSessionInIm,
  openSharedTaskFromAgent,
  resolveSharedTaskConversationId,
} from '../openSharedSessionInIm'

describe('openSharedSessionInIm ', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('在当前 IM 工作台打开收到的共享任务，不触发 Agent 首页导航', () => {
    expect(openSharedSessionInIm({
      conversationId: 'conversation-1',
      sessionId: 'session-1',
      shareId: 'share-1',
      title: '共享任务',
      organizationId: 'organization-1',
      workspaceId: 'workspace-owner',
      workspaceName: 'Owner workspace',
      ownerUserId: 'owner-1',
      ownerDisplayName: 'Owner',
      incoming: true,
    })).toBe(true)

    expect(mocks.setSharedAccess).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      shareId: 'share-1',
    }))
    expect(mocks.openResourceTab).toHaveBeenCalledWith('im:conversation-1', expect.objectContaining({
      type: 'sharedsession',
      id: 'session-1',
      meta: expect.objectContaining({
        shareId: 'share-1',
        workspaceName: 'Owner workspace',
        ownerUserId: 'owner-1',
        ownerDisplayName: 'Owner',
        incoming: true,
      }),
    }))
    expect(mocks.expandCanvasForScope).toHaveBeenCalledWith('im:conversation-1')
  })

  it('缺少当前 IM 会话时明确拒绝，不回退到首页', () => {
    expect(openSharedSessionInIm({
      conversationId: '',
      sessionId: 'session-1',
      shareId: 'share-1',
      incoming: true,
    })).toBe(false)
    expect(mocks.openResourceTab).not.toHaveBeenCalled()
    expect(mocks.expandCanvasForScope).not.toHaveBeenCalled()
  })

  it('owner 从共享卡打开时也登记 shareId，确保受控工作台主动加载历史', () => {
    expect(openSharedSessionInIm({
      conversationId: 'conversation-1',
      sessionId: 'session-owner',
      shareId: 'share-owner',
      incoming: false,
    })).toBe(true)
    expect(mocks.setSharedAccess).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-owner',
      shareId: 'share-owner',
      role: 'owner',
    }))
  })
})

describe('openSharedTaskFromAgent ', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.activateConversation.mockReturnValue(true)
    mocks.imState.currentConversationId = 'conversation-current'
    mocks.imState.lastOpenedConversationIdByOrganization = {
      'organization-1': 'conversation-last',
    }
    mocks.imState.conversations = [
      { id: 'conversation-last', organization_id: 'organization-1' },
      { id: 'conversation-current', organization_id: 'organization-1' },
    ]
  })

  it('优先使用仍在会话列表中的 share.conversation_id，切到消息并打开共享页', () => {
    mocks.imState.conversations = [
      { id: 'conversation-share', organization_id: 'organization-1' },
      { id: 'conversation-current', organization_id: 'organization-1' },
    ]
    expect(openSharedTaskFromAgent({
      sessionId: 'session-1',
      shareId: 'share-1',
      conversationId: 'conversation-share',
      organizationId: 'organization-1',
      title: '协作任务',
    })).toBe(true)

    expect(mocks.activateConversation).toHaveBeenCalledWith('conversation-share')
    expect(mocks.setCurrentTab).toHaveBeenCalledWith('im')
    expect(mocks.openResourceTab).toHaveBeenCalledWith(
      'im:conversation-share',
      expect.objectContaining({ id: 'session-1' }),
    )
  })

  it('列表没有 conversation_id 时回退当前 IM 会话', () => {
    expect(openSharedTaskFromAgent({
      sessionId: 'session-1',
      shareId: 'share-1',
      organizationId: 'organization-1',
    })).toBe(true)
    expect(mocks.activateConversation).toHaveBeenCalledWith('conversation-current')
  })

  it('没有当前会话时回退组织上次打开且仍在列表中的会话', () => {
    mocks.imState.currentConversationId = null
    expect(openSharedTaskFromAgent({
      sessionId: 'session-1',
      shareId: 'share-1',
      organizationId: 'organization-1',
    })).toBe(true)
    expect(mocks.activateConversation).toHaveBeenCalledWith('conversation-last')
  })

  it('解析不到会话时拒绝，不打开 Agent 栏', () => {
    mocks.imState.currentConversationId = null
    mocks.imState.lastOpenedConversationIdByOrganization = {}
    expect(openSharedTaskFromAgent({
      sessionId: 'session-1',
      shareId: 'share-1',
      organizationId: 'organization-1',
    })).toBe(false)
    expect(mocks.activateConversation).not.toHaveBeenCalled()
    expect(mocks.setCurrentTab).not.toHaveBeenCalled()
    expect(mocks.openResourceTab).not.toHaveBeenCalled()
  })

  it('share.conversation_id 不在会话列表时回退当前 IM 会话，避免清空选中', () => {
    expect(openSharedTaskFromAgent({
      sessionId: 'session-1',
      shareId: 'share-1',
      conversationId: 'conversation-missing',
      organizationId: 'organization-1',
    })).toBe(true)
    expect(mocks.activateConversation).toHaveBeenCalledWith('conversation-current')
    expect(mocks.openResourceTab).toHaveBeenCalledWith(
      'im:conversation-current',
      expect.objectContaining({ id: 'session-1' }),
    )
  })

  it('activateConversation 失败时不切消息、不打开共享页', () => {
    mocks.activateConversation.mockReturnValue(false)
    expect(openSharedTaskFromAgent({
      sessionId: 'session-1',
      shareId: 'share-1',
      conversationId: 'conversation-share',
    })).toBe(false)
    expect(mocks.setCurrentTab).not.toHaveBeenCalled()
    expect(mocks.openResourceTab).not.toHaveBeenCalled()
  })
})

describe('resolveSharedTaskConversationId ', () => {
  it('忽略空白或不在列表中的 share.conversation_id，改走当前会话', () => {
    expect(resolveSharedTaskConversationId({
      shareConversationId: '  ',
      currentConversationId: 'conversation-current',
      organizationId: 'organization-1',
      lastOpenedConversationIdByOrganization: {},
      conversations: [{ id: 'conversation-current', organization_id: 'organization-1' }],
    })).toBe('conversation-current')
    expect(resolveSharedTaskConversationId({
      shareConversationId: 'conversation-missing',
      currentConversationId: 'conversation-current',
      organizationId: 'organization-1',
      lastOpenedConversationIdByOrganization: {},
      conversations: [{ id: 'conversation-current', organization_id: 'organization-1' }],
    })).toBe('conversation-current')
  })
})
