import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ContactsList } from './ContactsList'

const mocks = vi.hoisted(() => ({
  createConversationAndActivate: vi.fn(() => Promise.resolve()),
  loadMembers: vi.fn(() => Promise.resolve()),
  setImSidebarView: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: Record<string, string>) => {
      const fallback = options?.defaultValue ?? _key
      return options?.name ? fallback.replace('{{name}}', options.name) : fallback
    },
  }),
}))

vi.mock('@components/ui', () => ({ toast: vi.fn() }))

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ user: { id: 'self-user' } }),
}))

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      selectedOrganization: { id: 'org-1' },
      members: [
        { user_id: 'self-user', user: { nickname: '我自己' } },
        { user_id: 'user-2', user: { nickname: '张三', username: 'zhangsan' } },
      ],
      loadMembers: mocks.loadMembers,
      isLoadingMembers: false,
    }),
}))

vi.mock('@stores/useUserProfileCache', () => ({
  useUserProfileCache: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ ensureProfiles: vi.fn() }),
  useDisplayName: () => '',
  useAvatar: () => '',
}))

vi.mock('@stores/useIMStore', () => ({
  useIMStore: {
    getState: () => ({
      createConversationAndActivate: mocks.createConversationAndActivate,
      setImSidebarView: mocks.setImSidebarView,
    }),
  },
}))

vi.mock('@components/common/ListSkeletons', () => ({
  NavigationListSkeleton: () => <div data-testid="contacts-skeleton" />,
}))

describe('ContactsList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('#7693: 已有成员缓存时打开通讯录仍会重拉 loadMembers', async () => {
    render(<ContactsList />)
    expect(mocks.loadMembers).toHaveBeenCalledWith('org-1')
    await screen.findByRole('button', { name: '打开与 张三 的私信' })
  })

  it('点击成员整行直接打开或创建私信，并返回会话列表', async () => {
    const onConversationOpened = vi.fn()
    render(<ContactsList onConversationOpened={onConversationOpened} />)

    fireEvent.click(await screen.findByRole('button', { name: '打开与 张三 的私信' }))

    await waitFor(() => {
      expect(mocks.createConversationAndActivate).toHaveBeenCalledWith({
        organizationId: 'org-1',
        kind: 'dm',
        memberIds: ['user-2'],
      })
      expect(mocks.setImSidebarView).toHaveBeenCalledWith('inbox')
      expect(onConversationOpened).toHaveBeenCalledTimes(1)
    })
  })

  it('本人行不可用于发起私信', async () => {
    render(<ContactsList />)
    expect((await screen.findByRole('button', { name: /我自己/ })).hasAttribute('disabled')).toBe(true)
  })

})
