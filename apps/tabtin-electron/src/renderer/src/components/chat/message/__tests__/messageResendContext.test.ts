import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import {
  buildEditResendMaterial,
  buildResendContextBlocks,
  buildSendRetryContextBlocks,
  mapAttachmentsForPrefill,
  mapBlocksForPrefill,
} from '@stores/chat/presentation/messageBubble/messageResendContext'

describe('messageResendContext', () => {
  it('buildResendContextBlocks 跳过 text block', () => {
    const message = {
      attachments_json: [{ type: 'file', file_id: 'f1', filename: 'a.txt' }],
      content_blocks_json: [
        { type: 'text', text: 'hello' },
        { type: 'context_ref', resource_id: 'r1' },
      ],
    } as ChatMessage

    const blocks = buildResendContextBlocks(message)
    expect(blocks).toHaveLength(2)
    expect(blocks?.some(b => b.type === 'text')).toBe(false)
  })

  it('buildSendRetryContextBlocks 保留全部 blocks', () => {
    const blocks = buildSendRetryContextBlocks(
      [{ type: 'file', file_id: 'f1' }],
      [{ type: 'text', text: 'hello' }],
    )
    expect(blocks).toHaveLength(2)
    expect(blocks?.some(b => b.type === 'text')).toBe(true)
  })

  it('mapAttachmentsForPrefill 保留 image / video / file', () => {
    const attachments = mapAttachmentsForPrefill([
      { type: 'image', file_id: 'img-1', filename: 'pic.png', mime_type: 'image/png', size: 10 },
      { type: 'video', file_id: 'vid-1', filename: 'clip.mp4', mime_type: 'video/mp4', size: 20 },
      { type: 'file', file_id: 'f-1', filename: 'a.pdf', mime_type: 'application/pdf', size: 30 },
    ])
    expect(attachments?.map(a => a.type)).toEqual(['image', 'video', 'file'])
  })

  it('mapBlocksForPrefill 跳过 text 与上传 media，只留 ContextRef', () => {
    const blocks = mapBlocksForPrefill([
      { type: 'text', text: 'x' },
      { type: 'video', file_id: 'vid-1', url: 'https://x/a.mp4' },
      { type: 'table_selection', table_id: 't1', preview: '表' },
    ])
    expect(blocks).toHaveLength(1)
    expect(blocks?.[0]?.type).toBe('table_selection')
  })

  it('编辑重发把保留的 image/file/video 统一恢复为附件并与 ContextRef 分流', () => {
    const message = {
      attachments_json: [
        { type: 'image', file_id: 'img-1', filename: 'pic.png', mime_type: 'image/png', size: 10 },
        { type: 'file', file_id: 'file-1', filename: 'source.zip', mime_type: 'application/zip', size: 20 },
      ],
      content_blocks_json: [
        { type: 'image', file_id: 'img-1', filename: 'pic.png', mime_type: 'image/png', size: 10 },
        { type: 'video', file_id: 'video-1', filename: 'clip.mp4', mime_type: 'video/mp4', size: 30 },
        { type: 'code_file', file_path: '/workspace/a.ts', root_path: '/workspace' },
      ],
    } as ChatMessage

    const material = buildEditResendMaterial(message, new Set(), new Set(), [])

    expect(material.attachments?.map(attachment => attachment.fileId)).toEqual([
      'img-1',
      'file-1',
      'video-1',
    ])
    expect(material.contextBlocks).toEqual([
      { type: 'code_file', file_path: '/workspace/a.ts', root_path: '/workspace' },
    ])
    expect(material.missingResourceNames).toEqual([])
  })

  it('编辑重发在回退前暴露缺少 file_id 的保留附件', () => {
    const message = {
      attachments_json: [
        { type: 'file', filename: 'legacy.zip', mime_type: 'application/zip', size: 20, url: 'https://example.com/legacy.zip' },
      ],
      content_blocks_json: [
        { type: 'document', title: 'legacy.pdf', mime_type: 'application/pdf' },
      ],
    } as unknown as ChatMessage

    const material = buildEditResendMaterial(message, new Set(), new Set(), [])

    expect(material.attachments).toHaveLength(1)
    expect(material.missingResourceNames).toEqual(['legacy.zip', 'legacy.pdf'])
  })

  it('编辑重发尊重原附件和 block 删除状态并去重新增附件', () => {
    const message = {
      attachments_json: [
        { type: 'file', file_id: 'keep-1', filename: 'keep.pdf', mime_type: 'application/pdf', size: 10 },
        { type: 'file', file_id: 'remove-1', filename: 'remove.pdf', mime_type: 'application/pdf', size: 20 },
      ],
      content_blocks_json: [
        { type: 'video', file_id: 'remove-video', filename: 'remove.mp4', mime_type: 'video/mp4', size: 30 },
        { type: 'table_selection', table_id: 'remove-table' },
      ],
    } as ChatMessage
    const duplicate = {
      id: 'new-keep-1',
      file: new File([], 'keep.pdf'),
      filename: 'keep.pdf',
      mimeType: 'application/pdf',
      size: 10,
      type: 'file' as const,
      status: 'ready' as const,
      fileId: 'keep-1',
    }

    const material = buildEditResendMaterial(
      message,
      new Set(['remove-1']),
      new Set([0, 1]),
      [duplicate],
    )

    expect(material.attachments?.map(attachment => attachment.fileId)).toEqual(['keep-1'])
    expect(material.contextBlocks).toBeUndefined()
  })

  it('编辑重发从 attachments_json 删除附件时同步排除同 file_id 的 media block', () => {
    const message = {
      attachments_json: [
        { type: 'image', file_id: 'shared-1', filename: 'shared.png', mime_type: 'image/png', size: 10 },
      ],
      content_blocks_json: [
        { type: 'image', file_id: 'shared-1', filename: 'shared.png', mime_type: 'image/png', size: 10 },
      ],
    } as ChatMessage

    const material = buildEditResendMaterial(message, new Set(['shared-1']), new Set(), [])

    expect(material.attachments).toBeUndefined()
  })

  it('编辑重发从 media block 删除附件时同步排除 attachments_json 的同一资源', () => {
    const message = {
      attachments_json: [
        { type: 'video', file_id: 'shared-2', filename: 'shared.mp4', mime_type: 'video/mp4', size: 10 },
      ],
      content_blocks_json: [
        { type: 'video', file_id: 'shared-2', filename: 'shared.mp4', mime_type: 'video/mp4', size: 10 },
      ],
    } as ChatMessage

    const material = buildEditResendMaterial(message, new Set(), new Set([0]), [])

    expect(material.attachments).toBeUndefined()
  })
})
