/**
 * chatMessageContextUsage —— 单元测试。
 *
 * 验证「上下文用量环」的核心派生逻辑：
 *
 *   1. last_* 字段优先于 turn 累加字段；
 *   2. 全 0 placeholder usage 跳过（第三方 LLM 在 message_start 阶段会发空 usage）；
 *   3. 倒序找最近一条带真实 usage 的 assistant；
 *   4. anchor + 之后消息 rough estimate 公式正确；
 *   5. draft 文本估算累加；
 *   6. output_tokens 不计入「输入侧」分子。
 */

import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import {
  getCurrentUsage,
  getCurrentUsageSource,
  inputSideTokens,
  getCurrentContextTokens,
  estimateTextTokens,
  __testOnly,
} from '../chatMessageContextUsage'

const { extractMessageUsage, chatMessageToRuntimeMessage } = __testOnly

function mkAssistant(metadata: Record<string, unknown> | null, content = ''): ChatMessage {
  return {
    id: `assist-${Math.random().toString(36).slice(2, 8)}`,
    role: 'assistant',
    content,
    created_at: new Date().toISOString(),
    metadata,
  }
}

function mkUser(content = ''): ChatMessage {
  return {
    id: `user-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content,
    created_at: new Date().toISOString(),
  }
}

/**
 * 构造带 usage_json（服务端落库的权威源）的 assistant 消息——可同时挂 metadata
 * 模拟「重开对话：usage_json 有值、metadata 只有账务字段」的真实形态。
 */
function mkAssistantUsageJson(
  usageJson: Record<string, unknown> | null,
  metadata: Record<string, unknown> | null = null,
  content = '',
): ChatMessage {
  return {
    id: `assist-${Math.random().toString(36).slice(2, 8)}`,
    role: 'assistant',
    content,
    created_at: new Date().toISOString(),
    metadata,
    usage_json: usageJson,
  } as ChatMessage
}

function mkSubagentAssistantUsageJson(
  usageJson: Record<string, unknown> | null,
  content = '',
): ChatMessage {
  return {
    ...mkAssistantUsageJson(usageJson, null, content),
    subagent_run_id: 'subagent-run-1',
  } as ChatMessage
}

describe('extractMessageUsage', () => {
  it('returns null for non-assistant messages', () => {
    expect(extractMessageUsage(mkUser('hello'))).toBeNull()
  })

  it('returns null for assistant without metadata', () => {
    expect(extractMessageUsage(mkAssistant(null))).toBeNull()
  })

  it('prefers last_* fields over turn-cumulative fields', () => {
    // turn 累加 1500，last 单次 500 —— 应该用 500（最后一次 LLM 调用的真实上下文）
    const usage = extractMessageUsage(
      mkAssistant({
        input_tokens: 1500,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 0,
        last_input_tokens: 500,
        last_cache_read_input_tokens: 100,
        last_cache_creation_input_tokens: 50,
      }),
    )
    expect(usage).toEqual({
      inputTokens: 500,
      cacheReadInputTokens: 100,
      cacheCreationInputTokens: 50,
      outputTokens: 0,
    })
  })

  it('falls back to turn-cumulative fields when last_* missing', () => {
    const usage = extractMessageUsage(
      mkAssistant({
        input_tokens: 1500,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 100,
        output_tokens: 80,
      }),
    )
    expect(usage).toEqual({
      inputTokens: 1500,
      cacheReadInputTokens: 200,
      cacheCreationInputTokens: 100,
      outputTokens: 80,
    })
  })

  it('skips placeholder usage with all input-side fields zero', () => {
    // 第三方 LLM 在 message_start 阶段可能发出全 0 usage 占位
    expect(
      extractMessageUsage(
        mkAssistant({
          input_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: 100, // output 单独有值不算「真实 usage」
        }),
      ),
    ).toBeNull()
  })

  it('treats negative / NaN tokens as 0 (defensive)', () => {
    const usage = extractMessageUsage(
      mkAssistant({
        last_input_tokens: 100,
        last_cache_read_input_tokens: -10, // 异常负数
        last_cache_creation_input_tokens: Number.NaN,
        output_tokens: 50,
      }),
    )
    expect(usage).toEqual({
      inputTokens: 100,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 50,
    })
  })

  it('does not mix last_* and turn-cumulative cache (consistency principle)', () => {
    // last_input_tokens 存在 → cache 字段也走 last_* 路径，缺失视为 0
    // 不能让 last_input 用 last 路径、cache 又用 turn 累加路径——会语义混乱
    const usage = extractMessageUsage(
      mkAssistant({
        input_tokens: 999,
        cache_read_input_tokens: 999,
        last_input_tokens: 200,
        // 故意不提供 last_cache_read_input_tokens
      }),
    )
    expect(usage?.inputTokens).toBe(200)
    expect(usage?.cacheReadInputTokens).toBe(0)
  })

  // ── usage_json 权威源（落库回灌 / 重开对话形态）─────────────────────────
  it('reads usage_json as the canonical source (per-call input)', () => {
    const usage = extractMessageUsage(
      mkAssistantUsageJson({
        input_tokens: 30517,
        output_tokens: 63,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      }),
    )
    expect(usage).toEqual({
      inputTokens: 30517,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 63,
    })
  })

  it('usage_json wins over metadata (canonical source beats fallback)', () => {
    // 重开对话的真实形态：usage_json 有真值，metadata 只剩账务字段（无 token）。
    // 即便 metadata 里残留了某些 token 字段，也以 usage_json 为准。
    const usage = extractMessageUsage(
      mkAssistantUsageJson(
        { input_tokens: 30517, cache_read_input_tokens: 100 },
        { last_input_tokens: 999, input_tokens: 888 },
      ),
    )
    expect(usage?.inputTokens).toBe(30517)
    expect(usage?.cacheReadInputTokens).toBe(100)
  })

  it('falls back to metadata when usage_json is missing (live in-memory message)', () => {
    const usage = extractMessageUsage(
      mkAssistantUsageJson(null, { last_input_tokens: 500 }),
    )
    expect(usage?.inputTokens).toBe(500)
  })

  it('falls back to metadata when usage_json is an all-zero placeholder', () => {
    const usage = extractMessageUsage(
      mkAssistantUsageJson(
        { input_tokens: 0, output_tokens: 0 },
        { last_input_tokens: 700 },
      ),
    )
    expect(usage?.inputTokens).toBe(700)
  })

  it('sums input-side from usage_json (input + cache_read + cache_creation)', () => {
    const usage = extractMessageUsage(
      mkAssistantUsageJson({
        input_tokens: 1000,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 50,
      }),
    )
    expect(usage && inputSideTokens(usage)).toBe(1250)
  })
})

describe('getCurrentUsage', () => {
  it('returns null for empty messages', () => {
    expect(getCurrentUsage([])).toBeNull()
  })

  it('walks back to find the last assistant with real usage', () => {
    const msgs: ChatMessage[] = [
      mkUser('hi'),
      mkAssistant({ last_input_tokens: 100 }),
      mkUser('again'),
      mkAssistant(null), // 无 metadata 的中间 assistant 应跳过
      mkUser('?'),
    ]
    const usage = getCurrentUsage(msgs)
    expect(usage?.inputTokens).toBe(100)
  })

  it('skips placeholder assistant (all-zero) and returns earlier real usage', () => {
    const msgs: ChatMessage[] = [
      mkAssistant({ last_input_tokens: 200 }),
      mkUser('q'),
      mkAssistant({ input_tokens: 0, cache_read_input_tokens: 0 }), // placeholder
    ]
    const usage = getCurrentUsage(msgs)
    expect(usage?.inputTokens).toBe(200)
  })

  it('ignores subagent transcript messages when deriving parent context usage', () => {
    const parent = mkAssistantUsageJson({
      input_tokens: 1200,
      cache_read_input_tokens: 300,
      output_tokens: 20,
    })
    const child = mkSubagentAssistantUsageJson({
      input_tokens: 500_000,
      cache_read_input_tokens: 50_000,
      output_tokens: 100,
    })

    const usage = getCurrentUsage([parent, child])
    expect(usage).toEqual({
      inputTokens: 1200,
      cacheReadInputTokens: 300,
      cacheCreationInputTokens: 0,
      outputTokens: 20,
    })
    expect(getCurrentContextTokens([parent, child])).toBe(1500)
  })
})

describe('inputSideTokens', () => {
  it('excludes output_tokens from the sum', () => {
    expect(
      inputSideTokens({
        inputTokens: 100,
        cacheReadInputTokens: 50,
        cacheCreationInputTokens: 25,
        outputTokens: 9999, // 故意巨量 output 验证不被算入
      }),
    ).toBe(175)
  })
})

describe('estimateTextTokens (CJK-aware, runtime 同口径)', () => {
  it('returns 0 for empty input', () => {
    expect(estimateTextTokens('')).toBe(0)
  })

  it('estimates pure English at ~4 chars/token + 4/3 padding', () => {
    // 400 字符英文 → 400/4 = 100 → ×4/3 = 134（含 runtime 的 4/3 padding）
    expect(estimateTextTokens('a'.repeat(400))).toBe(134)
  })

  it('estimates pure Chinese at ~1.3 chars/token (vs 4 for English)', () => {
    // 100 个汉字 → 100/1.3 ≈ 77 → ×4/3 ≈ 103
    // 关键回归：之前 chars/4 公式会算成 25 tokens——严重低估
    const result = estimateTextTokens('中'.repeat(100))
    expect(result).toBeGreaterThan(95)
    expect(result).toBeLessThan(110)
  })

  it('handles mixed Chinese + English correctly', () => {
    // CJK ratio = 0.5，charsPerToken = 0.5*1.3 + 0.5*4 = 2.65
    // 100 / 2.65 ≈ 37.7 → ×4/3 ≈ 51
    const result = estimateTextTokens('中'.repeat(50) + 'a'.repeat(50))
    expect(result).toBeGreaterThan(45)
    expect(result).toBeLessThan(57)
  })
})

describe('chatMessageToRuntimeMessage', () => {
  it('maps plain string content to a single text block', () => {
    const msg = mkUser('a'.repeat(100))
    const rt = chatMessageToRuntimeMessage(msg)
    expect(rt.role).toBe('user')
    expect(rt.content).toEqual([{ type: 'text', text: 'a'.repeat(100) }])
  })

  it('merges text + thinking blocks from content_blocks_json into one text block', () => {
    const msg: ChatMessage = {
      ...mkAssistant(null, ''),
      content_blocks_json: [
        { type: 'text', text: 'hello' },
        { type: 'thinking', thinking: 'reasoning' },
      ] as ChatMessage['content_blocks_json'],
    }
    const rt = chatMessageToRuntimeMessage(msg)
    expect(rt.role).toBe('assistant')
    expect(rt.content).toEqual([{ type: 'text', text: 'hello\nreasoning' }])
  })

  it('serializes tool_call name + input + output into text', () => {
    const msg: ChatMessage = {
      ...mkAssistant(null, ''),
      content_blocks_json: [
        { type: 'tool_call', tool_name: 'search', input: { foo: 'bar' }, output: 'ok' },
      ] as ChatMessage['content_blocks_json'],
    }
    const rt = chatMessageToRuntimeMessage(msg)
    expect(Array.isArray(rt.content)).toBe(true)
    const block = (rt.content as Array<{ type: string; text?: string }>)[0]
    expect(block.type).toBe('text')
    expect(block.text).toContain('search')
    expect(block.text).toContain('foo')
    expect(block.text).toContain('ok')
  })

  it('maps image block preserving width/height for image token estimation', () => {
    const msg: ChatMessage = {
      ...mkAssistant(null, ''),
      content_blocks_json: [
        { type: 'image', width: 800, height: 600 },
      ] as ChatMessage['content_blocks_json'],
    }
    const rt = chatMessageToRuntimeMessage(msg)
    expect(rt.content).toEqual([
      { type: 'image', source: { type: 'url', url: '' }, width: 800, height: 600 },
    ])
  })

  it('ignores decorative blocks (rich_content / file) that never enter LLM context', () => {
    const msg: ChatMessage = {
      ...mkAssistant(null, ''),
      content_blocks_json: [
        { type: 'rich_content', kind: 'widget', summary: 'chart' },
        { type: 'text', text: 'keep' },
      ] as ChatMessage['content_blocks_json'],
    }
    const rt = chatMessageToRuntimeMessage(msg)
    expect(rt.content).toEqual([{ type: 'text', text: 'keep' }])
  })
})

describe('getCurrentContextTokens', () => {
  it('returns 0 for empty messages without draft', () => {
    expect(getCurrentContextTokens([])).toBe(0)
  })

  it('estimates draft text only when no anchor exists', () => {
    // 200 chars / 4 = 50 → ×4/3 = 67（runtime estimateTextTokens 同口径）
    const result = getCurrentContextTokens([], 'a'.repeat(200))
    expect(result).toBe(67)
  })

  it('uses anchor input-side tokens when assistant with usage exists', () => {
    const msgs: ChatMessage[] = [
      mkUser('q'),
      mkAssistant({
        last_input_tokens: 1000,
        last_cache_read_input_tokens: 200,
        last_cache_creation_input_tokens: 50,
      }),
    ]
    expect(getCurrentContextTokens(msgs)).toBe(1250) // 1000 + 200 + 50
  })

  it('adds runtime-口径 estimate of messages after anchor', () => {
    const msgs: ChatMessage[] = [
      mkAssistant({ last_input_tokens: 500 }),
      mkUser('a'.repeat(100)), // raw = 4(overhead) + 100/4 = 29 → ×4/3 = 39
    ]
    expect(getCurrentContextTokens(msgs)).toBe(539)
  })

  it('adds draft text on top of anchor + post-anchor estimate', () => {
    const msgs: ChatMessage[] = [
      mkAssistant({ last_input_tokens: 500 }),
      mkUser('a'.repeat(100)), // 39 tokens（含 4 overhead + 4/3 padding）
    ]
    // 500 + 39(tail) + estimateTextTokens('b'*40)=ceil(10*4/3)=14
    expect(getCurrentContextTokens(msgs, 'b'.repeat(40))).toBe(553)
  })

  it('压缩检查点不另算：指示器仍锚定压缩后下一次真实调用的 usage', () => {
    // 压缩后又发了一轮 → 最后一条 assistant 的 usage 即压缩后真实 input，
    // 指示器锚定它（不读 compaction_summary.stats，避免 messages-only 误导）。
    const msgs: ChatMessage[] = [
      mkAssistant({ last_input_tokens: 5000 }),
      {
        id: 'compact-summary',
        role: 'system',
        content: '压缩摘要',
        created_at: new Date().toISOString(),
        message_kind: 'compaction_summary',
        metadata: { stats: { tokens_after: 1200 } },
      } as ChatMessage,
      mkAssistantUsageJson({ input_tokens: 1500, output_tokens: 20 }),
    ]

    expect(getCurrentContextTokens(msgs)).toBe(1500)
    expect(getCurrentUsageSource(msgs)).toBe('last_call')
  })

  it('刚压缩（检查点在 anchor 之后、还没发新消息）：即时显示 anchor − tokens_freed', () => {
    // 压缩前最后一次真实调用 input=72000（含 system+tools）；本次释放 60000。
    // 即时基数 = 72000 − 60000 = 12000（口径仍含固定开销，与下次真实调用一致）。
    const msgs: ChatMessage[] = [
      mkAssistant({ last_input_tokens: 72000 }),
      {
        id: 'compact-summary',
        role: 'system',
        content: '压缩摘要',
        created_at: new Date().toISOString(),
        message_kind: 'compaction_summary',
        metadata: { stats: { tokens_before: 68000, tokens_after: 8000, tokens_freed: 60000 } },
      } as ChatMessage,
    ]
    expect(getCurrentContextTokens(msgs)).toBe(12000)
    expect(getCurrentUsageSource(msgs)).toBe('post_compact')
  })

  it('刚压缩：检查点之后的新消息叠加到即时基数上', () => {
    const msgs: ChatMessage[] = [
      mkAssistant({ last_input_tokens: 72000 }),
      {
        id: 'compact-summary',
        role: 'system',
        content: '压缩摘要',
        created_at: new Date().toISOString(),
        message_kind: 'compaction_summary',
        metadata: { stats: { tokens_after: 8000, tokens_freed: 60000 } },
      } as ChatMessage,
      mkUser('a'.repeat(80)), // raw = 4 + 80/4 = 24 → ×4/3 = 32
    ]
    // 12000（基数）+ 32（检查点后新用户消息，runtime 口径）
    expect(getCurrentContextTokens(msgs)).toBe(12032)
    expect(getCurrentUsageSource(msgs)).toBe('post_compact')
  })

  it('刚压缩：anchor − freed 低于 tokens_after 时夹到 tokens_after 地板', () => {
    const msgs: ChatMessage[] = [
      mkAssistant({ last_input_tokens: 20000 }),
      {
        id: 'compact-summary',
        role: 'system',
        content: '压缩摘要',
        created_at: new Date().toISOString(),
        message_kind: 'compaction_summary',
        metadata: { stats: { tokens_after: 5000, tokens_freed: 19000 } },
      } as ChatMessage,
    ]
    // 20000 − 19000 = 1000 < 5000 → 夹到 5000
    expect(getCurrentContextTokens(msgs)).toBe(5000)
    expect(getCurrentUsageSource(msgs)).toBe('post_compact')
  })

  it('压缩检查点缺 stats.tokens_freed：不即时估算，回退锚定真实 usage', () => {
    const msgs: ChatMessage[] = [
      mkAssistant({ last_input_tokens: 1000 }),
      {
        id: 'compact-summary',
        role: 'system',
        content: '压缩摘要',
        created_at: new Date().toISOString(),
        message_kind: 'compaction_summary',
        metadata: { stats: { tokens_after: 200 } }, // 无 tokens_freed
      } as ChatMessage,
    ]
    // 无有效 freed → base 仍 1000 + 检查点消息文本粗估；source 不是 post_compact
    expect(getCurrentContextTokens(msgs)).toBeGreaterThanOrEqual(1000)
    expect(getCurrentUsageSource(msgs)).toBe('last_call')
  })

  it('falls back to full estimation when no usage anywhere', () => {
    // 整个会话没真实 usage（全新对话还没收到 DONE）。runtime estimateTokens 先
    // 累加各条 raw（含每条 +4 overhead）再统一 ×4/3：
    //   raw = (4+80/4) + (4+40/4) = 24 + 14 = 38 → ceil(38*4/3) = 51
    const msgs: ChatMessage[] = [
      mkUser('a'.repeat(80)),
      mkUser('b'.repeat(40)),
    ]
    expect(getCurrentContextTokens(msgs)).toBe(51)
  })

  it('handles 100% prompt cache hit edge case (last_input_tokens=0 + cache_read>0)', () => {
    // 极罕见但合法：provider 把全部 input 归到 cache_read（100% 命中）
    // last_input_tokens=0 不能被当作 placeholder 跳过——cache_read>0 是有效信号
    const msgs: ChatMessage[] = [
      mkAssistant({
        last_input_tokens: 0,
        last_cache_read_input_tokens: 1500,
        last_cache_creation_input_tokens: 0,
      }),
    ]
    expect(getCurrentContextTokens(msgs)).toBe(1500)
  })

  it('CJK draft text uses CJK-aware estimation (not chars/4)', () => {
    // 200 个汉字 draft → 200/1.3 ≈ 154 → ×4/3 ≈ 206（runtime 同口径含 padding）
    const msgs: ChatMessage[] = [
      mkAssistant({ last_input_tokens: 1000 }),
    ]
    const result = getCurrentContextTokens(msgs, '中'.repeat(200))
    expect(result).toBe(1206)
  })

  it('reopened conversation: derives context from usage_json, NOT text estimate (regression)', () => {
    // 复现根因 bug：重开历史对话后，消息从服务端拉回——token 用量在 usage_json，
    // metadata 只剩 source/client_event_id 等账务字段（无任何 token）。旧实现只读
    // metadata → 找不到 anchor → 回退「可见文本粗估」≈116（结构上看不到 system
    // prompt + 工具定义）。修复后应从最后一条 assistant 的 usage_json 取真实上下文。
    const msgs: ChatMessage[] = [
      mkUser('子agent的dogfood验证，你什么都不需要做，只需要派两个子agent，让他们回复1和2就行了'),
      mkAssistantUsageJson(
        { input_tokens: 30285, output_tokens: 166 },
        { source: 'agent_stream_6_piece', client_event_id: 'x' },
        '[工具调用]',
      ),
      mkAssistantUsageJson(
        { input_tokens: 30517, output_tokens: 63 },
        { source: 'agent_stream_6_piece', client_event_id: 'y' },
        '两个子 agent 均已完成',
      ),
    ]
    // 取最后一条 assistant 的 usage_json.input_tokens（= 最后一次 LLM 调用的真实上下文）
    expect(getCurrentContextTokens(msgs)).toBe(30517)
    expect(getCurrentUsageSource(msgs)).toBe('last_call')
  })

  it('multi-LLM-call turn: last_input_tokens stays accurate (not cumulative)', () => {
    // 用 tool_use 多轮调用的 turn，runtime 端 turn 累加 input_tokens 会是 1500，
    // 但 last_input_tokens 反映「最后一次 LLM 调用喂进的真实上下文」= 500。
    // 这是修复「turn 内多 LLM 调用导致环虚高 2-3 倍」的关键测试。
    const msgs: ChatMessage[] = [
      mkAssistant({
        input_tokens: 1500, // turn 累加（含 3 次 LLM 调用）
        last_input_tokens: 500, // 最后一次 LLM 调用的真实 input
      }),
    ]
    expect(getCurrentContextTokens(msgs)).toBe(500)
  })
})

describe('getCurrentUsageSource', () => {
  it('returns "none" for empty messages', () => {
    expect(getCurrentUsageSource([])).toBe('none')
  })

  it('returns "none" when all assistants are placeholders', () => {
    const msgs = [mkAssistant({ input_tokens: 0, output_tokens: 0 })]
    expect(getCurrentUsageSource(msgs)).toBe('none')
  })

  it('returns "last_call" when latest assistant has last_input_tokens', () => {
    const msgs = [mkAssistant({ last_input_tokens: 1200, input_tokens: 1500 })]
    expect(getCurrentUsageSource(msgs)).toBe('last_call')
  })

  it('returns "last_call" when latest assistant has usage_json (canonical, per-call)', () => {
    const msgs = [mkAssistantUsageJson({ input_tokens: 30517 })]
    expect(getCurrentUsageSource(msgs)).toBe('last_call')
  })

  it('returns "turn_accum" when latest assistant only has cumulative fields (老会话)', () => {
    // 2026-05-10 之前的 turn——只有 input_tokens，没 last_*。多 LLM 调用的 turn
    // 这个值会偏高，UI 用这个 source 触发「估算偏差」小字。
    const msgs = [mkAssistant({ input_tokens: 1500, output_tokens: 200 })]
    expect(getCurrentUsageSource(msgs)).toBe('turn_accum')
  })

  it('returns "last_call" when latest assistant has last_input_tokens=0 (100% cache hit)', () => {
    // last_input_tokens 字段存在但值 0（100% prompt cache hit）—— 仍走 last_call 路径
    const msgs = [
      mkAssistant({
        last_input_tokens: 0,
        last_cache_read_input_tokens: 1500,
      }),
    ]
    expect(getCurrentUsageSource(msgs)).toBe('last_call')
  })

  it('skips placeholder assistants and returns source of first valid one', () => {
    // 最新 assistant 是 placeholder，倒数第二个有真实 last_*
    const msgs = [
      mkAssistant({ last_input_tokens: 800 }), // 老一点的 turn，有 last_*
      mkAssistant({ input_tokens: 0 }), // 最新但 placeholder（应跳过）
    ]
    expect(getCurrentUsageSource(msgs)).toBe('last_call')
  })

  it('mixed history: latest turn dictates source（新 turn 用 last_call，老 turn 用 turn_accum）', () => {
    // 历史会话恢复：早期 turn 用老格式，最新 turn 是新格式
    const msgs = [
      mkAssistant({ input_tokens: 500 }), // 老格式
      mkAssistant({ last_input_tokens: 1200 }), // 新格式
    ]
    expect(getCurrentUsageSource(msgs)).toBe('last_call')
  })
})
