import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import {
  findLastClosedTurnEndIndex,
  findLastTurnEndIndex,
} from '../turnBoundary'

function msg(partial: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'role' | 'content' | 'created_at'>): ChatMessage {
  return {
    message_kind: partial.role === 'assistant' ? 'llm' : undefined,
    ...partial,
  } as ChatMessage
}

const turn1 = [
  msg({ id: 'u1', role: 'user', content: '第一轮', created_at: '2026-08-13T00:00:00Z' }),
  msg({ id: 'a1', role: 'assistant', content: '已改', created_at: '2026-08-13T00:00:01Z', agent_run_id: 'run-1' }),
]

describe('findLastClosedTurnEndIndex', () => {
  it('idle 完成后返回当前轮末', () => {
    expect(findLastTurnEndIndex(turn1)).toBe(1)
    expect(findLastClosedTurnEndIndex(turn1)).toBe(1)
  })

  it('user₁ → assistant₁ → user₂ 时没有可展示本轮', () => {
    const pending = [
      ...turn1,
      msg({ id: 'u2', role: 'user', content: '下一轮', created_at: '2026-08-13T00:00:02Z' }),
    ]
    expect(findLastTurnEndIndex(pending)).toBe(1)
    expect(findLastClosedTurnEndIndex(pending)).toBe(-1)
  })

  it('assistant₂ 到达后只认第 2 轮', () => {
    const turn2 = [
      ...turn1,
      msg({ id: 'u2', role: 'user', content: '下一轮', created_at: '2026-08-13T00:00:02Z' }),
      msg({
        id: 'a2',
        role: 'assistant',
        content: '继续',
        created_at: '2026-08-13T00:00:03Z',
        agent_run_id: 'run-2',
      }),
    ]
    expect(findLastTurnEndIndex(turn2)).toBe(3)
    expect(findLastClosedTurnEndIndex(turn2)).toBe(3)
  })

  it('trailing push / 非普通用户消息不打断上一轮', () => {
    const withPush = [
      ...turn1,
      msg({
        id: 'push-1',
        role: 'user',
        content: '后台完成',
        created_at: '2026-08-13T00:00:02Z',
        metadata: { triggered_by: 'push-notification' },
      }),
    ]
    expect(findLastTurnEndIndex(withPush)).toBe(1)
    expect(findLastClosedTurnEndIndex(withPush)).toBe(1)
  })
})
