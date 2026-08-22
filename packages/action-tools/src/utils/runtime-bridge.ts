import type {
  GetDetectedResourcesOutput,
  InspectResourceOutput,
  CaptureResourceOutput,
  DownloadResourceOutput,
  ParseM3U8Output,
  ParseStreamOutput,
} from '../types/resource-detection';
import type {
  TerminalAutoRespondRule,
  TerminalCapability,
  TerminalExecutionContext,
  TerminalExecutionPolicy,
  TerminalExecuteRequest,
  TerminalExecuteResponse,
  TerminalReadOutput,
  TerminalRuntimeBridge,
  TerminalSessionSummary,
  PtyManagerBridge,
} from '@tabtin/terminal-core';

type RunSessionAPI = {
  openTab?: (input: any) => Promise<any> | any;
  switchTab?: (input: any) => Promise<any> | any;
  closeTab?: (input: any) => Promise<any> | any;
  get?: (runId: string) => Promise<any> | any;
  addEvent?: (event: any) => Promise<any> | any;
};

type ViewFactoryAPI = {
  getViewState?: (viewId: string) => any;
  getCurrentViewId?: () => string | null;
};

type OrganizationTabManagerAPI = {
  getViewsByTab?: (crawlspaceId: string) => string[];
  getViewMetadata?: (viewId: string) => any;
};

type ViewStateRegistryAPI = {
  getState?: (viewId: string) => any;
};

type CrawlViewAPI = {
  executeScript?: (script: string, tabId?: string) => Promise<any>;
  getNavigationState?: (tabId?: string, options?: { includeHistory?: boolean }) => Promise<any> | any;
  goBack?: (tabId?: string) => Promise<any> | any;
  goForward?: (tabId?: string) => Promise<any> | any;
  reload?: (ignoreCache?: boolean, tabId?: string) => Promise<any> | any;
  stop?: (tabId?: string) => Promise<any> | any;
  loadUrl?: (tabId: string, url: string, options?: any) => Promise<any> | any;
  waitForTabReady?: (tabId: string, options?: { timeout?: number }) => Promise<any> | any;
  waitForSelector?: (tabId: string, options: any) => Promise<any> | any;
};

type ContextSpaceAPI = {
  listContextSpace?: (input: any) => Promise<any> | any;
  closeContextTab?: (input: any) => Promise<any> | any;
  setActiveContextTab?: (input: any) => Promise<any> | any;
  restoreContextGroup?: (input: any) => Promise<any> | any;
  assignPaneContent?: (input: any) => Promise<any> | any;
  splitPaneWithTab?: (input: any) => Promise<any> | any;
  movePane?: (input: any) => Promise<any> | any;
  dockPane?: (input: any) => Promise<any> | any;
  createWebTab?: (input: any) => Promise<any> | any;
};

// ==================== Resource Detection Bridge 类型 ====================

interface GetResourcesBridgeInput {
  viewId: string;
  category?: string;
  captureStatus?: string;
  capability?: string;
  limit?: number;
  probeMedia?: boolean;
  hideSegments?: boolean;
}

interface InspectResourceBridgeInput {
  resourceId: string;
  viewId?: string;
}

interface CaptureResourceBridgeInput {
  resourceId?: string;
  url?: string;
  viewId?: string;
  force?: boolean;
}

interface DownloadResourceBridgeInput {
  resourceId?: string;
  url?: string;
  filename?: string;
  headers?: Record<string, string>;
  viewId?: string;
}

interface ParseM3U8BridgeInput {
  resourceId?: string;
  url?: string;
  headers?: Record<string, string>;
  viewId?: string;
}

interface ParseStreamBridgeInput extends ParseM3U8BridgeInput {}

interface ProbeMediaBridgeResult {
  success: boolean;
  data?: {
    elements: Array<{
      tagName: string;
      currentSrc: string;
      sources: string[];
      videoWidth?: number;
      videoHeight?: number;
      duration?: number;
      usesMediaSource?: boolean;
      poster?: string;
      isPlaying?: boolean;
      isPaused?: boolean;
      currentTime?: number;
      buffered?: number;
      inferredCategory?: string;
    }>;
    pageUrl?: string;
    probeTimeMs?: number;
    error?: string;
  };
  error?: string;
}

interface DownloadStreamBridgeInput {
  resourceId?: string;
  url?: string;
  quality?: string;
  filename?: string;
  outputPath?: string;
  headers?: Record<string, string>;
  concurrency?: number;
  viewId?: string;
  signal?: AbortSignal;
}

interface StreamDownloadBridgeResult {
  success: boolean;
  downloadId: string;
  data?: {
    filePath: string;
    size: number;
    duration?: number;
    segmentCount: number;
    elapsedMs: number;
  };
  error?: string;
  errorCode?: string;
}

interface DownloadBatchBridgeInput {
  resourceIds?: string[];
  urls?: string[];
  headers?: Record<string, string>;
  concurrency?: number;
  viewId?: string;
}

interface DownloadBatchBridgeResult {
  success: boolean;
  data?: {
    total: number;
    succeeded: number;
    failed: number;
    results: Array<{
      url: string;
      success: boolean;
      data?: { filePath: string; size: number; mimeType: string };
      error?: string;
    }>;
  };
  error?: string;
}

type ResourceDetectionAPI = {
  getResources?: (input: GetResourcesBridgeInput) => GetDetectedResourcesOutput | Promise<GetDetectedResourcesOutput>;
  listResources?: (input: GetResourcesBridgeInput) => GetDetectedResourcesOutput | Promise<GetDetectedResourcesOutput>;
  inspectResource?: (input: InspectResourceBridgeInput) => Promise<InspectResourceOutput>;
  captureResource?: (input: CaptureResourceBridgeInput) => Promise<CaptureResourceOutput>;
  downloadResource?: (input: DownloadResourceBridgeInput) => Promise<DownloadResourceOutput>;
  downloadBatch?: (input: DownloadBatchBridgeInput) => Promise<DownloadBatchBridgeResult>;
  parseM3U8?: (input: ParseM3U8BridgeInput) => Promise<ParseM3U8Output>;
  parseStream?: (input: ParseStreamBridgeInput) => Promise<ParseStreamOutput>;
  probeMedia?: (input: { viewId: string }) => Promise<ProbeMediaBridgeResult>;
  downloadStream?: (input: DownloadStreamBridgeInput) => Promise<StreamDownloadBridgeResult>;
};

// ==================== Browser Environment Bridge ====================
//
// 用途：把 Space ↔ BrowserEnvironment partition 的同步查询能力从主进程的
// `BrowserEnvironmentService` 暴露给 action-tools 侧，让 `open_tab` 在 Agent
// 场景下按 Space 绑定的登录环境选择 partition，而不是硬编码 crawlspace 系列。
//
// 注入语义：
// - Electron 主进程在 `bridge-core.ts` 里用
//   `BrowserEnvironmentService.getPartitionForSpace(spaceId)` 实现并注入；
//   返回 `string`（partition key，不含 `persist:` 前缀）。
// - Daemon 无 Electron partition 语义，**不注入** → action-tools 自动降级到
//   后续的 fallback 链。
// - 测试可注入 mock 实现，覆盖 partition 切换场景。
//
// 契约（本地化退役 Wave 2 之后）：`getPartitionForSpace` 永不抛、永远立即返
// 回真实 partition（显式绑定 / 默认环境）。不再有 pending 占位概念——主进程
// BES 同步立即可用，没有"bootstrap 未就绪"的过渡态。

export type BrowserEnvAPI = {
  /**
   * 查询 Space 应使用的 partition（**不带** `persist:` 前缀）。
   *
   * 返回值语义：
   * - 宿主已接入 → 返回真实 env partition `string`（显式绑定 / 默认环境）。
   * - 未接入（Daemon / 旧宿主 / 测试无 mock）/ 输入非法 → 返回 `null | undefined`，
   *   调用方按 fallback 链继续。
   *
   * 永不抛：宿主异常时返回 null/undefined，由调用方 fallback。
   *
   * 必须是同步：`open_tab` 工具在 Electron 主进程执行时已有完整的 Service
   * 实例，同步读内存快照；若切异步会拖慢每个 Agent tab 打开几十到几百毫秒。
   */
  getPartitionForSpace?: (spaceId: string) => string | null | undefined;
};

// ==================== 注入实例 ====================

let injectedRunSession: RunSessionAPI | null = null;
let injectedViewFactory: ViewFactoryAPI | null = null;
let injectedOrganizationTabManager: OrganizationTabManagerAPI | null = null;
let injectedViewStateRegistry: ViewStateRegistryAPI | null = null;
let injectedCrawlView: CrawlViewAPI | null = null;
let injectedContextSpace: ContextSpaceAPI | null = null;
let injectedResourceDetection: ResourceDetectionAPI | null = null;
let injectedBrowserEnv: BrowserEnvAPI | null = null;

export function setRunSessionAPI(api: RunSessionAPI | null): void {
  injectedRunSession = api;
}

export function setViewFactoryAPI(api: ViewFactoryAPI | null): void {
  injectedViewFactory = api;
}

export function setOrganizationTabManagerAPI(api: OrganizationTabManagerAPI | null): void {
  injectedOrganizationTabManager = api;
}

export function setViewStateRegistryAPI(api: ViewStateRegistryAPI | null): void {
  injectedViewStateRegistry = api;
}

export function setCrawlViewAPI(api: CrawlViewAPI | null): void {
  injectedCrawlView = api;
}

export function setContextSpaceAPI(api: ContextSpaceAPI | null): void {
  injectedContextSpace = api;
}

export function resolveRunSessionAPI(): RunSessionAPI | null {
  if (injectedRunSession) return injectedRunSession;
  const tabtin = (global as any).tabtin || (typeof window !== 'undefined' ? (window as any).tabtin : null);
  const runSession = tabtin?.runSession || tabtin?.api?.runSession;
  return runSession || null;
}

export function resolveViewFactoryAPI(): ViewFactoryAPI | null {
  return injectedViewFactory;
}

export function resolveOrganizationTabManagerAPI(): OrganizationTabManagerAPI | null {
  return injectedOrganizationTabManager;
}

export function resolveViewStateRegistryAPI(): ViewStateRegistryAPI | null {
  return injectedViewStateRegistry;
}

export function resolveCrawlViewAPI(): CrawlViewAPI | null {
  if (injectedCrawlView) return injectedCrawlView;
  const tabtin = (global as any).tabtin || (typeof window !== 'undefined' ? (window as any).tabtin : null);
  const crawlView = tabtin?.crawlView || tabtin?.api?.crawlView;
  return crawlView || null;
}

export function resolveContextSpaceAPI(): ContextSpaceAPI | null {
  return injectedContextSpace;
}

export function setResourceDetectionAPI(api: ResourceDetectionAPI | null): void {
  injectedResourceDetection = api;
}

export function resolveResourceDetectionAPI(): ResourceDetectionAPI | null {
  return injectedResourceDetection;
}

export function setBrowserEnvAPI(api: BrowserEnvAPI | null): void {
  injectedBrowserEnv = api;
}

export function resolveBrowserEnvAPI(): BrowserEnvAPI | null {
  return injectedBrowserEnv;
}

// ==================== Screenshot Bridge ====================

type ScreenshotAPI = {
  capture?: (options: {
    target?: 'window' | 'view' | 'screen';
    viewId?: string;
    displayId?: string | number;
    format?: 'png' | 'jpeg';
    quality?: number;
    savePath?: string;
    includeBase64?: boolean;
    fullPage?: boolean;
  }) => Promise<{
    success: boolean;
    path?: string;
    width?: number;
    height?: number;
    format?: string;
    sizeBytes?: number;
    base64?: string;
    base64_degraded?: boolean;
    base64_format?: string;
    scaleFactor?: number;
    error?: string;
  }>;
};

let injectedScreenshot: ScreenshotAPI | null = null;

export function setScreenshotAPI(api: ScreenshotAPI | null): void {
  injectedScreenshot = api;
}

export function resolveScreenshotAPI(): ScreenshotAPI | null {
  return injectedScreenshot;
}

// ==================== Offscreen Render Bridge（Widget Wave 4） ====================
//
// **抽象边界**（widget RFC §四 4.2 + §五 4.1 决策 6/v2）：
//
// `OffscreenRenderAPI` 与 `ScreenshotAPI` 是**两个独立抽象**，不要塞进同一接口：
//   - `ScreenshotAPI.capture` 截**已存在**的 view / window / screen（target enum），
//     接收 viewId / displayId 等"找到目标"的参数，不接收源代码。
//   - `OffscreenRenderAPI.renderToImage` 接收**源代码字符串**（widget code / SVG /
//     未来的 HTML / Mermaid），在隔离的离屏 surface 渲染后烤成图片，是
//     "代码 → 图片" 的纯函数语义；调用方不持有/不感知任何 view 句柄。
//
// **下游消费者（约定不画空头支票）**：
//   - Widget Wave 4：`show_widget` 工具 execute 时调 `renderToImage` 烤 SVG
//   - 未来：TabSlide 前端导出（如团队愿意从 html2canvas 迁过来）、TabDoc PDF
//     导出。**6 个月内无第二个用户视为过度工程，需复盘**（widget RFC §七）
//
// **跨宿主实现**（widget RFC §五 4.1 表）：
//   - Electron：`apps/tabtin-electron/src/main/services/WidgetRenderService.ts`
//     从 `OffscreenWindowPool` 拿隐藏离屏 BrowserWindow → loadFile 临时 wrapper
//     HTML → `await document.fonts.ready` → `capturePage` 或 CDP screenshot
//   - Daemon：`apps/tabtin-daemon/src/browser/DaemonBrowserService.ts.captureWidget`
//     `browser.newPage()` → `page.setContent(wrapper)` → 字体等待 → `page.screenshot()`
//   - Headless 测试：注入 mock 实现，断言被调用次数 / 入参 / 返回 buffer
//
// **永不抛**：实现内异常时返回 `{ success: false, error }`——这样工具层
// `await renderToImage(...)` 用 try 而不必 catch，简化错误传播。

export type OffscreenRenderFormat = 'svg' | 'html' | 'mermaid';

export type OffscreenRenderViewport = {
  /** 渲染容器宽（px）。默认 680（widget RFC §四 4.2 wrapper 模板）。 */
  width?: number;
  /** 渲染容器高（px）。默认 400。 */
  height?: number;
  /** 设备像素比。默认 2（视网膜屏一致清晰度）。 */
  deviceScaleFactor?: number;
};

export type OffscreenRenderTheme = 'light' | 'dark';

export type OffscreenRenderInput = {
  /** widget 源代码（SVG / HTML / Mermaid 编译后的 SVG）。 */
  code: string;
  /** 源代码格式。Wave 4 仅 'svg'，HTML/Mermaid 由 Wave 6 解锁。 */
  format: OffscreenRenderFormat;
  /** 渲染容器尺寸 + DPR。 */
  viewport?: OffscreenRenderViewport;
  /** 主题。决定 wrapper 注入的 design token 是 light 还是 dark 块。 */
  theme?: OffscreenRenderTheme;
};

export type OffscreenRenderResult = {
  success: boolean;
  /** 成功时携带 PNG buffer（Node Buffer 或 Uint8Array），调用方再上传 OSS。 */
  buffer?: Uint8Array;
  /** 烤图最终宽（含 DPR 放大后的实际像素，可选诊断字段）。 */
  width?: number;
  height?: number;
  /** 失败时的人类可读原因。永远填一个非空字符串便于追踪。 */
  error?: string;
};

export type OffscreenRenderAPI = {
  /**
   * 把 widget 源代码烤成 PNG buffer。
   *
   * **契约**：
   *   - 永不抛：内部异常 → `{ success: false, error: 'message' }`
   *   - 同步注入异步执行：宿主在 startup 时 `setOffscreenRenderAPI({...})` 注入；
   *     `show-widget.ts` 在 execute 时 `resolveOffscreenRenderAPI()?.renderToImage(...)`。
   *   - 单次烤图典型 200ms-2s（含 BrowserWindow 创建 + fonts.ready 等待 + capturePage）。
   *   - 失败兜底：实现层应至少尝试一次 retry（字体加载竞态）；超 3 次仍失败返回 error。
   *
   * **不在此 API 范围**：
   *   - OSS 上传——由调用方（`show-widget.ts`）拿到 buffer 后调
   *     `uploadFileToOSS(filePath)` 自行上传，便于复用 `globalThis.tabtin` 注入。
   *   - 写盘——`renderToImage` 直接返回内存 buffer，不落临时文件。Daemon /
   *     Electron 上传层自己决定要不要先写 tmp 文件再上传 OSS（因为
   *     `uploadFileToOSS` 当前 API 接收文件路径）。
   */
  renderToImage?: (input: OffscreenRenderInput) => Promise<OffscreenRenderResult>;
};

let injectedOffscreenRender: OffscreenRenderAPI | null = null;

export function setOffscreenRenderAPI(api: OffscreenRenderAPI | null): void {
  injectedOffscreenRender = api;
}

export function resolveOffscreenRenderAPI(): OffscreenRenderAPI | null {
  return injectedOffscreenRender;
}

// ==================== UI Theme Bridge（Widget Wave 7 补丁） ====================
//
// **为什么需要**：Widget Wave 4 烤图链路里 `renderToImage({ code, format, viewport, theme })`
// 已经有 `theme` 参数，但 `show-widget/bake-upload.ts` 调用处**没传** theme —— 链路一路走
// 默认 `'light'`。用户 dark mode 下，desktop chat 里的 widget 显示 dark（因为
// `RichWidget` 读 `useIsDarkMode()`），但移动端从 OSS 拉到的烤图永远是 light，跨端
// 视觉分裂。
//
// **方案（runtime bridge 注入，非 schema 字段）**：
//   - 优点 1：theme 是呈现层细节，不该让 LLM 决策——LLM 不应关心用户 OS/App 颜色主题
//   - 优点 2：Daemon 模式没 UI theme，`resolveUITheme()` 返回 null，bake-upload.ts
//     fallback 到 `'light'`，与当前行为字面一致不引入回归
//   - 优点 3：renderer 侧 `useIsDarkMode` 监听 DOM class 变化时 fire `tabtin.uiTheme.report()`，
//     main 进程 `ipcMain` handler 更新本地变量——一条轻量的"renderer → main"单向流。
//
// **与其他 API 对齐**：接口命名 + set/resolve pattern 与 OffscreenRenderAPI / ScreenshotAPI
// 字面等价。下游消费者 `show-widget/bake-upload.ts` 在 execute 时 `resolveUITheme() ?? 'light'`
// 得到当前值，传给 `offscreen.renderToImage({ theme })`。

export type UITheme = 'light' | 'dark';

export type UIThemeAPI = {
  /**
   * 返回宿主 UI 当前 theme。Daemon / headless 测试环境没有 UI 时应返回 `null`，
   * 调用方（show-widget/bake-upload.ts）会 fallback 到 `'light'`——这与 Wave 4
   * 上线的默认行为字面一致，保证 Daemon 不引入回归。
   */
  getCurrentTheme?: () => UITheme | null;
};

let injectedUITheme: UIThemeAPI | null = null;

export function setUIThemeAPI(api: UIThemeAPI | null): void {
  injectedUITheme = api;
}

/**
 * 解析当前 UI theme。Daemon / headless / 未注入 → 返回 null，调用方按默认处理。
 *
 * 契约：
 *   - 永不抛（内部 getter 抛异常也吞下）
 *   - 返回值一定是 'light' / 'dark' / null 之一
 */
export function resolveUITheme(): UITheme | null {
  const getter = injectedUITheme?.getCurrentTheme;
  if (typeof getter !== 'function') return null;
  try {
    const value = getter();
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

// ==================== CDP Screenshot Bridge ====================

type CDPScreenshotAPI = {
  capture?: (webContents: any, options: {
    fullPage?: boolean;
    width?: number;
    format?: 'png' | 'jpeg';
    quality?: number;
  }) => Promise<Buffer>;
};

let injectedCDPScreenshot: CDPScreenshotAPI | null = null;

export function setCDPScreenshotAPI(api: CDPScreenshotAPI | null): void {
  injectedCDPScreenshot = api;
}

export function resolveCDPScreenshotAPI(): CDPScreenshotAPI | null {
  return injectedCDPScreenshot;
}

// ==================== PDF Bridge ====================

export type PdfAPI = {
  generate?: (options: {
    viewId: string;
    landscape?: boolean;
    printBackground?: boolean;
    pageSize?: string;
    margins?: { top?: number; bottom?: number; left?: number; right?: number };
    savePath?: string;
  }) => Promise<{
    success: boolean;
    path?: string;
    sizeBytes?: number;
    pageCount?: number;
    error?: string;
  }>;
};

let injectedPdf: PdfAPI | null = null;

export function setPdfAPI(api: PdfAPI | null): void {
  injectedPdf = api;
}

export function resolvePdfAPI(): PdfAPI | null {
  return injectedPdf;
}

// ==================== Page-to-Markdown Bridge ====================

export type PageToMarkdownAPI = {
  convert?: (options: {
    viewId?: string;
    url?: string;
    includeLinks?: boolean;
    includeImages?: boolean;
  }) => Promise<{
    success: boolean;
    markdown?: string;
    title?: string;
    url?: string;
    wordCount?: number;
    error?: string;
  }>;
};

let injectedPageToMarkdown: PageToMarkdownAPI | null = null;

export function setPageToMarkdownAPI(api: PageToMarkdownAPI | null): void {
  injectedPageToMarkdown = api;
}

export function resolvePageToMarkdownAPI(): PageToMarkdownAPI | null {
  return injectedPageToMarkdown;
}

// ==================== PTY Manager Bridge ====================

export type PtyManagerAPI = {
  readOutput?: (sessionId: string, options?: { tail?: number }) => TerminalReadOutput | null;
  listWithStatus?: (spaceId?: string) => TerminalSessionSummary[];
  executeCommand?: (
    sessionId: string,
    command: string,
    options?: {
      blockUntilMs?: number;
      workingDirectory?: string;
      env?: Record<string, string>;
      context?: TerminalExecutionContext;
      policy?: TerminalExecutionPolicy;
      autoRespond?: TerminalAutoRespondRule[];
      killOnTimeout?: boolean;
      _degradationDecision?: TerminalExecuteRequest['_degradationDecision'];
    },
  ) => Promise<TerminalExecuteResponse & { sessionId: string }>;
  spawnAgentSession?: (spaceId: string, options?: { cwd?: string; threadId?: string }) => string | null;
  getOrSpawnAgentSession?: (threadId: string, spaceId: string, options?: { cwd?: string }) => string | null;
  resolveThreadSession?: (threadId: string) => string | null;
  write?: (sessionId: string, data: string) => boolean;
};

const derivePtyManagerCapabilities = (api: PtyManagerAPI): TerminalCapability[] => {
  const capabilities = new Set<TerminalCapability>();
  if (api.executeCommand) capabilities.add('execute');
  if (api.readOutput) capabilities.add('session_read');
  if (api.write) capabilities.add('session_write');
  if (api.listWithStatus) capabilities.add('session_list');
  if (api.executeCommand || api.readOutput || api.write || api.listWithStatus) {
    capabilities.add('interactive');
  }
  return Array.from(capabilities);
};

const adaptPtyManagerAPI = (api: PtyManagerAPI | null): TerminalRuntimeBridge | null => {
  if (!api) return null;

  return {
    getCapabilities: () => derivePtyManagerCapabilities(api),
    execute: async (request: TerminalExecuteRequest): Promise<TerminalExecuteResponse> => {
      const command = request.command?.trim();
      if (!command) {
        throw new Error('command is required');
      }
      if (!api.executeCommand) {
        throw new Error('PTY executeCommand API not available');
      }

      let sessionId = request.sessionId;
      if (!sessionId) {
        const spaceId = request.context?.spaceId || 'default';
        const cwd = request.context?.workingDirectory || request.context?.workspaceRoot;
        const threadId = request.context?.threadId;

        if (threadId && api.getOrSpawnAgentSession) {
          sessionId = api.getOrSpawnAgentSession(threadId, spaceId, cwd ? { cwd } : undefined) ?? undefined;
        } else if (api.spawnAgentSession) {
          sessionId = api.spawnAgentSession(spaceId, cwd ? { cwd } : undefined) ?? undefined;
        } else {
          throw new Error('PTY spawnAgentSession API not available');
        }

        if (!sessionId) {
          throw new Error('Failed to create agent terminal session (max sessions reached?)');
        }
      }

      return api.executeCommand(sessionId, command, {
        blockUntilMs: request.blockUntilMs,
        workingDirectory: request.context?.workingDirectory,
        env: request.context?.env,
        context: request.context,
        policy: request.policy,
        autoRespond: request.autoRespond,
        killOnTimeout: request.killOnTimeout,
        _degradationDecision: request._degradationDecision,
      });
    },
    readOutput: api.readOutput
      ? (sessionId, options) => api.readOutput?.(sessionId, options) ?? null
      : undefined,
    listSessions: api.listWithStatus
      ? (scope) => {
          const capabilities = derivePtyManagerCapabilities(api);
          return api.listWithStatus?.(scope?.spaceId).map((session) => ({
            ...session,
            capabilityFlags: session.capabilityFlags ?? capabilities,
          })) ?? [];
        }
      : undefined,
    write: api.write
      ? (sessionId, data) => api.write?.(sessionId, data) ?? false
      : undefined,
    resolveThreadSession: api.resolveThreadSession
      ? (threadId) => api.resolveThreadSession?.(threadId) ?? null
      : undefined,
  };
};

let injectedTerminalRuntimeBridge: TerminalRuntimeBridge | null = null;
let injectedPtyManager: PtyManagerAPI | null = null;

export function setTerminalRuntimeBridge(api: TerminalRuntimeBridge | null): void {
  injectedTerminalRuntimeBridge = api;
}

export function setPtyManagerAPI(api: PtyManagerAPI | null): void {
  injectedPtyManager = api;
}

export function resolveTerminalRuntimeBridge(): TerminalRuntimeBridge | null {
  if (injectedTerminalRuntimeBridge) return injectedTerminalRuntimeBridge;
  return adaptPtyManagerAPI(injectedPtyManager);
}

export function resolvePtyManagerAPI(): PtyManagerAPI | null {
  return injectedPtyManager;
}

// ==================== PtyManagerBridge（Agent / 本地 LLM 路径） ====================
//
// **为什么需要独立第二套**：
//
// 上面的 `PtyManagerAPI` / `TerminalRuntimeBridge` 是 **4 件套（人控）**面用的：
// list / read / write / execute——下游消费者是 action-bridge / runtimes /
// future MCP / 4 件套等枚举型工具。
//
// 本地 LLM 走 ShellCap 的路径有**截然不同的契约**（见
// `packages/terminal-core/src/agent-bridge.ts` JSDoc）：每条命令必须新建
// 独立 PTY session（D3）、必须携带 agentMeta 做溯源、必须 emit
// `agent-session-created` 事件让 UI（WP3）能渲染新 tab、需要明确的 5 方法
// 语义。强行塞进 PtyManagerAPI 会破坏 4 件套调用方的契约稳定性。
//
// 因此保留两套独立的 set/resolve 入口：
//   - `setPtyManagerAPI` / `resolvePtyManagerAPI`：4 件套用，**保持原状**
//   - `setPtyManagerBridge` / `resolvePtyManagerBridge`：本地 LLM ShellCap 用
//
// 两套互不依赖、互不污染。Electron / Daemon 在 bootstrap 时都注入两个，
// 但具体实现可以共享底层 PtyManager 实例（WP2 包一层 implements 适配）。
//
// **不为远端 / 跨设备超前抽象**（D9）：本注入面也只服务"本机两端等价"。

let injectedPtyManagerBridge: PtyManagerBridge | null = null;

/**
 * 注入本机 `PtyManagerBridge` 实现。
 *
 * **典型注入点**（agent-bridge.ts JSDoc L544-545 硬约束顺序）：
 *   `PtyManager.ready()` → `setPtyManagerBridge()` → assemble ShellCap
 *
 *   - Electron：bootstrap 装配方调用 `getOrCreateElectronPtyManagerBridge()`
 *     拿到 bridge 实例，在 ElectronToolProvider 装配 ShellCap 前调本方法
 *   - Daemon：bootstrap 装配方从 `TabTinDaemon.getPtyManagerBridge()` 取
 *     实例，同上时序
 *   - 测试：单测可注入 mock 实现 / `unimplementedPtyManagerBridge`
 *
 * **置 `null`** 用于卸载（测试 teardown / 进程关闭）。
 */
export function setPtyManagerBridge(bridge: PtyManagerBridge | null): void {
  injectedPtyManagerBridge = bridge;
}

/**
 * 解析当前注入的 `PtyManagerBridge`。
 *
 * **返回 `null` 的语义**：宿主未注入。调用方（ShellCap 装配处）应当
 * **fail-fast 拒绝构造**而非 fallback 到 spawn——这是 D6 决策（不留
 * 兼容性兜底）。如果宿主注入了 `unimplementedPtyManagerBridge` 桩，
 * 本方法返回的是该桩；首次调用某方法时会 throw 明确错误。
 *
 * **不会自动 fallback** 到 `injectedPtyManager`（4 件套）的接口形态——
 * 两套语义不同，不能互相替代。
 */
export function resolvePtyManagerBridge(): PtyManagerBridge | null {
  return injectedPtyManagerBridge;
}

// W6 (2026-05-04): the TabSlide runtime bridge (setTabSlideAPI /
// resolveTabSlideAPI / TabSlideAPI type) was removed together with the
// `tabslide` AgentTool group. Slide operations now flow through Django
// REST endpoints via the `tabtin slide *` CLI directly.

// ==================== HTTP Crawl Bridge ====================

export type HttpCrawlAPI = {
  fetch?: (options: {
    url: string;
    timeout?: number;
    headers?: Record<string, string>;
    respectRobots?: boolean;
  }) => Promise<{
    success: boolean;
    data?: {
      url: string;
      title: string;
      content: string;
      content_type: string;
      status_code: number;
      response_time_ms: number;
    };
    error?: string;
  }>;
};

let injectedHttpCrawl: HttpCrawlAPI | null = null;

export function setHttpCrawlAPI(api: HttpCrawlAPI | null): void {
  injectedHttpCrawl = api;
}

export function resolveHttpCrawlAPI(): HttpCrawlAPI | null {
  return injectedHttpCrawl;
}

// ==================== TableKernel Bridge ====================

interface CommandResultLike {
  success: boolean;
  data?: unknown;
  errors: Array<{ code: string; message: string }>;
}

export type TableKernelAPI = {
  listTables: (input: { spaceId?: string }) => Promise<Record<string, unknown>>;
  getTableSchema: (tableId: string) => Promise<Record<string, unknown>>;
  queryRecords: (input: {
    tableId: string;
    filters?: unknown;
    sorts?: unknown;
    page?: number;
    pageSize?: number;
    fieldKeyType?: string;
  }) => Promise<Record<string, unknown>>;
  createRecord: (input: { tableId: string; data: Record<string, unknown> }) => Promise<CommandResultLike>;
  updateRecord: (input: {
    tableId: string;
    recordId: string;
    data: Record<string, unknown>;
  }) => Promise<CommandResultLike>;
  deleteRecord: (input: { tableId: string; recordId: string }) => Promise<CommandResultLike>;
};

let injectedTableKernel: TableKernelAPI | null = null;

export function setTableKernelAPI(api: TableKernelAPI | null): void {
  injectedTableKernel = api;
}

export function resolveTableKernelAPI(): TableKernelAPI | null {
  return injectedTableKernel;
}
