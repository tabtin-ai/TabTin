import { beforeEach, describe, expect, it, vi } from 'vitest'

const download = vi.fn()

vi.mock('../../services/ResourceDownloadService.js', () => ({
  getResourceDownloadService: () => ({ download }),
}))

const { saveAttachmentToWorkspace } = await import('../attachment-save-adapter.js')

describe('saveAttachmentToWorkspace', () => {
  beforeEach(() => {
    download.mockReset()
  })

  it('saves under the Workspace attachments directory and returns a relative path', async () => {
    download.mockResolvedValue({
      filePath: '/workspace/attachments/report.html',
      size: 42,
      mimeType: 'text/html',
    })

    const result = await saveAttachmentToWorkspace({
      fileId: 'file-1',
      sourceUrl: 'https://cdn.example.test/report.html',
      filename: 'report.html',
      mimeType: 'text/html',
      expectedSize: 42,
      workspaceRoot: '/workspace',
      abortSignal: new AbortController().signal,
    })

    expect(download).toHaveBeenCalledWith({
      url: 'https://cdn.example.test/report.html',
      filename: 'report.html',
      outputDir: '/workspace/attachments',
      maxBytes: 100 * 1024 * 1024,
    })
    expect(result).toEqual({
      relativePath: 'attachments/report.html',
      size: 42,
      mimeType: 'text/html',
    })
  })
})
