/**
 * ElectronBrowserContext — Electron 端的 BrowserContext 实现
 *
 * 通过 WebContents + debugger API 适配 browser-core 的 L2 统一接口。
 * Phase 2 产物，当前独立于 BrowserToolImpl（后续步骤会切换）。
 */

import type { WebContents } from 'electron'
import type { BrowserContext, ScreenshotOptions } from '@tabtin/browser-core'
import { getCDPConnectionManager } from '@tabtin/browser-core'
import { createLogger } from '../logger'

const log = createLogger('ElectronBrowserContext')

export class ElectronBrowserContext implements BrowserContext {
  private eventListeners = new Set<
    (ev: { method: string; params: Record<string, unknown> }) => void
  >()
  private debuggerMessageHandler:
    | ((event: Electron.Event, method: string, params: Record<string, unknown>) => void)
    | null = null
  private attachedByUs = false

  constructor(private readonly wc: WebContents) {}

  isAlive(): boolean {
    return !this.wc.isDestroyed()
  }

  private async ensureAttached(): Promise<void> {
    if (this.wc.debugger.isAttached()) return
    const cdpManager = getCDPConnectionManager()
    await cdpManager.getOrAttach(this.wc, {
      strategy: 'keep-alive',
    })
    this.attachedByUs = true
  }

  async sendCDP<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    await this.ensureAttached()
    return this.wc.debugger.sendCommand(method, params) as Promise<T>
  }

  onCDPEvent(
    handler: (ev: { method: string; params: Record<string, unknown> }) => void,
  ): () => void {
    if (!this.wc.debugger.isAttached()) {
      log.warn(
        'onCDPEvent: debugger 未 attach，监听器已注册，将在 attach 后生效',
      )
    }
    this.eventListeners.add(handler)

    if (!this.debuggerMessageHandler) {
      this.debuggerMessageHandler = (
        _event: Electron.Event,
        method: string,
        params: Record<string, unknown>,
      ) => {
        const ev = { method, params }
        for (const listener of this.eventListeners) {
          listener(ev)
        }
      }
      this.wc.debugger.on('message', this.debuggerMessageHandler)
    }

    return () => {
      this.eventListeners.delete(handler)
      if (this.eventListeners.size === 0 && this.debuggerMessageHandler) {
        this.wc.debugger.removeListener('message', this.debuggerMessageHandler)
        this.debuggerMessageHandler = null
      }
    }
  }

  listChildFrameIds(): string[] {
    const mainFrame = this.wc.mainFrame
    return mainFrame.framesInSubtree
      .filter((frame) => frame !== mainFrame && !frame.detached && !frame.isDestroyed())
      .map((frame) => String(frame.frameTreeNodeId))
  }

  async executeScript<T>(code: string, frameId?: string): Promise<T> {
    if (frameId) {
      const frame = this.wc.mainFrame.framesInSubtree.find(
        (candidate) =>
          String(candidate.frameTreeNodeId) === frameId &&
          !candidate.detached &&
          !candidate.isDestroyed(),
      )
      if (!frame) {
        throw new Error('目标 frame 已失效，请重新 glance')
      }
      return frame.executeJavaScript(code) as Promise<T>
    }
    return this.wc.executeJavaScript(code)
  }

  async loadURL(url: string): Promise<void> {
    await Promise.race([
      this.wc.loadURL(url),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('loadURL timeout (30s)')), 30_000)
      ),
    ]);
  }

  getCurrentURL(): string {
    return this.wc.getURL()
  }

  async getTitle(): Promise<string> {
    return this.wc.getTitle()
  }

  async captureScreenshot(options?: ScreenshotOptions): Promise<Buffer> {
    const { fullPage = false, width, format = 'jpeg', quality } = options ?? {}
    const effectiveQuality = format === 'jpeg' ? (quality ?? 80) : undefined

    await this.ensureAttached()

    let needsRestore = false
    try {
      if (width) {
        await this.wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
          width,
          height: 0, // 不覆盖高度，保持实际视口值（CDP 语义：0 = no override）
          deviceScaleFactor: 1,
          mobile: false,
        })
        needsRestore = true
        await new Promise((r) => setTimeout(r, 150))
      }

      const result = await this.wc.debugger.sendCommand('Page.captureScreenshot', {
        format,
        ...(effectiveQuality != null ? { quality: effectiveQuality } : {}),
        captureBeyondViewport: fullPage,
      })

      return Buffer.from(result.data, 'base64')
    } finally {
      if (needsRestore) {
        await this.wc.debugger
          .sendCommand('Emulation.clearDeviceMetricsOverride')
          .catch(() => {})
      }
    }
  }

  async detach(): Promise<void> {
    if (this.debuggerMessageHandler) {
      this.wc.debugger.removeListener('message', this.debuggerMessageHandler)
      this.debuggerMessageHandler = null
    }
    this.eventListeners.clear()

    if (this.attachedByUs) {
      const cdpManager = getCDPConnectionManager()
      cdpManager.detach(this.wc.id, 'electron_browser_context_detach')
      this.attachedByUs = false
    }
  }
}
