import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  handle: vi.fn(),
  removeHandler: vi.fn(),
  isTrustedSender: vi.fn((event: { trusted?: boolean }) => event.trusted === true),
  takeOverByUser: vi.fn<(viewId: string) => string[]>(),
  collectTakeOverGroup: vi.fn(),
  collectHandBackGroup: vi.fn(),
  captureBrowserTabControlViewState: vi.fn(),
  restoreBrowserTabControlViewState: vi.fn(),
  handBackToAgent: vi.fn(),
  parkBrowserControl: vi.fn<(sessionIds: readonly string[]) => string[]>(),
  releaseBrowserControl: vi.fn<(sessionIds: readonly string[]) => string[]>(),
  areBrowserControlSessionsParked: vi.fn<(sessionIds: readonly string[]) => boolean>(),
  getBrowserControlStatus: vi.fn(),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: mocks.handle,
    removeHandler: mocks.removeHandler,
  },
}))

vi.mock('../../auth', () => ({
  isTrustedSender: mocks.isTrustedSender,
  isTinSandboxSender: () => false,
}))

vi.mock('../../logger', () => ({
  createLogger: () => mocks.log,
}))

vi.mock('../browserTabInputLock', () => ({
  takeOverByUser: mocks.takeOverByUser,
  collectTakeOverGroup: mocks.collectTakeOverGroup,
  collectHandBackGroup: mocks.collectHandBackGroup,
  captureBrowserTabControlViewState: mocks.captureBrowserTabControlViewState,
  restoreBrowserTabControlViewState: mocks.restoreBrowserTabControlViewState,
  handBackToAgent: mocks.handBackToAgent,
}))

vi.mock('../../agent/ElectronAgentHost', () => ({
  electronAgentHost: {
    parkBrowserControl: mocks.parkBrowserControl,
    releaseBrowserControl: mocks.releaseBrowserControl,
    areBrowserControlSessionsParked: mocks.areBrowserControlSessionsParked,
    getBrowserControlStatus: mocks.getBrowserControlStatus,
  },
}))

const {
  BROWSER_TAB_CONTROL_IPC_CHANNELS,
  registerBrowserTabControlIpc,
  unregisterBrowserTabControlIpc,
} = await import('../browserTabControlIpc')

type InvokeResult =
  | { success: boolean; sessionIds: string[]; releasedSessionIds?: string[] }
  | { ok: false; error: { code: string } }

async function invokeRaw(channel: string, trusted: boolean, viewId: unknown): Promise<unknown> {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`handler not registered: ${channel}`)
  return await handler({ trusted, senderFrame: { url: 'http://localhost:5175' } }, viewId)
}

async function invoke(channel: string, trusted: boolean, viewId: unknown): Promise<InvokeResult> {
  const result = await invokeRaw(channel, trusted, viewId)
  if (result && typeof result === 'object' && 'ok' in result && result.ok === true && 'data' in result) {
    return result.data as InvokeResult
  }
  return result as InvokeResult
}

describe('browser tab control IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.handlers.clear()
    mocks.handle.mockImplementation((channel, handler) => {
      mocks.handlers.set(channel, handler)
    })
    mocks.takeOverByUser.mockReturnValue([])
    mocks.captureBrowserTabControlViewState.mockImplementation((viewId) => ({
      viewId,
      locked: false,
      unscopedLocked: false,
      holderSessionIds: [],
      userControlledSessionIds: [],
      pendingHandBackNoticeSessionIds: [],
    }))
    mocks.collectTakeOverGroup.mockImplementation((viewId) => {
      const state = mocks.captureBrowserTabControlViewState(viewId)
      return {
        viewIds: state.holderSessionIds.length > 0 ? [viewId] : [],
        sessionIds: state.holderSessionIds,
      }
    })
    mocks.collectHandBackGroup.mockImplementation((viewId) => {
      const state = mocks.captureBrowserTabControlViewState(viewId)
      return {
        viewIds: state.userControlledSessionIds.length > 0 ? [viewId] : [],
        sessionIds: state.userControlledSessionIds,
      }
    })
    mocks.handBackToAgent.mockReturnValue({
      affectedSessionIds: [],
      releaseSessionIds: [],
    })
    mocks.parkBrowserControl.mockReturnValue([])
    mocks.releaseBrowserControl.mockReturnValue([])
    mocks.areBrowserControlSessionsParked.mockReturnValue(false)
    mocks.getBrowserControlStatus.mockReturnValue({
      ownedSessionIds: [],
      parkedSessionIds: [],
      unresolvedSessionIds: [],
    })
    registerBrowserTabControlIpc()
  })

  it('take-over 先登记控制权，host 确认全部 park 后才成功', async () => {
    mocks.captureBrowserTabControlViewState.mockReturnValue({
      viewId: 'view-1',
      locked: true,
      unscopedLocked: false,
      holderSessionIds: ['session-1'],
      userControlledSessionIds: [],
      pendingHandBackNoticeSessionIds: [],
    })
    mocks.takeOverByUser.mockReturnValue(['session-1'])
    mocks.parkBrowserControl.mockReturnValue(['session-1'])
    mocks.getBrowserControlStatus.mockReturnValue({
      ownedSessionIds: ['session-1'],
      parkedSessionIds: ['session-1'],
      unresolvedSessionIds: [],
    })

    await expect(invoke('browser-tab-control:take-over', true, 'view-1')).resolves.toEqual({
      success: true,
      sessionIds: ['session-1'],
    })
    expect(mocks.parkBrowserControl).toHaveBeenCalledWith(['session-1'])
    expect(mocks.takeOverByUser.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.parkBrowserControl.mock.invocationCallOrder[0])
  })

  it('成功与业务失败都使用 envelope，让 preload invokeIpc 可安全解包', async () => {
    mocks.captureBrowserTabControlViewState.mockReturnValue({
      viewId: 'view-1',
      locked: true,
      unscopedLocked: false,
      holderSessionIds: ['session-1'],
      userControlledSessionIds: [],
      pendingHandBackNoticeSessionIds: [],
    })
    mocks.takeOverByUser.mockReturnValue(['session-1'])
    mocks.parkBrowserControl.mockReturnValue(['session-1'])
    mocks.getBrowserControlStatus.mockReturnValue({
      ownedSessionIds: ['session-1'],
      parkedSessionIds: ['session-1'],
      unresolvedSessionIds: [],
    })

    await expect(invokeRaw('browser-tab-control:take-over', true, 'view-1')).resolves.toMatchObject({
      ok: true,
      data: { success: true, sessionIds: ['session-1'] },
    })
    await expect(invokeRaw('browser-tab-control:hand-back', true, 'unknown-view')).resolves.toMatchObject({
      ok: true,
      data: { success: false, sessionIds: [] },
    })
  })

  it('take-over 部分 session 不存在时回滚本次 park 与 registry，不谎报成功', async () => {
    const viewState = {
      viewId: 'view-1',
      locked: true,
      unscopedLocked: false,
      holderSessionIds: ['session-1', 'missing'],
      userControlledSessionIds: [],
      pendingHandBackNoticeSessionIds: [],
    }
    mocks.captureBrowserTabControlViewState.mockReturnValue(viewState)
    mocks.takeOverByUser.mockReturnValue(['session-1', 'missing'])
    mocks.parkBrowserControl.mockReturnValue(['session-1'])
    mocks.getBrowserControlStatus
      .mockReturnValueOnce({
        ownedSessionIds: [],
        parkedSessionIds: [],
        unresolvedSessionIds: [],
      })
      .mockReturnValue({
        ownedSessionIds: ['session-1'],
        parkedSessionIds: ['session-1'],
        unresolvedSessionIds: ['missing'],
      })

    await expect(invoke('browser-tab-control:take-over', true, 'view-1')).resolves.toEqual({
      success: false,
      sessionIds: [],
    })
    expect(mocks.releaseBrowserControl).toHaveBeenCalledWith(['session-1'])
    expect(mocks.restoreBrowserTabControlViewState).toHaveBeenCalledWith(viewState)
    expect(mocks.log.warn).toHaveBeenCalledWith(
      '浏览器接管失败，已回滚',
      expect.objectContaining({ viewId: 'view-1', requestedCount: 2, parkedCount: 1 }),
    )
  })

  it('重复 take-over 不重复 acquire，但 host 已持有全部 park 时仍幂等成功', async () => {
    mocks.captureBrowserTabControlViewState.mockReturnValue({
      viewId: 'view-1',
      locked: false,
      unscopedLocked: false,
      holderSessionIds: ['session-1'],
      userControlledSessionIds: ['session-1'],
      pendingHandBackNoticeSessionIds: [],
    })
    mocks.takeOverByUser.mockReturnValue(['session-1'])
    mocks.parkBrowserControl.mockReturnValue([])
    mocks.getBrowserControlStatus.mockReturnValue({
      ownedSessionIds: ['session-1'],
      parkedSessionIds: ['session-1'],
      unresolvedSessionIds: [],
    })

    await expect(invoke('browser-tab-control:take-over', true, 'view-1')).resolves.toEqual({
      success: true,
      sessionIds: ['session-1'],
    })
    expect(mocks.releaseBrowserControl).not.toHaveBeenCalled()
    expect(mocks.restoreBrowserTabControlViewState).not.toHaveBeenCalled()
  })

  it('重复 take-over 若 host 状态缺失，精确恢复此前用户控制态', async () => {
    const viewState = {
      viewId: 'view-1',
      locked: false,
      unscopedLocked: false,
      holderSessionIds: ['session-1'],
      userControlledSessionIds: ['session-1'],
      pendingHandBackNoticeSessionIds: [],
    }
    mocks.captureBrowserTabControlViewState.mockReturnValue(viewState)
    mocks.takeOverByUser.mockReturnValue(['session-1'])
    mocks.parkBrowserControl.mockReturnValue([])

    await expect(invoke('browser-tab-control:take-over', true, 'view-1')).resolves.toEqual({
      success: false,
      sessionIds: [],
    })
    expect(mocks.restoreBrowserTabControlViewState).toHaveBeenCalledWith(viewState)
  })

  it('hand-back 先解除 registry gate，再只释放 host 自己的 park', async () => {
    mocks.captureBrowserTabControlViewState.mockReturnValue({
      viewId: 'view-1',
      locked: false,
      unscopedLocked: false,
      holderSessionIds: ['session-1'],
      userControlledSessionIds: ['session-1'],
      pendingHandBackNoticeSessionIds: [],
    })
    mocks.handBackToAgent.mockReturnValue({
      affectedSessionIds: ['session-1'],
      releaseSessionIds: ['session-1'],
    })
    mocks.releaseBrowserControl.mockReturnValue(['session-1'])

    await expect(invoke('browser-tab-control:hand-back', true, 'view-1')).resolves.toEqual({
      success: true,
      sessionIds: ['session-1'],
      releasedSessionIds: ['session-1'],
    })
    expect(mocks.releaseBrowserControl).toHaveBeenCalledWith(['session-1'])
    expect(mocks.handBackToAgent.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.releaseBrowserControl.mock.invocationCallOrder[0])
  })

  it.each([
    ['browser-tab-control:take-over', ''],
    ['browser-tab-control:take-over', '   '],
    ['browser-tab-control:take-over', undefined],
    ['browser-tab-control:hand-back', ''],
    ['browser-tab-control:hand-back', null],
  ])('%s 拒绝空 viewId', async (channel, viewId) => {
    await expect(invoke(channel, true, viewId)).resolves.toEqual({
      success: false,
      sessionIds: [],
    })
    expect(mocks.takeOverByUser).not.toHaveBeenCalled()
    expect(mocks.handBackToAgent).not.toHaveBeenCalled()
  })

  it.each([
    'browser-tab-control:take-over',
    'browser-tab-control:hand-back',
  ])('%s 对未知 view 和重复空操作返回失败且无 host 副作用', async (channel) => {
    await expect(invoke(channel, true, 'unknown-view')).resolves.toEqual({
      success: false,
      sessionIds: [],
    })
    expect(mocks.parkBrowserControl).not.toHaveBeenCalled()
    expect(mocks.releaseBrowserControl).not.toHaveBeenCalled()
    if (channel === 'browser-tab-control:take-over') {
      expect(mocks.log.warn).toHaveBeenCalledWith(
        '浏览器接管失败，view 无持锁会话（无主锁）',
        { viewId: 'unknown-view' },
      )
    }
  })

  it('非可信 sender 由 guardedHandle 拒绝', async () => {
    const result = await invoke('browser-tab-control:take-over', false, 'view-1')

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'UNAUTHORIZED' },
    })
    expect(mocks.takeOverByUser).not.toHaveBeenCalled()
  })

  it('按模块 channel 清理 handler', () => {
    unregisterBrowserTabControlIpc()

    expect(BROWSER_TAB_CONTROL_IPC_CHANNELS).toEqual([
      'browser-tab-control:take-over',
      'browser-tab-control:hand-back',
    ])
    expect(mocks.removeHandler).toHaveBeenCalledWith('browser-tab-control:take-over')
    expect(mocks.removeHandler).toHaveBeenCalledWith('browser-tab-control:hand-back')
  })
})
