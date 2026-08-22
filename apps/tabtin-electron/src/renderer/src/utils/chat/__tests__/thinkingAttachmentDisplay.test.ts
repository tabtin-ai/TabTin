import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import {
  collectAttachmentFilenameById,
  projectAttachmentBlocksForDisplay,
  projectThinkingTextForDisplay,
} from '../thinkingAttachmentDisplay'

function makeMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: overrides.id ?? 'message-1',
    role: overrides.role ?? 'user',
    content: '',
    created_at: '2026-08-15T00:00:00Z',
    ...overrides,
  } as ChatMessage
}

describe('thinkingAttachmentDisplay', () => {
  it('优先用用户附件的 filename 替换 Thinking 中对应的 file_id', () => {
    const fileId = '209afbfb-0739-4aa9-b5a9-f944cd040581'
    const filenames = collectAttachmentFilenameById([
      makeMessage({
        attachments_json: [{
          type: 'file',
          file_id: fileId,
          filename: '测试word.docx',
          mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          size: 37_600,
        }],
      }),
    ])

    expect(projectThinkingTextForDisplay(`正在解析 ${fileId}`, filenames))
      .toBe('正在解析 测试word.docx')
  })

  it('历史用户消息从 file/document block 收集 filename 与 title', () => {
    const message = makeMessage({
      blocks: [
        {
          index: 0,
          block_id: 'file-block',
          block: { type: 'file', file_id: 'file-1', filename: '报告.pdf' },
          finalized: true,
          partial: false,
        },
        {
          index: 1,
          block_id: 'document-block',
          block: {
            type: 'document',
            title: '访谈记录.docx',
            source: { type: 'file_id', file_id: 'file-2' },
          },
          finalized: true,
          partial: false,
        },
      ] as never,
    })

    const filenames = collectAttachmentFilenameById([message])
    expect(filenames.get('file-1')).toBe('报告.pdf')
    expect(filenames.get('file-2')).toBe('访谈记录.docx')
  })

  it('没有 filename 时保留 file_id，且不替换无关 UUID', () => {
    const attachmentId = 'attachment-id-without-name'
    const unrelatedId = 'c89817be-8bf1-4fc8-9d51-9901951e0ee8'
    const filenames = collectAttachmentFilenameById([
      makeMessage({
        attachments_json: [{
          type: 'file',
          file_id: attachmentId,
          filename: '',
          mime_type: 'application/octet-stream',
          size: 1,
        }],
      }),
    ])

    expect(projectThinkingTextForDisplay(
      `读取 ${attachmentId}，任务 ${unrelatedId}`,
      filenames,
    )).toBe(`读取 ${attachmentId}，任务 ${unrelatedId}`)
  })

  it('只收集用户上传文件，不用助手产物覆盖同名映射', () => {
    const filenames = collectAttachmentFilenameById([
      makeMessage({
        id: 'user-1',
        blocks: [{
          index: 0,
          block_id: 'user-file',
          block: { type: 'file', file_id: 'shared-id', filename: '用户文件.xlsx' },
          finalized: true,
          partial: false,
        }] as never,
      }),
      makeMessage({
        id: 'assistant-1',
        role: 'assistant',
        blocks: [{
          index: 0,
          block_id: 'assistant-file',
          block: { type: 'file', file_id: 'shared-id', filename: 'Agent产物.xlsx' },
          finalized: true,
          partial: false,
        }] as never,
      }),
    ])

    expect(filenames.get('shared-id')).toBe('用户文件.xlsx')
  })

  it('把 filename 投影到 parse_document 工具行和文档摘录卡，但不修改原始 file_id', () => {
    const fileId = '4da336e0-a00d-4957-9eb4-8e64eaddbaf6'
    const filenames = new Map([[fileId, '测试word.docx']])
    const blocks = [
      {
        index: 0,
        block_id: 'tool-use',
        block: {
          type: 'tool_use',
          id: 'tool-1',
          name: 'parse_document',
          input: { file_id: fileId },
        },
        finalized: true,
        partial: false,
      },
      {
        index: 1,
        block_id: 'document-excerpt',
        block: {
          type: 'tabtin_rich_content',
          kind: 'document_excerpt',
          summary: '',
          payload: { file_id: fileId, parse_status: 'success' },
        },
        finalized: true,
        partial: false,
      },
    ] as never

    const projected = projectAttachmentBlocksForDisplay(blocks, filenames)

    expect((projected[0].block as { input: unknown }).input).toEqual({
      file_id: fileId,
      filename: '测试word.docx',
    })
    expect((projected[1].block as { payload: unknown }).payload).toMatchObject({
      file_id: fileId,
      filename: '测试word.docx',
    })
    expect((blocks[0].block as { input: unknown }).input).toEqual({ file_id: fileId })
    expect((blocks[1].block as { payload: unknown }).payload).not.toHaveProperty('filename')
  })
})
