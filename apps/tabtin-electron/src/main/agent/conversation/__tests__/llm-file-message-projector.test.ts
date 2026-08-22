import type { Message } from '@tabtin/agent-runtime'
import { describe, expect, it } from 'vitest'
import { projectHistoricalFileBlocksAsResources } from '../llm-file-message-projector.js'

describe('projectHistoricalFileBlocksAsResources', () => {
  it('历史 ZIP 和图片都转成可访问资源引用', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          {
            type: 'file',
            file_id: 'file-1',
            filename: 'source.zip',
            mime_type: 'application/zip',
            url: 'https://cdn.example/source.zip',
          },
          {
            type: 'image',
            file_id: 'image-1',
            filename: 'image.png',
            mime_type: 'image/png',
            source: { type: 'url', url: 'https://cdn.example/image.png' },
          },
        ],
      },
      { role: 'assistant', content: '收到' },
      { role: 'user', content: '继续处理' },
    ]

    const projected = projectHistoricalFileBlocksAsResources(messages)

    expect(projected[0]?.content).toEqual([
      {
        type: 'text',
        text: [
          '[对话文件资源: source.zip (application/zip)]',
          '原始文件已上传；需要读取、解压或处理时，先调用 save_attachment(file_id=file-1) 保真保存到当前 Workspace。',
        ].join('\n'),
      },
      {
        type: 'text',
        text: [
          '[对话文件资源: image.png (image/png)]',
          '原始文件已上传；需要读取、解压或处理时，先调用 save_attachment(file_id=image-1) 保真保存到当前 Workspace。',
        ].join('\n'),
      },
    ])
  })

  it('当前轮和历史轮文档都只保留资源引用', () => {
    const historicalDocument = {
      type: 'document' as const,
      source: { type: 'url' as const, url: 'https://cdn.example/old.pdf' },
      file_id: 'old-file-id',
      title: 'old.pdf',
      mime_type: 'application/pdf',
    }
    const currentDocument = {
      type: 'document' as const,
      source: { type: 'url' as const, url: 'https://cdn.example/current.pdf' },
      file_id: 'current-file-id',
      title: 'current.pdf',
      mime_type: 'application/pdf',
    }
    const projected = projectHistoricalFileBlocksAsResources([
      { role: 'user', content: [historicalDocument] },
      { role: 'assistant', content: '收到' },
      { role: 'user', content: [currentDocument] },
    ])

    expect(projected[0]?.content).toEqual([{
      type: 'text',
      text: [
        '[对话文件资源: old.pdf (application/pdf)]',
        '原始文件已上传；需要读取、解压或处理时，先调用 save_attachment(file_id=old-file-id) 保真保存到当前 Workspace。',
      ].join('\n'),
    }])
    expect(projected[2]?.content).toEqual([{
      type: 'text',
      text: [
        '[对话文件资源: current.pdf (application/pdf)]',
        '原始文件已上传；需要读取、解压或处理时，先调用 save_attachment(file_id=current-file-id) 保真保存到当前 Workspace。',
      ].join('\n'),
    }])
  })
})
