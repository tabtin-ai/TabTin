/**
 * replaySubagentMessages.test.ts — PRD §4.18 子 Agent envelope 重放 + 合并回归
 *
 * 测什么：
 *   - applyEnvelopeEvent 增量：message_start / content_block_start / _delta / _stop
 *   - 幂等：同 message_id message_start 不重复建
 *   - tool_use input_json_delta 累积后 stop 时 JSON.parse
 *   - tool_result 块回填到对应 tool_use 卡片（不单独成块、不冒 [未知 block] 噪声）
 *   - selectReplayMessages 每次新 array 引用 + 过滤空 user 消息（tool_result 空壳）
 *   - replaySubagentMessages batch + firstUserMessageIndex
 *   - mergeReplayMessages（review C.1 修复核心）：
 *       · live 覆盖同 id（更新鲜）
 *       · live 独有追加在后
 *       · 任一为空时返回另一方
 *       · 「jsonl 50 条 + live 5 条」不截断（合并后 ≥ 50）
 */
import { describe, it, expect } from 'vitest'
import {
  createInitialReplayState,
  applyEnvelopeEvent,
  selectReplayMessages,
  replaySubagentMessages,
} from '../replaySubagentMessages'

function msgStart(id: string, role: 'user' | 'assistant' = 'assistant') {
  return { type: 'agent.stream.message_start', payload: { message_id: id, role } }
}
function blockStart(id: string, index: number, block: Record<string, unknown>) {
  return { type: 'agent.stream.content_block_start', payload: { message_id: id, index, block } }
}
function blockDelta(id: string, index: number, delta: Record<string, unknown>) {
  return { type: 'agent.stream.content_block_delta', payload: { message_id: id, index, delta } }
}
function blockStop(id: string, index: number) {
  return { type: 'agent.stream.content_block_stop', payload: { message_id: id, index } }
}

describe('applyEnvelopeEvent 增量', () => {
  it('message_start + text delta 累积', () => {
    const s = createInitialReplayState()
    applyEnvelopeEvent(s, msgStart('m1'))
    applyEnvelopeEvent(s, blockStart('m1', 0, { type: 'text', text: '' }))
    applyEnvelopeEvent(s, blockDelta('m1', 0, { type: 'text_delta', text: 'foo' }))
    applyEnvelopeEvent(s, blockDelta('m1', 0, { type: 'text_delta', text: 'bar' }))
    const msgs = selectReplayMessages(s)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toBe('foobar')
  })

  it('#3005 流式：content_block_stop 前 finalized=false，tool_use 带 pendingInputJson；stop 后收敛', () => {
    const s = createInitialReplayState()
    applyEnvelopeEvent(s, msgStart('m1'))
    applyEnvelopeEvent(s, blockStart('m1', 0, { type: 'text', text: '' }))
    applyEnvelopeEvent(s, blockDelta('m1', 0, { type: 'text_delta', text: 'partial' }))
    applyEnvelopeEvent(s, blockStart('m1', 1, { type: 'tool_use', id: 'tu1', name: 'read', input: {} }))
    applyEnvelopeEvent(s, blockDelta('m1', 1, { type: 'input_json_delta', partial_json: '{"path":' }))

    const streaming = selectReplayMessages(s)[0]
    expect(streaming.blocks![0].finalized).toBe(false) // text 流式中
    expect(streaming.blocks![1].finalized).toBe(false) // tool_use 流式中
    expect(streaming.blocks![1].pendingInputJson).toBe('{"path":') // 参数流式可见

    applyEnvelopeEvent(s, blockDelta('m1', 1, { type: 'input_json_delta', partial_json: '"/a"}' }))
    applyEnvelopeEvent(s, blockStop('m1', 1))
    applyEnvelopeEvent(s, blockStop('m1', 0))
    const done = selectReplayMessages(s)[0]
    expect(done.blocks![0].finalized).toBe(true)
    expect(done.blocks![1].finalized).toBe(true)
    expect(done.blocks![1].pendingInputJson).toBeUndefined()
    expect((done.blocks![1].block as { input: unknown }).input).toEqual({ path: '/a' })
  })

  it('#3005 阶段 3：子代理消息挂 blocks（SSoT 读模型），与 content_blocks_json 同构', () => {
    const s = createInitialReplayState()
    applyEnvelopeEvent(s, msgStart('m1'))
    applyEnvelopeEvent(s, blockStart('m1', 0, { type: 'text', text: '' }))
    applyEnvelopeEvent(s, blockDelta('m1', 0, { type: 'text_delta', text: 'hi' }))
    const msgs = selectReplayMessages(s)
    expect(msgs[0].blocks).toBeDefined()
    expect(msgs[0].blocks).toHaveLength(1)
    expect((msgs[0].blocks![0].block as { type: string; text: string })).toMatchObject({
      type: 'text',
      text: 'hi',
    })
  })

  it('#3005 子代理块 stamp runtime 的 payload.arrival_seq（只读不造）', () => {
    const s = createInitialReplayState()
    applyEnvelopeEvent(s, msgStart('m1'))
    // runtime 盖在 payload.arrival_seq 的权威值 → 原样透传到块
    applyEnvelopeEvent(s, { type: 'agent.stream.content_block_start', payload: { message_id: 'm1', index: 0, arrival_seq: 4242, block: { type: 'text', text: 'a' } } })
    // 无 arrival_seq（理论不会发生）→ 不盖，交给 created_at 兜底
    applyEnvelopeEvent(s, blockStart('m1', 1, { type: 'text', text: 'b' }))
    const blocks = selectReplayMessages(s)[0].blocks!
    expect((blocks[0].block as { arrival_seq?: number }).arrival_seq).toBe(4242)
    expect((blocks[1].block as { arrival_seq?: number }).arrival_seq).toBeUndefined()
  })

  it('非连续 envelope index 不制造稀疏 blocks，后续 delta/stop 仍按原 index 命中', () => {
    const s = createInitialReplayState()
    applyEnvelopeEvent(s, msgStart('m1'))
    applyEnvelopeEvent(s, blockStart('m1', 1, { type: 'text', text: '' }))
    applyEnvelopeEvent(s, blockDelta('m1', 1, { type: 'text_delta', text: 'hi' }))
    applyEnvelopeEvent(s, blockStop('m1', 1))

    const msg = selectReplayMessages(s)[0]
    expect(msg.content).toBe('hi')
    expect(msg.content_blocks_json).toHaveLength(1)
    expect(msg.blocks).toHaveLength(1)
    expect(0 in msg.blocks!).toBe(true)
    expect(msg.blocks![0].finalized).toBe(true)
    expect((msg.blocks![0].block as { text?: string }).text).toBe('hi')
  })

  it('message_start 幂等（同 id 不重复建）', () => {
    const s = createInitialReplayState()
    applyEnvelopeEvent(s, msgStart('m1'))
    applyEnvelopeEvent(s, msgStart('m1'))
    expect(selectReplayMessages(s)).toHaveLength(1)
  })

  it('thinking_delta 累积到 thinking block', () => {
    const s = createInitialReplayState()
    applyEnvelopeEvent(s, msgStart('m1'))
    applyEnvelopeEvent(s, blockStart('m1', 0, { type: 'thinking', thinking: '' }))
    applyEnvelopeEvent(s, blockDelta('m1', 0, { type: 'thinking_delta', thinking: '想一下' }))
    const block = selectReplayMessages(s)[0].content_blocks_json?.[0] as { type: string; thinking?: string }
    expect(block.type).toBe('thinking')
    expect(block.thinking).toBe('想一下')
  })

  it('tool_use input_json_delta 累积 + stop 时 JSON.parse', () => {
    const s = createInitialReplayState()
    applyEnvelopeEvent(s, msgStart('m1'))
    applyEnvelopeEvent(s, blockStart('m1', 0, { type: 'tool_use', id: 'tu1', name: 'read_file' }))
    applyEnvelopeEvent(s, blockDelta('m1', 0, { type: 'input_json_delta', partial_json: '{"path":' }))
    applyEnvelopeEvent(s, blockDelta('m1', 0, { type: 'input_json_delta', partial_json: '"/x"}' }))
    applyEnvelopeEvent(s, blockStop('m1', 0))
    const block = selectReplayMessages(s)[0].content_blocks_json?.[0] as { type: string; input?: unknown }
    expect(block.type).toBe('tool_use')
    expect(block.input).toEqual({ path: '/x' })
  })

  it('tool_use input_json 解析失败时保留 raw 字符串', () => {
    const s = createInitialReplayState()
    applyEnvelopeEvent(s, msgStart('m1'))
    applyEnvelopeEvent(s, blockStart('m1', 0, { type: 'tool_use', id: 'tu1', name: 'x' }))
    applyEnvelopeEvent(s, blockDelta('m1', 0, { type: 'input_json_delta', partial_json: '{bad json' }))
    applyEnvelopeEvent(s, blockStop('m1', 0))
    const block = selectReplayMessages(s)[0].content_blocks_json?.[0] as { input?: unknown }
    expect(block.input).toBe('{bad json')
  })

  it('缺 message_id / type 的事件 silent skip', () => {
    const s = createInitialReplayState()
    applyEnvelopeEvent(s, { type: 'agent.stream.message_start', payload: {} })
    applyEnvelopeEvent(s, { payload: { message_id: 'x' } })
    applyEnvelopeEvent(s, null)
    expect(selectReplayMessages(s)).toHaveLength(0)
  })

  it('selectReplayMessages 每次新 array 引用', () => {
    const s = createInitialReplayState()
    applyEnvelopeEvent(s, msgStart('m1'))
    const a = selectReplayMessages(s)
    const b = selectReplayMessages(s)
    expect(a).not.toBe(b)
  })

  // 回归：「子 Agent 详情只显示首个 token（范围）」根因——
  // applyEnvelopeEvent in-place 改 block.text + content_blocks_json 数组引用恒定，
  // 若 select 透传同一数组引用，下游以「引用 + length」memo 的 MessageBubble 会
  // 冻结在首个 delta 的快照。select 必须每次产出全新 content_blocks_json 数组 +
  // 全新 block 对象，且反映最新累积文本。
  it('文字块 in-place 增长后，select 产出全新 content_blocks_json 引用 + 最新文本', () => {
    const s = createInitialReplayState()
    applyEnvelopeEvent(s, msgStart('m1'))
    applyEnvelopeEvent(s, blockStart('m1', 0, { type: 'thinking', thinking: '' }))
    applyEnvelopeEvent(s, blockDelta('m1', 0, { type: 'thinking_delta', thinking: '想完了' }))
    applyEnvelopeEvent(s, blockStart('m1', 1, { type: 'text', text: '' }))
    applyEnvelopeEvent(s, blockDelta('m1', 1, { type: 'text_delta', text: '范围' }))

    const first = selectReplayMessages(s)
    expect(first[0].content).toBe('范围')
    const firstBlocks = first[0].content_blocks_json

    // 继续追加文本（in-place 改 state 里的 block）
    applyEnvelopeEvent(s, blockDelta('m1', 1, { type: 'text_delta', text: '：回复数字1' }))

    const second = selectReplayMessages(s)
    // 数组引用必须变化（否则下游 useMemo 不会重算）
    expect(second[0].content_blocks_json).not.toBe(firstBlocks)
    // 且反映最新累积文本，而非冻结在「范围」
    expect(second[0].content).toBe('范围：回复数字1')
    const textBlock = second[0].content_blocks_json?.[1] as { type: string; text?: string }
    expect(textBlock.type).toBe('text')
    expect(textBlock.text).toBe('范围：回复数字1')
  })

  it('select 产出的 block 是快照，不随后续 in-place 修改而变', () => {
    const s = createInitialReplayState()
    applyEnvelopeEvent(s, msgStart('m1'))
    applyEnvelopeEvent(s, blockStart('m1', 0, { type: 'text', text: '' }))
    applyEnvelopeEvent(s, blockDelta('m1', 0, { type: 'text_delta', text: 'A' }))
    const snap = selectReplayMessages(s)
    const snapBlock = snap[0].content_blocks_json?.[0] as { text?: string }
    expect(snapBlock.text).toBe('A')
    // 后续 in-place 增长不应回写到已取出的快照
    applyEnvelopeEvent(s, blockDelta('m1', 0, { type: 'text_delta', text: 'B' }))
    expect(snapBlock.text).toBe('A')
  })
})

describe('tool_result 作为 native 块合并到 tool_use message（与 cold 结构统一）', () => {
  it('tool_result 作为 native tool_result 块 append 到 tool_use 所在 message，空 user 消息被过滤', () => {
    const s = createInitialReplayState()
    // assistant 消息：tool_use
    applyEnvelopeEvent(s, msgStart('asst', 'assistant'))
    applyEnvelopeEvent(s, blockStart('asst', 0, { type: 'tool_use', id: 'run_terminal_command:0', name: 'run_terminal_command' }))
    applyEnvelopeEvent(s, blockStop('asst', 0))
    // user 消息：tool_result（独立消息，content 是完整字符串、不走 delta）
    applyEnvelopeEvent(s, msgStart('tr', 'user'))
    applyEnvelopeEvent(s, blockStart('tr', 0, { type: 'tool_result', tool_use_id: 'run_terminal_command:0', content: '{"exit_code":0}' }))

    const msgs = selectReplayMessages(s)
    // 承载 tool_result 的空 user 消息被过滤 → 只剩 assistant（含 tool_use + tool_result 两块）
    expect(msgs).toHaveLength(1)
    const blocks = msgs[0].content_blocks_json as Array<Record<string, unknown>>
    expect(blocks).toHaveLength(2)
    expect(blocks[0].type).toBe('tool_use')
    expect(blocks[1].type).toBe('tool_result')
    expect(blocks[1].tool_use_id).toBe('run_terminal_command:0')
    expect(blocks[1].content).toBe('{"exit_code":0}')
    expect(blocks[1].is_error).toBe(false)
  })

  it('同 tool_use_id 跨消息重复（agent_0）：两个 result 各自 append 到自己的 message（首个未配对 FIFO）', () => {
    // 复现子 Agent 跨多轮派孙 Agent：两个 agent_0 tool_use 分处不同 assistant 消息，
    // 两个 agent_0 tool_result 顺序到达。append 到「首个尚无同 id tool_result」的 message，
    // 各得其所（与 cold chat_message + BlockTimeline 同 message 配对口径一致）。
    const s = createInitialReplayState()
    applyEnvelopeEvent(s, msgStart('a1', 'assistant'))
    applyEnvelopeEvent(s, blockStart('a1', 0, { type: 'tool_use', id: 'agent_0', name: 'agent' }))
    applyEnvelopeEvent(s, blockStop('a1', 0))
    applyEnvelopeEvent(s, msgStart('tr1', 'user'))
    applyEnvelopeEvent(s, blockStart('tr1', 0, { type: 'tool_result', tool_use_id: 'agent_0', content: '孙A结果' }))
    applyEnvelopeEvent(s, msgStart('a2', 'assistant'))
    applyEnvelopeEvent(s, blockStart('a2', 0, { type: 'tool_use', id: 'agent_0', name: 'agent' }))
    applyEnvelopeEvent(s, blockStop('a2', 0))
    applyEnvelopeEvent(s, msgStart('tr2', 'user'))
    applyEnvelopeEvent(s, blockStart('tr2', 0, { type: 'tool_result', tool_use_id: 'agent_0', content: '孙B结果' }))

    const msgs = selectReplayMessages(s)
    const tr1 = (msgs[0].content_blocks_json as Array<Record<string, unknown>>).find(b => b.type === 'tool_result')
    const tr2 = (msgs[1].content_blocks_json as Array<Record<string, unknown>>).find(b => b.type === 'tool_result')
    expect(tr1?.content).toBe('孙A结果')
    expect(tr2?.content).toBe('孙B结果')
  })

  it('tool_result is_error=true 时 native 块带 is_error', () => {
    const s = createInitialReplayState()
    applyEnvelopeEvent(s, msgStart('asst', 'assistant'))
    applyEnvelopeEvent(s, blockStart('asst', 0, { type: 'tool_use', id: 'tc:1', name: 'x' }))
    applyEnvelopeEvent(s, blockStop('asst', 0))
    applyEnvelopeEvent(s, msgStart('tr', 'user'))
    applyEnvelopeEvent(s, blockStart('tr', 0, { type: 'tool_result', tool_use_id: 'tc:1', content: 'boom', is_error: true }))
    const blocks = selectReplayMessages(s)[0].content_blocks_json as Array<Record<string, unknown>>
    const tr = blocks.find(b => b.type === 'tool_result')
    expect(tr?.content).toBe('boom')
    expect(tr?.is_error).toBe(true)
  })

  it('不再产出 [未知 block: tool_result] 噪声文本', () => {
    const s = createInitialReplayState()
    applyEnvelopeEvent(s, msgStart('asst', 'assistant'))
    applyEnvelopeEvent(s, blockStart('asst', 0, { type: 'tool_use', id: 'tc:1', name: 'x' }))
    applyEnvelopeEvent(s, blockStop('asst', 0))
    applyEnvelopeEvent(s, msgStart('tr', 'user'))
    applyEnvelopeEvent(s, blockStart('tr', 0, { type: 'tool_result', tool_use_id: 'tc:1', content: 'ok' }))
    const allText = selectReplayMessages(s)
      .flatMap(m => m.content_blocks_json ?? [])
      .map(b => (b as { text?: string }).text ?? '')
      .join('')
    expect(allText).not.toContain('未知 block')
  })

  it('tool_result 找不到匹配 tool_use 时丢弃（不报错、不渲染噪声）', () => {
    const s = createInitialReplayState()
    applyEnvelopeEvent(s, msgStart('tr', 'user'))
    applyEnvelopeEvent(s, blockStart('tr', 0, { type: 'tool_result', tool_use_id: 'missing', content: 'x' }))
    // 空 user 消息（tool_result 被丢弃）→ 过滤后 0 条
    expect(selectReplayMessages(s)).toHaveLength(0)
  })

  it('selectReplayMessages 过滤空 user 消息但保留有文本的（task prompt）', () => {
    const s = createInitialReplayState()
    applyEnvelopeEvent(s, msgStart('task', 'user'))
    applyEnvelopeEvent(s, blockStart('task', 0, { type: 'text', text: '' }))
    applyEnvelopeEvent(s, blockDelta('task', 0, { type: 'text_delta', text: '干活' }))
    applyEnvelopeEvent(s, msgStart('empty', 'user')) // 空壳 user（模拟 tool_result 回填后）
    const msgs = selectReplayMessages(s)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toBe('干活')
  })
})

describe('replaySubagentMessages batch', () => {
  it('firstUserMessageIndex 指向第一条 user message', () => {
    const lines = [
      msgStart('inherit-1', 'assistant'),
      msgStart('inherit-2', 'assistant'),
      msgStart('task', 'user'),
      // task prompt 带文本（真实数据里 user 消息恒有内容；空 user 会被过滤）
      blockStart('task', 0, { type: 'text', text: '' }),
      blockDelta('task', 0, { type: 'text_delta', text: '任务描述' }),
      msgStart('reply', 'assistant'),
    ]
    const { messages, firstUserMessageIndex } = replaySubagentMessages(lines)
    expect(messages).toHaveLength(4)
    expect(firstUserMessageIndex).toBe(2)
  })

  it('无 user message → firstUserMessageIndex = -1', () => {
    const { firstUserMessageIndex } = replaySubagentMessages([msgStart('m1', 'assistant')])
    expect(firstUserMessageIndex).toBe(-1)
  })
})

// 注：原 `mergeReplayMessages` 双源合并已于 2026-05-29 移除——subagent
// messages.jsonl 的合成 message_id（`local-...`）与 live 的真实 envelope id 永不
// 相等，按 id 去重失效会导致同一条回复重复显示（dogfood「重复显示回复」根因）。
// SubagentDetailPane 改为「live 优先 / jsonl 冷兜底」二选一，逻辑过于简单无需单测。
// 下方两类核心 reducer（applyEnvelopeEvent 增量 + replaySubagentMessages batch）仍有
// 完整覆盖。
