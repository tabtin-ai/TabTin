import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import {
  mapMessageAttachmentsForRetry,
  resolveRetrySendContent,
} from '@stores/chat/presentation/messageBubble/messageResendContext'

describe('messageResendContext retry helpers ', () => {
  it('resolveRetrySendContent 忽略 [富内容] 摘要，只认 text 块', () => {
    const message = {
      content: '[富内容]',
      text_summary: '[富内容]',
      content_blocks_json: [
        { type: 'video', file_id: 'v1', url: 'https://cdn.example.com/a.mp4' },
      ],
    } as ChatMessage
    expect(resolveRetrySendContent(message)).toBe('')
  })

  it('resolveRetrySendContent 从 text 块取真实正文', () => {
    const message = {
      content: '[富内容]',
      content_blocks_json: [
        { type: 'text', text: '看看这个视频' },
        { type: 'video', file_id: 'v1', url: 'https://cdn.example.com/a.mp4' },
      ],
    } as ChatMessage
    expect(resolveRetrySendContent(message)).toBe('看看这个视频')
  })

  it('mapMessageAttachmentsForRetry 从 video 块还原 ready 附件', () => {
    const message = {
      content: '',
      content_blocks_json: [
        {
          type: 'video',
          file_id: 'vid-1',
          filename: 'clip.mp4',
          mime_type: 'video/mp4',
          size: 42,
          url: 'https://cdn.example.com/clip.mp4',
        },
      ],
    } as ChatMessage
    const attachments = mapMessageAttachmentsForRetry(message)
    expect(attachments).toHaveLength(1)
    expect(attachments![0]).toMatchObject({
      fileId: 'vid-1',
      type: 'video',
      status: 'ready',
      remoteUrl: 'https://cdn.example.com/clip.mp4',
      filename: 'clip.mp4',
    })
  })
})
