import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  __resetDraftMessageSessionCoordinatorForTests,
  beginDraftMessageSession,
  cancelDraftMessageSessionByScopeKey,
} from '../../draftMessageSessionCoordinator'
import { bindDraftSessionToMessage } from '../../draftSession'
import {
  __resetPendingFirstSendRetryForTests,
  registerPendingFirstSendRetryHandler,
  retryPendingFirstSend,
} from '../pendingFirstSendRetry'

const SCOPE = 'conversation:draft:space-1'
const PENDING = 'local-pending-abc'

describe('pendingFirstSendRetry ', () => {
  beforeEach(() => {
    __resetDraftMessageSessionCoordinatorForTests()
    __resetPendingFirstSendRetryForTests()
    beginDraftMessageSession(SCOPE)
    bindDraftSessionToMessage(SCOPE, PENDING, { phase: 'sending' })
  })

  it('经 episode 绑定路由到注册面板的首发编排', () => {
    const handler = vi.fn()
    registerPendingFirstSendRetryHandler(SCOPE, handler)

    const handled = retryPendingFirstSend(PENDING, {
      message: 'hello again',
      contextBlocks: [{ type: 'file', file_id: 'f-1' }],
    })

    expect(handled).toBe(true)
    expect(handler).toHaveBeenCalledWith({
      message: 'hello again',
      contextBlocks: [{ type: 'file', file_id: 'f-1' }],
    })
  })

  it('episode 已取消（切走草稿）时返回 false，由调用方降级', () => {
    cancelDraftMessageSessionByScopeKey(SCOPE)
    const handler = vi.fn()
    registerPendingFirstSendRetryHandler(SCOPE, handler)

    expect(retryPendingFirstSend(PENDING, { message: 'x' })).toBe(false)
    expect(handler).not.toHaveBeenCalled()
  })

  it('面板未注册 handler 时返回 false', () => {
    expect(retryPendingFirstSend(PENDING, { message: 'x' })).toBe(false)
  })

  it('注销后不再路由；后注册的同 scope handler 不被旧注销误删', () => {
    const first = vi.fn()
    const second = vi.fn()
    const unregisterFirst = registerPendingFirstSendRetryHandler(SCOPE, first)
    registerPendingFirstSendRetryHandler(SCOPE, second)

    // 旧 handler 的注销（如面板重渲染 cleanup 乱序）不得删掉新 handler
    unregisterFirst()
    expect(retryPendingFirstSend(PENDING, { message: 'x' })).toBe(true)
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
  })
})
