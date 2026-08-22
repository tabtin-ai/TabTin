import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { MESSAGE_TYPE_FILE, MESSAGE_TYPE_TEXT } from '@/constants/tabchat'
import type { IMMessage } from '@/services/tabchatApi'

const mockSafeCopy = vi.fn()
const mockToast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() })
const attachmentStatuses: Record<number, unknown> = {}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => options?.defaultValue ?? key,
  }),
}))

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: mockToast,
  resolveChoiceTagColors: () => ({ bg: '', text: '', border: '' }),
  FALLBACK_TAG_BG: '',
  FALLBACK_TAG_TEXT: '',
  FALLBACK_TAG_BORDER: '',
}))

vi.mock('@components/ui', () => ({
  OVERLAY_SURFACE_CLASS: 'overlay-surface',
  toast: mockToast,
}))

vi.mock('@components/chat/preview/copyImageToClipboard', () => ({
  copyImageToClipboard: vi.fn(),
}))

vi.mock('@components/chat/utils/clipboard', () => ({
  safeCopyToClipboard: (...args: unknown[]) => mockSafeCopy(...args),
}))

vi.mock('./HandoffCard', () => ({ HandoffCard: () => null }))
vi.mock('./stickers/tabtinRobotPack', () => ({
  resolveTabtinRobotStickerMetadata: () => null,
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
vi.mock('@stores/useFileAttachmentStore', () => ({
  useFileAttachmentStore: (
    selector: (state: {
      statuses: Record<string, unknown>
      markUnavailable: () => void
      ensureChecked: () => void
      reset: () => void
    }) => unknown,
  ) => selector({ statuses: attachmentStatuses, markUnavailable: vi.fn(), ensureChecked: vi.fn(), reset: vi.fn() }),
}))
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
vi.mock('./TeamSpaceCreateTaskDialog', () => ({ TeamSpaceCreateTaskDialog: () => null }))

function buildMessage(overrides: Partial<IMMessage> = {}): IMMessage {
  return {
    id: 10,
    conversation_id: 'conv-1',
    sender_id: 'peer-user-2',
    content: 'hello copy me',
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

describe('IMMessageBubble text copy and card fallback', () => {
  // 气泡首测会冷加载整条 IM 依赖链，默认 5s 容易在本机/CI 抖超时。
  beforeEach(() => {
    mockSafeCopy.mockReset()
    mockToast.mockClear()
    for (const key of Object.keys(attachmentStatuses)) delete attachmentStatuses[Number(key)]
  })

  it('shows copy menu on text bubble right-click and copies message content', async () => {
    const { IMMessageBubble } = await import('./IMMessageBubble')
    const { container } = render(
      <IMMessageBubble message={buildMessage()} prevMessage={null} />,
    )
    const bubble = container.querySelector('[data-im-message-bubble]') as HTMLElement

    fireEvent.contextMenu(bubble, { clientX: 40, clientY: 50 })

    const copyItem = screen.getByRole('menuitem', { name: '复制' })
    expect(copyItem).toBeTruthy()
    fireEvent.click(copyItem)

    expect(mockSafeCopy).toHaveBeenCalledWith(
      'hello copy me',
      expect.any(Function),
      expect.any(Function),
    )
    const onSuccess = mockSafeCopy.mock.calls[0][1] as () => void
    onSuccess()
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: '已复制' }),
    )
  }, 15_000)

  it('does not open text copy menu when content is empty', async () => {
    const { IMMessageBubble } = await import('./IMMessageBubble')
    const { container } = render(
      <IMMessageBubble message={buildMessage({ content: '   ' })} prevMessage={null} />,
    )
    const bubble = container.querySelector('[data-im-message-bubble]') as HTMLElement

    fireEvent.contextMenu(bubble, { clientX: 40, clientY: 50 })

    expect(screen.queryByRole('menuitem', { name: '复制' })).toBeNull()
  })

  it('does not open text copy menu when right-clicking a link', async () => {
    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(
      <IMMessageBubble
        message={buildMessage({ content: 'see https://example.com now' })}
        prevMessage={null}
      />,
    )
    const link = screen.getByText('https://example.com')

    fireEvent.contextMenu(link, { clientX: 40, clientY: 50 })

    expect(screen.queryByRole('menuitem', { name: '复制' })).toBeNull()
  })

  it('does not open text copy menu for cloud document resource cards', async () => {
    const { IMMessageBubble } = await import('./IMMessageBubble')
    const { container } = render(
      <IMMessageBubble
        message={buildMessage({
          content: '看看这份方案',
          metadata: {
            card: {
              type: 'document',
              resource_id: 'doc-1',
              name: '方案文档',
              caption: '看看这份方案',
            },
          },
        })}
        prevMessage={null}
      />,
    )
    const bubble = container.querySelector('[data-im-message-bubble]') as HTMLElement

    fireEvent.contextMenu(bubble, { clientX: 40, clientY: 50 })

    expect(screen.queryByRole('menuitem', { name: '复制' })).toBeNull()
    expect(mockSafeCopy).not.toHaveBeenCalled()
    expect(screen.queryByText('当前客户端版本不支持此卡片，请升级到最新版本查看')).toBeNull()
  })

  it('hides fallback content and shows the upgrade hint for an unknown card type', async () => {
    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(
      <IMMessageBubble
        message={buildMessage({
          content: '[新卡片] 项目周报',
          metadata: { card: { type: 'project_digest_v2' } },
        })}
        prevMessage={null}
      />,
    )

    expect(screen.queryByText('[新卡片] 项目周报')).toBeNull()
    expect(screen.getByText('当前客户端版本不支持此卡片，请升级到最新版本查看')).toBeTruthy()
  })

  it('shows the upgrade fallback instead of an unsupported attachment card', async () => {
    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(
      <IMMessageBubble
        message={buildMessage({
          content: '[Codex 会话] 修复账户登录问题',
          message_type: MESSAGE_TYPE_FILE,
          has_attachment: true,
          metadata: {
            file_id: 'codex-session-1',
            file_name: '修复账户登录问题.codex-session.zip',
            card: { type: 'codex_session', schema_version: 1 },
          },
        })}
        prevMessage={null}
      />,
    )

    expect(screen.queryByText('[Codex 会话] 修复账户登录问题')).toBeNull()
    expect(screen.getByText('当前客户端版本不支持此卡片，请升级到最新版本查看')).toBeTruthy()
    expect(screen.queryByText('修复账户登录问题.codex-session.zip')).toBeNull()
  })

  it('copies a downloaded file from its context menu', async () => {
    attachmentStatuses[10] = {
      status: 'available',
      downloadUrl: 'https://cdn.example/video.mp4',
      downloadedAt: 1710000000000,
      localPath: '/Users/me/Downloads/video.mp4',
    }
    const writeFile = vi.fn(async () => ({ success: true }))
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: { clipboard: { writeFile } },
    })
    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(
      <IMMessageBubble
        message={buildMessage({
          content: '',
          message_type: MESSAGE_TYPE_FILE,
          has_attachment: true,
          metadata: { file_id: 'video-1', file_name: 'video.mp4' },
        })}
        prevMessage={null}
      />,
    )

    fireEvent.contextMenu(screen.getByText('video.mp4'), { clientX: 40, clientY: 50 })
    fireEvent.click(screen.getByRole('menuitem', { name: '复制文件' }))

    await vi.waitFor(() => expect(writeFile).toHaveBeenCalledWith('/Users/me/Downloads/video.mp4'))
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: '已复制文件' }))
  }, 15_000)

  it('replaces fallback content that already contains an upgrade hint', async () => {
    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(
      <IMMessageBubble
        message={buildMessage({
          content: '[新卡片] 项目周报（请升级至最新版本查看）',
          metadata: { card: { type: 'project_digest_v2' } },
        })}
        prevMessage={null}
      />,
    )

    expect(screen.queryByText('[新卡片] 项目周报（请升级至最新版本查看）')).toBeNull()
    expect(screen.getByText('当前客户端版本不支持此卡片，请升级到最新版本查看')).toBeTruthy()
  })

  it('does not show the card upgrade hint for ordinary text', async () => {
    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(<IMMessageBubble message={buildMessage()} prevMessage={null} />)

    expect(screen.getByText('hello copy me')).toBeTruthy()
    expect(screen.queryByText('当前客户端版本不支持此卡片，请升级到最新版本查看')).toBeNull()
  })
})
