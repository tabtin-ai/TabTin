import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { MESSAGE_TYPE_TEXT } from '@/constants/tabchat'
import type { IMMessage } from '@/services/tabchatApi'
import { IMMessageBubble } from './IMMessageBubble'

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
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  resolveChoiceTagColors: vi.fn(),
  stableHash: vi.fn(),
  CHOICE_COLOR_HEX_MAP: {},
  FALLBACK_TAG_BG_COLORS: [],
  FALLBACK_TAG_TEXT_COLORS: [],
  normalizeHexColor: vi.fn(),
  isLightHexColor: vi.fn(),
}))

vi.mock('./downloadImAttachment', () => ({ downloadImAttachment: vi.fn() }))

vi.mock('@/services/openResourceLink', () => ({
  handleResourceLinkClick: vi.fn(),
  handleResourceLinkContextMenu: vi.fn(),
}))

vi.mock('@/services/tabchatApi', () => ({
  deleteMessage: vi.fn(),
  getMessageAttachmentDownloadUrl: vi.fn(),
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
  }) => unknown) => selector({
    conversations: [{ id: 'conv-1', organization_id: 'organization-1' }],
    readReceipts: {},
  }),
}))

vi.mock('@stores/useFileAttachmentStore', () => ({
  useFileAttachmentStore: (
    selector: (state: {
      statuses: Record<string, unknown>
      markUnavailable: () => void
      ensureChecked: () => void
      reset: () => void
    }) => unknown,
  ) => selector({ statuses: {}, markUnavailable: vi.fn(), ensureChecked: vi.fn(), reset: vi.fn() }),
}))

vi.mock('@stores/useUserProfileCache', () => ({
  useUserProfileCache: (selector: (state: { ensureProfiles: typeof mockEnsureProfiles }) => unknown) =>
    selector({ ensureProfiles: mockEnsureProfiles }),
  useDisplayName: () => 'Peer Profile',
  useDisplayNames: () => ({}),
  useAvatar: () => '',
}))

vi.mock('./ForwardDialog', () => ({ ForwardDialog: () => null }))
vi.mock('./TeamSpaceCreateTaskDialog', () => ({ TeamSpaceCreateTaskDialog: () => null }))
vi.mock('./EmojiReactionBar', () => ({ EmojiReactionBar: () => null, EmojiQuickPicker: () => null }))
vi.mock('./IMMessageActionBar', () => ({
  IMMessageActionBar: ({ visible, canRecall }: { visible: boolean; canRecall: boolean }) => (
    visible && canRecall ? <button type="button">recallMessage</button> : null
  ),
}))
vi.mock('./SpaceCard', () => ({ SpaceCard: () => null }))
vi.mock('./IMResourceCard', () => ({ IMResourceCard: () => null }))
vi.mock('./ContactCard', () => ({ ContactCard: () => null }))

function buildMessage(overrides: Partial<IMMessage>): IMMessage {
  return {
    id: 10,
    conversation_id: 'conv-1',
    sender_id: 'human-user-1',
    content: '',
    message_type: MESSAGE_TYPE_TEXT,
    reply_to_id: null,
    has_attachment: false,
    metadata: {},
    created_at: '2026-06-22T12:00:00Z',
    is_deleted: true,
    reactions: {},
    ...overrides,
  }
}

describe('IMMessageBubble recall re-edit (功能1)', () => {
  beforeEach(() => {
    mockEnsureProfiles.mockReset()
  })

  it('shows re-edit affordance and fires onReEdit with cached content for own recalled text', async () => {
    const onReEdit = vi.fn()
    render(
      <IMMessageBubble
        message={buildMessage({ _recalledContent: 'draft text' })}
        prevMessage={null}
        onReEdit={onReEdit}
      />,
    )
    const btn = screen.getByText('reEdit')
    expect(btn.closest('[data-im-recalled-message]')?.getAttribute('data-message-alignment')).toBe('outgoing')
    expect(btn).toBeTruthy()
    fireEvent.click(btn)
    expect(onReEdit).toHaveBeenCalledWith('draft text')
  })

  it('hides re-edit when no cached content (other devices / peers)', async () => {
    render(
      <IMMessageBubble
        message={buildMessage({})}
        prevMessage={null}
        onReEdit={vi.fn()}
      />,
    )
    expect(screen.queryByText('reEdit')).toBeNull()
    expect(screen.getByText('youRecalledMessage')).toBeTruthy()
  })

  it('hides re-edit on a peer-recalled message even if content somehow present', async () => {
    render(
      <IMMessageBubble
        message={buildMessage({ sender_id: 'peer-user-2', _recalledContent: 'x' })}
        prevMessage={null}
        onReEdit={vi.fn()}
      />,
    )
    expect(screen.queryByText('reEdit')).toBeNull()
    const recalledMessage = screen.getByText('messageRecalled')
    expect(recalledMessage.closest('[data-im-recalled-message]')?.getAttribute('data-message-alignment')).toBe('incoming')
  })

  it('刚发送的本人消息按本地发送时间展示撤回', () => {
    vi.useFakeTimers()
    vi.setSystemTime('2026-08-08T07:50:32.468Z')
    try {
      render(
        <IMMessageBubble
          message={buildMessage({
            content: '刚发送的消息',
            created_at: '2026-08-08T07:47:23.000Z',
            is_deleted: false,
            _localSentAt: '2026-08-08T07:50:16.864Z',
          })}
          prevMessage={null}
        />,
      )

      const trigger = screen.getByText('刚发送的消息')
        .closest('[data-im-message-action-trigger]') as HTMLElement
      fireEvent.mouseEnter(trigger)

      expect(screen.getByText('recallMessage')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })
})
