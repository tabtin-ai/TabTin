import { describe, expect, it } from 'vitest'
import type {
  ChatSession,
  ChatSessionRunStatus,
} from '@tabtin/chat-client'
import { resolveSessionDisplayStatus } from './chat-session-status'

const session = {
  id: 'session-1',
  status: 'active',
  message_count: 2,
} as ChatSession

function resolve(runStatus: ChatSessionRunStatus | null, lastAssistantIsError = false) {
  return resolveSessionDisplayStatus(
    session,
    {},
    {},
    {},
    [],
    lastAssistantIsError,
    runStatus,
  )
}

describe('#4679 会话列表视觉投影', () => {
  it.each(['queued', 'running', 'cancelling'] as const)(
    '%s 映射为蓝色转圈态',
    (status) => expect(resolve(status)).toBe('streaming'),
  )

  it('failed 无论消息启发式如何都映射红色异常态', () => {
    expect(resolve('failed', false)).toBe('failed')
  })

  it('completed 映射完成态，未读圆点由组件的本地阅读水位决定', () => {
    expect(resolve('completed')).toBe('idle')
  })

  it.each(['cancelled', 'interrupted'] as const)(
    '%s 是中性完成，不显示失败',
    (status) => expect(resolve(status, true)).toBe('neutral'),
  )

  it('waiting_user 与 paused 保留明确反馈', () => {
    expect(resolve('waiting_user')).toBe('pending')
    expect(resolve('paused')).toBe('paused')
  })

  it('本地 HITL 实时事件可在权威 running 增量到达前提供等待反馈', () => {
    expect(resolveSessionDisplayStatus(
      session,
      {},
      { [session.id]: {} },
      {},
      [],
      false,
      'running',
    )).toBe('pending')
  })

  it('残留 HITL 面板不能复活 completed 终态', () => {
    expect(resolveSessionDisplayStatus(
      session,
      {},
      { [session.id]: {} },
      {},
      [],
      false,
      'completed',
    )).toBe('idle')
  })

  it('旧后端无 run_state 时保留最后 assistant 错误 fallback', () => {
    expect(resolve(null, true)).toBe('failed')
  })
})
