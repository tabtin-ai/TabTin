import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import type { ContentBlockEntry } from '@stores/useChatRuntimeStore'
import { reconcileServerMessageBlocks } from '@/stores/chat/domain/blockMergePolicy'

function entry(index: number, arrivalSeq: number, text: string): ContentBlockEntry {
  return {
    index,
    block_id: `blk-${index}`,
    block: { type: 'text', text, arrival_seq: arrivalSeq } as unknown as ContentBlockEntry['block'],
    finalized: false,
    partial: false,
  }
}

function toolUseEntry(index: number, arrivalSeq: number, id: string, todos: Array<{ id: string; status: string }>): ContentBlockEntry {
  return {
    index,
    block_id: id,
    block: { type: 'tool_use', id, name: 'todo', input: { merge: true, todos }, arrival_seq: arrivalSeq } as unknown as ContentBlockEntry['block'],
    finalized: true,
    partial: false,
  }
}

function assistant(overrides: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    created_at: new Date().toISOString(),
    ...overrides,
  } as ChatMessage
}

describe('reconcileServerMessageBlocks —— 有 live 只补缺，无整消息级判断', () => {
  it('本地有 live 无键文字 + 服务端更旧无键文字 → 不替换 live', () => {
    const live = [entry(0, 200, 'thinking full')]
    const local = assistant({ id: 'm1', blocks: live })
    const server = assistant({
      id: 'm1',
      content_blocks_json: [{ type: 'text', text: 'half', arrival_seq: 100 }] as unknown as ChatMessage['content_blocks_json'],
    })
    const result = reconcileServerMessageBlocks(local, server)
    expect(result.blocks).toHaveLength(1)
    expect((result.blocks![0].block as { text?: string }).text).toBe('thinking full')
    expect((result.content_blocks_json as { text?: string }[])[0].text).toBe('thinking full')
  })

  it('本地无 live 块（reload / evict 后）→ 块字段用服务端补缺，壳 id 仍留本地', () => {
    const local = assistant({ id: 'm1', content: '' })
    const server = assistant({
      id: 'server-uuid',
      content: 'hist',
      content_blocks_json: [{ type: 'text', text: 'hist', arrival_seq: 42 }] as unknown as ChatMessage['content_blocks_json'],
    })
    const result = reconcileServerMessageBlocks(local, server)
    expect(result.id).toBe('m1')
    expect(result.content).toBe('hist')
    expect((result.metadata as { message_id?: string })?.message_id).toBe('server-uuid')
    // 冷合并只补 json；runtime blocks 由 store 入口 hydrate
    expect(result.blocks).toBeUndefined()
    expect((result.content_blocks_json as { text?: string }[])[0].text).toBe('hist')
  })

  it('无 live：服务端块无 seq、本地 json 同 key 有 seq → 采用服务端内容并保住 seq', () => {
    const local = assistant({
      id: 'm1',
      content_blocks_json: [
        {
          type: 'tool_use',
          id: 'tu_todo_1',
          name: 'todo',
          input: { action: 'open', items: [{ id: '1', status: 'in_progress' }] },
          arrival_seq: 100,
        },
      ] as unknown as ChatMessage['content_blocks_json'],
    })
    const server = assistant({
      id: 'server-uuid',
      content: 'server body',
      content_blocks_json: [
        {
          type: 'tool_use',
          id: 'tu_todo_1',
          name: 'todo',
          input: {
            action: 'open',
            items: [
              { id: '1', status: 'completed' },
              { id: '2', status: 'completed' },
            ],
          },
          // 故意无 arrival_seq
        },
      ] as unknown as ChatMessage['content_blocks_json'],
    })
    const result = reconcileServerMessageBlocks(local, server)
    expect(result.blocks).toBeUndefined()
    const block = (result.content_blocks_json as Array<{
      arrival_seq?: number
      input?: { items?: unknown[] }
    }>)[0]
    expect(block.arrival_seq).toBe(100)
    expect(block.input?.items).toHaveLength(2)
  })

  it('有 live 时壳以 local 为准：server content/id 不得覆盖', () => {
    const live = [entry(0, 200, 'thinking full')]
    const local = assistant({
      id: 'local-abc-1',
      content: 'live body',
      blocks: live,
      metadata: { client_event_id: 'local-abc-1' },
    })
    const server = assistant({
      id: 'server-uuid-2',
      content: 'half',
      client_event_id: 'local-abc-1',
      content_blocks_json: [{ type: 'text', text: 'half', arrival_seq: 100 }] as unknown as ChatMessage['content_blocks_json'],
    })
    const result = reconcileServerMessageBlocks(local, server)
    expect(result.id).toBe('local-abc-1')
    expect(result.content).toBe('live body')
    expect((result.metadata as { message_id?: string })?.message_id).toBe('server-uuid-2')
    expect((result.blocks![0].block as { text?: string }).text).toBe('thinking full')
  })

  it('live 只有工具块、无无键块 → 补齐服务端文字（补缺）', () => {
    const live = [toolUseEntry(0, 50, 'todo_write_1', [{ id: '1', status: 'completed' }])]
    const local = assistant({ id: 'm1', blocks: live })
    const server = assistant({
      id: 'm1',
      content_blocks_json: [
        { type: 'text', text: 'complete', arrival_seq: 300 },
      ] as unknown as ChatMessage['content_blocks_json'],
    })
    const result = reconcileServerMessageBlocks(local, server)
    expect(result.blocks).toHaveLength(2)
    expect(result.blocks!.some((e) => (e.block as { type?: string }).type === 'tool_use')).toBe(true)
    expect((result.blocks!.find((e) => (e.block as { type?: string }).type === 'text')!.block as { text?: string }).text).toBe('complete')
    expect(result).not.toBe(server)
  })

  it('live 与服务端同长无键文字 → 仍留 live，不整段换成服务端', () => {
    // 码点等长时不升级（ 要求严格大于）；避免服务端同长异文误盖 live。
    const live = [entry(0, 300, 'done')]
    const local = assistant({ id: 'm1', blocks: live })
    const server = assistant({
      id: 'm1',
      content_blocks_json: [{ type: 'text', text: 'donx', arrival_seq: 300 }] as unknown as ChatMessage['content_blocks_json'],
    })
    const result = reconcileServerMessageBlocks(local, server)
    expect((result.blocks![0].block as { text?: string }).text).toBe('done')
  })

  it('服务端无 content_blocks_json（流式中途快照空）→ 保留 live', () => {
    const live = [entry(0, 10, 'streaming')]
    const local = assistant({ id: 'm1', blocks: live })
    const server = assistant({ id: 'm1' })
    const result = reconcileServerMessageBlocks(local, server)
    expect(result.blocks).toHaveLength(1)
    expect((result.blocks![0].block as { text?: string }).text).toBe('streaming')
  })

  // ：live 短无键 text 不得挡住服务端全文；壳 content 仍可保持摘要。
  it('#7794 live 短无键 text + 服务端长文 → 用服务端无键块，保留 live 工具块', () => {
    const shortLive = '摘要前缀'.repeat(20) // 远短于全文
    const fullServer = `${shortLive}${'续写段落。'.repeat(30)}结尾`
    const live = [
      toolUseEntry(0, 50, 'todo_write_1', [{ id: '1', status: 'completed' }]),
      entry(1, 100, shortLive),
    ]
    const local = assistant({
      id: 'm1',
      content: Array.from(fullServer).slice(0, 200).join(''),
      blocks: live,
    })
    const server = assistant({
      id: 'm1',
      content: Array.from(fullServer).slice(0, 200).join(''),
      content_blocks_json: [
        {
          type: 'tool_use',
          id: 'todo_write_1',
          name: 'todo',
          input: { merge: true, todos: [{ id: '1', status: 'completed' }] },
          arrival_seq: 50,
        },
        { type: 'text', text: fullServer, arrival_seq: 100 },
      ] as unknown as ChatMessage['content_blocks_json'],
    })
    const result = reconcileServerMessageBlocks(local, server)
    expect(result.blocks).toHaveLength(2)
    const tool = result.blocks!.find((e) => (e.block as { type?: string }).type === 'tool_use')
    expect((tool!.block as { id?: string }).id).toBe('todo_write_1')
    const text = result.blocks!.find((e) => (e.block as { type?: string }).type === 'text')
    expect((text!.block as { text?: string }).text).toBe(fullServer)
    expect(Array.from((text!.block as { text: string }).text).length).toBeGreaterThan(200)
    // 壳 content 不强制升全文（会话列表仍对齐 text_summary）
    expect(Array.from(result.content).length).toBeLessThanOrEqual(200)
  })
})

describe('reconcileServerMessageBlocks —— 块级归并保住 live 独有工具块', () => {
  it('服务端更新但缺 live 已完成的 todo（tool_use）→ 归并保住完成态，不打回未完成', () => {
    const live = [toolUseEntry(0, 100, 'todo_write_3', [{ id: '1', status: 'completed' }])]
    const local = assistant({ id: 'm1', blocks: live })
    const server = assistant({
      id: 'm1',
      content_blocks_json: [
        { type: 'text', text: 'later reply', arrival_seq: 300 },
      ] as unknown as ChatMessage['content_blocks_json'],
    })
    const result = reconcileServerMessageBlocks(local, server)
    expect(result.blocks).toHaveLength(2)
    const kinds = result.blocks!.map((e) => (e.block as { type?: string; id?: string }))
    expect(kinds[0].type).toBe('tool_use')
    expect(kinds[0].id).toBe('todo_write_3')
    expect(kinds[1].type).toBe('text')
    expect(result.content_blocks_json).toHaveLength(2)
  })

  it('服务端更新且同 id todo 块 seq 更高 → 同 key 仍留 live，只补无键文字（禁止整块替换）', () => {
    const live = [toolUseEntry(0, 100, 'todo_write_3', [{ id: '1', status: 'completed' }])]
    const local = assistant({ id: 'm1', blocks: live })
    const server = assistant({
      id: 'm1',
      content_blocks_json: [
        { type: 'tool_use', id: 'todo_write_3', name: 'todo', input: { action: 'open', items: [{ id: '1', status: 'completed' }] }, arrival_seq: 300 },
        { type: 'text', text: 'later', arrival_seq: 301 },
      ] as unknown as ChatMessage['content_blocks_json'],
    })
    const result = reconcileServerMessageBlocks(local, server)
    expect(result.blocks).toHaveLength(2)
    expect(result).not.toBe(server)
    const tool = result.blocks!.find((e) => (e.block as { type?: string }).type === 'tool_use')
    expect((tool!.block as { arrival_seq?: number }).arrival_seq).toBe(100)
    expect((result.blocks!.find((e) => (e.block as { type?: string }).type === 'text')!.block as { text?: string }).text).toBe('later')
  })

  it('同 id：服务端 pending(低 seq)+更高 seq 文字，live completed → 保住 completed', () => {
    const live = [toolUseEntry(0, 200, 'todo_write_3', [{ id: '1', status: 'completed' }])]
    const local = assistant({ id: 'm1', blocks: live })
    const server = assistant({
      id: 'm1',
      content_blocks_json: [
        {
          type: 'tool_use',
          id: 'todo_write_3',
          name: 'todo',
          input: { action: 'open', items: [{ id: '1', status: 'pending' }] },
          arrival_seq: 100,
        },
        { type: 'text', text: 'later reply', arrival_seq: 300 },
      ] as unknown as ChatMessage['content_blocks_json'],
    })
    const result = reconcileServerMessageBlocks(local, server)
    expect(result.blocks).toHaveLength(2)
    const tool = result.blocks!.find((e) => (e.block as { type?: string }).type === 'tool_use')
    const input = (tool!.block as { input?: { todos?: Array<{ status: string }> } }).input
    expect(input?.todos?.[0]?.status).toBe('completed')
    expect((tool!.block as { arrival_seq?: number }).arrival_seq).toBe(200)
    expect((result.blocks!.find((e) => (e.block as { type?: string }).type === 'text')!.block as { text?: string }).text).toBe('later reply')
  })

  it('同 id：服务端 pending(更高 seq)+更高 seq 文字 → 不得打回 live completed', () => {
    const live = [toolUseEntry(0, 200, 'todo_write_3', [{ id: '1', status: 'completed' }])]
    const local = assistant({ id: 'm1', blocks: live })
    const server = assistant({
      id: 'm1',
      content_blocks_json: [
        {
          type: 'tool_use',
          id: 'todo_write_3',
          name: 'todo',
          input: { action: 'open', items: [{ id: '1', status: 'pending' }] },
          arrival_seq: 250,
        },
        { type: 'text', text: 'later reply', arrival_seq: 300 },
      ] as unknown as ChatMessage['content_blocks_json'],
    })
    const result = reconcileServerMessageBlocks(local, server)
    const tool = result.blocks!.find((e) => (e.block as { type?: string }).type === 'tool_use')
    const input = (tool!.block as { input?: { todos?: Array<{ status: string }> } }).input
    expect(input?.todos?.[0]?.status).toBe('completed')
    expect((tool!.block as { arrival_seq?: number }).arrival_seq).toBe(200)
  })
})
