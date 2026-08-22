/**
 * BrowserCoreBridge — browser-core 运行时桥接层
 *
 * 提供 cdpScreenshot、viewFactory 和 htmlCleaner 三个注入点，
 * 由宿主环境（Electron 主进程 / action-tools）通过 setBrowserCoreBridge() 注入实现。
 */

export type CDPScreenshotAPI = {
  capture?: (webContents: any, options: {
    fullPage?: boolean;
    width?: number;
    format?: 'png' | 'jpeg';
    quality?: number;
  }) => Promise<Buffer>;
};

export type ViewFactoryAPI = {
  getViewState?: (viewId: string) => any;
  getCurrentViewId?: () => string | null;
};

export type HtmlCleanerAPI = {
  cleanHtml: (rawHtml: string) => string;
  generateSkeletonHtml: (cleanedHtml: string) => string;
  /**
   * 按内容类型白名单过滤 HTML（browser --include）：剥掉不在白名单里的类型。
   * `includeTypes` 为规范化类型名数组（空数组 = 全部剥离）。可选：宿主未注入时 snapshot 跳过过滤。
   */
  filterHtmlByContentTypes?: (html: string, includeTypes: string[]) => string;
};

export interface BrowserCoreBridge {
  cdpScreenshot: CDPScreenshotAPI | null;
  viewFactory: ViewFactoryAPI | null;
  htmlCleaner: HtmlCleanerAPI | null;
}

const bridge: BrowserCoreBridge = {
  cdpScreenshot: null,
  viewFactory: null,
  htmlCleaner: null,
};

export function setBrowserCoreBridge(b: Partial<BrowserCoreBridge>): void {
  if (b.cdpScreenshot !== undefined) bridge.cdpScreenshot = b.cdpScreenshot;
  if (b.viewFactory !== undefined) bridge.viewFactory = b.viewFactory;
  if (b.htmlCleaner !== undefined) bridge.htmlCleaner = b.htmlCleaner;
}

export function resolveCDPScreenshotAPI(): CDPScreenshotAPI | null {
  return bridge.cdpScreenshot;
}

export function resolveViewFactoryAPI(): ViewFactoryAPI | null {
  return bridge.viewFactory;
}

export function resolveHtmlCleanerAPI(): HtmlCleanerAPI | null {
  return bridge.htmlCleaner;
}
