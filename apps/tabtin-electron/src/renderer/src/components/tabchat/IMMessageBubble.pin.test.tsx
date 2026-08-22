import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MESSAGE_TYPE_TEXT } from '@/constants/tabchat'
import type { IMMessage } from '@/services/tabchatApi'

const mocks = vi.hoisted(() => ({
  pinMessage: vi.fn(),
  unpinMessage: vi.fn(),
  onMessagePinned: vi.fn(),
  onMessageUnpinned: vi.fn(),
  loadPinnedMessages: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => options?.defaultValue ?? key,
  }),
}))

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  resolveChoiceTagColors: vi.fn(() => ({ bg: '#eee', text: '#111' })),
}))

vi.mock('@/services/openResourceLink', () => ({
  handleResourceLinkClick: vi.fn(),
  handleResourceLinkContextMenu: vi.fn(),
}))

vi.mock('@/services/tabchatApi', () => ({
  deleteMessage: vi.fn(),
  getMessageAttachmentDownloadUrl: vi.fn(),
  pinMessage: (...args: unknown[]) => mocks.pinMessage(...args),
  unpinMessage: (...args: unknown[]) => mocks.unpinMessage(...args),
  addReaction: vi.fn(),
  removeReaction: vi.fn(),
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

vi.mock('@stores/useIMStore', () => {
  const state = {
    conversations: [{
      id: 'conv-1',
      organization_id: 'organization-1',
      type: 2,
      name: 'Group',
    }],
    readReceipts: {},
    onMessagePinned: mocks.onMessagePinned,
    onMessageUnpinned: mocks.onMessageUnpinned,
    loadPinnedMessages: mocks.loadPinnedMessages,
  }
  const useIMStore = Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    { getState: () => state },
  )
  return { useIMStore }
})

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
  useUserProfileCache: (selector: (state: { ensureProfiles: () => void }) => unknown) =>
    selector({ ensureProfiles: vi.fn() }),
  useDisplayName: () => 'Peer Profile',
  useDisplayNames: () => ({}),
  useAvatar: () => '',
}))

vi.mock('./ForwardDialog', () => ({ ForwardDialog: () => null }))
vi.mock('./TeamSpaceCreateTaskDialog', () => ({ TeamSpaceCreateTaskDialog: () => null }))
vi.mock('./EmojiReactionBar', () => ({ EmojiReactionBar: () => null, EmojiQuickPicker: () => null }))
vi.mock('./SpaceCard', () => ({ SpaceCard: () => null }))
vi.mock('./IMResourceCard', () => ({ IMResourceCard: () => null }))
vi.mock('./ContactCard', () => ({ ContactCard: () => null }))
vi.mock('./downloadImAttachment', () => ({ downloadImAttachment: vi.fn() }))
vi.mock('./IMMessageActionBar', () => ({
  IMMessageActionBar: ({
    isPinned,
    onTogglePin,
  }: {
    isPinned: boolean
    onTogglePin: () => void
  }) => (
    <button type="button" aria-label={isPinned ? '取消置顶' : '置顶'} onClick={onTogglePin}>
      {isPinned ? '取消置顶' : '置顶'}
    </button>
  ),
}))

function buildMessage(overrides: Partial<IMMessage> = {}): IMMessage {
  return {
    id: 42,
    conversation_id: 'conv-1',
    sender_id: 'human-user-2',
    sender_type: 'user',
    sender_name: 'Mira',
    content: '需要置顶的消息',
    message_type: MESSAGE_TYPE_TEXT,
    reply_to_id: null,
    has_attachment: false,
    metadata: {},
    created_at: '2026-08-04T00:00:00Z',
    is_deleted: false,
    is_pinned: false,
    reactions: {},
    ...overrides,
  }
}

describe('IMMessageBubble pin action state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.pinMessage.mockResolvedValue(buildMessage({ is_pinned: true }))
    mocks.unpinMessage.mockResolvedValue(undefined)
  })

  it('updates the store after pinning succeeds', async () => {
    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(
      <IMMessageBubble
        message={buildMessage()}
        prevMessage={null}
        canManagePins
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '置顶' }))

    await waitFor(() => {
      expect(mocks.onMessagePinned).toHaveBeenCalledWith(
        'conv-1',
        expect.objectContaining({ id: 42, is_pinned: true }),
      )
    })
    expect(mocks.pinMessage).toHaveBeenCalledWith('conv-1', 42)
  }, 20_000)

  it('updates the store only after unpinning succeeds', async () => {
    let resolveUnpin!: () => void
    mocks.unpinMessage.mockReturnValueOnce(new Promise<void>((resolve) => {
      resolveUnpin = resolve
    }))
    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(
      <IMMessageBubble
        message={buildMessage({ is_pinned: true })}
        prevMessage={null}
        canManagePins
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '取消置顶' }))

    expect(mocks.unpinMessage).toHaveBeenCalledWith('conv-1', 42)
    expect(mocks.onMessageUnpinned).not.toHaveBeenCalled()

    resolveUnpin()
    await waitFor(() => {
      expect(mocks.onMessageUnpinned).toHaveBeenCalledWith('conv-1', 42)
    })
  }, 20_000)

  it('keeps the pinned state when unpinning fails', async () => {
    mocks.unpinMessage.mockRejectedValueOnce(new Error('network'))
    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(
      <IMMessageBubble
        message={buildMessage({ is_pinned: true })}
        prevMessage={null}
        canManagePins
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '取消置顶' }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '取消置顶' })).toBeTruthy()
    })
    expect(mocks.onMessageUnpinned).not.toHaveBeenCalled()
    expect(mocks.loadPinnedMessages).toHaveBeenCalledWith('conv-1')
  }, 20_000)
})
