import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../i18n', () => ({
  t: (key: string, params?: Record<string, any>) => {
    if (params) return `${key}:${JSON.stringify(params)}`
    return key
  },
}))

import {
  BrowserToolImpl,
  getSharedBrowserToolImpl,
  resetSharedBrowserToolImpl,
  getSharedTabResolver,
  getSharedBlockDetector,
  getSharedCaptchaGuard,
  getSharedSnapshotService,
  getSharedSoMService,
  DOMOperationHelper,
  getSharedCDPOperationHelper,
} from '@tabtin/browser-core'

// ── helpers ──────────────────────────────────────────────────────────

function makeBrowserContext(overrides?: Record<string, any>) {
  return {
    isAlive: vi.fn(() => true),
    sendCDP: vi.fn().mockResolvedValue({}),
    onCDPEvent: vi.fn().mockReturnValue(() => {}),
    executeScript: vi.fn().mockResolvedValue({ success: true }),
    loadURL: vi.fn(),
    getCurrentURL: vi.fn(() => 'https://test.com'),
    getTitle: vi.fn().mockResolvedValue('Test Page'),
    captureScreenshot: vi.fn().mockResolvedValue(Buffer.from('png')),
    detach: vi.fn(),
    ...overrides,
  }
}

function stubGuardsClean() {
  vi.spyOn(getSharedBlockDetector(), 'detect').mockResolvedValue({ blocked: false, confidence: 0, shouldUpgrade: false })
  vi.spyOn(getSharedCaptchaGuard(), 'detect').mockResolvedValue({ detected: false, confidence: 0, challenge_visible: false, suggested_action: 'auto-wait' } as any)
  vi.spyOn(getSharedCaptchaGuard(), 'detectAndHandle').mockResolvedValue({ detected: false, confidence: 0, challenge_visible: false, suggested_action: 'auto-wait' } as any)
}

// ── setup ────────────────────────────────────────────────────────────

describe('BrowserToolImpl', () => {
  let impl: BrowserToolImpl
  let mockCtx: ReturnType<typeof makeBrowserContext>

  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    resetSharedBrowserToolImpl()
    impl = new BrowserToolImpl()
    mockCtx = makeBrowserContext()
    stubGuardsClean()

    vi.spyOn(getSharedTabResolver(), 'getContext').mockReturnValue(mockCtx as any)
    vi.spyOn(getSharedTabResolver(), 'getView').mockReturnValue({ webContents: mockCtx })
    vi.spyOn(getSharedTabResolver(), 'resolve').mockResolvedValue(null)

    vi.spyOn(getSharedCDPOperationHelper(), 'runAction').mockResolvedValue({ success: true })
    vi.spyOn(DOMOperationHelper, 'runAction').mockResolvedValue({ success: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ── DI / setters ──────────────────────────────────────────────

  describe('dependency injection', () => {
    it('setElectronViewGetter 注入到三个子服务', () => {
      const setCtxFactorySpy = vi.spyOn(getSharedTabResolver(), 'setContextFactory')
      const getter = vi.fn()
      impl.setElectronViewGetter(getter)
      const setViewGetterSpy = vi.spyOn(getSharedTabResolver(), 'setViewGetter')
      impl.setElectronViewGetter(getter)
      expect(setViewGetterSpy).toHaveBeenCalledWith(getter)
    })

    it('setRunEventRecorder 保存回调', () => {
      const recorder = vi.fn()
      impl.setRunEventRecorder(recorder)
    })

    it('setCaptchaInterventionCallback 传递到 CaptchaGuard', () => {
      const spy = vi.spyOn(getSharedCaptchaGuard(), 'setInterventionCallback')
      const cb = vi.fn()
      impl.setCaptchaInterventionCallback(cb)
      expect(spy).toHaveBeenCalledWith(cb)
    })
  })

  // ── executeAct ────────────────────────────────────────────────

  describe('executeAct', () => {
    it('单个 click 操作成功', async () => {
      const result = await impl.executeAct({
        actions: [{ type: 'click', selector: '#btn' }],
        crawlTabId: 'tab-1',
      })

      expect(result.success).toBe(true)
      expect(result.executed_actions).toHaveLength(1)
      expect(result.executed_actions[0].status).toBe('success')
      expect(result.page_url).toBe('https://test.com')
    })

    it('act 后截图超时时仍返回动作结果', async () => {
      mockCtx.captureScreenshot.mockImplementation(() => new Promise(() => {}))

      const pending = impl.executeAct({
        actions: [{ type: 'click', selector: '#btn' }],
        crawlTabId: 'tab-1',
      })
      await vi.advanceTimersByTimeAsync(2500)
      const result = await pending

      expect(result.success).toBe(true)
      expect(result.executed_actions).toHaveLength(1)
      expect(result.screenshot_base64).toBeUndefined()
    })

    it('多个操作顺序执行', async () => {
      const result = await impl.executeAct({
        actions: [
          { type: 'click', selector: '#a' },
          { type: 'fill', selector: '#input', value: 'hello' },
        ],
        crawlTabId: 'tab-1',
      })

      expect(result.success).toBe(true)
      expect(result.executed_actions).toHaveLength(2)
    })

    it('stop_on_error=true 时首个致命错误即返回（不重试）', async () => {
      const cdpSpy = vi.spyOn(getSharedCDPOperationHelper(), 'runAction')
        .mockResolvedValueOnce({ success: false, error: 'Access denied', code: 'blocked' })
        .mockResolvedValueOnce({ success: true })

      const result = await impl.executeAct({
        actions: [
          { type: 'click', selector: '#blocked' },
          { type: 'click', selector: '#ok' },
        ],
        crawlTabId: 'tab-1',
        stop_on_error: true,
      })

      expect(result.success).toBe(false)
      expect(result.executed_actions).toHaveLength(1)
      expect(result.error?.code).toBeDefined()
      expect(cdpSpy).toHaveBeenCalledOnce()
    })

    it('stop_on_error=false 时继续执行后续操作', async () => {
      vi.spyOn(getSharedCDPOperationHelper(), 'runAction')
        .mockResolvedValueOnce({ success: false, error: 'oops' })
        .mockResolvedValueOnce({ success: true })

      const result = await impl.executeAct({
        actions: [
          { type: 'click', selector: '#fail' },
          { type: 'click', selector: '#ok' },
        ],
        crawlTabId: 'tab-1',
        stop_on_error: false,
      })

      expect(result.success).toBe(false)
      expect(result.executed_actions).toHaveLength(2)
      expect(result.executed_actions[0].status).toBe('failed')
      expect(result.executed_actions[1].status).toBe('success')
      expect(result.error).toBeDefined()
    })

    it('可重试错误触发 withRetry 重试', async () => {
      vi.spyOn(getSharedCDPOperationHelper(), 'runAction')
        .mockResolvedValueOnce({ success: false, error: 'Element not found', code: 'element_not_found' })
        .mockResolvedValueOnce({ success: false, error: 'Element not found', code: 'element_not_found' })
        .mockResolvedValueOnce({ success: true })

      const result = await impl.executeAct({
        actions: [{ type: 'click', selector: '#flaky' }],
        crawlTabId: 'tab-1',
        stop_on_error: false,
      })

      expect(getSharedCDPOperationHelper().runAction).toHaveBeenCalled()
    })

    it('CDP 操作走 CDPOperationHelper', async () => {
      const domSpy = vi.spyOn(DOMOperationHelper, 'runAction').mockClear()

      const result = await impl.executeAct({
        actions: [{ type: 'keyPress', selector: '', value: 'Enter' }],
        crawlTabId: 'tab-1',
      })

      expect(result.success).toBe(true)
      expect(getSharedCDPOperationHelper().runAction).toHaveBeenCalled()
      expect(domSpy).not.toHaveBeenCalled()
    })

    it('坐标点击走 CDP 路径', async () => {
      const result = await impl.executeAct({
        actions: [{ type: 'click', x: 100, y: 200 } as any],
        crawlTabId: 'tab-1',
      })

      expect(result.success).toBe(true)
      expect(getSharedCDPOperationHelper().runAction).toHaveBeenCalled()
    })

    it('无可用 Tab 返回 PAGE_NOT_LOADED', async () => {
      vi.spyOn(getSharedTabResolver(), 'getContext').mockReturnValue(null)
      vi.spyOn(getSharedTabResolver(), 'getView').mockReturnValue(null)

      const result = await impl.executeAct({
        actions: [{ type: 'click', selector: '#btn' }],
      })

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('page_not_loaded')
      expect(result.executed_actions).toHaveLength(0)
    })

    it('view 已销毁抛出错误', async () => {
      vi.spyOn(getSharedTabResolver(), 'getContext').mockReturnValue({
        ...mockCtx,
        isAlive: () => false,
      } as any)

      const result = await impl.executeAct({
        actions: [{ type: 'click', selector: '#btn' }],
        crawlTabId: 'tab-1',
      })

      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
    })

    it('导航后清除验证码缓存并延迟', async () => {
      const result = await impl.executeAct({
        actions: [{ type: 'click', selector: 'a.nav' }],
        crawlTabId: 'tab-1',
      })

      expect(result.success).toBe(true)
    })

    it('事件记录器被调用', async () => {
      const recorder = vi.fn()
      impl.setRunEventRecorder(recorder)

      await impl.executeAct({
        actions: [{ type: 'click', selector: '#btn' }],
        crawlTabId: 'tab-1',
        runId: 'run-1',
      })

      expect(recorder).toHaveBeenCalled()
      const event = recorder.mock.calls[0][0]
      expect(event.type).toBe('execute_act')
      expect(event.runId).toBe('run-1')
      expect(event.viewId).toBe('tab-1')
    })
  })

  // ── executeObserve ────────────────────────────────────────────

  describe('executeObserve', () => {
    it('正常返回可交互元素列表', async () => {
      vi.spyOn(getSharedSoMService(), 'collectInteractiveElements').mockResolvedValue({
        elements: [
          { selector: '#btn', tag: 'button', name: 'Submit', visible: true, id: 0, role: 'button', bbox: { x: 0, y: 0, w: 100, h: 30 }, interactive: true },
          { selector: 'a.link', tag: 'a', name: 'Home', visible: true, id: 1, role: 'link', bbox: { x: 0, y: 50, w: 80, h: 20 }, interactive: true },
        ],
        truncated: false,
        totalCandidates: 2,
      } as any)

      const result = await impl.executeObserve({
        crawlTabId: 'tab-1',
      })

      expect(result.success).toBe(true)
      expect(result.observed_elements.length).toBe(2)
      expect(result.observed_elements[0].selector).toBe('#btn')
      expect(result.observed_elements[0].tag).toBe('button')
    })

    it('include_som=true 时附带标注截图', async () => {
      vi.spyOn(getSharedSoMService(), 'collectInteractiveElements').mockResolvedValue({
        elements: [
          { selector: '#btn', tag: 'button', name: 'OK', visible: true, id: 0, role: 'button', bbox: { x: 0, y: 0, w: 50, h: 30 }, interactive: true },
        ],
        truncated: false,
        totalCandidates: 1,
      } as any)
      const captureAnnotatedSpy = vi.spyOn(getSharedSoMService(), 'captureAnnotated').mockResolvedValue({ screenshotBase64: 'base64data' } as any)

      const result = await impl.executeObserve({
        crawlTabId: 'tab-1',
        include_som: true,
      })

      expect(result.success).toBe(true)
      expect((result as any).som_screenshot_base64).toBe('base64data')
      expect(captureAnnotatedSpy).toHaveBeenCalledOnce()
    })

    it('include_som=false 时不调用 captureAnnotated', async () => {
      vi.spyOn(getSharedSoMService(), 'collectInteractiveElements').mockResolvedValue({
        elements: [],
        truncated: false,
        totalCandidates: 0,
      } as any)
      const captureAnnotatedSpy = vi.spyOn(getSharedSoMService(), 'captureAnnotated')

      const result = await impl.executeObserve({
        crawlTabId: 'tab-1',
        include_som: false,
      })

      expect(result.success).toBe(true)
      expect(captureAnnotatedSpy).not.toHaveBeenCalled()
    })

    it('无可用 Tab 返回错误', async () => {
      vi.spyOn(getSharedTabResolver(), 'getContext').mockReturnValue(null)
      vi.spyOn(getSharedTabResolver(), 'resolve').mockResolvedValue(null)

      const result = await impl.executeObserve({})

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('page_not_loaded')
      expect(result.observed_elements).toHaveLength(0)
    })

    it('SoMService 异常被捕获', async () => {
      vi.spyOn(getSharedSoMService(), 'collectInteractiveElements').mockRejectedValue(new Error('DOM access timeout'))

      const result = await impl.executeObserve({
        crawlTabId: 'tab-1',
      })

      expect(result.success).toBe(false)
      expect(result.error?.code).toBeDefined()
    })
  })

  // ── requestSnapshot ───────────────────────────────────────────

  describe('requestSnapshot', () => {
    it('正常返回快照数据', async () => {
      vi.spyOn(getSharedSnapshotService(), 'capture').mockResolvedValue({
        url: 'https://test.com',
        title: 'Test',
        skeleton_html: '<div>...</div>',
        accessibility_tree: 'tree',
        screenshot_base64: 'img',
      } as any)

      const result = await impl.requestSnapshot({
        crawlTabId: 'tab-1',
        include_screenshot: true,
      })

      expect(result.success).toBe(true)
      expect(result.data?.snapshot.url).toBe('https://test.com')
      expect(result.data?.snapshot.title).toBe('Test')
      expect(result.data?.snapshot.skeleton_html).toBe('<div>...</div>')
    })

    it('缺少 crawlTabId 返回 PAGE_NOT_LOADED', async () => {
      const result = await impl.requestSnapshot({})

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('page_not_loaded')
    })

    it('检测到封禁信号附加 block 字段', async () => {
      vi.spyOn(getSharedSnapshotService(), 'capture').mockResolvedValue({ url: 'https://test.com', title: 'Test' } as any)
      vi.spyOn(getSharedBlockDetector(), 'detect').mockResolvedValue({ blocked: true, reason: 'IP banned', error_code: 'blocked', confidence: 0.8, shouldUpgrade: false })

      const result = await impl.requestSnapshot({ crawlTabId: 'tab-1' })

      expect(result.success).toBe(true)
      expect(result.block?.blocked).toBe(true)
      expect(result.block?.reason).toBe('IP banned')
    })

    it('检测到验证码 → 自动处理 → 重新快照', async () => {
      const snap1 = { url: 'https://test.com', title: 'Captcha' }
      const snap2 = { url: 'https://test.com', title: 'Real Page' }
      const captureSpy = vi.spyOn(getSharedSnapshotService(), 'capture')
        .mockResolvedValueOnce(snap1 as any)
        .mockResolvedValueOnce(snap2 as any)

      vi.spyOn(getSharedCaptchaGuard(), 'detect').mockResolvedValue({ detected: true, confidence: 0.9, challenge_visible: true, suggested_action: 'click-checkbox' } as any)
      vi.spyOn(getSharedCaptchaGuard(), 'detectAndHandle').mockResolvedValue({ detected: false, confidence: 0, challenge_visible: false, suggested_action: 'auto-wait' } as any)

      const result = await impl.requestSnapshot({ crawlTabId: 'tab-1' })

      expect(result.success).toBe(true)
      expect(result.data?.snapshot.title).toBe('Real Page')
      expect(captureSpy).toHaveBeenCalledTimes(2)
    })

    it('验证码未解决保留 captcha 字段', async () => {
      vi.spyOn(getSharedSnapshotService(), 'capture').mockResolvedValue({ url: 'https://test.com', title: 'Captcha' } as any)

      const captchaInfo = { detected: true, confidence: 0.95, challenge_visible: true, suggested_action: 'user-intervention' as const }
      vi.spyOn(getSharedCaptchaGuard(), 'detect').mockResolvedValue(captchaInfo as any)
      vi.spyOn(getSharedCaptchaGuard(), 'detectAndHandle').mockResolvedValue(captchaInfo as any)

      const result = await impl.requestSnapshot({ crawlTabId: 'tab-1' })

      expect(result.captcha?.detected).toBe(true)
    })

    it('SnapshotService 异常被捕获', async () => {
      vi.spyOn(getSharedSnapshotService(), 'capture').mockRejectedValue(new Error('crash'))

      const result = await impl.requestSnapshot({ crawlTabId: 'tab-1' })

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('unknown_error')
    })
  })

  // ── 统一管道 executeWithGuards ────────────────────────────────

  describe('unified pipeline', () => {
    it('封禁检测结果附加到返回值', async () => {
      vi.spyOn(getSharedBlockDetector(), 'detect').mockResolvedValue({ blocked: true, reason: 'rate limited', error_code: 'rate_limited', confidence: 0.8, shouldUpgrade: false })

      const result = await impl.executeAct({
        actions: [{ type: 'click', selector: '#btn' }],
        crawlTabId: 'tab-1',
      })

      expect(result.block?.blocked).toBe(true)
    })

    it('验证码检测结果附加到返回值', async () => {
      vi.spyOn(getSharedCaptchaGuard(), 'detectAndHandle').mockResolvedValue({
        detected: true, confidence: 0.8, challenge_visible: true, suggested_action: 'auto-wait',
      } as any)

      const result = await impl.executeAct({
        actions: [{ type: 'click', selector: '#btn' }],
        crawlTabId: 'tab-1',
      })

      expect(result.captcha?.detected).toBe(true)
    })
  })

  // ── Tab 解析优先级 ────────────────────────────────────────────

  describe('tab resolution', () => {
    it('crawlTabId 优先使用，不调用 resolve', async () => {
      const resolveSpy = vi.spyOn(getSharedTabResolver(), 'resolve')

      await impl.executeAct({
        actions: [{ type: 'click', selector: '#btn' }],
        crawlTabId: 'tab-explicit',
      })

      expect(resolveSpy).not.toHaveBeenCalled()
    })

    it('无 crawlTabId 时通过 runId 解析', async () => {
      const resolveSpy = vi.spyOn(getSharedTabResolver(), 'resolve').mockResolvedValue('resolved-tab')

      await impl.executeAct({
        actions: [{ type: 'click', selector: '#btn' }],
        runId: 'run-123',
      })

      expect(resolveSpy).toHaveBeenCalledWith('run-123', expect.anything(), expect.anything())
    })
  })

  // ── 全局单例 ─────────────────────────────────────────────────

  describe('singleton', () => {
    it('getSharedBrowserToolImpl 返回同一实例', () => {
      resetSharedBrowserToolImpl()
      const a = getSharedBrowserToolImpl()
      const b = getSharedBrowserToolImpl()
      expect(a).toBe(b)
    })

    it('resetSharedBrowserToolImpl 后返回新实例', () => {
      const a = getSharedBrowserToolImpl()
      resetSharedBrowserToolImpl()
      const b = getSharedBrowserToolImpl()
      expect(a).not.toBe(b)
    })
  })

  // ── destroy ──────────────────────────────────────────────────

  describe('destroy', () => {
    it('调用不抛异常', async () => {
      await expect(impl.destroy()).resolves.not.toThrow()
    })
  })

  // ── BT-024: withRetry() 异常捕获回归测试 ────────────────────

  describe('BT-024: withRetry 应捕获 coreFn 抛出的异常并重试', () => {
    it('snapshot coreFn 抛异常时应重试并最终返回成功', async () => {
      let callCount = 0
      vi.spyOn(getSharedSnapshotService(), 'capture').mockImplementation(async () => {
        callCount++
        if (callCount < 3) throw new Error('transient snapshot error')
        return { url: 'https://example.com', title: 'Test' } as any
      })

      const result = await impl.requestSnapshot({ crawlTabId: 'tab-1' })

      expect(result.success).toBe(true)
      expect(callCount).toBe(3)
    })

    it('coreFn 持续抛异常超出重试次数时应由顶层 catch 处理为失败', async () => {
      vi.spyOn(getSharedSnapshotService(), 'capture').mockRejectedValue(new Error('persistent snapshot error'))

      const result = await impl.requestSnapshot({ crawlTabId: 'tab-1' })

      expect(result.success).toBe(false)
    })
  })
})
