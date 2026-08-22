import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  faviconResolver: {
    resolve: vi.fn(),
  },
}))

vi.mock('electron', () => ({
  app: { isPackaged: false },
}))

vi.mock('./webcontents/favicon-resolver', () => ({
  getFaviconResolver: () => mocks.faviconResolver,
}))

import { createCrawlViewFaviconController } from './crawl-view-favicon-controller'

class FakeWebContents extends EventEmitter {
  constructor(private readonly url: string) {
    super()
  }

  isDestroyed() {
    return false
  }

  getURL() {
    return this.url
  }
}

describe('crawl-view-favicon-controller', () => {
  it('只会为当前 attached view 发出 favicon 事件，旧 view 的异步结果会被忽略', async () => {
    let resolveFirst: ((value: string | null) => void) | null = null
    let resolveSecond: ((value: string | null) => void) | null = null

    mocks.faviconResolver.resolve
      .mockImplementationOnce(
        () =>
          new Promise<string | null>((resolve) => {
            resolveFirst = resolve
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<string | null>((resolve) => {
            resolveSecond = resolve
          }),
      )

    const emitFaviconChanged = vi.fn()
    const controller = createCrawlViewFaviconController({
      emitFaviconChanged,
    })
    const firstView = new FakeWebContents('https://example.com/view-1')
    const secondView = new FakeWebContents('https://example.com/view-2')

    controller.attach(firstView as any, 'view-1')
    controller.handleFaviconUpdated(firstView as any, 'view-1', ['https://example.com/1.ico'])

    controller.attach(secondView as any, 'view-2')
    controller.handleFaviconUpdated(secondView as any, 'view-2', ['https://example.com/2.ico'])

    resolveFirst?.('data:image/png;base64,old')
    await Promise.resolve()

    expect(emitFaviconChanged).not.toHaveBeenCalled()

    resolveSecond?.('data:image/png;base64,new')
    await Promise.resolve()

    expect(emitFaviconChanged).toHaveBeenCalledWith({
      favicon: 'data:image/png;base64,new',
      url: 'https://example.com/view-2',
      viewId: 'view-2',
    })
  })

  it('resolver 没拿到 dataUrl 时会回退到原始 favicon url', async () => {
    mocks.faviconResolver.resolve.mockResolvedValueOnce(null)

    const emitFaviconChanged = vi.fn()
    const controller = createCrawlViewFaviconController({
      emitFaviconChanged,
    })
    const currentView = new FakeWebContents('https://example.com/current')

    controller.attach(currentView as any, 'view-3')
    controller.handleFaviconUpdated(currentView as any, 'view-3', ['https://example.com/fallback.ico'])

    await Promise.resolve()

    expect(emitFaviconChanged).toHaveBeenCalledWith({
      favicon: 'https://example.com/fallback.ico',
      url: 'https://example.com/current',
      viewId: 'view-3',
    })
  })
})
