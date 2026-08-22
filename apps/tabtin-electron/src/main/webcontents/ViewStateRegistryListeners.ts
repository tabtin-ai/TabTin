/**
 * ViewStateRegistry — 事件监听器工厂
 *
 * 创建绑定到特定 View 的 webContents 事件监听器集合。
 * 通过依赖注入（callbacks）解耦与 ViewStateRegistry 内部状态的关系。
 */

import type { WebContents } from 'electron';
import type { LoadEvent, ViewState, ViewEventListeners } from './ViewStateRegistryTypes';
import { dispatchAutofillDomReady } from '../credential-vault/autofill-dom-ready-port';
import { getAppDiscoveryService } from '../services/AppDiscoveryService';
import { BrowserWindow } from 'electron';
import { createLogger } from '../logger';

const log = createLogger('ViewStateRegistry');

const HTTP_ERROR_PAGE_VISIBLE_CONTENT_SCRIPT = `(() => {
  const isVisible = (element) => {
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const body = document.body;
  if (!body || !isVisible(body)) return false;
  if (body.innerText.trim().length > 0) return true;

  if (Array.from(document.querySelectorAll('img, svg, canvas, video, iframe')).some((element) => isVisible(element))) {
    return true;
  }

  return Array.from(document.querySelectorAll('*')).some((element) =>
    isVisible(element) && window.getComputedStyle(element).backgroundImage !== 'none'
  );
})()`;

function shouldProbeHttpErrorPage(httpResponseCode: number): boolean {
  return httpResponseCode === 404 || (httpResponseCode >= 500 && httpResponseCode <= 599);
}

/**
 * 诊断日志用的 URL 脱敏：只保留 origin + pathname，丢弃 query/hash，
 * 避免把 URL 里可能携带的 token / 会话参数写入诊断包（main.log）。
 */
function safeUrlForLog(raw: string | undefined): string {
  if (!raw) return '<none>';
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}${u.search ? '?…' : ''}`;
  } catch {
    return '<invalid-url>';
  }
}

export interface ListenerCallbacks {
  getState: (id: string) => ViewState | undefined;
  updateState: (id: string, updates: Partial<ViewState>) => void;
  scheduleFaviconResolve: (
    id: string,
    wc: WebContents,
    opts: { favicons?: string[]; allowDom?: boolean; force?: boolean; reason?: string }
  ) => void;
  emitLoaded: (data: { id: string; url: string; title: string; timestamp: number }) => void;
  emitError: (data: { id: string; errorCode: number; errorDescription: string }) => void;
  debug: (...args: any[]) => void;
  maxHistory: number;
}

function getFaviconOwnerKey(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function shouldClearFaviconForNavigation(previousUrl: string | undefined, nextUrl: string): boolean {
  const nextOwner = getFaviconOwnerKey(nextUrl);
  if (!nextOwner) return false;
  return getFaviconOwnerKey(previousUrl) !== nextOwner;
}

function buildNavigationUpdates(
  state: ViewState | undefined,
  url: string,
): Partial<ViewState> {
  const updates: Partial<ViewState> = { url };
  if (shouldClearFaviconForNavigation(state?.url, url)) {
    updates.favicon = undefined;
  }
  return updates;
}

/**
 * 创建一组 webContents 事件监听器并附加到 webContents 上。
 *
 * 返回监听器引用，供 unregister 时移除。
 */
export function createAndAttachListeners(
  id: string,
  webContents: WebContents,
  cb: ListenerCallbacks
): ViewEventListeners {
  let navigationGeneration = 0;
  let pendingHttpError: { url: string; statusCode: number; generation: number } | undefined;

  const reportHttpError = (url: string, httpResponseCode: number) => {
    const errorDescription = `HTTP ${httpResponseCode}`;
    const state = cb.getState(id);
    if (state) {
      const loadEvent: LoadEvent = { url: url || state.url, timestamp: Date.now(), success: false };
      state.loadHistory.push(loadEvent);
      if (state.loadHistory.length > cb.maxHistory) {
        state.loadHistory.shift();
      }
    }

    log.warn('View 状态登记为 HTTP 错误', {
      id,
      httpResponseCode,
      errorDescription,
      url: safeUrlForLog(url),
    });
    cb.updateState(id, { status: 'error', lastErrorDescription: errorDescription, url: url || undefined });
    cb.emitError({ id, errorCode: httpResponseCode, errorDescription });
  };

  const onStartLoading = () => {
    navigationGeneration += 1;
    pendingHttpError = undefined;
    const state = cb.getState(id);
    if (state) {
      (state as any)._loadStartedAt = Date.now();
    }
    cb.updateState(id, { status: 'loading' });
    log.debug(`🔄 开始加载: id=${id}`);
  };

  const onFinishLoad = () => {
    const url = webContents.getURL();
    const title = webContents.getTitle();
    const now = Date.now();

    const state = cb.getState(id);
    if (state) {
      const loadEvent: LoadEvent = {
        url,
        timestamp: now,
        duration: (state as any)._loadStartedAt ? now - (state as any)._loadStartedAt : undefined,
        success: true
      };
      state.loadHistory.push(loadEvent);
      if (state.loadHistory.length > cb.maxHistory) {
        state.loadHistory.shift();
      }
    }

    cb.updateState(id, { status: 'loaded', url, title, lastLoadTime: now });
    cb.scheduleFaviconResolve(id, webContents, { allowDom: true, reason: 'finish-load' });

    setTimeout(() => {
      cb.scheduleFaviconResolve(id, webContents, { allowDom: true, force: true, reason: 'finish-load-delayed' });
    }, 1500);

    log.info(`✅ 加载完成: id=${id}, url=${safeUrlForLog(url)}`);
    cb.emitLoaded({ id, url, title, timestamp: now });

    try {
      const mainWindow = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
      getAppDiscoveryService().checkUrl(url, mainWindow ?? null);
    } catch { /* best-effort */ }

    const pending = pendingHttpError;
    pendingHttpError = undefined;
    if (!pending || pending.url !== url) return;

    const isCurrentNavigation = () =>
      pending.generation === navigationGeneration && webContents.getURL() === pending.url;
    const showTabWebFallback = () => {
      if (isCurrentNavigation()) {
        reportHttpError(pending.url, pending.statusCode);
      }
    };

    void webContents.executeJavaScript(HTTP_ERROR_PAGE_VISIBLE_CONTENT_SCRIPT)
      .then((hasVisibleContent) => {
        if (hasVisibleContent !== true) showTabWebFallback();
      })
      .catch(showTabWebFallback);
  };

  const onFailLoad = (
    _event: any,
    errorCode: number,
    errorDescription: string,
    validatedURL?: string,
    isMainFrame = true,
    frameProcessId?: number,
    frameRoutingId?: number,
  ) => {
    if (errorCode === -3) {
      log.debug(`ℹ️  加载被主动停止（忽略）: id=${id}`);
      return;
    }

    if (!isMainFrame) {
      log.warn('View 子 frame 加载失败（不改变主页面状态）', {
        id,
        errorCode,
        errorDescription,
        url: safeUrlForLog(validatedURL),
        currentMainUrl: safeUrlForLog(webContents.getURL()),
        frameProcessId,
        frameRoutingId,
      });
      return;
    }

    pendingHttpError = undefined;

    const state = cb.getState(id);
    if (state) {
      const loadEvent: LoadEvent = { url: validatedURL || state.url, timestamp: Date.now(), success: false };
      state.loadHistory.push(loadEvent);
      if (state.loadHistory.length > cb.maxHistory) {
        state.loadHistory.shift();
      }
    }

    const currentMainUrl = webContents.getURL();
    log.warn('View 状态登记为加载失败', {
      id,
      errorCode,
      errorDescription,
      url: safeUrlForLog(validatedURL),
      currentMainUrl: safeUrlForLog(currentMainUrl),
      isMainFrame,
      frameProcessId,
      frameRoutingId,
      previousStatus: state?.status,
    });
    cb.updateState(id, { status: 'error', lastErrorDescription: errorDescription });
    cb.emitError({ id, errorCode, errorDescription });
  };

  const onFrameNavigate = (
    _event: any,
    url: string,
    httpResponseCode: number,
    _httpStatusText: string,
    isMainFrame = true,
  ) => {
    if (!isMainFrame) return;
    if (typeof httpResponseCode !== 'number' || httpResponseCode < 400) return;

    if (shouldProbeHttpErrorPage(httpResponseCode)) {
      pendingHttpError = { url, statusCode: httpResponseCode, generation: navigationGeneration };
      return;
    }

    reportHttpError(url, httpResponseCode);
  };

  const onStopLoading = () => {
    const state = cb.getState(id);
    if (state && state.status === 'loading') {
      const url = webContents.getURL();
      const title = webContents.getTitle();
      cb.updateState(id, { status: 'loaded', url, title, lastLoadTime: Date.now() });
      log.debug(`⏸️  停止加载: id=${id}, url=${safeUrlForLog(url)}`);
    }
  };

  const onDomReady = () => {
    const url = webContents.getURL();
    const title = webContents.getTitle();
    const state = cb.getState(id);
    if (state && state.status === 'loading') {
      cb.updateState(id, { status: 'loaded', url, title, lastLoadTime: Date.now() });
      log.debug(`⚡️ DOM 就绪，标记已加载: id=${id}, url=${safeUrlForLog(url)}`);
    }
    cb.scheduleFaviconResolve(id, webContents, { allowDom: true, reason: 'dom-ready' });
    dispatchAutofillDomReady(id, webContents).catch(() => {/* autofill best-effort */});
  };

  const onTitleUpdated = (_event: any, title: string) => {
    const url = webContents.getURL();
    cb.updateState(id, { title, url });
  };

  const onFaviconUpdated = (_event: any, favicons: string[]) => {
    if (!favicons || favicons.length === 0) return;
    cb.scheduleFaviconResolve(id, webContents, {
      favicons,
      allowDom: false,
      force: true,
      reason: 'page-favicon-updated'
    });
  };

  const onNavigate = (_event: any, url: string) => {
    if (url) cb.updateState(id, buildNavigationUpdates(cb.getState(id), url));
  };

  const onInPageNavigate = (_event: any, url: string) => {
    if (url) cb.updateState(id, { url });
  };

  const onWillNavigate = (_event: any, url: string) => {
    if (url) cb.updateState(id, buildNavigationUpdates(cb.getState(id), url));
  };

  webContents.on('did-start-loading', onStartLoading);
  webContents.on('did-finish-load', onFinishLoad);
  webContents.on('did-fail-load', onFailLoad);
  webContents.on('did-frame-navigate', onFrameNavigate);
  webContents.on('did-stop-loading', onStopLoading);
  webContents.on('dom-ready', onDomReady);
  webContents.on('page-title-updated', onTitleUpdated);
  webContents.on('page-favicon-updated', onFaviconUpdated);
  webContents.on('did-navigate', onNavigate);
  webContents.on('did-navigate-in-page', onInPageNavigate);
  webContents.on('will-navigate', onWillNavigate);

  cb.debug('attachListeners: 事件监听器已附加', { id });

  return {
    onStartLoading,
    onFinishLoad,
    onFailLoad,
    onFrameNavigate,
    onStopLoading,
    onDomReady,
    onTitleUpdated,
    onFaviconUpdated,
    onNavigate,
    onInPageNavigate,
    onWillNavigate
  };
}

/**
 * 从 webContents 上移除之前附加的全部监听器
 */
export function detachListeners(webContents: WebContents, listeners: ViewEventListeners): void {
  webContents.removeListener('did-start-loading', listeners.onStartLoading);
  webContents.removeListener('did-finish-load', listeners.onFinishLoad);
  webContents.removeListener('did-fail-load', listeners.onFailLoad);
  webContents.removeListener('did-frame-navigate', listeners.onFrameNavigate);
  webContents.removeListener('did-stop-loading', listeners.onStopLoading);
  webContents.removeListener('dom-ready', listeners.onDomReady);
  webContents.removeListener('page-title-updated', listeners.onTitleUpdated);
  webContents.removeListener('page-favicon-updated', listeners.onFaviconUpdated);
  webContents.removeListener('did-navigate', listeners.onNavigate);
  webContents.removeListener('did-navigate-in-page', listeners.onInPageNavigate);
  webContents.removeListener('will-navigate', listeners.onWillNavigate);
}
