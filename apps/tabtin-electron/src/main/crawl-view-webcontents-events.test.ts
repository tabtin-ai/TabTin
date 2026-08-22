import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import { bindCrawlViewWebContentsEvents } from './crawl-view-webcontents-events'

class FakeWebContents extends EventEmitter {}

function createBindings() {
  return {
    onDidStartLoading: vi.fn(),
    onDidFinishLoad: vi.fn(),
    onDidStopLoading: vi.fn(),
    onDidFailLoad: vi.fn(),
    onDidStartNavigation: vi.fn(),
    onDidNavigateInPage: vi.fn(),
    onDidFrameNavigate: vi.fn(),
    onDidFailProvisionalLoad: vi.fn(),
    onWillNavigate: vi.fn(),
    onPageTitleUpdated: vi.fn(),
    onPageFaviconUpdated: vi.fn(),
    onDidChangeThemeColor: vi.fn(),
    onConsoleMessage: vi.fn(),
  }
}

describe('crawl-view-webcontents-events', () => {
  it('cleanup 时只移除自己注册的监听，不影响外部监听器', () => {
    const webContents = new FakeWebContents() as any
    const externalDidFinishLoad = vi.fn()
    const externalTitleUpdated = vi.fn()
    const bindings = createBindings()

    webContents.on('did-finish-load', externalDidFinishLoad)
    webContents.on('page-title-updated', externalTitleUpdated)

    const cleanup = bindCrawlViewWebContentsEvents(webContents, bindings)

    webContents.emit('did-finish-load')
    webContents.emit('page-title-updated', {}, 'TabTin')

    expect(bindings.onDidFinishLoad).toHaveBeenCalledTimes(1)
    expect(bindings.onPageTitleUpdated).toHaveBeenCalledWith({}, 'TabTin')
    expect(externalDidFinishLoad).toHaveBeenCalledTimes(1)
    expect(externalTitleUpdated).toHaveBeenCalledWith({}, 'TabTin')

    cleanup()

    webContents.emit('did-finish-load')
    webContents.emit('page-title-updated', {}, 'TabTin 2')

    expect(bindings.onDidFinishLoad).toHaveBeenCalledTimes(1)
    expect(bindings.onPageTitleUpdated).toHaveBeenCalledTimes(1)
    expect(externalDidFinishLoad).toHaveBeenCalledTimes(2)
    expect(externalTitleUpdated).toHaveBeenCalledTimes(2)
  })
})
