import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IMMessage } from '@/services/tabchatApi'
import { useFileAttachmentStore } from '@stores/useFileAttachmentStore'
import { useResourcePreviewStore } from '@components/chat/preview/useResourcePreviewStore'
import {
  canOpenImFilePreview,
  openImFilePreview,
  resolveImAttachmentDownloadUrl,
} from './openImFilePreview'
import { messageStableKey } from '@/services/im/messageMerge'

vi.mock('@components/ui', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}))

const getDownloadUrl = vi.fn()

vi.mock('@/services/tabchatApi', () => ({
  getMessageAttachmentDownloadUrl: (...args: unknown[]) => getDownloadUrl(...args),
}))

function makeFileMessage(overrides: Partial<IMMessage> = {}): IMMessage {
  return {
    id: 42,
    conversation_id: 'conv-1',
    sender_id: 'user-1',
    content: '',
    message_type: 3,
    reply_to_id: null,
    has_attachment: true,
    metadata: {
      file_id: 'file-1',
      file_name: 'notes.docx',
      file_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      file_size: 2048,
    },
    created_at: '2026-07-25T00:00:00Z',
    ...overrides,
  }
}

const t = (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key

describe('openImFilePreview', () => {
  beforeEach(() => {
    getDownloadUrl.mockReset()
    getDownloadUrl.mockResolvedValue({
      download_url: 'https://fresh.example/notes.docx',
      file_name: 'notes.docx',
      expires_in: 300,
    })
    useFileAttachmentStore.getState().reset()
    useResourcePreviewStore.getState().close()
  })

  it('detects previewable office documents', () => {
    expect(canOpenImFilePreview(makeFileMessage())).toBe(true)
    expect(canOpenImFilePreview(makeFileMessage({
      metadata: { file_name: 'archive.zip', file_type: 'application/zip' },
    }))).toBe(false)
  })

  it('refreshes attachment url then opens ChatResourcePreviewModal', async () => {
    const message = makeFileMessage()
    useFileAttachmentStore.setState({
      statuses: {
        [messageStableKey(message)]: { status: 'available', downloadUrl: 'https://stale.example/notes.docx' },
      },
    })

    const opened = await openImFilePreview(message, t)

    expect(opened).toBe(true)
    expect(getDownloadUrl).toHaveBeenCalledWith('conv-1', message)
    expect(useResourcePreviewStore.getState().isOpen).toBe(true)
    expect(useResourcePreviewStore.getState().resources[0]).toMatchObject({
      kind: 'docx',
      url: 'https://fresh.example/notes.docx',
      name: 'notes.docx',
      fileId: 'file-1',
      sourceMessageId: messageStableKey(message),
    })
  })

  it('reuses a pre-resolved url without another refresh', async () => {
    const opened = await openImFilePreview(makeFileMessage(), t, {
      url: 'https://already.example/notes.docx',
    })

    expect(opened).toBe(true)
    expect(getDownloadUrl).not.toHaveBeenCalled()
    expect(useResourcePreviewStore.getState().resources[0]?.url).toBe(
      'https://already.example/notes.docx',
    )
  })

  it('marks attachment unavailable when refresh fails', async () => {
    getDownloadUrl.mockRejectedValue(new Error('gone'))
    const markUnavailable = vi.spyOn(useFileAttachmentStore.getState(), 'markUnavailable')

    const url = await resolveImAttachmentDownloadUrl(makeFileMessage(), t)

    expect(url).toBeNull()
    expect(markUnavailable).toHaveBeenCalledWith(expect.objectContaining({ id: 42 }))
  })
})
