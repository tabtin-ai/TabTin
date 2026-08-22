import { beforeEach, describe, expect, it, vi } from 'vitest'

const { openSpy, getCachedMediaUrlSpy, resolveAccessUrlSpy, resolveOssFileAccessUrlSpy } = vi.hoisted(
  () => ({
    openSpy: vi.fn(() => true),
    getCachedMediaUrlSpy: vi.fn(),
    resolveAccessUrlSpy: vi.fn(),
    resolveOssFileAccessUrlSpy: vi.fn(),
  }),
)

vi.mock('@components/chat/preview/useResourcePreviewStore', () => ({
  useResourcePreviewStore: {
    getState: () => ({
      open: openSpy,
    }),
  },
}))

vi.mock('@components/chat/preview/chatMediaHttpCache', () => ({
  getCachedChatMediaObjectUrl: (...args: unknown[]) =>
    getCachedMediaUrlSpy(...args),
}))

vi.mock('@tabtin/table-core', () => ({
  AttachmentApiService: {
    resolveAccessUrl: (...args: unknown[]) => resolveAccessUrlSpy(...args),
  },
}))

vi.mock('@components/chat/preview/resolveOssFileAccessUrl', () => ({
  resolveOssFileAccessUrl: (...args: unknown[]) => resolveOssFileAccessUrlSpy(...args),
}))

import {
  loadElectronAttachmentPreviewUi,
  mapAttachmentPreviewFiles,
  resolveAttachmentPreviewFiles,
  resolveElectronAttachmentThumbnailUrl,
} from '../electronAttachmentPreviewUi'

describe('electronAttachmentPreviewUi', () => {
  beforeEach(() => {
    openSpy.mockClear()
    openSpy.mockReturnValue(true)
    getCachedMediaUrlSpy.mockReset()
    resolveAccessUrlSpy.mockReset()
    resolveOssFileAccessUrlSpy.mockReset()
  })

  it('resolves a file-id-only thumbnail through private OSS access', async () => {
    resolveAccessUrlSpy.mockResolvedValue({
      url: 'https://oss.example/private/signed.jpeg',
      expires_in: 3600,
    })
    getCachedMediaUrlSpy.mockResolvedValue('blob:private-thumbnail')

    await expect(
      resolveElectronAttachmentThumbnailUrl({
        fileId: 'attachment-key',
        src: '',
        name: 'private.jpeg',
        mimetype: 'image/jpeg',
        assetFileId: '802cf8e7-08fc-4619-9145-a37b201fb877',
        accessContext: {
          fieldId: 'field-1',
          recordId: 'record-1',
        },
      }, { tableId: 'table-1' }),
    ).resolves.toBe('blob:private-thumbnail')

    expect(resolveAccessUrlSpy).toHaveBeenCalledWith({
      file_id: '802cf8e7-08fc-4619-9145-a37b201fb877',
      table_id: 'table-1',
      field_id: 'field-1',
      record_id: 'record-1',
      reference_id: undefined,
    })
    expect(getCachedMediaUrlSpy).toHaveBeenCalledWith({
      url: 'https://oss.example/private/signed.jpeg',
      fileId: '802cf8e7-08fc-4619-9145-a37b201fb877',
      mimeType: 'image/jpeg',
    })
  })

  it('falls back to the legacy OSS file route when an older backend rejects access-url with 405', async () => {
    const methodNotAllowed = Object.assign(new Error('Method not allowed'), { status: 405 })
    resolveAccessUrlSpy.mockRejectedValue(methodNotAllowed)
    resolveOssFileAccessUrlSpy.mockResolvedValue('https://oss.example/private/legacy-signed.jpeg')
    getCachedMediaUrlSpy.mockResolvedValue('blob:legacy-thumbnail')

    await expect(
      resolveElectronAttachmentThumbnailUrl({
        fileId: 'attachment-key',
        src: 'https://oss.example/private/stale.jpeg',
        name: 'private.jpeg',
        mimetype: 'image/jpeg',
        assetFileId: '802cf8e7-08fc-4619-9145-a37b201fb877',
        accessContext: {
          fieldId: 'field-1',
          recordId: 'record-1',
        },
      }, { tableId: 'table-1' }),
    ).resolves.toBe('blob:legacy-thumbnail')

    expect(resolveAccessUrlSpy).toHaveBeenCalledTimes(1)
    expect(resolveOssFileAccessUrlSpy).toHaveBeenCalledWith(
      '802cf8e7-08fc-4619-9145-a37b201fb877',
      { forceRefresh: true },
    )
    expect(getCachedMediaUrlSpy).toHaveBeenCalledWith({
      url: 'https://oss.example/private/legacy-signed.jpeg',
      fileId: '802cf8e7-08fc-4619-9145-a37b201fb877',
      mimeType: 'image/jpeg',
    })
  })

  it('does not bypass a real TabData permission denial through the legacy OSS route', async () => {
    const permissionDenied = Object.assign(new Error('Permission denied'), { status: 403 })
    resolveAccessUrlSpy.mockRejectedValue(permissionDenied)

    await expect(
      resolveElectronAttachmentThumbnailUrl({
        fileId: 'attachment-key',
        src: 'https://oss.example/private/stale.jpeg',
        name: 'private.jpeg',
        mimetype: 'image/jpeg',
        assetFileId: '802cf8e7-08fc-4619-9145-a37b201fb877',
      }, { tableId: 'table-1' }),
    ).rejects.toMatchObject({ status: 403 })

    expect(resolveOssFileAccessUrlSpy).not.toHaveBeenCalled()
    expect(getCachedMediaUrlSpy).not.toHaveBeenCalled()
  })

  it('does not fall back when the access-url route exists but the attachment is missing (404 + NOT_FOUND)', async () => {
    const attachmentMissing = Object.assign(new Error('附件不存在'), {
      status: 404,
      code: 'NOT_FOUND',
    })
    resolveAccessUrlSpy.mockRejectedValue(attachmentMissing)

    await expect(
      resolveElectronAttachmentThumbnailUrl({
        fileId: 'attachment-key',
        src: 'https://oss.example/private/stale.jpeg',
        name: 'private.jpeg',
        mimetype: 'image/jpeg',
        assetFileId: '802cf8e7-08fc-4619-9145-a37b201fb877',
      }, { tableId: 'table-1' }),
    ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })

    expect(resolveOssFileAccessUrlSpy).not.toHaveBeenCalled()
    expect(getCachedMediaUrlSpy).not.toHaveBeenCalled()
  })

  it('falls back when a 404 has no business error code (missing route on older backends)', async () => {
    const routeMissing = Object.assign(new Error('Not Found'), { status: 404 })
    resolveAccessUrlSpy.mockRejectedValue(routeMissing)
    resolveOssFileAccessUrlSpy.mockResolvedValue('https://oss.example/private/legacy-signed.jpeg')
    getCachedMediaUrlSpy.mockResolvedValue('blob:legacy-thumbnail')

    await expect(
      resolveElectronAttachmentThumbnailUrl({
        fileId: 'attachment-key',
        src: 'https://oss.example/private/stale.jpeg',
        name: 'private.jpeg',
        mimetype: 'image/jpeg',
        assetFileId: '802cf8e7-08fc-4619-9145-a37b201fb877',
      }, { tableId: 'table-1' }),
    ).resolves.toBe('blob:legacy-thumbnail')

    expect(resolveOssFileAccessUrlSpy).toHaveBeenCalledWith(
      '802cf8e7-08fc-4619-9145-a37b201fb877',
      { forceRefresh: true },
    )
  })

  it('maps xlsx/docx attachments to Office preview kinds with asset file id', () => {
    const resources = mapAttachmentPreviewFiles([
      {
        fileId: 'key-xlsx',
        src: 'https://assets.example.com/tabdata/a/report.xlsx',
        name: 'report.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        assetFileId: 'fid-xlsx',
      },
      {
        fileId: 'key-docx',
        src: 'https://assets.example.com/tabdata/a/brief.docx',
        name: 'brief.docx',
        mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        assetFileId: 'fid-docx',
      },
      {
        fileId: 'key-png',
        src: 'https://assets.example.com/tabdata/a/cover.png',
        name: 'cover.png',
        mimetype: 'image/png',
      },
    ])

    expect(resources.map((r) => r.kind)).toEqual(['xlsx', 'docx', 'image'])
    expect(resources[0]).toMatchObject({
      id: 'tabdata-att:key-xlsx',
      fileId: 'fid-xlsx',
      url: 'https://assets.example.com/tabdata/a/report.xlsx',
    })
    expect(resources[1].fileId).toBe('fid-docx')
  })

  it('resolves file-id-only resources before opening the preview stack', async () => {
    resolveAccessUrlSpy.mockResolvedValue({
      url: 'https://oss.example/private/report.pdf',
      expires_in: 3600,
    })

    await expect(resolveAttachmentPreviewFiles([{
      fileId: 'key-pdf',
      src: '',
      name: 'report.pdf',
      mimetype: 'application/pdf',
      assetFileId: 'fid-pdf',
      accessContext: { referenceId: 'ref-pdf' },
    }], { tableId: 'table-pdf' })).resolves.toEqual([
      expect.objectContaining({
        src: 'https://oss.example/private/report.pdf',
        assetFileId: 'fid-pdf',
      }),
    ])
    expect(resolveAccessUrlSpy).toHaveBeenCalledWith({
      file_id: 'fid-pdf',
      table_id: 'table-pdf',
      field_id: undefined,
      record_id: undefined,
      reference_id: 'ref-pdf',
    })
  })

  it('openPreview opens the chat lightbox at the matching index', async () => {
    const ui = await loadElectronAttachmentPreviewUi()
    const { createElement, createRef } = await import('react')
    const { render } = await import('@testing-library/react')

    const ref = createRef<{ openPreview: (fileId: string) => void }>()
    render(
      createElement(ui.Dialog, {
        ref,
        files: [
          {
            fileId: 'img-1',
            src: 'https://cdn.example/a.png',
            name: 'a.png',
            mimetype: 'image/png',
          },
          {
            fileId: 'xlsx-1',
            src: 'https://cdn.example/scores.xlsx',
            name: 'scores.xlsx',
            mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            assetFileId: 'fid-1',
          },
        ],
      }),
    )

    ref.current?.openPreview('xlsx-1')

    await vi.waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1))
    const [resources, index, options] = openSpy.mock.calls[0]
    expect(index).toBe(1)
    expect(options).toEqual({ showNavMeta: true })
    expect(resources[1]).toMatchObject({
      kind: 'xlsx',
      name: 'scores.xlsx',
      fileId: 'fid-1',
    })
  })
})
