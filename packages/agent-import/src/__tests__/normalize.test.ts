import { describe, expect, it } from 'vitest'
import {
  contentHashId,
  ensureUuid,
  interpolateTimestamps,
  normalizeMessages,
  SYNTHESIZED_TOOL_RESULT_TEXT,
  textDedupKey,
  uuidFromString,
} from '../normalize.js'
import { newRedactStats, redactText } from '../redact.js'
import type { UnifiedMessage } from '../types.js'

function msg(partial: Partial<UnifiedMessage> & Pick<UnifiedMessage, 'id' | 'role' | 'blocks'>): UnifiedMessage {
  return { createdAt: '2026-07-01T00:00:00.000Z', ...partial }
}

describe('normalizeMessages', () => {
  it('未配对 tool_use 合成占位 tool_result（续聊重放协议合法性，PRD §3.3）', () => {
    const out = normalizeMessages(
      [
        msg({
          id: 'a1',
          role: 'assistant',
          blocks: [
            { type: 'text', text: '我来跑一下' },
            { type: 'tool_use', id: 'tu_1', name: 'Shell', input: { command: 'ls' } },
          ],
        }),
      ],
      { source: 'cursor', redact: false },
    )
    const holder = out[0]
    const result = holder.blocks.find((b) => b.type === 'tool_result')
    expect(result).toBeDefined()
    expect(result).toMatchObject({
      tool_use_id: 'tu_1',
      content: SYNTHESIZED_TOOL_RESULT_TEXT,
      synthesized: true,
    })
  })

  it('已配对的 tool_use 不再合成', () => {
    const out = normalizeMessages(
      [
        msg({
          id: 'a1',
          role: 'assistant',
          blocks: [
            { type: 'tool_use', id: 'tu_1', name: 'Read', input: {} },
            { type: 'tool_result', tool_use_id: 'tu_1', content: 'file body' },
          ],
        }),
      ],
      { source: 'codex', redact: false },
    )
    const results = out[0].blocks.filter((b) => b.type === 'tool_result')
    expect(results).toHaveLength(1)
    expect((results[0] as { synthesized?: boolean }).synthesized).toBeUndefined()
  })

  it('非 Claude 来源 thinking 剥离 signature；Claude 保留', () => {
    const input = [
      msg({
        id: 't1',
        role: 'assistant',
        blocks: [{ type: 'thinking', thinking: '想一想', signature: 'sig-abc' }],
      }),
    ]
    const cursorOut = normalizeMessages(input, { source: 'cursor', redact: false })
    expect((cursorOut[0].blocks[0] as { signature?: string }).signature).toBeUndefined()

    const claudeOut = normalizeMessages(input, { source: 'claude_code', redact: false })
    expect((claudeOut[0].blocks[0] as { signature?: string }).signature).toBe('sig-abc')
  })

  it('打码开启时 text/tool_result 里的密钥被码掉并计数', () => {
    const stats = newRedactStats()
    const out = normalizeMessages(
      [
        msg({
          id: 'k1',
          role: 'user',
          blocks: [{ type: 'text', text: '我的 key 是 test-api-key' }],
        }),
      ],
      { source: 'cursor', redact: true, redactStats: stats },
    )
    const text = (out[0].blocks[0] as { text: string }).text
    expect(text).not.toContain('KiJQnoyPIzORCuE5uGDyrZojjbncPAf3HuRX')
    expect(stats.hits).toBeGreaterThan(0)
  })

  it('空消息剔除', () => {
    const out = normalizeMessages(
      [msg({ id: 'e1', role: 'assistant', blocks: [] })],
      { source: 'workbuddy', redact: false },
    )
    expect(out).toHaveLength(0)
  })
})

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

describe('ensureUuid（client_event_id 收口，防 Django 静默 skip）', () => {
  it('合法 UUID 原样保留（Claude uuid 跨设备稳定）', () => {
    const u = '4ebba3f2-1234-4abc-89ab-0123456789ab'
    expect(ensureUuid(u)).toBe(u)
  })

  it('非 UUID 源生 id（Codex msg_/rs_、Claude path#index）归一为合法 UUID', () => {
    for (const raw of ['msg_abc123', 'rs_0f1e2d', '/Users/x/.claude/proj/sess.jsonl#42', 'codex:abc:placeholder']) {
      expect(ensureUuid(raw)).toMatch(UUID_RE)
    }
  })

  it('确定性——同源 id 恒映射同一 UUID（重跑幂等）', () => {
    expect(ensureUuid('msg_abc123')).toBe(ensureUuid('msg_abc123'))
    expect(uuidFromString('a')).not.toBe(uuidFromString('b'))
  })

  it('normalizeMessages 输出的每条消息 id 都是合法 UUID', () => {
    const out = normalizeMessages(
      [
        { id: 'msg_openai_001', role: 'user', blocks: [{ type: 'text', text: 'hi' }], createdAt: '2026-07-01T00:00:00.000Z' },
        { id: '/p/sess.jsonl#3', role: 'assistant', blocks: [{ type: 'text', text: 'yo' }], createdAt: '2026-07-01T00:00:01.000Z' },
      ],
      { source: 'codex', redact: false },
    )
    expect(out).toHaveLength(2)
    for (const m of out) expect(m.id).toMatch(UUID_RE)
  })
})

describe('contentHashId', () => {
  it('同输入稳定、异输入不同、形态为 UUID', () => {
    const a = contentHashId('sess-1', 'user', 0, 'hello world')
    const b = contentHashId('sess-1', 'user', 0, 'hello world')
    const c = contentHashId('sess-1', 'user', 1, 'hello world')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('空白差异归一（NFKC + 空白折叠）', () => {
    expect(contentHashId('s', 'user', 0, 'a  b\r\nc')).toBe(contentHashId('s', 'user', 0, 'a b\nc'))
  })
})

describe('textDedupKey', () => {
  it('Codex event_msg 与 response_item 双重表达可对上', () => {
    expect(textDedupKey('同一段回复\r\n第二行')).toBe(textDedupKey('同一段回复\n第二行'))
  })
})

describe('interpolateTimestamps', () => {
  it('线性内插且首尾对齐时间窗（clamp，PRD §3.3 Cursor）', () => {
    const ts = interpolateTimestamps(3, '2026-07-01T00:00:00.000Z', '2026-07-01T02:00:00.000Z')
    expect(ts).toHaveLength(3)
    expect(ts[0]).toBe('2026-07-01T00:00:00.000Z')
    expect(ts[2]).toBe('2026-07-01T02:00:00.000Z')
    expect(Date.parse(ts[1])).toBe(Date.parse('2026-07-01T01:00:00.000Z'))
  })

  it('end 早于 start 时 clamp 到 start（mtime 不可靠场景）', () => {
    const ts = interpolateTimestamps(2, '2026-07-02T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
    expect(ts[0]).toBe(ts[1])
  })
})

describe('redactText', () => {
  it('覆盖 JWT / Bearer / 赋值式密钥', () => {
    const stats = newRedactStats()
    const input = [
      'jwt: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c',
      'Authorization: Bearer abcdef1234567890abcdef1234567890',
      'api_key=supersecretvalue12345',
    ].join('\n')
    const out = redactText(input, stats)
    expect(out).not.toContain('SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c')
    expect(out).not.toContain('abcdef1234567890abcdef1234567890')
    expect(out).not.toContain('supersecretvalue12345')
    expect(stats.hits).toBeGreaterThanOrEqual(3)
  })

  it('普通文本零误伤', () => {
    const stats = newRedactStats()
    const input = '我们讨论一下 skill 的设计，参考 docs/agent/tooling-skills.md 第 3 节。'
    expect(redactText(input, stats)).toBe(input)
    expect(stats.hits).toBe(0)
  })
})
