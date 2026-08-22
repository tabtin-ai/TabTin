/**
 * DaemonBrowserService — Patchright-based headless browser for Daemon.
 *
 * Provides the same core browser primitives that Electron offers via
 * WebContentsView, but backed by patchright-core (stealth-patched Chromium)
 * connecting to a system-installed Chrome.
 *
 * Features:
 * - Lazy browser initialization (only launched on first use)
 * - Multi-tab page pool (keyed by tabId, with active-tab tracking)
 * - Idle page eviction (configurable timeout)
 * - action-tools runtime bridge injection (setCrawlViewAPI etc.)
 */

import { existsSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, resolve, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { getHomeTabtinPath } from '@tabtin/shared/storage-paths';
import { EventEmitter } from 'node:events';

import type { Logger } from '../observability/logging/logger.js';
import { DaemonBrowserContext } from './context/DaemonBrowserContext.js';
import { applyStealthArgs } from '@tabtin/anti-detect';
import { PromiseMutex } from '../../base/async/promise-mutex.js';
import { isPrivateHost, validateUrl } from '@tabtin/security-policy';
import { isBlockedScript } from '@tabtin/browser-core/url-policy';
import { attachRuntimeLogCapture } from '@tabtin/browser-core';
import type {
  NetworkLog,
  ConsoleLog,
  NetworkLogQuery,
  NetworkLogEntry,
  ConsoleLogQuery,
  ConsoleLogEntry,
} from '@tabtin/browser-core';
import type { ResourceEntry } from './ResourceTracker.js';
import type { RecordingManager } from './RecordingSession.js';

// DOM 稳定判定参数：连续 QUIET_MS 无 DOM 结构变更视为内容就绪；MAX_MS 为 settle 观察上限，
// 超过则返回 unsettled_timeout。口径须与 Electron content-ops.ts、
// packages/browser-core/src/base/types/dom-settle.ts 的同名常量一致（三处运行时不同、无法共用一份实现）。
const DAEMON_DOM_SETTLE_QUIET_MS = 500;
const DAEMON_DOM_SETTLE_MAX_MS = 10000;

/**
 * 在 Patchright page 上下文里用原生 MutationObserver 观察 DOM 是否稳定。
 * 连续 quietMs 无结构性变更判定 settled；到达 maxWaitMs 仍在变化返回 false。best-effort，不抛错。
 */
async function waitForDomSettle(
  page: import('patchright-core').Page,
  quietMs: number,
  maxWaitMs: number,
): Promise<boolean> {
  const settleArgs: [number, number] = [quietMs, maxWaitMs];
  try {
    const settled = await page.evaluate(
      ([quiet, maxWait]: [number, number]) =>
        new Promise<boolean>((resolve) => {
          try {
            let quietTimer: ReturnType<typeof setTimeout> | null = null;
            let done = false;
            const finish = (value: boolean) => {
              if (done) return;
              done = true;
              try { observer.disconnect(); } catch { /* noop */ }
              if (quietTimer) clearTimeout(quietTimer);
              resolve(value);
            };
            // 每次 DOM 变更都重置安静计时器：只有完整 quiet ms 无变更才判定 settled(true)；
            // 到达 maxWait 硬上限仍未安静则判定 unsettled(false)。
            const schedule = () => {
              if (quietTimer) clearTimeout(quietTimer);
              quietTimer = setTimeout(() => finish(true), quiet);
            };
            const observer = new MutationObserver(() => schedule());
            const root = document.documentElement || document.body;
            if (!root) { resolve(false); return; }
            observer.observe(root, { childList: true, subtree: true, attributes: false, characterData: false });
            setTimeout(() => finish(false), maxWait);
            schedule();
          } catch {
            resolve(false);
          }
        }),
      settleArgs,
    );
    return Boolean(settled);
  } catch {
    return false;
  }
}

/**
 * 构建 Patchright BrowserContext 的默认配置。
 * 统一管理行为伪装参数，避免三处 newContext 各自硬编码。
 */
function buildDefaultContextOptions(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    viewport: { width: 1280, height: 720 },
    colorScheme: 'dark',
    deviceScaleFactor: 2,
    permissions: ['geolocation', 'notifications'],
    ...overrides,
  };
}

// ── Chrome / Chromium detection ──────────────────────────────────

const CHROME_PATHS: Record<string, string[]> = {
  linux: [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
};

function findChromePath(): string | undefined {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const candidates = CHROME_PATHS[process.platform] ?? [];
  return candidates.find((p) => existsSync(p));
}

// ── URL / Path Validation ────────────────────────────────────────
// SSRF 防护统一由 @tabtin/security-policy 提供，此处 re-export 保持外部引用兼容
export { isPrivateHost, validateUrl };

export function validateSavePath(savePath: string, workspaceRoot?: string): void {
  const resolved = normalize(resolve(savePath));
  const allowedPrefixes = [
    normalize(resolve(getHomeTabtinPath())),
    normalize(tmpdir()),
    normalize(resolve(process.cwd())),
  ];
  if (workspaceRoot) {
    allowedPrefixes.push(normalize(resolve(workspaceRoot)));
  }

  const isAllowed = allowedPrefixes.some(
    (prefix) => resolved === prefix || resolved.startsWith(prefix + '/'),
  );

  if (!isAllowed) {
    throw new Error(
      `savePath 不在允许的目录范围内: ${savePath}。` +
      `允许: workspace 目录、~/.tabtin/、系统临时目录`,
    );
  }
}

// ── Constants ────────────────────────────────────────────────────

const MAX_PAGES = 10;
const PAGE_IDLE_MS = 5 * 60_000;
const ACTIVE_TAB_IDLE_MS = 30 * 60_000;
const SCREENSHOTS_DIR = getHomeTabtinPath('screenshots');
const EXPORTS_DIR = getHomeTabtinPath('exports');

// ── Types ────────────────────────────────────────────────────────

interface PageEntry {
  page: import('patchright-core').Page;
  ownContext: import('patchright-core').BrowserContext | null;
  createdAt: number;
  lastUsed: number;
  resourceTracker?: import('./ResourceTracker.js').ResourceTracker;
}

export interface ScreenshotOptions {
  fullPage?: boolean;
  savePath?: string;
  includeBase64?: boolean;
  format?: 'png' | 'jpeg';
  quality?: number;
  target?: 'window' | 'view' | 'screen';
  viewId?: string;
}

export interface PdfOptions {
  landscape?: boolean;
  printBackground?: boolean;
  pageSize?: string;
  savePath?: string;
  margins?: { top?: number; bottom?: number; left?: number; right?: number };
  viewId?: string;
}

async function saveBrowserArtifact(buffer: Buffer, requestedPath: string | undefined, defaultDir: string, defaultName: string): Promise<string> {
  const savePath = requestedPath || join(defaultDir, defaultName);
  await mkdir(requestedPath ? dirname(savePath) : defaultDir, { recursive: true });
  await writeFile(savePath, buffer);
  return savePath;
}

function pdfMargins(margins: PdfOptions['margins']): { top?: string; bottom?: string; left?: string; right?: string } | undefined {
  if (!margins) return undefined;
  const pixels = (value?: number) => value ? `${value}px` : undefined;
  return { top: pixels(margins.top), bottom: pixels(margins.bottom), left: pixels(margins.left), right: pixels(margins.right) };
}

function normalizeScreenshotOptions(opts?: ScreenshotOptions): Required<Pick<ScreenshotOptions, 'format' | 'fullPage' | 'includeBase64'>> & ScreenshotOptions {
  return { ...opts, format: opts?.format ?? 'png', fullPage: opts?.fullPage ?? false, includeBase64: opts?.includeBase64 ?? false };
}

function normalizeStorageTargetOptions(options?: { name?: string; tabId?: string; createNamedSession?: boolean }): { name?: string; tabId?: string; createNamedSession: boolean } {
  return { name: options?.name?.trim(), tabId: options?.tabId?.trim(), createNamedSession: options?.createNamedSession === true };
}

type WidgetCaptureInput = { code: string; format: 'svg' | 'html' | 'mermaid'; viewport?: { width?: number; height?: number; deviceScaleFactor?: number }; theme?: 'light' | 'dark' };
type OpenTabOptions = { url?: string; userAgent?: string; session?: string; proxy?: { server: string; username?: string; password?: string }; shareContext?: boolean; settle?: boolean };
type NormalizedWidgetCapture = { code: string; codeBytes: number; width: number; height: number; deviceScaleFactor: number; theme: 'light' | 'dark' };

function normalizeWidgetCapture(input: WidgetCaptureInput): { value?: NormalizedWidgetCapture; error?: string } {
  const maxBytes = 64 * 1024;
  if (!input || typeof input !== 'object') return { error: 'invalid input' };
  if (!new Set(['svg', 'html', 'mermaid']).has(input.format)) return { error: `unsupported format "${input.format}". Supported formats: svg, html, mermaid.` };
  const code = typeof input.code === 'string' ? input.code : '';
  if (!code) return { error: 'code is required' };
  const codeBytes = Buffer.byteLength(code, 'utf-8');
  if (codeBytes > maxBytes) return { error: `widget code too large: ${codeBytes} bytes > ${maxBytes} bytes` };
  return { value: { code, codeBytes, width: input.viewport?.width ?? 680, height: input.viewport?.height ?? 400, deviceScaleFactor: input.viewport?.deviceScaleFactor ?? 2, theme: input.theme ?? 'light' } };
}

async function closeWidgetResources(page: import('patchright-core').Page | null, context: import('patchright-core').BrowserContext | null): Promise<void> {
  try { if (page && !page.isClosed()) await page.close(); } catch { /* ignore */ }
  try { if (context) await context.close(); } catch { /* ignore */ }
}

async function clearPageStorage(page: import('patchright-core').Page, clearLocal: boolean, clearCache: boolean): Promise<void> {
  try {
    if (clearLocal) await page.evaluate(() => { try { localStorage.clear(); } catch { /* sandboxed */ } try { sessionStorage.clear(); } catch { /* sandboxed */ } });
    if (clearCache) await page.evaluate(async () => { try { const keys = await caches.keys(); await Promise.all(keys.map(key => caches.delete(key))); } catch { /* unavailable */ } });
  } catch { /* page may have navigated or closed */ }
}

function runtimeLoadError(start: number, url: string, error: unknown, status?: 'timeout'): Record<string, unknown> {
  const end = Date.now();
  const message = error instanceof Error ? error.message : String(error);
  return { success: false, status: status || (message.toLowerCase().includes('timeout') ? 'timeout' : 'error'), finalUrl: url, timing: { start, end, duration: end - start }, error: message };
}

async function waitForRuntimeSelector(page: import('patchright-core').Page, options: any, timeout: number, start: number): Promise<Record<string, unknown> | null> {
  if (!options.waitForSelector) return null;
  try { await page.waitForSelector(options.waitForSelector, { state: options.waitForState || 'visible', timeout: options.waitForTimeout || timeout }); return null; }
  catch (error) { return runtimeLoadError(start, page.url(), error, 'timeout'); }
}

async function loadRuntimeUrl(page: import('patchright-core').Page, url: string, rawOptions?: any): Promise<Record<string, unknown>> {
  const start = Date.now();
  try {
    validateUrl(url);
    const options = rawOptions || {};
    const waitUntil = options.waitUntil || 'settled';
    const timeout = options.timeout || 30_000;
    const pwWaitUntil = waitUntil === 'networkidle' ? 'networkidle' : waitUntil === 'load' ? 'load' : 'domcontentloaded';
    await page.goto(url, { waitUntil: pwWaitUntil, timeout });
    const selectorError = await waitForRuntimeSelector(page, options, timeout, start);
    if (selectorError) return selectorError;
    let readiness: 'settled' | 'unsettled_timeout' | undefined;
    if (waitUntil === 'settled' && !options.waitForSelector) {
      const settleWindow = Math.min(Math.max(timeout - (Date.now() - start), DAEMON_DOM_SETTLE_QUIET_MS), DAEMON_DOM_SETTLE_MAX_MS);
      readiness = await waitForDomSettle(page, DAEMON_DOM_SETTLE_QUIET_MS, settleWindow) ? 'settled' : 'unsettled_timeout';
    }
    const end = Date.now();
    return { success: true, status: 'loaded', finalUrl: page.url(), timing: { start, end, duration: end - start }, ...(readiness ? { readiness } : {}) };
  } catch (error) { return runtimeLoadError(start, url, error); }
}

export async function loadRuntimeUrlForTab(
  resolvePage: (tabId: string) => import('patchright-core').Page,
  tabId: string,
  url: string,
  options?: unknown,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  try {
    return await loadRuntimeUrl(resolvePage(tabId), url, options);
  } catch (error) {
    return runtimeLoadError(start, url, error);
  }
}

function openedTabLog(tabId: string, options: OpenTabOptions): string {
  return `[Browser] Opened tab ${tabId}${options.url ? ` → ${options.url}` : ''}${options.userAgent ? ' (custom UA)' : ''}${options.proxy ? ` (proxy: ${options.proxy.server})` : ''}`;
}

function storageTargetIdentity(name?: string, tabId?: string): { name?: string; tabId?: string } {
  const identity: { name?: string; tabId?: string } = {};
  if (name) identity.name = name;
  if (tabId) identity.tabId = tabId;
  return identity;
}

function skippedStorageItemCount(origins: BrowserStorageOriginState[], skipped: string[]): number {
  return skipped.reduce((sum, origin) => sum + (origins.find((item) => item.origin === origin)?.sessionStorage?.length ?? 0), 0);
}

// ── Service ──────────────────────────────────────────────────────

interface SessionEntry {
  name: string;
  context: import('patchright-core').BrowserContext;
  tabIds: Set<string>;
  createdAt: number;
}

export interface BrowserStorageItem {
  name: string;
  value: string;
}

export interface BrowserStorageOriginState {
  origin: string;
  localStorage: BrowserStorageItem[];
  sessionStorage?: BrowserStorageItem[];
}

export interface BrowserStorageState {
  cookies: import('patchright-core').Cookie[];
  origins: BrowserStorageOriginState[];
}

export interface BrowserStorageStateResult {
  name?: string;
  tabId?: string;
  state: BrowserStorageState;
  savedAt: string;
  originCount: number;
  cookieCount: number;
  localStorageCount: number;
  sessionStorageCount: number;
  indexedDB: 'not-supported';
}

export interface BrowserStorageLoadResult {
  name?: string;
  tabId?: string;
  active: boolean;
  loaded: true;
  mode: 'merge' | 'replace';
  cookieCount: number;
  originCount: number;
  localStorageCount: number;
  sessionStorageCount: number;
  skippedSessionStorageOrigins: string[];
  openedSessionStorageOrigins: string[];
  indexedDB: 'not-supported';
}

export interface BrowserStorageLoadOptions {
  name?: string;
  tabId?: string;
  mode?: 'merge' | 'replace';
  openMissingOrigins?: boolean;
}

export class DaemonBrowserService extends EventEmitter {
  private browser: import('patchright-core').Browser | null = null;
  private context: import('patchright-core').BrowserContext | null = null;
  private readonly pages = new Map<string, PageEntry>();
  private readonly contexts = new Map<string, DaemonBrowserContext>();
  private activeTabId: string | null = null;
  private idCounter = 0;
  private chromePath: string | undefined;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private workspaceRoot: string | undefined;
  private browserCoreReady = false;
  private readonly _openTabMutex = new PromiseMutex();

  private readonly sessions = new Map<string, SessionEntry>();
  private activeSessionName: string | null = null;
  private tabToSession = new Map<string, string>();

  // Network route 拦截 handler（route/unroute 规则消费）。
  // BR-8 P3b：network/console 历史不再走本地 _addNetworkLog/_addConsoleLog →
  // action-tools Map，而是经 attachRuntimeLogCapture 喂进 browser-core 共享缓冲。
  private readonly _pageRouteHandlers = new Map<string, (route: import('patchright-core').Route) => Promise<void>>();

  // BR-8 WS-B：browser-core runtime 的常驻历史缓冲（由 initBrowserCore 注入共享单例）。
  // 经 BrowserContext.onCDPEvent 喂 CDP 事件 → /network /console 返回历史日志而非窗口快照。
  private _networkLog?: NetworkLog;
  private _consoleLog?: ConsoleLog;

  constructor(private readonly logger: Logger) {
    super();
    this.chromePath = findChromePath();
  }

  setWorkspaceRoot(root: string): void {
    this.workspaceRoot = root;
  }

  getWorkspaceRoot(): string | undefined {
    return this.workspaceRoot;
  }

  // ═══════ Availability ═══════

  isAvailable(): boolean {
    return !!this.chromePath;
  }

  getChromePath(): string | undefined {
    return this.chromePath;
  }

  // ═══════ Lazy lifecycle ═══════

  private async ensureBrowser(): Promise<import('patchright-core').Browser> {
    if (this.browser?.isConnected()) return this.browser;

    if (!this.chromePath) {
      throw new Error('No Chrome/Chromium found. Install Chrome or set CHROME_PATH.');
    }

    const { chromium } = await import('patchright-core');
    this.browser = await chromium.launch({
      headless: true,
      executablePath: this.chromePath,
      args: applyStealthArgs([
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-setuid-sandbox',
      ]),
    });

    this.browser.on('disconnected', () => {
      this.logger.warn('[Browser] Browser process disconnected');
      this.browser = null;
      this.context = null;
      for (const [, ctx] of this.contexts) {
        ctx.detach().catch(() => {});
      }
      this.contexts.clear();
      for (const [tabId, entry] of this.pages) {
        entry.resourceTracker?.detach();
        this.clearRuntimeLogCapture(tabId);
      }
      this.pages.clear();
      this.activeTabId = null;
      for (const [, session] of this.sessions) {
        session.context.close().catch(() => {});
      }
      this.sessions.clear();
      this.tabToSession.clear();
      this.activeSessionName = null;
      this.emit('browser:unavailable', { reason: 'disconnected' });
    });

    this.logger.info(`[Browser] Launched headless Chrome: ${this.chromePath}`);
    return this.browser;
  }

  private async ensureContext(): Promise<import('patchright-core').BrowserContext> {
    if (this.context) return this.context;
    const browser = await this.ensureBrowser();
    this.context = await browser.newContext(buildDefaultContextOptions());

    await this.installSsrfInterception(this.context);

    return this.context;
  }

  private async installSsrfInterception(ctx: import('patchright-core').BrowserContext): Promise<void> {
    await ctx.route('**/*', async (route) => {
      try {
        const parsed = new URL(route.request().url());
        if (isPrivateHost(parsed.hostname)) {
          this.logger.warn(`[Browser] Blocked SSRF request to private address: ${parsed.hostname}`);
          await route.abort('blockedbyclient');
          return;
        }
      } catch { /* non-HTTP schemes handled by browser */ }
      await route.continue();
    });
  }

  private async initResourceTracker(entry: PageEntry): Promise<void> {
    try {
      const { ResourceTracker } = await import('./ResourceTracker.js');
      const tracker = new ResourceTracker();
      await tracker.attach(entry.page);
      entry.resourceTracker = tracker;
    } catch {
      // CDP session may not be available — non-critical
    }
  }

  getResourceTracker(tabId?: string): import('./ResourceTracker.js').ResourceTracker | undefined {
    const id = tabId || this.activeTabId;
    if (!id) return undefined;
    return this.pages.get(id)?.resourceTracker;
  }

  getPage(tabId?: string): import('patchright-core').Page {
    const id = tabId || this.activeTabId;
    if (!id) throw new Error('No active tab. Use open_tab first.');
    const entry = this.pages.get(id);
    if (!entry) throw new Error(`Tab ${id} not found. Available: ${[...this.pages.keys()].join(', ') || 'none'}`);
    entry.lastUsed = Date.now();
    return entry.page;
  }

  private generateTabId(): string {
    return `tab-${++this.idCounter}-${Date.now().toString(36)}`;
  }

  private async createPageForOpen(options?: { userAgent?: string; proxy?: { server: string; username?: string; password?: string }; shareContext?: boolean }): Promise<{ page: import('patchright-core').Page; ownContext: import('patchright-core').BrowserContext | null }> {
    const shared = options?.shareContext === true && !options.userAgent && !options.proxy;
    if (shared) return { page: await (await this.ensureContext()).newPage(), ownContext: null };
    const browser = await this.ensureBrowser();
    const ownContext = await browser.newContext(buildDefaultContextOptions({
      ...(options?.userAgent && { userAgent: options.userAgent }),
      ...(options?.proxy && { proxy: { server: options.proxy.server, ...(options.proxy.username && { username: options.proxy.username }), ...(options.proxy.password && { password: options.proxy.password }) } }),
    }));
    await this.installSsrfInterception(ownContext);
    const page = await ownContext.newPage();
    if (options?.proxy) this.logger.info(`[Proxy] 使用代理: ${options.proxy.server}`);
    return { page, ownContext };
  }

  private async navigateOpenedPage(tabId: string, page: import('patchright-core').Page, url: string, settle: boolean): Promise<void> {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      if (settle) await waitForDomSettle(page, DAEMON_DOM_SETTLE_QUIET_MS, DAEMON_DOM_SETTLE_MAX_MS);
    } catch (error) {
      await this.closeTab(tabId).catch(() => {});
      throw error;
    }
  }

  // ═══════ Tab Management ═══════

  async openTab(rawOptions?: OpenTabOptions): Promise<string> {
    const options = rawOptions || {};
    // 仅在显式指定 session 时路由到 session 路径，不用 activeSessionName 劫持
    const sessionName = options.session;
    if (sessionName && this.sessions.has(sessionName) && !options.userAgent && !options.proxy) {
      return this.openTabInSession(sessionName, { url: options.url, settle: options.settle });
    }

    const release = await this._openTabMutex.acquire(30_000);
    try {
      if (options.url) {
        validateUrl(options.url);
      }

      if (this.pages.size >= MAX_PAGES) {
        await this.evictOldestPage();
      }

      const { page, ownContext } = await this.createPageForOpen(options);

      const tabId = this.generateTabId();

      const entry: PageEntry = {
        page,
        ownContext,
        createdAt: Date.now(),
        lastUsed: Date.now(),
      };
      this.pages.set(tabId, entry);
      this.attachPageLifecycleListeners(tabId, page);

      this.initResourceTracker(entry).catch(() => {});
      this.activeTabId = tabId;

      // 导航前就建好 BrowserContext 并挂常驻日志捕获，确保首屏请求/控制台进缓冲（BR-8 WS-B）
      const ctx = new DaemonBrowserContext(page);
      this.contexts.set(tabId, ctx);
      await attachRuntimeLogCapture(ctx, tabId, { networkLog: this._networkLog, consoleLog: this._consoleLog });
      await ctx.init();

      if (options.url) {
        await this.navigateOpenedPage(tabId, page, options.url, options.settle !== false);
      }

      this.startIdleCleanup();
      this.logger.info(openedTabLog(tabId, options));
      return tabId;
    } finally {
      release();
    }
  }

  async switchTab(tabId: string): Promise<void> {
    if (!this.pages.has(tabId)) throw new Error(`Tab ${tabId} not found`);
    this.activeTabId = tabId;
    this.pages.get(tabId)!.lastUsed = Date.now();
  }

  async closeTab(tabId: string): Promise<void> {
    const ctx = this.contexts.get(tabId);
    if (ctx) {
      await ctx.detach().catch(() => {});
      this.contexts.delete(tabId);
    }
    // 释放该 tab 的 network/console 历史缓冲（BR-8 WS-B）
    this.clearRuntimeLogCapture(tabId);

    const entry = this.pages.get(tabId);
    if (!entry) return;

    // 先从 Map 删除，防止 page.close() 触发 close 事件时
    // cleanupDeadPage 重复清理（close 监听器检查 pages.has）
    this.pages.delete(tabId);
    this._pageRouteHandlers.delete(tabId);
    entry.resourceTracker?.detach();

    try {
      if (!entry.page.isClosed()) await entry.page.close();
    } catch { /* already closed */ }

    if (entry.ownContext) {
      await entry.ownContext.close().catch(() => {});
    }

    if (this.activeTabId === tabId) {
      const remaining = [...this.pages.keys()];
      this.activeTabId = remaining.length > 0 ? remaining[remaining.length - 1] : null;
    }

    const sessionName = this.tabToSession.get(tabId);
    if (sessionName) {
      this.tabToSession.delete(tabId);
      const session = this.sessions.get(sessionName);
      if (session) {
        session.tabIds.delete(tabId);
      }
    }
  }

  listTabs(): Array<{ id: string; tabId: string; url: string; active: boolean }> {
    // BR-11：tabId 作主字段（= id，纯 viewId），与 Electron `tab list` 输出及输入 flag
    // --tab-id 双端对齐；保留 id 兼容既有消费方。顶层 activeTabId 已是主字段。
    const result: Array<{ id: string; tabId: string; url: string; active: boolean }> = [];
    for (const [id, entry] of this.pages) {
      try {
        result.push({ id, tabId: id, url: entry.page.url(), active: id === this.activeTabId });
      } catch { /* page may be closed */ }
    }
    return result;
  }

  getActiveTabId(): string | null {
    return this.activeTabId;
  }

  // ═══════ Navigation ═══════

  async navigateTo(
    url: string,
    tabId?: string,
    options?: { settle?: boolean },
  ): Promise<{ url: string; title: string; status: number | null }> {
    validateUrl(url);
    const page = this.getPage(tabId);
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // 与 loadUrl / browser open 的 settled 契约对齐：默认等 DOM 稳定作为「内容就绪」信号，
    // 覆盖 load 后才 fetch 渲染的 SPA。best-effort，不因 settle 未达成而失败。
    if (options?.settle !== false) {
      await waitForDomSettle(page, DAEMON_DOM_SETTLE_QUIET_MS, DAEMON_DOM_SETTLE_MAX_MS);
    }
    return { url: page.url(), title: await page.title(), status: response?.status() ?? null };
  }

  async goBack(tabId?: string): Promise<void> {
    const page = this.getPage(tabId);
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10_000 });
  }

  async goForward(tabId?: string): Promise<void> {
    const page = this.getPage(tabId);
    await page.goForward({ waitUntil: 'domcontentloaded', timeout: 10_000 });
  }

  async reload(tabId?: string, ignoreCache?: boolean): Promise<void> {
    const page = this.getPage(tabId);
    if (ignoreCache) {
      // Hard reload via CDP: equivalent to Ctrl+Shift+R — actually bypasses disk cache.
      // `location.reload()` (the previous impl) did NOT bypass cache and also
      // had the condition inverted (ignoreCache=true took the weaker path).
      const client = await page.context().newCDPSession(page);
      try {
        await client.send('Page.reload', { ignoreCache: true });
        await page.waitForLoadState('domcontentloaded', { timeout: 15_000 });
      } finally {
        await client.detach();
      }
    } else {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 });
    }
  }

  async stop(tabId?: string): Promise<void> {
    const page = this.getPage(tabId);
    await page.evaluate(() => window.stop());
  }

  async getNavigationState(
    tabId?: string,
    options?: { includeHistory?: boolean },
  ): Promise<{
    url: string;
    title: string;
    canGoBack: boolean;
    canGoForward: boolean;
    isLoading: boolean;
    history?: Array<{ url: string; title: string }>;
    activeIndex?: number;
  }> {
    const page = this.getPage(tabId);
    const [title, historyLen, canGoForward, isLoading] = await Promise.all([
      page.title(),
      page.evaluate(() => window.history.length).catch(() => 1),
      page.evaluate(() => {
        try {
          // Modern Chrome 102+: Navigation API exposes exact history entries and position.
          const nav = (window as unknown as { navigation?: { entries(): unknown[]; currentEntry: unknown } }).navigation;
          if (nav && typeof nav.entries === 'function') {
            const entries = nav.entries();
            const idx = entries.indexOf(nav.currentEntry);
            return idx >= 0 && idx < entries.length - 1;
          }
        } catch { /* not supported */ }
        return false;
      }).catch(() => false),
      // BR-4：isLoading 是 Electron NavigationState 的基础字段（webContents.isLoading()）。
      // Playwright Page 无同名同步 API，用 document.readyState 派生（complete = 已加载完）。
      page.evaluate(() => document.readyState !== 'complete').catch(() => false),
    ]);
    const state: {
      url: string;
      title: string;
      canGoBack: boolean;
      canGoForward: boolean;
      isLoading: boolean;
      history?: Array<{ url: string; title: string }>;
      activeIndex?: number;
    } = {
      url: page.url(),
      title,
      canGoBack: historyLen > 1,
      canGoForward,
      isLoading,
    };

    // BR-4 gap #2：尊重 --include-history。Electron 经 webContents.navigationHistory
    // .getAllEntries() 返回 {url,title}[] + activeIndex；Daemon 经 CDP
    // Page.getNavigationHistory 拿到等价的完整前进/后退历史（window.history 出于隐私
    // 不暴露条目 URL，故必须走 CDP）——形状与 Electron 对齐（history / activeIndex）。
    if (options?.includeHistory) {
      try {
        const client = await page.context().newCDPSession(page);
        try {
          const nav = await client.send('Page.getNavigationHistory') as {
            currentIndex: number;
            entries: Array<{ url: string; title?: string }>;
          };
          state.history = nav.entries.map((e) => ({ url: e.url, title: e.title || '' }));
          state.activeIndex = nav.currentIndex;
        } finally {
          await client.detach();
        }
      } catch { /* CDP history 不可用时省略，不伪造 */ }
    }

    return state;
  }

  // ═══════ Content & Execution ═══════

  async executeScript<T = unknown>(code: string, tabId?: string): Promise<T> {
    if (isBlockedScript(code)) {
      throw new Error('Script accesses restricted browser storage APIs');
    }
    const page = this.getPage(tabId);
    return page.evaluate(code) as Promise<T>;
  }

  /**
   * 使用结构化参数执行页面脚本，消除字符串拼接 JS 注入风险（BT-018）。
   * Playwright 会将 fn 序列化后在页面上下文执行，arg 作为独立参数传递，
   * 不经过字符串拼接，彻底杜绝注入路径。
   *
   * 使用 `any` 绕过 Playwright 严格的 Unboxed<A> 泛型约束，
   * 运行时行为正确（Playwright 在内部正确处理对象参数的序列化）。
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async evaluateWithArg<T = unknown>(fn: (arg: any) => T | Promise<T>, arg: unknown, tabId?: string): Promise<T> {
    const page = this.getPage(tabId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return page.evaluate(fn as any, arg) as Promise<T>;
  }

  async getPageContent(tabId?: string): Promise<{ html: string; text: string; title: string; url: string }> {
    const page = this.getPage(tabId);
    const [html, text, title] = await Promise.all([
      page.content(),
      page.innerText('body').catch(() => ''),
      page.title(),
    ]);
    return { html, text, title, url: page.url() };
  }

  async waitForSelector(selector: string, tabId?: string, timeout?: number): Promise<{ found: boolean; error?: string }> {
    const page = this.getPage(tabId);
    try {
      await page.waitForSelector(selector, { timeout: timeout ?? 30_000 });
      return { found: true };
    } catch (err) {
      return { found: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ═══════ Widget Wave 4 — Offscreen Render ═══════

  /**
   * Widget 离屏烤图（widget RFC §五 4.4 / §四 4.2 决策 6/v2）。
   *
   * **业务目标**：让 `show_widget` 工具在 Daemon 模式下也能把 SVG 源代码烤
   * 成 PNG buffer，让移动端拉历史时看到图片（不只是 summary 文字）。
   *
   * **管线**（与 Electron WidgetRenderService 等价但底层不同）：
   *   1. 校验 format=svg/html/mermaid + code 长度（Mermaid 已由工具编译成 SVG）
   *   2. 用独立 BrowserContext + ephemeral page（不污染用户的浏览会话）
   *   3. `page.setContent(wrapper)`——这是新增的管线（之前 takeScreenshot 是
   *      截已存在 view，不接受源代码）
   *   4. `await page.evaluate(() => document.fonts.ready)` —— 与 Electron
   *      `executeJavaScript('document.fonts.ready')` 对齐避免字体丢失
   *   5. `page.screenshot()` 拿 buffer
   *   6. `page.close() + ctx.close()` —— ephemeral 资源，烤完即销毁
   *
   * **错误恢复**：
   *   - 永不抛——内部异常包成 `{ success: false, error }`（与 OffscreenRenderAPI
   *     contract 一致）
   *   - browser launch 失败（Chrome 没装等）：返回 error 让 show-widget.ts emit
   *     不带 image_url 的 RICH_CONTENT，移动端走 fallback
   *
   * **vs takeScreenshot 的区别**：
   *   - takeScreenshot：截已存在的 page（用户浏览会话里的 tab）
   *   - captureWidget：从源代码起新建 ephemeral page → 烤图 → 销毁
   *
   * **与 Electron WidgetRenderService 共用 widget-tokens**：wrapper HTML 由
   * `@tabtin/widget-tokens.buildWrapper(code, { theme, reducedMotion: true })`
   * 生成，CSP 字面与 chat 预览一致。
   */
  async captureWidget(input: {
    code: string;
    format: 'svg' | 'html' | 'mermaid';
    viewport?: { width?: number; height?: number; deviceScaleFactor?: number };
    theme?: 'light' | 'dark';
  }): Promise<{
    success: boolean;
    buffer?: Uint8Array;
    width?: number;
    height?: number;
    error?: string;
  }> {
    // 与 Electron WidgetRenderService 字面一致的校验。输入 source 仍是 8KB；
    // Mermaid 编译后的 SVG 会膨胀，因此渲染层给 64KB 余量。
    const normalized = normalizeWidgetCapture(input);
    if (!normalized.value) return { success: false, error: normalized.error };
    const { code, codeBytes, width, height, deviceScaleFactor, theme } = normalized.value;

    // 动态 import @tabtin/widget-tokens——避免在 patchright launch 失败的边界
    // 路径上把 widget-tokens 也 fail，且让没有 widget 的 daemon 启动不付出
    // import 成本。
    let buildWrapper: typeof import('@tabtin/widget-tokens').buildWrapper;
    try {
      ({ buildWrapper } = await import('@tabtin/widget-tokens'));
    } catch (err) {
      return {
        success: false,
        error: `widget-tokens import failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const wrapperHtml = buildWrapper(code, {
      theme,
      width,
      // 烤图必须关 fade-in 动画——避免截到 50% 透明帧
      reducedMotion: true,
    });

    let browser: import('patchright-core').Browser;
    try {
      browser = await this.ensureBrowser();
    } catch (err) {
      return {
        success: false,
        error: `browser launch failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    let page: import('patchright-core').Page | null = null;
    let ctx: import('patchright-core').BrowserContext | null = null;
    try {
      // 独立 BrowserContext——不复用 user 的浏览会话，避免 cookie / cache 污染
      ctx = await browser.newContext(buildDefaultContextOptions({
        viewport: { width, height },
        deviceScaleFactor,
        // widget 烤图模式：固定 light scheme（theme 已在 wrapper HTML 中通过
        // `:root{...}` 注入；patchright colorScheme 主要影响 prefers-color-scheme
        // 媒体查询，wrapper 已用 `.dark` 等价方式注入 token，不必依赖此参数。
        // 但保留 light 让 prefers-color-scheme: dark 不被命中——避免与 wrapper
        // 内的 `:root` 主题块产生干扰）
        colorScheme: 'light',
      }));
      page = await ctx.newPage();

      await page.setContent(wrapperHtml, {
        // wait until the document load (HTML/SVG 都同步渲染，不等 networkidle)
        waitUntil: 'load',
        timeout: 10_000,
      });

      // 等字体就位——避免烤图字体丢失（widget RFC §四 4.2 已知坑 #2）。
      //
      // **超时策略**（用户视角 Review P1 修复）：与 Electron WidgetRenderService
      // 的 `FONT_READY_TIMEOUT_MS = 1500` 对齐——document.fonts.ready 在极端
      // 字体加载竞态下可能永久 pending（已知 Chromium 边界 case），不加 race
      // 会让整个烤图阻塞 page.setContent 的 10s timeout。1.5s 是 PingFang /
      // SF / iCloud 同步字体加载的余量预留，超过就降级到 system stack。
      const FONT_READY_TIMEOUT_MS = 1500;
      await Promise.race([
        page.evaluate(async () => {
          if (typeof document === 'undefined' || !document.fonts) return true;
          try {
            await document.fonts.ready;
          } catch {
            // 老旧 Chromium 可能不支持，直接忽略
          }
          return true;
        }).catch(() => {
          // evaluate 失败不阻塞——降级到 system stack
        }),
        new Promise<void>((resolve) => setTimeout(resolve, FONT_READY_TIMEOUT_MS)),
      ]);

      const buffer = await page.screenshot({
        type: 'png',
        // 不传 fullPage——固定按 viewport 截，避免 SVG 异常 viewBox 撑出整页
        // 截到一张超大图把内存吃满
        fullPage: false,
        omitBackground: false,
      });

      this.logger.debug?.(
        `[DaemonBrowserService] captureWidget: ${codeBytes} bytes → ${buffer.length} bytes PNG`,
      );

      return {
        success: true,
        buffer,
        width: width * deviceScaleFactor,
        height: height * deviceScaleFactor,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn?.(`[DaemonBrowserService] captureWidget failed: ${msg}`);
      return { success: false, error: msg };
    } finally {
      // ephemeral resources：一次性销毁，避免 leak
      await closeWidgetResources(page, ctx);
    }
  }

  // ═══════ Screenshot ═══════

  async takeScreenshot(tabId?: string, opts?: ScreenshotOptions): Promise<{
    success: boolean; path?: string; base64?: string;
    width?: number; height?: number; format?: string; sizeBytes?: number; error?: string;
  }> {
    try {
      const options = normalizeScreenshotOptions(opts);
      if (options.savePath) validateSavePath(options.savePath, this.workspaceRoot);

      const page = this.getPage(tabId);
      const format = options.format;
      const buffer = await page.screenshot({
        fullPage: options.fullPage,
        type: format,
        ...(format === 'jpeg' && options.quality ? { quality: options.quality } : {}),
      });

      const savePath = await saveBrowserArtifact(buffer, options.savePath, SCREENSHOTS_DIR, `screenshot-${Date.now()}.${format}`);

      const viewport = page.viewportSize();
      return {
        success: true,
        path: savePath,
        base64: options.includeBase64 ? buffer.toString('base64') : undefined,
        width: viewport?.width ?? 1280,
        height: viewport?.height ?? 720,
        format,
        sizeBytes: buffer.length,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ═══════ PDF ═══════

  async generatePdf(tabId?: string, opts?: PdfOptions): Promise<{
    success: boolean; path?: string; sizeBytes?: number; pageCount?: number; error?: string;
  }> {
    try {
      if (opts?.savePath) validateSavePath(opts.savePath, this.workspaceRoot);

      const page = this.getPage(tabId);
      const buffer = await page.pdf({
        landscape: opts?.landscape ?? false,
        printBackground: opts?.printBackground ?? true,
        format: (opts?.pageSize as any) || 'A4',
        margin: pdfMargins(opts?.margins),
      });
      const savePath = await saveBrowserArtifact(buffer, opts?.savePath, EXPORTS_DIR, `pdf-${Date.now()}.pdf`);

      return { success: true, path: savePath, sizeBytes: buffer.length };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ═══════ Page to Markdown ═══════

  async pageToMarkdown(tabId?: string, opts?: {
    url?: string;
    includeLinks?: boolean;
    includeImages?: boolean;
  }): Promise<{
    success: boolean; markdown?: string; title?: string; url?: string; wordCount?: number; error?: string;
  }> {
    try {
      let page: import('patchright-core').Page;
      let tempTabId: string | null = null;

      if (opts?.url) validateUrl(opts.url);

      if (opts?.url && !tabId) {
        // 临时页面也需要 mutex 保护，确保配额检查+创建+注册是原子操作；
        // 使用独立 Context 保持与默认隔离策略一致
        const release = await this._openTabMutex.acquire(30_000);
        try {
          if (this.pages.size >= MAX_PAGES) await this.evictOldestPage();

          const browser = await this.ensureBrowser();
          const ownCtx = await browser.newContext(buildDefaultContextOptions());
          await this.installSsrfInterception(ownCtx);
          const tempPage = await ownCtx.newPage();

          tempTabId = this.generateTabId();
          const entry: PageEntry = {
            page: tempPage,
            ownContext: ownCtx,
            createdAt: Date.now(),
            lastUsed: Date.now(),
          };
          this.pages.set(tempTabId, entry);
          this.attachPageLifecycleListeners(tempTabId, tempPage);

          try {
            await tempPage.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
            // 等 DOM 稳定作为「内容就绪」信号，覆盖 load 后才 fetch 渲染的 SPA（与 settled 契约对齐）。
            await waitForDomSettle(tempPage, DAEMON_DOM_SETTLE_QUIET_MS, DAEMON_DOM_SETTLE_MAX_MS);
          } catch (err) {
            await this.closeTab(tempTabId).catch(() => {});
            throw err;
          }
          page = tempPage;
        } finally {
          release();
        }
      } else {
        page = this.getPage(tabId);
        if (opts?.url) {
          await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          await waitForDomSettle(page, DAEMON_DOM_SETTLE_QUIET_MS, DAEMON_DOM_SETTLE_MAX_MS);
        }
      }

      try {
        const html = await page.content();
        const title = await page.title();
        const pageUrl = page.url();

        const { createTurndownInstance } = await import('@tabtin/action-tools/headless');
        const td = await createTurndownInstance({
          removeImages: opts?.includeImages === false,
          removeLinks: opts?.includeLinks === false,
        });

        const markdown = td.turndown(html);
        return {
          success: true,
          markdown,
          title,
          url: pageUrl,
          wordCount: markdown.split(/\s+/).filter(Boolean).length,
        };
      } finally {
        if (tempTabId) await this.closeTab(tempTabId).catch(() => {});
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ═══════ Cookie & Session Management ═══════

  /** 获取指定标签（或活跃标签）所在 Context 的 cookies */
  async getCookies(urls?: string[], tabId?: string): Promise<import('patchright-core').Cookie[]> {
    const ctx = this.getTabContext(tabId);
    return urls && urls.length > 0 ? ctx.cookies(urls) : ctx.cookies();
  }

  async addCookies(cookies: import('patchright-core').Cookie[], tabId?: string): Promise<void> {
    const ctx = this.getTabContext(tabId);
    await ctx.addCookies(cookies);
  }

  async clearCookies(tabId?: string): Promise<void> {
    const ctx = this.getTabContext(tabId);
    await ctx.clearCookies();
  }

  /** 获取标签所在的 BrowserContext，适配独立 Context 和共享 Context 两种模式 */
  private getTabContext(tabId?: string): import('patchright-core').BrowserContext {
    const id = tabId || this.activeTabId;
    if (id) {
      const entry = this.pages.get(id);
      if (entry) {
        if (entry.ownContext) return entry.ownContext;
        return entry.page.context();
      }
    }
    if (this.context) return this.context;
    throw new Error('No active tab or browser context available');
  }

  private getStorageTarget(options?: {
    name?: string;
    tabId?: string;
    createNamedSession?: boolean;
  }): {
    context: import('patchright-core').BrowserContext;
    pages: import('patchright-core').Page[];
    tabId?: string;
    name?: string;
  } {
    const { name, tabId, createNamedSession } = normalizeStorageTargetOptions(options);

    if (name) {
      const session = this.sessions.get(name);
      if (session) {
        if (tabId && !session.tabIds.has(tabId)) {
          throw new Error(`Tab ${tabId} does not belong to session "${name}"`);
        }
        const targetTabIds = tabId ? [tabId] : [...session.tabIds];
        const pages = targetTabIds
          .map((id) => this.pages.get(id)?.page)
          .filter((page): page is import('patchright-core').Page => !!page && !page.isClosed());
        return { context: session.context, pages, name, tabId };
      }
      if (!tabId) {
        throw new Error(`Session "${name}" not found`);
      }
    }

    if (tabId) {
      const entry = this.pages.get(tabId);
      if (!entry) throw new Error(`Tab ${tabId} not found`);
      return { context: this.getTabContext(tabId), pages: [entry.page].filter((page) => !page.isClosed()), name, tabId };
    }

    if (name && createNamedSession) {
      throw new Error(`Session "${name}" not found. Create it before loading storageState.`);
    }

    return { context: this.getTabContext(), pages: this.getPagesForContext(this.getTabContext()), name, tabId };
  }

  private getPagesForContext(ctx: import('patchright-core').BrowserContext): import('patchright-core').Page[] {
    return [...this.pages.values()]
      .filter((entry) => !entry.page.isClosed() && entry.page.context() === ctx)
      .map((entry) => entry.page);
  }

  private static getHttpOrigin(url: string): string | null {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      return parsed.origin;
    } catch {
      return null;
    }
  }

  private static countStorageItems(origins: BrowserStorageOriginState[], field: 'localStorage' | 'sessionStorage'): number {
    return origins.reduce((sum, origin) => sum + (origin[field]?.length ?? 0), 0);
  }

  private static normalizeStorageLoadMode(value: unknown): 'merge' | 'replace' {
    if (value === undefined || value === null || value === '' || value === 'merge') return 'merge';
    if (value === 'replace') return 'replace';
    throw new Error('mode 必须是 merge 或 replace');
  }

  private static normalizeStorageItems(value: unknown): BrowserStorageItem[] {
    if (Array.isArray(value)) {
      return value
        .filter((item): item is { name: unknown; value: unknown } => !!item && typeof item === 'object' && 'name' in item)
        .map((item) => ({ name: String(item.name), value: String(item.value ?? '') }));
    }
    if (value && typeof value === 'object') {
      return Object.entries(value as Record<string, unknown>).map(([name, itemValue]) => ({
        name,
        value: String(itemValue ?? ''),
      }));
    }
    return [];
  }

  private static normalizeStorageState(raw: unknown, fallbackOrigin?: string | null): BrowserStorageState {
    if (!raw || typeof raw !== 'object') {
      throw new Error('state 必须是 storageState JSON 对象');
    }

    const source = raw as Record<string, unknown>;
    const cookies = Array.isArray(source.cookies)
      ? source.cookies as import('patchright-core').Cookie[]
      : [];
    const origins: BrowserStorageOriginState[] = [];

    if (Array.isArray(source.origins)) {
      for (const originEntry of source.origins) {
        if (!originEntry || typeof originEntry !== 'object') continue;
        const entry = originEntry as Record<string, unknown>;
        if (typeof entry.origin !== 'string' || !entry.origin.trim()) continue;
        origins.push({
          origin: entry.origin,
          localStorage: DaemonBrowserService.normalizeStorageItems(entry.localStorage),
          sessionStorage: DaemonBrowserService.normalizeStorageItems(entry.sessionStorage),
        });
      }
    } else if (source.localStorage || source.sessionStorage) {
      const origin = typeof source.url === 'string'
        ? DaemonBrowserService.getHttpOrigin(source.url)
        : fallbackOrigin;
      if (!origin) {
        throw new Error('legacy state 缺少可用 url，无法推断 localStorage/sessionStorage origin');
      }
      origins.push({
        origin,
        localStorage: DaemonBrowserService.normalizeStorageItems(source.localStorage),
        sessionStorage: DaemonBrowserService.normalizeStorageItems(source.sessionStorage),
      });
    }

    return { cookies, origins };
  }

  async saveStorageState(options?: { name?: string; tabId?: string }): Promise<BrowserStorageStateResult> {
    const target = this.getStorageTarget({ name: options?.name, tabId: options?.tabId });
    const baseState = await (target.context as any).storageState() as {
      cookies?: import('patchright-core').Cookie[];
      origins?: Array<{ origin: string; localStorage?: BrowserStorageItem[] }>;
    };
    const origins = new Map<string, BrowserStorageOriginState>();
    for (const origin of baseState.origins ?? []) {
      origins.set(origin.origin, {
        origin: origin.origin,
        localStorage: DaemonBrowserService.normalizeStorageItems(origin.localStorage),
      });
    }

    for (const page of target.pages) {
      const origin = DaemonBrowserService.getHttpOrigin(page.url());
      if (!origin) continue;
      const sessionStorage = await page.evaluate(() => {
        const items: Array<{ name: string; value: string }> = [];
        try {
          for (let i = 0; i < window.sessionStorage.length; i++) {
            const name = window.sessionStorage.key(i);
            if (name !== null) items.push({ name, value: window.sessionStorage.getItem(name) ?? '' });
          }
        } catch {
          // sandboxed or inaccessible storage; keep origin without sessionStorage.
        }
        return items;
      }).catch(() => [] as BrowserStorageItem[]);
      if (sessionStorage.length === 0) continue;
      const entry = origins.get(origin) ?? { origin, localStorage: [] };
      entry.sessionStorage = sessionStorage;
      origins.set(origin, entry);
    }

    const state: BrowserStorageState = {
      cookies: baseState.cookies ?? [],
      origins: [...origins.values()],
    };

    return {
      ...storageTargetIdentity(target.name, target.tabId),
      state,
      savedAt: new Date().toISOString(),
      originCount: state.origins.length,
      cookieCount: state.cookies.length,
      localStorageCount: DaemonBrowserService.countStorageItems(state.origins, 'localStorage'),
      sessionStorageCount: DaemonBrowserService.countStorageItems(state.origins, 'sessionStorage'),
      indexedDB: 'not-supported',
    };
  }

  private async clearStorageStateTarget(
    context: import('patchright-core').BrowserContext,
    pages: import('patchright-core').Page[],
  ): Promise<void> {
    await context.clearCookies();
    for (const page of pages) {
      if (page.isClosed()) continue;
      await page.evaluate(() => {
        try { window.localStorage.clear(); } catch { /* sandboxed */ }
        try { window.sessionStorage.clear(); } catch { /* sandboxed */ }
      }).catch(() => {});
    }
  }

  private async loadOriginStorage(
    originState: BrowserStorageOriginState,
    target: ReturnType<DaemonBrowserService['getStorageTarget']>,
    openMissingOrigins: boolean,
    skipped: string[],
    opened: string[],
  ): Promise<void> {
    validateUrl(originState.origin);
    const localStorage = originState.localStorage ?? [];
    const sessionStorage = originState.sessionStorage ?? [];
    const pagesForOrigin = target.pages.filter((page) => DaemonBrowserService.getHttpOrigin(page.url()) === originState.origin);
    if (localStorage.length > 0) {
      let page = pagesForOrigin[0];
      let tempPage: import('patchright-core').Page | null = null;
      if (!page) { tempPage = await target.context.newPage(); page = tempPage; await page.goto(originState.origin, { waitUntil: 'domcontentloaded', timeout: 30_000 }); }
      try { await page.evaluate((items) => { for (const item of items) window.localStorage.setItem(item.name, item.value); }, localStorage); }
      finally { if (tempPage) await tempPage.close().catch(() => {}); }
    }
    if (sessionStorage.length === 0) return;
    let page = pagesForOrigin[0];
    if (!page && target.name && !target.tabId && openMissingOrigins) {
      const newTabId = await this.openTabInSession(target.name, { url: originState.origin });
      const entry = this.pages.get(newTabId);
      if (entry && !entry.page.isClosed()) { page = entry.page; target.pages.push(page); opened.push(originState.origin); }
    }
    if (!page) { skipped.push(originState.origin); return; }
    await page.evaluate((items) => { for (const item of items) window.sessionStorage.setItem(item.name, item.value); }, sessionStorage);
  }

  private storageFallbackOrigin(tabId?: string): string | null {
    if (!tabId) return null;
    try { return DaemonBrowserService.getHttpOrigin(this.getPage(tabId).url()); }
    catch { return null; }
  }

  private activateStorageTarget(name?: string): void {
    if (name) this.activeSessionName = name;
  }

  async loadStorageState(rawState: unknown, options?: BrowserStorageLoadOptions): Promise<BrowserStorageLoadResult> {
    const fallbackOrigin = this.storageFallbackOrigin(options?.tabId);
    const state = DaemonBrowserService.normalizeStorageState(rawState, fallbackOrigin);
    const mode = DaemonBrowserService.normalizeStorageLoadMode(options?.mode);
    const openMissingOrigins = options?.openMissingOrigins === true;

    if (options?.name && !this.sessions.has(options.name) && !options?.tabId) {
      await this.createSession(options.name);
    }

    const target = this.getStorageTarget({ name: options?.name, tabId: options?.tabId });
    if (mode === 'replace') {
      await this.clearStorageStateTarget(target.context, target.pages);
    }
    if (state.cookies.length > 0) {
      await target.context.addCookies(state.cookies);
    }

    const skippedSessionStorageOrigins: string[] = [];
    const openedSessionStorageOrigins: string[] = [];
    for (const originState of state.origins) {
      await this.loadOriginStorage(originState, target, openMissingOrigins, skippedSessionStorageOrigins, openedSessionStorageOrigins);
    }

    this.activateStorageTarget(target.name);

    return {
      ...storageTargetIdentity(target.name, target.tabId),
      active: Boolean(target.name && this.activeSessionName === target.name),
      loaded: true,
      mode,
      cookieCount: state.cookies.length,
      originCount: state.origins.length,
      localStorageCount: DaemonBrowserService.countStorageItems(state.origins, 'localStorage'),
      sessionStorageCount: DaemonBrowserService.countStorageItems(state.origins, 'sessionStorage') - skippedStorageItemCount(state.origins, skippedSessionStorageOrigins),
      skippedSessionStorageOrigins,
      openedSessionStorageOrigins,
      indexedDB: 'not-supported',
    };
  }

  async clearSession(options?: {
    clearCookies?: boolean;
    clearLocalStorage?: boolean;
    clearCache?: boolean;
    tabId?: string;
  }): Promise<void> {
    const clearCookies = options?.clearCookies ?? true;
    const clearLocalStorage = options?.clearLocalStorage ?? true;
    const clearCache = options?.clearCache ?? true;

    const ctx = this.getTabContext(options?.tabId);
    const cleared: string[] = [];

    if (clearCookies) {
      await ctx.clearCookies();
      cleared.push('cookies');
    }

    await ctx.clearPermissions();
    cleared.push('permissions');

    if (clearLocalStorage || clearCache) {
      const targetCtx = ctx;
      const pages = [...this.pages.values()]
        .filter(e => !e.page.isClosed() && e.page.context() === targetCtx)
        .map(e => e.page);

      for (const page of pages) {
        await clearPageStorage(page, clearLocalStorage, clearCache);
      }
      if (clearLocalStorage) cleared.push('localStorage', 'sessionStorage');
      if (clearCache) cleared.push('cache');
    }

    this.logger.info(`[Browser] Session cleared (${cleared.join(' + ')})`);
  }

  // ═══════ Runtime Bridge Injection ═══════

  /**
   * Inject browser APIs into the action-tools runtime bridge,
   * enabling tabweb tools (screenshot, pdf, markdown, navigation, etc.)
   * to work through the standard adapter execution path.
   */
  async injectRuntimeAPIs(): Promise<void> {
    const {
      setCrawlViewAPI,
      setScreenshotAPI,
      setPdfAPI,
      setPageToMarkdownAPI,
      setRunSessionAPI,
      setViewFactoryAPI,
      setHttpCrawlAPI,
      setResourceDetectionAPI,
      setOffscreenRenderAPI,
    } = await import('@tabtin/action-tools/headless');

    setCrawlViewAPI({
      executeScript: (script: string, tabId?: string) => this.executeScript(script, tabId),
      getNavigationState: (tabId?: string, options?: { includeHistory?: boolean }) => this.getNavigationState(tabId, options),
      goBack: (tabId?: string) => this.goBack(tabId),
      goForward: (tabId?: string) => this.goForward(tabId),
      reload: (ignoreCache?: boolean, tabId?: string) => this.reload(tabId, ignoreCache),
      stop: (tabId?: string) => this.stop(tabId),
      loadUrl: (tabId: string, url: string, options?: any) =>
        loadRuntimeUrlForTab((id) => this.getPage(id), tabId, url, options),
      waitForSelector: async (tabId: string, options: any) => {
        if (options?.delay) {
          const start = Date.now();
          await new Promise<void>((resolve) => setTimeout(resolve, options.delay));
          return { success: true, elapsedMs: Date.now() - start };
        }
        if (options?.delay === undefined && options?.selector === undefined && typeof options === 'string') {
          const start = Date.now();
          const result = await this.waitForSelector(options, tabId);
          return { success: result.found, elapsedMs: Date.now() - start, error: result.error };
        }
        const selector = options?.selector;
        if (!selector) {
          return { success: false, error: 'selector is required when delay is not provided' };
        }
        const start = Date.now();
        const page = this.getPage(tabId);
        try {
          await page.waitForSelector(selector, {
            state: options.state || 'visible',
            timeout: options.timeout || 30_000,
          });
          return { success: true, elapsedMs: Date.now() - start };
        } catch (err: any) {
          return { success: false, elapsedMs: Date.now() - start, error: err?.message || String(err) };
        }
      },
    });

    setScreenshotAPI({
      capture: (options) => this.takeScreenshot(options?.viewId, options),
    });

    // ═══ Widget Wave 4.4: OffscreenRenderAPI 注入 ═══
    // show_widget 工具在 Daemon 模式下也能烤 SVG 成 PNG → 上传 OSS → emit
    // RICH_CONTENT 带 image_url。**不**走 setScreenshotAPI（target 不一样—
    // Screenshot 截已存在的 view，OffscreenRender 接受源代码烤图）。
    // 详见 widget RFC §五 4.1 + 4.4。
    setOffscreenRenderAPI({
      renderToImage: (input) =>
        this.captureWidget({
          code: input.code,
          format: input.format,
          viewport: input.viewport,
          theme: input.theme,
        }),
    });

    setPdfAPI({
      generate: (options) => this.generatePdf(options?.viewId, options),
    });

    setPageToMarkdownAPI({
      convert: (options) => this.pageToMarkdown(options?.viewId, options),
    });

    setRunSessionAPI({
      openTab: async (input: any) => {
        const tabId = await this.openTab({
          url: input?.url,
          userAgent: input?.userAgent,
          proxy: input?.proxy,
        });
        return { success: true, id: tabId, tabId, viewId: tabId };
      },
      switchTab: async (input: any) => {
        await this.switchTab(input?.tabId || input?.viewId);
        return { success: true };
      },
      closeTab: async (input: any) => {
        await this.closeTab(input?.tabId || input?.viewId);
        return { success: true };
      },
      get: (runId: string) => ({
        runId,
        activeViewId: this.activeTabId,
        views: [...this.pages.entries()].map(([id, entry]) => {
          let url = '';
          try { if (!entry.page.isClosed()) url = entry.page.url(); } catch { /* page may be navigating */ }
          return { viewId: id, createdAt: entry.createdAt, metadata: { url } };
        }),
      }),
    });

    setViewFactoryAPI({
      getCurrentViewId: () => this.activeTabId,
      getViewState: (viewId: string) => {
        const entry = this.pages.get(viewId);
        if (!entry || entry.page.isClosed()) return undefined;
        try {
          return { url: entry.page.url(), config: { metadata: { url: entry.page.url() } } };
        } catch { return undefined; }
      },
    });

    setHttpCrawlAPI({
      fetch: async (options) => {
        const startMs = Date.now();
        try {
          validateUrl(options.url);
          const response = await fetch(options.url, {
            headers: options.headers,
            signal: AbortSignal.timeout(options.timeout || 30_000),
          });
          const content = await response.text();
          const titleMatch = content.match(/<title[^>]*>([^<]*)<\/title>/i);
          return {
            success: true,
            data: {
              url: response.url,
              title: titleMatch?.[1]?.trim() ?? '',
              content,
              content_type: response.headers.get('content-type') || 'text/html',
              status_code: response.status,
              response_time_ms: Date.now() - startMs,
            },
          };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    });

    // ═══════ Resource Detection Bridge helpers ═══════

    const resolveResourceUrl = (input: { resourceId?: string; url?: string; viewId?: string }): string | null => {
      if (input.url) return input.url;
      if (!input.resourceId) return null;
      const tracker = this.getResourceTracker(input.viewId);
      return tracker?.inspect(input.resourceId)?.url ?? null;
    };

    const getAuthHeaders = async (url: string, viewId?: string): Promise<Record<string, string>> => {
      const result: Record<string, string> = {};
      try {
        const tracker = this.getResourceTracker(viewId);
        if (tracker?.isEnabled) {
          const entry = tracker.findByUrl(url);
          if (entry?.headers) {
            const cookie = entry.headers['cookie'] || entry.headers['Cookie'];
            if (cookie) result['Cookie'] = cookie;
            const referer = entry.headers['referer'] || entry.headers['Referer'];
            if (referer) result['Referer'] = referer;
            const auth = entry.headers['authorization'] || entry.headers['Authorization'];
            if (auth) result['Authorization'] = auth;
          }
        }
        if (!result['Cookie']) {
          try {
            const cookies = await this.getCookies([url], viewId);
            if (cookies.length > 0) {
              result['Cookie'] = cookies.map(c => `${c.name}=${c.value}`).join('; ');
            }
          } catch { /* cookie 获取失败不阻断主流程 */ }
        }
      } catch { /* 非关键路径 */ }
      return result;
    };

    type RCategory = 'video' | 'hls' | 'dash' | 'audio' | 'image' | 'font' | 'document';
    type RCaptureStatus = 'metadata_only' | 'content_cached' | 'failed';
    type RCapability = 'preview' | 'download' | 'parse' | 'streamDownload';

    const inferCategory = (entry: ResourceEntry): RCategory => {
      const url = entry.url.toLowerCase();
      if (/\.m3u8(\?|#|$)/.test(url)) return 'hls';
      if (/\.mpd(\?|#|$)/.test(url)) return 'dash';
      const mime = (entry.mimeType || '').toLowerCase();
      if (mime.startsWith('video/') || (entry.resourceType === 'Media' && !mime.startsWith('audio/'))) return 'video';
      if (mime.startsWith('audio/')) return 'audio';
      if (mime.startsWith('image/') || entry.resourceType === 'Image') return 'image';
      if (mime.startsWith('font/') || entry.resourceType === 'Font') return 'font';
      return 'document';
    };

    const mapEntryToRecord = (entry: ResourceEntry, viewId: string, pageUrl?: string) => {
      const category = inferCategory(entry);
      const captureStatus: RCaptureStatus = entry.captured ? 'content_cached' : entry.loadingState === 'failed' ? 'failed' : 'metadata_only';
      const capabilities: RCapability[] = [];
      if (entry.loadingState === 'finished') capabilities.push('download');
      if (category === 'image') capabilities.push('preview');
      if (category === 'hls' || category === 'dash') capabilities.push('parse', 'streamDownload');

      return {
        id: entry.requestId,
        resourceId: entry.requestId,
        url: entry.url,
        category,
        mimeType: entry.mimeType,
        size: entry.contentLength,
        statusCode: entry.status ?? 0,
        method: entry.method,
        requestHeaders: entry.headers,
        timestamp: entry.timing?.requestTime ? Math.round(entry.timing.requestTime * 1000) : Date.now(),
        viewId,
        pageUrl,
        source: 'network' as const,
        captureStatus,
        capabilities,
      };
    };

    const findVariantIndex = (variants: Array<{ bandwidth: number; resolution?: string }>, quality?: string): number => {
      if (!quality || !variants.length) return 0;
      const normalized = quality.toString().toLowerCase().trim();
      if (!normalized || normalized === 'best' || normalized === 'highest') return 0;
      const match = variants.findIndex(v => (v.resolution || '').toLowerCase().includes(normalized));
      return match >= 0 ? match : 0;
    };

    const resolveDownloadManifest = async (url: string, headers: Record<string, string>, quality?: string): Promise<{ segments?: Array<{ uri: string; duration: number }>; initSegmentUrl?: string; error?: string }> => {
      if (/\.mpd(\?|#|$)/.test(url.toLowerCase())) {
        const { fetchAndParseMPD } = await import('./mpd-parser.js');
        const manifest = await fetchAndParseMPD(url, headers);
        if (manifest.isEncrypted) return { error: 'DASH stream is DRM-protected' };
        const index = findVariantIndex(manifest.variants, quality);
        return { segments: manifest.variantSegments?.[index]?.segments || manifest.segments, initSegmentUrl: manifest.variantSegments?.[index]?.initSegmentUrl || manifest.initSegmentUrl };
      }
      const { fetchAndParseM3U8 } = await import('./m3u8-parser.js');
      let manifest = await fetchAndParseM3U8(url, headers);
      if (manifest.isEncrypted) return { error: `HLS stream is encrypted (${manifest.encryptionMethod || 'AES-128'})` };
      if (manifest.type === 'master' && manifest.variants.length > 0) {
        const index = findVariantIndex(manifest.variants, quality);
        manifest = await fetchAndParseM3U8(manifest.variants[index]?.uri || manifest.variants[0].uri, headers);
      }
      return { segments: manifest.segments, initSegmentUrl: manifest.initSegmentUrl };
    };

    const listResourcesImpl = async (input: { viewId: string; category?: string; limit?: number }) => {
      try {
        const tracker = this.getResourceTracker(input.viewId);
        if (!tracker) return { success: false as const, error: `No resource tracker for view ${input.viewId}` };

        let pageUrl: string | undefined;
        try { pageUrl = this.getPage(input.viewId).url(); } catch { /* page may be closed */ }

        const entries = tracker.list();
        let records = entries.map(e => mapEntryToRecord(e, input.viewId, pageUrl));

        if (input.category) {
          const cat = input.category.toLowerCase();
          records = records.filter(r => r.category === cat);
        }
        if (input.limit && input.limit > 0) {
          records = records.slice(0, input.limit);
        }

        const byCategory: Record<string, number> = {};
        for (const r of records) byCategory[r.category] = (byCategory[r.category] || 0) + 1;

        return {
          success: true as const,
          data: {
            resources: records,
            summary: { total: records.length, byCategory },
            viewId: input.viewId,
            pageUrl,
          },
        };
      } catch (err: any) {
        return { success: false as const, error: err?.message || String(err) };
      }
    };

    setResourceDetectionAPI({
      getResources: (input) => listResourcesImpl(input),
      listResources: (input) => listResourcesImpl(input),

      inspectResource: async (input) => {
        try {
          const tracker = this.getResourceTracker(input.viewId);
          if (!tracker) return { success: false, error: `No resource tracker for view ${input.viewId || 'active'}` };

          const entry = tracker.inspect(input.resourceId);
          if (!entry) return { success: false, error: `Resource ${input.resourceId} not found` };

          let pageUrl: string | undefined;
          try { pageUrl = this.getPage(input.viewId).url(); } catch { /* page may be closed */ }

          return { success: true, data: { resource: mapEntryToRecord(entry, input.viewId || this.activeTabId || '', pageUrl) } };
        } catch (err: any) {
          return { success: false, error: err?.message || String(err) };
        }
      },

      captureResource: async (input) => {
        try {
          const tracker = this.getResourceTracker(input.viewId);
          if (!tracker) return { success: false, error: `No resource tracker for view ${input.viewId || 'active'}` };

          let requestId = input.resourceId;
          if (!requestId && input.url) {
            requestId = tracker.findByUrl(input.url)?.requestId;
          }
          if (!requestId) return { success: false, error: 'resourceId or url required' };

          const body = await tracker.capture(requestId);
          const entry = tracker.inspect(requestId);
          if (!entry) return { success: false, error: `Resource ${requestId} not found after capture` };

          let pageUrl: string | undefined;
          try { pageUrl = this.getPage(input.viewId).url(); } catch { /* page may be closed */ }

          return {
            success: !!body,
            data: {
              resource: mapEntryToRecord(entry, input.viewId || this.activeTabId || '', pageUrl),
              captured: !!body,
            },
          };
        } catch (err: any) {
          return { success: false, error: err?.message || String(err) };
        }
      },

      downloadResource: async (input) => {
        try {
          const tracker = this.getResourceTracker(input.viewId);
          if (!tracker) return { success: false, error: `No resource tracker for view ${input.viewId || 'active'}` };

          let requestId = input.resourceId;
          if (!requestId && input.url) {
            requestId = tracker.findByUrl(input.url)?.requestId;
          }
          if (!requestId) return { success: false, error: 'resourceId or url required' };

          const result = await tracker.download(requestId, input.filename);
          if (!result.success) return { success: false, error: result.error };

          const entry = tracker.inspect(requestId);
          return {
            success: true,
            data: { filePath: result.path!, size: result.size!, mimeType: entry?.mimeType, resourceId: requestId },
          };
        } catch (err: any) {
          return { success: false, error: err?.message || String(err) };
        }
      },

      downloadBatch: async (input) => {
        try {
          const tracker = this.getResourceTracker(input.viewId);
          if (!tracker) return { success: false, error: `No resource tracker for view ${input.viewId || 'active'}` };

          const ids: string[] = [...(input.resourceIds || [])];
          if (input.urls) {
            for (const url of input.urls) {
              const entry = tracker.findByUrl(url);
              if (entry) ids.push(entry.requestId);
            }
          }
          if (ids.length === 0) return { success: false, error: 'No resources to download' };

          const concurrency = input.concurrency || 3;
          const results: Array<{ url: string; success: boolean; data?: { filePath: string; size: number; mimeType: string }; error?: string }> = [];
          let succeeded = 0;
          let failed = 0;

          const queue = [...ids];
          const worker = async () => {
            while (queue.length > 0) {
              const id = queue.shift()!;
              const entry = tracker.inspect(id);
              const url = entry?.url || id;
              try {
                const dlResult = await tracker.download(id);
                if (dlResult.success) {
                  succeeded++;
                  results.push({ url, success: true, data: { filePath: dlResult.path!, size: dlResult.size!, mimeType: entry?.mimeType || 'application/octet-stream' } });
                } else {
                  failed++;
                  results.push({ url, success: false, error: dlResult.error });
                }
              } catch (err: any) {
                failed++;
                results.push({ url, success: false, error: err?.message || String(err) });
              }
            }
          };

          await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, () => worker()));

          return { success: failed === 0, data: { total: ids.length, succeeded, failed, results } };
        } catch (err: any) {
          return { success: false, error: err?.message || String(err) };
        }
      },

      parseM3U8: async (input) => {
        try {
          const url = resolveResourceUrl(input);
          if (!url) return { success: false, error: 'url or valid resourceId required' };

          const authHeaders = await getAuthHeaders(url, input.viewId);
          const mergedHeaders = { ...authHeaders, ...(input.headers ?? {}) };

          const { fetchAndParseM3U8 } = await import('./m3u8-parser.js');
          const manifest = await fetchAndParseM3U8(url, mergedHeaders);

          return {
            success: true,
            data: {
              streamType: 'hls' as const,
              isMasterPlaylist: manifest.type === 'master',
              variants: manifest.variants.map(v => ({ bandwidth: v.bandwidth, resolution: v.resolution, url: v.uri, codecs: v.codecs })),
              segments: manifest.segments.map((s, i) => ({ url: s.uri, duration: s.duration, sequence: i })),
              duration: manifest.totalDuration,
              isLive: manifest.isLive,
              isEncrypted: manifest.isEncrypted ?? false,
            },
          };
        } catch (err: any) {
          return { success: false, error: err?.message || String(err) };
        }
      },

      parseStream: async (input) => {
        try {
          const url = resolveResourceUrl(input);
          if (!url) return { success: false, error: 'url or valid resourceId required' };

          const authHeaders = await getAuthHeaders(url, input.viewId);
          const mergedHeaders = { ...authHeaders, ...(input.headers ?? {}) };

          const urlLower = url.toLowerCase();
          if (/\.mpd(\?|#|$)/.test(urlLower)) {
            const { fetchAndParseMPD } = await import('./mpd-parser.js');
            const m = await fetchAndParseMPD(url, mergedHeaders);
            return {
              success: true,
              data: {
                streamType: 'dash' as const, isMasterPlaylist: m.variants.length > 1,
                variants: m.variants.map(v => ({ bandwidth: v.bandwidth, resolution: v.resolution, url: v.uri, codecs: v.codecs })),
                segments: m.segments.map(s => ({ url: s.uri, duration: s.duration, sequence: s.sequence })),
                duration: m.totalDuration, isLive: m.isLive, isEncrypted: m.isEncrypted,
                initSegmentUrl: m.initSegmentUrl, hasAudioTrack: m.hasAudioTrack,
              },
            };
          }

          if (/\.m3u8(\?|#|$)/.test(urlLower)) {
            const { fetchAndParseM3U8 } = await import('./m3u8-parser.js');
            const m = await fetchAndParseM3U8(url, mergedHeaders);
            return {
              success: true,
              data: {
                streamType: 'hls' as const, isMasterPlaylist: m.type === 'master',
                variants: m.variants.map(v => ({ bandwidth: v.bandwidth, resolution: v.resolution, url: v.uri, codecs: v.codecs })),
                segments: m.segments.map((s, i) => ({ url: s.uri, duration: s.duration, sequence: i })),
                duration: m.totalDuration, isLive: m.isLive, isEncrypted: m.isEncrypted ?? false,
              },
            };
          }

          const { safeFetchText: fetchText } = await import('./safe-fetch.js');
          const content = await fetchText(url, { headers: mergedHeaders, timeout: 15_000 });
          const trimmed = content.trimStart();

          if (trimmed.startsWith('<?xml') || trimmed.includes('<MPD')) {
            const { parseMPD } = await import('./mpd-parser.js');
            const m = parseMPD(content, url);
            return {
              success: true,
              data: {
                streamType: 'dash' as const, isMasterPlaylist: m.variants.length > 1,
                variants: m.variants.map(v => ({ bandwidth: v.bandwidth, resolution: v.resolution, url: v.uri, codecs: v.codecs })),
                segments: m.segments.map(s => ({ url: s.uri, duration: s.duration, sequence: s.sequence })),
                duration: m.totalDuration, isLive: m.isLive, isEncrypted: m.isEncrypted,
                initSegmentUrl: m.initSegmentUrl, hasAudioTrack: m.hasAudioTrack,
              },
            };
          }

          const { parseM3U8: parseHls } = await import('./m3u8-parser.js');
          const m = parseHls(content, url);
          return {
            success: true,
            data: {
              streamType: 'hls' as const, isMasterPlaylist: m.type === 'master',
              variants: m.variants.map(v => ({ bandwidth: v.bandwidth, resolution: v.resolution, url: v.uri, codecs: v.codecs })),
              segments: m.segments.map((s, i) => ({ url: s.uri, duration: s.duration, sequence: i })),
              duration: m.totalDuration, isLive: m.isLive, isEncrypted: m.isEncrypted ?? false,
            },
          };
        } catch (err: any) {
          return { success: false, error: err?.message || String(err) };
        }
      },

      probeMedia: async (input) => {
        try {
          const page = this.getPage(input.viewId);
          const startTime = Date.now();

          const elements = await page.evaluate(() => {
            function videoDetails(el: Element, isVideo: boolean) {
              if (!isVideo) return { videoWidth: undefined, videoHeight: undefined, poster: undefined };
              const video = el as HTMLVideoElement;
              return { videoWidth: video.videoWidth, videoHeight: video.videoHeight, poster: video.poster || undefined };
            }
            function playbackDetails(media: HTMLMediaElement, bufferedEnd: number) {
              return { duration: Number.isFinite(media.duration) ? media.duration : undefined, isPlaying: !media.paused && !media.ended && media.readyState > 2, isPaused: media.paused, currentTime: media.currentTime || undefined, buffered: bufferedEnd || undefined };
            }
            function snapshotMedia(el: Element) {
              const media = el as HTMLMediaElement;
              const isVideo = el.tagName.toLowerCase() === 'video';
              const sources = [...el.querySelectorAll('source')].map(source => source.src).filter(Boolean);
              let bufferedEnd = 0;
              try { if (media.buffered.length > 0) bufferedEnd = media.buffered.end(media.buffered.length - 1); } catch { /* ignore */ }
              return { tagName: el.tagName.toLowerCase(), currentSrc: media.currentSrc || '', sources, ...videoDetails(el, isVideo), ...playbackDetails(media, bufferedEnd), usesMediaSource: !!(media as any).srcObject || (media.currentSrc || '').startsWith('blob:'), inferredCategory: isVideo ? 'video' : 'audio' };
            }
            const results: Array<{
              tagName: string; currentSrc: string; sources: string[];
              videoWidth?: number; videoHeight?: number; duration?: number;
              usesMediaSource?: boolean; poster?: string;
              isPlaying?: boolean; isPaused?: boolean;
              currentTime?: number; buffered?: number; inferredCategory?: string;
            }> = [];

            document.querySelectorAll('video, audio').forEach((el) => {
              results.push(snapshotMedia(el));
            });
            return results;
          });

          return { success: true, data: { elements, pageUrl: page.url(), probeTimeMs: Date.now() - startTime } };
        } catch (err: any) {
          return { success: false, error: err?.message || String(err) };
        }
      },

      downloadStream: async (input) => {
        const downloadId = `stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        try {
          const url = resolveResourceUrl(input);
          if (!url) return { success: false, downloadId, error: 'url or valid resourceId required' };

          const authHeaders = await getAuthHeaders(url, input.viewId);
          const mergedHeaders = { ...authHeaders, ...(input.headers ?? {}) };

          const manifest = await resolveDownloadManifest(url, mergedHeaders, input.quality);
          if (manifest.error) return { success: false, downloadId, error: manifest.error, errorCode: 'STREAM_ENCRYPTED' };
          const segments = manifest.segments || [];
          if (!segments.length) return { success: false, downloadId, error: 'No segments found in stream manifest' };

          const { downloadStream: dlStream } = await import('./stream-downloader.js');
          const outputPath = input.filename ? join(getHomeTabtinPath('downloads'), input.filename) : undefined;
          const startMs = Date.now();
          const result = await dlStream(segments, {
            outputPath, concurrency: input.concurrency ?? 3, headers: mergedHeaders, initSegmentUrl: manifest.initSegmentUrl,
          });

          return {
            success: result.success,
            downloadId,
            data: result.path ? {
              filePath: result.path, size: result.totalSize,
              duration: result.duration, segmentCount: result.segments, elapsedMs: Date.now() - startMs,
            } : undefined,
            error: result.error,
          };
        } catch (err: any) {
          return { success: false, downloadId, error: err?.message || String(err) };
        }
      },
    });

    // ═══════ Network Bridge (route 拦截规则) ═══════
    // network/console 历史改由 attachRuntimeLogCapture 喂进 browser-core 共享缓冲
    // （BR-8 P3b），这里只负责 route/unroute 拦截规则的 Patchright route 应用。

    const {
      setOnRulesChanged,
      getRouteRules,
    } = await import('@tabtin/action-tools/tools');

    setOnRulesChanged(async (tabId: string) => {
      const pageEntry = this.pages.get(tabId);
      if (!pageEntry || pageEntry.page.isClosed()) return;
      const page = pageEntry.page;

      const prev = this._pageRouteHandlers.get(tabId);
      if (prev) {
        await page.unroute('**/*', prev).catch(() => {});
        this._pageRouteHandlers.delete(tabId);
      }

      const rules = getRouteRules(tabId);
      if (rules.length === 0) return;

      const handler = async (route: import('patchright-core').Route) => {
        try {
          const requestUrl = route.request().url();
          const matched = rules.find(r => {
            try { return new RegExp(r.urlPattern).test(requestUrl); }
            catch { return requestUrl.includes(r.urlPattern); }
          });

          if (matched) {
            await route.fulfill({
              status: matched.status ?? 200,
              body: matched.body ?? '',
              headers: matched.headers,
            });
          } else {
            // fallback to next handler (context-level SSRF interception)
            await route.fallback();
          }
        } catch {
          try { await route.continue(); } catch { /* request may be cancelled */ }
        }
      };

      this._pageRouteHandlers.set(tabId, handler);
      await page.route('**/*', handler);
    });

    this.logger.info('[Browser] Runtime bridge APIs injected (CrawlView, Screenshot, Pdf, Markdown, RunSession, ViewFactory, HttpCrawl, ResourceDetection, NetworkBridge)');
  }

  // ═══════ browser-core Bridge ═══════

  /**
   * 初始化 browser-core 桥接层，使 BrowserToolImpl 及其子服务
   * 通过 BrowserContext 接口在 Daemon 环境下运行。
   */
  async initBrowserCore(): Promise<void> {
    const { getSharedBrowserToolImpl, setBrowserCoreBridge, getSharedNetworkLog, getSharedConsoleLog } =
      await import('@tabtin/browser-core');
    const { cleanHtml, generateSkeletonHtml, filterHtmlByContentTypes, parseContentTypeWhitelist } =
      await import('@tabtin/action-tools/impl');
    const impl = getSharedBrowserToolImpl();

    // BR-8 WS-B：拿到 browser-core 的共享历史缓冲，供 attachRuntimeLogCapture 喂数据。
    this._networkLog = getSharedNetworkLog();
    this._consoleLog = getSharedConsoleLog();

    impl.setContextFactory((tabId: string) => {
      const existing = this.contexts.get(tabId);
      if (existing && existing.isAlive()) return existing;

      const entry = this.pages.get(tabId);
      if (!entry || entry.page.isClosed()) return null;

      const ctx = new DaemonBrowserContext(entry.page);
      ctx.init().catch(() => {});
      this.contexts.set(tabId, ctx);
      // 惰性重建的 context 也补挂日志捕获（BR-8 WS-B）。页面已加载完，
      // 此后的请求/控制台仍进缓冲；fire-and-forget，不阻塞工厂返回。
      void attachRuntimeLogCapture(ctx, tabId, { networkLog: this._networkLog, consoleLog: this._consoleLog });
      return ctx;
    });

    setBrowserCoreBridge({
      viewFactory: {
        getCurrentViewId: () => this.activeTabId,
        getViewState: (viewId: string) => {
          const entry = this.pages.get(viewId);
          if (!entry || entry.page.isClosed()) return undefined;
          try {
            return { url: entry.page.url(), config: { metadata: { url: entry.page.url() } } };
          } catch { return undefined; }
        },
      },
      htmlCleaner: {
        cleanHtml: (html: string) => cleanHtml(html),
        generateSkeletonHtml: (html: string) => generateSkeletonHtml(html),
        filterHtmlByContentTypes: (html: string, includeTypes: string[]) =>
          filterHtmlByContentTypes(html, parseContentTypeWhitelist(includeTypes) ?? new Set()),
      },
    });

    this.browserCoreReady = true;
    this.logger.info('[Browser] browser-core bridge initialized (BrowserToolImpl ready via BrowserContext)');
  }

  isBrowserCoreReady(): boolean {
    return this.browserCoreReady;
  }

  getBrowserContext(tabId: string): DaemonBrowserContext | null {
    return this.contexts.get(tabId) ?? null;
  }

  // ═══════ Runtime log capture (BR-8 WS-B / P3b) ═══════
  // 挂载逻辑已收编进 browser-core 的共享 `attachRuntimeLogCapture`（双端同一实现），
  // 各 openTab 路径在导航前 await 调用它；此处只保留查询 + 清理。

  /** 查询某 tab 的网络历史（/network 路由用）。 */
  queryNetworkLog(tabId: string, query?: NetworkLogQuery): NetworkLogEntry[] {
    return this._networkLog?.query(tabId, query) ?? [];
  }

  /** 查询某 tab 的控制台历史（/console 路由用）。 */
  queryConsoleLog(tabId: string, query?: ConsoleLogQuery): ConsoleLogEntry[] {
    return this._consoleLog?.query(tabId, query) ?? [];
  }

  private clearRuntimeLogCapture(tabId: string): void {
    this._networkLog?.clear(tabId);
    this._consoleLog?.clear(tabId);
  }

  // ═══════ Lifecycle ═══════

  private async evictOldestPage(): Promise<void> {
    let oldest: [string, PageEntry] | null = null;
    let oldestFallback: [string, PageEntry] | null = null;
    for (const entry of this.pages) {
      if (!oldestFallback || entry[1].lastUsed < oldestFallback[1].lastUsed) {
        oldestFallback = entry;
      }
      if (entry[0] === this.activeTabId) continue;
      if (!oldest || entry[1].lastUsed < oldest[1].lastUsed) {
        oldest = entry;
      }
    }

    if (oldest) {
      this.logger.info(`[Browser] Evicting idle tab ${oldest[0]}`);
      await this.closeTab(oldest[0]);
      return;
    }

    if (!oldestFallback) return;

    // 没有非活跃标签可淘汰 — 检查活跃标签是否正在加载，加载中拒绝淘汰
    try {
      if (!oldestFallback[1].page.isClosed()) {
        const readyState = await oldestFallback[1].page
          .evaluate(() => document.readyState)
          .catch(() => 'complete');
        if (readyState !== 'complete') {
          throw new Error(
            `Cannot evict active tab ${oldestFallback[0]}: page is still loading (readyState=${readyState}). ` +
            `All ${this.pages.size} tab slots are in use. Max: ${MAX_PAGES}.`,
          );
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Cannot evict')) throw err;
    }

    this.logger.warn(`[Browser] No inactive tabs available, evicting active tab ${oldestFallback[0]}`);
    await this.closeTab(oldestFallback[0]);
  }

  private startIdleCleanup(): void {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => {
      void this.runIdleCleanupCycle();
    }, 60_000);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  private async runIdleCleanupCycle(): Promise<void> {
    const now = Date.now();
    const candidates: string[] = [];
    for (const [id, entry] of this.pages) {
      const idleLimit = id === this.activeTabId ? ACTIVE_TAB_IDLE_MS : PAGE_IDLE_MS;
      if (now - entry.lastUsed > idleLimit) candidates.push(id);
    }

    for (const id of candidates) {
      const entry = this.pages.get(id);
      if (!entry || entry.page.isClosed()) continue;

      try {
        const readyState = await entry.page
          .evaluate(() => document.readyState)
          .catch(() => 'complete' as const);
        if (readyState !== 'complete') {
          this.logger.info(`[Browser] Skipping idle cleanup for tab ${id}: page still loading (readyState=${readyState})`);
          continue;
        }
      } catch {
        // evaluate 失败 — 页面可能已不可用，允许关闭
      }

      await this.closeTab(id).catch(() => {});
    }

    if (this.pages.size === 0 && this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
  }

  // ═══════ Session Management ═══════

  async createSession(name: string, contextOptions?: {
    proxy?: { server: string; username?: string; password?: string };
    userAgent?: string;
  }): Promise<{ name: string; tabCount: number }> {
    if (this.sessions.has(name)) {
      const session = this.sessions.get(name)!;
      return { name, tabCount: session.tabIds.size };
    }
    const browser = await this.ensureBrowser();
    const sessionContext = await browser.newContext(buildDefaultContextOptions({
      ...(contextOptions?.proxy ? { proxy: contextOptions.proxy } : {}),
      ...(contextOptions?.userAgent ? { userAgent: contextOptions.userAgent } : {}),
    }));
    await this.installSsrfInterception(sessionContext);
    this.sessions.set(name, {
      name,
      context: sessionContext,
      tabIds: new Set(),
      createdAt: Date.now(),
    });
    if (!this.activeSessionName) {
      this.activeSessionName = name;
    }
    if (contextOptions?.proxy) {
      this.logger.info(`[Proxy] Session "${name}" 使用代理: ${contextOptions.proxy.server}`);
    }
    this.logger.info(`[Browser] Session created: ${name}`);
    return { name, tabCount: 0 };
  }

  switchSession(name: string): void {
    if (!this.sessions.has(name)) {
      throw new Error(`Session "${name}" not found`);
    }
    this.activeSessionName = name;
    this.logger.info(`[Browser] Session switched to: ${name}`);
  }

  async closeSession(name: string): Promise<void> {
    const session = this.sessions.get(name);
    if (!session) throw new Error(`Session "${name}" not found`);

    for (const tabId of session.tabIds) {
      await this.closeTab(tabId).catch(() => {});
      this.tabToSession.delete(tabId);
    }

    await session.context.close().catch(() => {});
    this.sessions.delete(name);

    if (this.activeSessionName === name) {
      this.activeSessionName = this.sessions.size > 0
        ? this.sessions.keys().next().value ?? null
        : null;
    }
    this.logger.info(`[Browser] Session closed: ${name}`);
  }

  listSessions(): Array<{ name: string; tabCount: number; active: boolean; createdAt: number }> {
    const result: Array<{ name: string; tabCount: number; active: boolean; createdAt: number }> = [];
    for (const [name, session] of this.sessions) {
      result.push({
        name,
        tabCount: session.tabIds.size,
        active: name === this.activeSessionName,
        createdAt: session.createdAt,
      });
    }
    return result;
  }

  getActiveSessionName(): string | null {
    return this.activeSessionName;
  }

  async openTabInSession(sessionName: string, options?: { url?: string; settle?: boolean }): Promise<string> {
    const session = this.sessions.get(sessionName);
    if (!session) throw new Error(`Session "${sessionName}" not found`);

    const release = await this._openTabMutex.acquire(30_000);
    try {
      if (options?.url) {
        validateUrl(options.url);
      }

      if (this.pages.size >= MAX_PAGES) {
        await this.evictOldestPage();
      }

      const page = await session.context.newPage();
      const tabId = this.generateTabId();

      const entry: PageEntry = {
        page,
        ownContext: null,
        createdAt: Date.now(),
        lastUsed: Date.now(),
      };
      this.pages.set(tabId, entry);
      this.attachPageLifecycleListeners(tabId, page);
      this.initResourceTracker(entry).catch(() => {});
      this.activeTabId = tabId;
      session.tabIds.add(tabId);
      this.tabToSession.set(tabId, sessionName);

      // 导航前就建好 BrowserContext 并挂常驻日志捕获，确保首屏请求/控制台进缓冲（BR-8 WS-B）
      const ctx = new DaemonBrowserContext(page);
      this.contexts.set(tabId, ctx);
      await attachRuntimeLogCapture(ctx, tabId, { networkLog: this._networkLog, consoleLog: this._consoleLog });
      await ctx.init();

      if (options?.url) {
        try {
          await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          // 与 loadUrl / browser open 的 settled 契约对齐：默认等 DOM 稳定作为「内容就绪」信号。
          if (options.settle !== false) {
            await waitForDomSettle(page, DAEMON_DOM_SETTLE_QUIET_MS, DAEMON_DOM_SETTLE_MAX_MS);
          }
        } catch (err) {
          await this.closeTab(tabId).catch(() => {});
          throw err;
        }
      }

      this.startIdleCleanup();
      this.logger.info(`[Browser] Opened tab ${tabId} in session "${sessionName}"${options?.url ? ` → ${options.url}` : ''}`);
      return tabId;
    } finally {
      release();
    }
  }

  // ═══════ Page Lifecycle Monitoring ═══════

  private attachPageLifecycleListeners(tabId: string, page: import('patchright-core').Page): void {
    page.on('crash', () => {
      this.logger.error(`[Browser] Page ${tabId} crashed, cleaning up`);
      this.cleanupDeadPage(tabId);
      this.emit('page:crashed', { tabId });
    });
    page.on('close', () => {
      if (this.pages.has(tabId)) {
        this.logger.warn(`[Browser] Page ${tabId} closed unexpectedly`);
        this.cleanupDeadPage(tabId);
      }
    });

    // BR-8 P3b：network/console 历史由 attachRuntimeLogCapture 经 CDP onCDPEvent
    // 常驻喂进 browser-core 共享缓冲，不再用 Patchright page.on('response'/'console')
    // 写 action-tools 并行 Map（避免双端双实现 + daemon 内 CLI/FC 读不同源）。
  }

  private cleanupDeadPage(tabId: string): void {
    const ctx = this.contexts.get(tabId);
    if (ctx) {
      ctx.detach().catch(() => {});
      this.contexts.delete(tabId);
    }
    this.clearRuntimeLogCapture(tabId);

    const entry = this.pages.get(tabId);
    entry?.resourceTracker?.detach();
    if (entry?.ownContext) {
      entry.ownContext.close().catch(() => {});
    }

    this.pages.delete(tabId);
    this._pageRouteHandlers.delete(tabId);
    if (this.activeTabId === tabId) {
      const remaining = [...this.pages.keys()];
      this.activeTabId = remaining.length > 0 ? remaining[remaining.length - 1] : null;
    }

    const sessionName = this.tabToSession.get(tabId);
    if (sessionName) {
      this.tabToSession.delete(tabId);
      const session = this.sessions.get(sessionName);
      if (session) session.tabIds.delete(tabId);
    }
  }

  // ═══════ Memory Monitoring ═══════

  async getBrowserMemoryUsage(): Promise<{
    jsHeapUsedSize: number;
    jsHeapTotalSize: number;
    pageCount: number;
  } | null> {
    if (!this.browser?.isConnected() || this.pages.size === 0) return null;

    let totalHeapUsed = 0;
    let totalHeapTotal = 0;
    let sampledCount = 0;

    for (const [, entry] of this.pages) {
      if (entry.page.isClosed()) continue;
      try {
        const client = await entry.page.context().newCDPSession(entry.page);
        try {
          const result = await client.send('Performance.getMetrics') as {
            metrics: Array<{ name: string; value: number }>;
          };
          const metrics = result.metrics;
          totalHeapUsed += metrics.find(m => m.name === 'JSHeapUsedSize')?.value ?? 0;
          totalHeapTotal += metrics.find(m => m.name === 'JSHeapTotalSize')?.value ?? 0;
          sampledCount++;
        } finally {
          await client.detach().catch(() => {});
        }
      } catch {
        continue;
      }
    }

    if (sampledCount === 0) return null;
    return { jsHeapUsedSize: totalHeapUsed, jsHeapTotalSize: totalHeapTotal, pageCount: this.pages.size };
  }

  // ═══════ Dispose ═══════

  async dispose(): Promise<void> {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }

    const tabIds = [...this.pages.keys()];
    for (const id of tabIds) {
      await this.closeTab(id).catch(() => {});
    }

    for (const [name, session] of this.sessions) {
      await session.context.close().catch(() => {});
    }
    this.sessions.clear();
    this.tabToSession.clear();
    this.activeSessionName = null;

    try {
      const { setOnRulesChanged } = await import('@tabtin/action-tools/tools');
      setOnRulesChanged(null);
    } catch { /* non-critical */ }
    this._pageRouteHandlers.clear();
    this._networkLog = undefined;
    this._consoleLog = undefined;

    this.browserCoreReady = false;

    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }

    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }

    this.logger.info('[Browser] Service disposed');
  }
}

// ── Singleton access (used by CLI routes) ────────────────────────
