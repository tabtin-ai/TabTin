/**
 * ViewStateRegistry - View 统一状态注册中心（ 起引用层只持有 WebContents，容器无关）
 *
 * 职责：
 * 1. 作为 View 状态的登记与事件镜像（非唯一权威）
 * 2. 协调 embedded-crawl-view 和 ElectronLauncher 的状态
 * 3. 提供智能决策：是否需要导航、加载、刷新等
 * 4. 支持多次操作同一网页的场景
 *
 * 拆分说明：
 * - 类型定义       → ViewStateRegistryTypes.ts
 * - 导航决策纯函数 → ViewStateRegistryNavigation.ts
 * - 事件监听器工厂 → ViewStateRegistryListeners.ts
 * - 核心状态管理   → 本文件
 */

import { EventEmitter } from 'events';
import type { WebContents } from 'electron';
import { getFaviconResolver } from './favicon-resolver';
import { createLogger } from '../logger';

const log = createLogger('ViewStateRegistry');

import {
  hasAliveWebContents,
  type ViewState,
  type LoadEvent,
  type NavigationDecision,
  type NavigationOptions,
  type ViewEventListeners,
} from './ViewStateRegistryTypes';

import {
  isSameUrl,
  createEmptyState,
  computeNavigationAction,
} from './ViewStateRegistryNavigation';

import {
  createAndAttachListeners,
  detachListeners,
  type ListenerCallbacks,
} from './ViewStateRegistryListeners';

// Re-export all public types so existing import paths remain valid
export type {
  ViewState,
  LoadEvent,
  NavigationDecision,
  NavigationOptions,
} from './ViewStateRegistryTypes';
export { type NavigationAction } from './ViewStateRegistryTypes';

function getFaviconOwnerKey(url: string | undefined): string | null {
  if (!url || url === 'about:blank') return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function canReuseFaviconForUrl(sourceUrl: string | undefined, targetUrl: string | undefined): boolean {
  const sourceOwner = getFaviconOwnerKey(sourceUrl);
  const targetOwner = getFaviconOwnerKey(targetUrl);
  return Boolean(sourceOwner && targetOwner && sourceOwner === targetOwner);
}

export class ViewStateRegistry extends EventEmitter {
  private static instance: ViewStateRegistry | null = null;

  private states = new Map<string, ViewState>();
  /** : 引用类型层容器无关化 — 只持有 WebContents，不再持有 WebContentsView */
  private viewRefs = new Map<string, WebContents>();
  private eventListeners = new Map<string, ViewEventListeners>();
  private debugMode: boolean;

  private metrics = {
    totalRegistrations: 0,
    totalUnregistrations: 0,
    totalDecisions: 0,
    decisionDistribution: { skip: 0, wait: 0, reload: 0, navigate: 0 },
    totalDecisionTime: 0,
    averageDecisionTime: 0
  };

  private readonly MAX_HISTORY = 5;
  private metricsLite = { registerCount: 0, unregisterCount: 0, decisionCount: 0 };

  private readonly faviconResolver = getFaviconResolver();
  private faviconResolveAt = new Map<string, number>();
  private faviconResolveUrl = new Map<string, string>();
  private readonly FAVICON_RESOLVE_MIN_INTERVAL = 1000;

  private constructor() {
    super();
    this.debugMode = process.env.VIEW_STATE_DEBUG === 'true';
    // RF04: 自治清理定时器已移除，由 ViewFactory lifecycle 统一驱动
    this.debug('ViewStateRegistry initialized');
  }

  private debug(...args: any[]): void {
    if (this.debugMode) {
      log.debug(...args);
    }
  }

  public static getInstance(): ViewStateRegistry {
    if (!ViewStateRegistry.instance) {
      ViewStateRegistry.instance = new ViewStateRegistry();
    }
    return ViewStateRegistry.instance;
  }

  // ==================== 状态管理 ====================

  register(id: string, webContents: WebContents, initialState: Partial<ViewState>): void {
    this.debug('register', { id, initialState });
    this.metricsLite.registerCount += 1;

    if (this.states.has(id)) {
      log.warn('⚠️  View已存在，将先清理旧状态:', id);
      this.unregister(id);
    }

    const state: ViewState = {
      id,
      url: initialState.url || 'about:blank',
      status: initialState.status || 'idle',
      title: initialState.title,
      mode: initialState.mode || 'unknown',
      owner: initialState.owner || 'shared',
      lastLoadTime: initialState.lastLoadTime || 0,
      lastAccessTime: Date.now(),
      loadHistory: initialState.loadHistory || [],
      reusable: initialState.reusable !== false,
      inUse: initialState.inUse ?? false,
      metadata: {
        createdBy: initialState.metadata?.createdBy || 'unknown',
        createdAt: initialState.metadata?.createdAt || Date.now(),
        ...initialState.metadata
      }
    };

    this.states.set(id, state);
    this.viewRefs.set(id, webContents);

    // 附加事件监听器（委托给 Listeners 模块）
    const callbacks = this.buildListenerCallbacks();
    const listeners = createAndAttachListeners(id, webContents, callbacks);
    this.eventListeners.set(id, listeners);

    // 若已完成加载，补偿一次 favicon 解析
    try {
      if (!webContents.isDestroyed() && !webContents.isLoading()) {
        this.scheduleFaviconResolve(id, webContents, { allowDom: true, force: true, reason: 'register' });
      }
    } catch {
      // ignore
    }

    this.metrics.totalRegistrations++;
    this.emit('view:registered', { id, state });
    log.info('✅ View 已注册:', id, { url: state.url, mode: state.mode, owner: state.owner });
  }

  unregister(id: string): void {
    this.debug('unregister', { id });
    this.metricsLite.unregisterCount += 1;

    const state = this.states.get(id);
    if (!state) {
      this.debug('unregister: View不存在', { id });
      return;
    }

    const listeners = this.eventListeners.get(id);
    const webContents = this.viewRefs.get(id);

    if (listeners && webContents && hasAliveWebContents(webContents)) {
      try {
        detachListeners(webContents, listeners);
        this.debug('unregister: 事件监听器已清理', { id });
      } catch (error) {
        log.warn('清理事件监听器失败:', id, error);
      }
    }

    this.eventListeners.delete(id);
    this.states.delete(id);
    this.viewRefs.delete(id);
    this.metrics.totalUnregistrations++;

    this.emit('view:unregistered', { id, state });
    log.info('🗑️  View 已注销:', id);
  }

  updateState(id: string, updates: Partial<ViewState>): void {
    const state = this.states.get(id);
    if (!state) {
      log.warn('⚠️  尝试更新不存在的 View 状态:', id);
      return;
    }

    const oldStatus = state.status;
    const effectiveUpdates = { ...updates };
    if (
      Object.prototype.hasOwnProperty.call(updates, 'url') &&
      !Object.prototype.hasOwnProperty.call(updates, 'favicon') &&
      typeof updates.url === 'string' &&
      state.favicon &&
      !canReuseFaviconForUrl(state.url, updates.url)
    ) {
      effectiveUpdates.favicon = undefined;
    }
    Object.assign(state, effectiveUpdates, { lastAccessTime: Date.now() });

    this.emit('view:updated', { id, state, updates: effectiveUpdates });

    if (updates.status !== undefined && updates.status !== oldStatus) {
      this.emit('state:changed', { id, state });
      this.debug('状态已变更', { id, from: oldStatus, to: updates.status });
    }
  }

  getState(id: string): ViewState | undefined {
    return this.states.get(id);
  }

  hasView(id: string): boolean {
    return this.states.has(id);
  }

  async waitForState(
    id: string,
    targetStatus: ViewState['status'],
    options: { timeout?: number } = {}
  ): Promise<ViewState> {
    const timeout = options.timeout || 30000;
    const startTime = Date.now();

    this.debug('waitForState', { id, targetStatus, timeout });

    const currentState = this.getState(id);
    if (!currentState) {
      throw new Error(`View 不存在: ${id}`);
    }

    if (currentState.status === targetStatus) {
      this.debug('waitForState: 已经是目标状态', { id, status: targetStatus });
      return currentState;
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        cleanup();
        const elapsed = Date.now() - startTime;
        reject(new Error(`等待状态超时: ${id} (${targetStatus}), 耗时: ${elapsed}ms`));
      }, timeout);

      const onStateChange = (data: { id: string; state: ViewState }) => {
        if (data.id === id && data.state.status === targetStatus) {
          cleanup();
          const elapsed = Date.now() - startTime;
          this.debug('waitForState: 状态已到达', { id, status: targetStatus, elapsed });
          resolve(data.state);
        }
      };

      const cleanup = () => {
        clearTimeout(timeoutId);
        this.off('state:changed', onStateChange);
      };

      this.on('state:changed', onStateChange);
    });
  }

  touch(id: string): void {
    const state = this.states.get(id);
    if (state) {
      state.lastAccessTime = Date.now();
      this.emit('view:touched', { id, lastAccessTime: state.lastAccessTime });
    }
  }

  // ==================== 智能决策 ====================

  decideNavigation(
    viewId: string,
    targetUrl: string,
    options: NavigationOptions = {}
  ): NavigationDecision {
    const startTime = performance.now();
    const state = this.states.get(viewId);
    const result = computeNavigationAction(state, targetUrl, options);

    const decision: NavigationDecision = {
      action: result.action,
      reason: result.reason,
      currentState: state || createEmptyState(viewId),
      estimatedWaitTime: result.estimatedWaitTime
    };

    this.recordDecision(decision, startTime);
    return decision;
  }

  private recordDecision(decision: NavigationDecision, startTime: number): void {
    const duration = performance.now() - startTime;

    this.metrics.totalDecisions++;
    this.metricsLite.decisionCount += 1;
    this.metrics.totalDecisionTime += duration;
    this.metrics.averageDecisionTime = this.metrics.totalDecisionTime / this.metrics.totalDecisions;
    this.metrics.decisionDistribution[decision.action]++;

    this.debug('decideNavigation', {
      action: decision.action,
      reason: decision.reason,
      duration: `${duration.toFixed(2)}ms`
    });

    this.emit('navigation:decided', { decision, duration });
  }

  public getLiteMetrics(): {
    registerCount: number;
    unregisterCount: number;
    decisionCount: number;
    timestamp: string;
  } {
    return { ...this.metricsLite, timestamp: new Date().toISOString() };
  }

  // ==================== Favicon ====================

  private scheduleFaviconResolve(
    id: string,
    webContents: WebContents,
    options: { favicons?: string[]; allowDom?: boolean; reason?: string; force?: boolean }
  ): void {
    const state = this.states.get(id);
    if (!state || webContents.isDestroyed()) return;

    const pageUrl = webContents.getURL();
    const now = Date.now();
    const lastUrl = this.faviconResolveUrl.get(id);
    const lastAt = this.faviconResolveAt.get(id) ?? 0;
    const shouldThrottle = !options.force && lastUrl === pageUrl && now - lastAt < this.FAVICON_RESOLVE_MIN_INTERVAL;
    if (shouldThrottle) return;

    this.faviconResolveAt.set(id, now);
    this.faviconResolveUrl.set(id, pageUrl);

    void this.faviconResolver
      .resolve({
        viewId: id,
        webContents,
        pageUrl,
        favicons: options.favicons,
        allowDom: options.allowDom
      })
      .then((dataUrl) => {
        if (!dataUrl) return;
        if (webContents.isDestroyed()) return;
        const currentPageUrl = webContents.getURL();
        if (!isSameUrl(currentPageUrl, pageUrl, false)) {
          this.debug('skip stale favicon resolve', { id, reason: options.reason, pageUrl, currentPageUrl });
          return;
        }
        const currentState = this.states.get(id);
        if (!currentState) return;
        if (!canReuseFaviconForUrl(currentState.url, pageUrl)) {
          this.debug('skip stale favicon resolve after state navigation', {
            id,
            reason: options.reason,
            pageUrl,
            stateUrl: currentState.url
          });
          return;
        }
        const current = currentState.favicon;
        if (current === dataUrl) return;
        this.updateState(id, { favicon: dataUrl });
      })
      .catch((error) => {
        this.debug('favicon resolve failed', {
          id,
          reason: options.reason,
          error: error instanceof Error ? error.message : String(error)
        });
      });
  }

  // ==================== 内部辅助 ====================

  private buildListenerCallbacks(): ListenerCallbacks {
    return {
      getState: (id) => this.states.get(id),
      updateState: (id, updates) => this.updateState(id, updates),
      scheduleFaviconResolve: (id, wc, opts) => this.scheduleFaviconResolve(id, wc, opts),
      emitLoaded: (data) => this.emit('view:loaded', data),
      emitError: (data) => this.emit('view:error', data),
      debug: (...args) => this.debug(...args),
      maxHistory: this.MAX_HISTORY
    };
  }

  // ==================== 清理和维护 ====================

  /**
   * RF04: 被动孤儿清理 — 由 ViewFactory lifecycle 定时调用。
   *
   * 仅移除底层 WebContents 已销毁的条目。返回被清理的 id 列表，
   * 供 ViewFactory 做后续补偿（如 views Map 清理）。
   */
  cleanupOrphans(): string[] {
    const orphans: string[] = [];

    for (const [id, webContents] of this.viewRefs.entries()) {
      if (!hasAliveWebContents(webContents)) {
        orphans.push(id);
      }
    }

    for (const id of orphans) {
      this.unregister(id);
    }

    if (orphans.length > 0) {
      log.info('🧹 孤儿清理完成，移除', orphans.length, '个已销毁 View');
    }

    if (this.eventListeners.size !== this.states.size) {
      log.warn(
        '⚠️  监听器数量与状态数量不匹配:',
        `listeners=${this.eventListeners.size}, states=${this.states.size}`
      );
    }

    return orphans;
  }

  shutdown(): void {
    for (const [id, listeners] of this.eventListeners) {
      const webContentsRef = this.viewRefs.get(id);
      if (webContentsRef && !webContentsRef.isDestroyed()) {
        detachListeners(webContentsRef, listeners);
      }
    }
    this.eventListeners.clear();
    this.faviconResolveAt.clear();
    this.faviconResolveUrl.clear();
    this.states.clear();
    this.viewRefs.clear();
    this.removeAllListeners();
    log.info('🛑 已关闭');
  }

  // ==================== 查询与调试 ====================

  getAllStates(): Map<string, ViewState> {
    return new Map(this.states);
  }

  getMetrics() {
    return {
      ...this.metrics,
      statesCount: this.states.size,
      viewRefsCount: this.viewRefs.size,
      listenersCount: this.eventListeners.size
    };
  }

  findByUrl(url: string): ViewState[] {
    return Array.from(this.states.values()).filter(s => isSameUrl(s.url, url));
  }

  findByMode(mode: ViewState['mode']): ViewState[] {
    return Array.from(this.states.values()).filter(s => s.mode === mode);
  }

  findByOwner(owner: ViewState['owner']): ViewState[] {
    return Array.from(this.states.values()).filter(s => s.owner === owner);
  }

  findStale(staleTime: number): ViewState[] {
    const now = Date.now();
    return Array.from(this.states.values()).filter(
      s => s.status === 'loaded' && now - s.lastLoadTime > staleTime
    );
  }

  healthCheck(): {
    healthy: boolean;
    issues: string[];
    statistics: {
      totalViews: number;
      loadingViews: number;
      loadedViews: number;
      errorViews: number;
      staleViews: number;
      avgLoadTime: number;
    };
  } {
    const issues: string[] = [];
    const now = Date.now();
    let loadingCount = 0, loadedCount = 0, errorCount = 0, staleCount = 0;
    let totalLoadTime = 0, loadTimeCount = 0;

    for (const state of this.states.values()) {
      if (state.status === 'loading') loadingCount++;
      if (state.status === 'loaded') loadedCount++;
      if (state.status === 'error') errorCount++;

      if (state.status === 'loaded' && now - state.lastLoadTime > 10 * 60 * 1000) {
        staleCount++;
      }

      for (const load of state.loadHistory) {
        if (load.duration) {
          totalLoadTime += load.duration;
          loadTimeCount++;
        }
      }

      if (state.status === 'loading' && now - state.lastAccessTime > 60000) {
        issues.push(`View ${state.id} 加载超时（超过60秒）`);
      }

      if (state.loadHistory.length > 0) {
        const recentFailures = state.loadHistory.slice(-3).filter(e => !e.success);
        if (recentFailures.length >= 2) {
          issues.push(`View ${state.id} 最近多次加载失败`);
        }
      }
    }

    if (this.eventListeners.size !== this.states.size) {
      issues.push(`监听器数量(${this.eventListeners.size})与状态数量(${this.states.size})不匹配`);
    }

    return {
      healthy: issues.length === 0 && errorCount === 0,
      issues,
      statistics: {
        totalViews: this.states.size,
        loadingViews: loadingCount,
        loadedViews: loadedCount,
        errorViews: errorCount,
        staleViews: staleCount,
        avgLoadTime: loadTimeCount > 0 ? totalLoadTime / loadTimeCount : 0
      }
    };
  }

  printSummary(): void {
    log.info('📊 状态摘要:');
    log.info(`  总计: ${this.states.size} 个 View`);

    const byMode = new Map<string, number>();
    const byOwner = new Map<string, number>();
    const byStatus = new Map<string, number>();

    for (const state of this.states.values()) {
      byMode.set(state.mode, (byMode.get(state.mode) || 0) + 1);
      byOwner.set(state.owner, (byOwner.get(state.owner) || 0) + 1);
      byStatus.set(state.status, (byStatus.get(state.status) || 0) + 1);
    }

    log.info('  按模式:', Object.fromEntries(byMode));
    log.info('  按所有者:', Object.fromEntries(byOwner));
    log.info('  按状态:', Object.fromEntries(byStatus));

    const metrics = this.getMetrics();
    log.info('  性能指标:', {
      总决策数: metrics.totalDecisions,
      平均决策时间: `${metrics.averageDecisionTime.toFixed(2)}ms`,
      决策分布: metrics.decisionDistribution
    });
  }
}

// ==================== 导出 ====================

export function getViewStateRegistry(): ViewStateRegistry {
  return ViewStateRegistry.getInstance();
}

export async function waitForViewState(
  id: string,
  targetStatus: ViewState['status'],
  options?: { timeout?: number }
): Promise<ViewState> {
  const registry = getViewStateRegistry();
  return registry.waitForState(id, targetStatus, options);
}
