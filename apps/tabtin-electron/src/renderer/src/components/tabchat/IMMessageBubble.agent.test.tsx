import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { IMMessage } from '@/services/tabchatApi'
import { NIINII_MASCOT_URL } from '@/constants/mascot'

const { mockEnsureProfiles } = vi.hoisted(() => ({
  mockEnsureProfiles: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => {
      if (options?.name) return `${key}:${options.name}`
      if (options?.defaultValue) return options.defaultValue
      return key
    },
  }),
}))

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@components/context-space/registry/homeRegistry', () => ({}))
vi.mock('@components/layout/project/teamSpaceProjectNavigation', () => ({
  enterTeamSpaceProject: vi.fn(),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: vi.fn(),
  resolveChoiceTagColors: () => ({ bg: '', text: '', border: '' }),
}))

vi.mock('@/services/openResourceLink', () => ({
  handleResourceLinkClick: vi.fn(),
  handleResourceLinkContextMenu: vi.fn(),
}))

vi.mock('@/services/tabchatApi', () => ({
  deleteMessage: vi.fn(),
}))

vi.mock('@/services/tabchatAttachmentApi', () => ({
  formatFileSize: vi.fn((size: number) => `${size} B`),
}))

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) =>
    selector({ user: { id: 'human-user-1' } }),
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: (selector: (state: { selectedAgent: null }) => unknown) =>
    selector({ selectedAgent: null }),
}))

vi.mock('@stores/chat/useChatStore', () => ({ useChatStore: { getState: () => ({}) } }))
vi.mock('@stores/useUIStore', () => ({ useUIStore: { getState: () => ({}) } }))
vi.mock('./cards/TabTinCustomCardRenderer', () => ({ TabTinCustomCardRenderer: () => null }))
vi.mock('./imMarkdownComponents', () => ({ createImMarkdownComponents: () => ({}) }))

vi.mock('@stores/useIMStore', () => ({
  useIMStore: (selector: (state: {
    conversations: Array<{ id: string; organization_id: string }>
    readReceipts: Record<string, unknown>
    conversationMembers: Record<string, unknown[]>
  }) => unknown) =>
    selector({
      conversations: [{ id: 'conv-1', organization_id: 'organization-1' }],
      readReceipts: {},
      conversationMembers: {},
    }),
}))

vi.mock('@stores/useUserProfileCache', () => ({
  useUserProfileCache: (selector: (state: { ensureProfiles: typeof mockEnsureProfiles }) => unknown) =>
    selector({ ensureProfiles: mockEnsureProfiles }),
  useDisplayName: () => 'Human Profile',
  useDisplayNames: () => ({}),
  useAvatar: () => '',
}))

vi.mock('./ForwardDialog', () => ({
  ForwardDialog: () => null,
}))

vi.mock('./EmojiReactionBar', () => ({
  EmojiReactionBar: () => null,
  EmojiQuickPicker: () => null,
}))

vi.mock('./IMMessageActionBar', () => ({ IMMessageActionBar: () => null }))

vi.mock('./SpaceCard', () => ({
  SpaceCard: () => null,
}))

vi.mock('./IMResourceCard', () => ({
  IMResourceCard: () => null,
}))

vi.mock('./TeamSpaceCreateTaskDialog', () => ({
  TeamSpaceCreateTaskDialog: () => null,
}))

describe('IMMessageBubble agent replay', () => {
  it('renders the Agent name and NiiNii avatar while preserving custom images and size', async () => {
    const { IMMessageBubble } = await import('./IMMessageBubble')
    const message: IMMessage = {
      id: 1,
      conversation_id: 'conv-1',
      sender_id: 'agent-1',
      sender_type: 'agent',
      sender_name: '进宝助手',
      content: '收到，我来处理。',
      message_type: 1,
      reply_to_id: null,
      has_attachment: false,
      metadata: {},
      created_at: '2026-06-21T12:00:00Z',
      is_deleted: false,
      reactions: {},
    }

    const { container, rerender } = render(
      <IMMessageBubble
        message={message}
        prevMessage={null}
      />,
    )

    expect(await screen.findByText('进宝助手')).toBeTruthy()
    expect(screen.getByLabelText('AI')).toBeTruthy()
    expect(screen.getByText('收到，我来处理。')).toBeTruthy()
    expect(mockEnsureProfiles).not.toHaveBeenCalledWith(['agent-1'])
    expect(container.querySelector('img')?.getAttribute('src')).toBe(NIINII_MASCOT_URL)
    expect(container.querySelector('img')?.parentElement?.className).toContain('h-9 w-9')

    rerender(<IMMessageBubble message={{ ...message, sender_avatar: 'https://example.com/custom.png' }} prevMessage={null} />)
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.com/custom.png')
    fireEvent.error(container.querySelector('img')!)
    expect(container.querySelector('img')?.getAttribute('src')).toBe(NIINII_MASCOT_URL)

    rerender(<IMMessageBubble message={{ ...message, sender_name: '小Tin' }} prevMessage={null} />)
    expect(screen.getByText('NiiNii')).toBeTruthy()
    expect(screen.queryByText('小Tin')).toBeNull()
  })
})
