import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  handle: vi.fn(),
  removeHandler: vi.fn(),
  ownedSessionIds: new Set<string>(),
  parkBrowserControl: vi.fn<(sessionIds: readonly string[]) => string[]>(),
  releaseBrowserControl: vi.fn<(sessionIds: readonly string[]) => string[]>(),
  areBrowserControlSessionsParked: vi.fn<(sessionIds: readonly string[]) => boolean>(),
  getBrowserControlOwnedSessionIds: vi.fn<(sessionIds: readonly string[]) => string[]>(),
  getBrowserControlStatus: vi.fn<(sessionIds: readonly string[]) => {
    ownedSessionIds: string[]
    parkedSessionIds: string[]
    unresolvedSessionIds: string[]
  }>(),
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
  isTrustedSender: () => true,
  isTinSandboxSender: () => false,
}))

vi.mock('../../logger', () => ({
  createLogger: () => mocks.log,
}))

vi.mock('../../agent/ElectronAgentHost', () => ({
  electronAgentHost: {
    parkBrowserControl: mocks.parkBrowserControl,
    releaseBrowserControl: mocks.releaseBrowserControl,
    areBrowserControlSessionsParked: mocks.areBrowserControlSessionsParked,
    getBrowserControlOwnedSessionIds: mocks.getBrowserControlOwnedSessionIds,
    getBrowserControlStatus: mocks.getBrowserControlStatus,
  },
}))

const {
  captureBrowserTabControlViewState,
  consumeHandBackNotice,
  getBrowserTabControlSnapshot,
  isLocked,
  isUserControllingView,
  lock,
  resetBrowserTabInputLockForTests,
  takeOverByUser,
} = await import('../browserTabInputLock')
const { registerBrowserTabControlIpc } = await import('../browserTabControlIpc')

interface InvokeResult {
  success: boolean
  sessionIds: string[]
  releasedSessionIds?: string[]
}

async function invoke(channel: string, viewId: string): Promise<InvokeResult> {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`handler not registered: ${channel}`)
  const result = await handler(
    { senderFrame: { url: 'http://localhost:5175' } },
    viewId,
  ) as { ok: boolean; data: InvokeResult }
  return result.data
}

describe('browser tab control IPC registry/host integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetBrowserTabInputLockForTests()
    mocks.handlers.clear()
    mocks.ownedSessionIds.clear()
    mocks.handle.mockImplementation((channel, handler) => {
      mocks.handlers.set(channel, handler)
    })
    mocks.parkBrowserControl.mockImplementation((sessionIds) => {
      const added: string[] = []
      for (const sessionId of sessionIds) {
        if (mocks.ownedSessionIds.has(sessionId)) continue
        mocks.ownedSessionIds.add(sessionId)
        added.push(sessionId)
      }
      return added
    })
    mocks.releaseBrowserControl.mockImplementation((sessionIds) => {
      const released: string[] = []
      for (const sessionId of sessionIds) {
        if (!mocks.ownedSessionIds.delete(sessionId)) continue
        released.push(sessionId)
      }
      return released
    })
    mocks.areBrowserControlSessionsParked.mockImplementation(
      (sessionIds) => sessionIds.every((sessionId) => mocks.ownedSessionIds.has(sessionId)),
    )
    mocks.getBrowserControlOwnedSessionIds.mockImplementation(
      (sessionIds) => sessionIds.filter((sessionId) => mocks.ownedSessionIds.has(sessionId)),
    )
    mocks.getBrowserControlStatus.mockImplementation((sessionIds) => {
      const ownedSessionIds =
        sessionIds.filter((sessionId) => mocks.ownedSessionIds.has(sessionId))
      return {
        ownedSessionIds,
        parkedSessionIds: [...ownedSessionIds],
        unresolvedSessionIds: [],
      }
    })
    registerBrowserTabControlIpc()
  })

  it('同 session 多 view 一次 handback 整组 release，并区分 affected/released sessions', async () => {
    lock('view-1', 'session-1')
    lock('view-2', 'session-1')

    await expect(invoke('browser-tab-control:take-over', 'view-1')).resolves.toEqual({
      success: true,
      sessionIds: ['session-1'],
    })
    expect(getBrowserTabControlSnapshot()).toEqual({
      lockedViewIds: [],
      userControlledViewIds: ['view-1', 'view-2'],
      sessionIdsByViewId: {
        'view-1': ['session-1'],
        'view-2': ['session-1'],
      },
    })
    expect(mocks.ownedSessionIds).toEqual(new Set(['session-1']))
    expect(consumeHandBackNotice('session-1')).toBe(false)

    await expect(invoke('browser-tab-control:take-over', 'view-2')).resolves.toEqual({
      success: true,
      sessionIds: ['session-1'],
    })
    expect(getBrowserTabControlSnapshot()).toEqual({
      lockedViewIds: [],
      userControlledViewIds: ['view-1', 'view-2'],
      sessionIdsByViewId: {
        'view-1': ['session-1'],
        'view-2': ['session-1'],
      },
    })
    expect(mocks.ownedSessionIds).toEqual(new Set(['session-1']))

    await expect(invoke('browser-tab-control:hand-back', 'view-1')).resolves.toEqual({
      success: true,
      sessionIds: ['session-1'],
      releasedSessionIds: ['session-1'],
    })
    expect(mocks.releaseBrowserControl).toHaveBeenCalledWith(['session-1'])
    expect(mocks.ownedSessionIds.size).toBe(0)
    expect(getBrowserTabControlSnapshot()).toEqual({
      lockedViewIds: ['view-1', 'view-2'],
      userControlledViewIds: [],
      sessionIdsByViewId: {
        'view-1': ['session-1'],
        'view-2': ['session-1'],
      },
    })
    expect(consumeHandBackNotice('session-1')).toBe(true)
    expect(consumeHandBackNotice('session-1')).toBe(false)
  })

  it('多 holder 部分 park 失败时精确恢复接管前 view state', async () => {
    lock('view-1', 'session-1')
    lock('view-1', 'session-2')
    const before = captureBrowserTabControlViewState('view-1')
    mocks.parkBrowserControl.mockImplementation((sessionIds) => {
      const parked = sessionIds.filter((sessionId) => sessionId === 'session-1')
      for (const sessionId of parked) mocks.ownedSessionIds.add(sessionId)
      return parked
    })

    await expect(invoke('browser-tab-control:take-over', 'view-1')).resolves.toMatchObject({
      success: false,
      sessionIds: [],
    })

    expect(captureBrowserTabControlViewState('view-1')).toEqual(before)
    expect(mocks.ownedSessionIds.size).toBe(0)
    expect(consumeHandBackNotice('session-2')).toBe(false)
  })

  it.each(['park', 'confirm'] as const)(
    '%s 抛错时只释放本次新增 ownership 并恢复 snapshot',
    async (failureAt) => {
      lock('view-1', 'session-1')
      lock('view-1', 'session-2')
      const before = captureBrowserTabControlViewState('view-1')

      if (failureAt === 'park') {
        mocks.parkBrowserControl.mockImplementation((sessionIds) => {
          for (const sessionId of sessionIds) mocks.ownedSessionIds.add(sessionId)
          throw new Error('park failed')
        })
      } else {
        mocks.parkBrowserControl.mockImplementation((sessionIds) => {
          const added = sessionIds.filter((sessionId) => !mocks.ownedSessionIds.has(sessionId))
          for (const sessionId of added) mocks.ownedSessionIds.add(sessionId)
          return added
        })
        mocks.getBrowserControlStatus
          .mockImplementationOnce(() => ({
            ownedSessionIds: [],
            parkedSessionIds: [],
            unresolvedSessionIds: [],
          }))
          .mockImplementation(() => { throw new Error('confirm failed') })
      }

      await expect(invoke('browser-tab-control:take-over', 'view-1')).resolves.toMatchObject({
        success: false,
        sessionIds: [],
      })
      expect(captureBrowserTabControlViewState('view-1')).toEqual(before)
      expect(mocks.ownedSessionIds.size).toBe(0)
      expect(consumeHandBackNotice('session-2')).toBe(false)
      expect(mocks.log.warn).toHaveBeenCalledWith(
        '浏览器接管失败，已回滚',
        expect.objectContaining({ viewId: 'view-1' }),
      )
    },
  )

  it('接管失败时回滚组内全部 view 的控制态', async () => {
    lock('view-1', 'session-1')
    lock('view-2', 'session-1')
    const before = getBrowserTabControlSnapshot()
    mocks.parkBrowserControl.mockImplementation((sessionIds) => {
      for (const sessionId of sessionIds) mocks.ownedSessionIds.add(sessionId)
      throw new Error('park boom')
    })

    await expect(invoke('browser-tab-control:take-over', 'view-1')).resolves.toEqual({
      success: false,
      sessionIds: [],
    })

    expect(getBrowserTabControlSnapshot()).toEqual(before)
    expect(mocks.ownedSessionIds.size).toBe(0)
  })

  it('takeover 初始状态查询抛错时不释放既有 ownership', async () => {
    lock('view-1', 'session-1')
    await invoke('browser-tab-control:take-over', 'view-1')
    const before = captureBrowserTabControlViewState('view-1')
    mocks.getBrowserControlStatus
      .mockImplementationOnce(() => {
        throw new Error('initial status failed')
      })
      .mockImplementation((sessionIds) => ({
        ownedSessionIds:
          sessionIds.filter((sessionId) => mocks.ownedSessionIds.has(sessionId)),
        parkedSessionIds:
          sessionIds.filter((sessionId) => mocks.ownedSessionIds.has(sessionId)),
        unresolvedSessionIds: [],
      }))

    await expect(invoke('browser-tab-control:take-over', 'view-1')).resolves.toMatchObject({
      success: false,
      sessionIds: [],
    })
    expect(captureBrowserTabControlViewState('view-1')).toEqual(before)
    expect(mocks.ownedSessionIds).toEqual(new Set(['session-1']))
    expect(mocks.releaseBrowserControl).not.toHaveBeenCalled()
  })

  it.each(['partial', 'throw'] as const)(
    'handback %s release 失败时恢复用户控制并确保全部仍 parked',
    async (failureAt) => {
      lock('view-1', 'session-1')
      lock('view-1', 'session-2')
      await invoke('browser-tab-control:take-over', 'view-1')
      const before = getBrowserTabControlSnapshot()

      mocks.releaseBrowserControl.mockImplementation(() => {
        mocks.ownedSessionIds.delete('session-1')
        if (failureAt === 'throw') throw new Error('release failed')
        return ['session-1']
      })

      await expect(invoke('browser-tab-control:hand-back', 'view-1')).resolves.toMatchObject({
        success: false,
        sessionIds: [],
        releasedSessionIds: [],
      })
      expect(getBrowserTabControlSnapshot()).toEqual(before)
      expect(mocks.ownedSessionIds).toEqual(new Set(['session-1', 'session-2']))
      expect(consumeHandBackNotice('session-1')).toBe(false)
      expect(consumeHandBackNotice('session-2')).toBe(false)
    },
  )

  it('交还失败时恢复组内全部 view 的用户控制态', async () => {
    lock('view-1', 'session-1')
    lock('view-2', 'session-1')
    await invoke('browser-tab-control:take-over', 'view-1')
    const before = getBrowserTabControlSnapshot()
    mocks.releaseBrowserControl.mockImplementation(() => {
      mocks.ownedSessionIds.delete('session-1')
      throw new Error('release boom')
    })

    await expect(invoke('browser-tab-control:hand-back', 'view-2')).resolves.toEqual({
      success: false,
      sessionIds: [],
      releasedSessionIds: [],
    })

    expect(getBrowserTabControlSnapshot()).toEqual(before)
    expect(isLocked('view-1')).toBe(false)
    expect(isLocked('view-2')).toBe(false)
    expect(isUserControllingView('view-1')).toBe(true)
    expect(isUserControllingView('view-2')).toBe(true)
    expect(mocks.ownedSessionIds).toEqual(new Set(['session-1']))
    expect(consumeHandBackNotice('session-1')).toBe(false)
  })

  it('final-release session 原本无 ownership 且确认未 parked 时可成功', async () => {
    lock('view-1', 'session-1')
    takeOverByUser('view-1')

    await expect(invoke('browser-tab-control:hand-back', 'view-1')).resolves.toEqual({
      success: true,
      sessionIds: ['session-1'],
      releasedSessionIds: ['session-1'],
    })
    expect(mocks.releaseBrowserControl).toHaveBeenCalledWith(['session-1'])
    expect(mocks.ownedSessionIds.size).toBe(0)
    expect(consumeHandBackNotice('session-1')).toBe(true)
  })

  it('handback 异常只重建事务前已有 ownership', async () => {
    lock('view-1', 'session-1')
    lock('view-1', 'session-2')
    takeOverByUser('view-1')
    mocks.ownedSessionIds.add('session-1')
    const before = getBrowserTabControlSnapshot()
    mocks.releaseBrowserControl.mockImplementation(() => {
      mocks.ownedSessionIds.delete('session-1')
      throw new Error('release failed')
    })

    await expect(invoke('browser-tab-control:hand-back', 'view-1')).resolves.toMatchObject({
      success: false,
      sessionIds: [],
    })
    expect(getBrowserTabControlSnapshot()).toEqual(before)
    expect(mocks.ownedSessionIds).toEqual(new Set(['session-1']))
    expect(consumeHandBackNotice('session-1')).toBe(false)
    expect(consumeHandBackNotice('session-2')).toBe(false)
  })
})
