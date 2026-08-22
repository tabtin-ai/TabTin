import {
  ipcMain,
  type BrowserWindow,
  type IpcMainEvent,
  type WebContents,
} from 'electron';
import { isTrustedSender } from '../auth';
import { createLogger } from '../logger';

const log = createLogger('ContextSpaceBridge');

type ContextSpaceInvokePayload = {
  requestId: string;
  action: string;
  payload: any;
};

type ContextSpaceResponsePayload = {
  requestId: string;
  success: boolean;
  data?: any;
  error?: string;
};

type PendingRequest = {
  resolve: (value: ContextSpaceResponsePayload) => void;
  reject: (error: Error) => void;
  sender: WebContents;
  cleanup: () => void;
};

type ReadyWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};

type WebContentsLifecycleHandlers = {
  reload: (event: unknown, ...args: unknown[]) => void;
  destroyed: () => void;
};

type DidStartNavigationDetails = {
  isMainFrame?: boolean;
  isSameDocument?: boolean;
};

/**
 * /#6774 live 回归修正：判定「主窗 renderer 上下文即将销毁」不能用
 * did-start-loading——<webview> 是宿主页面里的特殊 iframe，挂载/内部导航都会
 * 触发宿主 webContents 的 did-start-loading（isMainFrame=false），create_web_tab
 * 的「创建即后台挂载」会掐断自己的响应（mainWindow unavailable 假错）。
 * 只有主 frame 的真实导航（非 same-document）才意味着 pending 请求不会再有响应。
 */
function isMainFrameRealNavigation(details: unknown): boolean {
  const d = details as DidStartNavigationDetails | undefined;
  return d?.isMainFrame === true && d?.isSameDocument !== true;
}

export class ContextSpaceToolBridge {
  private pending = new Map<string, PendingRequest>();
  private readyWaiters = new Map<WebContents, Set<ReadyWaiter>>();
  private readyWebContents = new WeakSet<WebContents>();
  private lifecycleHandlers = new Map<WebContents, WebContentsLifecycleHandlers>();
  private activeInvocations = new Set<AbortController>();
  private listening = false;
  private disposed = false;

  constructor(
    private readonly ensureMainWindow: (
      signal?: AbortSignal,
    ) => Promise<BrowserWindow | null>,
  ) {}

  private ensureListener(): void {
    if (this.disposed) {
      throw new Error('ContextSpaceToolBridge has been destroyed');
    }
    if (this.listening) return;
    ipcMain.on('context-space:response', this.handleResponse);
    ipcMain.on('context-space:ready', this.handleReady);
    this.listening = true;
  }

  private handleResponse = (_event: IpcMainEvent, payload: ContextSpaceResponsePayload) => {
    if (!isTrustedSender(_event)) {
      log.warn('context-space:response 来自不受信任来源，已丢弃');
      return;
    }
    const request = this.pending.get(payload.requestId);
    if (!request) return;
    if (_event.sender !== request.sender) {
      log.warn(`context-space:response sender 不匹配 requestId=${payload.requestId}`);
      return;
    }
    request.cleanup();
    this.pending.delete(payload.requestId);
    request.resolve(payload);
  };

  private handleReady = (event: IpcMainEvent) => {
    if (!isTrustedSender(event)) {
      log.warn('context-space:ready 来自不受信任来源，已丢弃');
      return;
    }

    const webContents = event.sender;
    this.readyWebContents.add(webContents);
    if (!this.lifecycleHandlers.has(webContents)) {
      const reload = (details: unknown) => {
        if (!isMainFrameRealNavigation(details)) return;
        this.readyWebContents.delete(webContents);
      };
      const destroyed = () => {
        this.readyWebContents.delete(webContents);
        webContents.removeListener('did-start-navigation', reload);
        this.lifecycleHandlers.delete(webContents);
      };
      this.lifecycleHandlers.set(webContents, { reload, destroyed });
      webContents.on('did-start-navigation', reload);
      webContents.once('destroyed', destroyed);
    }

    const waiters = this.readyWaiters.get(webContents);
    if (!waiters) return;
    this.readyWaiters.delete(webContents);
    for (const waiter of waiters) {
      waiter.resolve();
    }
  };

  private waitForRendererReady(
    webContents: WebContents,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    if (this.readyWebContents.has(webContents)) {
      return Promise.resolve();
    }
    if (webContents.isDestroyed()) {
      return Promise.reject(new Error('mainWindow unavailable'));
    }

    this.ensureListener();
    return new Promise((resolve, reject) => {
      const waiters = this.readyWaiters.get(webContents) ?? new Set<ReadyWaiter>();
      const cleanup = () => {
        signal.removeEventListener('abort', handleAbort);
        webContents.removeListener('destroyed', handleUnavailable);
        webContents.removeListener('did-start-navigation', handleNavigation);
        waiters.delete(waiter);
        if (waiters.size === 0) this.readyWaiters.delete(webContents);
      };
      const handleAbort = () => {
        cleanup();
        reject(signal.reason);
      };
      const handleUnavailable = () => {
        waiter.reject(new Error('mainWindow unavailable'));
      };
      // 子 frame（含 <webview> 挂载）导航不算主窗失效，必须持续监听而非 once
      const handleNavigation = (details: unknown) => {
        if (!isMainFrameRealNavigation(details)) return;
        handleUnavailable();
      };
      const waiter: ReadyWaiter = {
        resolve: () => {
          cleanup();
          resolve();
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        cleanup,
      };
      waiters.add(waiter);
      this.readyWaiters.set(webContents, waiters);
      signal.addEventListener('abort', handleAbort, { once: true });
      webContents.once('destroyed', handleUnavailable);
      webContents.on('did-start-navigation', handleNavigation);

      try {
        webContents.send('context-space:ready-check');
      } catch (error) {
        log.warn('发送 context-space:ready-check 失败', error);
        waiter.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private waitForResponse(
    webContents: WebContents,
    message: ContextSpaceInvokePayload,
    signal: AbortSignal,
  ): Promise<ContextSpaceResponsePayload> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        signal.removeEventListener('abort', handleAbort);
        webContents.removeListener('destroyed', handleUnavailable);
        webContents.removeListener('did-start-navigation', handleNavigation);
      };
      const handleAbort = () => {
        cleanup();
        this.pending.delete(message.requestId);
        reject(signal.reason);
      };
      const handleUnavailable = () => {
        cleanup();
        this.pending.delete(message.requestId);
        reject(new Error('mainWindow unavailable'));
      };
      // 子 frame（含 <webview> 挂载）导航不算主窗失效，必须持续监听而非 once
      const handleNavigation = (details: unknown) => {
        if (!isMainFrameRealNavigation(details)) return;
        handleUnavailable();
      };
      this.pending.set(message.requestId, {
        resolve,
        reject,
        sender: webContents,
        cleanup,
      });
      signal.addEventListener('abort', handleAbort, { once: true });
      webContents.once('destroyed', handleUnavailable);
      webContents.on('did-start-navigation', handleNavigation);

      try {
        signal.throwIfAborted();
        webContents.send('context-space:invoke', message);
      } catch (error) {
        log.error(
          `发送 context-space:invoke 失败 action=${message.action} requestId=${message.requestId}`,
          error,
        );
        cleanup();
        this.pending.delete(message.requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async invoke(action: string, payload: any, timeoutMs = 8000): Promise<ContextSpaceResponsePayload> {
    if (this.disposed) {
      return {
        requestId: 'invalid',
        success: false,
        error: 'ContextSpaceToolBridge has been destroyed'
      };
    }

    const controller = new AbortController();
    const timeoutError = new Error(`context-space invoke timeout: ${action}`);
    const timer = setTimeout(() => {
      log.warn(`invoke 超时 action=${action} timeoutMs=${timeoutMs}`);
      controller.abort(timeoutError);
    }, timeoutMs);
    this.activeInvocations.add(controller);

    try {
      const mainWindow = await this.ensureMainWindow(controller.signal);
      controller.signal.throwIfAborted();
      if (!mainWindow || mainWindow.isDestroyed()) {
        return {
          requestId: 'invalid',
          success: false,
          error: 'mainWindow unavailable'
        };
      }
      await this.waitForRendererReady(mainWindow.webContents, controller.signal);
      controller.signal.throwIfAborted();

      const requestId = `context-space-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const message: ContextSpaceInvokePayload = { requestId, action, payload };
      log.debug(`invoke action=${action} requestId=${requestId} timeoutMs=${timeoutMs}`);
      return await this.waitForResponse(
        mainWindow.webContents,
        message,
        controller.signal,
      );
    } finally {
      clearTimeout(timer);
      this.activeInvocations.delete(controller);
    }
  }

  destroy(): void {
    this.disposed = true;
    const destroyError = new Error('context-space bridge destroyed');
    for (const controller of this.activeInvocations) {
      controller.abort(destroyError);
    }
    this.activeInvocations.clear();
    if (this.listening) {
      ipcMain.removeListener('context-space:response', this.handleResponse);
      ipcMain.removeListener('context-space:ready', this.handleReady);
      this.listening = false;
    }
    for (const entry of this.pending.values()) {
      entry.cleanup();
      entry.reject(destroyError);
    }
    this.pending.clear();
    for (const waiters of this.readyWaiters.values()) {
      for (const waiter of waiters) {
        waiter.cleanup();
        waiter.reject(destroyError);
      }
    }
    this.readyWaiters.clear();
    for (const [webContents, handlers] of this.lifecycleHandlers) {
      webContents.removeListener('did-start-navigation', handlers.reload);
      webContents.removeListener('destroyed', handlers.destroyed);
    }
    this.lifecycleHandlers.clear();
  }
}
