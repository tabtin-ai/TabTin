import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import type { ContentBlockEntry } from '@stores/useChatRuntimeStore'
import {
  materializeMessagesForTimeline,
  sortMessagesForTimeline,
} from '@/stores/chat/domain/messageTimelineOrder'

function msg(overrides: Partial<ChatMessage> & { id: string }): ChatMessage {
  const base = {
    id: overrides.id,
    role: 'assistant',
    content: '',
    created_at: '2026-06-28T00:00:00.000Z',
    ...overrides,
  } as ChatMessage
  // 模拟入口 hydrate（hydrateSessionBlocksFromJson）： 后时间线读 message.blocks，
  // 由 content_blocks_json 派生（全 finalized，保留 block 本体上的 arrival_seq）。用例显式
  // 给 blocks 时不覆盖。
  if (base.blocks === undefined && Array.isArray(base.content_blocks_json)) {
    base.blocks = base.content_blocks_json.map((block, index) => ({
      index,
      block_id: `b-${base.id}-${index}`,
      block: block as ContentBlockEntry['block'],
      finalized: true,
      partial: false,
    }))
  }
  return base
}

describe('messageTimelineOrder', () => {
  it('历史 web_search 富内容产物不生成独立时间线消息', () => {
    const searchArtifact = msg({
      id: 'web-search-artifact',
      message_kind: 'tool_artifact',
      content: '',
      content_blocks_json: [{
        type: 'tabtin_rich_content',
        kind: 'search_results',
        summary: 'web_search: 上海今天天气 (192204)',
        payload: {
          query: '上海今天天气',
          total_count: 192204,
          search_results: [],
        },
        arrival_seq: 20,
      }],
    })
    const answer = msg({
      id: 'answer',
      message_kind: 'llm',
      content_blocks_json: [{
        type: 'text',
        text: '根据搜索结果，今天上海天气如下。',
        arrival_seq: 30,
      }],
    })

    expect(materializeMessagesForTimeline([searchArtifact, answer]).map(message => message.id))
      .toEqual(['answer'])
  })

  it('compaction_summary 不隐藏边界前消息：聊天列表仍完整显示所有轮次', () => {
    const timeline = materializeMessagesForTimeline([
      msg({ id: 'u1', role: 'user', content: 'old question', created_at: '2026-06-28T00:00:00.000Z' }),
      msg({ id: 'a1', role: 'assistant', content: 'old answer', created_at: '2026-06-28T00:00:01.000Z' }),
      msg({ id: 'u2', role: 'user', content: 'new question', created_at: '2026-06-28T00:00:02.000Z' }),
      msg({ id: 'a2', role: 'assistant', content: 'new answer', created_at: '2026-06-28T00:00:03.000Z' }),
      msg({
        id: 'summary',
        role: 'system',
        message_kind: 'compaction_summary',
        content: 'summary',
        created_at: '2026-06-28T00:00:04.000Z',
        metadata: { compacted_up_to_message_id: 'a1' },
      }),
    ])

    // 边界前的 u1/a1 不再被隐藏；compaction_summary 作为分隔就地显示。
    expect(timeline.map(message => message.id)).toEqual(['u1', 'a1', 'u2', 'a2', 'summary'])
  })

  it('sorts messages by block arrival sequence instead of created_at', () => {
    const artifact = msg({
      id: 'artifact',
      message_kind: 'tool_artifact',
      created_at: '2026-06-28T00:00:00.000Z',
      content_blocks_json: [{ type: 'tabtin_rich_content', arrival_seq: 30 }],
    })
    const llm = msg({
      id: 'llm',
      message_kind: 'llm',
      created_at: '2026-06-28T00:00:01.000Z',
      content_blocks_json: [{ type: 'tool_call', arrival_seq: 20 }],
    })

    expect(sortMessagesForTimeline([artifact, llm]).map(m => m.id)).toEqual(['llm', 'artifact'])
  })

  it('块级内联:独立 artifact 按到达时间插进 llm 两个文字块之间(拆出同 id 段)', () => {
    const llm = msg({
      id: 'llm',
      message_kind: 'llm',
      content_blocks_json: [
        { type: 'text', text: 'before tool', arrival_seq: 10 },
        { type: 'text', text: 'after artifact', arrival_seq: 40 },
      ],
    })
    const artifact = msg({
      id: 'artifact',
      message_kind: 'tool_artifact',
      content_blocks_json: [
        { type: 'tabtin_rich_content', kind: 'widget', summary: 'artifact', arrival_seq: 30 },
      ],
    })

    const timeline = materializeMessagesForTimeline([artifact, llm])
    expect(timeline.map(m => m.id)).toEqual(['llm', 'artifact', 'llm'])
    expect(timeline[0]?.content_blocks_json?.map(b => b.arrival_seq)).toEqual([10])
    expect(timeline[1]?.content_blocks_json?.map(b => b.arrival_seq)).toEqual([30])
    expect(timeline[2]?.content_blocks_json?.map(b => b.arrival_seq)).toEqual([40])
    // 被拆开的两段标 partial:渲染须用段自带 blocks,不可按 id 取 runtime 全量。
    expect((timeline[0]?.metadata as Record<string, unknown>)?._timeline_is_partial).toBe(true)
    expect((timeline[2]?.metadata as Record<string, unknown>)?._timeline_is_partial).toBe(true)
    // 中间的 artifact 自身未被拆,不标 partial。
    expect((timeline[1]?.metadata as Record<string, unknown>)?._timeline_is_partial).toBeUndefined()
  })

  it('块级内联:用户消息按到达时间插进 assistant 两个文字块之间', () => {
    const assistant = msg({
      id: 'assistant',
      message_kind: 'llm',
      content_blocks_json: [
        { type: 'text', text: 'before user reply', arrival_seq: 10 },
        { type: 'text', text: 'after user reply', arrival_seq: 40 },
      ],
    })
    const user = msg({
      id: 'user',
      role: 'user',
      content: 'HITL approved',
      content_blocks_json: [
        { type: 'text', text: 'HITL approved', arrival_seq: 30 },
      ],
    })

    const timeline = materializeMessagesForTimeline([assistant, user])
    expect(timeline.map(m => `${m.role}:${m.id}`)).toEqual([
      'assistant:assistant',
      'user:user',
      'assistant:assistant',
    ])
  })

  it('keeps a local user message before subsequently arrived assistant blocks', () => {
    const user = msg({
      id: 'user-local',
      role: 'user',
      content: '查看本地文件系统资源占用',
      created_at: '2026-06-28T00:00:00.000Z',
      content_blocks_json: undefined,
    })
    const assistant = msg({
      id: 'assistant-live',
      role: 'assistant',
      created_at: '2026-06-28T00:00:00.001Z',
      content_blocks_json: [
        { type: 'thinking', thinking: '查看磁盘分区', signature: '', arrival_seq: Date.parse('2026-06-28T00:00:00.001Z') * 1_000 + 1 },
      ],
    })

    expect(materializeMessagesForTimeline([assistant, user]).map(m => m.id)).toEqual([
      'user-local',
      'assistant-live',
    ])
  })

  it('interleaves multi-turn user/assistant when both use microsecond arrival_seq (history)', () => {
    // 历史回放：user 与 assistant 都用同口径微秒 arrival_seq（≈1.78e15，安全整数内）。
    // 回归：曾因 assistant=纳秒(1e18) / user=毫秒×1000(1e15) 量级差千倍，
    // 导致所有 user 排到所有 assistant 前面（用户滚到底部只看到 assistant）。
    const base = Date.parse('2026-06-28T00:00:00.000Z') * 1000
    const u1 = msg({ id: 'u1', role: 'user', content: 'q1', content_blocks_json: [{ type: 'text', text: 'q1', arrival_seq: base + 10 }] })
    const a1 = msg({ id: 'a1', role: 'assistant', content_blocks_json: [{ type: 'text', text: 'a1', arrival_seq: base + 20 }] })
    const u2 = msg({ id: 'u2', role: 'user', content: 'q2', content_blocks_json: [{ type: 'text', text: 'q2', arrival_seq: base + 30 }] })
    const a2 = msg({ id: 'a2', role: 'assistant', content_blocks_json: [{ type: 'text', text: 'a2', arrival_seq: base + 40 }] })

    const timeline = materializeMessagesForTimeline([a2, u1, a1, u2])
    expect(timeline.map(m => m.id)).toEqual(['u1', 'a1', 'u2', 'a2'])
  })

  it('_timeline_pin_first 任务气泡钉在最前，即便其 created_at 晚于回复块 arrival_seq（乱序根因回归）', () => {
    // 子代理任务气泡（run 输入）无 blocks、created_at 源自 dispatch（可能晚于孙代理块
    // 真实 arrival_seq）。显式 _timeline_pin_first 保证钉首；正文展示靠
    // content_blocks_json text 块，不进 message.blocks，以免打断钉首 passthrough。
    const replySeq = 1783223900853006 // 孙代理块 arrival_seq（真实事件时序，早）
    const task = msg({
      id: 'subagent-task:gc', role: 'user', content: '去做 X',
      created_at: '2026-07-05T03:58:24.085Z', // 晚于 replySeq 对应事件时间
      metadata: { _timeline_pin_first: true } as never,
    })
    const reply = msg({
      id: 'gc-reply', role: 'assistant', content: '', created_at: '2026-07-05T03:58:20.000Z',
      content_blocks_json: [{ type: 'text', text: '我做完了', arrival_seq: replySeq }],
    })
    const timeline = materializeMessagesForTimeline([task, reply])
    expect(timeline.map((m) => m.id)).toEqual(['subagent-task:gc', 'gc-reply'])
  })

  it('normalizes legacy nanosecond assistant arrival against microsecond user (refresh on old data)', () => {
    // 存量回归：旧 assistant 块 arrival_seq 是纳秒(time_ns≈1.78e18)，user 是微秒。
    // 不归一时所有 user(e15) 会排到所有 assistant(e18) 之前 → 滚到底部看不到 user。
    const ms = Date.parse('2026-06-28T00:00:00.000Z')
    const u1 = msg({ id: 'u1', role: 'user', content: 'q1', content_blocks_json: [{ type: 'text', text: 'q1', arrival_seq: ms * 1000 + 10 }] })
    const a1 = msg({ id: 'a1', role: 'assistant', content_blocks_json: [{ type: 'text', text: 'a1', arrival_seq: ms * 1_000_000 + 20_000 }] })
    const u2 = msg({ id: 'u2', role: 'user', content: 'q2', content_blocks_json: [{ type: 'text', text: 'q2', arrival_seq: (ms + 1) * 1000 + 10 }] })
    const a2 = msg({ id: 'a2', role: 'assistant', content_blocks_json: [{ type: 'text', text: 'a2', arrival_seq: (ms + 1) * 1_000_000 + 20_000 }] })

    const timeline = materializeMessagesForTimeline([a2, u2, a1, u1])
    expect(timeline.map(m => m.id)).toEqual(['u1', 'a1', 'u2', 'a2'])
  })

  it('does NOT use query-local block.seq as a global key (legacy multi-turn data)', () => {
    // 回归:旧数据块带 envelope `_seq`(query 内局部、每轮从 0 重置)。曾误把它当
    // 全局排序键 → 两轮 user 的 seq:0 挤到顶、assistant 按局部 seq 交叉错排。
    // 现在 seq 不参与排序,回落 created_at,按轮正确分组。
    const u1 = msg({ id: 'u1', role: 'user', content: 'q1', created_at: '2026-06-28T00:00:00.000Z', content_blocks_json: [{ type: 'text', text: 'q1', seq: 0 }] })
    const a1 = msg({ id: 'a1', role: 'assistant', created_at: '2026-06-28T00:00:01.000Z', content_blocks_json: [{ type: 'text', text: 'a1', seq: 210 }] })
    const u2 = msg({ id: 'u2', role: 'user', content: 'q2', created_at: '2026-06-28T00:01:00.000Z', content_blocks_json: [{ type: 'text', text: 'q2', seq: 0 }] })
    const a2 = msg({ id: 'a2', role: 'assistant', created_at: '2026-06-28T00:01:01.000Z', content_blocks_json: [{ type: 'text', text: 'a2', seq: 5 }] })

    const timeline = materializeMessagesForTimeline([a2, u2, a1, u1])
    expect(timeline.map(m => m.id)).toEqual(['u1', 'a1', 'u2', 'a2'])
  })

  it('tool_result 继承 tool_use 序号:即便 artifact 落在二者原始 arrival 之间也不被拆散', () => {
    // tool_result 自身 arrival=35 晚于 artifact=30,但继承 tool_use(20)→ 与 tool_use
    // 绑定;artifact(30) 落在 tool_use(20) 与末尾 text(50) 之间 → 把 llm 拆成
    // [text,tool_use,tool_result] | artifact | [text],工具卡仍能在首段内配对。
    const llm = msg({
      id: 'llm',
      message_kind: 'llm',
      content_blocks_json: [
        { type: 'text', text: '我来读文件', arrival_seq: 10 },
        { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {}, arrival_seq: 20 },
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'file content', arrival_seq: 35 },
        { type: 'text', text: '读完了', arrival_seq: 50 },
      ],
    })
    const artifact = msg({
      id: 'artifact',
      message_kind: 'tool_artifact',
      content_blocks_json: [
        { type: 'tabtin_rich_content', kind: 'widget', summary: 'artifact', arrival_seq: 30 },
      ],
    })

    const timeline = materializeMessagesForTimeline([artifact, llm])
    expect(timeline.map(m => m.id)).toEqual(['llm', 'artifact', 'llm'])
    expect(timeline[0]?.content_blocks_json?.map(b => b.type)).toEqual([
      'text', 'tool_use', 'tool_result',
    ])
    expect(timeline[2]?.content_blocks_json?.map(b => b.type)).toEqual(['text'])
  })

  it('用户消息：runtime blocks 缺图时物化仍保留 content_blocks_json 附件', () => {
    const imageBlock = {
      type: 'image',
      file_id: 'img-1',
      filename: 'shot.png',
      mime_type: 'image/png',
      source: { type: 'url', url: 'http://127.0.0.1:6061/api/services/oss/local-object?object_key=a.png' },
      arrival_seq: 20,
    }
    const user = msg({
      id: 'u-media',
      role: 'user',
      content: '看图',
      content_blocks_json: [
        { type: 'text', text: '看图', arrival_seq: 10 },
        imageBlock,
      ],
      // 模拟对账后 json 有图、blocks 仍只有 text
      blocks: [{
        index: 0,
        block_id: 'b-text',
        block: { type: 'text', text: '看图', arrival_seq: 10 } as ContentBlockEntry['block'],
        finalized: true,
        partial: false,
      }],
    })
    const timeline = materializeMessagesForTimeline([user])
    expect(timeline).toHaveLength(1)
    expect(timeline[0]?.content_blocks_json?.map((b) => b.type)).toEqual(['text', 'image'])
    expect((timeline[0]?.content_blocks_json?.[1] as { file_id?: string }).file_id).toBe('img-1')
  })

  it('pairs tool_result living in a SEPARATE message back into the tool_use fragment (current architecture)', () => {
    // 当前架构:tool_use 在 assistant 消息,tool_result 在独立合成 user 消息。
    // 跨消息按 tool_use_id 全局配对,tool_result 必须被归并进 tool_use 的 fragment,
    // 否则 BlockTimeline.buildSiblingToolResultMap 拿不到结果 → 工具卡卡「结果正在同步」。
    const assistant = msg({
      id: 'assistant',
      role: 'assistant',
      message_kind: 'llm',
      content_blocks_json: [
        { type: 'thinking', thinking: '我来执行命令', signature: '', arrival_seq: 100 },
        { type: 'tool_use', id: 'toolu_df', name: 'run_terminal_command', input: { command: 'df -h' }, arrival_seq: 200 },
      ],
    })
    const toolResultTurn = msg({
      id: 'tool-result-turn',
      role: 'user',
      content: '',
      content_blocks_json: [
        { type: 'tool_result', tool_use_id: 'toolu_df', content: 'Filesystem Size Used', arrival_seq: 300 },
      ],
    })
    const followup = msg({
      id: 'assistant-2',
      role: 'assistant',
      message_kind: 'llm',
      content_blocks_json: [
        { type: 'text', text: '从 df 结果可以看到…', arrival_seq: 400 },
      ],
    })

    const timeline = materializeMessagesForTimeline([assistant, toolResultTurn, followup])
    // tool_result 被归并进 assistant fragment;合成 user 消息不再单独成片。
    expect(timeline.map(m => m.id)).toEqual(['assistant', 'assistant-2'])
    expect(timeline[0]?.content_blocks_json?.map(b => b.type)).toEqual([
      'thinking',
      'tool_use',
      'tool_result',
    ])
    const result = timeline[0]?.content_blocks_json?.find(b => b.type === 'tool_result') as
      | { tool_use_id?: string }
      | undefined
    expect(result?.tool_use_id).toBe('toolu_df')
  })

})
