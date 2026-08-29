import { beforeEach, describe, expect, it, vi } from 'vitest'

const persistedEvents = vi.hoisted(() => [] as any[])

vi.mock('../EventPersistence', () => ({
  getEventPersistence: () => ({
    getEvents: () => persistedEvents,
  }),
}))

vi.mock('../../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

import { ReplayEngine } from '../ReplayEngine'
import {
  BrowserTabUserInControlError,
  lock,
  resetBrowserTabInputLockForTests,
  takeOverByUser,
} from '../../browser-tab-lock/browserTabInputLock'

function replayEvent(viewId: string, index: number) {
  return {
    id: `event-${index}`,
    runId: 'run-1',
    viewId,
    type: 'execute_act',
    timestamp: index,
    data: { actions: [{ type: 'click', selector: `#button-${index}` }] },
  }
}

const EFFECTIVE_TARGET_CASES = [
  {
    name: 'TAB_SWITCHED 缺失 event.viewId',
    type: 'TAB_SWITCHED',
    sourceViewId: undefined,
  },
  {
    name: 'TAB_SWITCHED 的 event.viewId 与 data.tabId 不一致',
    type: 'TAB_SWITCHED',
    sourceViewId: 'view-safe',
  },
  {
    name: 'TAB_CLOSED 缺失 event.viewId',
    type: 'TAB_CLOSED',
    sourceViewId: undefined,
  },
  {
    name: 'TAB_CLOSED 的 event.viewId 与 data.tabId 不一致',
    type: 'TAB_CLOSED',
    sourceViewId: 'view-safe',
  },
] as const

describe('ReplayEngine browser view 用户控制租约', () => {
  beforeEach(() => {
    persistedEvents.length = 0
    resetBrowserTabInputLockForTests()
  })

  it('同步 replay 的首个受控 event 在 executor 前停止', async () => {
    persistedEvents.push(replayEvent('view-1', 1))
    lock('view-1', 'session-1')
    takeOverByUser('view-1')
    const executor = vi.fn()
    const engine = new ReplayEngine()
    engine.setActionExecutor(executor)

    await expect(engine.replay('run-1'))
      .rejects.toBeInstanceOf(BrowserTabUserInControlError)
    expect(executor).not.toHaveBeenCalled()
  })

  it('异步 replay 在事件间发生接管时停止下一个及后续 event', async () => {
    persistedEvents.push(
      replayEvent('view-safe', 1),
      replayEvent('view-controlled', 2),
      replayEvent('view-after', 3),
    )
    const executor = vi.fn(async () => {
      lock('view-controlled', 'session-1')
      takeOverByUser('view-controlled')
      return { success: true }
    })
    const engine = new ReplayEngine()
    engine.setActionExecutor(executor)

    await expect(engine.replay('run-1', { stopOnError: false }))
      .rejects.toBeInstanceOf(BrowserTabUserInControlError)
    expect(executor).toHaveBeenCalledTimes(1)
  })

  it.each(EFFECTIVE_TARGET_CASES)(
    '$name 时按实际 executor tabId 硬停',
    async ({ type, sourceViewId }) => {
      persistedEvents.push({
        id: 1,
        runId: 'run-effective-target',
        ...(sourceViewId ? { viewId: sourceViewId } : {}),
        type,
        timestamp: 1,
        data: { tabId: 'view-controlled' },
      })
      lock('view-controlled', 'session-1')
      takeOverByUser('view-controlled')
      const executor = vi.fn()
      const engine = new ReplayEngine()
      engine.setActionExecutor(executor)

      await expect(engine.replay('run-effective-target'))
        .rejects.toMatchObject({
          code: 'BROWSER_TAB_USER_IN_CONTROL',
          viewId: 'view-controlled',
        })
      expect(executor).not.toHaveBeenCalled()
    },
  )
})
