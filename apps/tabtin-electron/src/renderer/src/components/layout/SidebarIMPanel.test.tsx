import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  imSidebarView: 'inbox',
  setImSidebarView: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}))

vi.mock('@components/tabchat/ConversationList', () => ({
  ConversationList: () => <div data-testid="conversation-list" />,
}))

vi.mock('@components/tabchat/ContactsList', () => ({
  ContactsList: () => <div data-testid="contacts-list" />,
}))

vi.mock('@components/tabchat/MessageSearch', () => ({
  MessageSearch: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="message-search">{children}</div>
  ),
}))

vi.mock('@components/tabchat/CreateConversationDialog', () => ({
  CreateConversationDialog: ({ isOpen, groupOnly }: { isOpen: boolean; groupOnly?: boolean }) => (
    isOpen ? <div data-testid="create-group-dialog" data-group-only={String(groupOnly)} /> : null
  ),
}))

vi.mock('@components/tabchat/useTabChatPanelLifecycle', () => ({
  useTabChatPanelLifecycle: () => undefined,
}))

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector({
      selectedOrganization: { id: 'org-1' },
    }),
    { subscribe: vi.fn() },
  ),
}))

vi.mock('@stores/useIMStore', () => ({
  useIMStore: (selector: (state: unknown) => unknown) => selector({
    imSidebarView: mocks.imSidebarView,
    setImSidebarView: mocks.setImSidebarView,
  }),
}))

import { SidebarIMPanel } from './SidebarIMPanel'

describe('SidebarIMPanel 通讯录导航', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.imSidebarView = 'inbox'
  })

  it('通过统一导航动作进入通讯录', () => {
    render(<SidebarIMPanel />)

    fireEvent.click(screen.getByRole('button', { name: '通讯录' }))

    expect(mocks.setImSidebarView).toHaveBeenCalledWith('contacts')
  })

  it('通讯录选中时左侧仍保留最近消息，按钮进入灰阶选中态', () => {
    mocks.imSidebarView = 'contacts'

    render(<SidebarIMPanel />)

    const contactsButton = screen.getByRole('button', { name: '通讯录' })
    expect(contactsButton.getAttribute('aria-pressed')).toBe('true')
    expect(contactsButton.getAttribute('aria-current')).toBe('page')
    expect(contactsButton.className).toContain('bg-foreground/[0.06]')
    expect(contactsButton.className).not.toContain('bg-accent/15')
    expect(screen.getByTestId('conversation-list')).toBeTruthy()
    expect(screen.getByTestId('message-search')).toBeTruthy()
    expect(screen.queryByTestId('contacts-list')).toBeNull()

    fireEvent.click(contactsButton)

    expect(mocks.setImSidebarView).toHaveBeenCalledWith('inbox')
  })

  it('提供仅用于发起群聊的入口', () => {
    render(<SidebarIMPanel />)

    fireEvent.click(screen.getByRole('button', { name: '创建群组' }))

    expect(screen.getByTestId('create-group-dialog').getAttribute('data-group-only')).toBe('true')
  })
})
