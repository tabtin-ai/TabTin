import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MESSAGE_TYPE_IMAGE } from '@/constants/tabchat'
import type { IMMessage } from '@/services/tabchatApi'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  }),
}))

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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
  }) => unknown) =>
    selector({
      conversations: [{ id: 'conv-1', organization_id: 'organization-1' }],
      readReceipts: {},
    }),
}))
vi.mock('@stores/useFileAttachmentStore', () => {
  const state = {
    statuses: {
      'conv-1:legacy:peer-user-2:10:2026-06-22T12:00:00Z': {
        status: 'available',
        downloadUrl: 'https://oss.example.com/tabtin-happy.png',
      },
    } as Record<string, { status: string; downloadUrl?: string }>,
    markUnavailable: vi.fn(),
    ensureChecked: vi.fn(),
    reset: vi.fn(),
  }
  const useFileAttachmentStore = (
    selector: (s: typeof state) => unknown,
  ) => selector(state)
  useFileAttachmentStore.getState = () => state
  return { useFileAttachmentStore }
})
vi.mock('@stores/useUserProfileCache', () => ({
  useUserProfileCache: (selector: (state: { ensureProfiles: () => void }) => unknown) =>
    selector({ ensureProfiles: vi.fn() }),
  useDisplayName: () => 'Peer',
  useDisplayNames: () => ({}),
  useAvatar: () => '',
}))
vi.mock('./ForwardDialog', () => ({ ForwardDialog: () => null }))
vi.mock('./EmojiReactionBar', () => ({
  EmojiReactionBar: () => null,
  EmojiQuickPicker: () => null,
}))
vi.mock('./IMMessageActionBar', () => ({ IMMessageActionBar: () => null }))
vi.mock('./SpaceCard', () => ({ SpaceCard: () => null }))
vi.mock('./IMResourceCard', () => ({ IMResourceCard: () => null }))
vi.mock('./ContactCard', () => ({ ContactCard: () => null }))
vi.mock('./HandoffCard', () => ({ HandoffCard: () => null }))
vi.mock('./TeamSpaceCreateTaskDialog', () => ({ TeamSpaceCreateTaskDialog: () => null }))
vi.mock('./ImImageContextMenu', () => ({ ImImageContextMenu: () => null }))
vi.mock('./stickers/tabtinRobotPack', () => ({
  resolveTabtinRobotStickerMetadata: (
    metadata: { sticker?: { pack?: string; id?: string }; file_name?: string } | null | undefined,
  ) => {
    const sticker = metadata?.sticker
    if (sticker?.pack === 'tabtin-robot' && typeof sticker.id === 'string') {
      return { pack: 'tabtin-robot', id: sticker.id }
    }
    const match = typeof metadata?.file_name === 'string'
      ? /^tabtin-(neutral|happy|sad|surprise|cool)\.png$/i.exec(metadata.file_name)
      : null
    if (!match) return null
    return { pack: 'tabtin-robot', id: match[1].toLowerCase() }
  },
}))

function buildMessage(overrides: Partial<IMMessage>): IMMessage {
  return {
    id: 10,
    conversation_id: 'conv-1',
    sender_id: 'peer-user-2',
    content: '',
    message_type: MESSAGE_TYPE_IMAGE,
    reply_to_id: null,
    has_attachment: true,
    metadata: {},
    created_at: '2026-06-22T12:00:00Z',
    is_deleted: false,
    reactions: {},
    ...overrides,
  }
}

describe('IMMessageBubble stickers', () => {
  it('renders TabTin sticker images at sticker size', async () => {
    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(
      <IMMessageBubble
        message={buildMessage({
          metadata: {
            file_id: 'file-sticker',
            file_name: 'tabtin-happy.png',
            access_url: 'https://oss.example.com/tabtin-happy.png',
            sticker: { pack: 'tabtin-robot', id: 'happy' },
          },
        })}
        prevMessage={null}
      />,
    )

    const stickerButton = document.querySelector('[data-im-sticker="happy"]') as HTMLElement
    expect(stickerButton).toBeTruthy()
    const img = stickerButton.querySelector('img') as HTMLImageElement
    expect(img.className).toContain('h-[140px]')
    expect(img.className).toContain('w-[140px]')
  })

  it('reserves a stable frame for legacy images without dimensions', async () => {
    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(
      <IMMessageBubble
        message={buildMessage({
          metadata: {
            file_id: 'file-image',
            file_name: 'photo.png',
            access_url: 'https://oss.example.com/photo.png',
          },
        })}
        prevMessage={null}
      />,
    )

    expect(document.querySelector('[data-im-sticker]')).toBeNull()
    const frame = screen.getByRole('button', { name: '打开图片预览' })
    const img = screen.getByRole('img', { name: 'photo.png' })
    expect(frame.style.width).toBe('480px')
    expect(frame.style.aspectRatio).toBe('480 / 420')

    fireEvent.load(img)

    expect(frame.style.width).toBe('480px')
    expect(frame.style.aspectRatio).toBe('480 / 420')
  })

  it('reserves the intrinsic aspect ratio when image dimensions are available', async () => {
    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(
      <IMMessageBubble
        message={buildMessage({
          metadata: {
            file_id: 'file-portrait',
            file_name: 'portrait.png',
            access_url: 'https://oss.example.com/portrait.png',
            image_width: 844,
            image_height: 1152,
          },
        })}
        prevMessage={null}
      />,
    )

    const frame = screen.getByRole('button', { name: '打开图片预览' })
    const img = screen.getByRole('img', { name: 'portrait.png' })
    expect(Number.parseFloat(frame.style.width)).toBeCloseTo(307.71, 2)
    expect(frame.style.aspectRatio).toContain(' / 420')
    expect(img.className).toContain('h-full')
    expect(img.className).toContain('w-full')
  })

  it('falls back to sticker size from tabtin-*.png file name when metadata.sticker is missing', async () => {
    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(
      <IMMessageBubble
        message={buildMessage({
          metadata: {
            file_id: 'file-sticker-legacy',
            file_name: 'tabtin-surprise.png',
            access_url: 'https://oss.example.com/tabtin-surprise.png',
          },
        })}
        prevMessage={null}
      />,
    )

    const stickerButton = document.querySelector('[data-im-sticker="surprise"]') as HTMLElement
    expect(stickerButton).toBeTruthy()
    const img = stickerButton.querySelector('img') as HTMLImageElement
    expect(img.className).toContain('h-[140px]')
    expect(img.className).toContain('w-[140px]')
  })
})
