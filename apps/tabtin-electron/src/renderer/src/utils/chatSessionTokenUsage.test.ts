/**
 * chatSessionTokenUsage utility 单测——重点是 SSoT invariant。
 *
 * 三个集合的关系卡死（这是抽 SSoT 的核心价值）：
 *   - `UPDATABLE_MONOTONIC_TOKENS` ⊂ `ALL_TOKEN_FIELDS_TO_OMIT`
 *   - `DEPRECATED_TOKEN_FIELDS`    ⊂ `ALL_TOKEN_FIELDS_TO_OMIT`
 *   - `UPDATABLE_MONOTONIC_TOKENS ∪ DEPRECATED_TOKEN_FIELDS = ALL_TOKEN_FIELDS_TO_OMIT`
 *   - `UPDATABLE_MONOTONIC_TOKENS ∩ DEPRECATED_TOKEN_FIELDS = ∅`
 *
 * 还要验：
 *   - `extractChatSessionTokenUsage` 输出键集合 = `UPDATABLE_MONOTONIC_TOKENS`
 *     （新增活字段时 extract 自动跟上）；
 *   - `omitMonotonicTokenFields` 剔除完整 `ALL_TOKEN_FIELDS_TO_OMIT`；
 *   - 原对象不被 mutate。
 */
import { describe, expect, it } from 'vitest'
import type { ChatSession } from '@tabtin/chat-client'
import {
  UPDATABLE_MONOTONIC_TOKENS,
  DEPRECATED_TOKEN_FIELDS,
  ALL_TOKEN_FIELDS_TO_OMIT,
  omitMonotonicTokenFields,
  extractChatSessionTokenUsage,
} from './chatSessionTokenUsage'

function buildSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 'sess-1',
    title: 'Test',
    status: 'active',
    organization_id: 'wt-1',
    created_at: '2026-05-17T00:00:00Z',
    updated_at: '2026-05-17T00:00:00Z',
    message_count: 5,
    last_message_preview: 'hello',
    last_message_at: '2026-05-17T00:00:01Z',
    input_tokens: 100,
    output_tokens: 50,
    total_tokens: 150,
    cache_read_input_tokens: 30,
    cache_creation_input_tokens: 20,
    context_tokens: 200,
    ...overrides,
  } as ChatSession
}

describe('token 字段集合 · SSoT invariant', () => {
  it('UPDATABLE_MONOTONIC_TOKENS 含 input/output/total 三个 W3 计费活字段', () => {
    expect(UPDATABLE_MONOTONIC_TOKENS).toContain('input_tokens')
    expect(UPDATABLE_MONOTONIC_TOKENS).toContain('output_tokens')
    expect(UPDATABLE_MONOTONIC_TOKENS).toContain('total_tokens')
    // 不应含废弃字段
    expect(UPDATABLE_MONOTONIC_TOKENS).not.toContain('context_tokens')
  })

  it('DEPRECATED_TOKEN_FIELDS 含 context_tokens', () => {
    expect(DEPRECATED_TOKEN_FIELDS).toContain('context_tokens')
  })

  it('ALL_TOKEN_FIELDS_TO_OMIT = UPDATABLE ∪ DEPRECATED（关系等价）', () => {
    const expected = new Set([...UPDATABLE_MONOTONIC_TOKENS, ...DEPRECATED_TOKEN_FIELDS])
    const actual = new Set(ALL_TOKEN_FIELDS_TO_OMIT)
    expect(actual).toEqual(expected)
  })

  it('UPDATABLE ∩ DEPRECATED = ∅（活字段和已废弃字段互斥）', () => {
    const updatable = new Set<string>(UPDATABLE_MONOTONIC_TOKENS)
    const deprecated = new Set<string>(DEPRECATED_TOKEN_FIELDS)
    for (const k of updatable) {
      expect(deprecated.has(k)).toBe(false)
    }
  })

  it('extractChatSessionTokenUsage 输出键 = UPDATABLE_MONOTONIC_TOKENS', () => {
    // 关键 invariant：活字段集和 extract 输出对齐——加新字段时只改 UPDATABLE
    // 数组，extract 自动循环生成对应的 key。
    const session = buildSession()
    const usage = extractChatSessionTokenUsage(session)
    expect(Object.keys(usage).sort()).toEqual([...UPDATABLE_MONOTONIC_TOKENS].sort())
  })

  it('extract 不会输出 DEPRECATED 字段（即便 ChatSession 上有该字段）', () => {
    const session = buildSession()
    const usage = extractChatSessionTokenUsage(session)
    for (const k of DEPRECATED_TOKEN_FIELDS) {
      expect((usage as Record<string, unknown>)[k]).toBeUndefined()
    }
  })
})

describe('omitMonotonicTokenFields', () => {
  it('剔除 ALL_TOKEN_FIELDS_TO_OMIT 全部字段', () => {
    const session = buildSession()
    const result = omitMonotonicTokenFields(session)
    for (const k of ALL_TOKEN_FIELDS_TO_OMIT) {
      expect((result as Record<string, unknown>)[k]).toBeUndefined()
    }
  })

  it('保留其他业务字段（id / title / message_count / preview）', () => {
    const session = buildSession()
    const result = omitMonotonicTokenFields(session)
    expect(result.id).toBe('sess-1')
    expect(result.title).toBe('Test')
    expect(result.message_count).toBe(5)
    expect(result.last_message_preview).toBe('hello')
  })

  it('原对象不被 mutate（防御性 spread）', () => {
    const session = buildSession()
    omitMonotonicTokenFields(session)
    expect(session.input_tokens).toBe(100)
    expect(session.output_tokens).toBe(50)
    expect(session.total_tokens).toBe(150)
    expect(session.cache_read_input_tokens).toBe(30)
    expect(session.cache_creation_input_tokens).toBe(20)
    expect(session.context_tokens).toBe(200)
  })

  it('token 字段缺失时不报错', () => {
    const session = buildSession({
      input_tokens: undefined,
      output_tokens: undefined,
      total_tokens: undefined,
      context_tokens: undefined,
    })
    expect(() => omitMonotonicTokenFields(session)).not.toThrow()
    expect(omitMonotonicTokenFields(session).id).toBe('sess-1')
  })
})

describe('extractChatSessionTokenUsage', () => {
  it('全部数字字段时返回完整 usage（值正确）', () => {
    const session = buildSession()
    const usage = extractChatSessionTokenUsage(session)
    expect(usage).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 20,
    })
  })

  it('字段缺失或非数字时安全 fallback（不报错，跳过该字段）', () => {
    const session = buildSession({
      input_tokens: undefined,
      output_tokens: undefined,
    })
    const usage = extractChatSessionTokenUsage(session)
    expect(usage.input_tokens).toBeUndefined()
    expect(usage.output_tokens).toBeUndefined()
    expect(usage.total_tokens).toBe(150)
  })
})
