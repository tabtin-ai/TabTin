import { EventEmitter } from 'node:events'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  nativeTheme: {
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  extractThemeColor: vi.fn(async (webContents: { getURL: () => string }) => ({
    color: webContents.getURL().includes('dark') ? '#111111' : '#f5f3f0',
    source: 'meta',
  })),
}))

vi.mock('electron', () => ({
  nativeTheme: mocks.nativeTheme,
}))

vi.mock('./webcontents/theme-color-extractor', () => ({
  extractThemeColor: mocks.extractThemeColor,
}))

import { createCrawlViewThemeColorController } from './crawl-view-theme-color-controller'

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

describe('crawl-view-theme-color-controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('只会为当前 attached view 发出主题色事件，并在 detach 时取消挂起任务', async () => {
    const emitThemeColorChanged = vi.fn()
    const controller = createCrawlViewThemeColorController({
      emitThemeColorChanged,
    })
    const firstView = new FakeWebContents('https://example.com/light')
    const secondView = new FakeWebContents('https://example.com/dark')

    controller.attach(firstView as any, 'view-1')
    controller.scheduleExtraction(firstView as any, 'view-1')
    controller.detach()

    await vi.advanceTimersByTimeAsync(300)
    expect(emitThemeColorChanged).not.toHaveBeenCalled()

    controller.attach(secondView as any, 'view-2')
    controller.scheduleExtraction(secondView as any, 'view-2')
    await vi.advanceTimersByTimeAsync(300)

    expect(emitThemeColorChanged).toHaveBeenCalledWith({
      themeColor: '#111111',
      source: 'meta',
      url: 'https://example.com/dark',
      viewId: 'view-2',
    })
  })

  it('系统主题变化时会重新提取当前 attached view 的主题色', async () => {
    const emitThemeColorChanged = vi.fn()
    const controller = createCrawlViewThemeColorController({
      emitThemeColorChanged,
    })
    const currentView = new FakeWebContents('https://example.com/dark')

    controller.attach(currentView as any, 'view-2')

    const updatedHandler = mocks.nativeTheme.on.mock.calls[0]?.[1]
    updatedHandler()
    await vi.advanceTimersByTimeAsync(300)

    expect(emitThemeColorChanged).toHaveBeenCalledWith({
      themeColor: '#111111',
      source: 'meta',
      url: 'https://example.com/dark',
      viewId: 'view-2',
    })
  })

  it('支持多阶段重采样，并对重复结果去重', async () => {
    const emitThemeColorChanged = vi.fn()
    const controller = createCrawlViewThemeColorController({
      emitThemeColorChanged,
    })
    const currentView = new FakeWebContents('https://example.com/dark')

    controller.attach(currentView as any, 'view-3')
    controller.scheduleExtraction(currentView as any, 'view-3', { delaysMs: [0, 200, 800] })

    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(200)
    await vi.advanceTimersByTimeAsync(800)

    expect(emitThemeColorChanged).toHaveBeenCalledTimes(1)
    expect(emitThemeColorChanged).toHaveBeenCalledWith({
      themeColor: '#111111',
      source: 'meta',
      url: 'https://example.com/dark',
      viewId: 'view-3',
    })
  })

  it('clearThemeColor 会显式发出 null，并取消旧的提取任务', async () => {
    const emitThemeColorChanged = vi.fn()
    const controller = createCrawlViewThemeColorController({
      emitThemeColorChanged,
    })
    const currentView = new FakeWebContents('https://example.com/light')

    controller.attach(currentView as any, 'view-4')
    controller.scheduleExtraction(currentView as any, 'view-4', { delaysMs: [300] })
    controller.clearThemeColor(currentView as any, 'view-4', 'https://example.com/next')

    await vi.advanceTimersByTimeAsync(300)

    expect(emitThemeColorChanged).toHaveBeenCalledTimes(1)
    expect(emitThemeColorChanged).toHaveBeenCalledWith({
      themeColor: null,
      source: null,
      url: 'https://example.com/next',
      viewId: 'view-4',
    })
  })

  it('requestThemeColorRefresh("navigation") 只清空不采样', async () => {
    const emitThemeColorChanged = vi.fn()
    const controller = createCrawlViewThemeColorController({
      emitThemeColorChanged,
    })
    const currentView = new FakeWebContents('https://example.com/dark')

    controller.attach(currentView as any, 'view-nav')
    controller.requestThemeColorRefresh(currentView as any, 'view-nav', 'navigation', {
      urlOverride: 'https://example.com/next',
    })

    await vi.advanceTimersByTimeAsync(3000)

    expect(emitThemeColorChanged).toHaveBeenCalledTimes(1)
    expect(emitThemeColorChanged).toHaveBeenCalledWith({
      themeColor: null,
      source: null,
      url: 'https://example.com/next',
      viewId: 'view-nav',
    })
  })

  it('requestThemeColorRefresh("hashOnly") 不会清空旧色，只做采样', async () => {
    const emitThemeColorChanged = vi.fn()
    const controller = createCrawlViewThemeColorController({
      emitThemeColorChanged,
    })
    const currentView = new FakeWebContents('https://example.com/dark')

    controller.attach(currentView as any, 'view-hash')
    controller.requestThemeColorRefresh(currentView as any, 'view-hash', 'hashOnly')

    await vi.advanceTimersByTimeAsync(1000)

    expect(emitThemeColorChanged).toHaveBeenCalledTimes(1)
    expect(emitThemeColorChanged).toHaveBeenCalledWith({
      themeColor: '#111111',
      source: 'meta',
      url: 'https://example.com/dark',
      viewId: 'view-hash',
    })
  })

  it('requestThemeColorRefresh("inPage") 先清空后采样', async () => {
    const emitThemeColorChanged = vi.fn()
    const controller = createCrawlViewThemeColorController({
      emitThemeColorChanged,
    })
    const currentView = new FakeWebContents('https://example.com/dark')

    controller.attach(currentView as any, 'view-spa')
    controller.requestThemeColorRefresh(currentView as any, 'view-spa', 'inPage', {
      urlOverride: 'https://example.com/route-b',
    })

    await vi.advanceTimersByTimeAsync(2000)

    const calls = emitThemeColorChanged.mock.calls.map((call) => call[0])
    expect(calls[0]).toMatchObject({ themeColor: null, url: 'https://example.com/route-b' })
    expect(calls.some((c) => c?.themeColor === '#111111')).toBe(true)
  })

  it('requestThemeColorRefresh 对未知 reason 只告警不抛错', () => {
    const emitThemeColorChanged = vi.fn()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const controller = createCrawlViewThemeColorController({
      emitThemeColorChanged,
    })
    const currentView = new FakeWebContents('https://example.com/dark')

    controller.attach(currentView as any, 'view-bad')
    expect(() =>
      controller.requestThemeColorRefresh(
        currentView as any,
        'view-bad',
        'unknown-reason' as any,
      ),
    ).not.toThrow()
    expect(warnSpy).toHaveBeenCalled()
    expect(emitThemeColorChanged).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
