/**
 * LegacyWebContentsBrowserContext
 *
 * 将 Electron webContents (或 PlaywrightWebContentsShim) 包装为 BrowserContext 接口。
 * 仅在 setElectronViewGetter 被调用而 setContextFactory 未被调用时作为兼容层使用。
 * 新代码应始终通过 setContextFactory 注入 ElectronBrowserContext / DaemonBrowserContext。
 */

import type { BrowserContext, ScreenshotOptions } from './BrowserContext';

export class LegacyWebContentsBrowserContext implements BrowserContext {
  private eventListeners = new Set<(ev: { method: string; params: Record<string, unknown> }) => void>();
  private debuggerMessageHandler:
    | ((event: unknown, method: string, params: Record<string, unknown>) => void)
    | null = null;

  constructor(private readonly wc: any) {}

  isAlive(): boolean {
    return typeof this.wc.isDestroyed === 'function' ? !this.wc.isDestroyed() : true;
  }

  async sendCDP<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T> {
    const dbg = this.wc.debugger;
    if (!dbg) throw new Error('webContents.debugger is not available');
    if (typeof dbg.isAttached === 'function' && !dbg.isAttached()) {
      await dbg.attach('1.3');
    }
    return dbg.sendCommand(method, params) as Promise<T>;
  }

  onCDPEvent(handler: (ev: { method: string; params: Record<string, unknown> }) => void): () => void {
    const dbg = this.wc.debugger;
    if (!dbg) return () => {};

    if (typeof dbg.isAttached === 'function' && !dbg.isAttached()) {
      dbg.attach('1.3');
    }

    this.eventListeners.add(handler);

    if (!this.debuggerMessageHandler) {
      this.debuggerMessageHandler = (
        _event: unknown,
        method: string,
        params: Record<string, unknown>,
      ) => {
        const ev = { method, params };
        for (const listener of this.eventListeners) {
          try { listener(ev); } catch { /* handler error isolated */ }
        }
      };
      dbg.on('message', this.debuggerMessageHandler);
    }

    return () => {
      this.eventListeners.delete(handler);
      if (this.eventListeners.size === 0 && this.debuggerMessageHandler) {
        dbg.removeListener('message', this.debuggerMessageHandler);
        this.debuggerMessageHandler = null;
      }
    };
  }

  async executeScript<T>(code: string): Promise<T> {
    return this.wc.executeJavaScript(code);
  }

  async loadURL(url: string): Promise<void> {
    await this.wc.loadURL(url);
  }

  getCurrentURL(): string {
    return this.wc.getURL();
  }

  async getTitle(): Promise<string> {
    return this.wc.getTitle();
  }

  async captureScreenshot(options?: ScreenshotOptions): Promise<Buffer> {
    const { fullPage = false, width, format = 'jpeg', quality } = options ?? {};
    const effectiveQuality = format === 'jpeg' ? (quality ?? 70) : undefined;

    const dbg = this.wc.debugger;
    if (!dbg) {
      const nativeImage = await this.wc.capturePage();
      return typeof nativeImage.toPNG === 'function' ? nativeImage.toPNG() : Buffer.from(nativeImage);
    }

    if (typeof dbg.isAttached === 'function' && !dbg.isAttached()) {
      await dbg.attach('1.3');
    }

    let needsRestore = false;
    try {
      if (width) {
        await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
          width,
          height: 0,
          deviceScaleFactor: 1,
          mobile: false,
        });
        needsRestore = true;
        await new Promise((r) => setTimeout(r, 150));
      }

      const result = await dbg.sendCommand('Page.captureScreenshot', {
        format,
        ...(effectiveQuality != null ? { quality: effectiveQuality } : {}),
        captureBeyondViewport: fullPage,
      });

      return Buffer.from(result.data, 'base64');
    } finally {
      if (needsRestore) {
        await dbg.sendCommand('Emulation.clearDeviceMetricsOverride').catch(() => {});
      }
    }
  }

  async detach(): Promise<void> {
    const dbg = this.wc.debugger;
    if (dbg && this.debuggerMessageHandler) {
      dbg.removeListener('message', this.debuggerMessageHandler);
      this.debuggerMessageHandler = null;
    }
    this.eventListeners.clear();

    if (dbg && typeof dbg.isAttached === 'function' && dbg.isAttached()) {
      try { dbg.detach(); } catch {}
    }
  }
}
