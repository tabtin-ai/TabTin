import { describe, expect, it, vi } from 'vitest'

import {
  ApprovalGate,
  approvalGateSessionId,
  createApprovalGate,
} from '../src/interaction/approval-gate.js'

describe('ApprovalGate', () => {
  it('approvalGateSessionId strips chat-session- prefix', () => {
    expect(approvalGateSessionId('chat-session-11111111-1111-4111-8111-111111111111'))
      .toBe('11111111-1111-4111-8111-111111111111')
    expect(approvalGateSessionId('not-a-uuid')).toBe('')
  })

  it('returns memo hit without asking', async () => {
    const ask = vi.fn()
    const gate = createApprovalGate({
      ask,
      memo: {
        isApproved: () => true,
        record: vi.fn(),
      },
    })

    await expect(gate.request(
      { threadId: 'chat-session-11111111-1111-4111-8111-111111111111', interactionMode: 'interactive' },
      { actionType: 'browser.eval', detail: 'actionId=eval risk=high-risk-write' },
    )).resolves.toEqual({ approved: true, scope: 'always' })
    expect(ask).not.toHaveBeenCalled()
  })

  it('asks once and records thread/always memo', async () => {
    const record = vi.fn()
    const ask = vi.fn(async () => ({ approved: true, scope: 'thread' as const }))
    const gate = new ApprovalGate({
      ask,
      memo: { isApproved: () => false, record },
      toSessionId: approvalGateSessionId,
    })

    await expect(gate.request(
      { threadId: 'chat-session-11111111-1111-4111-8111-111111111111', interactionMode: 'interactive' },
      {
        actionType: 'browser.eval',
        detail: 'actionId=eval risk=high-risk-write',
        reason: '页面写操作',
        timeoutMs: 1_000,
      },
    )).resolves.toEqual({ approved: true, scope: 'thread' })

    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'chat-session-11111111-1111-4111-8111-111111111111' }),
      expect.objectContaining({
        actionType: 'browser.eval',
        detail: 'actionId=eval risk=high-risk-write',
        timeoutMs: 1_000,
      }),
    )
    expect(record).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      'browser.eval',
      'thread',
      true,
      'actionId=eval risk=high-risk-write',
    )
  })

  it('does not record memo for strict or denied asks', async () => {
    const record = vi.fn()
    const ask = vi.fn(async () => ({ approved: false }))
    const gate = createApprovalGate({
      ask,
      memo: { isApproved: () => false, record },
    })

    await expect(gate.request(
      { threadId: 'chat-session-11111111-1111-4111-8111-111111111111', interactionMode: 'interactive' },
      { actionType: 'interactive_command', detail: 'sudo', isStrict: true },
    )).resolves.toEqual({ approved: false, scope: undefined })
    expect(record).not.toHaveBeenCalled()
  })
})
