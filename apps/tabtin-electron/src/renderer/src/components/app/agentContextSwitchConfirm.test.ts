import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cancelAgentContextSwitchConfirm,
  confirmAgentContextSwitch,
  requestAgentContextSwitchConfirm,
  useAgentContextSwitchConfirmStore,
} from './agentContextSwitchConfirm'

afterEach(() => {
  cancelAgentContextSwitchConfirm()
  vi.clearAllMocks()
})

describe('agentContextSwitchConfirm', () => {
  it('确认停止成功后才放行后续切换', async () => {
    const stop = vi.fn().mockResolvedValue(true)
    const result = requestAgentContextSwitchConfirm({
      kind: 'organization',
      sessions: [{ sessionId: 'session-1', title: '运行中的任务', queuedCount: 0 }],
      stop,
    })

    expect(useAgentContextSwitchConfirmStore.getState()).toMatchObject({
      open: true,
      kind: 'organization',
      isStopping: false,
    })

    await confirmAgentContextSwitch()

    await expect(result).resolves.toBe(true)
    expect(stop).toHaveBeenCalledOnce()
    expect(useAgentContextSwitchConfirmStore.getState().open).toBe(false)
  })

  it('停止失败时保持弹窗打开，不放行上下文切换', async () => {
    const stop = vi.fn().mockResolvedValue(false)
    const result = requestAgentContextSwitchConfirm({
      kind: 'logout',
      sessions: [{ sessionId: 'session-1', title: '运行中的任务', queuedCount: 1 }],
      stop,
    })

    await confirmAgentContextSwitch()

    expect(stop).toHaveBeenCalledOnce()
    expect(useAgentContextSwitchConfirmStore.getState()).toMatchObject({
      open: true,
      isStopping: false,
      error: '任务尚未完全停止，请稍后重试。',
    })

    cancelAgentContextSwitchConfirm()
    await expect(result).resolves.toBe(false)
  })
})
