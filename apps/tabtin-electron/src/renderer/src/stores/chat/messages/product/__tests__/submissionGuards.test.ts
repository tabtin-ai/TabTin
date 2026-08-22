import { describe, expect, it } from 'vitest'
import {
  evaluateDeliverySubmission,
  evaluatePreLockSubmission,
} from '../delivery/submissionGuards'

describe('evaluatePreLockSubmission', () => {
  const base = {
    sessionId: 'session-1',
    restoringSessionId: null,
    pendingApprovalBySessionId: {},
    pendingAskUserBySessionId: {},
  }

  it('无 session 时阻断', () => {
    expect(evaluatePreLockSubmission({ ...base, sessionId: null })).toEqual({
      ok: false,
      reason: 'no_session',
      queueReason: 'no_session',
      userFeedback: 'silent',
    })
  })

  it('restoring 同 session 时阻断', () => {
    expect(evaluatePreLockSubmission({
      ...base,
      restoringSessionId: 'session-1',
    })).toEqual({
      ok: false,
      reason: 'restoring',
      queueReason: 'restoring',
      userFeedback: 'restoring_toast',
    })
  })

  it('restoring 其他 session 时不阻断', () => {
    expect(evaluatePreLockSubmission({
      ...base,
      restoringSessionId: 'session-other',
    })).toEqual({ ok: true })
  })

})

describe('evaluateDeliverySubmission', () => {
  const baseSession = {
    sessionId: 'session-1',
    restoringSessionId: null,
    pendingApprovalBySessionId: {},
    pendingAskUserBySessionId: {},
  }

  const capableDelivery = {
    sendRoute: 'runtime' as const,
    modelConfigured: true,
  }

  it('待审批时不阻断（直送 host 排队）', () => {
    expect(evaluateDeliverySubmission(
      {
        ...baseSession,
        pendingApprovalBySessionId: {
          'session-1': { batchId: 'b1' } as never,
        },
      },
      capableDelivery,
    )).toEqual({ ok: true })
  })

  it('hard askUser 时不阻断（直送 host 排队）', () => {
    expect(evaluateDeliverySubmission(
      {
        ...baseSession,
        pendingAskUserBySessionId: {
          'session-1': { blockingPolicy: 'hard' } as never,
        },
      },
      capableDelivery,
    )).toEqual({ ok: true })
  })

  it('soft askUser 不阻断（由 hitlOnSubmit 处理）', () => {
    expect(evaluateDeliverySubmission(
      {
        ...baseSession,
        pendingAskUserBySessionId: {
          'session-1': { blockingPolicy: 'soft' } as never,
        },
      },
      capableDelivery,
    )).toEqual({ ok: true })
  })

  it('sendRoute unavailable 时阻断', () => {
    expect(evaluateDeliverySubmission(baseSession, {
      ...capableDelivery,
      sendRoute: 'unavailable',
    })).toEqual({
      ok: false,
      reason: 'no_runtime',
      queueReason: 'no_runtime',
      userFeedback: 'device_required_toast',
    })
  })

  it('gateway 路由允许', () => {
    expect(evaluateDeliverySubmission(baseSession, {
      sendRoute: 'gateway',
      modelConfigured: true,
    })).toEqual({ ok: true })
  })

  it('无模型时阻断', () => {
    expect(evaluateDeliverySubmission(baseSession, {
      ...capableDelivery,
      modelConfigured: false,
    })).toEqual({
      ok: false,
      reason: 'no_model',
      queueReason: 'no_model',
      userFeedback: 'model_required_toast',
    })
  })
})
