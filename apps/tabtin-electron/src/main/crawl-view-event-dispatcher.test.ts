import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  runSessionManager: {
    getRunIdByView: vi.fn((viewId: string) => viewId === 'view-1' ? 'run-1' : null),
    addObservation: vi.fn(),
  },
  eventBridge: {
    push: vi.fn(),
  },
}))

vi.mock('./run-session/RunSessionManager', () => ({
  getRunSessionManager: () => mocks.runSessionManager,
}))

vi.mock('./run-session/EventBridge', () => ({
  getEventBridge: () => mocks.eventBridge,
}))

import { dispatchCrawlViewEvent } from './crawl-view-event-dispatcher'

describe('crawl-view-event-dispatcher', () => {
  it('会把 crawl 事件统一分发给 RunSession、EventBridge、renderer 和主进程订阅者', () => {
    const send = vi.fn()
    const externalListener = vi.fn()

    dispatchCrawlViewEvent({
      type: 'page:loaded',
      data: {
        url: 'https://tabtin.ai',
        title: 'TabTin',
      },
      fallbackViewId: 'view-1',
      mainWindow: {
        isDestroyed: () => false,
        webContents: {
          send,
        },
      } as any,
      externalListeners: [externalListener],
      timestamp: 123,
    })

    expect(mocks.runSessionManager.addObservation).toHaveBeenCalledWith({
      viewId: 'view-1',
      type: 'page:loaded',
      timestamp: 123,
      data: {
        url: 'https://tabtin.ai',
        title: 'TabTin',
        viewId: 'view-1',
      },
      context: {
        url: 'https://tabtin.ai',
        title: 'TabTin',
        error: undefined,
      },
    })
    expect(mocks.eventBridge.push).toHaveBeenCalledWith({
      type: 'page:loaded',
      timestamp: 123,
      runId: 'run-1',
      data: {
        url: 'https://tabtin.ai',
        title: 'TabTin',
        viewId: 'view-1',
      },
    })
    expect(send).toHaveBeenCalledWith('crawl-view:event', {
      type: 'page:loaded',
      timestamp: 123,
      runId: 'run-1',
      data: {
        url: 'https://tabtin.ai',
        title: 'TabTin',
        viewId: 'view-1',
      },
    })
    expect(externalListener).toHaveBeenCalledWith({
      type: 'page:loaded',
      timestamp: 123,
      runId: 'run-1',
      data: {
        url: 'https://tabtin.ai',
        title: 'TabTin',
        viewId: 'view-1',
      },
    })
  })
})
