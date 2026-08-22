/**
 * localTranscript.test.ts —  本机 transcript 薄适配契约。
 *
 * 锁定不变量：
 * 1. native 块直落 content_blocks_json，text 汇总进 content。
 * 2. tool_result 并回其 tool_use 所在消息（同 message 配对），承载它的空 user 消息被丢弃。
 * 3. 跨轮同 tool_use_id FIFO：result 配到首个未配对的同 id tool_use。
 * 4. messageId 缺失时按 `local-<sid>-<idx>` 合成稳定 id。
 * 5. created_at 缺失时向前继承，保时间线顺序。
 * 6. 找不到对应 tool_use 的孤儿 result 不丢（保留在原消息）。
 */
import { describe, expect, it } from 'vitest'

import {
  adaptTranscriptToChatMessages,
  enrichWithServerMetadata,
  type ReconstructedTranscriptMessage,
} from '../localTranscript'
import type { ChatMessage } from '@tabtin/chat-client'

const SID = 'sess-4897'

function userText(text: string, over: Partial<ReconstructedTranscriptMessage> = {}): ReconstructedTranscriptMessage {
  return { role: 'user', blocks: [{ type: 'text', text }], ...over }
}

describe('#4897 adaptTranscriptToChatMessages', () => {
  it('空正文终态错误映射为统一卡片数据，不生成错误正文', () => {
    const out = adaptTranscriptToChatMessages([
      {
        role: 'assistant',
        messageId: 'billing-error',
        blocks: [],
        stopReason: 'error',
        errorInfoJson: {
          error_class: 'LLM_BILLING_ERROR',
          category: 'organization_insufficient_credits',
        },
      },
    ], SID)
    expect(out).toHaveLength(1)
    expect(out[0].content).toBe('')
    expect(out[0].content_blocks_json).toEqual([])
    expect(out[0].error_info_json).toEqual(expect.objectContaining({
      error_class: 'LLM_BILLING_ERROR',
      category: 'organization_insufficient_credits',
    }))
  })

  it('#6072：切回会话时保留 turn 级 Agent 身份', () => {
    const reconstructed: ReconstructedTranscriptMessage[] = [
      {
        role: 'assistant',
        agentId: 'agent-turn-a',
        messageId: 'a-turn-1',
        blocks: [{ type: 'text', text: '由 Agent A 生成' }],
      },
    ]

    const out = adaptTranscriptToChatMessages(reconstructed, SID)

    expect(out[0].agent_id).toBe('agent-turn-a')
  })

  it('#7879：切回会话时从本地真源恢复 user 发送者', () => {
    const out = adaptTranscriptToChatMessages([
      userText('共享发言', { messageId: 'u-shared', senderUserId: 'grantee-1' }),
    ], SID)

    expect(out[0].sender_user_id).toBe('grantee-1')
  })

  it('把 native 块落到 content_blocks_json，text 汇总进 content', () => {
    const out = adaptTranscriptToChatMessages(
      [userText('你好', { messageId: 'u1', timestamp: '2026-07-14T00:00:00.000Z' })],
      SID,
    )
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('u1')
    expect(out[0].role).toBe('user')
    expect(out[0].content).toBe('你好')
    expect(out[0].content_blocks_json).toEqual([{ type: 'text', text: '你好' }])
    expect(out[0].created_at).toBe('2026-07-14T00:00:00.000Z')
  })

  it('#5592：triggeredBy 映射到 metadata.triggered_by（push 通知重载还原收敛卡）', () => {
    const out = adaptTranscriptToChatMessages(
      [
        userText('A background command completed…', {
          messageId: 'push-1',
          timestamp: '2026-07-14T00:00:00.000Z',
          triggeredBy: 'push-notification',
        }),
        userText('真用户输入', { messageId: 'u-real', timestamp: '2026-07-14T00:00:01.000Z' }),
      ],
      SID,
    )
    const push = out.find((m) => m.id === 'push-1')!
    expect((push.metadata as Record<string, unknown> | undefined)?.triggered_by).toBe('push-notification')
    const real = out.find((m) => m.id === 'u-real')!
    expect(real.metadata).toBeUndefined()
  })

  it('#9460：冷恢复保留系统注入角色及其渲染判定元数据', () => {
    const out = adaptTranscriptToChatMessages(
      [{
        role: 'system',
        messageId: 'push-system-1',
        blocks: [{ type: 'text', text: 'A background command completed…' }],
        triggeredBy: 'push-notification',
      }],
      SID,
    )

    expect(out[0].role).toBe('system')
    expect((out[0].metadata as Record<string, unknown>)?.triggered_by).toBe('push-notification')
  })

  it('tool_result 并回 tool_use 所在消息，空 user 承载消息被丢弃', () => {
    const recon: ReconstructedTranscriptMessage[] = [
      userText('查一下', { messageId: 'u1', timestamp: '2026-07-14T00:00:00.000Z' }),
      {
        role: 'assistant',
        messageId: 'a1',
        timestamp: '2026-07-14T00:00:01.000Z',
        blocks: [
          { type: 'text', text: '好的' },
          { type: 'tool_use', id: 'call_1', name: 'search', input: { q: 'x' } } as never,
        ],
      },
      {
        role: 'user',
        messageId: 'u2',
        timestamp: '2026-07-14T00:00:02.000Z',
        blocks: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'result-data', is_error: false } as never,
        ],
      },
    ]
    const out = adaptTranscriptToChatMessages(recon, SID)
    // u2（只承载 tool_result）应被丢弃 → 只剩 u1 + a1
    expect(out.map((m) => m.id)).toEqual(['u1', 'a1'])
    const a1 = out.find((m) => m.id === 'a1')!
    const types = (a1.content_blocks_json ?? []).map((b) => (b as { type?: string }).type)
    expect(types).toEqual(['text', 'tool_use', 'tool_result'])
    const result = (a1.content_blocks_json ?? []).find((b) => (b as { type?: string }).type === 'tool_result')
    expect((result as { content?: string }).content).toBe('result-data')
  })

  it('跨轮同 tool_use_id FIFO：result 配到首个未配对的 tool_use', () => {
    const mkUse = (mid: string, ts: string): ReconstructedTranscriptMessage => ({
      role: 'assistant',
      messageId: mid,
      timestamp: ts,
      blocks: [{ type: 'tool_use', id: 'agent_0', name: 'run', input: {} } as never],
    })
    const mkResult = (content: string, ts: string): ReconstructedTranscriptMessage => ({
      role: 'user',
      timestamp: ts,
      blocks: [{ type: 'tool_result', tool_use_id: 'agent_0', content, is_error: false } as never],
    })
    const out = adaptTranscriptToChatMessages(
      [
        mkUse('a1', '2026-07-14T00:00:00.000Z'),
        mkResult('r1', '2026-07-14T00:00:01.000Z'),
        mkUse('a2', '2026-07-14T00:00:02.000Z'),
        mkResult('r2', '2026-07-14T00:00:03.000Z'),
      ],
      SID,
    )
    expect(out.map((m) => m.id)).toEqual(['a1', 'a2'])
    const r1 = (out[0].content_blocks_json ?? []).find((b) => (b as { type?: string }).type === 'tool_result')
    const r2 = (out[1].content_blocks_json ?? []).find((b) => (b as { type?: string }).type === 'tool_result')
    expect((r1 as { content?: string }).content).toBe('r1')
    expect((r2 as { content?: string }).content).toBe('r2')
  })

  it('messageId 缺失时合成稳定 id', () => {
    const out = adaptTranscriptToChatMessages([userText('无 id')], SID)
    expect(out[0].id).toBe(`local-${SID}-0`)
  })

  it('created_at 缺失时向前继承', () => {
    const out = adaptTranscriptToChatMessages(
      [
        userText('第一条', { messageId: 'u1', timestamp: '2026-07-14T00:00:00.000Z' }),
        { role: 'assistant', messageId: 'a1', blocks: [{ type: 'text', text: '回复' }] },
      ],
      SID,
    )
    expect(out[1].created_at).toBe('2026-07-14T00:00:00.000Z')
  })

  it('孤儿 tool_result（无匹配 tool_use）保留不丢', () => {
    const out = adaptTranscriptToChatMessages(
      [
        {
          role: 'user',
          messageId: 'u1',
          timestamp: '2026-07-14T00:00:00.000Z',
          blocks: [{ type: 'tool_result', tool_use_id: 'missing', content: 'orphan', is_error: false } as never],
        },
      ],
      SID,
    )
    expect(out).toHaveLength(1)
    const result = (out[0].content_blocks_json ?? [])[0]
    expect((result as { content?: string }).content).toBe('orphan')
  })
})

function chatMsg(over: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'x',
    role: 'assistant',
    content: '',
    created_at: '2026-07-14T00:00:00.000Z',
    ...over,
  }
}

describe('#4897 enrichWithServerMetadata（DB 只补非正文增强字段）', () => {
  it('#6072：旧本地记录缺 Agent 身份时由 DB 行补齐', () => {
    const local = [chatMsg({ id: 'a1', content: '本地正文' })]
    const server = [chatMsg({ id: 'a1', agent_id: 'agent-turn-a', content: 'DB 正文' })]

    const out = enrichWithServerMetadata(local, server)

    expect(out[0].agent_id).toBe('agent-turn-a')
    expect(out[0].content).toBe('本地正文')
  })

  it('#6072：本地已有 turn 身份时不被 DB 滞后值覆盖', () => {
    const local = [chatMsg({ id: 'a1', agent_id: 'agent-runtime', content: '本地正文' })]
    const server = [chatMsg({ id: 'a1', agent_id: 'agent-stale-db', content: 'DB 正文' })]

    const out = enrichWithServerMetadata(local, server)

    expect(out[0].agent_id).toBe('agent-runtime')
    expect(out[0].content).toBe('本地正文')
  })

  it('按 id 匹配补 usage / checkpoint，正文块不动', () => {
    const local = [
      chatMsg({
        id: 'a1',
        content: 'runtime 正文',
        content_blocks_json: [{ type: 'text', text: 'runtime 正文' }],
      }),
    ]
    const server = [
      chatMsg({
        id: 'a1',
        content: 'DB 滞后正文',
        content_blocks_json: [{ type: 'text', text: 'DB 滞后正文' }],
        usage_json: { output_tokens: 42 },
        checkpoint_hash: 'abc123',
      }),
    ]
    const out = enrichWithServerMetadata(local, server)
    expect(out).not.toBe(local) // 有变更 → 新数组
    expect(out[0].usage_json).toEqual({ output_tokens: 42 })
    expect(out[0].checkpoint_hash).toBe('abc123')
    // 正文以 runtime 为准，DB 不覆盖（二者互不包含时）
    expect(out[0].content).toBe('runtime 正文')
    expect(out[0].content_blocks_json).toEqual([{ type: 'text', text: 'runtime 正文' }])
  })

  it('#8294 本地 Tracker 模板包着 DB display 正文 → 冷读改用 DB 可见正文', () => {
    const instruction = 'test'
    const templated = [
      '## 任务',
      instruction,
      '',
      '请独立完成以上任务并汇报结果。如有合适的 Skill 可用，可自行搜索并调用（skills_search / skills_read）。',
    ].join('\n')
    const local = [
      chatMsg({
        id: 'u1',
        role: 'user',
        content: templated,
        content_blocks_json: [{ type: 'text', text: templated }],
        // 模拟 hydrate 后的 runtime SSoT；enrich 必须清掉，否则时间线物化会盖回模板
        blocks: [{
          index: 0,
          block_id: 'legacy-0',
          finalized: true,
          partial: false,
          block: { type: 'text', text: templated },
        }],
      } as ChatMessage),
    ]
    const server = [
      chatMsg({
        id: 'u1',
        role: 'user',
        content: instruction,
        content_blocks_json: [{ type: 'text', text: instruction }],
        usage_json: { output_tokens: 1 },
      }),
    ]
    const out = enrichWithServerMetadata(local, server)
    expect(out[0].content).toBe(instruction)
    expect(out[0].content_blocks_json).toEqual([{ type: 'text', text: instruction }])
    expect(out[0].usage_json).toEqual({ output_tokens: 1 })
    expect(out[0].blocks).toBeUndefined()
  })

  it('#8294 本地与 DB 互不包含 → 不覆盖冷读正文（反向）', () => {
    const local = [
      chatMsg({
        id: 'u1',
        role: 'user',
        content: '本地完全不同的长正文一二三四五六七八',
        content_blocks_json: [{ type: 'text', text: '本地完全不同的长正文一二三四五六七八' }],
      }),
    ]
    const server = [
      chatMsg({
        id: 'u1',
        role: 'user',
        content: '服务端另一段指令',
        content_blocks_json: [{ type: 'text', text: '服务端另一段指令' }],
      }),
    ]
    const out = enrichWithServerMetadata(local, server)
    expect(out[0].content).toBe('本地完全不同的长正文一二三四五六七八')
  })

  it('#8294 content/json 已纠正但 runtime blocks 仍是模板 → 仍清掉 blocks', () => {
    const instruction = 'test'
    const templated = [
      '## 任务',
      instruction,
      '',
      '请独立完成以上任务并汇报结果。如有合适的 Skill 可用，可自行搜索并调用（skills_search / skills_read）。',
    ].join('\n')
    const local = [
      chatMsg({
        id: 'u1',
        role: 'user',
        content: instruction,
        content_blocks_json: [{ type: 'text', text: instruction }],
        blocks: [{
          index: 0,
          block_id: 'legacy-0',
          finalized: true,
          partial: false,
          block: { type: 'text', text: templated },
        }],
      } as ChatMessage),
    ]
    const server = [
      chatMsg({
        id: 'u1',
        role: 'user',
        content: instruction,
        content_blocks_json: [{ type: 'text', text: instruction }],
      }),
    ]
    const out = enrichWithServerMetadata(local, server)
    expect(out[0].content).toBe(instruction)
    expect(out[0].content_blocks_json).toEqual([{ type: 'text', text: instruction }])
    expect(out[0].blocks).toBeUndefined()
  })

  it('runtime id 落库后变 UUID：靠 metadata.message_id 跨 id 匹配', () => {
    const local = [chatMsg({ id: 'local-sess-1-0', content: 'hi' })]
    const server = [
      chatMsg({
        id: 'server-uuid-9',
        metadata: { message_id: 'local-sess-1-0' },
        checkpoint_hash: 'h1',
      }),
    ]
    const out = enrichWithServerMetadata(local, server)
    expect(out[0].id).toBe('local-sess-1-0') // id 保持 runtime
    expect(out[0].checkpoint_hash).toBe('h1')
  })

  it('DB 有而本地没有的消息被忽略（不引入 DB-only 行）', () => {
    const local = [chatMsg({ id: 'a1' })]
    const server = [chatMsg({ id: 'a1' }), chatMsg({ id: 'db-only' })]
    const out = enrichWithServerMetadata(local, server)
    expect(out.map((m) => m.id)).toEqual(['a1'])
  })

  it('无匹配 / 无变更时返回同一引用', () => {
    const local = [chatMsg({ id: 'a1', checkpoint_hash: 'h' })]
    const server = [chatMsg({ id: 'a1', checkpoint_hash: 'h' })]
    expect(enrichWithServerMetadata(local, server)).toBe(local)
    expect(enrichWithServerMetadata(local, [])).toBe(local)
  })

  it('#2595：本机只有正文时从 DB 补回缺失的 video 块（切会话缩略图）', () => {
    const local = [
      chatMsg({
        id: 'u1',
        role: 'user',
        content: '这个视频里是什么',
        content_blocks_json: [{ type: 'text', text: '这个视频里是什么' }],
      }),
    ]
    const videoBlock = {
      type: 'video',
      file_id: 'vid-file-1',
      filename: 'clip.mp4',
      mime_type: 'video/mp4',
      size: 1024,
      url: 'https://cdn.example.com/clip.mp4',
    }
    const server = [
      chatMsg({
        id: 'u1',
        role: 'user',
        content: '这个视频里是什么',
        content_blocks_json: [
          { type: 'text', text: '这个视频里是什么' },
          videoBlock,
        ],
      }),
    ]
    const out = enrichWithServerMetadata(local, server)
    expect(out[0].content).toBe('这个视频里是什么')
    expect(out[0].content_blocks_json).toEqual([
      { type: 'text', text: '这个视频里是什么' },
      videoBlock,
    ])
  })

  it('#2595：本地已有同 file_id 的 video 块时不重复补入', () => {
    const videoBlock = {
      type: 'video',
      file_id: 'vid-file-1',
      filename: 'clip.mp4',
      url: 'https://cdn.example.com/clip.mp4',
    }
    const local = [
      chatMsg({
        id: 'u1',
        role: 'user',
        content: 'hi',
        content_blocks_json: [{ type: 'text', text: 'hi' }, videoBlock],
      }),
    ]
    const server = [
      chatMsg({
        id: 'u1',
        role: 'user',
        content: 'hi',
        content_blocks_json: [{ type: 'text', text: 'hi' }, { ...videoBlock, size: 99 }],
      }),
    ]
    const out = enrichWithServerMetadata(local, server)
    expect(out).toBe(local)
  })
})
