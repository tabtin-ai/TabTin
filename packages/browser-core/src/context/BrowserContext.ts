export interface ScreenshotOptions {
  fullPage?: boolean;
  width?: number;
  format?: 'png' | 'jpeg';
  quality?: number;
}

/**
 * L2 unified browser context abstraction.
 *
 * Electron implements via WebContents + debugger API,
 * Daemon implements via Playwright Page + CDPSession.
 * All browser-core operations program against this interface only.
 */
export interface BrowserContext {
  isAlive(): boolean;
  sendCDP<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>;
  onCDPEvent(handler: (ev: { method: string; params: Record<string, unknown> }) => void): () => void;
  listChildFrameIds?(): string[];
  executeScript<T>(code: string, frameId?: string): Promise<T>;
  loadURL(url: string): Promise<void>;
  getCurrentURL(): string;
  getTitle(): Promise<string>;
  captureScreenshot(options?: ScreenshotOptions): Promise<Buffer>;
  detach(): Promise<void>;
}
