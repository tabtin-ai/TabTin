/**
 * WidgetRenderService — Electron 主进程的 widget 离屏渲染服务（widget RFC §五 4.3）。
 *
 * **业务职责**：把 `show_widget` 工具传过来的 SVG / HTML / Mermaid 源代码包成
 * sandbox iframe 等价的 wrapper HTML，加载到隐藏 BrowserWindow，等字体就位后
 * `capturePage` 烤 PNG buffer 返回。Wave 6 起支持 SVG / HTML(no-script)；
 * Mermaid 在 agent-runtime execute 阶段已编译成 SVG 后再进入本服务。
 *
 * **跟 TabVideoRenderService 的关系**：
 *   - 共享模式：隐藏离屏 BrowserWindow + `loadFile` 临时 wrapper HTML +
 *     `capturePage` 烤图——参考 `TabVideoRenderService.ts:266-322`
 *   - **不**共用同一个 service 实例：TabVideo 是视频帧（动画 + chunk-level
 *     concurrency=8 + FFmpeg 编码），widget 是单帧静态图。共享会让两个 service
 *     互相耦合。
 *   - 共用 `OffscreenWindowPool`：未来 TabSlide / TabDoc 等接入也共用同一池，
 *     避免每个 BrowserWindow ~30MB 拖慢主进程。
 *
 * **错误恢复**：
 *   - 字体未加载 → 等 `document.fonts.ready` 最多 1.5s（足够本地系统字体加载）
 *   - capturePage 抛 → 一次重试，再失败返回 `{ success: false, error }`
 *   - 永不抛——`renderToImage` 是 OffscreenRenderAPI 的 contract，调用方期望
 *     用 try 不必 catch
 *
 * **注册时机**：`bridge-core.ts` 在 startup 时调 `setOffscreenRenderAPI(...)`
 * 把本 service 暴露给 `packages/action-tools` 全局，让 `show-widget.ts` 工具
 * `resolveOffscreenRenderAPI()` 拿到 → execute 烤图。
 */

import { BrowserWindow } from 'electron'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { buildWrapper, DEFAULT_VIEWPORT } from '@tabtin/widget-tokens'
import type {
  OffscreenRenderInput,
  OffscreenRenderResult,
} from '@tabtin/action-tools/headless'
import {
  OffscreenWindowPool,
  OFFSCREEN_POOL_MAX_CONCURRENT,
  OFFSCREEN_POOL_IDLE_TIMEOUT_MS,
  OFFSCREEN_POOL_ACQUIRE_TIMEOUT_MS,
} from './OffscreenWindowPool'

/**
 * 字体等待最大时长——document.fonts.ready 通常 < 200ms 完成；1.5s 是给
 * iCloud 同步字体（Apple 的 SF / PingFang 等）预留余量。再长就放弃，截
 * fallback system stack 字体。
 */
const FONT_READY_TIMEOUT_MS = 1500

/**
 * capturePage 失败重试次数。Chrome 偶有"BrowserWindow content not yet
 * laid out"的暂态错误，重试 1 次几乎都能过。
 */
const CAPTURE_RETRY_COUNT = 1

/**
 * **P0-2 修复（2026-04-30）**：`loadFile` 超时——widget 内 inline script `while(1){}`
 * 死循环会让 renderer 主线程卡死，`did-finish-load` 事件永不触发，Promise
 * 永不 resolve。旧实现无任何兜底——单个恶意 widget 能永久占用一个 BrowserWindow
 * → 第二个占用第二个 → 整个 widget pool 死锁 → agent 停摆。
 *
 * 8s 与 Daemon `captureWidget` 的 `page.setContent({ timeout: 10000 })` 对齐，略保守——
 * 合法 widget 的 loadFile 通常 < 500ms（SVG + 内联 style），8s 已经覆盖 p99.9。
 * 超时后必须**销毁 BrowserWindow**（不归还 pool），防死循环 widget 污染后续烤图。
 */
const LOAD_FILE_TIMEOUT_MS = 8_000

/**
 * **P0-2 修复**：`capturePage` 超时——renderer 卡死时 capturePage 也可能挂。
 * 通常 < 100ms 完成，5s 已经是工程合理上限。
 */
const CAPTURE_PAGE_TIMEOUT_MS = 5_000

/**
 * **P0-2**：强制销毁 BrowserWindow + 记 log（不抛）——在 loadFile / capturePage
 * 超时的错误路径调用，让 BrowserWindow 被 SIGKILL 级强退出，`win.isDestroyed()`
 * 之后返回 true，`pool.release(entry)` 走"external destroy"分支从 pool 里删除
 * entry，而不是归还 idle（污染后续 widget）。
 *
 * 理由（为什么销毁而不是归还）：
 *   1. renderer 卡死的 window 即使 loadFile 后来"醒过来"，状态也被污染（可能仍有
 *      死循环 script 在跑，吃 CPU + 持有内存）。
 *   2. 归还后下一个 widget 复用同一 window 会继承污染——下一个 widget 也会被卡。
 *   3. 销毁后 pool 空了一个位置，下次 acquire 会创建新 window——30MB 代价可接受。
 *
 * **实现保证**：Electron `BrowserWindow.destroy()` 底层调 Chromium
 * `WebContents::Close()` → 对 renderer process 发 SIGKILL（Linux/macOS）或
 * `TerminateProcess`（Windows）。不等待 renderer 优雅退出，所以死循环 script
 * 立即停止。无僵尸 renderer process。
 */
function destroyWindowSafely(win: BrowserWindow, logger: (msg: string) => void, reason: string): void {
  try {
    if (!win.isDestroyed()) {
      win.destroy()
      logger(`[WidgetRenderService] destroyed window after ${reason}`)
    }
  } catch (err) {
    logger(`[WidgetRenderService] destroy after ${reason} failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timerHandle: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timerHandle = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms,
        )
        if (typeof timerHandle.unref === 'function') timerHandle.unref()
      }),
    ])
  } finally {
    if (timerHandle) clearTimeout(timerHandle)
  }
}

/**
 * 渲染代码上限。输入 source 仍由 show_widget 控制在 8KB；Mermaid 编译后的 SVG
 * 往往会膨胀，所以离屏渲染层给 64KB 余量，同时防止异常大图拖垮 BrowserWindow。
 */
const MAX_RENDER_CODE_BYTES = 64 * 1024
const SUPPORTED_RENDER_FORMATS = new Set(['svg', 'html', 'mermaid'])

export interface WidgetRenderServiceOptions {
  /**
   * 测试用：注入 mock pool，避免依赖 Electron runtime。生产环境不传，service
   * 自动用真 BrowserWindow factory 创建 pool。
   */
  pool?: OffscreenWindowPool
  /** 测试用：注入 logger 让 dev 时输出 debug，生产环境 noop。 */
  logger?: (msg: string) => void
}

/**
 * Widget 离屏渲染服务——单例模式，与 TabVideoRenderService 一致。
 */
export class WidgetRenderService {
  private static instance: WidgetRenderService | null = null
  private readonly pool: OffscreenWindowPool
  private readonly logger: (msg: string) => void

  static getInstance(options?: WidgetRenderServiceOptions): WidgetRenderService {
    if (!WidgetRenderService.instance) {
      WidgetRenderService.instance = new WidgetRenderService(options)
    }
    return WidgetRenderService.instance
  }

  /**
   * 测试用——重置单例（vitest 多 case 之间不污染）。生产代码不调。
   */
  static __resetForTests(): void {
    WidgetRenderService.instance?.dispose()
    WidgetRenderService.instance = null
  }

  constructor(options?: WidgetRenderServiceOptions) {
    this.logger = options?.logger ?? (() => {})
    this.pool =
      options?.pool ??
      new OffscreenWindowPool({
        maxConcurrent: OFFSCREEN_POOL_MAX_CONCURRENT,
        idleTimeoutMs: OFFSCREEN_POOL_IDLE_TIMEOUT_MS,
        factory: () =>
          new BrowserWindow({
            width: DEFAULT_VIEWPORT.width,
            height: DEFAULT_VIEWPORT.height,
            show: false,
            frame: false,
            webPreferences: {
              offscreen: true,
              nodeIntegration: false,
              contextIsolation: true,
            },
          }),
        logger: this.logger,
      })
  }

  /**
   * 烤图入口——OffscreenRenderAPI.renderToImage 的实现。
   *
   * **永不抛**：内部异常 → `{ success: false, error: 'message' }`
   *
   * **流程**：
   *   1. 校验 format 是 'svg' / 'html' / 'mermaid' + code 长度
   *   2. 从 pool acquire 隐藏 BrowserWindow
   *   3. 写 wrapper HTML 到 tmp 文件 → loadFile（不是 data: URL，避免 2MB
   *      限制 + 外部资源 CORS 问题，与 TabVideoRenderService 模式一致）
   *   4. 等 `document.fonts.ready`（最多 FONT_READY_TIMEOUT_MS）
   *   5. capturePage 拿 PNG buffer
   *   6. release 归还 pool（即便失败也要归还，否则 pool 漏 entry）
   *   7. 删 tmp 文件
   */
  async renderToImage(input: OffscreenRenderInput): Promise<OffscreenRenderResult> {
    // ── 1. 校验 ─────────────────────────────────────────
    if (!input || typeof input !== 'object') {
      return { success: false, error: 'invalid input' }
    }
    if (!SUPPORTED_RENDER_FORMATS.has(input.format)) {
      return {
        success: false,
        error: `unsupported format "${input.format}". Supported formats: svg, html, mermaid.`,
      }
    }
    const code = typeof input.code === 'string' ? input.code : ''
    if (!code) {
      return { success: false, error: 'code is required' }
    }
    const codeBytes = new TextEncoder().encode(code).length
    if (codeBytes > MAX_RENDER_CODE_BYTES) {
      return {
        success: false,
        error: `widget code too large: ${codeBytes} bytes > ${MAX_RENDER_CODE_BYTES} bytes`,
      }
    }

    const viewport = {
      width: input.viewport?.width ?? DEFAULT_VIEWPORT.width,
      height: input.viewport?.height ?? DEFAULT_VIEWPORT.height,
    }
    const theme = input.theme ?? 'light'
    const wrapperHtml = buildWrapper(code, {
      theme,
      width: viewport.width,
      // 烤图模式必须关 fade-in 动画——否则截到 50% 透明帧
      reducedMotion: true,
    })

    // ── 2. 写 tmp wrapper HTML ───────────────────────────
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'widget-render-'))
    const htmlPath = path.join(tmpDir, 'widget.html')
    try {
      fs.writeFileSync(htmlPath, wrapperHtml, 'utf-8')
    } catch (err) {
      this.cleanupTmp(tmpDir)
      return {
        success: false,
        error: `tmp write failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }

    // ── 3. acquire window + render ───────────────────────
    let entry: Awaited<ReturnType<OffscreenWindowPool['acquire']>> | null = null
    try {
      // **可靠性 Review 自修（2026-04-30）**：显式传 timeout，避免 pool 默认值
      // 未来被其他调用方（如 Daemon 共用 pool）调整时 silently 影响 widget 行为。
      // 本服务对 acquire timeout 的语义有确定需求（> 2×loadFile=16s），显式声明。
      entry = await this.pool.acquire(OFFSCREEN_POOL_ACQUIRE_TIMEOUT_MS)
      if (entry.window.isDestroyed()) {
        return { success: false, error: 'BrowserWindow was destroyed before render' }
      }

      const win = entry.window
      // setSize 让 viewport 与 input 对齐——pool 创建时是默认 size，
      // 不同 widget 调用可能传不同 viewport
      try {
        win.setSize(viewport.width, viewport.height)
      } catch {
        /* setSize 偶有 platform-specific 异常，忽略——load 后会按 CSS 宽度 fit */
      }
      win.webContents.setBackgroundThrottling(false)

      // **P0-2 修复**：loadFile 加 timeout——死循环 inline script 会让
      // `did-finish-load` 事件永不触发，旧实现 Promise 永挂单个恶意 widget 就能
      // 占死 pool 一整个 entry。超时后走 catch 分支 → finally 检查
      // window.isDestroyed() → 对应的销毁路径让 pool 删除污染 entry。
      try {
        await withTimeout(
          win.loadFile(htmlPath),
          LOAD_FILE_TIMEOUT_MS,
          'widget loadFile',
        )
      } catch (err) {
        destroyWindowSafely(win, this.logger, 'loadFile timeout')
        throw err
      }

      // 等字体就位——避免烤图字体丢失（widget RFC §四 4.2 已知坑 #2）
      await this.waitForFontsReady(win)

      // ── 4. capturePage（含一次重试 + P0-2 超时）──────────
      const buffer = await this.captureWithRetry(win)

      this.logger(
        `[WidgetRenderService] rendered ${codeBytes} bytes → ${buffer.length} bytes PNG`,
      )

      return {
        success: true,
        buffer,
        width: viewport.width,
        height: viewport.height,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.logger(`[WidgetRenderService] render failed: ${msg}`)
      return { success: false, error: msg }
    } finally {
      // 归还 pool，即便失败也要归还（pool 内部会处理 destroyed window）
      if (entry) this.pool.release(entry)
      this.cleanupTmp(tmpDir)
    }
  }

  /**
   * 等待 `document.fonts.ready`，最多 FONT_READY_TIMEOUT_MS。
   *
   * 实现：在 webContents 里跑 `await document.fonts.ready` 表达式，外面 Promise.race
   * 套 setTimeout。超时不抛——降级到 system stack（用户视觉略有差异但能看图）。
   */
  private async waitForFontsReady(win: BrowserWindow): Promise<void> {
    if (win.isDestroyed()) return
    try {
      await Promise.race([
        win.webContents.executeJavaScript(
          // 注意：document.fonts.ready 是 Promise，await 之
          `(async () => { await document.fonts.ready; return true; })()`,
        ),
        // 可靠性 Review 自修：加 .unref() 与 withTimeout / acquire timer 的惯例
        // 一致，让 Electron 进程收到 SIGTERM 时不被这个 1.5s 计时器阻塞退出。
        new Promise<true>((resolve) => {
          const handle = setTimeout(() => resolve(true), FONT_READY_TIMEOUT_MS)
          if (typeof handle.unref === 'function') handle.unref()
        }),
      ])
    } catch (err) {
      // executeJavaScript 抛了——可能 win 在加载中途崩溃；不抛 service 给调用方
      this.logger(`[WidgetRenderService] fonts.ready failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * capturePage with one retry. 偶发 "content not yet laid out"，retry 几乎都过。
   *
   * **P0-2**：每次 capturePage 加 5s timeout——renderer 卡死时 capturePage 也
   * 可能挂。超时后抛给上层，上层 finally 归还 pool（有可能 window 已经被
   * destroy），pool 自动把污染 entry 删掉。
   *
   * 第二次失败抛——交给 renderToImage 的 try-catch 包成 OffscreenRenderResult。
   */
  private async captureWithRetry(win: BrowserWindow): Promise<Buffer> {
    let lastErr: unknown = null
    for (let attempt = 0; attempt <= CAPTURE_RETRY_COUNT; attempt++) {
      if (win.isDestroyed()) {
        throw new Error('BrowserWindow destroyed during capture')
      }
      try {
        const image = await withTimeout(
          win.webContents.capturePage(),
          CAPTURE_PAGE_TIMEOUT_MS,
          'widget capturePage',
        )
        const png = image.toPNG()
        if (png.length === 0) throw new Error('empty PNG buffer')
        return png
      } catch (err) {
        lastErr = err
        // P0-2：capturePage 超时时直接销毁 window——不给第二次机会。
        // 超时意味着 renderer 卡死，retry 不可能成功，反而会再卡 5s。
        if (err instanceof Error && err.message.includes('capturePage timed out')) {
          destroyWindowSafely(win, this.logger, 'capturePage timeout')
          throw err
        }
        // 短暂等再试
        await new Promise((r) => setTimeout(r, 50))
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }

  private cleanupTmp(tmpDir: string): void {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* ignore — tmp 残留不影响功能，OS 会定期清 */
    }
  }

  /**
   * 暴露 pool metric——dev panel / 测试 / 三视角 review 评估用。
   */
  getPoolMetric(): ReturnType<OffscreenWindowPool['getMetric']> {
    return this.pool.getMetric()
  }

  /**
   * 服务关闭——pool dispose 销毁所有 window。
   */
  dispose(): void {
    this.pool.dispose()
  }
}

/**
 * **P0-2 修复**：对外暴露的超时常量，供单元测试 + dev panel 断言 + 未来调优。
 *
 * **不要随意扩大**：这些超时是 DoS 防线，不是"让慢 widget 跑得动"的性能 knob。
 * 若 p99 合法 widget 真正需要更长时间，先查是不是 Mermaid 编译 DSL 爆炸 / 字体
 * 加载卡死 / SVG 层级过深——95% 情况是代码问题而不是超时值问题。
 */
export const WIDGET_RENDER_LOAD_FILE_TIMEOUT_MS = LOAD_FILE_TIMEOUT_MS
export const WIDGET_RENDER_CAPTURE_PAGE_TIMEOUT_MS = CAPTURE_PAGE_TIMEOUT_MS
