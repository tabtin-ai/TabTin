import { describe, expect, it } from 'vitest'
import type { MessageAttachment, MessageBlock } from '@tabtin/chat-client'
import { deriveUserAttachments } from '../userMessageAttachments'

describe('deriveUserAttachments', () => {
  it('回灌态：从持久化 content_blocks_json 的 file 块还原附件卡片', () => {
    const blocks: MessageBlock[] = [
      { type: 'text', text: '请总结这个文件' },
      { type: 'file', file_id: 'file-1', filename: 'brief.pdf', mime_type: 'application/pdf', size: 1024 },
    ]

    expect(deriveUserAttachments([], blocks)).toEqual([
      {
        type: 'file',
        file_id: 'file-1',
        filename: 'brief.pdf',
        mime_type: 'application/pdf',
        size: 1024,
        url: undefined,
        preview_url: undefined,
      },
    ])
  })

  it('回灌态：image 块也还原为 image 附件', () => {
    const blocks: MessageBlock[] = [
      { type: 'image', file_id: 'img-1', filename: 'shot.png', mime_type: 'image/png', size: 2048, url: 'https://x/shot.png' },
    ]

    const result = deriveUserAttachments(undefined, blocks)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ type: 'image', file_id: 'img-1', url: 'https://x/shot.png' })
  })

  it('#5475 本地运行时 USER echo：Anthropic image source(url) 也还原为附件', () => {
    // engine/context/user-message.ts 构造的块是 { type:'image', source:{type:'url', url} }，
    // 无扁平 url/file_id——历史上被跳过导致切换/重启图片消失。
    const blocks = [
      { type: 'image', source: { type: 'url', url: 'http://127.0.0.1:6060/api/services/oss/local-object?object_key=chat%2Fa.png' } },
    ] as unknown as MessageBlock[]

    const result = deriveUserAttachments([], blocks)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      type: 'image',
      url: 'http://127.0.0.1:6060/api/services/oss/local-object?object_key=chat%2Fa.png',
    })
  })

  it('#2595：Anthropic video source(url) 还原为 video 附件（切会话缩略图）', () => {
    const blocks = [
      { type: 'video', source: { type: 'url', url: 'https://cdn.example.com/clip.mp4' } },
    ] as unknown as MessageBlock[]

    const result = deriveUserAttachments([], blocks)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      type: 'video',
      url: 'https://cdn.example.com/clip.mp4',
    })
  })

  it('#5475 Anthropic image source(base64) 还原为 data URL 附件', () => {
    const blocks = [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ] as unknown as MessageBlock[]

    const result = deriveUserAttachments([], blocks)
    expect(result).toHaveLength(1)
    expect(result[0]?.url).toBe('data:image/png;base64,AAAA')
    expect(result[0]?.mime_type).toBe('image/png')
  })

  it('乐观态：blocks 无 file 块时用 attachments_json 兜底', () => {
    const attachments: MessageAttachment[] = [
      { type: 'file', file_id: 'file-2', filename: 'draft.docx', mime_type: 'application/vnd', size: 512 },
    ]
    const blocks: MessageBlock[] = [{ type: 'text', text: '看看这个' }]

    expect(deriveUserAttachments(attachments, blocks)).toEqual(attachments)
  })

  it('实时态：同一 file_id 同时出现在 attachments_json 与 file 块时去重', () => {
    const attachments: MessageAttachment[] = [
      { type: 'file', file_id: 'dup-1', filename: 'a.pdf', mime_type: 'application/pdf', size: 10 },
    ]
    const blocks: MessageBlock[] = [
      { type: 'file', file_id: 'dup-1', filename: 'a.pdf', mime_type: 'application/pdf', size: 10 },
    ]

    const result = deriveUserAttachments(attachments, blocks)
    expect(result).toHaveLength(1)
    expect(result[0]?.file_id).toBe('dup-1')
  })

  it('#8525：本地 URL echo 与 DB file_id 同 URL 时升级保留 file_id（切会话换链）', () => {
    const url = 'https://oss.example.com/private/shot.png?sign=stale'
    const blocks = [
      { type: 'image', source: { type: 'url', url } },
      {
        type: 'image',
        file_id: 'img-private-1',
        filename: 'shot.png',
        mime_type: 'image/png',
        size: 2048,
        url,
      },
    ] as unknown as MessageBlock[]

    const result = deriveUserAttachments([], blocks)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      type: 'image',
      file_id: 'img-private-1',
      url,
      filename: 'shot.png',
      size: 2048,
    })
  })

  it('#8525：transcript 顶层 file_id + source.url 直接投影可换链附件', () => {
    const blocks = [
      {
        type: 'image',
        file_id: 'img-2',
        filename: 'a.png',
        mime_type: 'image/png',
        source: { type: 'url', url: 'https://oss.example.com/a.png' },
      },
    ] as unknown as MessageBlock[]

    const result = deriveUserAttachments([], blocks)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      type: 'image',
      file_id: 'img-2',
      url: 'https://oss.example.com/a.png',
    })
  })

  it('无 file_id 也无 url 的块跳过（无法形成可用卡片）', () => {
    const blocks: MessageBlock[] = [
      { type: 'file', filename: '损坏' },
      { type: 'text', text: 'x' },
    ]

    expect(deriveUserAttachments([], blocks)).toEqual([])
  })

  it('纯文本消息不产生附件', () => {
    expect(deriveUserAttachments(undefined, [{ type: 'text', text: 'hi' }])).toEqual([])
  })

  it('#6945：DocumentBlock（runtime echo）回灌为 file 附件卡片', () => {
    const blocks = [
      {
        type: 'document',
        title: 'brief.pdf',
        mime_type: 'application/pdf',
        source: { type: 'url', url: 'https://cdn.example.com/brief.pdf' },
      },
    ] as unknown as MessageBlock[]

    const result = deriveUserAttachments([], blocks)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      type: 'file',
      filename: 'brief.pdf',
      mime_type: 'application/pdf',
      url: 'https://cdn.example.com/brief.pdf',
    })
  })

  it('#7309：DocumentBlock + FileBlock 叠显时只保留有 size 的 FileBlock', () => {
    const url = 'https://cdn.example.com/sheet.xlsx'
    const blocks = [
      {
        type: 'document',
        title: 'sheet.xlsx',
        mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        source: { type: 'url', url },
      },
      {
        type: 'file',
        file_id: 'fid-1',
        filename: 'sheet.xlsx',
        mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        size: 5400,
        url,
      },
    ] as unknown as MessageBlock[]

    const result = deriveUserAttachments([], blocks)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      type: 'file',
      file_id: 'fid-1',
      filename: 'sheet.xlsx',
      size: 5400,
      url,
    })
  })

  it('#7309：同 filename 但 url 不同时不去重（避免误吞另一份文件）', () => {
    const blocks = [
      {
        type: 'document',
        title: 'sheet.xlsx',
        source: { type: 'url', url: 'https://cdn.example.com/a.xlsx' },
      },
      {
        type: 'file',
        file_id: 'fid-2',
        filename: 'sheet.xlsx',
        size: 1200,
        url: 'https://cdn.example.com/b.xlsx',
      },
    ] as unknown as MessageBlock[]

    const result = deriveUserAttachments([], blocks)
    expect(result).toHaveLength(2)
    expect(result.map(a => a.url).sort()).toEqual([
      'https://cdn.example.com/a.xlsx',
      'https://cdn.example.com/b.xlsx',
    ].sort())
  })

  it('#8096：云盘 ContextRef（file_id + preview）不投影为「附件 0 B」', () => {
    const blocks = [
      {
        type: 'file',
        file_id: '0ba8b5e3-9ea6-4939-8a25-2a508000ccc1',
        preview: 'IMG_8380.PNG',
        tab_type: 'file',
      },
    ] as unknown as MessageBlock[]

    expect(deriveUserAttachments([], blocks)).toEqual([])
  })

  it('#8096：真附件（filename + size）仍投影为附件卡', () => {
    const blocks: MessageBlock[] = [
      {
        type: 'file',
        file_id: 'f-att',
        filename: 'a.png',
        mime_type: 'image/png',
        size: 140,
        url: 'https://cdn.example.com/a.png',
      },
    ]

    expect(deriveUserAttachments([], blocks)).toEqual([
      {
        type: 'file',
        file_id: 'f-att',
        filename: 'a.png',
        mime_type: 'image/png',
        size: 140,
        url: 'https://cdn.example.com/a.png',
        preview_url: undefined,
      },
    ])
  })
})
