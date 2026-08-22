import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sendPlanExecution } from './planExecute'

const mockSetAgentMode = vi.fn()
const mockSendMessage = vi.fn()

vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => ({
      setAgentMode: mockSetAgentMode,
      sendMessage: mockSendMessage,
    }),
  },
}))

vi.mock('./planExecutedStore', () => ({
  markPlanExecuted: vi.fn(),
}))

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}))

describe('sendPlanExecution ', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSendMessage.mockResolvedValue(undefined)
  })

  it('切 agent 时按卡片 sessionId 写入', async () => {
    const ok = await sendPlanExecution({
      ref: { kind: 'file', path: '.tabtin/plans/demo.plan.md' },
      planName: 'demo',
      sessionId: 'sess-plan-card',
      spaceId: 'space-1',
    })

    expect(ok).toBe(true)
    expect(mockSetAgentMode).toHaveBeenCalledWith('agent', { sessionId: 'sess-plan-card' })
    expect(mockSendMessage).toHaveBeenCalled()
  })
})
