/**
 * Wave 2 · 跨轮记忆 · 装填选择器单测。
 *
 * 覆盖方案 §七 里可在纯单元层验证的 E2E 场景：
 * - S1  第 3 轮能看到前 2 轮（单元层退化为：10 条历史被如实保留）
 * - S2  N=10 上限（15 轮里只保留最近 10 条）
 * - S3  tool_call / thinking / tool_result blocks 被过滤
 * - S5  temp-user / temp-ai 占位不被装填
 * - S6  切 session 时的隔离（调用方传 session B 的空数组即可验证）
 *
 * S4（feature flag off）由 `crossTurnMemory.test.ts` 覆盖。
 * S7（重启后回填历史再装填）需要跑动 sendMessageAction + mock IPC，属于
 * 集成测试范畴，见交付报告"未覆盖 TODO"清单。
 */

import { describe, expect, it } from 'vitest'
import type { ChatMessage, MessageBlock } from '@tabtin/chat-client'
import { selectRecentHistoryForRuntime } from '@tabtin/agent-runtime/history'

/**
 * W4c：本测试是 daemon API selectRecentHistoryForRuntime 的契约测试，daemon 端
 * `HistorySourceMessage` 类型用字段名 `blocks_json`（packages/agent-runtime/src/
 * history/types.ts 窄接口）—— renderer 类型 ChatMessage.content_blocks_json
 * 跨边界传入 daemon 前由 sendMessageAction 做字段映射（line 1059-1064）。
 *
 * 测试 fixture 模拟"映射后传入 daemon 的形态"，所以仍用 `blocks_json` 字段名。
 * 类型扩展 `MkOverrides` 包含此字段，避免直接 cast as ChatMessage 时 TS 严格
 * 模式因 ChatMessage 接口已无 blocks_json 字段而报错。
 */
type MkOverrides = Partial<ChatMessage> & { blocks_json?: MessageBlock[] }

function mkUser(id: string, text: string, overrides: MkOverrides = {}): ChatMessage {
  return {
    id,
    role: 'user',
    content: text,
    created_at: '2026-04-19T00:00:00Z',
    ...overrides,
  } as unknown as ChatMessage
}

function mkAssistant(id: string, text: string, overrides: MkOverrides = {}): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: text,
    created_at: '2026-04-19T00:00:00Z',
    ...overrides,
  } as unknown as ChatMessage
}

function mkBlocks(blocks: MessageBlock[]): MessageBlock[] {
  return blocks
}

describe('selectRecentHistoryForRuntime', () => {
  it('compaction_summary · 使用摘要并丢弃边界前旧消息', () => {
    const msgs: ChatMessage[] = [
      mkUser('u1', '旧问题'),
      mkAssistant('a1', '旧回答'),
      mkUser('summary-1', '旧问题和旧回答的摘要', {
        role: 'system',
        message_kind: 'compaction_summary',
        metadata: { compacted_up_to_message_id: 'a1' },
        blocks_json: [{ type: 'text', text: '旧问题和旧回答的摘要' } as MessageBlock],
      }),
      mkUser('u2', '新问题'),
    ]

    const history = selectRecentHistoryForRuntime(msgs, {
      maxMessages: 10,
      excludeCurrentTurn: false,
    })

    expect(String(history[0]?.content)).toContain('旧问题和旧回答的摘要')
    expect(history.some(item => item.content === '旧问题')).toBe(false)
    expect(history.some(item => item.content === '旧回答')).toBe(false)
    expect(history.some(item => item.content === '新问题')).toBe(true)
  })

  it('S1 · 保留多轮 user+assistant 对话（顺序与来源一致）', () => {
    const msgs: ChatMessage[] = [
      mkUser('u1', '你好'),
      mkAssistant('a1', '你好！有什么可以帮你？'),
      mkUser('u2', '我叫 Tina'),
      mkAssistant('a2', '你好 Tina'),
      mkUser('u3', '记得我第一句说什么吗？'),
    ]

    const history = selectRecentHistoryForRuntime(msgs, {
      maxMessages: 10,
      excludeCurrentTurn: false,
    })

    expect(history).toEqual([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好！有什么可以帮你？' },
      { role: 'user', content: '我叫 Tina' },
      { role: 'assistant', content: '你好 Tina' },
      { role: 'user', content: '记得我第一句说什么吗？' },
    ])
  })

  it('S2 · 超过 maxMessages 时保留最后 N 条，丢弃最早的', () => {
    const msgs: ChatMessage[] = []
    for (let i = 1; i <= 15; i++) {
      msgs.push(mkUser(`u${i}`, `user-${i}`))
      msgs.push(mkAssistant(`a${i}`, `asst-${i}`))
    }

    const history = selectRecentHistoryForRuntime(msgs, {
      maxMessages: 10,
      excludeCurrentTurn: false,
    })

    expect(history).toHaveLength(10)
    expect(history[0]).toEqual({ role: 'user', content: 'user-11' })
    expect(history[9]).toEqual({ role: 'assistant', content: 'asst-15' })
  })

  it('S3 · tool_call block 被展开成 assistant(tool_use) + user(tool_result) 对；thinking 被丢弃', () => {
    // Wave 连续对话成熟化 · 事 1 升级：不再"过滤"tool_call，而是展开成
    // LLM wire 协议需要的 tool_use + tool_result 对，Agent 下一轮能精确
    // 看到"上次调了什么工具、拿到什么结果"。
    const msgs: ChatMessage[] = [
      mkUser('u1', '查一下北京天气'),
      mkAssistant('a1', '', {
        blocks_json: mkBlocks([
          { type: 'thinking', content: '思考中…' } as unknown as MessageBlock,
          {
            type: 'tool_call',
            tool_name: 'web_search',
            tool_call_id: 'toolu_abc',
            args_summary: 'q=北京天气',
            input: { q: '北京天气' },
            output: '{"temp": 25, "weather": "晴"}',
          } as unknown as MessageBlock,
          { type: 'text', text: '北京今天 25 度，晴。' },
        ]),
      }),
      mkUser('u2', '那东京呢？'),
    ]

    const history = selectRecentHistoryForRuntime(msgs, {
      maxMessages: 10,
      excludeCurrentTurn: false,
    })

    // 预期（W4.3 顺序保留修复后）：
    //   user("查一下北京天气")
    //   assistant([tool_use(id=toolu_abc, ...), text("北京今天...")])
    //     ↑ content_blocks_json 顺序是 [thinking, tool_call, text] → thinking 丢，按出现顺序输出
    //   user([tool_result(tool_use_id=toolu_abc, content='{"temp": 25, "weather": "晴"}')])
    //   user("那东京呢？")
    expect(history).toHaveLength(4)

    expect(history[0]).toEqual({ role: 'user', content: '查一下北京天气' })

    // assistant：按 content_blocks_json 出现顺序保留（W4.3 改 unshift→push）；thinking 丢
    const asst = history[1]!
    expect(asst.role).toBe('assistant')
    expect(Array.isArray(asst.content)).toBe(true)
    const asstBlocks = asst.content as Array<Record<string, unknown>>
    expect(asstBlocks).toHaveLength(2)
    expect(asstBlocks[0]).toMatchObject({
      type: 'tool_use',
      id: 'toolu_abc',
      name: 'web_search',
      input: { q: '北京天气' },
    })
    expect(asstBlocks[1]).toEqual({ type: 'text', text: '北京今天 25 度，晴。' })

    // 紧跟一条合成的 user，承载 tool_result
    const synthUser = history[2]!
    expect(synthUser.role).toBe('user')
    expect(Array.isArray(synthUser.content)).toBe(true)
    const synthBlocks = synthUser.content as Array<Record<string, unknown>>
    expect(synthBlocks).toHaveLength(1)
    expect(synthBlocks[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'toolu_abc',
    })
    // output 是对象 → JSON 字符串化
    expect(synthBlocks[0]!.content).toBe('{"temp": 25, "weather": "晴"}')

    expect(history[3]).toEqual({ role: 'user', content: '那东京呢？' })
  })

  it('S3-bis · tool_use_id 严格保留 LLM 原生 id（不重写）', () => {
    const nativeId = 'toolu_01ABCDEfghIJKL12345'
    const msgs: ChatMessage[] = [
      mkUser('u', 'q'),
      mkAssistant('a', '', {
        blocks_json: mkBlocks([
          { type: 'tool_call', tool_name: 'grep', tool_call_id: nativeId, input: {}, output: 'match' } as unknown as MessageBlock,
        ]),
      }),
    ]
    const history = selectRecentHistoryForRuntime(msgs, {
      maxMessages: 10,
      excludeCurrentTurn: false,
    })
    // assistant 的 tool_use.id 与 user 的 tool_result.tool_use_id 都 === nativeId
    const asstBlocks = history[1]!.content as Array<Record<string, unknown>>
    const trBlocks = history[2]!.content as Array<Record<string, unknown>>
    expect(asstBlocks[0]!.id).toBe(nativeId)
    expect(trBlocks[0]!.tool_use_id).toBe(nativeId)
  })

  it('S3-ter · tool_use 错误（error=true）→ tool_result.is_error 保留', () => {
    const msgs: ChatMessage[] = [
      mkUser('u', 'q'),
      mkAssistant('a', '', {
        blocks_json: mkBlocks([
          {
            type: 'tool_call',
            tool_name: 'grep',
            tool_call_id: 'tc-err',
            input: {},
            output: 'tool crashed',
            error: true,
          } as unknown as MessageBlock,
        ]),
      }),
    ]
    const history = selectRecentHistoryForRuntime(msgs, {
      maxMessages: 10,
      excludeCurrentTurn: false,
    })
    const trBlocks = history[2]!.content as Array<Record<string, unknown>>
    expect(trBlocks[0]!.is_error).toBe(true)
  })

  it('S3-quater · filterUnresolvedToolUses · "所有 tool_use 都无 tool_result" 的 assistant 整条丢', () => {
    // 构造场景：用户中断 Agent 生成，assistant 发了 tool_use 但还没回 tool_result
    // 就被打断。由于 tool_call block 在 content_blocks_json 里一个 block 就同时承载
    // tool_use + tool_result（合成），这种"半闭环"在 ChatMessage 层不会出现——
    // 但如果未来 content_blocks_json 形态升级或 Django 回填数据异常，filterUnresolvedToolUses
    // 仍会兜底。这里通过直接构造展开后同 id 分布不闭环的场景来覆盖该函数。
    //
    // 通过 Mock 一个 assistant 带"无 output 字段"的 tool_call 触发半闭环：
    // 实际上 expandAssistantFromBlocks 对 output=undefined 会生成 content=''
    // 的 tool_result，这**是闭环**（有对应 tool_result 块）。所以此处测试改为
    // 直接用 filterUnresolvedToolUses 验证——更适合放 filterUnresolvedToolUses
    // 的独立测试文件里。见 filterUnresolvedToolUses.test.ts。
    //
    // 这里仅验证：正常 tool 链场景下 filter 不误伤。
    const msgs: ChatMessage[] = [
      mkUser('u', 'q'),
      mkAssistant('a', '', {
        blocks_json: mkBlocks([
          { type: 'tool_call', tool_name: 'grep', tool_call_id: 'tc-ok', input: {}, output: 'match' } as unknown as MessageBlock,
        ]),
      }),
    ]
    const history = selectRecentHistoryForRuntime(msgs, {
      maxMessages: 10,
      excludeCurrentTurn: false,
    })
    // 正常闭环 → 消息完整保留
    expect(history.find(m => m.role === 'assistant')).toBeDefined()
    expect(history.find(m => m.role === 'user' && Array.isArray(m.content))).toBeDefined()
  })

  it('S3.1 · text blocks 为空或缺失时回落到 ChatMessage.content', () => {
    const msgs: ChatMessage[] = [
      mkUser('u1', '老格式纯文本消息', {
        blocks_json: undefined,
      }),
      mkAssistant('a1', '老格式纯文本回复'),
    ]

    const history = selectRecentHistoryForRuntime(msgs, {
      maxMessages: 10,
      excludeCurrentTurn: false,
    })

    expect(history).toEqual([
      { role: 'user', content: '老格式纯文本消息' },
      { role: 'assistant', content: '老格式纯文本回复' },
    ])
  })

  it('S3.2 · 多个 text blocks 按出现顺序保留（W4.3 改 unshift+join → 顺序 push），thinking 丢弃', () => {
    const msgs: ChatMessage[] = [
      mkAssistant('a1', '', {
        blocks_json: mkBlocks([
          { type: 'text', text: '第一段' },
          { type: 'thinking', content: '中间思考' } as unknown as MessageBlock,
          { type: 'text', text: '第二段' },
        ]),
      }),
    ]

    const history = selectRecentHistoryForRuntime(msgs, {
      maxMessages: 10,
      excludeCurrentTurn: false,
    })

    // W4.3 顺序保留修复：每个 text block 单独 push（不再 join '\n\n' 然后 unshift）。
    // 无 tool_use 时 content 是 `[{type:'text', text:'第一段'}, {type:'text', text:'第二段'}]`。
    // thinking 丢；最终 2 条独立 text block。Anthropic API 接受多 text block，
    // 语义跟单 text("第一段\n\n第二段") 等价。
    expect(history).toHaveLength(1)
    const asst = history[0]!
    expect(asst.role).toBe('assistant')
    expect(Array.isArray(asst.content)).toBe(true)
    const blocks = asst.content as Array<Record<string, unknown>>
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toEqual({ type: 'text', text: '第一段' })
    expect(blocks[1]).toEqual({ type: 'text', text: '第二段' })
    // thinking 不在输出里
    expect(blocks.every(b => b.type !== 'thinking')).toBe(true)
  })

  it('S5 · W4.3.2 修复：currentUserMessageId 精确匹配 temp-user 才剔除（不再 startsWith 兜底）', () => {
    // 历史背景：旧实现用 `id.startsWith('temp-')` 兜底剔除任何 temp-* id 的
    // ChatMessage——结果误杀前几轮还没 ack 的 temp-ai-* assistant，dogfood
    // W4 第二轮 history 完全丢失（详见 docs/cross-turn-memory-decoupling.md
    // line 19 + select-recent-history.ts isCurrentTurnPlaceholder 注释）。
    //
    // 修复后行为：只有 `id === currentUserMessageId` 的那条被剔除；其他 temp-*
    // 都保留（前几轮没 ack 的 temp-* 是真实 history）。本测试体现新语义。
    const msgs: ChatMessage[] = [
      mkUser('real-1', '历史 user 1'),
      mkAssistant('real-2', '历史 assistant 1'),
      mkUser('temp-user-1700000000-abcd', '本轮 user 占位'),
      mkAssistant('temp-ai-1700000000-abcd', ''),
    ]

    // 不传 currentUserMessageId → 本轮 user 也不被剔除（调用方应该传 id）
    const history = selectRecentHistoryForRuntime(msgs, {
      maxMessages: 10,
      excludeCurrentTurn: true,
    })
    // 前两条历史 + 本轮 temp-user 都保留（temp-ai 因 content 空被自然排除）
    expect(history.map(m => m.content)).toEqual([
      '历史 user 1',
      '历史 assistant 1',
      '本轮 user 占位',
    ])

    // 传 currentUserMessageId → 本轮 user 被精确剔除
    const historyWithId = selectRecentHistoryForRuntime(msgs, {
      maxMessages: 10,
      excludeCurrentTurn: true,
      currentUserMessageId: 'temp-user-1700000000-abcd',
    })
    expect(historyWithId).toEqual([
      { role: 'user', content: '历史 user 1' },
      { role: 'assistant', content: '历史 assistant 1' },
    ])
  })

  it('S5.1 · excludeCurrentTurn=true 时用 currentUserMessageId 排除已 sync server_id 的本轮 user', () => {
    const msgs: ChatMessage[] = [
      mkUser('real-1', '历史 user 1'),
      mkAssistant('real-2', '历史 assistant 1'),
      // 本轮 user 已被 relay ACK 回来替换成 server_id（不再带 temp- 前缀）
      mkUser('server-uuid-current', '本轮 user 发送中'),
    ]

    const history = selectRecentHistoryForRuntime(msgs, {
      maxMessages: 10,
      excludeCurrentTurn: true,
      currentUserMessageId: 'server-uuid-current',
    })

    expect(history.map(m => m.content)).toEqual(['历史 user 1', '历史 assistant 1'])
  })

  it('S5.2 · excludeCurrentTurn=false 时保留占位消息（兼容 fork/debug 场景）', () => {
    const msgs: ChatMessage[] = [
      mkUser('real-1', '历史 user'),
      mkUser('temp-user-999', '本轮占位'),
    ]

    const history = selectRecentHistoryForRuntime(msgs, {
      maxMessages: 10,
      excludeCurrentTurn: false,
    })

    expect(history.map(m => m.content)).toEqual(['历史 user', '本轮占位'])
  })

  it('S6 · 空 messages（例如切到新 session）返回空数组', () => {
    const history = selectRecentHistoryForRuntime([], {
      maxMessages: 10,
      excludeCurrentTurn: true,
    })
    expect(history).toEqual([])
  })

  it('边界 · 丢弃空串消息（不给 LLM 喂空 content）', () => {
    const msgs: ChatMessage[] = [
      mkUser('u1', '有内容的 user'),
      mkAssistant('a1', '', { blocks_json: mkBlocks([{ type: 'tool_call', tool_name: 'x' } as unknown as MessageBlock]) }),
      mkAssistant('a2', '   \n\n   ', {}),
      mkUser('u2', '最后一条'),
    ]

    const history = selectRecentHistoryForRuntime(msgs, {
      maxMessages: 10,
      excludeCurrentTurn: false,
    })

    expect(history).toEqual([
      { role: 'user', content: '有内容的 user' },
      { role: 'user', content: '最后一条' },
    ])
  })

  it('边界 · 过滤掉 system / tool role（ChatMessage 允许但 Engine Message 只接受 user/assistant）', () => {
    const msgs: ChatMessage[] = [
      mkUser('u1', '有效'),
      { id: 's1', role: 'system', content: '系统提示', created_at: '' } as ChatMessage,
      { id: 't1', role: 'tool', content: '工具输出', created_at: '' } as ChatMessage,
      mkAssistant('a1', '有效回复'),
    ]

    const history = selectRecentHistoryForRuntime(msgs, {
      maxMessages: 10,
      excludeCurrentTurn: false,
    })

    expect(history).toEqual([
      { role: 'user', content: '有效' },
      { role: 'assistant', content: '有效回复' },
    ])
  })

  it('Review B P1 · tool_call 缺 tool_name 时整块丢（不生成 tool_use + tool_result 对）', () => {
    // 原实现会用 'unknown' 回落 → LLM 下一轮看到"自己调了 unknown 工具"幻觉。
    // 修复后：整块丢，同 assistant 的 text 仍保留。
    const msgs: ChatMessage[] = [
      mkUser('u1', 'q'),
      mkAssistant('a1', '', {
        blocks_json: mkBlocks([
          { type: 'text', text: '我回答一下' },
          {
            type: 'tool_call',
            tool_call_id: 'tc-no-name',
            // 故意缺 tool_name
            input: {},
            output: 'result',
          } as unknown as MessageBlock,
        ]),
      }),
    ]

    const history = selectRecentHistoryForRuntime(msgs, {
      maxMessages: 10,
      excludeCurrentTurn: false,
    })

    // 只生成一条 assistant（text），无 tool_use / tool_result 对
    expect(history).toHaveLength(2)
    expect(history[0]!.role).toBe('user')
    expect(history[1]!.role).toBe('assistant')
    const asstBlocks = history[1]!.content as Array<Record<string, unknown>>
    expect(asstBlocks).toHaveLength(1)
    expect(asstBlocks[0]).toEqual({ type: 'text', text: '我回答一下' })
  })

  it('边界 · maxMessages<=0 返回空数组', () => {
    const msgs: ChatMessage[] = [mkUser('u1', 'x')]
    expect(selectRecentHistoryForRuntime(msgs, { maxMessages: 0, excludeCurrentTurn: false })).toEqual([])
    expect(selectRecentHistoryForRuntime(msgs, { maxMessages: -1, excludeCurrentTurn: false })).toEqual([])
  })
})
