import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useTabChatPanelLifecycle } from './useTabChatPanelLifecycle'

const mocks = vi.hoisted(() => ({
  loadMembers: vi.fn(() => Promise.resolve()),
  loadConversations: vi.fn(() => Promise.resolve()),
  loadLabels: vi.fn(() => Promise.resolve()),
  startIMProvider: vi.fn(() => Promise.resolve()),
  authState: {
    user: { id: 'user-1' } as { id: string } | null,
  },
  imState: {
    loadConversations: vi.fn(() => Promise.resolve()),
    loadLabels: vi.fn(() => Promise.resolve()),
    activeLabelFilters: [] as string[],
    connectionStatus: 'disconnected' as 'disconnected' | 'connecting' | 'connected',
  },
  organizationState: {
    selectedOrganization: { id: 'org-1' } as { id: string } | null,
    members: [
      { user_id: 'u-1', user: { nickname: '已有成员' } },
    ] as Array<{ user_id: string; user?: { nickname?: string } }>,
    loadMembers: vi.fn(() => Promise.resolve()),
  },
}))

mocks.organizationState.loadMembers = mocks.loadMembers
mocks.imState.loadConversations = mocks.loadConversations
mocks.imState.loadLabels = mocks.loadLabels

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: (selector: (state: typeof mocks.organizationState) => unknown) =>
    selector(mocks.organizationState),
}))

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: typeof mocks.authState) => unknown) =>
    selector(mocks.authState),
}))

vi.mock('@stores/useIMStore', () => ({
  useIMStore: (selector: (state: typeof mocks.imState) => unknown) =>
    selector(mocks.imState),
}))

vi.mock('@/services/tabchatApi', () => ({
  startIMProvider: mocks.startIMProvider,
}))

describe('useTabChatPanelLifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.organizationState.selectedOrganization = { id: 'org-1' }
    mocks.organizationState.members = [
      { user_id: 'u-1', user: { nickname: '已有成员' } },
    ]
    mocks.authState.user = { id: 'user-1' }
    mocks.imState.connectionStatus = 'disconnected'
    mocks.imState.activeLabelFilters = []
  })

  it('进入消息域时若连接已断开则重新拉起 Django IM', () => {
    renderHook(() => useTabChatPanelLifecycle())

    expect(mocks.startIMProvider).toHaveBeenCalledWith({
      organizationId: 'org-1',
      userId: 'user-1',
    })
  })

  it('连接已恢复时不再重复 start', () => {
    mocks.imState.connectionStatus = 'connected'
    renderHook(() => useTabChatPanelLifecycle())

    expect(mocks.startIMProvider).not.toHaveBeenCalled()
  })

  it('#7693: 成员缓存非空时进入消息域仍会保鲜 loadMembers', () => {
    renderHook(() => useTabChatPanelLifecycle())

    expect(mocks.loadConversations).toHaveBeenCalledWith('org-1')
    expect(mocks.loadLabels).toHaveBeenCalledWith('org-1')
    expect(mocks.loadMembers).toHaveBeenCalledWith('org-1')
  })

  it('#7693: 收到 organization-invitations-changed 时重拉当前组织成员', () => {
    renderHook(() => useTabChatPanelLifecycle())
    mocks.loadMembers.mockClear()

    act(() => {
      window.dispatchEvent(new CustomEvent('tabtin:organization-invitations-changed', {
        detail: { organizationId: 'org-1' },
      }))
    })

    expect(mocks.loadMembers).toHaveBeenCalledWith('org-1')
  })

  it('#7693: 其它组织的 invitations-changed 不触发当前组织重拉', () => {
    renderHook(() => useTabChatPanelLifecycle())
    mocks.loadMembers.mockClear()

    act(() => {
      window.dispatchEvent(new CustomEvent('tabtin:organization-invitations-changed', {
        detail: { organizationId: 'org-other' },
      }))
    })

    expect(mocks.loadMembers).not.toHaveBeenCalled()
  })

  it('#7693: 重连派发无 organizationId 的 invitations-changed 时仍补拉当前组织', () => {
    renderHook(() => useTabChatPanelLifecycle())
    mocks.loadMembers.mockClear()

    act(() => {
      window.dispatchEvent(new CustomEvent('tabtin:organization-invitations-changed', {
        detail: {},
      }))
    })

    expect(mocks.loadMembers).toHaveBeenCalledWith('org-1')
  })
})
