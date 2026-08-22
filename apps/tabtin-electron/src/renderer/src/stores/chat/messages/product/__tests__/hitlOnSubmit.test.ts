import { describe, expect, it } from 'vitest'
import {
  buildSoftAskUserStoreClearPatch,
  evaluateHitlOnSubmit,
} from '../hitl/hitlOnSubmit'

describe('evaluateHitlOnSubmit', () => {
  it('无 pending 时不动作', () => {
    expect(evaluateHitlOnSubmit(undefined, true)).toEqual({ action: 'none' })
  })

  it('hard-blocking 时不动作（由 delivery guard 已阻断）', () => {
    expect(evaluateHitlOnSubmit({ blockingPolicy: 'hard' } as never, true)).toEqual({
      action: 'none',
    })
  })

  it('soft-blocking 无 IPC 时仍清 pending 并插 system 消息计划', () => {
    expect(evaluateHitlOnSubmit({ blockingPolicy: 'soft' } as never, false)).toEqual({
      action: 'apply_soft_skip',
      plan: {
        clearPendingAskUser: true,
        clearAskUserSubmitting: true,
        appendAutoSkippedSystemMessage: true,
      },
    })
  })

  it('soft-blocking 有 interruptId 且 bridge 可用时附带 ipcSkip', () => {
    expect(evaluateHitlOnSubmit({
      blockingPolicy: 'soft',
      interruptId: 'int-1',
      threadId: 'thread-1',
    } as never, true)).toEqual({
      action: 'apply_soft_skip',
      plan: {
        clearPendingAskUser: true,
        clearAskUserSubmitting: true,
        appendAutoSkippedSystemMessage: true,
        ipcSkip: {
          interruptId: 'int-1',
          threadId: 'thread-1',
        },
      },
    })
  })
})

describe('buildSoftAskUserStoreClearPatch', () => {
  it('移除指定 session 的 pending 与 submitting', () => {
    expect(buildSoftAskUserStoreClearPatch(
      's1',
      { s1: { blockingPolicy: 'soft' } as never, s2: { blockingPolicy: 'soft' } as never },
      { s1: true, s2: false },
    )).toEqual({
      pendingAskUserBySessionId: { s2: { blockingPolicy: 'soft' } },
      askUserSubmittingBySessionId: { s2: false },
    })
  })
})
