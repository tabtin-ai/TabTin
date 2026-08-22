import type { WebContentsScrapeOptions } from '../../types/options.js';

export interface WebContentsViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WebContentsViewOptions {
  id?: string;
  url?: string;
  title?: string;
  visible?: boolean;
  bounds?: WebContentsViewBounds;
  partition?: string;
  sessionMode?: 'inherit' | 'isolated' | 'temporary';
  userAgent?: string;
  reuseViewId?: string;
  keepAlive?: boolean;
  proxy?: import('../../types/options.js').ProxyConfig;
  metadata?: Record<string, unknown>;
}

export interface WebContentsViewHandle {
  id: string;
  reuse?: boolean;
  context?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface WebContentsNavigationOptions {
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';
  timeout?: number;
  waitForDynamic?: boolean;
  dynamicWaitTime?: number;
  extraHeaders?: Record<string, string>;
}

export interface WebContentsNavigationResult {
  url: string;
  finalUrl?: string;
  statusCode?: number;
  title?: string;
  timing?: {
    start: number;
    end: number;
    duration: number;
  };
  metadata?: Record<string, unknown>;
}

export interface WebContentsExecuteOptions {
  timeout?: number;
  world?: 'main' | 'isolated';
}

export interface WebContentsScreenshotOptions {
  format?: 'png' | 'jpeg';
  quality?: number;
  clip?: { x: number; y: number; width: number; height: number };
  omitBackground?: boolean;
}

export interface WebContentsSnapshotOptions {
  includeConsole?: boolean;
  includeNetwork?: boolean;
  includePerformance?: boolean;
  includeCookies?: boolean;
  screenshot?: boolean | WebContentsScreenshotOptions;
  additionalScripts?: string[];
  /**
   * 是否在快照结束后保留底层引擎资源（用于后续翻页）
   */
  keepEngineAlive?: boolean;
  /**
   * 是否强制确保存在 CDP 连接（即使当前已有快照页面）
   */
  ensureCDP?: boolean;
}

export interface WebContentsResourceAttachment {
  id: string;
  type: 'view' | 'connection' | string;
  metadata?: Record<string, unknown>;
}

export interface WebContentsAdapterInitOptions {
  maxConcurrency?: number;
  defaultWaitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';
  defaultTimeout?: number;
  enableNetworkTracking?: boolean;
  enableConsoleTracking?: boolean;
  enablePerformanceTracking?: boolean;
  [key: string]: unknown;
}

export interface WebContentsAdapterRuntimeInfo {
  runtime: string;
  version?: string;
}

export interface WebContentsAdapterResult {
  success: boolean;
  url: string;
  finalUrl?: string;
  statusCode: number;
  title?: string;
  html?: string;
  screenshot?: {
    data: string;
    mimeType: string;
    width?: number;
    height?: number;
  };
  cookies?: Array<{
    name: string;
    value: string;
    domain?: string;
    path?: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
  }>;
  timing: {
    start: number;
    end: number;
    duration: number;
  };
  timestamp: string;
  engineContext?: {
    windowId?: string | number;
    windowKind?: 'webcontents-view' | 'browser-window';
    connectionId?: string;
    url?: string;
  };
  pageMetadata?: {
    title?: string;
    meta?: Array<{ name?: string; property?: string; content?: string }>;
    links?: Array<{ rel?: string; href?: string; type?: string }>;
    scripts?: Array<{ src?: string; type?: string; async?: boolean; defer?: boolean }>;
    styles?: Array<{ href?: string; media?: string }>;
    images?: Array<{ src?: string; alt?: string; width?: number; height?: number }>;
    forms?: Array<{ action?: string; method?: string; id?: string }>;
    stats?: {
      textLength?: number;
      elementsCount?: number;
      linksCount?: number;
      imagesCount?: number;
      scriptsCount?: number;
    };
  };
  consoleMessages?: Array<{
    type: string;
    text: string;
    timestamp: number;
    location?: { url?: string; lineNumber?: number; columnNumber?: number };
  }>;
  networkRequests?: Array<{
    url: string;
    method: string;
    resourceType: string;
    headers?: Record<string, string>;
    postData?: string;
    timestamp: number;
  }>;
  networkResponses?: Array<{
    resourceId?: string;
    viewId?: string;
    url: string;
    status: number;
    statusText?: string;
    headers?: Record<string, string>;
    size?: number;
    mimeType?: string;
    category?: string;
    captureStatus?: string;
    contentKind?: 'data_url' | 'text' | 'file_path';
    timing?: Record<string, any>;
    body?: string;
    bodyPreview?: string;
  }>;
  performanceMetrics?: {
    domContentLoaded?: number;
    loadComplete?: number;
    firstPaint?: number;
    firstContentfulPaint?: number;
    /** Navigation Timing: responseStart - navigationStart（毫秒） */
    responseStart?: number;
    /** Navigation Timing: requestStart - navigationStart（毫秒） */
    requestStart?: number;
  };
  extraPayloads?: Array<{
    id: string;
    type: 'json' | 'text' | 'binary';
    data: string | Buffer;
    contentType?: string;
    description?: string;
  }>;
  error?: {
    message: string;
    code?: string;
    stack?: string;
  };
}

export interface IWebContentsAdapter {
  readonly name: string;
  readonly runtime: string;
  readonly version?: string;

  initialize?(options?: WebContentsAdapterInitOptions): Promise<void>;

  /**
   * 创建 WebContents 视图实例
   */
  createView?(options: WebContentsViewOptions): Promise<WebContentsViewHandle>;

  /**
   * 销毁 WebContents 视图实例
   */
  destroyView?(viewId: string, options?: { keepAlive?: boolean; reuse?: boolean }): Promise<void>;

  /**
   * 导航至指定 URL
   */
  navigate?(viewId: string, url: string, options?: WebContentsNavigationOptions): Promise<WebContentsNavigationResult>;

  /**
   * 在页面中执行脚本
   */
  executeScript?<T = unknown>(viewId: string, script: string, options?: WebContentsExecuteOptions): Promise<T>;

  /**
   * 捕获页面快照（HTML、网络、性能等数据）
   */
  captureSnapshot?(viewId: string, options?: WebContentsSnapshotOptions): Promise<WebContentsAdapterResult>;

  /**
   * 捕获页面截图
   */
  screenshot?(viewId: string, options?: WebContentsScreenshotOptions): Promise<Buffer>;

  /**
   * 将运行时资源（View / Connection 等）关联到任务，便于生命周期管理
   */
  attachResourcesToTask?(attachments: WebContentsResourceAttachment[], taskId: string): void;

  /**
   * 直接执行抓取（兼容旧实现）
   */
  scrape?(url: string, options: WebContentsScrapeOptions): Promise<WebContentsAdapterResult>;

  cleanup?(): Promise<void>;
  getRuntimeInfo?(): WebContentsAdapterRuntimeInfo;
}
