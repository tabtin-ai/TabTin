// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { DOMOperationHelper } from '../DOMOperationHelper'

function makeCtx() {
  return {
    executeScript: vi.fn(async (script: string) => {
      // eslint-disable-next-line no-eval
      return eval(script)
    }),
    getCurrentURL: () => 'https://example.test/scroll',
  } as any
}

/** jsdom 对 scroll* 支持不完整：补齐 element/window 的 scrollBy/scrollTo。 */
function installScrollPolyfill() {
  const patchEl = (proto: any) => {
    if (!proto.scrollBy) {
      proto.scrollBy = function scrollBy(opts: any) {
        const top = typeof opts === 'number' ? opts : Number(opts?.top || 0)
        this.scrollTop = Math.max(0, (this.scrollTop || 0) + top)
      }
    }
    if (!proto.scrollTo) {
      proto.scrollTo = function scrollTo(opts: any) {
        const top = typeof opts === 'number' ? opts : Number(opts?.top || 0)
        this.scrollTop = Math.max(0, top)
      }
    }
  }
  patchEl(Element.prototype)
  patchEl(HTMLElement.prototype)

  let windowScrollY = 0
  Object.defineProperty(window, 'scrollY', {
    configurable: true,
    get: () => windowScrollY,
  })
  Object.defineProperty(window, 'pageYOffset', {
    configurable: true,
    get: () => windowScrollY,
  })
  window.scrollBy = ((opts: any) => {
    const top = typeof opts === 'number' ? opts : Number(opts?.top || 0)
    windowScrollY = Math.max(0, windowScrollY + top)
    document.documentElement.scrollTop = windowScrollY
  }) as any
  window.scrollTo = ((opts: any) => {
    const top = typeof opts === 'number' ? opts : Number(opts?.top || 0)
    windowScrollY = Math.max(0, top)
    document.documentElement.scrollTop = windowScrollY
  }) as any

  return {
    resetWindowScroll: () => {
      windowScrollY = 0
      document.documentElement.scrollTop = 0
    },
  }
}

function mockScrollMetrics(
  el: HTMLElement,
  metrics: { scrollHeight: number; clientHeight: number; scrollTop?: number },
) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => metrics.scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => metrics.clientHeight })
  let top = metrics.scrollTop ?? 0
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      const max = Math.max(0, metrics.scrollHeight - metrics.clientHeight)
      top = Math.max(0, Math.min(max, Number(v) || 0))
    },
  })
  el.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    width: 390,
    height: metrics.clientHeight,
    top: 0,
    left: 0,
    right: 390,
    bottom: metrics.clientHeight,
    toJSON: () => ({}),
  })
}

describe('DOMOperationHelper scroll（主滚解析 + 位移验收）', () => {
  let poly: ReturnType<typeof installScrollPolyfill>

  beforeEach(() => {
    poly = installScrollPolyfill()
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
  })

  afterEach(() => {
    document.body.innerHTML = ''
    poly.resetWindowScroll()
  })

  it('嵌套主滚容器：无 selector + direction/amount 应滚 #app 且 success', async () => {
    // document 不可滚
    mockScrollMetrics(document.documentElement, { scrollHeight: 800, clientHeight: 800 })
    mockScrollMetrics(document.body, { scrollHeight: 800, clientHeight: 800 })
    Object.defineProperty(document, 'scrollingElement', {
      configurable: true,
      get: () => document.documentElement,
    })

    const app = document.createElement('div')
    app.id = 'app'
    app.style.overflowY = 'auto'
    mockScrollMetrics(app, { scrollHeight: 1800, clientHeight: 800, scrollTop: 0 })
    document.body.appendChild(app)

    const result = await DOMOperationHelper.runAction(makeCtx(), {
      selector: '',
      action: 'scroll',
      direction: 'down',
      amount: 800,
      waitForVisible: false,
    })

    expect(result.success).toBe(true)
    expect(result.code).toBeUndefined()
    expect(app.scrollTop).toBe(800)
    expect(Math.abs(result.delta || 0)).toBeGreaterThanOrEqual(1)
  })

  it('document 可滚时仍走 window，不误选侧栏', async () => {
    mockScrollMetrics(document.documentElement, { scrollHeight: 2400, clientHeight: 800 })
    mockScrollMetrics(document.body, { scrollHeight: 2400, clientHeight: 800 })
    Object.defineProperty(document, 'scrollingElement', {
      configurable: true,
      get: () => document.documentElement,
    })

    const aside = document.createElement('aside')
    aside.style.overflowY = 'auto'
    mockScrollMetrics(aside, { scrollHeight: 1200, clientHeight: 400, scrollTop: 0 })
    aside.getBoundingClientRect = () => ({
      x: 0, y: 0, width: 80, height: 400, top: 0, left: 0, right: 80, bottom: 400, toJSON: () => ({}),
    })
    document.body.appendChild(aside)

    const result = await DOMOperationHelper.runAction(makeCtx(), {
      selector: '',
      action: 'scroll',
      value: '500',
      waitForVisible: false,
    })

    expect(result.success).toBe(true)
    expect(result.target).toBe('window')
    expect(window.scrollY).toBe(500)
    expect(aside.scrollTop).toBe(0)
  })

  it('已在底部再 to_end → success + atBoundary', async () => {
    mockScrollMetrics(document.documentElement, { scrollHeight: 800, clientHeight: 800 })
    mockScrollMetrics(document.body, { scrollHeight: 800, clientHeight: 800 })
    Object.defineProperty(document, 'scrollingElement', {
      configurable: true,
      get: () => document.documentElement,
    })

    const app = document.createElement('div')
    app.id = 'app'
    app.style.overflowY = 'auto'
    mockScrollMetrics(app, { scrollHeight: 1200, clientHeight: 800, scrollTop: 400 })
    document.body.appendChild(app)

    const result = await DOMOperationHelper.runAction(makeCtx(), {
      selector: '',
      action: 'scroll',
      value: 'bottom',
      waitForVisible: false,
    })

    expect(result.success).toBe(true)
    expect(result.atBoundary).toBe(true)
  })

  it('完全不可滚 → no_target 失败（不假成功）', async () => {
    mockScrollMetrics(document.documentElement, { scrollHeight: 800, clientHeight: 800 })
    mockScrollMetrics(document.body, { scrollHeight: 800, clientHeight: 800 })
    Object.defineProperty(document, 'scrollingElement', {
      configurable: true,
      get: () => document.documentElement,
    })

    const result = await DOMOperationHelper.runAction(makeCtx(), {
      selector: '',
      action: 'scroll',
      direction: 'down',
      amount: 800,
      waitForVisible: false,
    })

    expect(result.success).toBe(false)
    expect(result.code).toBe('no_target')
  })
})
