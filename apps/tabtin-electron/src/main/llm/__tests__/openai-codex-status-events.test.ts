import { describe, expect, it, vi } from 'vitest'

const send = vi.fn()
vi.mock('../../window-manager.js', () => ({
  getMainWindow: () => ({
    isDestroyed: () => false,
    webContents: { send },
  }),
}))

import {
  notifyOpenAICodexStatusChanged,
  onOpenAICodexStatusChanged,
} from '../openai-codex-status-events.js'

describe('openaiCodexStatusEvents', () => {
  it('先完成主进程清理，再通知 renderer 刷新目录', async () => {
    let releaseCleanup: (() => void) | undefined
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve
    })
    const unsubscribe = onOpenAICodexStatusChanged(async () => cleanupGate)

    const notifying = notifyOpenAICodexStatusChanged('disconnected')
    await Promise.resolve()
    expect(send).not.toHaveBeenCalled()

    releaseCleanup?.()
    await notifying

    expect(send).toHaveBeenCalledWith(
      'openai-codex:status-changed',
      { status: 'disconnected' },
    )
    unsubscribe()
  })
})
