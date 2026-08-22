import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { MESSAGE_TYPE_FILE, MESSAGE_TYPE_IMAGE, MESSAGE_TYPE_TEXT } from '@/constants/tabchat'
import type { IMMessage } from '@/services/tabchatApi'
import { useResourcePreviewStore } from '@components/chat/preview/useResourcePreviewStore'

const {
  mockEnsureProfiles,
  mockGetAttachmentUrl,
  mockDownloadImAttachment,
  attachmentStatuses,
  mockMarkUnavailable,
  mockMarkDownloaded,
  mockOpenPath,
  mockShowItemInFolder,
} = vi.hoisted(() => ({
  mockEnsureProfiles: vi.fn(),
  mockGetAttachmentUrl: vi.fn(),
  mockDownloadImAttachment: vi.fn(),
  attachmentStatuses: { value: {} as Record<number, { status: string; downloadUrl: string | null; downloadedAt?: number; localPath?: string }> },
  mockMarkUnavailable: vi.fn(),
  mockMarkDownloaded: vi.fn(),
  mockOpenPath: vi.fn(),
  mockShowItemInFolder: vi.fn(),
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
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
  }),
  resolveChoiceTagColors: () => ({ bg: '', text: '', border: '' }),
  FALLBACK_TAG_BG: '',
  FALLBACK_TAG_TEXT: '',
  FALLBACK_TAG_BORDER: '',
}))

vi.mock('./downloadImAttachment', () => ({
  downloadImAttachment: mockDownloadImAttachment,
}))

vi.mock('@/services/openResourceLink', () => ({
  handleResourceLinkClick: vi.fn(),
  handleResourceLinkContextMenu: vi.fn(),
}))

vi.mock('@/services/tabchatApi', () => ({
  deleteMessage: vi.fn(),
  getMessageAttachmentDownloadUrl: mockGetAttachmentUrl,
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
  const getState = () => ({
    statuses: attachmentStatuses.value,
    markUnavailable: mockMarkUnavailable,
    markDownloaded: mockMarkDownloaded,
    markLocalFile: vi.fn(),
    ensureChecked: vi.fn(),
    reset: vi.fn(),
  })
  const useFileAttachmentStore = Object.assign(
    (selector: (state: ReturnType<typeof getState>) => unknown) => selector(getState()),
    { getState },
  )
  return { useFileAttachmentStore }
})

vi.mock('@stores/useUserProfileCache', () => ({
  useUserProfileCache: (selector: (state: { ensureProfiles: typeof mockEnsureProfiles }) => unknown) =>
    selector({ ensureProfiles: mockEnsureProfiles }),
  useDisplayName: () => 'Peer Profile',
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

vi.mock('./TeamSpaceCreateTaskDialog', () => ({
  TeamSpaceCreateTaskDialog: () => null,
}))

vi.mock('./SpaceCard', () => ({
  SpaceCard: () => null,
}))

vi.mock('./IMResourceCard', () => ({
  IMResourceCard: () => null,
}))

vi.mock('./ContactCard', () => ({
  ContactCard: () => null,
}))

function buildMessage(overrides: Partial<IMMessage>): IMMessage {
  return {
    id: 10,
    conversation_id: 'conv-1',
    sender_id: 'human-user-1',
    content: 'hello',
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

describe('IMMessageBubble forward polish', () => {
  beforeEach(() => {
    mockGetAttachmentUrl.mockReset()
    mockGetAttachmentUrl.mockResolvedValue({
      download_url: 'https://oss.example.com/fresh/report.pdf',
      file_name: 'report.pdf',
      expires_in: 3600,
    })
    attachmentStatuses.value = {}
    mockMarkUnavailable.mockReset()
    mockMarkDownloaded.mockReset()
    mockDownloadImAttachment.mockReset()
    mockDownloadImAttachment.mockResolvedValue('saved')
    mockOpenPath.mockReset()
    mockOpenPath.mockResolvedValue({ success: true })
    mockShowItemInFolder.mockReset()
    mockShowItemInFolder.mockResolvedValue({ success: true })
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: {
        openPath: mockOpenPath,
        showItemInFolder: mockShowItemInFolder,
      },
    })
  })

  it('styles markdown headings as a block hierarchy distinct from inline bold', async () => {
    const { markdownComponents } = await import('./IMMessageBubble')
    const Heading = markdownComponents.h1 as React.ComponentType<{ children: React.ReactNode }>
    const Subheading = markdownComponents.h2 as React.ComponentType<{ children: React.ReactNode }>
    const TertiaryHeading = markdownComponents.h3 as React.ComponentType<{ children: React.ReactNode }>
    const Strong = markdownComponents.strong as React.ComponentType<{ children: React.ReactNode }>

    const { container } = render(
      <div>
        <Heading>标题</Heading>
        <Subheading>二级标题</Subheading>
        <TertiaryHeading>三级标题</TertiaryHeading>
        <p><Strong>加粗</Strong></p>
      </div>,
    )

    const heading = screen.getByRole('heading', { level: 1 })
    const subheading = screen.getByRole('heading', { level: 2 })
    const tertiaryHeading = screen.getByRole('heading', { level: 3 })
    const strong = container.querySelector('strong')
    expect(heading.className).toContain('border-b')
    expect(heading.className).toContain('pb-1')
    expect(heading.className).toContain('font-bold')
    expect(subheading.className).toContain('border-l-2')
    expect(subheading.className).toContain('pl-2')
    expect(tertiaryHeading.className).toContain('border-l')
    expect(tertiaryHeading.className).toContain('pl-2')
    expect(strong?.className).toContain('font-semibold')
    expect(strong?.className).not.toContain('border-b')
    expect(strong?.className).not.toContain('border-l')
  })

  it('hides forwarded-from label when user forwards own message (TC-12)', async () => {
    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(
      <IMMessageBubble
        message={buildMessage({
          metadata: {
            forwarded_from: {
              original_message_id: 1,
              original_conversation_id: 'conv-1',
              original_conversation_name: 'Old',
              original_sender_id: 'human-user-1',
              original_sender_name: 'Me',
            },
          },
        })}
        prevMessage={null}
      />,
    )

    expect(screen.queryByText(/forwardedFrom:/)).toBeNull()
  })

  it('shows forwarded-from label for messages forwarded from someone else', async () => {
    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(
      <IMMessageBubble
        message={buildMessage({
          metadata: {
            forwarded_from: {
              original_message_id: 2,
              original_conversation_id: 'conv-2',
              original_conversation_name: 'Team',
              original_sender_id: 'peer-user-2',
              original_sender_name: 'Alice',
            },
          },
        })}
        prevMessage={null}
      />,
    )

    expect(screen.getByText('forwardedFrom:Alice')).toBeTruthy()
  })

  it('renders the accompanying message below a file card without repeating legacy placeholders', async () => {
    attachmentStatuses.value = { 10: { status: 'available', downloadUrl: 'https://oss.example.com/fresh/report.pdf' } }
    const { IMMessageBubble } = await import('./IMMessageBubble')
    const { rerender } = render(
      <IMMessageBubble
        message={buildMessage({
          message_type: MESSAGE_TYPE_FILE,
          content: '请查收这份方案',
          has_attachment: true,
          metadata: { file_id: 'file-123', file_name: 'report.pdf', file_size: 2048 },
        })}
        prevMessage={null}
      />,
    )

    const caption = screen.getByText('请查收这份方案')
    const fileName = screen.getByText('report.pdf')
    expect(fileName.compareDocumentPosition(caption) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    rerender(
      <IMMessageBubble
        message={buildMessage({
          message_type: MESSAGE_TYPE_FILE,
          content: '[文件] report.pdf',
          has_attachment: true,
          metadata: { file_id: 'file-123', file_name: 'report.pdf', file_size: 2048 },
        })}
        prevMessage={null}
      />,
    )
    expect(screen.queryByText('[文件] report.pdf')).toBeNull()
  })

  it('renders the accompanying message below an image', async () => {
    attachmentStatuses.value = { 10: { status: 'available', downloadUrl: 'https://oss.example.com/photo.png' } }
    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(
      <IMMessageBubble
        message={buildMessage({
          message_type: MESSAGE_TYPE_IMAGE,
          content: '图片说明',
          has_attachment: true,
          metadata: { file_id: 'image-123', file_name: 'photo.png' },
        })}
        prevMessage={null}
      />,
    )

    const image = screen.getByRole('img', { name: 'photo.png' })
    const caption = screen.getByText('图片说明')
    expect(image.compareDocumentPosition(caption) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('renders download button only when store marks attachment available (TC-13)', async () => {
    attachmentStatuses.value = { 10: { status: 'available', downloadUrl: 'https://oss.example.com/fresh/report.pdf' } }
    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(
      <IMMessageBubble
        message={buildMessage({
          message_type: MESSAGE_TYPE_FILE,
          content: '[文件] report.pdf',
          has_attachment: true,
          metadata: {
            file_id: 'file-123',
            file_name: 'report.pdf',
            file_size: 2048,
          },
        })}
        prevMessage={null}
      />,
    )

    expect(screen.getByText('report.pdf')).toBeTruthy()
    expect(screen.getByTitle('download')).toBeTruthy()
  })

  it('marks file as downloaded so remounting after tab switch does not require another download', async () => {
    attachmentStatuses.value = { 10: { status: 'available', downloadUrl: 'https://oss.example.com/fresh/report.pdf' } }
    const { IMMessageBubble } = await import('./IMMessageBubble')
    const fileMessage = buildMessage({
      message_type: MESSAGE_TYPE_FILE,
      content: '[文件] report.pdf',
      has_attachment: true,
      metadata: {
        file_id: 'file-123',
        file_name: 'report.pdf',
        file_size: 2048,
      },
    })

    const { unmount } = render(<IMMessageBubble message={fileMessage} prevMessage={null} />)
    fireEvent.click(screen.getByTitle('download'))

    await waitFor(() => {
      expect(mockDownloadImAttachment).toHaveBeenCalled()
      expect(mockMarkDownloaded).toHaveBeenCalledWith(10)
    })

    unmount()
    attachmentStatuses.value = {
      10: {
        status: 'available',
        downloadUrl: 'https://oss.example.com/fresh/report.pdf',
        downloadedAt: 1710000000000,
      },
    }
    render(<IMMessageBubble message={fileMessage} prevMessage={null} />)

    expect(screen.getByTitle('已下载')).toBeTruthy()
    expect(screen.queryByTitle('download')).toBeNull()
  })

  it('records downloaded file path, previews PDF in-app, and keeps reveal-in-folder', async () => {
    attachmentStatuses.value = { 10: { status: 'available', downloadUrl: 'https://oss.example.com/fresh/report.pdf' } }
    mockDownloadImAttachment.mockResolvedValue({ status: 'saved', path: '/Users/me/Downloads/report.pdf' })
    useResourcePreviewStore.getState().close()
    const { IMMessageBubble } = await import('./IMMessageBubble')
    const fileMessage = buildMessage({
      message_type: MESSAGE_TYPE_FILE,
      content: '[文件] report.pdf',
      has_attachment: true,
      metadata: {
        file_id: 'file-123',
        file_name: 'report.pdf',
        file_type: 'application/pdf',
        file_size: 2048,
      },
    })

    const { unmount } = render(<IMMessageBubble message={fileMessage} prevMessage={null} />)
    fireEvent.click(screen.getByTitle('download'))
    await waitFor(() => {
      expect(mockMarkDownloaded).toHaveBeenCalledWith(10, '/Users/me/Downloads/report.pdf')
    })

    unmount()
    attachmentStatuses.value = {
      10: {
        status: 'available',
        downloadUrl: 'https://oss.example.com/fresh/report.pdf',
        downloadedAt: 1710000000000,
        localPath: '/Users/me/Downloads/report.pdf',
      },
    }
    render(<IMMessageBubble message={fileMessage} prevMessage={null} />)

    fireEvent.click(screen.getByText('report.pdf'))
    await waitFor(() => {
      expect(useResourcePreviewStore.getState().isOpen).toBe(true)
      expect(useResourcePreviewStore.getState().resources[0]?.kind).toBe('pdf')
    })
    expect(mockOpenPath).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTitle('打开文件夹'))
    expect(mockShowItemInFolder).toHaveBeenCalledWith('/Users/me/Downloads/report.pdf')
    useResourcePreviewStore.getState().close()
  })

  it('opens unsupported local attachments with the system default app', async () => {
    attachmentStatuses.value = {
      10: {
        status: 'available',
        downloadUrl: 'https://oss.example.com/fresh/archive.zip',
        downloadedAt: 1710000000000,
        localPath: '/Users/me/Downloads/archive.zip',
      },
    }
    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(
      <IMMessageBubble
        message={buildMessage({
          message_type: MESSAGE_TYPE_FILE,
          content: '[文件] archive.zip',
          has_attachment: true,
          metadata: {
            file_id: 'file-zip',
            file_name: 'archive.zip',
            file_type: 'application/zip',
            file_size: 4096,
          },
        })}
        prevMessage={null}
      />,
    )

    fireEvent.click(screen.getByText('archive.zip'))
    expect(mockOpenPath).toHaveBeenCalledWith('/Users/me/Downloads/archive.zip')
    expect(useResourcePreviewStore.getState().isOpen).toBe(false)
  })

  it('opens available PDF attachments in the shared Agent preview lightbox', async () => {
    attachmentStatuses.value = {
      10: { status: 'available', downloadUrl: 'https://oss.example.com/stale/brief.pdf' },
    }
    mockGetAttachmentUrl.mockResolvedValue({
      download_url: 'https://oss.example.com/fresh/brief.pdf',
      file_name: 'brief.pdf',
      expires_in: 3600,
    })
    useResourcePreviewStore.getState().close()
    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(
      <IMMessageBubble
        message={buildMessage({
          message_type: MESSAGE_TYPE_FILE,
          content: '[文件] brief.pdf',
          has_attachment: true,
          metadata: {
            file_id: 'file-pdf',
            file_name: 'brief.pdf',
            file_type: 'application/pdf',
            file_size: 1024,
          },
        })}
        prevMessage={null}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '预览' }))
    await waitFor(() => {
      const state = useResourcePreviewStore.getState()
      expect(state.isOpen).toBe(true)
      expect(state.resources[0]).toMatchObject({
        kind: 'pdf',
        name: 'brief.pdf',
        fileId: 'file-pdf',
        url: 'https://oss.example.com/fresh/brief.pdf',
      })
    })
    expect(mockGetAttachmentUrl).toHaveBeenCalledWith('conv-1', 10)
    useResourcePreviewStore.getState().close()
  })

  it('shows unavailable state in chat from store status, hiding download (TC-13 UI)', async () => {
    attachmentStatuses.value = { 10: { status: 'unavailable', downloadUrl: null } }
    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(
      <IMMessageBubble
        message={buildMessage({
          message_type: MESSAGE_TYPE_FILE,
          content: '[文件] stale.pdf',
          has_attachment: true,
          metadata: {
            file_id: 'file-stale',
            file_name: 'stale.pdf',
            file_size: 1024,
            access_url: 'https://oss.example.com/stale.pdf',
          },
        })}
        prevMessage={null}
      />,
    )

    expect(screen.getByText('fileUnavailable')).toBeTruthy()
    expect(screen.queryByTitle('download')).toBeNull()
  })

  it('shows checking state when store has no status yet (TC-13 UI)', async () => {
    attachmentStatuses.value = {}
    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(
      <IMMessageBubble
        message={buildMessage({
          message_type: MESSAGE_TYPE_FILE,
          content: '[文件] checking.pdf',
          has_attachment: true,
          metadata: {
            file_id: 'file-checking',
            file_name: 'checking.pdf',
            file_size: 512,
          },
        })}
        prevMessage={null}
      />,
    )

    expect(screen.getByText('fileChecking')).toBeTruthy()
    expect(screen.queryByTitle('download')).toBeNull()
  })
})
