import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { IMMessage } from '@/services/tabchatApi'

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

vi.mock('@stores/useIMStore', () => ({
  useIMStore: (selector: (state: {
    conversations: Array<{ id: string; organization_id: string }>
    readReceipts: Record<string, unknown>
  }) => unknown) =>
    selector({
      conversations: [{ id: 'conv-1', organization_id: 'organization-1' }],
      readReceipts: {},
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
  it('renders concrete agent name from hydrated history message', async () => {
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

    render(
      <IMMessageBubble
        message={message}
        prevMessage={null}
      />,
    )

    expect(await screen.findByText('进宝助手')).toBeTruthy()
    expect(screen.getByLabelText('AI')).toBeTruthy()
    expect(screen.getByText('收到，我来处理。')).toBeTruthy()
    expect(mockEnsureProfiles).not.toHaveBeenCalledWith(['agent-1'])
  })
})
