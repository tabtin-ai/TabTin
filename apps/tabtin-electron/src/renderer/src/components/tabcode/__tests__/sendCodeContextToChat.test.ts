import { beforeEach, describe, expect, it, vi } from 'vitest'

const deliverContextInjectToChat = vi.fn()

vi.mock('@/services/deliverContextInjectToChat', () => ({
  deliverContextInjectToChat: (...args: unknown[]) => deliverContextInjectToChat(...args),
}))

import { sendCodeContextToChat } from '../sendCodeContextToChat'

describe('sendCodeContextToChat', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    deliverContextInjectToChat.mockReturnValue({
      ok: true,
      mode: 'current-session',
      scopeId: 'session-1',
      tabScopeKey: 'conversation:session-1',
    })
  })

  it('TabCode 多入口统一走 deliverContextInjectToChat', () => {
    const payload = {
      type: 'code_file' as const,
      resourceId: 'file-1',
      label: 'a.ts',
      meta: { filePath: 'a.ts' },
    }

    const result = sendCodeContextToChat(payload)

    expect(deliverContextInjectToChat).toHaveBeenCalledTimes(1)
    expect(deliverContextInjectToChat).toHaveBeenCalledWith(payload)
    expect(result).toEqual({
      ok: true,
      mode: 'current-session',
      scopeId: 'session-1',
      tabScopeKey: 'conversation:session-1',
    })
  })
})
