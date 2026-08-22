/**
 *  渲染进程网络自愈聚合器单测：阈值判定、节流、宿主 API 缺失安全。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COLLAB_STUCK_CONNECTING_EVENT } from '@tabtin/collab-core'
import {
  initCollabNetworkRecovery,
  NETWORK_RECOVERY_STUCK_THRESHOLD,
  __internal,
} from '@/services/collabNetworkRecovery'

function dispatchStuck(watchdogTriggerCount: number, documentName = 'doc-1'): void {
  window.dispatchEvent(
    new CustomEvent(COLLAB_STUCK_CONNECTING_EVENT, {
      detail: { documentName, watchdogTriggerCount },
    }),
  )
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('collabNetworkRecovery — 挂起聚合上报', () => {
  const recoverStack = vi.fn(async () => ({ performed: true, cooldownRemainingMs: 0 }))

  beforeEach(() => {
    vi.clearAllMocks()
    __internal.resetThrottle()
    ;(window as unknown as { tabtin?: unknown }).tabtin = { network: { recoverStack } }
    initCollabNetworkRecovery()
  })

  afterEach(() => {
    __internal.dispose()
    delete (window as unknown as { tabtin?: unknown }).tabtin
  })

  it('计数低于阈值不上报', async () => {
    dispatchStuck(NETWORK_RECOVERY_STUCK_THRESHOLD - 1)
    await flushMicrotasks()

    expect(recoverStack).not.toHaveBeenCalled()
  })

  it('计数达到阈值上报，reason 携带文档与计数', async () => {
    dispatchStuck(NETWORK_RECOVERY_STUCK_THRESHOLD, 'table:t-42')
    await flushMicrotasks()

    expect(recoverStack).toHaveBeenCalledTimes(1)
    expect(recoverStack).toHaveBeenCalledWith({
      reason: `collab_stuck_connecting:table:t-42:${NETWORK_RECOVERY_STUCK_THRESHOLD}`,
    })
  })

  it('节流窗口内多文档同时挂起只上报一次', async () => {
    dispatchStuck(NETWORK_RECOVERY_STUCK_THRESHOLD, 'doc-a')
    dispatchStuck(NETWORK_RECOVERY_STUCK_THRESHOLD + 1, 'doc-b')
    await flushMicrotasks()

    expect(recoverStack).toHaveBeenCalledTimes(1)
  })

  it('window.tabtin 缺失（web/测试环境）时静默安全', async () => {
    delete (window as unknown as { tabtin?: unknown }).tabtin
    __internal.resetThrottle()

    expect(() => dispatchStuck(NETWORK_RECOVERY_STUCK_THRESHOLD)).not.toThrow()
    await flushMicrotasks()
    expect(recoverStack).not.toHaveBeenCalled()
  })
})
