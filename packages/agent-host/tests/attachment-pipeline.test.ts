import { describe, expect, it, vi } from 'vitest'

import {
  findAttachmentsMissingResourceIdentity,
  formatAttachmentResourceMetadata,
  formatGenericAttachmentResourceText,
  formatDocumentAttachmentMetadata,
  formatFallbackAttachmentText,
  resolveFileAttachmentsShell,
  type AttachmentDescriptor,
} from '../src/delivery/attachment-pipeline.js'

describe('formatGenericAttachmentResourceText', () => {
  it('告诉 Agent 用 file_id 保真落地普通文件', () => {
    const result = formatGenericAttachmentResourceText({
      file_id: 'file-zip',
      filename: 'source.zip',
      mime_type: 'application/zip',
    })
    expect(result).toContain('[对话文件资源: source.zip (application/zip)]')
    expect(result).toContain('save_attachment(file_id=file-zip)')
    expect(result).not.toContain('parse_document')
  })
})

describe('formatFallbackAttachmentText', () => {
  it('formats with mime when present', () => {
    expect(formatFallbackAttachmentText({ filename: 'foo.pdf', mime_type: 'application/pdf' }))
      .toBe('[附件: foo.pdf (application/pdf)]')
  })
  it('formats without mime', () => {
    expect(formatFallbackAttachmentText({ filename: 'foo.pdf' })).toBe('[附件: foo.pdf]')
  })
  it('uses `file` when filename missing', () => {
    expect(formatFallbackAttachmentText({})).toBe('[附件: file]')
  })
})

describe('formatDocumentAttachmentMetadata', () => {
  it('exposes the authoritative FileRecord UUID and attachment URL', () => {
    const result = formatDocumentAttachmentMetadata([
      {
        type: 'file',
        file_id: 'cc84e7cb-55bb-453a-b105-a8bcd627a57f',
        filename: 'How-Anthropic.pdf',
        url: 'http://127.0.0.1/local-object?object_key=19e41ff7.pdf',
      },
    ], { turnId: 'message-1' })

    expect(result).toContain('file_id="cc84e7cb-55bb-453a-b105-a8bcd627a57f"')
    expect(result).toContain('filename="How-Anthropic.pdf"')
    expect(result).toContain('url="http://127.0.0.1/local-object?object_key=19e41ff7.pdf"')
    expect(result).toContain('附件链接：http://127.0.0.1/local-object?object_key=19e41ff7.pdf')
    expect(result).toContain('save_attachment(file_id=...)')
  })

  it('保留旧 API 仅处理 file 的语义', () => {
    expect(formatDocumentAttachmentMetadata([
      { type: 'image', file_id: 'image-1', filename: 'x.png' },
      { type: 'file', filename: 'missing-id.pdf' },
    ])).toBe('')
  })
})

describe('attachment resource identity', () => {
  it('识别任何缺失 file_id 的上传附件', () => {
    expect(findAttachmentsMissingResourceIdentity([
      { type: 'image', filename: 'image.png', file_id: 'image-1' },
      { type: 'video', filename: 'video.mp4' },
      { type: 'file', filename: 'archive.zip', file_id: 'file-1' },
    ])).toEqual(['video.mp4'])
  })

  it('图片、视频和文件都生成按需读取资源说明', () => {
    const result = formatAttachmentResourceMetadata([
      { type: 'image', filename: 'image.png', file_id: 'image-1' },
      { type: 'video', filename: 'video.mp4', file_id: 'video-1' },
      { type: 'file', filename: 'archive.zip', file_id: 'file-1' },
    ])
    expect(result).toContain('file_id="image-1"')
    expect(result).toContain('file_id="video-1"')
    expect(result).toContain('file_id="file-1"')
  })
})

describe('resolveFileAttachmentsShell', () => {
  const attachment: AttachmentDescriptor = {
    type: 'file',
    file_id: 'file-1',
    filename: 'doc.md',
    mime_type: 'text/markdown',
  }

  it('returns empty string for empty attachments', async () => {
    const out = await resolveFileAttachmentsShell(
      [],
      async () => 'never',
      () => 'fallback',
    )
    expect(out).toBe('')
  })

  it('wraps successful body in `<context type="attached">`', async () => {
    const out = await resolveFileAttachmentsShell(
      [attachment],
      async () => 'resolved body',
      formatFallbackAttachmentText,
    )
    expect(out).toContain('<context type="attached"')
    expect(out).toContain('file_id="file-1"')
    expect(out).toContain('filename="doc.md"')
    expect(out).toContain('resolved body')
  })

  it('falls back to fallback text when resolver returns null', async () => {
    const out = await resolveFileAttachmentsShell(
      [attachment],
      async () => null,
      formatFallbackAttachmentText,
    )
    expect(out).toContain('[附件: doc.md (text/markdown)]')
  })

  it('falls back to fallback text when resolver rejects, and logs debug', async () => {
    const logger = { debug: vi.fn() }
    const out = await resolveFileAttachmentsShell(
      [attachment],
      async () => {
        throw new Error('boom')
      },
      formatFallbackAttachmentText,
      { logger },
    )
    expect(out).toContain('[附件: doc.md')
    expect(logger.debug).toHaveBeenCalledOnce()
  })

  it('includes `stale_after_turn` when turnId provided', async () => {
    const out = await resolveFileAttachmentsShell(
      [attachment],
      async () => 'body',
      formatFallbackAttachmentText,
      { turnId: 'turn-42' },
    )
    expect(out).toContain('stale_after_turn="turn-42"')
  })

  it('joins multiple attachments with double newline', async () => {
    const out = await resolveFileAttachmentsShell(
      [attachment, { ...attachment, filename: 'other.md' }],
      async (a) => `body-${a.filename}`,
      formatFallbackAttachmentText,
    )
    const blocks = out.split('\n\n')
    expect(blocks.length).toBeGreaterThanOrEqual(2)
    expect(out).toContain('body-doc.md')
    expect(out).toContain('body-other.md')
  })
})
