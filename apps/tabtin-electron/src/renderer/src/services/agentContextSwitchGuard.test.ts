import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  abortRun,
  getBusySessionIds,
  getState,
  requestConfirm,
  toast,
} = vi.hoisted(() => ({
  getState: vi.fn(),
  abortRun: vi.fn(),
  getBusySessionIds: vi.fn(() => []),
  requestConfirm: vi.fn(),
  toast: vi.fn(),
}))

const chatSessions = [{ id: 'session-1', title: '正在整理文档' }]

vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => ({ sessions: chatSessions }),
  },
}))

vi.mock('@/stores/chat/execution/sessionRunProjection', () => ({
  getBusySessionIds,
}))

vi.mock('@components/app/agentContextSwitchConfirm', () => ({
  requestAgentContextSwitchConfirm: requestConfirm,
}))

vi.mock('@tabtin/smartsheet-ui', () => ({ toast }))

import { runWithAgentContextSwitchGuard } from './agentContextSwitchGuard'

describe('runWithAgentContextSwitchGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getBusySessionIds.mockReturnValue([])
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: {
        agentEngine: { getState, abortRun },
      },
    })
  })

  it('没有运行会话时直接继续原操作', async () => {
    const proceed = vi.fn()
    getState.mockResolvedValue({
      busy: false,
      busySessions: [],
    })

    await expect(runWithAgentContextSwitchGuard('organization', proceed)).resolves.toBe(true)

    expect(proceed).toHaveBeenCalledOnce()
    expect(requestConfirm).not.toHaveBeenCalled()
  })

  it('新主进程明确返回空 busySessions 时不读取可能滞后的 renderer 投影', async () => {
    const proceed = vi.fn()
    getBusySessionIds.mockReturnValue(['stale-session'])
    getState.mockResolvedValue({
      busy: false,
      busySessions: [],
    })

    await expect(runWithAgentContextSwitchGuard('organization', proceed)).resolves.toBe(true)

    expect(proceed).toHaveBeenCalledOnce()
    expect(requestConfirm).not.toHaveBeenCalled()
  })

  it('确认后停止所有本机会话，idle 后才继续原操作', async () => {
    const proceed = vi.fn()
    getState
      .mockResolvedValueOnce({
        busy: true,
        busySessions: [{
          sessionId: 'session-1',
          organizationId: 'org-1',
          queuedRunIds: ['queued-1'],
        }],
      })
      // stop 开始时重查仍 busy
      .mockResolvedValueOnce({
        busy: true,
        busySessions: [{
          sessionId: 'session-1',
          organizationId: 'org-1',
          queuedRunIds: ['queued-1'],
        }],
      })
      // 单会话仍 busy，才发 abort
      .mockResolvedValueOnce({ busy: true })
      .mockResolvedValueOnce({ busy: false })
      .mockResolvedValueOnce({ busy: false, busySessions: [] })
    abortRun.mockResolvedValue({
      localHit: true,
      remoteRequested: true,
      remoteAccepted: true,
      remotePublished: 1,
    })
    requestConfirm.mockImplementation(async (input: { stop: () => Promise<boolean> }) => input.stop())

    await expect(runWithAgentContextSwitchGuard('logout', proceed)).resolves.toBe(true)

    expect(requestConfirm).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'logout',
      sessions: [{ sessionId: 'session-1', title: '正在整理文档', queuedCount: 1 }],
    }))
    expect(abortRun).toHaveBeenCalledWith('session-1')
    expect(proceed).toHaveBeenCalledOnce()
  })

  it('弹窗等待期间任务已自行结束后确认，不再发中断', async () => {
    const proceed = vi.fn()
    getState
      .mockResolvedValueOnce({
        busy: true,
        busySessions: [{ sessionId: 'session-1', organizationId: 'org-1', queuedRunIds: [] }],
      })
      // 用户点确认时已 idle
      .mockResolvedValueOnce({ busy: false, busySessions: [] })
    requestConfirm.mockImplementation(async (input: { stop: () => Promise<boolean> }) => input.stop())

    await expect(runWithAgentContextSwitchGuard('organization', proceed)).resolves.toBe(true)

    expect(abortRun).not.toHaveBeenCalled()
    expect(proceed).toHaveBeenCalledOnce()
  })

  it('停止期间新出现的会话也会停止后才继续原操作', async () => {
    const proceed = vi.fn()
    getState
      .mockResolvedValueOnce({
        busy: true,
        busySessions: [{ sessionId: 'session-1', organizationId: 'org-1', queuedRunIds: [] }],
      })
      // stop 重查 session-1
      .mockResolvedValueOnce({
        busy: true,
        busySessions: [{ sessionId: 'session-1', organizationId: 'org-1', queuedRunIds: [] }],
      })
      .mockResolvedValueOnce({ busy: true })
      .mockResolvedValueOnce({ busy: false })
      // 停止后又冒出 session-2
      .mockResolvedValueOnce({
        busy: true,
        busySessions: [{ sessionId: 'session-2', organizationId: 'org-1', queuedRunIds: [] }],
      })
      .mockResolvedValueOnce({ busy: true })
      .mockResolvedValueOnce({ busy: false })
      .mockResolvedValueOnce({ busy: false, busySessions: [] })
    abortRun.mockResolvedValue({
      localHit: true,
      remoteRequested: true,
      remoteAccepted: true,
      remotePublished: 1,
    })
    requestConfirm.mockImplementation(async (input: { stop: () => Promise<boolean> }) => input.stop())

    await expect(runWithAgentContextSwitchGuard('organization', proceed)).resolves.toBe(true)

    expect(abortRun).toHaveBeenNthCalledWith(1, 'session-1')
    expect(abortRun).toHaveBeenNthCalledWith(2, 'session-2')
    expect(proceed).toHaveBeenCalledOnce()
  })
})
