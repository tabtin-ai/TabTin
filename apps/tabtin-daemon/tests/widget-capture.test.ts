/**
 * captureWidget 测试 — Widget Wave 4.4 关键不变量（widget RFC §五 4.4）。
 *
 * 守住的核心约束：
 *
 *   1. **format 校验**：Wave 6 支持 svg/html/mermaid，未知格式拒
 *   2. **code 长度 cap 8KB**：与 Electron WidgetRenderService / show-widget.ts 字面一致
 *   3. **永不抛**：内部异常包成 `{ success: false, error }`
 *   4. **管线正确**：browser.newContext → newPage → setContent → fonts.ready →
 *      page.screenshot → page.close + ctx.close
 *   5. **wrapper HTML 用 widget-tokens 同源**：CSP + theme 字面对齐
 *   6. **资源清理**：即便失败也 close page + ctx，不漏 leak
 *
 * 测试策略：mock `ensureBrowser` 返回 mock browser，让 captureWidget 跑完
 * 整条管线，断言：
 *   - setContent 收到含 WIDGET_CSP 的 HTML
 *   - 字体等待被调
 *   - screenshot 被调，buffer 返回
 *   - 失败路径不 leak
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DaemonBrowserService } from '../src/platform/browser/DaemonBrowserService.js'
import { WIDGET_CSP } from '@tabtin/widget-tokens'
import type { Logger } from '../src/platform/observability/logging/logger.js'

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger
}

describe('DaemonBrowserService.captureWidget — Wave 4.4', () => {
  let service: DaemonBrowserService
  let mockPage: any
  let mockContext: any
  let mockBrowser: any

  beforeEach(() => {
    service = new DaemonBrowserService(makeLogger())

    // Mock Page：记录 setContent / evaluate / screenshot / close
    mockPage = {
      setContentCalls: [] as Array<{ html: string; opts?: unknown }>,
      evaluateCalls: 0,
      screenshotCalls: 0,
      closed: false,
      setContent: vi.fn(async (html: string, opts: unknown) => {
        mockPage.setContentCalls.push({ html, opts })
      }),
      evaluate: vi.fn(async () => {
        mockPage.evaluateCalls += 1
        return true
      }),
      screenshot: vi.fn(async (_opts: unknown) => {
        mockPage.screenshotCalls += 1
        return Buffer.from('fake-png-bytes')
      }),
      close: vi.fn(async () => {
        mockPage.closed = true
      }),
      isClosed: () => mockPage.closed,
      url: () => 'about:blank',
    }
    mockContext = {
      closed: false,
      newPage: vi.fn(async () => mockPage),
      close: vi.fn(async () => {
        mockContext.closed = true
      }),
    }
    mockBrowser = {
      newContext: vi.fn(async (_opts: unknown) => mockContext),
    }

    // 注入 mockBrowser 到 service.ensureBrowser（避免真 launch Chromium）
    ;(service as unknown as { ensureBrowser: () => Promise<unknown> }).ensureBrowser = async () =>
      mockBrowser
  })

  // ── 防线 1: format 校验 ────────────────────────────────────────
  it.each(['pdf', ''])(
    'format=%s 必须返回 success=false',
    async (badFormat) => {
      const result = await service.captureWidget({
        code: '<svg/>',
        format: badFormat as 'svg',
      })
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/format/)
      // 校验失败时不 launch browser
      expect(mockBrowser.newContext).not.toHaveBeenCalled()
    },
  )

  // ── 防线 2: render code 长度 cap 64KB ───────────────────────────
  it('render code 超 64KB 必须被拒绝', async () => {
    const huge = '<svg>' + 'x'.repeat(65 * 1024) + '</svg>'
    const result = await service.captureWidget({ code: huge, format: 'svg' })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/too large|65536/)
    expect(mockBrowser.newContext).not.toHaveBeenCalled()
  })

  it('空 code 必须被拒绝', async () => {
    const result = await service.captureWidget({ code: '', format: 'svg' })
    expect(result.success).toBe(false)
  })

  it('null/undefined input 必须被拒绝', async () => {
    const r1 = await service.captureWidget(null as never)
    expect(r1.success).toBe(false)
    expect(r1.error).toMatch(/invalid input/)
  })

  // ── 防线 3: 管线正确（setContent → fonts.ready → screenshot）──────
  it('format=svg + 合法 code → 走完整管线 + 返回 buffer', async () => {
    const result = await service.captureWidget({
      code: '<svg viewBox="0 0 100 100"><rect/></svg>',
      format: 'svg',
    })
    expect(result.success).toBe(true)
    expect(result.buffer).toBeDefined()
    expect(result.buffer!.length).toBeGreaterThan(0)
    // 默认 viewport 680×400，DPR=2 → 输出实际像素
    expect(result.width).toBe(1360)
    expect(result.height).toBe(800)

    // 管线步骤都被调
    expect(mockBrowser.newContext).toHaveBeenCalledTimes(1)
    expect(mockContext.newPage).toHaveBeenCalledTimes(1)
    expect(mockPage.setContent).toHaveBeenCalledTimes(1)
    expect(mockPage.evaluateCalls).toBe(1) // document.fonts.ready
    expect(mockPage.screenshotCalls).toBe(1)
    // 资源清理（即便成功也要 close）
    expect(mockPage.closed).toBe(true)
    expect(mockContext.closed).toBe(true)
  })

  it.each([
    ['html', '<div style="color:hsl(var(--foreground))">设置页</div>'],
    ['mermaid', '<svg viewBox="0 0 100 40"><text>A</text></svg>'],
  ])('format=%s 进入同一 wrapper 烤图管线', async (format, code) => {
    const result = await service.captureWidget({
      code,
      format: format as 'html',
    })
    expect(result.success).toBe(true)
    const { html } = mockPage.setContentCalls[0]
    expect(html).toContain(code)
  })

  // ── 防线 4: wrapper HTML 字面对齐 chat 预览（CSP + theme）─────────
  it('setContent 收到的 HTML 含 widget-tokens CSP（与 chat 预览字面一致）', async () => {
    await service.captureWidget({
      code: '<svg viewBox="0 0 50 50"><circle/></svg>',
      format: 'svg',
    })
    const { html } = mockPage.setContentCalls[0]
    expect(html).toContain(WIDGET_CSP)
    expect(html).toContain('<svg viewBox="0 0 50 50"><circle/></svg>')
  })

  it('theme=dark 注入 dark token block', async () => {
    await service.captureWidget({
      code: '<svg/>',
      format: 'svg',
      theme: 'dark',
    })
    const { html } = mockPage.setContentCalls[0]
    expect(html).toContain('--background:30 6% 9%;')
  })

  it('theme=light 默认值注入 light token block', async () => {
    await service.captureWidget({ code: '<svg/>', format: 'svg' })
    const { html } = mockPage.setContentCalls[0]
    expect(html).toContain('--background:40 25% 99%;')
  })

  it('烤图模式必须 reducedMotion=true', async () => {
    await service.captureWidget({ code: '<svg/>', format: 'svg' })
    const { html } = mockPage.setContentCalls[0]
    expect(html).toContain('animation:none !important')
  })

  // ── 防线 5: 永不抛 + 失败路径资源清理 ──────────────────────────
  it('setContent 抛错 → success=false + 资源已清理', async () => {
    mockPage.setContent.mockRejectedValueOnce(new Error('navigation timeout'))
    const result = await service.captureWidget({ code: '<svg/>', format: 'svg' })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/navigation timeout/)
    // 即便失败也要 close（不漏 leak）
    expect(mockPage.closed).toBe(true)
    expect(mockContext.closed).toBe(true)
  })

  it('screenshot 抛错 → success=false + 资源已清理', async () => {
    mockPage.screenshot.mockRejectedValueOnce(new Error('OOM'))
    const result = await service.captureWidget({ code: '<svg/>', format: 'svg' })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/OOM/)
    expect(mockPage.closed).toBe(true)
    expect(mockContext.closed).toBe(true)
  })

  it('ensureBrowser 抛错 → success=false（Chrome 没装兜底）', async () => {
    ;(service as unknown as { ensureBrowser: () => Promise<unknown> }).ensureBrowser = async () => {
      throw new Error('No Chrome found')
    }
    const result = await service.captureWidget({ code: '<svg/>', format: 'svg' })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/browser launch failed|No Chrome/)
    // 没创建 page → 不需要 close
    expect(mockPage.closed).toBe(false)
  })

  // ── 防线 6: viewport 自定义 ─────────────────────────────────────
  it('自定义 viewport 传到 newContext', async () => {
    await service.captureWidget({
      code: '<svg/>',
      format: 'svg',
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
    })
    const ctxOpts = mockBrowser.newContext.mock.calls[0][0]
    expect(ctxOpts.viewport.width).toBe(800)
    expect(ctxOpts.viewport.height).toBe(600)
    expect(ctxOpts.deviceScaleFactor).toBe(1)
  })

  // ── 防线 7: fonts.ready evaluate 失败不阻塞主流程 ──────────────
  it('document.fonts.ready evaluate 失败仍继续 screenshot（降级到 system stack）', async () => {
    mockPage.evaluate.mockRejectedValueOnce(new Error('fonts api unavailable'))
    const result = await service.captureWidget({ code: '<svg/>', format: 'svg' })
    expect(result.success).toBe(true)
    expect(mockPage.screenshotCalls).toBe(1)
  })
})
