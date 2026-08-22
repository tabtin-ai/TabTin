import { describe, expect, it } from 'vitest'

import { buildAttachmentMessageBlocks } from '../src/conversation/attachment-message-blocks.js'

describe('buildAttachmentMessageBlocks', () => {
  it('preserves image and file attachments for persisted user message blocks', () => {
    const blocks = buildAttachmentMessageBlocks([
      {
        type: 'image',
        file_id: 'image-file-id',
        filename: 'screenshot.jpg',
        mime_type: 'image/jpeg',
        size: 67803,
        url: 'https://assets.example.com/chat/attachments/screenshot.jpg',
        preview_url: 'https://assets.example.com/chat/attachments/screenshot-preview.jpg',
      },
      {
        type: 'file',
        file_id: 'pdf-file-id',
        filename: 'report.pdf',
        mime_type: 'application/pdf',
        size: 12345,
        url: 'https://assets.example.com/chat/attachments/report.pdf',
      },
    ])

    expect(blocks).toEqual([
      {
        type: 'image',
        file_id: 'image-file-id',
        filename: 'screenshot.jpg',
        mime_type: 'image/jpeg',
        size: 67803,
        url: 'https://assets.example.com/chat/attachments/screenshot.jpg',
        preview_url: 'https://assets.example.com/chat/attachments/screenshot-preview.jpg',
      },
      {
        type: 'file',
        file_id: 'pdf-file-id',
        filename: 'report.pdf',
        mime_type: 'application/pdf',
        size: 12345,
        url: 'https://assets.example.com/chat/attachments/report.pdf',
        preview_url: undefined,
      },
    ])
  })

  it('returns undefined when there are no attachments', () => {
    expect(buildAttachmentMessageBlocks(undefined)).toBeUndefined()
    expect(buildAttachmentMessageBlocks([])).toBeUndefined()
  })
})
