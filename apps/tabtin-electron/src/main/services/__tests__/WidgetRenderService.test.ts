/**
 * WidgetRenderService 测试 — Widget Wave 4.3 关键不变量
 *
 * 守住的核心约束（widget RFC §五 4.3 + §四 4.2 已知坑）：
 *
 *   1. **renderToImage 永不抛**：内部异常 → `{ success: false, error: 'message' }`
 *   2. **format 校验**：Wave 6 支持 svg/html/mermaid，未知格式拒
 *   3. **code 长度校验**：8KB cap 防 OOM
 *   4. **wrapper HTML 用 widget-tokens**：CSP + theme 与 chat 预览同源
 *   5. **走 OffscreenWindowPool**：service 内部用 pool（不 new BrowserWindow 直接用）
 *   6. **fonts.ready 等待**：避免烤图字体丢失
 *   7. **失败重试**：capturePage 偶发暂态错误 retry 1 次
 *   8. **release 归还 pool**：即便失败也归还，不漏 entry
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  WidgetRenderService,
  WIDGET_RENDER_LOAD_FILE_TIMEOUT_MS,
  WIDGET_RENDER_CAPTURE_PAGE_TIMEOUT_MS,
} from '../WidgetRenderService'
import { OffscreenWindowPool } from '../OffscreenWindowPool'
import type { BrowserWindow } from 'electron'
import { WIDGET_CSP } from '@tabtin/widget-tokens'

/**
 * Mock BrowserWindow——支持 widget service 调到的 API：
 *   - loadFile / capturePage / executeJavaScript / setSize / webContents.setBackgroundThrottling
 *   - isDestroyed / destroy
 *
 * P0-2 新增：`loadFilePending` / `capturePagePending` 让测试可以模拟"widget 内
 * 死循环 script 让 did-finish-load 永不触发 / capturePage 永挂" 的场景。
 */
class MockBrowserWindow {
  destroyed = false
  loadFileCalls: string[] = []
  executeJSCalls: string[] = []
  capturePageCallCount = 0
  capturePageErrorTimes = 0
  loadedHtml: string = ''

  // Capture failure plan: throw N times, then succeed
  capturePageFailUntilAttempt = 0
  // **P0-2**：设 true 让 loadFile 返回永不 resolve 的 Promise（模拟死循环）
  loadFilePending = false
  // **P0-2**：设 true 让 capturePage 返回永不 resolve 的 Promise（renderer 卡死）
  capturePagePending = false

  webContents = {
    setBackgroundThrottling: () => {},
    setFrameRate: () => {},
    capturePage: async () => {
      this.capturePageCallCount += 1
      if (this.capturePagePending) {
        return new Promise(() => {}) as never // 永挂
      }
      if (this.capturePageCallCount <= this.capturePageFailUntilAttempt) {
        throw new Error(`capturePage failed attempt ${this.capturePageCallCount}`)
      }
      return {
        toPNG: () => Buffer.from('fake-png-' + this.capturePageCallCount),
      }
    },
    executeJavaScript: async (script: string) => {
      this.executeJSCalls.push(script)
      // document.fonts.ready check returns true
      return true
    },
    debugger: {
      isAttached: () => false,
      attach: () => {},
      detach: () => {},
      sendCommand: async () => ({ data: '' }),
    },
  }

  isDestroyed(): boolean {
    return this.destroyed
  }
  destroy(): void {
    this.destroyed = true
  }
  setSize(_w: number, _h: number): void {}
  async loadFile(htmlPath: string): Promise<void> {
    this.loadFileCalls.push(htmlPath)
    if (this.loadFilePending) {
      // 永不 resolve——模拟 widget 内死循环 script 卡住 renderer
      await new Promise(() => {})
      return
    }
    // 读 wrapper HTML 内容（让测试断言 CSP）
    const fs = await import('node:fs')
    this.loadedHtml = fs.readFileSync(htmlPath, 'utf-8')
  }
}

function makePool(maxConcurrent = 2): {
  pool: OffscreenWindowPool
  windows: MockBrowserWindow[]
} {
  const windows: MockBrowserWindow[] = []
  const factory = (): BrowserWindow => {
    const w = new MockBrowserWindow()
    windows.push(w)
    return w as unknown as BrowserWindow
  }
  const pool = new OffscreenWindowPool({ factory, maxConcurrent, idleTimeoutMs: 30_000 })
  return { pool, windows }
}

describe('WidgetRenderService — Wave 4.3 关键防线', () => {
  beforeEach(() => {
    WidgetRenderService.__resetForTests()
  })
  afterEach(() => {
    WidgetRenderService.__resetForTests()
  })

  // ── 防线 1: format 校验 ────────────────────────────────────────
  it.each(['', 'pdf'])(
    'format=%s 必须返回 success=false',
    async (badFormat) => {
      const { pool } = makePool()
      const svc = new WidgetRenderService({ pool })
      const result = await svc.renderToImage({
        code: '<svg/>',
        format: badFormat as 'svg',
      })
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/format/)
    },
  )

  it('format=svg + 合法 code → success=true 且返回 buffer', async () => {
    const { pool } = makePool()
    const svc = new WidgetRenderService({ pool })
    const result = await svc.renderToImage({
      code: '<svg viewBox="0 0 100 100"><rect/></svg>',
      format: 'svg',
    })
    expect(result.success).toBe(true)
    // Node Buffer 在 Node 内是 Uint8Array 子类——使用 Buffer.isBuffer 兼容
    // vitest 4 跨 realm 的 instanceof 严格性
    expect(Buffer.isBuffer(result.buffer) || result.buffer instanceof Uint8Array).toBe(true)
    expect(result.buffer!.length).toBeGreaterThan(0)
    expect(result.width).toBe(680)
    expect(result.height).toBe(400)
  })

  it.each([
    ['html', '<div style="color:hsl(var(--foreground))">设置页</div>'],
    ['mermaid', '<svg viewBox="0 0 100 40"><text>A</text></svg>'],
  ])('format=%s 进入同一 wrapper 烤图管线', async (format, code) => {
    const { pool, windows } = makePool()
    const svc = new WidgetRenderService({ pool })
    const result = await svc.renderToImage({
      code,
      format: format as 'html',
    })
    expect(result.success).toBe(true)
    expect(windows[0].loadedHtml).toContain(code)
  })

  // ── 防线 2: code 长度 cap ──────────────────────────────────────
  it('code 超 8KB 必须被拒绝', async () => {
    const { pool } = makePool()
    const svc = new WidgetRenderService({ pool })
    const huge = '<svg>' + 'x'.repeat(65 * 1024) + '</svg>'
    const result = await svc.renderToImage({ code: huge, format: 'svg' })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/too large|65536/)
  })

  it('空 code 必须被拒绝', async () => {
    const { pool } = makePool()
    const svc = new WidgetRenderService({ pool })
    const result = await svc.renderToImage({ code: '', format: 'svg' })
    expect(result.success).toBe(false)
  })

  // ── 防线 3: wrapper HTML 用 widget-tokens（CSP + theme 字面对齐 chat 预览）
  it('loadFile 写到磁盘的 wrapper HTML 必须含 widget-tokens 的 CSP', async () => {
    const { pool, windows } = makePool()
    const svc = new WidgetRenderService({ pool })
    await svc.renderToImage({
      code: '<svg viewBox="0 0 50 50"><circle/></svg>',
      format: 'svg',
    })
    const win = windows[0]
    expect(win.loadFileCalls.length).toBe(1)
    expect(win.loadedHtml).toContain(WIDGET_CSP)
    expect(win.loadedHtml).toContain('<svg viewBox="0 0 50 50"><circle/></svg>')
  })

  it('theme=dark 注入 dark token block', async () => {
    const { pool, windows } = makePool()
    const svc = new WidgetRenderService({ pool })
    await svc.renderToImage({
      code: '<svg/>',
      format: 'svg',
      theme: 'dark',
    })
    // dark bundle 的 background hsl 与 light 不同
    expect(windows[0].loadedHtml).toContain('--background:30 6% 12%;')
  })

  it('theme=light 默认值注入 light token block', async () => {
    const { pool, windows } = makePool()
    const svc = new WidgetRenderService({ pool })
    await svc.renderToImage({ code: '<svg/>', format: 'svg' })
    expect(windows[0].loadedHtml).toContain('--background:40 25% 99%;')
  })

  it('烤图模式必须 reducedMotion=true（避免截到 50% 透明帧）', async () => {
    const { pool, windows } = makePool()
    const svc = new WidgetRenderService({ pool })
    await svc.renderToImage({ code: '<svg/>', format: 'svg' })
    expect(windows[0].loadedHtml).toContain('animation:none !important')
  })

  // ── 防线 4: 走 OffscreenWindowPool（acquire/release）────────────
  it('renderToImage 后 pool entry 归还（poolSize 不增长，inUseCount=0）', async () => {
    const { pool, windows } = makePool()
    const svc = new WidgetRenderService({ pool })
    await svc.renderToImage({ code: '<svg/>', format: 'svg' })
    await svc.renderToImage({ code: '<svg><rect/></svg>', format: 'svg' })
    const m = pool.getMetric()
    expect(m.inUseCount).toBe(0)
    // 第二次复用第一次的 window
    expect(windows.length).toBe(1)
    expect(m.windowsReused).toBe(1)
  })

  it('format 校验失败时不 acquire pool（不浪费资源）', async () => {
    const { pool, windows } = makePool()
    const svc = new WidgetRenderService({ pool })
    await svc.renderToImage({ code: '<svg/>', format: 'pdf' as 'svg' })
    expect(windows.length).toBe(0)
    expect(pool.getMetric().windowsCreated).toBe(0)
  })

  // ── 防线 5: fonts.ready 等待 ─────────────────────────────────
  it('renderToImage 期间调用 document.fonts.ready', async () => {
    const { pool, windows } = makePool()
    const svc = new WidgetRenderService({ pool })
    await svc.renderToImage({ code: '<svg/>', format: 'svg' })
    const fontsCall = windows[0].executeJSCalls.find((s) => s.includes('document.fonts.ready'))
    expect(fontsCall).toBeDefined()
  })

  // ── 防线 6: capturePage 失败重试 ─────────────────────────────
  it('capturePage 第一次抛、第二次成功 → renderToImage success=true（重试 1 次）', async () => {
    const { pool, windows } = makePool()
    const svc = new WidgetRenderService({ pool })
    // 注入 mock：第 1 次 capturePage 抛错
    const factory = pool['factory'] // 内部 factory，但不直接调；用现有 windows 控制
    void factory
    // 改用：让 renderToImage 跑完，然后用第 2 个 mock window 设 fail
    // 简便做法：renderToImage 内部 call window = pool.acquire()，第 1 次拿到 windows[0]
    // 我们先 acquire 一个 entry 让 service 拿到 pre-config 的 mock
    // 但 service 自己管理 pool——通过让第一个 window 设 fail 来覆盖
    windows.length = 0
    // 关键：让下一次创建的 mock window 第 1 次 capture 抛
    const origPool = pool
    // override factory in pool: 让 next acquire 创建的 window 第 1 次 capture 抛
    // 此处用一个新 pool 让逻辑清晰
    const newWindows: MockBrowserWindow[] = []
    const newPool = new OffscreenWindowPool({
      factory: (): BrowserWindow => {
        const w = new MockBrowserWindow()
        w.capturePageFailUntilAttempt = 1 // 第 1 次失败，第 2 次成功
        newWindows.push(w)
        return w as unknown as BrowserWindow
      },
      maxConcurrent: 2,
      idleTimeoutMs: 30_000,
    })
    const svc2 = new WidgetRenderService({ pool: newPool })
    const result = await svc2.renderToImage({ code: '<svg/>', format: 'svg' })
    expect(result.success).toBe(true)
    expect(newWindows[0].capturePageCallCount).toBe(2) // 失败 1 + 成功 1
    void origPool
  })

  it('capturePage 一直失败 → renderToImage success=false（重试 1 次后放弃）', async () => {
    const newWindows: MockBrowserWindow[] = []
    const pool = new OffscreenWindowPool({
      factory: (): BrowserWindow => {
        const w = new MockBrowserWindow()
        w.capturePageFailUntilAttempt = 99 // 总是失败
        newWindows.push(w)
        return w as unknown as BrowserWindow
      },
      maxConcurrent: 2,
      idleTimeoutMs: 30_000,
    })
    const svc = new WidgetRenderService({ pool })
    const result = await svc.renderToImage({ code: '<svg/>', format: 'svg' })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/capturePage failed/)
    // 即便失败 entry 也归还（pool 状态干净）
    expect(pool.getMetric().inUseCount).toBe(0)
  })

  // ── 防线 7: 永不抛 ───────────────────────────────────────────
  it('renderToImage 永不抛——非法 input / 内部错误都返回 result 对象', async () => {
    const { pool } = makePool()
    const svc = new WidgetRenderService({ pool })
    // null / 缺字段
    await expect(svc.renderToImage(null as never)).resolves.toBeDefined()
    await expect(svc.renderToImage({ code: '<svg/>' } as never)).resolves.toBeDefined()
  })

  // ── 防线 8: getPoolMetric 暴露 metric 给 dev panel ────────────
  it('getPoolMetric 返回 pool metric（让 dev panel / 三视角 review 评估用）', async () => {
    const { pool } = makePool()
    const svc = new WidgetRenderService({ pool })
    await svc.renderToImage({ code: '<svg/>', format: 'svg' })
    const m = svc.getPoolMetric()
    expect(m.windowsCreated).toBe(1)
    expect(m.poolSize).toBe(1)
  })
})

// ─── P0-2 修复验证（2026-04-30）────────────────────────────────────────
//
// 修复目标：widget 内 inline script 死循环让 did-finish-load 永不触发
// → 旧实现 `await win.loadFile(htmlPath)` 永挂 → BrowserWindow 永久占用 →
// pool 饱和 → 整个 agent 停摆。新增 8s loadFile 超时 + 5s capturePage 超时，
// 超时后销毁 window（不回 pool，避免污染）。
describe('WidgetRenderService — P0-2：loadFile / capturePage 超时', () => {
  beforeEach(() => {
    WidgetRenderService.__resetForTests()
  })
  afterEach(() => {
    WidgetRenderService.__resetForTests()
  })

  it('WIDGET_RENDER_LOAD_FILE_TIMEOUT_MS 默认 8000（对标 Daemon 10s 略保守）', () => {
    expect(WIDGET_RENDER_LOAD_FILE_TIMEOUT_MS).toBe(8_000)
  })

  it('WIDGET_RENDER_CAPTURE_PAGE_TIMEOUT_MS 默认 5000', () => {
    expect(WIDGET_RENDER_CAPTURE_PAGE_TIMEOUT_MS).toBe(5_000)
  })

  it('**loadFile 永挂** → 8s 内返回 success=false + BrowserWindow 被销毁 + pool entry 被清', async () => {
    vi.useFakeTimers()
    try {
      const windows: MockBrowserWindow[] = []
      const factory = (): BrowserWindow => {
        const w = new MockBrowserWindow()
        w.loadFilePending = true // 模拟 widget 内死循环卡死 renderer
        windows.push(w)
        return w as unknown as BrowserWindow
      }
      const pool = new OffscreenWindowPool({
        factory,
        maxConcurrent: 2,
        idleTimeoutMs: 30_000,
      })
      const svc = new WidgetRenderService({ pool })

      const resultPromise = svc.renderToImage({
        code: '<svg/>',
        format: 'svg',
      })

      // 推进 8s 触发 loadFile timeout
      await vi.advanceTimersByTimeAsync(8_000)

      const result = await resultPromise
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/loadFile timed out/)

      // 关键：BrowserWindow 被销毁（不能污染 pool）
      expect(windows[0].destroyed).toBe(true)

      // Pool entry 被 release 走"external destroy"分支清掉
      expect(pool.getMetric().poolSize).toBe(0)
      expect(pool.getMetric().inUseCount).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('**capturePage 永挂** → 5s 内返回 success=false + window 销毁 + pool 清', async () => {
    vi.useFakeTimers()
    try {
      const windows: MockBrowserWindow[] = []
      const factory = (): BrowserWindow => {
        const w = new MockBrowserWindow()
        w.capturePagePending = true // loadFile OK，但 capturePage 挂
        windows.push(w)
        return w as unknown as BrowserWindow
      }
      const pool = new OffscreenWindowPool({
        factory,
        maxConcurrent: 2,
        idleTimeoutMs: 30_000,
      })
      const svc = new WidgetRenderService({ pool })

      const resultPromise = svc.renderToImage({
        code: '<svg/>',
        format: 'svg',
      })

      // loadFile 立刻完成（非 pending），capturePage 会挂
      // 推进 5s 触发 capturePage timeout
      await vi.advanceTimersByTimeAsync(5_000)

      const result = await resultPromise
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/capturePage timed out/)
      expect(windows[0].destroyed).toBe(true)
      expect(pool.getMetric().poolSize).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('**pool 饱和场景**：两个永挂 widget 占死 pool → 第三个 widget 15s 内 timeout 不挂死', async () => {
    vi.useFakeTimers()
    try {
      const windows: MockBrowserWindow[] = []
      const factory = (): BrowserWindow => {
        const w = new MockBrowserWindow()
        w.loadFilePending = true
        windows.push(w)
        return w as unknown as BrowserWindow
      }
      const pool = new OffscreenWindowPool({
        factory,
        maxConcurrent: 2,
        idleTimeoutMs: 30_000,
      })
      const svc = new WidgetRenderService({ pool })

      // 第 1 + 2 个恶意 widget 永挂（8s 后 loadFile timeout → destroy → release）
      // 第 3 个 widget 先排队（pool 满）
      const p1 = svc.renderToImage({ code: '<svg>a</svg>', format: 'svg' })
      const p2 = svc.renderToImage({ code: '<svg>b</svg>', format: 'svg' })
      const p3 = svc.renderToImage({ code: '<svg>c</svg>', format: 'svg' })

      // 推进 8s 让 p1/p2 触发 loadFile timeout → 销毁 + release → p3 拿到 window
      // 但新 window 也是 loadFilePending → 再 8s 后 p3 也 timeout
      await vi.advanceTimersByTimeAsync(8_000)
      await Promise.resolve()
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(8_000)

      const [r1, r2, r3] = await Promise.all([p1, p2, p3])
      expect(r1.success).toBe(false)
      expect(r2.success).toBe(false)
      expect(r3.success).toBe(false)
      expect(r1.error).toMatch(/timed out/)
      expect(r2.error).toMatch(/timed out/)

      // 所有 window 被销毁，pool 清干净
      expect(windows.every((w) => w.destroyed)).toBe(true)
      expect(pool.getMetric().poolSize).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('**正常烤图不误触**：非 pending widget 能正常完成不受 timeout 影响', async () => {
    // 用 real timer（确保正常路径在几 ms 内完成）
    const { pool, windows } = makePool()
    const svc = new WidgetRenderService({ pool })
    const result = await svc.renderToImage({
      code: '<svg><rect/></svg>',
      format: 'svg',
    })
    expect(result.success).toBe(true)
    expect(result.buffer).toBeDefined()
    expect(windows[0].destroyed).toBe(false) // window 正常归还不销毁
    expect(pool.getMetric().poolSize).toBe(1)
    expect(pool.getMetric().inUseCount).toBe(0)
  })
})
