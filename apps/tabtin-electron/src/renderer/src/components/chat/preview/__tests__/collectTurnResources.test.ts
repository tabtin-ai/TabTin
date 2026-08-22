import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import { collectTurnResources, locateResourceIndex } from '../collectTurnResources'

function makeMsg(overrides: Partial<ChatMessage>): ChatMessage {
  const base = {
    id: overrides.id ?? 'm-' + Math.random().toString(36).slice(2, 8),
    role: overrides.role ?? 'assistant',
    content: '',
    created_at: '2026-04-29T00:00:00Z',
    ...overrides,
  } as ChatMessage
  // ：资源派生读运行时 SSoT message.blocks（生产由入口反序列化灌入）。测试从
  // content_blocks_json 派生 finalized entries 模拟 ingress。
  if (base.blocks === undefined && Array.isArray(base.content_blocks_json)) {
    base.blocks = base.content_blocks_json.map((block, index) => ({
      index,
      block_id: `b-${base.id}-${index}`,
      block,
      finalized: true,
      partial: false,
    })) as never
  }
  return base
}

describe('collectTurnResources', () => {
  it('用户消息只返回自身附件中的可预览资源', () => {
    const userMsg = makeMsg({
      id: 'u1',
      role: 'user',
      attachments_json: [
        { type: 'image', filename: 'a.png', mime_type: 'image/png', size: 100, url: 'https://x/a.png' },
        { type: 'file',  filename: 'b.txt', mime_type: 'text/plain', size: 50, url: 'https://x/b.txt' },
      ],
    })
    const otherMsg = makeMsg({ id: 'a1', role: 'assistant', agent_run_id: 'run-1' })
    const res = collectTurnResources([userMsg, otherMsg], userMsg)
    expect(res).toHaveLength(2)
    expect(res[0]).toMatchObject({ kind: 'image', url: 'https://x/a.png', sourceMessageId: 'u1' })
    expect(res[1]).toMatchObject({ kind: 'txt', url: 'https://x/b.txt' })
  })

  it('用户附件按 mime/扩展名识别 txt / md / json', () => {
    const userMsg = makeMsg({
      id: 'u-text',
      role: 'user',
      attachments_json: [
        { type: 'file', filename: 'notes.txt', mime_type: 'text/plain', size: 10, url: 'https://x/notes.txt' },
        { type: 'file', filename: 'readme.md', mime_type: 'text/markdown', size: 20, url: 'https://x/readme.md' },
        { type: 'file', filename: 'data.json', mime_type: 'application/json', size: 30, url: 'https://x/data.json' },
        { type: 'file', filename: 'plan.markdown', mime_type: 'application/octet-stream', size: 40, url: 'https://x/plan.markdown' },
      ],
    })
    const res = collectTurnResources([userMsg], userMsg)
    expect(res.map(r => r.kind)).toEqual(['txt', 'md', 'json', 'md'])
  })

  it('#2595：type=video 附件即使 mime 推不出也归为 video', () => {
    const userMsg = makeMsg({
      id: 'u-vid',
      role: 'user',
      attachments_json: [
        { type: 'video', filename: 'clip.bin', mime_type: 'application/octet-stream', size: 10, url: 'https://x/clip.bin' },
      ],
    })
    const res = collectTurnResources([userMsg], userMsg)
    expect(res).toHaveLength(1)
    expect(res[0]).toMatchObject({ kind: 'video', url: 'https://x/clip.bin' })
  })

  it('#2595：video 块 Anthropic source.url 可聚合进预览', () => {
    const userMsg = makeMsg({
      id: 'u-vid-src',
      role: 'user',
      content_blocks_json: [
        { type: 'video', source: { type: 'url', url: 'https://cdn.example.com/a.mp4' } } as any,
      ],
    })
    const res = collectTurnResources([userMsg], userMsg)
    expect(res).toHaveLength(1)
    expect(res[0]).toMatchObject({ kind: 'video', url: 'https://cdn.example.com/a.mp4' })
  })

  it('助手消息按 agent_run_id 聚合多条助手消息的资源', () => {
    const a1 = makeMsg({
      id: 'a1', role: 'assistant', agent_run_id: 'run-1',
      content_blocks_json: [
        { type: 'image', url: 'https://x/1.png', filename: '1.png', mime_type: 'image/png' },
      ],
    })
    const a2 = makeMsg({
      id: 'a2', role: 'assistant', agent_run_id: 'run-1',
      content_blocks_json: [
        { type: 'rich_content', kind: 'image', url: 'https://x/2.png', summary: 'two' } as any,
      ],
    })
    const a3 = makeMsg({
      id: 'a3', role: 'assistant', agent_run_id: 'run-2',
      content_blocks_json: [
        { type: 'image', url: 'https://x/3.png', mime_type: 'image/png' },
      ],
    })
    const res = collectTurnResources([a1, a2, a3], a1)
    expect(res).toHaveLength(2)
    expect(res.map(r => r.url)).toEqual(['https://x/1.png', 'https://x/2.png'])
  })

  it('助手消息按 agent_run_id 聚合时不会带入混在中间的 user 消息资源', () => {
    const a1 = makeMsg({
      id: 'a1', role: 'assistant', agent_run_id: 'run-1',
      content_blocks_json: [{ type: 'image', url: 'https://x/a.png', mime_type: 'image/png' }],
    })
    const u1 = makeMsg({
      id: 'u1', role: 'user',
      attachments_json: [
        { type: 'image', filename: 'u.png', mime_type: 'image/png', size: 1, url: 'https://x/u.png' },
      ],
    })
    const a2 = makeMsg({
      id: 'a2', role: 'assistant', agent_run_id: 'run-1',
      content_blocks_json: [{ type: 'image', url: 'https://x/b.png', mime_type: 'image/png' }],
    })
    const res = collectTurnResources([a1, u1, a2], a1)
    expect(res.map(r => r.url)).toEqual(['https://x/a.png', 'https://x/b.png'])
  })

  it('助手消息无 agent_run_id 时仅聚合自身', () => {
    const a1 = makeMsg({
      id: 'a1', role: 'assistant',
      content_blocks_json: [
        { type: 'image', url: 'https://x/1.png', mime_type: 'image/png' },
        { type: 'image', url: 'https://x/2.png', mime_type: 'image/png' },
      ],
    })
    const a2 = makeMsg({
      id: 'a2', role: 'assistant',
      content_blocks_json: [{ type: 'image', url: 'https://x/3.png', mime_type: 'image/png' }],
    })
    const res = collectTurnResources([a1, a2], a1)
    expect(res.map(r => r.url)).toEqual(['https://x/1.png', 'https://x/2.png'])
  })

  it('依据 mime/扩展名推断 kind（pdf / video / audio / heic）', () => {
    const m = makeMsg({
      id: 'u1', role: 'user',
      attachments_json: [
        { type: 'file', filename: 'doc.pdf', mime_type: 'application/pdf', size: 1, url: 'https://x/doc.pdf' },
        { type: 'file', filename: 'clip.mp4', mime_type: '', size: 1, url: 'https://x/clip.mp4' },
        { type: 'file', filename: 'song', mime_type: 'audio/mpeg', size: 1, url: 'https://x/song' },
        { type: 'file', filename: 'photo.HEIC', mime_type: '', size: 1, url: 'https://x/photo.HEIC' },
      ],
    })
    const res = collectTurnResources([m], m)
    expect(res.map(r => r.kind)).toEqual(['pdf', 'video', 'audio', 'image'])
  })

  it('Office / CSV 文件 mime / 扩展名都能识别为 docx/xlsx/pptx/csv', () => {
    const m = makeMsg({
      id: 'u1', role: 'user',
      attachments_json: [
        { type: 'file', filename: 'a.docx',
          mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          size: 1, url: 'https://x/a.docx' },
        { type: 'file', filename: 'b.xlsx',
          mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          size: 1, url: 'https://x/b.xlsx' },
        { type: 'file', filename: 'c.pptx',
          mime_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          size: 1, url: 'https://x/c.pptx' },
        // 仅扩展名（OSS 常返 octet-stream）
        { type: 'file', filename: 'd.docx', mime_type: 'application/octet-stream',
          size: 1, url: 'https://x/d.docx?t=1' },
        { type: 'file', filename: 'e.csv', mime_type: 'text/csv',
          size: 1, url: 'https://x/e.csv' },
        { type: 'file', filename: 'f.csv', mime_type: 'application/octet-stream',
          size: 1, url: 'https://x/f.csv?download=1' },
      ],
    })
    const res = collectTurnResources([m], m)
    expect(res.map(r => r.kind)).toEqual(['docx', 'xlsx', 'pptx', 'docx', 'csv', 'csv'])
  })

  it('PreviewResource 携带 fileId（用于本地 buffer 缓存命中）', () => {
    const m = makeMsg({
      id: 'u1', role: 'user',
      attachments_json: [
        { type: 'image', filename: 'a.png', mime_type: 'image/png', size: 1, url: 'https://x/a.png', file_id: 'fid-1' },
      ],
    })
    const res = collectTurnResources([m], m)
    expect(res[0].fileId).toBe('fid-1')
  })

  it('忽略无 url 的 block / attachment', () => {
    const m = makeMsg({
      id: 'u1', role: 'user',
      attachments_json: [
        { type: 'image', filename: 'no-url.png', mime_type: 'image/png', size: 1 },
      ],
      content_blocks_json: [
        { type: 'image' } as any,
      ],
    })
    expect(collectTurnResources([m], m)).toHaveLength(0)
  })

  it('收集 show_widget 图示块（无 url，靠 code）', () => {
    const m = makeMsg({
      id: 'a1',
      role: 'assistant',
      agent_run_id: 'run-1',
      content_blocks_json: [{
        type: 'tabtin_rich_content',
        kind: 'widget',
        summary: '架构图',
        payload: {
          widget_id: 'w-1',
          format: 'svg',
          code: '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
          title: 'K8s 架构',
        },
      }],
    })
    const res = collectTurnResources([m], m)
    expect(res).toHaveLength(1)
    expect(res[0]).toMatchObject({
      id: 'a1:widget:w-1',
      kind: 'widget',
      name: 'K8s 架构',
      widgetId: 'w-1',
      format: 'svg',
      sourceMessageId: 'a1',
    })
    expect(res[0].code).toContain('<svg')
  })

  it('跳过 pending widget 占位', () => {
    const m = makeMsg({
      id: 'a1',
      role: 'assistant',
      content_blocks_json: [{
        type: 'tabtin_rich_content',
        kind: 'widget',
        summary: '生成中',
        payload: {
          widget_id: 'pending:tc-1',
          format: 'svg',
          code: '',
        },
      }],
    })
    expect(collectTurnResources([m], m)).toHaveLength(0)
  })
})

describe('locateResourceIndex', () => {
  const m = makeMsg({
    id: 'u1', role: 'user',
    attachments_json: [
      { type: 'image', filename: 'a.png', mime_type: 'image/png', size: 1, url: 'https://x/a.png' },
      { type: 'image', filename: 'b.png', mime_type: 'image/png', size: 1, url: 'https://x/b.png' },
    ],
  })
  const resources = collectTurnResources([m], m)

  it('按 url hint 命中', () => {
    expect(locateResourceIndex(resources, 'u1', { url: 'https://x/b.png' })).toBe(1)
  })

  it('按 messageId fallback 到首个', () => {
    expect(locateResourceIndex(resources, 'u1')).toBe(0)
  })

  it('找不到时返回 0', () => {
    expect(locateResourceIndex(resources, 'unknown')).toBe(0)
  })

  it('按 widget resourceId 命中', () => {
    const widgetMsg = makeMsg({
      id: 'a1',
      role: 'assistant',
      content_blocks_json: [{
        type: 'tabtin_rich_content',
        kind: 'widget',
        summary: '图',
        payload: {
          widget_id: 'w-9',
          format: 'svg',
          code: '<svg></svg>',
        },
      }],
    })
    const widgetRes = collectTurnResources([widgetMsg], widgetMsg)
    expect(locateResourceIndex(widgetRes, 'a1', { resourceId: 'a1:widget:w-9' })).toBe(0)
  })
})
