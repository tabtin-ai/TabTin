import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MESSAGE_TYPE_TEXT } from '@/constants/tabchat'
import type { IMMessage } from '@/services/tabchatApi'
import { IMMessageBubble } from './IMMessageBubble'

const mockLinkClick = vi.fn()
const mockLinkContextMenu = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => options?.defaultValue ?? key,
  }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  resolveChoiceTagColors: () => ({ bg: '', text: '', border: '' }),
  FALLBACK_TAG_BG: '',
  FALLBACK_TAG_TEXT: '',
  FALLBACK_TAG_BORDER: '',
}))

vi.mock('@components/ui', () => ({
  OVERLAY_SURFACE_CLASS: 'overlay-surface',
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}))

vi.mock('@components/chat/preview/copyImageToClipboard', () => ({
  copyImageToClipboard: vi.fn(),
}))

vi.mock('./ImImageContextMenu', () => ({
  ImImageContextMenu: () => null,
}))

vi.mock('./HandoffCard', () => ({
  HandoffCard: () => null,
}))

vi.mock('./stickers/tabtinRobotPack', () => ({
  resolveTabtinRobotStickerMetadata: (
    metadata: { sticker?: { pack?: string; id?: string } } | null | undefined,
  ) => {
    const sticker = metadata?.sticker
    if (sticker?.pack === 'tabtin-robot' && typeof sticker.id === 'string') {
      return { pack: 'tabtin-robot', id: sticker.id }
    }
    return null
  },
}))

vi.mock('./downloadImAttachment', () => ({ downloadImAttachment: vi.fn() }))

vi.mock('@/services/openResourceLink', () => ({
  handleResourceLinkClick: (...args: unknown[]) => mockLinkClick(...args),
  handleResourceLinkContextMenu: (...args: unknown[]) => mockLinkContextMenu(...args),
}))

vi.mock('./ImConversationCanvasContext', () => ({
  useImConversationCanvas: () => ({
    scopeKey: 'im:conv-1',
    executionSpaceId: 'workspace-1',
  }),
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
  }) => unknown) =>
    selector({
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
  useUserProfileCache: (selector: (state: { ensureProfiles: () => void }) => unknown) =>
    selector({ ensureProfiles: vi.fn() }),
  useDisplayName: () => 'Peer Profile',
  useDisplayNames: (ids: string[]) => Object.fromEntries((ids ?? []).map((id) => [id, 'Alice'])),
  useAvatar: () => '',
}))

vi.mock('./ForwardDialog', () => ({ ForwardDialog: () => null }))
vi.mock('./EmojiReactionBar', () => ({
  EmojiReactionBar: () => <div data-testid="emoji-reaction-bar">reaction</div>,
  EmojiQuickPicker: () => null,
}))
vi.mock('./IMMessageActionBar', () => ({ IMMessageActionBar: () => null }))
vi.mock('./SpaceCard', () => ({ SpaceCard: () => null }))
vi.mock('./IMResourceCard', () => ({
  IMResourceCard: ({ name }: { name: string }) => <div data-testid="resource-card">resource-card:{name}</div>,
}))
vi.mock('./ContactCard', () => ({ ContactCard: () => null }))
vi.mock('./TeamSpaceCreateTaskDialog', () => ({ TeamSpaceCreateTaskDialog: () => null }))

function buildMessage(overrides: Partial<IMMessage>): IMMessage {
  return {
    id: 10,
    conversation_id: 'conv-1',
    sender_id: 'peer-user-2',
    content: '',
    message_type: MESSAGE_TYPE_TEXT,
    reply_to_id: null,
    has_attachment: false,
    metadata: {},
    created_at: '2026-06-22T12:00:00Z',
    is_deleted: false,
    reactions: {},
    ...overrides,
  }
}

describe('IMMessageBubble rich text (功能2)', () => {
  it.each([
    'tabtin://resource/table/46ff7041-cfdd-41f4-9f7e-2f9c93236e3d?hint=tabdata&recordIds=f7372b28-0636-432c-82d2-477d6af58af5',
    'tabtin-preprod://resource/table/46ff7041-cfdd-41f4-9f7e-2f9c93236e3d?hint=tabdata&recordIds=f7372b28-0636-432c-82d2-477d6af58af5',
    'tabtin-dev://resource/table/46ff7041-cfdd-41f4-9f7e-2f9c93236e3d?hint=tabdata&recordIds=f7372b28-0636-432c-82d2-477d6af58af5',
    'tabtin://resource/table/table1',
  ])('把裸 TabTin 资源深链渲染为可点击链接并交给 ResourceRouter：%s', async (uri) => {
    render(<IMMessageBubble message={buildMessage({ content: uri })} prevMessage={null} />)

    const link = screen.getByText(uri) as HTMLAnchorElement
    expect(link.tagName).toBe('A')
    expect(link.getAttribute('href')).toBe(uri)
    link.click()
    expect(mockLinkClick).toHaveBeenCalledWith(expect.anything(), uri, 'im:conv-1', 'workspace-1')
    fireEvent.contextMenu(link)
    expect(mockLinkContextMenu).toHaveBeenCalledWith(
      expect.anything(),
      uri,
      'im:conv-1',
      'workspace-1',
    )
  })

  it('仍然过滤 Markdown 中的危险协议', () => {
    render(
      <IMMessageBubble
        message={buildMessage({ content: '[危险链接](javascript:alert(1))' })}
        prevMessage={null}
      />,
    )

    expect(screen.getByText('危险链接').getAttribute('href')).toBe('')
  })

  it('autolinks a bare URL in plain text into a clickable anchor', async () => {
    render(<IMMessageBubble message={buildMessage({ content: 'see https://example.com now' })} prevMessage={null} />)
    const link = screen.getByText('https://example.com') as HTMLAnchorElement
    expect(link.tagName).toBe('A')
    expect(link.getAttribute('href')).toBe('https://example.com')
  })

  it('keeps trailing punctuation out of the link', async () => {
    render(<IMMessageBubble message={buildMessage({ content: '看 https://example.com。' })} prevMessage={null} />)
    const link = screen.getByText('https://example.com') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('https://example.com')
  })

  it('prefixes www. links with https://', async () => {
    render(<IMMessageBubble message={buildMessage({ content: 'visit www.example.com today' })} prevMessage={null} />)
    const link = screen.getByText('www.example.com') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('https://www.example.com')
  })

  it('renders typed text together with its staged resource card', async () => {
    render(
      <IMMessageBubble
        message={buildMessage({
          content: '请看这份方案',
          metadata: {
            card: {
              type: 'document',
              resource_id: 'doc-1',
              space_id: 'space-1',
              name: '方案文档',
              caption: '请看这份方案',
            },
          },
        })}
        prevMessage={null}
      />,
    )

    const resourceCard = screen.getByTestId('resource-card')
    const caption = screen.getByText('请看这份方案')
    expect(resourceCard).toBeTruthy()
    expect(caption).toBeTruthy()
    expect(resourceCard.compareDocumentPosition(caption) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('把点赞和表情放在消息气泡内部', async () => {
    const { container } = render(
      <IMMessageBubble
        message={buildMessage({ content: '收到', reactions: { '👍': ['human-user-1'] } })}
        prevMessage={null}
      />,
    )

    const bubble = container.querySelector('[data-im-message-bubble]')
    expect(bubble?.contains(screen.getByTestId('emoji-reaction-bar'))).toBe(true)
  })

  it('highlights @mention by mentioned id in plain text', async () => {
    render(
      <IMMessageBubble
        message={buildMessage({ content: 'hi @Alice check this', metadata: { mentioned_user_ids: ['user-alice'] } })}
        prevMessage={null}
      />,
    )
    expect(screen.getByText('@Alice')).toBeTruthy()
  })

  it('highlights @所有人 when mention_all is set', async () => {
    render(
      <IMMessageBubble
        message={buildMessage({
          content: '@所有人 今晚开会',
          metadata: { mention_all: true },
        })}
        prevMessage={null}
      />,
    )
    expect(screen.getByText('@所有人')).toBeTruthy()
  })
})
