/**
 * DaemonBrowserContext — Patchright-based BrowserContext implementation
 *
 * 实现 L2 BrowserContext 接口，面向 browser-core 的统一抽象。
 * Daemon 环境下通过 Patchright Page + CDPSession 提供浏览器操作能力。
 */

import type { Page, CDPSession } from 'patchright-core';
import type { BrowserContext, ScreenshotOptions } from '@tabtin/browser-core';

export class DaemonBrowserContext implements BrowserContext {
  private page: Page;
  private cdpSession: CDPSession | null = null;
  private cdpSessionPromise: Promise<CDPSession> | null = null;
  private cachedTitle = '';
  private cdpEventHandlers = new Set<(ev: { method: string; params: Record<string, unknown> }) => void>();
  private cdpEventForwarderInstalled = false;

  constructor(page: Page) {
    this.page = page;
    page.on('domcontentloaded', () => {
      page.title().then(t => { this.cachedTitle = t; }).catch(() => {});
    });
  }

  async init(): Promise<void> {
    if (!this.page.isClosed()) {
      this.cachedTitle = await this.page.title().catch(() => '');
    }
  }

  isAlive(): boolean {
    return !this.page.isClosed();
  }

  async sendCDP<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T> {
    const session = await this.ensureCDPSession();
    return session.send(method as Parameters<CDPSession['send']>[0], params) as Promise<T>;
  }

  onCDPEvent(handler: (ev: { method: string; params: Record<string, unknown> }) => void): () => void {
    this.cdpEventHandlers.add(handler);
    this.installCDPEventForwarder();
    return () => {
      this.cdpEventHandlers.delete(handler);
    };
  }

  async executeScript<T>(code: string): Promise<T> {
    return this.page.evaluate(code) as Promise<T>;
  }

  async loadURL(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  }

  getCurrentURL(): string {
    return this.page.url();
  }

  async getTitle(): Promise<string> {
    if (this.page.isClosed()) return this.cachedTitle;
    try {
      return await this.page.title();
    } catch {
      return this.cachedTitle;
    }
  }

  async captureScreenshot(options?: ScreenshotOptions): Promise<Buffer> {
    const { fullPage = false, width, format = 'png', quality } = options ?? {};

    // 未指定 width 时走原有 page.screenshot 路径
    if (!width) {
      const buf = await this.page.screenshot({
        fullPage,
        type: format,
        ...(format === 'jpeg' ? { quality: quality ?? 80 } : {}),
      });
      return Buffer.from(buf);
    }

    // 指定 width 时通过 CDP 设置视口尺寸，确保与 SoM 坐标系一致
    let needsRestore = false;
    try {
      await this.sendCDP('Emulation.setDeviceMetricsOverride', {
        width,
        height: 0,
        deviceScaleFactor: 1,
        mobile: false,
      });
      needsRestore = true;
      await new Promise((r) => setTimeout(r, 150));

      const result = await this.sendCDP<{ data: string }>('Page.captureScreenshot', {
        format: format === 'jpeg' ? 'jpeg' : 'png',
        ...(format === 'jpeg' ? { quality: quality ?? 80 } : {}),
        captureBeyondViewport: fullPage,
      });
      return Buffer.from(result.data, 'base64');
    } finally {
      if (needsRestore) {
        await this.sendCDP('Emulation.clearDeviceMetricsOverride').catch(() => {});
      }
    }
  }

  async detach(): Promise<void> {
    this.cdpSessionPromise = null;
    if (this.cdpSession) {
      await this.cdpSession.detach().catch(() => {});
      this.cdpSession = null;
    }
    this.cdpEventHandlers.clear();
    this.cdpEventForwarderInstalled = false;
    this.cdpForwarderGeneration++;
  }

  getPage(): Page {
    return this.page;
  }

  /**
   * monkey-patch CDPSession.emit 拦截所有 CDP domain 事件（含 '.' 的事件名），
   * 转发给已注册的 handler。仅首次调用时安装。
   */
  private cdpForwarderGeneration = 0;

  private installCDPEventForwarder(): void {
    if (this.cdpEventForwarderInstalled) return;
    this.cdpEventForwarderInstalled = true;
    const gen = ++this.cdpForwarderGeneration;

    this.ensureCDPSession().then(session => {
      if (gen !== this.cdpForwarderGeneration) return;
      if (typeof (session as any).emit !== 'function') {
        console.warn('[DaemonBrowserContext] CDPSession.emit not available, CDP event forwarding disabled');
        return;
      }
      const originalEmit = (session as any).emit.bind(session);
      (session as any).emit = (event: string | symbol, ...args: unknown[]): boolean => {
        if (typeof event === 'string' && event.includes('.') && gen === this.cdpForwarderGeneration && this.cdpEventHandlers.size > 0) {
          const ev = { method: event, params: (args[0] ?? {}) as Record<string, unknown> };
          for (const h of this.cdpEventHandlers) {
            try { h(ev); } catch { /* handler error isolated */ }
          }
        }
        return originalEmit(event, ...args);
      };
    }).catch(err => {
      console.error('[DaemonBrowserContext] Failed to install CDP event forwarder:', err);
      if (gen === this.cdpForwarderGeneration) {
        this.cdpEventForwarderInstalled = false;
      }
    });
  }

  private async ensureCDPSession(): Promise<CDPSession> {
    if (this.cdpSession) return this.cdpSession;
    if (!this.cdpSessionPromise) {
      this.cdpSessionPromise = this.page.context().newCDPSession(this.page).then(session => {
        this.cdpSession = session;
        this.cdpSessionPromise = null;
        return session;
      }).catch(err => {
        this.cdpSessionPromise = null;
        throw err;
      });
    }
    return this.cdpSessionPromise;
  }
}
