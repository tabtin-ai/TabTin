import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const powerListeners = vi.hoisted(() => new Map<string, () => void>())
const waitForApiReachable = vi.hoisted(() => vi.fn())
const touchAllViews = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  powerMonitor: {
    on: vi.fn((event: string, listener: () => void) => powerListeners.set(event, listener)),
    removeListener: vi.fn((event: string) => powerListeners.delete(event)),
  },
}))
vi.mock('./network/wait-for-api-reachable', () => ({ waitForApiReachable }))
vi.mock('./view-factory', () => ({ getViewFactory: () => ({ touchAllViews }) }))
vi.mock('./logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

import { installSystemSleepGuard } from './system-sleep-guard'

function createDeps() {
  return {
    getMainWindow: () => null,
    wsGateway: {
      suspend: vi.fn(),
      markResumeRecovering: vi.fn(),
      reconnectAfterResume: vi.fn().mockResolvedValue(true),
      clearResumeRecovering: vi.fn(),
    },
    agentServicePause: vi.fn(),
    agentServiceResume: vi.fn(),
    eventPersistence: {
      pauseFlush: vi.fn(),
      resumeFlush: vi.fn(),
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  powerListeners.clear()
  waitForApiReachable.mockReset().mockResolvedValue({ ok: true })
  touchAllViews.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('SystemSleepGuard WebSocket 恢复', () => {
  it('suspend 保留恢复上下文，resume 等网络可用后只重连一次', async () => {
    const deps = createDeps()
    const dispose = installSystemSleepGuard(deps as any)

    powerListeners.get('suspend')?.()
    powerListeners.get('resume')?.()
    powerListeners.get('resume')?.()
    await vi.advanceTimersByTimeAsync(3_000)

    expect(deps.wsGateway.suspend).toHaveBeenCalledOnce()
    expect(deps.wsGateway.markResumeRecovering).toHaveBeenCalledOnce()
    expect(waitForApiReachable).toHaveBeenCalledOnce()
    expect(deps.wsGateway.reconnectAfterResume).toHaveBeenCalledOnce()
    expect(deps.agentServicePause).toHaveBeenCalledOnce()
    expect(deps.agentServiceResume).toHaveBeenCalledOnce()
    expect(deps.eventPersistence.pauseFlush).toHaveBeenCalledOnce()
    expect(deps.eventPersistence.resumeFlush).toHaveBeenCalledOnce()

    dispose()
  })

  it('resume 延迟期间再次 suspend 会取消旧恢复，不创建并发连接', async () => {
    const deps = createDeps()
    const dispose = installSystemSleepGuard(deps as any)

    powerListeners.get('suspend')?.()
    powerListeners.get('resume')?.()
    powerListeners.get('suspend')?.()
    await vi.advanceTimersByTimeAsync(3_000)

    expect(deps.wsGateway.suspend).toHaveBeenCalledTimes(2)
    expect(deps.wsGateway.reconnectAfterResume).not.toHaveBeenCalled()
    expect(deps.agentServiceResume).not.toHaveBeenCalled()

    dispose()
  })

  it('没有先 suspend 的 resume 事件不触发无意义重连', async () => {
    const deps = createDeps()
    const dispose = installSystemSleepGuard(deps as any)

    powerListeners.get('resume')?.()
    await vi.advanceTimersByTimeAsync(3_000)

    expect(deps.wsGateway.markResumeRecovering).not.toHaveBeenCalled()
    expect(deps.wsGateway.reconnectAfterResume).not.toHaveBeenCalled()
    dispose()
  })

  it('恢复重连返回 false 时清除 recovering，但仍恢复本地服务', async () => {
    const deps = createDeps()
    deps.wsGateway.reconnectAfterResume.mockResolvedValue(false)
    const dispose = installSystemSleepGuard(deps as any)

    powerListeners.get('suspend')?.()
    powerListeners.get('resume')?.()
    await vi.advanceTimersByTimeAsync(3_000)

    expect(deps.wsGateway.clearResumeRecovering).toHaveBeenCalledOnce()
    expect(deps.agentServiceResume).toHaveBeenCalledOnce()
    expect(deps.eventPersistence.resumeFlush).toHaveBeenCalledOnce()
    dispose()
  })
})
