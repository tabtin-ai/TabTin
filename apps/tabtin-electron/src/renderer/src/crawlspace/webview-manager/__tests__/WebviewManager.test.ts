/**
 * WebviewManager 单测（jsdom，）
 *
 * 核心回归（Phase 0 硬门禁第 1 条）：**防 re-parent**——元素创建后 parent
 * 恒为稳定层 `#tabtin-webview-layer`，公开 API 的任何组合都不得触发
 * re-append（appendChild 移动 = guest 销毁重建 = 探针 1 FAIL 实证）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { WebviewManager, type WebviewHostBridge } from '../WebviewManager'

const { mockTryOpenPreviewableDirectUrl } = vi.hoisted(() => ({
  mockTryOpenPreviewableDirectUrl: vi.fn(() => true),
}))

vi.mock('@/components/chat/preview/assetPreviewResolver', () => ({
  tryOpenPreviewableDirectUrl: mockTryOpenPreviewableDirectUrl,
}))

function makeBridge(overrides: Partial<WebviewHostBridge> = {}): WebviewHostBridge {
  return {
    announce: vi.fn(async () => ({ success: true, effectivePartition: 'persist:tabtin:env:default' })),
    bind: vi.fn(async () => ({ success: true })),
    discardAnnounce: vi.fn(async () => ({ success: true })),
    ...overrides,
  }
}

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

describe('WebviewManager', () => {
  let manager: WebviewManager
  let bridge: WebviewHostBridge

  beforeEach(() => {
    document.body.innerHTML = ''
    mockTryOpenPreviewableDirectUrl.mockClear()
    bridge = makeBridge()
    manager = new WebviewManager({ document, bridge, logger: silentLogger })
    // jsdom 无 rAF：回落 setTimeout 分支即可（WebviewManager 内部已 guard）
  })

  afterEach(() => {
    manager.disposeForTesting()
    vi.restoreAllMocks()
  })

  const flushTimers = () => new Promise((resolve) => setTimeout(resolve, 25))

  describe('ensure', () => {
    it('创建元素并 append 到稳定层；幂等（第二次不再 announce）', async () => {
      const first = await manager.ensure('tab-1', { url: 'https://example.com' })
      expect(first.created).toBe(true)

      const el = manager.getElementForTesting('tab-1')
      expect(el).not.toBeNull()
      expect(el!.tagName.toLowerCase()).toBe('webview')

      const layer = manager.getLayerForTesting()
      expect(layer).not.toBeNull()
      expect(layer!.id).toBe('tabtin-webview-layer')
      expect(el!.parentElement).toBe(layer)
      expect(layer!.parentElement).toBe(document.body)

      const second = await manager.ensure('tab-1', { url: 'https://other.com' })
      expect(second.created).toBe(false)
      expect(bridge.announce).toHaveBeenCalledTimes(1)
      // 幂等路径绝不改 src / partition
      expect(el!.getAttribute('src')).toBe('https://example.com')
      expect(el!.getAttribute('partition')).toBe('persist:tabtin:env:default')
    })

    it('属性设置顺序：partition 必须先于 src', async () => {
      const order: string[] = []
      const originalSetAttribute = HTMLElement.prototype.setAttribute
      const spy = vi
        .spyOn(HTMLElement.prototype, 'setAttribute')
        .mockImplementation(function (this: HTMLElement, name: string, value: string) {
          if (this.tagName.toLowerCase() === 'webview') order.push(name)
          return originalSetAttribute.call(this, name, value)
        })

      await manager.ensure('tab-order', { url: 'https://example.com', partition: 'tabtin:env:default' })
      spy.mockRestore()

      const partitionIdx = order.indexOf('partition')
      const srcIdx = order.indexOf('src')
      expect(partitionIdx).toBeGreaterThanOrEqual(0)
      expect(srcIdx).toBeGreaterThanOrEqual(0)
      expect(partitionIdx).toBeLessThan(srcIdx)
      // src 必须是最后一个被设置的属性（此后 guest 即开始加载）
      expect(order[order.length - 1]).toBe('src')
    })

    it('announce 失败：抛错且不创建元素', async () => {
      bridge = makeBridge({ announce: vi.fn(async () => ({ success: false, error: 'partition 不合法' })) })
      manager = new WebviewManager({ document, bridge, logger: silentLogger })
      await expect(manager.ensure('tab-bad', { url: 'https://x.com' })).rejects.toThrow('partition 不合法')
      expect(manager.getElementForTesting('tab-bad')).toBeNull()
    })

    it('默认 session（effectivePartition 为空）：不设置 partition 属性', async () => {
      bridge = makeBridge({ announce: vi.fn(async () => ({ success: true, effectivePartition: '' })) })
      manager = new WebviewManager({ document, bridge, logger: silentLogger })
      await manager.ensure('tab-shared', { url: 'https://example.com' })
      expect(manager.getElementForTesting('tab-shared')!.hasAttribute('partition')).toBe(false)
    })

    it('并发 ensure 折叠为一次创建（single-flight，共享同一 Promise）', async () => {
      const p1 = manager.ensure('tab-cc', { url: 'https://example.com' })
      const p2 = manager.ensure('tab-cc', { url: 'https://example.com' })
      expect(p2).toBe(p1)
      await Promise.all([p1, p2])
      expect(bridge.announce).toHaveBeenCalledTimes(1)
      // 只产生一个元素、一次 append
      expect(document.querySelectorAll('webview[data-tabtin-webview="tab-cc"]').length).toBe(1)
    })

    it('#7336 previewable PDF：src 落 about:blank，并打开 Preview Modal（不喂 Chromium PDF viewer）', async () => {
      const pdfUrl = 'https://assets.example.com/tabfiles/uploads/32be0f0aba6643e7adacc06d143f443b.pdf'
      await manager.ensure('tab-pdf', { url: pdfUrl })
      const el = manager.getElementForTesting('tab-pdf')!
      expect(el.getAttribute('src')).toBe('about:blank')
      await flushTimers()
      expect(mockTryOpenPreviewableDirectUrl).toHaveBeenCalledWith(pdfUrl, {
        filename: undefined,
        mimeType: undefined,
        fileId: undefined,
      })
      expect(silentLogger.warn).toHaveBeenCalledWith(
        '[WebviewManager] upstream preview routing missed previewable URL',
        {
          tabId: 'tab-pdf',
          previewKind: 'pdf',
        },
      )
    })

    it('#7336 previewable xlsx：同样 divert，不写文件 URL 到 src', async () => {
      const xlsxUrl = 'https://cdn.example.com/report.xlsx'
      await manager.ensure('tab-xlsx', {
        url: xlsxUrl,
        openIntentHints: { filename: 'report.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      })
      expect(manager.getElementForTesting('tab-xlsx')!.getAttribute('src')).toBe('about:blank')
      await flushTimers()
      expect(mockTryOpenPreviewableDirectUrl).toHaveBeenCalledWith(xlsxUrl, {
        filename: 'report.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        fileId: undefined,
      })
    })
  })

  describe('显隐两档', () => {
    it('born-hidden Agent 页面进入 keepalive 时补齐非零逻辑视口', async () => {
      await manager.ensure('tab-bg', { url: 'https://example.com' })

      manager.keepAliveHidden('tab-bg')

      const el = manager.getElementForTesting('tab-bg')!
      expect(el.style.left).toBe('0px')
      expect(el.style.top).toBe('0px')
      expect(el.style.width).toBe('1280px')
      expect(el.style.height).toBe('720px')
      expect(el.style.visibility).toBe('')
      expect(el.style.opacity).toBe('0')
      expect(el.style.pointerEvents).toBe('none')
      expect(el.hasAttribute('inert')).toBe(true)
      expect(manager.getVisibility('tab-bg')).toBe('keepalive')
    })

    it('born-hidden 页面首次显示前先以真实 slot rect 替换后台逻辑视口', async () => {
      await manager.ensure('tab-bg-show', { url: 'https://example.com' })
      manager.keepAliveHidden('tab-bg-show')

      const slot = document.createElement('div')
      document.body.appendChild(slot)
      vi.spyOn(slot, 'getBoundingClientRect').mockReturnValue({
        x: 40,
        y: 60,
        width: 320,
        height: 240,
        top: 60,
        left: 40,
        right: 360,
        bottom: 300,
        toJSON: () => ({}),
      })
      manager.syncTo('tab-bg-show', slot)

      manager.show('tab-bg-show')

      const el = manager.getElementForTesting('tab-bg-show')!
      expect(el.style.left).toBe('40px')
      expect(el.style.top).toBe('60px')
      expect(el.style.width).toBe('320px')
      expect(el.style.height).toBe('240px')
      expect(el.style.opacity).toBe('')
      expect(el.style.pointerEvents).toBe('auto')
    })

    it('首次 show 尚无 slot 时保持隐形，slot 就绪后才显示真实页面', async () => {
      await manager.ensure('tab-bg-late-slot', { url: 'https://example.com' })
      manager.keepAliveHidden('tab-bg-late-slot')
      manager.show('tab-bg-late-slot')

      const el = manager.getElementForTesting('tab-bg-late-slot')!
      expect(el.style.opacity).toBe('0')
      expect(el.style.pointerEvents).toBe('none')

      const slot = document.createElement('div')
      document.body.appendChild(slot)
      vi.spyOn(slot, 'getBoundingClientRect').mockReturnValue({
        x: 12,
        y: 24,
        width: 640,
        height: 480,
        top: 24,
        left: 12,
        right: 652,
        bottom: 504,
        toJSON: () => ({}),
      })
      manager.syncTo('tab-bg-late-slot', slot)
      await flushTimers()

      expect(el.style.left).toBe('12px')
      expect(el.style.top).toBe('24px')
      expect(el.style.width).toBe('640px')
      expect(el.style.height).toBe('480px')
      expect(el.style.opacity).toBe('')
      expect(el.style.pointerEvents).toBe('auto')
    })

    it('throttle 档：visibility hidden + 移出视口（节流省资源）', async () => {
      await manager.ensure('tab-h', { url: 'https://example.com' })
      manager.setRect('tab-h', { x: 10, y: 20, width: 300, height: 200 })
      manager.show('tab-h')
      const el = manager.getElementForTesting('tab-h')!
      expect(el.style.visibility).toBe('')
      expect(el.style.left).toBe('10px')

      manager.hide('tab-h', 'throttle')
      expect(el.style.visibility).toBe('hidden')
      expect(el.style.left).toBe('-10000px')
      expect(el.style.top).toBe('-10000px')
      expect(el.hasAttribute('inert')).toBe(false)
      expect(manager.getVisibility('tab-h')).toBe('throttle')
    })

    it('keepalive 档：opacity 0 + pointer-events none + inert，原位保留（不节流）', async () => {
      await manager.ensure('tab-k', { url: 'https://example.com' })
      manager.setRect('tab-k', { x: 15, y: 25, width: 400, height: 300 })
      manager.show('tab-k')

      manager.hide('tab-k', 'keepalive')
      const el = manager.getElementForTesting('tab-k')!
      expect(el.style.opacity).toBe('0')
      expect(el.style.pointerEvents).toBe('none')
      expect(el.hasAttribute('inert')).toBe(true)
      expect(el.style.visibility).toBe('')
      // 保持原位（rAF/渲染不被 Chromium 节流的关键）
      expect(el.style.left).toBe('15px')
      expect(el.style.top).toBe('25px')
      expect(manager.getVisibility('tab-k')).toBe('keepalive')
    })

    it('show 恢复：清掉两档隐藏样式并回位', async () => {
      await manager.ensure('tab-s', { url: 'https://example.com' })
      manager.setRect('tab-s', { x: 5, y: 6, width: 100, height: 80 })
      manager.hide('tab-s', 'keepalive')
      manager.show('tab-s')
      const el = manager.getElementForTesting('tab-s')!
      expect(el.style.opacity).toBe('')
      expect(el.style.visibility).toBe('')
      expect(el.style.pointerEvents).toBe('auto')
      expect(el.hasAttribute('inert')).toBe(false)
      expect(el.style.left).toBe('5px')

      manager.hide('tab-s', 'throttle')
      manager.show('tab-s')
      expect(el.style.visibility).toBe('')
      expect(el.style.left).toBe('5px')
    })

    it('throttle 隐藏期间 setRect 只记账不落样式，show 时应用', async () => {
      await manager.ensure('tab-r', { url: 'https://example.com' })
      manager.hide('tab-r', 'throttle')
      manager.setRect('tab-r', { x: 42, y: 43, width: 500, height: 400 })
      const el = manager.getElementForTesting('tab-r')!
      expect(el.style.left).toBe('-10000px')
      manager.show('tab-r')
      expect(el.style.left).toBe('42px')
      expect(el.style.width).toBe('500px')
    })
  })

  describe('鼠标穿透（分隔条拖拽，对齐 WCV setIgnoreMouseEventsForAttached）', () => {
    it('开启后可见 guest pointer-events:none，关闭恢复 auto', async () => {
      await manager.ensure('tab-pt', { url: 'https://example.com' })
      manager.show('tab-pt')
      const el = manager.getElementForTesting('tab-pt')!
      expect(el.style.pointerEvents).toBe('auto')

      manager.setMousePassthrough(true)
      expect(el.style.pointerEvents).toBe('none')

      manager.setMousePassthrough(false)
      expect(el.style.pointerEvents).toBe('auto')
    })

    it('穿透期间 show 的 guest 也保持 none；穿透结束后 show 恢复 auto', async () => {
      manager.setMousePassthrough(true)
      await manager.ensure('tab-pt2', { url: 'https://example.com' })
      manager.show('tab-pt2')
      const el = manager.getElementForTesting('tab-pt2')!
      expect(el.style.pointerEvents).toBe('none')

      manager.setMousePassthrough(false)
      expect(el.style.pointerEvents).toBe('auto')
    })

    it('隐藏中的 guest 不受穿透开关影响（本就 none / 停靠态）', async () => {
      await manager.ensure('tab-pt3', { url: 'https://example.com' })
      manager.hide('tab-pt3', 'keepalive')
      const el = manager.getElementForTesting('tab-pt3')!
      expect(el.style.pointerEvents).toBe('none')

      manager.setMousePassthrough(true)
      manager.setMousePassthrough(false)
      // 仍处于 keepalive 隐藏：不能被穿透关闭误恢复成可点击
      expect(el.style.pointerEvents).toBe('none')
    })
  })

  describe('防 re-parent 回归（Phase 0 硬门禁第 1 条）', () => {
    it('公开 API 任意组合下 parent 恒为稳定层、元素身份不变、append 只发生一次', async () => {
      await manager.ensure('tab-p', { url: 'https://example.com' })
      const layer = manager.getLayerForTesting()!
      const el = manager.getElementForTesting('tab-p')!

      // 从此刻起监控 appendChild / insertBefore —— 任何 API 都不得再次触发
      const appendSpy = vi.spyOn(layer, 'appendChild')
      const insertSpy = vi.spyOn(layer, 'insertBefore')
      const bodyAppendSpy = vi.spyOn(document.body, 'appendChild')

      const slot = document.createElement('div')
      document.body.appendChild(slot)
      bodyAppendSpy.mockClear() // 上面这行是测试自己的 append，不计入

      manager.setRect('tab-p', { x: 1, y: 2, width: 3, height: 4 })
      manager.show('tab-p')
      manager.hide('tab-p', 'throttle')
      manager.show('tab-p')
      manager.hide('tab-p', 'keepalive')
      manager.show('tab-p')
      manager.syncTo('tab-p', slot)
      manager.requestSync('tab-p')
      await manager.ensure('tab-p', { url: 'https://re-entry.example.com' })
      manager.reloadGuest('tab-p')
      await flushTimers()

      expect(appendSpy).not.toHaveBeenCalled()
      expect(insertSpy).not.toHaveBeenCalled()
      expect(bodyAppendSpy).not.toHaveBeenCalled()
      expect(manager.getElementForTesting('tab-p')).toBe(el)
      expect(el.parentElement).toBe(layer)
      expect(el.isConnected).toBe(true)
    })

    it('多 tab：各自 append 一次到同一稳定层，互不移动', async () => {
      await manager.ensure('tab-a', { url: 'https://a.com' })
      await manager.ensure('tab-b', { url: 'https://b.com' })
      const layer = manager.getLayerForTesting()!
      const elA = manager.getElementForTesting('tab-a')!
      const elB = manager.getElementForTesting('tab-b')!
      expect(elA.parentElement).toBe(layer)
      expect(elB.parentElement).toBe(layer)

      manager.show('tab-a')
      manager.hide('tab-b', 'throttle')
      manager.show('tab-b')
      manager.hide('tab-a', 'keepalive')

      expect(elA.parentElement).toBe(layer)
      expect(elB.parentElement).toBe(layer)
    })
  })

  describe('几何同步', () => {
    it('syncTo 先于 ensure（announce 在途窗口）：创建完成后补挂 slot 并应用 rect', async () => {
      const slot = document.createElement('div')
      document.body.appendChild(slot)
      slot.getBoundingClientRect = () =>
        ({ x: 100, y: 50, width: 640, height: 480, top: 50, left: 100, right: 740, bottom: 530, toJSON: () => ({}) }) as DOMRect

      manager.syncTo('tab-g', slot) // 元素尚不存在
      await manager.ensure('tab-g', { url: 'https://example.com' })
      manager.show('tab-g')
      await flushTimers()

      const el = manager.getElementForTesting('tab-g')!
      expect(el.style.left).toBe('100px')
      expect(el.style.top).toBe('50px')
      expect(el.style.width).toBe('640px')
      expect(el.style.height).toBe('480px')
    })

    it('requestSync 合帧后按 slot rect 更新样式', async () => {
      await manager.ensure('tab-g2', { url: 'https://example.com' })
      manager.show('tab-g2')
      const slot = document.createElement('div')
      document.body.appendChild(slot)
      let rect = { x: 10, y: 10, width: 100, height: 100 }
      slot.getBoundingClientRect = () =>
        ({ ...rect, top: rect.y, left: rect.x, right: rect.x + rect.width, bottom: rect.y + rect.height, toJSON: () => ({}) }) as DOMRect

      manager.syncTo('tab-g2', slot)
      await flushTimers()
      const el = manager.getElementForTesting('tab-g2')!
      expect(el.style.left).toBe('10px')

      rect = { x: 20, y: 30, width: 200, height: 150 }
      manager.requestSync('tab-g2')
      await flushTimers()
      expect(el.style.left).toBe('20px')
      expect(el.style.top).toBe('30px')
      expect(el.style.width).toBe('200px')
    })
  })

  describe('销毁', () => {
    it('destroy 移除元素；从未 attach（无 dom-ready）时通知主进程清理 pending', async () => {
      await manager.ensure('tab-d', { url: 'https://example.com' })
      const el = manager.getElementForTesting('tab-d')!
      manager.destroy('tab-d')
      expect(el.isConnected).toBe(false)
      expect(manager.has('tab-d')).toBe(false)
      expect(bridge.discardAnnounce).toHaveBeenCalledWith('tab-d')
    })

    it('已 attach（dom-ready 触发过）时不再 discard announce', async () => {
      await manager.ensure('tab-d2', { url: 'https://example.com' })
      const el = manager.getElementForTesting('tab-d2')!
      el.dispatchEvent(new Event('dom-ready'))
      manager.destroy('tab-d2')
      expect(bridge.discardAnnounce).not.toHaveBeenCalled()
    })

    it('destroy 后可重新 ensure（重新 announce + 新元素）', async () => {
      await manager.ensure('tab-d3', { url: 'https://example.com' })
      const first = manager.getElementForTesting('tab-d3')!
      manager.destroy('tab-d3')
      const result = await manager.ensure('tab-d3', { url: 'https://example.com' })
      expect(result.created).toBe(true)
      expect(bridge.announce).toHaveBeenCalledTimes(2)
      expect(manager.getElementForTesting('tab-d3')).not.toBe(first)
    })
  })

  describe('事件桥', () => {
    it('dom-ready → getWebContentsId → bind 上报', async () => {
      await manager.ensure('tab-e', { url: 'https://example.com' })
      const el = manager.getElementForTesting('tab-e')! as HTMLElement & { getWebContentsId?: () => number }
      el.getWebContentsId = () => 777
      el.dispatchEvent(new Event('dom-ready'))
      await flushTimers()
      expect(bridge.bind).toHaveBeenCalledWith('tab-e', 777)
    })

    it('onGuestCrashed → 元素 reload 恢复', async () => {
      let crashedCb: ((payload: { tabId: string; reason: string; url: string }) => void) | null = null
      bridge = makeBridge({
        onGuestCrashed: (cb) => { crashedCb = cb; return () => {} },
      })
      manager = new WebviewManager({ document, bridge, logger: silentLogger })
      await manager.ensure('tab-c', { url: 'https://example.com' })
      const el = manager.getElementForTesting('tab-c')! as HTMLElement & { reload?: () => void }
      const reload = vi.fn()
      el.reload = reload
      crashedCb!({ tabId: 'tab-c', reason: 'crashed', url: 'https://example.com' })
      expect(reload).toHaveBeenCalledTimes(1)
    })

    it('onDestroyRequest → 移除元素', async () => {
      let destroyCb: ((payload: { tabId: string }) => void) | null = null
      bridge = makeBridge({
        onDestroyRequest: (cb) => { destroyCb = cb; return () => {} },
      })
      manager = new WebviewManager({ document, bridge, logger: silentLogger })
      await manager.ensure('tab-dr', { url: 'https://example.com' })
      destroyCb!({ tabId: 'tab-dr' })
      expect(manager.has('tab-dr')).toBe(false)
    })
  })
})
