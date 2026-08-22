/**
 * Wave 事 5 · `filterUnresolvedToolUses` 单测。
 *
 * 覆盖方案 §五 场景 2（"中断后再发下一条"）的核心逻辑：
 * "assistant 发了 tool_use 但 user 没回 tool_result" 的残缺记录被整条过滤。
 */

import { describe, expect, it } from 'vitest'
import type { RuntimeHistoryMessage } from '@tabtin/agent-runtime/history'
import { filterUnresolvedToolUses } from '@tabtin/agent-runtime/history'

function asstWithToolUses(ids: string[]): RuntimeHistoryMessage {
  return {
    role: 'assistant',
    content: ids.map((id) => ({
      type: 'tool_use',
      id,
      name: 'grep',
      input: {},
    })),
  }
}

function userWithToolResults(ids: string[]): RuntimeHistoryMessage {
  return {
    role: 'user',
    content: ids.map((id) => ({
      type: 'tool_result',
      tool_use_id: id,
      content: 'ok',
    })),
  }
}

describe('filterUnresolvedToolUses', () => {
  it('空输入安全', () => {
    expect(filterUnresolvedToolUses([])).toEqual([])
  })

  it('无 tool 链时 pass-through（reference 相等）', () => {
    const msgs: RuntimeHistoryMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]
    expect(filterUnresolvedToolUses(msgs)).toBe(msgs)
  })

  it('所有 tool_use 都闭环 → pass-through', () => {
    const msgs: RuntimeHistoryMessage[] = [
      { role: 'user', content: 'q' },
      asstWithToolUses(['a', 'b']),
      userWithToolResults(['a', 'b']),
    ]
    expect(filterUnresolvedToolUses(msgs)).toBe(msgs)
  })

  it('场景 2 · "所有 tool_use 都 unresolved" 的 assistant 整条丢', () => {
    // 用户中断 Agent 生成导致：assistant 发了 tool_use_X 但没收到 tool_result_X。
    // 下一轮装填这条 assistant 会让 LLM 400。filterUnresolvedToolUses 整条丢。
    const msgs: RuntimeHistoryMessage[] = [
      { role: 'user', content: 'q1' },
      asstWithToolUses(['interrupted_use']),
      // 缺对应 tool_result —— 这是被中断的半拉子
      { role: 'user', content: 'new question' },
    ]
    const r = filterUnresolvedToolUses(msgs)
    expect(r).toHaveLength(2)
    expect(r[0]).toEqual({ role: 'user', content: 'q1' })
    expect(r[1]).toEqual({ role: 'user', content: 'new question' })
  })

  it('部分 tool_use 已闭环部分没：保留整条 assistant（留给事 2 补合成占位）', () => {
    // 同语义：`toolUseBlockIds.every(id => unresolvedIds.has(id))` 为 false 时整条留。
    const msgs: RuntimeHistoryMessage[] = [
      { role: 'user', content: 'q' },
      asstWithToolUses(['a_ok', 'b_missing']),
      // 只回了一个 tool_result
      userWithToolResults(['a_ok']),
    ]
    const r = filterUnresolvedToolUses(msgs)
    expect(r).toEqual(msgs)
  })

  it('thinking-only / 纯文本 assistant 不被误伤（没有 tool_use → 保留）', () => {
    const msgs: RuntimeHistoryMessage[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'answer' },
      { role: 'assistant', content: [{ type: 'text', text: 'another answer' }] },
    ]
    expect(filterUnresolvedToolUses(msgs)).toEqual(msgs)
  })

  it('多个 assistant 混合：只丢真全部 unresolved 的那条', () => {
    const msgs: RuntimeHistoryMessage[] = [
      { role: 'user', content: 'q1' },
      asstWithToolUses(['ok1']),
      userWithToolResults(['ok1']),
      { role: 'user', content: 'q2' },
      asstWithToolUses(['orphan1', 'orphan2']),
      // 整条 assistant 的两个 tool_use 都没 tool_result → 整条丢
      { role: 'user', content: 'q3' },
      asstWithToolUses(['ok3']),
      userWithToolResults(['ok3']),
    ]
    const r = filterUnresolvedToolUses(msgs)
    // 丢了中间那条半拉子 assistant
    expect(r).toHaveLength(7)
    expect(r.find((m) =>
      Array.isArray(m.content)
      && m.content.some((b) => (b as { id?: string }).id === 'orphan1'),
    )).toBeUndefined()
  })

  it('纯函数：不 mutate 输入', () => {
    const msgs: RuntimeHistoryMessage[] = [
      asstWithToolUses(['x']),
      { role: 'user', content: 'foo' },
    ]
    const before = JSON.stringify(msgs)
    filterUnresolvedToolUses(msgs)
    expect(JSON.stringify(msgs)).toBe(before)
  })
})
