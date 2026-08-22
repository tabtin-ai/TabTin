import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import { mergeAuthoritativeServerReplace, mergeMessagesFromServer } from '@/stores/chat/domain/messageSyncAction'

function msg(overrides: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    role: 'user',
    content: 'hello',
    created_at: new Date().toISOString(),
    ...overrides,
  } as ChatMessage
}

describe('mergeMessagesFromServer', () => {
  it('服务端 system 注入角色覆盖实时态遗留的 user 壳', () => {
    const local = msg({
      id: 'env-1',
      role: 'user',
      message_kind: 'environment_context',
    })
    const server = msg({
      id: 'env-1',
      role: 'system',
      message_kind: 'environment_context',
    })

    const result = mergeMessagesFromServer([local], [server])

    expect(result.messages[0].role).toBe('system')
  })

  it('returns unchanged when fresh is empty', () => {
    const existing = [msg({ id: 'a' })]
    const result = mergeMessagesFromServer(existing, [])
    expect(result.changed).toBe(false)
    expect(result.messages).toBe(existing)
  })

  it('replaces existing assistant message by id', () => {
    const existing = [msg({ id: 'a', role: 'assistant', content: 'old' })]
    const fresh = [msg({ id: 'a', role: 'assistant', content: 'new' })]
    const result = mergeMessagesFromServer(existing, fresh)
    expect(result.changed).toBe(true)
    expect(result.messages[0].content).toBe('new')
  })

  it('appends truly new messages', () => {
    const existing = [msg({ id: 'a' })]
    const fresh = [msg({ id: 'b', content: 'new msg', role: 'assistant' })]
    const result = mergeMessagesFromServer(existing, fresh)
    expect(result.messages).toHaveLength(2)
    expect(result.newCount).toBe(1)
  })

  it('preserves system_prompt_context kind from server sync', () => {
    const fresh = [
      msg({
        id: 'system-prompt-1',
        role: 'user',
        message_kind: 'system_prompt_context',
        content: '<identity>\nSECRET SYSTEM PROMPT SHOULD NOT RENDER\n</identity>',
        metadata: { source: 'system_prompt' },
      }),
    ]

    const result = mergeMessagesFromServer([], fresh)

    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].message_kind).toBe('system_prompt_context')
    expect(result.messages[0].metadata).toMatchObject({ source: 'system_prompt' })
  })

  it('单一身份收口：server user id == 本地乐观 id → 按 id 缝合、不双条', () => {
    // 收口后乐观 user 的 store id 从创建起就是 client_message_id（= 服务端落库 id），
    // server 回灌那条 id 与本地一致，直接在 existingIds 命中、按 id 就地更新，
    // 不再需要 temp- 前缀 + content/时间窗的模糊去重降级。
    const cid = 'cid-unified-1'
    const local = msg({
      id: cid,
      content: 'hello world',
      created_at: new Date().toISOString(),
      metadata: { client_message_id: cid },
    })
    ;(local as Record<string, unknown>).sendStatus = 'sending'
    const server = msg({
      id: cid,
      content: 'hello world',
      created_at: new Date().toISOString(),
      metadata: { client_event_id: cid, client_message_id: cid },
    })

    const result = mergeMessagesFromServer([local], [server])
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].id).toBe(cid)
    expect(result.newCount).toBe(0)
  })

  it('preserves the local sent status when server sync replaces a user message', () => {
    const now = new Date()
    const local = msg({
      id: 'server-user-1',
      created_at: now.toISOString(),
      metadata: { client_message_id: 'client-1' },
    })
    ;(local as Record<string, unknown>).sendStatus = 'sent'
    const server = msg({
      id: 'server-user-1',
      created_at: now.toISOString(),
      metadata: { client_message_id: 'client-1' },
    })

    const result = mergeMessagesFromServer([local], [server])

    expect((result.messages[0] as Record<string, unknown>).sendStatus).toBe('sent')
  })

  it('#2595：server 缺 video 块时用本地 attachments_json 补进 content_blocks_json', () => {
    const now = new Date().toISOString()
    const local = msg({
      id: 'user-vid-1',
      content: '这个视频里是什么',
      created_at: now,
      content_blocks_json: [{ type: 'text', text: '这个视频里是什么' }],
      attachments_json: [{
        type: 'video',
        file_id: 'f-vid',
        filename: 'clip.mp4',
        mime_type: 'video/mp4',
        size: 2048,
        url: 'https://cdn.example.com/clip.mp4',
      }],
      metadata: { client_message_id: 'user-vid-1' },
    })
    const server = msg({
      id: 'user-vid-1',
      content: '这个视频里是什么',
      created_at: now,
      content_blocks_json: [{ type: 'text', text: '这个视频里是什么' }],
      attachments_json: [],
      metadata: { client_message_id: 'user-vid-1' },
    })

    const result = mergeMessagesFromServer([local], [server])
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].content_blocks_json).toEqual([
      { type: 'text', text: '这个视频里是什么' },
      {
        type: 'video',
        file_id: 'f-vid',
        filename: 'clip.mp4',
        mime_type: 'video/mp4',
        size: 2048,
        url: 'https://cdn.example.com/clip.mp4',
        preview_url: undefined,
      },
    ])
  })

  it('does not deduplicate when time window exceeds 5s', () => {
    const now = new Date()
    const tempMsg = msg({
      id: 'temp-user-123',
      content: 'hello',
      created_at: now.toISOString(),
    })
    ;(tempMsg as Record<string, unknown>).sendStatus = 'failed'

    const serverMsg = msg({
      id: 'server-uuid-456',
      content: 'hello',
      created_at: new Date(now.getTime() + 10_000).toISOString(),
    })

    const result = mergeMessagesFromServer([tempMsg], [serverMsg])
    expect(result.messages).toHaveLength(2)
  })

  it('does not deduplicate when content differs', () => {
    const now = new Date()
    const tempMsg = msg({
      id: 'temp-user-123',
      content: 'message A',
      created_at: now.toISOString(),
    })
    ;(tempMsg as Record<string, unknown>).sendStatus = 'failed'

    const serverMsg = msg({
      id: 'server-uuid-456',
      content: 'completely different message',
      created_at: now.toISOString(),
    })

    const result = mergeMessagesFromServer([tempMsg], [serverMsg])
    expect(result.messages).toHaveLength(2)
  })

  it('does not deduplicate non-temp messages', () => {
    const now = new Date()
    const existing = [msg({ id: 'real-id-1', content: 'hello', created_at: now.toISOString() })]
    const fresh = [msg({ id: 'real-id-2', content: 'hello', created_at: now.toISOString() })]

    const result = mergeMessagesFromServer(existing, fresh)
    expect(result.messages).toHaveLength(2)
  })

  it('protects failed user messages from being overwritten by server', () => {
    const failedMsg = msg({ id: 'temp-user-1', content: 'hello' })
    ;(failedMsg as Record<string, unknown>).sendStatus = 'failed'

    const result = mergeMessagesFromServer(
      [failedMsg],
      [msg({ id: 'temp-user-1', content: 'server version' })],
    )
    expect(result.messages[0].content).toBe('hello')
  })

  it('单一身份收口：同文案连发两条(不同 client_message_id)不被误合并', () => {
    // 删除 content+时间窗模糊去重的关键收益：两条内容相同但身份不同的 user 消息
    // 不再被误判为「同一条」而吞掉一条。
    const now = new Date()
    const first = msg({
      id: 'cid-dup-1',
      content: '再来一次',
      created_at: now.toISOString(),
      metadata: { client_message_id: 'cid-dup-1' },
    })
    ;(first as Record<string, unknown>).sendStatus = 'sent'
    const secondServer = msg({
      id: 'cid-dup-2',
      content: '再来一次',
      created_at: new Date(now.getTime() + 500).toISOString(),
      metadata: { client_event_id: 'cid-dup-2', client_message_id: 'cid-dup-2' },
    })

    const result = mergeMessagesFromServer([first], [secondServer])
    expect(result.messages).toHaveLength(2)
  })

  it('deduplicates by client_message_id (exact match)', () => {
    const cid = 'cid-abc-123'
    const tempMsg = msg({
      id: 'temp-user-999',
      content: 'hello',
      created_at: new Date().toISOString(),
      metadata: { client_message_id: cid },
    })

    const serverMsg = msg({
      id: 'server-uuid-777',
      content: 'hello',
      created_at: new Date(Date.now() + 8000).toISOString(),
      metadata: { client_message_id: cid },
    })

    const result = mergeMessagesFromServer([tempMsg], [serverMsg])
    expect(result.messages).toHaveLength(1)
    // 壳以 local 为准：id 不换成 server UUID，只 link 进 metadata
    expect(result.messages[0].id).toBe('temp-user-999')
    expect((result.messages[0].metadata as { message_id?: string })?.message_id).toBe('server-uuid-777')
    expect(result.newCount).toBe(0)
  })

  it('deduplicates by client_event_id (cross-device observed user)', () => {
    const cid = 'cid-observed-user'
    const observed = msg({
      id: cid,
      content: 'from mobile',
      created_at: '2026-06-25T08:00:01.000Z',
      metadata: { client_event_id: cid },
    })

    const serverMsg = msg({
      id: 'server-observed-user',
      content: 'from mobile',
      created_at: '2026-06-25T08:00:02.000Z',
      metadata: { client_event_id: cid },
    })

    const result = mergeMessagesFromServer([observed], [serverMsg])
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].id).toBe(cid)
    expect((result.messages[0].metadata as { message_id?: string })?.message_id).toBe('server-observed-user')
    expect(result.newCount).toBe(0)
  })

  it('client_message_id match takes priority over time window fallback', () => {
    const now = new Date()
    const cid = 'cid-priority-test'
    const tempMsg = msg({
      id: 'temp-user-1',
      content: 'same content',
      created_at: now.toISOString(),
      metadata: { client_message_id: cid },
    })

    const serverMsgMatching = msg({
      id: 'server-matching',
      content: 'same content',
      created_at: new Date(now.getTime() + 7000).toISOString(),
      metadata: { client_message_id: cid },
    })

    const result = mergeMessagesFromServer([tempMsg], [serverMsgMatching])
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].id).toBe('temp-user-1')
    expect((result.messages[0].metadata as { message_id?: string })?.message_id).toBe('server-matching')
  })

  it('单一身份收口：无 client id 的不同 id user 不再模糊合并', () => {
    // 收口后统一按稳定身份（id / client id）缝合；两条无 client 身份、id 不同的
    // user 各自保留，不再靠 content+时间窗模糊合并（那会误杀同文案连发）。
    const now = new Date()
    const localNoCid = msg({
      id: 'legacy-local-1',
      content: 'no cid message',
      created_at: now.toISOString(),
    })
    const serverNoCid = msg({
      id: 'server-no-cid',
      content: 'no cid message',
      created_at: new Date(now.getTime() + 1000).toISOString(),
    })

    const result = mergeMessagesFromServer([localNoCid], [serverNoCid])
    expect(result.messages).toHaveLength(2)
  })

  it('temp-user 合并时保留比 text_summary 更长的本地正文（防 200 字截断）', () => {
    const now = new Date()
    const fullPrompt = '帮我做一份 TabTin 产品介绍包。' + 'x'.repeat(400)
    const truncatedSummary = fullPrompt.slice(0, 200)
    const tempMsg = msg({
      id: 'temp-user-long',
      content: fullPrompt,
      created_at: now.toISOString(),
      metadata: { client_message_id: 'cid-long-prompt' },
    })

    const serverMsg = msg({
      id: 'server-long',
      content: truncatedSummary,
      created_at: now.toISOString(),
      metadata: { client_message_id: 'cid-long-prompt' },
    })

    const result = mergeMessagesFromServer([tempMsg], [serverMsg])
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].content).toBe(fullPrompt)
    expect(result.messages[0].content!.length).toBeGreaterThan(200)
  })

  it('#8294 本地流式完整 Tracker 模板、服务端 display_message 纯指令 → 气泡取服务端', () => {
    const now = new Date()
    const instruction = 'test'
    const templatedPrompt = [
      '## 任务',
      instruction,
      '',
      '请独立完成以上任务并汇报结果。如有合适的 Skill 可用，可自行搜索并调用（skills_search / skills_read）。',
    ].join('\n')
    const local = msg({
      id: '8754c606-7422-403c-977c-542e1ed5c79a',
      content: templatedPrompt,
      content_blocks_json: [{ type: 'text', text: templatedPrompt }],
      created_at: now.toISOString(),
    } as ChatMessage)
    const server = msg({
      id: '8754c606-7422-403c-977c-542e1ed5c79a',
      content: instruction,
      content_blocks_json: [{ type: 'text', text: instruction }],
      created_at: now.toISOString(),
    } as ChatMessage)

    const result = mergeMessagesFromServer([local], [server])
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].content).toBe(instruction)
    expect(result.messages[0].content_blocks_json).toEqual([{ type: 'text', text: instruction }])
  })

  it('服务端 content_blocks_json 含全文时优先用 blocks 正文', () => {
    const now = new Date()
    const fullText = '④ 最后给我一份「介绍包总览」完整说明。' + 'y'.repeat(300)
    const tempMsg = msg({
      id: 'temp-user-blocks',
      content: fullText.slice(0, 200),
      created_at: now.toISOString(),
      metadata: { client_message_id: 'cid-blocks' },
    })

    const serverMsg = msg({
      id: 'server-blocks',
      content: fullText.slice(0, 200),
      content_blocks_json: [{ type: 'text', text: fullText }],
      created_at: now.toISOString(),
      metadata: { client_message_id: 'cid-blocks' },
    } as ChatMessage)

    const result = mergeMessagesFromServer([tempMsg], [serverMsg])
    expect(result.messages[0].content).toBe(fullText)
  })

  it('同 id user 回灌为空正文且仅有 file block 时保留本地正文', () => {
    const now = new Date()
    const localMsg = msg({
      id: 'server-user-with-file',
      content: '请总结这个文件',
      created_at: now.toISOString(),
    })

    const serverMsg = msg({
      id: 'server-user-with-file',
      content: '',
      content_blocks_json: [{ type: 'file', file_id: 'file-1', filename: 'brief.pdf' }],
      created_at: now.toISOString(),
    } as ChatMessage)

    const result = mergeMessagesFromServer([localMsg], [serverMsg])
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].content).toBe('请总结这个文件')
    expect(result.messages[0].content_blocks_json).toEqual([
      { type: 'file', file_id: 'file-1', filename: 'brief.pdf' },
    ])
  })

  it('同 id user 回灌含 blocks 全文时采用服务端完整正文', () => {
    const now = new Date()
    const fullText = '服务端 blocks 里的完整正文' + 'z'.repeat(240)
    const localMsg = msg({
      id: 'server-user-full-blocks',
      content: '本地短正文',
      created_at: now.toISOString(),
    })

    const serverMsg = msg({
      id: 'server-user-full-blocks',
      content: fullText.slice(0, 200),
      content_blocks_json: [
        { type: 'text', text: fullText },
        { type: 'file', file_id: 'file-2', filename: 'full.pdf' },
      ],
      created_at: now.toISOString(),
    } as ChatMessage)

    const result = mergeMessagesFromServer([localMsg], [serverMsg])
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].content).toBe(fullText)
    expect(result.messages[0].content_blocks_json).toEqual([
      { type: 'text', text: fullText },
      { type: 'file', file_id: 'file-2', filename: 'full.pdf' },
    ])
  })

  it('does not match when client_message_ids differ', () => {
    const now = new Date()
    const tempMsg = msg({
      id: 'temp-user-diff-cid',
      content: 'same content',
      created_at: now.toISOString(),
      metadata: { client_message_id: 'cid-aaa' },
    })

    const serverMsg = msg({
      id: 'server-diff-cid',
      content: 'same content but different cid',
      created_at: new Date(now.getTime() + 8000).toISOString(),
      metadata: { client_message_id: 'cid-bbb' },
    })

    const result = mergeMessagesFromServer([tempMsg], [serverMsg])
    expect(result.messages).toHaveLength(2)
  })

  it('latest page upsert keeps earlier loaded history when current list is longer than server page', () => {
    const existing = [
      msg({ id: 'old-1', content: 'old', created_at: '2026-06-25T08:00:00.000Z' }),
      msg({ id: 'server-1', content: 'old server', created_at: '2026-06-25T08:01:00.000Z' }),
      msg({ id: 'local-tail', role: 'assistant', content: 'tail', created_at: '2026-06-25T08:02:00.000Z' }),
    ]
    const fresh = [
      msg({ id: 'server-1', content: 'fresh server', created_at: '2026-06-25T08:01:00.000Z' }),
      msg({ id: 'server-2', role: 'assistant', content: 'new server', created_at: '2026-06-25T08:03:00.000Z' }),
    ]

    const result = mergeMessagesFromServer(existing, fresh)
    expect(result.messages.map(m => m.id)).toEqual(['old-1', 'server-1', 'local-tail', 'server-2'])
    expect(result.messages.find(m => m.id === 'server-1')?.content).toBe('fresh server')
  })

  it('latest page does not wipe local tail when server page is stale with the same item count', () => {
    const existing = [
      msg({ id: 'server-1', content: 'server 1', created_at: '2026-06-25T08:01:00.000Z' }),
      msg({ id: 'live-ai', role: 'assistant', content: '刚刚实时看到的 AI 回复', created_at: '2026-06-25T08:05:00.000Z' }),
    ]
    const staleFresh = [
      msg({ id: 'server-0', content: 'server 0', created_at: '2026-06-25T08:00:00.000Z' }),
      msg({ id: 'server-1', content: 'server 1 fresh', created_at: '2026-06-25T08:01:00.000Z' }),
    ]

    const result = mergeMessagesFromServer(existing, staleFresh)
    expect(result.messages.map(m => m.id)).toEqual(['server-0', 'server-1', 'live-ai'])
    expect(result.messages.find(m => m.id === 'live-ai')?.content).toBe('刚刚实时看到的 AI 回复')
  })

  it('#6514 upsert 不以服务端页为底：本地独有行保留，服务端新行补入', () => {
    const existing = [
      msg({ id: 'stale-local', content: 'keep local', created_at: '2026-06-25T08:00:00.000Z' }),
    ]
    const fresh = [
      msg({ id: 'server-1', content: 'server wins', created_at: '2026-06-25T08:01:00.000Z' }),
    ]

    const result = mergeMessagesFromServer(existing, fresh)
    expect(result.messages.map(m => m.id)).toEqual(['stale-local', 'server-1'])
  })

  it('#2822 内容态保留未落库：权威替换分支保留 runtime 起源消息（local- 前缀）', () => {
    const existing = [
      msg({ id: 'server-1', content: 'synced', created_at: '2026-07-14T03:15:00.000Z' }),
      msg({ id: 'local-4b016503-1783998941-ab', role: 'assistant', content: '刚看到但未落库', created_at: '2026-07-14T03:15:40.000Z' }),
    ]
    // 服务端滞后页：比本地新（时间上）但缺未落库消息 → 权威替换分支
    const fresh = [
      msg({ id: 'server-1', content: 'synced', created_at: '2026-07-14T03:15:00.000Z' }),
      msg({ id: 'server-2', content: 'another', created_at: '2026-07-14T03:16:00.000Z' }),
    ]

    const result = mergeMessagesFromServer(existing, fresh)
    expect(result.messages.map(m => m.id)).toContain('local-4b016503-1783998941-ab')
  })

  it('#2822 内容态保留未落库：服务端已有对应行（client_event_id 共享身份）时不重复保留', () => {
    const existing = [
      msg({ id: 'local-4b016503-1783998941-ab', role: 'assistant', content: 'live', created_at: '2026-07-14T03:15:40.000Z' }),
    ]
    const fresh = [
      msg({
        id: 'server-uuid-1',
        role: 'assistant',
        content: 'persisted',
        created_at: '2026-07-14T03:16:06.000Z',
        client_event_id: 'local-4b016503-1783998941-ab',
      } as never),
    ]

    const result = mergeMessagesFromServer(existing, fresh)
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].id).toBe('local-4b016503-1783998941-ab')
    expect((result.messages[0].metadata as { message_id?: string })?.message_id).toBe('server-uuid-1')
  })

  it('#2822 mergeAuthoritativeServerReplace：整表替换按内容态保留未落库 runtime 消息', () => {
    const local = [
      msg({ id: 'server-1', content: 'synced', created_at: '2026-07-14T03:15:00.000Z' }),
      msg({ id: 'local-4b016503-1783998941-ab', role: 'assistant', content: '未落库', created_at: '2026-07-14T03:15:40.000Z' }),
      msg({ id: 'temp-user-123', content: '乐观占位', created_at: '2026-07-14T03:15:50.000Z' }),
    ]
    const server = [
      msg({ id: 'server-1', content: 'synced', created_at: '2026-07-14T03:15:00.000Z' }),
    ]

    const kept = mergeAuthoritativeServerReplace(server, local)
    expect(kept.map(m => m.id)).toEqual(['server-1', 'local-4b016503-1783998941-ab', 'temp-user-123'])
  })

  it('#5516 ACK 后 forceFullLatest 权威替换不得抹掉已重绑的本地 user', () => {
    const cid = 'client-msg-dmg-1'
    const existing = [
      msg({ id: 'server-1', content: 'older', created_at: '2026-07-15T11:30:00.000Z' }),
      // ACK 后 id 已是 server UUID（失去 temp- 前缀），但仍有 client_message_id
      msg({
        id: 'server-user-acked',
        role: 'user',
        content: '那生成dmg文件',
        created_at: '2026-07-15T11:33:50.000Z',
        metadata: { client_message_id: cid },
      }),
    ]
    ;(existing[1] as Record<string, unknown>).sendStatus = 'sent'
    // 滞后 latest page：缺该 user，但含更新的 env/assistant → 走权威替换分支
    const fresh = [
      msg({ id: 'server-1', content: 'older', created_at: '2026-07-15T11:30:00.000Z' }),
      msg({
        id: 'env-newer',
        role: 'user',
        content: '<context type="environment">...</context>',
        created_at: '2026-07-15T11:33:58.000Z',
        metadata: { message_kind: 'environment_context' },
      }),
      msg({
        id: 'assistant-newer',
        role: 'assistant',
        content: '正在打包',
        created_at: '2026-07-15T11:34:00.000Z',
      }),
    ]

    const kept = mergeMessagesFromServer(existing, fresh)
    expect(kept.messages.map(m => m.id)).toContain('server-user-acked')
    expect(kept.messages.find(m => m.id === 'server-user-acked')?.content).toBe('那生成dmg文件')
  })

  it('#5516 服务端页已含同 client_message_id 时不重复保留', () => {
    const cid = 'client-msg-dup-1'
    const existing = [
      msg({
        id: 'server-user-acked',
        content: '那生成dmg文件',
        created_at: '2026-07-15T11:33:50.000Z',
        metadata: { client_message_id: cid },
      }),
    ]
    ;(existing[0] as Record<string, unknown>).sendStatus = 'sent'
    const fresh = [
      msg({
        id: 'server-user-from-list',
        content: '那生成dmg文件',
        created_at: '2026-07-15T11:33:50.000Z',
        metadata: { client_message_id: cid },
      }),
      msg({
        id: 'assistant-newer',
        role: 'assistant',
        content: 'ok',
        created_at: '2026-07-15T11:34:00.000Z',
      }),
    ]

    const result = mergeMessagesFromServer(existing, fresh)
    const matched = result.messages.filter(
      m => (m.metadata as { client_message_id?: string } | null)?.client_message_id === cid,
    )
    expect(matched).toHaveLength(1)
    expect(matched[0].id).toBe('server-user-acked')
    expect((matched[0].metadata as { message_id?: string })?.message_id).toBe('server-user-from-list')
    // 缝合时保留本地 sendStatus，供后续滞后页保命
    expect((matched[0] as Record<string, unknown>).sendStatus).toBe('sent')
  })

  it('#5516 权威两步竞态：T1 页含同 cid user 后 T2 滞后缺 user → 气泡仍在', () => {
    const cid = 'client-msg-race-auth-1'
    const existing = [
      msg({ id: 'server-1', content: 'older', created_at: '2026-07-15T11:30:00.000Z' }),
      msg({
        id: 'server-user-acked',
        role: 'user',
        content: '刚发出的消息',
        created_at: '2026-07-15T11:33:50.000Z',
        metadata: { client_message_id: cid },
      }),
    ]
    ;(existing[1] as Record<string, unknown>).sendStatus = 'sent'

    // T1：权威页已含同 cid user（服务端壳无 sendStatus）+ 更新 assistant
    const fresh1 = [
      msg({ id: 'server-1', content: 'older', created_at: '2026-07-15T11:30:00.000Z' }),
      msg({
        id: 'server-user-from-list',
        role: 'user',
        content: '刚发出的消息',
        created_at: '2026-07-15T11:33:50.000Z',
        metadata: { client_message_id: cid },
      }),
      msg({
        id: 'assistant-newer',
        role: 'assistant',
        content: '上一轮收尾',
        created_at: '2026-07-15T11:34:00.000Z',
      }),
    ]
    const after1 = mergeMessagesFromServer(existing, fresh1)
    const user1 = after1.messages.find(
      m => (m.metadata as { client_message_id?: string } | null)?.client_message_id === cid,
    )
    expect(user1).toBeDefined()
    expect((user1 as Record<string, unknown>).sendStatus).toBe('sent')

    // T2：页长度够、缺该 user、有更新 assistant → 仍走权威；靠 sendStatus 保命
    const fresh2 = [
      msg({ id: 'server-1', content: 'older', created_at: '2026-07-15T11:30:00.000Z' }),
      msg({
        id: 'env-newer',
        role: 'user',
        content: '<context type="environment">...</context>',
        created_at: '2026-07-15T11:33:58.000Z',
        metadata: { message_kind: 'environment_context' },
      }),
      msg({
        id: 'assistant-newer-2',
        role: 'assistant',
        content: '继续',
        created_at: '2026-07-15T11:34:05.000Z',
      }),
    ]
    const after2 = mergeMessagesFromServer(after1.messages, fresh2)
    const user2 = after2.messages.find(
      m => (m.metadata as { client_message_id?: string } | null)?.client_message_id === cid,
    )
    expect(user2).toBeDefined()
    expect(user2?.content).toBe('刚发出的消息')
  })

  it('#5516 mergeAuthoritativeServerReplace 保留已 ACK 的本地 user', () => {
    const local = [
      msg({ id: 'server-1', content: 'synced', created_at: '2026-07-14T03:15:00.000Z' }),
      msg({
        id: 'server-user-acked',
        content: '那生成dmg文件',
        created_at: '2026-07-14T03:15:45.000Z',
        metadata: { client_message_id: 'client-acked-1' },
      }),
      msg({ id: 'temp-user-new', content: '排队刚发出', created_at: '2026-07-14T03:15:55.000Z' }),
    ]
    ;(local[1] as Record<string, unknown>).sendStatus = 'sent'
    const server = [
      msg({ id: 'server-1', content: 'synced', created_at: '2026-07-14T03:15:00.000Z' }),
    ]

    const kept = mergeAuthoritativeServerReplace(server, local)
    expect(kept.map(m => m.id)).toEqual(['server-1', 'server-user-acked', 'temp-user-new'])
  })

  it('#5516 mergeAuthoritativeServerReplace 重叠 user 缝合保留 sendStatus', () => {
    const cid = 'client-acked-overlap-1'
    const local = [
      msg({
        id: 'server-user-acked',
        content: '那生成dmg文件',
        created_at: '2026-07-14T03:15:45.000Z',
        metadata: { client_message_id: cid },
      }),
    ]
    ;(local[0] as Record<string, unknown>).sendStatus = 'sent'
    const server = [
      msg({
        id: 'server-user-from-list',
        content: '那生成dmg文件',
        created_at: '2026-07-14T03:15:45.000Z',
        metadata: { client_message_id: cid },
      }),
    ]

    const kept = mergeAuthoritativeServerReplace(server, local)
    expect(kept).toHaveLength(1)
    expect(kept[0].id).toBe('server-user-acked')
    expect((kept[0].metadata as { message_id?: string })?.message_id).toBe('server-user-from-list')
    expect((kept[0] as Record<string, unknown>).sendStatus).toBe('sent')
  })

  it('#6514 upsert 保留本地历史 user，同时补入服务端新行', () => {
    const existing = [
      msg({
        id: 'historical-user',
        content: '很久以前的话',
        created_at: '2026-07-15T11:30:00.000Z',
        client_event_id: 'hist-cid-1',
      } as never),
    ]
    const fresh = [
      msg({
        id: 'assistant-newer',
        role: 'assistant',
        content: '新回复',
        created_at: '2026-07-15T11:34:00.000Z',
      }),
    ]

    const result = mergeMessagesFromServer(existing, fresh)
    expect(result.messages.map(m => m.id)).toEqual(['historical-user', 'assistant-newer'])
  })

  it('#2522 /  upsert 不把 rewind summary 之前的服务端行当新消息复活', () => {
    const existing = [
      msg({ id: 'u1', role: 'user', content: '保留 user', created_at: '2026-07-03T08:00:00.000Z' }),
      msg({ id: 'a1', role: 'assistant', content: '保留 assistant', created_at: '2026-07-03T08:00:01.000Z' }),
      msg({
        id: 'rewind-summary-test',
        role: 'system',
        content: '回退完成',
        created_at: '2026-07-03T08:00:04.000Z',
      }),
    ]
    const staleFresh = [
      msg({ id: 'u1', role: 'user', content: '保留 user', created_at: '2026-07-03T08:00:00.000Z' }),
      msg({ id: 'a1', role: 'assistant', content: '保留 assistant', created_at: '2026-07-03T08:00:01.000Z' }),
      msg({ id: 'u2', role: 'user', content: '被回退 user', created_at: '2026-07-03T08:00:02.000Z' }),
      msg({ id: 'a2', role: 'assistant', content: '被回退 assistant', created_at: '2026-07-03T08:00:03.000Z' }),
    ]

    const result = mergeMessagesFromServer(existing, staleFresh)
    expect(result.messages.map(m => m.id)).toEqual(['u1', 'a1', 'rewind-summary-test'])
  })

  it('latest page reports changed when server refresh updates the same id', () => {
    const existing = [
      msg({ id: 'server-1', content: 'old content', created_at: '2026-06-25T08:00:00.000Z' }),
    ]
    const fresh = [
      msg({ id: 'server-1', content: 'fresh content', created_at: '2026-06-25T08:00:00.000Z' }),
    ]

    const result = mergeMessagesFromServer(existing, fresh)
    expect(result.changed).toBe(true)
    expect(result.messages[0].content).toBe('fresh content')
  })

  // ──  根因：latest page 权威替换按内容态保留未落库，不因服务端页缺失删本地 ──
  // 服务端 latest page 缺某条本地消息（in-flight 未落库 / 半集分页）时，旧兜底
  // 分支按「缺失即删」把它抹掉。现按内容态（local- / temp- / 本地发起 user）保留，
  // 服务端只是滞后投影，只增补 / 更新 / 排序，绝不因服务端页缺失删本地。

  it('#5547 内容态保留未落库：latest page 只含 assistant、缺首条 user → 不删该 user（新对话首条不消失）', () => {
    const cid = 'client-first-msg-1'
    const localUser = msg({
      id: cid,
      role: 'user',
      content: '新对话第一条',
      created_at: '2026-07-16T09:00:00.000Z',
      metadata: { client_message_id: cid },
    })
    ;(localUser as Record<string, unknown>).sendStatus = 'sending'
    const existing = [localUser]
    // 服务端首条 user 尚未落库，latest page 只回来 assistant
    const fresh = [
      msg({ id: 'assistant-1', role: 'assistant', content: '在的', created_at: '2026-07-16T09:00:02.000Z' }),
    ]

    const kept = mergeMessagesFromServer(existing, fresh)
    expect(kept.messages.map(m => m.id)).toContain(cid)
    expect(kept.messages.find(m => m.id === cid)?.content).toBe('新对话第一条')

    // ：对账一律 upsert，观察端本地独有行也不因服务端页缺失被删
    const observerUser = msg({
      id: 'hist-user',
      role: 'user',
      content: '历史 user',
      created_at: '2026-07-16T09:00:00.000Z',
    })
    const observer = mergeMessagesFromServer([observerUser], fresh)
    expect(observer.messages.map(m => m.id)).toEqual(['hist-user', 'assistant-1'])
  })

  it('#5547 内容态保留未落库：latest page 已含同 id user（服务端无 sendStatus）→ 保留本地瞬态 sendStatus', () => {
    const cid = 'client-unified-2'
    const localUser = msg({
      id: cid,
      role: 'user',
      content: '你好',
      created_at: '2026-07-16T09:00:00.000Z',
      metadata: { client_message_id: cid },
    })
    ;(localUser as Record<string, unknown>).sendStatus = 'sending'
    // 服务端已落库同 id（ 收口后 server id == client_message_id），但快照不带瞬态 sendStatus
    const serverUser = msg({
      id: cid,
      role: 'user',
      content: '你好',
      created_at: '2026-07-16T09:00:00.000Z',
      metadata: { client_event_id: cid, client_message_id: cid },
    })
    // 本地列表比服务端页更长 → 走 delta merge，同 id user 缝合时保留 sendStatus
    const anchor = msg({ id: 'server-0', role: 'assistant', content: 'older', created_at: '2026-07-15T08:00:00.000Z' })

    const result = mergeMessagesFromServer([anchor, localUser], [serverUser])
    const merged = result.messages.find(m => m.id === cid)
    expect(merged).toBeDefined()
    expect((merged as Record<string, unknown>).sendStatus).toBe('sending')
  })

  it('#5547 内容态保留未落库：两步竞态（server 壳更新 → 半集缺 user）首条 user 仍不消失', () => {
    const cid = 'client-race-3'
    const localUser = msg({
      id: cid,
      role: 'user',
      content: '第一条',
      created_at: '2026-07-16T09:00:00.000Z',
      metadata: { client_message_id: cid },
    })
    ;(localUser as Record<string, unknown>).sendStatus = 'sending'

    // T1：服务端页已含同 id user（无 sendStatus）+ assistant —— delta merge 缝合 sendStatus
    const t1Fresh = [
      msg({ id: cid, role: 'user', content: '第一条', created_at: '2026-07-16T09:00:00.000Z', metadata: { client_event_id: cid, client_message_id: cid } }),
      msg({ id: 'assistant-1', role: 'assistant', content: '回复', created_at: '2026-07-16T09:00:02.000Z' }),
    ]
    const afterT1 = mergeMessagesFromServer([localUser], t1Fresh)
    // T1 后仍保留 sendStatus，未被 server 壳抹掉
    expect((afterT1.messages.find(m => m.id === cid) as Record<string, unknown>)?.sendStatus).toBe('sending')

    // T2：滞后半集页只回来 assistant，缺该 user
    const t2Fresh = [
      msg({ id: 'assistant-1', role: 'assistant', content: '回复', created_at: '2026-07-16T09:00:02.000Z' }),
    ]
    const afterT2 = mergeMessagesFromServer(afterT1.messages, t2Fresh)
    expect(afterT2.messages.map(m => m.id)).toContain(cid)
  })
})

describe('#4589 assistant live 块权威（server reconcile 不覆盖更新的 runtime live 块）', () => {
  function liveEntry(arrivalSeq: number, text: string) {
    return {
      index: 0,
      block_id: 'blk-0',
      block: { type: 'text', text, arrival_seq: arrivalSeq },
      finalized: false,
      partial: false,
    }
  }

  it('observer 中途 reconcile：本地 live 更新、服务端快照更旧 → 保留 live 无键文字（不整消息级择边）', () => {
    const live = [liveEntry(200, 'thinking 全量')]
    const existing = [msg({ id: 'a1', role: 'assistant', content: '', blocks: live } as never)]
    const fresh = [msg({
      id: 'a1',
      role: 'assistant',
      content: 'half',
      content_blocks_json: [{ type: 'text', text: 'half', arrival_seq: 100 }],
    } as never)]

    const result = mergeMessagesFromServer(existing, fresh)
    expect(result.changed).toBe(true)
    const blocks = (result.messages[0] as { blocks?: Array<{ block?: { text?: string } }> }).blocks
    expect(blocks).toHaveLength(1)
    expect(blocks![0].block?.text).toBe('thinking 全量')
  })

  it('finalize 后 reload：本地无 live 块 → 服务端权威（json；blocks 由 store hydrate）', () => {
    const existing = [msg({ id: 'a1', role: 'assistant', content: 'old' })]
    const fresh = [msg({
      id: 'a1',
      role: 'assistant',
      content: 'final',
      content_blocks_json: [{ type: 'text', text: 'final', arrival_seq: 500 }],
    } as never)]

    const result = mergeMessagesFromServer(existing, fresh)
    // 冷合并只补壳 + content_blocks_json；runtime blocks 由 setSessionMessages hydrate。
    expect(result.messages[0].content).toBe('final')
    expect(result.messages[0].content_blocks_json).toEqual([
      { type: 'text', text: 'final', arrival_seq: 500 },
    ])
    expect(result.messages[0].blocks).toBeUndefined()
  })

  // ：服务端无键码点严格更长 → 升级全文；等长/更短仍留 live（见上一用例）。
  it('#7794 有 live 短无键文字时：服务端更长无键文字应替换（气泡靠 blocks 全文）', () => {
    const stale = [liveEntry(50, '旧半截')]
    const existing = [msg({ id: 'a1', role: 'assistant', content: '', blocks: stale } as never)]
    const fresh = [msg({
      id: 'a1',
      role: 'assistant',
      content: 'complete',
      content_blocks_json: [{ type: 'text', text: 'complete', arrival_seq: 300 }],
    } as never)]

    const result = mergeMessagesFromServer(existing, fresh)
    const blocks = (result.messages[0] as { blocks?: Array<{ block?: { text?: string } }> }).blocks
    expect(blocks).toHaveLength(1)
    expect(blocks![0].block?.text).toBe('complete')
  })

  it('#6514 mergeMessagesFromServer ≡ upsert：live 更新时保留 live 无键文字', () => {
    const live = [liveEntry(200, 'thinking 全量')]
    const existing = [msg({ id: 'a1', role: 'assistant', content: '', blocks: live } as never)]
    const fresh = [msg({
      id: 'a1',
      role: 'assistant',
      content: 'half',
      content_blocks_json: [{ type: 'text', text: 'half', arrival_seq: 100 }],
    } as never)]

    const result = mergeMessagesFromServer(existing, fresh)
    expect(result.changed).toBe(true)
    const blocks = (result.messages[0] as { blocks?: Array<{ block?: { text?: string } }> }).blocks
    expect(blocks![0].block?.text).toBe('thinking 全量')
  })

  it('#6514 mergeMessagesFromServer ≡ upsert：live 仅工具块时补齐服务端文字', () => {
    const toolOnly = [{
      index: 0,
      block_id: 'todo_1',
      block: {
        type: 'tool_use',
        id: 'todo_1',
        name: 'todo',
        input: { todos: [{ id: '1', status: 'completed' }] },
        arrival_seq: 50,
      },
      finalized: true,
      partial: false,
    }]
    const existing = [msg({ id: 'a1', role: 'assistant', content: '', blocks: toolOnly } as never)]
    const fresh = [msg({
      id: 'a1',
      role: 'assistant',
      content: 'complete',
      content_blocks_json: [{ type: 'text', text: 'complete', arrival_seq: 300 }],
    } as never)]

    const result = mergeMessagesFromServer(existing, fresh)
    const blocks = (result.messages[0] as { blocks?: Array<{ block?: { type?: string; text?: string } }> }).blocks
    expect(blocks).toHaveLength(2)
    expect(blocks!.some((e) => e.block?.type === 'tool_use')).toBe(true)
    expect(blocks!.find((e) => e.block?.type === 'text')?.block?.text).toBe('complete')
  })
})

describe('#5093 runtime 起源消息落库跳变：块权威按身份匹配、保留 live 块', () => {
  function todoLive(arrivalSeq: number, status: string) {
    return {
      index: 0,
      block_id: 'tw-0',
      block: {
        type: 'tool_use',
        id: 'tw-0',
        name: 'todo',
        input: { action: 'open', items: [{ id: 't1', content: 'A', status }] },
        arrival_seq: arrivalSeq,
      },
      finalized: true,
      partial: false,
    }
  }

  function todoJson(arrivalSeq: number, status: string) {
    return [{
      type: 'tool_use',
      id: 'tw-0',
      name: 'todo',
      input: { action: 'open', items: [{ id: 't1', content: 'A', status }] },
      arrival_seq: arrivalSeq,
    }]
  }

  it('mergeMessagesFromServer：local- 落库(client_event_id 共享身份)且服务端 JSON 滞后 → 保留 live completed 块、不重复', () => {
    const live = todoLive(200, 'completed')
    const existing = [
      msg({ id: 'server-1', content: 'synced', created_at: '2026-07-14T03:15:00.000Z' }),
      msg({ id: 'local-abc-1', role: 'assistant', content: '', blocks: [live], created_at: '2026-07-14T03:15:40.000Z' } as never),
    ]
    const fresh = [
      msg({ id: 'server-1', content: 'synced', created_at: '2026-07-14T03:15:00.000Z' }),
      msg({
        id: 'server-uuid-2',
        role: 'assistant',
        content: '',
        client_event_id: 'local-abc-1',
        content_blocks_json: todoJson(100, 'pending'),
        created_at: '2026-07-14T03:16:06.000Z',
      } as never),
    ]

    const result = mergeMessagesFromServer(existing, fresh)
    const merged = result.messages.find(m => m.id === 'local-abc-1')
    expect(merged).toBeDefined()
    expect((merged as { blocks?: unknown }).blocks).toEqual([live])
    expect((merged?.metadata as { message_id?: string })?.message_id).toBe('server-uuid-2')
    expect(result.messages.filter(m => m.id === 'server-uuid-2')).toHaveLength(0)
  })

  it('mergeMessagesFromServer：服务端 JSON 同 key seq 更高 → 仍留 live completed（禁止整块替换）', () => {
    const live = todoLive(200, 'completed')
    const existing = [
      msg({ id: 'local-abc-1', role: 'assistant', content: '', blocks: [live], created_at: '2026-07-14T03:15:40.000Z' } as never),
    ]
    const fresh = [
      msg({
        id: 'server-uuid-2',
        role: 'assistant',
        content: '',
        client_event_id: 'local-abc-1',
        content_blocks_json: todoJson(300, 'completed'),
        created_at: '2026-07-14T03:16:06.000Z',
      } as never),
    ]

    const result = mergeMessagesFromServer(existing, fresh)
    expect(result.messages).toHaveLength(1)
    const merged = result.messages[0]
    expect(merged.id).toBe('local-abc-1')
    expect((merged.metadata as { message_id?: string })?.message_id).toBe('server-uuid-2')
    const blocks = (merged as { blocks?: Array<{ block?: { arrival_seq?: number; input?: { items?: Array<{ status: string }> } } }> }).blocks
    expect(blocks).toHaveLength(1)
    expect(blocks![0].block?.arrival_seq).toBe(200)
    // fixture 用 items（与 todo 工具 open 形态一致），不是 todos
    expect(blocks![0].block?.input?.items?.[0]?.status).toBe('completed')
    expect((merged.content_blocks_json as { input: { items: { status: string }[] } }[])[0].input.items[0].status).toBe('completed')
  })

  it('mergeAuthoritativeServerReplace：同 id 服务端 pending + 更高 seq 文字，不得整包打回 live completed', () => {
    const live = todoLive(200, 'completed')
    const local = [
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        blocks: [live],
        created_at: '2026-07-14T03:15:40.000Z',
      } as never),
    ]
    const server = [
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        content_blocks_json: [
          ...todoJson(100, 'pending'),
          { type: 'text', text: 'later', arrival_seq: 300 },
        ],
        created_at: '2026-07-14T03:16:06.000Z',
      } as never),
    ]

    const kept = mergeAuthoritativeServerReplace(server, local)
    expect(kept).toHaveLength(1)
    const blocks = (kept[0] as { blocks?: Array<{ block?: { type?: string; input?: { items?: Array<{ status: string }> }; text?: string } }> }).blocks
    expect(blocks).toHaveLength(2)
    const tool = blocks!.find((e) => e.block?.type === 'tool_use')
    expect(tool!.block?.input?.items?.[0]?.status).toBe('completed')
  })

  it('mergeMessagesFromServer(delta)：local- 落库(身份共享、服务端新 UUID) → 不重复、保留 live completed 块', () => {
    const live = todoLive(200, 'completed')
    const existing = [
      msg({ id: 'local-abc-1', role: 'assistant', content: '', blocks: [live], created_at: '2026-07-14T03:15:40.000Z' } as never),
    ]
    const fresh = [
      msg({
        id: 'server-uuid-2',
        role: 'assistant',
        content: '',
        client_event_id: 'local-abc-1',
        content_blocks_json: todoJson(100, 'pending'),
        created_at: '2026-07-14T03:16:06.000Z',
      } as never),
    ]

    const result = mergeMessagesFromServer(existing, fresh)
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].id).toBe('local-abc-1')
    expect((result.messages[0].metadata as { message_id?: string })?.message_id).toBe('server-uuid-2')
    expect((result.messages[0] as { blocks?: unknown }).blocks).toEqual([live])
  })

  it('有 live 时 server content 半截不得盖掉 local 正文（壳以 runtime 为准）', () => {
    const live = todoLive(200, 'completed')
    const existing = [
      msg({
        id: 'local-abc-1',
        role: 'assistant',
        content: 'full live reply',
        blocks: [live],
        created_at: '2026-07-14T03:15:40.000Z',
      } as never),
    ]
    const fresh = [
      msg({
        id: 'server-uuid-2',
        role: 'assistant',
        content: 'half',
        client_event_id: 'local-abc-1',
        content_blocks_json: todoJson(100, 'pending'),
        created_at: '2026-07-14T03:16:06.000Z',
      } as never),
    ]

    const result = mergeMessagesFromServer(existing, fresh)
    expect(result.messages[0].id).toBe('local-abc-1')
    expect(result.messages[0].content).toBe('full live reply')
    expect((result.messages[0] as { blocks?: unknown }).blocks).toEqual([live])
  })

  it('真未落库(服务端页无对应行) → 保留本地消息与 live 块（不回归 ）', () => {
    const live = todoLive(200, 'completed')
    const existing = [
      msg({ id: 'server-1', content: 'synced', created_at: '2026-07-14T03:15:00.000Z' }),
      msg({ id: 'local-abc-1', role: 'assistant', content: '', blocks: [live], created_at: '2026-07-14T03:15:40.000Z' } as never),
    ]
    const fresh = [
      msg({ id: 'server-1', content: 'synced', created_at: '2026-07-14T03:15:00.000Z' }),
    ]

    const result = mergeMessagesFromServer(existing, fresh)
    const kept = result.messages.find(m => m.id === 'local-abc-1')
    expect(kept).toBeDefined()
    expect((kept as { blocks?: unknown }).blocks).toEqual([live])
  })
})
