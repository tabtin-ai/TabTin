import { describe, expect, it, vi } from 'vitest'

const { syncWorkspaceViewMetadata } = vi.hoisted(() => ({
  syncWorkspaceViewMetadata: vi.fn(),
}))

vi.mock('./view-metadata-sync', () => ({
  syncWorkspaceViewMetadata,
}))

import { connectCrawlspaceViewEventSync } from './crawl-view-event-sync'

describe('connectCrawlspaceViewEventSync', () => {
  it('会把 theme-color:changed 事件同步到 workspace view 元数据链', () => {
    let listener: ((event: any) => void) | undefined
    const unsubscribe = vi.fn()

    const disconnect = connectCrawlspaceViewEventSync((registeredListener) => {
      listener = registeredListener
      return unsubscribe
    })

    listener?.({
      type: 'theme-color:changed',
      timestamp: Date.now(),
      data: {
        viewId: 'view-1',
        themeColor: '#654321',
      },
    })

    expect(syncWorkspaceViewMetadata).toHaveBeenCalledWith({
      viewId: 'view-1',
      themeColor: '#654321',
    })
    expect(disconnect).toBe(unsubscribe)
  })
})
