import { beforeEach, describe, expect, it, vi } from 'vitest'

const { downloadPreviewResourceSpy, resolveAccessUrlSpy } = vi.hoisted(() => ({
  downloadPreviewResourceSpy: vi.fn(),
  resolveAccessUrlSpy: vi.fn(),
}))

vi.mock('@components/chat/preview/downloadPreviewResource', () => ({
  downloadPreviewResource: (...args: unknown[]) => downloadPreviewResourceSpy(...args),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
  }),
  ToastAction: () => null,
}))

vi.mock('@tabtin/table-core', () => ({
  AttachmentApiService: {
    resolveAccessUrl: (...args: unknown[]) => resolveAccessUrlSpy(...args),
  },
}))

import { downloadTabDataAttachment } from '../downloadTabDataAttachments'

describe('downloadTabDataAttachment', () => {
  beforeEach(() => {
    downloadPreviewResourceSpy.mockReset()
    downloadPreviewResourceSpy.mockResolvedValue('saved')
    resolveAccessUrlSpy.mockReset()
  })

  it('refreshes an expired private attachment through TabData context before downloading', async () => {
    resolveAccessUrlSpy.mockResolvedValue({
      url: 'https://oss.example/private/report.pdf',
      expires_in: 3600,
    })
    const t = vi.fn((key: string) => key)

    await downloadTabDataAttachment({
      url: 'https://oss.example/private/report.pdf?expired=1',
      name: 'report.pdf',
      fileId: '802cf8e7-08fc-4619-9145-a37b201fb877',
      accessContext: {
        fieldId: 'field-1',
        recordId: 'record-1',
        referenceId: 'reference-1',
      },
    }, t as never, { tableId: 'table-1' })

    expect(resolveAccessUrlSpy).toHaveBeenCalledWith({
      file_id: '802cf8e7-08fc-4619-9145-a37b201fb877',
      table_id: 'table-1',
      field_id: 'field-1',
      record_id: 'record-1',
      reference_id: 'reference-1',
    })
    expect(downloadPreviewResourceSpy).toHaveBeenCalledWith({
      url: 'https://oss.example/private/report.pdf',
      fileName: 'report.pdf',
      t,
      fileId: '802cf8e7-08fc-4619-9145-a37b201fb877',
    })
  })
})
