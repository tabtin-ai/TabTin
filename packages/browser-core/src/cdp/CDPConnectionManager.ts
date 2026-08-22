/**
 * CDP 连接管理器
 *
 * 核心功能：
 * 1. 统一管理所有 WebContents 的 CDP 连接
 * 2. 支持多种连接策略（Profile）
 * 3. 绑定任务生命周期
 * 4. 自动清理和资源管理
 */

import { EventEmitter } from 'events';
import { t } from '../i18n';

/**
 * CDP 连接策略（Profile）
 * 🔥 注意：这里的策略应该与 apps/tabtin-electron/src/main/view-factory/types.ts 保持一致
 */
export type CDPConnectionStrategy =
  | 'ephemeral'     // 短暂：每次操作后立即断开
  | 'keep-alive'    // 保活：保持连接，60秒无活动自动断开
  | 'task-bound'    // 任务绑定：绑定任务生命周期，任务结束自动断开
  | 'persistent';   // 持久：长期保持，不自动断开

/**
 * 为了向后兼容，保留旧的枚举（已废弃）
 * @deprecated 请使用 CDPConnectionStrategy 类型
 */
export enum CDPConnectionProfile {
  EPHEMERAL = 'ephemeral',
  KEEP_ALIVE = 'keep-alive',
  TASK_BOUND = 'task-bound',
  PERSISTENT = 'persistent'
}

/**
 * CDP 连接状态
 */
interface CDPConnectionState {
  webContentsId: number;
  isAttached: boolean;
  enabledDomains: Set<string>;
  lastUsedTime: number;
  strategy: CDPConnectionStrategy;
  /** Number of in-flight CDP operations; connections with inFlight > 0 are eviction-safe. */
  inFlight: number;

  boundTaskId?: string;
  boundRunId?: string;
  boundOrganizationId?: string;
}

/**
 * CDP 连接配置
 */
export interface CDPConnectionConfig {
  defaultStrategy?: CDPConnectionStrategy;
  keepAliveTimeoutMs?: number;
  enableAutoCleanup?: boolean;
  cleanupIntervalMs?: number;
}

/**
 * 任务生命周期事件（从 TaskLifecycleManager 传入）
 */
export interface TaskLifecycleEvent {
  type: 'started' | 'completed' | 'failed' | 'cancelled';
  taskId: string;
  runId?: string;
  organizationId?: string;
}

const STRATEGY_PRIORITY: Record<CDPConnectionStrategy, number> = {
  'ephemeral': 1,
  'keep-alive': 2,
  'task-bound': 3,
  'persistent': 4,
};

/** BT-023: 连接池上限，防止高并发场景连接数无界增长 */
const DEFAULT_MAX_CONNECTIONS = 20;

export class CDPConnectionManager extends EventEmitter {
  private connections = new Map<number, CDPConnectionState>();
  private taskBindings = new Map<string, number>();
  private organizationBindings = new Map<string, number>();
  private cleanupTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private webContentsCache = new Map<number, any>();
  private pendingAttach = new Map<number, Promise<void>>();

  private config: Required<CDPConnectionConfig>;

  constructor(config?: CDPConnectionConfig) {
    super();

    this.config = {
      defaultStrategy: config?.defaultStrategy ?? 'keep-alive',
      keepAliveTimeoutMs: config?.keepAliveTimeoutMs ?? 60000,
      enableAutoCleanup: config?.enableAutoCleanup ?? true,
      cleanupIntervalMs: config?.cleanupIntervalMs ?? 30000
    };

    if (this.config.enableAutoCleanup) {
      this.startAutoCleanup();
    }

    this.startHeartbeat();

    console.log('[CDPConnectionManager] 初始化完成', {
      defaultStrategy: this.config.defaultStrategy,
      keepAliveTimeout: `${this.config.keepAliveTimeoutMs}ms`
    });
  }

  // ==================== 核心 API ====================

  async getOrAttach(
    webContents: any,
    options?: {
      strategy?: CDPConnectionStrategy;
      taskId?: string;
      runId?: string;
      organizationId?: string;
    }
  ): Promise<void> {
    const wcId = webContents.id;
    const strategy = options?.strategy ?? this.config.defaultStrategy;

    const wcUrl: string = webContents.getURL?.() || '';
    if (wcUrl.includes('localhost:517') || wcUrl.includes('/renderer/index.html')) {
      const errMsg = `[CDPConnectionManager] 🛡️ 拒绝 attach 到主窗口 webContents (id=${wcId}, url=${wcUrl})`;
      console.error(errMsg);
      throw new Error(errMsg);
    }

    const pending = this.pendingAttach.get(wcId);
    if (pending) {
      console.log(`[CDPConnectionManager] ⏳ 等待进行中的 attach: WebContents ${wcId}`);
      await pending;
    }

    let state = this.connections.get(wcId);

    if (state?.isAttached && webContents.debugger.isAttached()) {
      state.lastUsedTime = Date.now();

      if (STRATEGY_PRIORITY[strategy] > STRATEGY_PRIORITY[state.strategy]) {
        console.log(`[CDPConnectionManager] ⬆️  升级连接策略: WebContents ${wcId} [${state.strategy} → ${strategy}]`);
        state.strategy = strategy;
      }

      if (strategy === 'task-bound') {
        this.updateBindings(wcId, options);
      }

      console.log(`[CDPConnectionManager] ♻️  复用 CDP 连接: WebContents ${wcId} [${state.strategy}]`);
      return;
    }

    if (state?.isAttached && !webContents.debugger.isAttached()) {
      console.warn(`[CDPConnectionManager] ⚠️  CDP 连接已断开，重新 attach: WebContents ${wcId}`);
      state.isAttached = false;
    }

    console.log(`[CDPConnectionManager] 🔌 创建新 CDP 连接: WebContents ${wcId} [${strategy}]`);

    const attachPromise = this._doAttach(webContents, wcId, strategy, options);
    this.pendingAttach.set(wcId, attachPromise);
    try {
      await attachPromise;
    } finally {
      this.pendingAttach.delete(wcId);
    }
  }

  private async _doAttach(
    webContents: any,
    wcId: number,
    strategy: CDPConnectionStrategy,
    options?: { taskId?: string; runId?: string; organizationId?: string },
  ): Promise<void> {
    if (this.connections.size >= DEFAULT_MAX_CONNECTIONS) {
      this.evictLRUConnection();
    }

    try {
      await webContents.debugger.attach('1.3');

      const state: CDPConnectionState = {
        webContentsId: wcId,
        isAttached: true,
        enabledDomains: new Set(),
        lastUsedTime: Date.now(),
        strategy,
        inFlight: 0,
        boundTaskId: options?.taskId,
        boundRunId: options?.runId,
        boundOrganizationId: options?.organizationId
      };

      this.connections.set(wcId, state);
      this.webContentsCache.set(wcId, webContents);

      if (strategy === 'task-bound') {
        this.updateBindings(wcId, options);
      }

      webContents.once('destroyed', () => {
        this.webContentsCache.delete(wcId);
        console.log(`[CDPConnectionManager] 📡 WebContents 销毁: ${wcId}`);
        this.detach(wcId, 'webcontents_destroyed');
      });

      this.emit('connected', { webContentsId: wcId, strategy });

    } catch (error) {
      console.error(`[CDPConnectionManager] ❌ CDP attach 失败:`, error);
      throw error;
    }
  }

  /**
   * 三级驱逐策略：
   * 1. 优先驱逐最老的空闲 keep-alive 连接
   * 2. 其次驱逐最老的空闲 task-bound 连接（inFlight === 0）
   * 3. 均无可驱逐 → 抛出 Error 拒绝新连接，而非静默突破上限
   *
   * eviction_safe: inFlight > 0 的连接不可被驱逐，防止中断活跃 CDP 操作。
   */
  private evictLRUConnection(): void {
    let candidateWcId: number | undefined;
    let candidateTime = Infinity;

    // Round 1: keep-alive 且空闲的连接
    for (const [wcId, state] of this.connections.entries()) {
      if (state.strategy === 'keep-alive' && state.inFlight === 0 && state.lastUsedTime < candidateTime) {
        candidateTime = state.lastUsedTime;
        candidateWcId = wcId;
      }
    }

    if (candidateWcId !== undefined) {
      console.log(`[CDPConnectionManager] 🔄 连接池已满(${DEFAULT_MAX_CONNECTIONS})，驱逐空闲 keep-alive 连接: WebContents ${candidateWcId}`);
      this.detach(candidateWcId, 'pool_limit_eviction');
      return;
    }

    // Round 2: task-bound 且空闲的连接
    candidateTime = Infinity;
    for (const [wcId, state] of this.connections.entries()) {
      if (state.strategy === 'task-bound' && state.inFlight === 0 && state.lastUsedTime < candidateTime) {
        candidateTime = state.lastUsedTime;
        candidateWcId = wcId;
      }
    }

    if (candidateWcId !== undefined) {
      console.log(`[CDPConnectionManager] 🔄 连接池已满(${DEFAULT_MAX_CONNECTIONS})，驱逐空闲 task-bound 连接: WebContents ${candidateWcId}`);
      this.detach(candidateWcId, 'pool_limit_eviction');
      return;
    }

    // Round 3: 所有连接都在执行操作，拒绝新连接
    throw new Error(
      `CDP connection pool exhausted: all ${DEFAULT_MAX_CONNECTIONS} connections are actively in use (inFlight > 0). ` +
      `Cannot allocate a new connection. Wait for an active operation to complete or increase DEFAULT_MAX_CONNECTIONS.`
    );
  }

  async enableDomain(webContents: any, domain: string): Promise<void> {
    const wcId = webContents.id;
    const state = this.connections.get(wcId);

    if (!state?.isAttached) {
      throw new Error(t('errors.cdpNotAttached', { id: wcId }));
    }

    if (state.enabledDomains.has(domain)) {
      return;
    }

    state.inFlight++;
    try {
      await webContents.debugger.sendCommand(`${domain}.enable`);
      state.enabledDomains.add(domain);
      state.lastUsedTime = Date.now();

      console.log(`[CDPConnectionManager] ✅ 启用 Domain: ${domain} (WebContents ${wcId})`);
    } catch (error) {
      console.error(`[CDPConnectionManager] ❌ 启用 Domain 失败: ${domain}`, error);
      throw error;
    } finally {
      if (state.inFlight > 0) state.inFlight--;
    }
  }

  async sendCommand<T = any>(
    webContents: any,
    method: string,
    params?: any
  ): Promise<T> {
    const wcId = webContents.id;
    const state = this.connections.get(wcId);

    if (!state?.isAttached) {
      throw new Error(t('errors.cdpNotAttached', { id: wcId }));
    }

    state.inFlight++;
    try {
      state.lastUsedTime = Date.now();
      const result = await webContents.debugger.sendCommand(method, params);
      return result as T;
    } catch (error) {
      console.error(`[CDPConnectionManager] ❌ CDP 命令失败: ${method}`, error);
      throw error;
    } finally {
      if (state.inFlight > 0) state.inFlight--;
    }
  }

  detach(webContentsIdOrTask: number | string, reason?: string): void {
    let wcId: number | undefined;

    if (typeof webContentsIdOrTask === 'string') {
      wcId = this.taskBindings.get(webContentsIdOrTask);
      if (!wcId) {
        console.warn(`[CDPConnectionManager] ⚠️  未找到任务绑定: ${webContentsIdOrTask}`);
        return;
      }
    } else {
      wcId = webContentsIdOrTask;
    }

    const state = this.connections.get(wcId);
    if (!state) return;

    try {
      console.log(`[CDPConnectionManager] 🔌 断开 CDP 连接: WebContents ${wcId} [${reason || 'manual'}]`);

      const wc = this.webContentsCache.get(wcId);
      if (wc && !wc.isDestroyed?.() && wc.debugger?.isAttached?.()) {
        try {
          wc.debugger.detach();
        } catch (detachErr) {
          console.warn(`[CDPConnectionManager] ⚠️  debugger.detach() 失败（忽略）: WebContents ${wcId}`, detachErr);
        }
      }

      this.emit('disconnected', {
        webContentsId: wcId,
        reason: reason || 'manual',
        strategy: state.strategy
      });

    } finally {
      if (state.boundTaskId) {
        this.taskBindings.delete(state.boundTaskId);
      }
      if (state.boundOrganizationId) {
        this.organizationBindings.delete(state.boundOrganizationId);
      }

      this.connections.delete(wcId);
      this.webContentsCache.delete(wcId);
    }
  }

  // ==================== 任务生命周期绑定 ====================

  handleTaskLifecycle(event: TaskLifecycleEvent): void {
    const { type, taskId, organizationId } = event;

    console.log(`[CDPConnectionManager] 📋 任务生命周期事件: ${type} (task: ${taskId}, workspace: ${organizationId})`);

    switch (type) {
      case 'started':
        break;

      case 'completed':
      case 'failed':
      case 'cancelled':
        this.detachByTask(taskId, type);
        break;
    }
  }

  private detachByTask(taskId: string, reason: string): void {
    const wcId = this.taskBindings.get(taskId);
    if (!wcId) {
      console.log(`[CDPConnectionManager] ℹ️  任务无绑定连接: ${taskId}`);
      return;
    }

    const state = this.connections.get(wcId);
    if (!state) return;

    if (state.strategy === 'task-bound') {
      this.detach(wcId, `task_${reason}`);
    } else {
      console.log(`[CDPConnectionManager] ℹ️  连接非任务绑定模式，跳过断开: WebContents ${wcId} [${state.strategy}]`);
    }
  }

  detachByOrganization(organizationId: string, reason?: string): void {
    const wcId = this.organizationBindings.get(organizationId);
    if (!wcId) {
      console.log(`[CDPConnectionManager] ℹ️  Organization 无绑定连接: ${organizationId}`);
      return;
    }

    this.detach(wcId, reason || `organization_closed`);
  }

  // ==================== 心跳健康检查 ====================

  private startHeartbeat(): void {
    const HEARTBEAT_INTERVAL = 30000;
    this.heartbeatTimer = setInterval(() => {
      this.runHeartbeat();
    }, HEARTBEAT_INTERVAL);
  }

  private async runHeartbeat(): Promise<void> {
    const tasks: Array<Promise<void>> = [];

    for (const [wcId, state] of this.connections.entries()) {
      if (state.strategy === 'ephemeral') continue;
      tasks.push(this.heartbeatSingle(wcId, state));
    }

    if (tasks.length > 0) {
      await Promise.allSettled(tasks);
    }
  }

  private async heartbeatSingle(wcId: number, state: any): Promise<void> {
    const wc = this.webContentsCache.get(wcId);
    if (!wc || wc.isDestroyed?.()) {
      this.detach(wcId, 'heartbeat_destroyed');
      return;
    }

    if (!wc.debugger.isAttached()) {
      console.warn(`[CDPConnectionManager] 💓 心跳检测到断连，尝试重连: WebContents ${wcId} [${state.strategy}]`);
      try {
        await wc.debugger.attach('1.3');
        state.isAttached = true;
        state.lastUsedTime = Date.now();

        const domainsToRestore = new Set(state.enabledDomains);
        state.enabledDomains.clear();
        for (const domain of domainsToRestore) {
          try {
            await wc.debugger.sendCommand(`${domain}.enable`);
            state.enabledDomains.add(domain);
          } catch (domainErr) {
            console.warn(`[CDPConnectionManager] ⚠️  重连后恢复 Domain 失败: ${domain}`, domainErr);
          }
        }

        this.emit('reconnected', { webContentsId: wcId, strategy: state.strategy });
        console.log(`[CDPConnectionManager] 💓 心跳重连成功: WebContents ${wcId}，已恢复 ${state.enabledDomains.size}/${domainsToRestore.size} 个 Domain`);
      } catch {
        console.error(`[CDPConnectionManager] 💓 心跳重连失败: WebContents ${wcId}，移除连接`);
        this.detach(wcId, 'heartbeat_reconnect_failed');
        this.emit('reconnect_failed', { webContentsId: wcId, strategy: state.strategy });
      }
      return;
    }

    try {
      await wc.debugger.sendCommand('Runtime.evaluate', { expression: '1', returnByValue: true });
      state.lastUsedTime = Date.now();
    } catch {
      console.warn(`[CDPConnectionManager] 💓 心跳探活失败: WebContents ${wcId}`);
      state.isAttached = false;
    }
  }

  // ==================== 自动清理 ====================

  private startAutoCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanupIdleConnections();
    }, this.config.cleanupIntervalMs);

    console.log(`[CDPConnectionManager] 🧹 启动自动清理 (间隔: ${this.config.cleanupIntervalMs}ms)`);
  }

  private cleanupIdleConnections(): void {
    const now = Date.now();

    for (const [wcId, state] of this.connections.entries()) {
      if (state.strategy === 'task-bound' ||
          state.strategy === 'persistent') {
        continue;
      }

      if (state.strategy === 'ephemeral') {
        this.detach(wcId, 'ephemeral_cleanup');
        continue;
      }

      if (state.strategy === 'keep-alive') {
        const idleTime = now - state.lastUsedTime;
        if (idleTime > this.config.keepAliveTimeoutMs) {
          console.log(`[CDPConnectionManager] 🧹 清理空闲连接: WebContents ${wcId} (idle: ${idleTime}ms)`);
          this.detach(wcId, 'idle_timeout');
        }
      }
    }
  }

  // ==================== 辅助方法 ====================

  private updateBindings(
    wcId: number,
    options?: {
      taskId?: string;
      runId?: string;
      organizationId?: string;
    }
  ): void {
    const state = this.connections.get(wcId);
    if (!state) return;

    if (options?.taskId) {
      state.boundTaskId = options.taskId;
      this.taskBindings.set(options.taskId, wcId);
    }

    if (options?.runId) {
      state.boundRunId = options.runId;
    }

    if (options?.organizationId) {
      state.boundOrganizationId = options.organizationId;
      this.organizationBindings.set(options.organizationId, wcId);
    }
  }

  getConnectionState(webContentsId: number): CDPConnectionState | undefined {
    return this.connections.get(webContentsId);
  }

  isConnected(webContentsId: number): boolean {
    const state = this.connections.get(webContentsId);
    return state?.isAttached ?? false;
  }

  getStats() {
    const stats = {
      totalConnections: this.connections.size,
      byStrategy: {
        ephemeral: 0,
        'keep-alive': 0,
        'task-bound': 0,
        persistent: 0
      },
      taskBindings: this.taskBindings.size,
      organizationBindings: this.organizationBindings.size,
      connections: [] as any[]
    };

    for (const [wcId, state] of this.connections.entries()) {
      stats.byStrategy[state.strategy]++;

      stats.connections.push({
        webContentsId: wcId,
        strategy: state.strategy,
        enabledDomains: Array.from(state.enabledDomains),
        idleTimeMs: Date.now() - state.lastUsedTime,
        inFlight: state.inFlight,
        boundTaskId: state.boundTaskId,
        boundRunId: state.boundRunId,
        boundOrganizationId: state.boundOrganizationId
      });
    }

    return stats;
  }

  destroy(): void {
    console.log('[CDPConnectionManager] 🔥 销毁管理器');

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    for (const wcId of this.connections.keys()) {
      this.detach(wcId, 'manager_destroyed');
    }

    this.removeAllListeners();
  }
}

// ==================== 全局单例 ====================

let globalInstance: CDPConnectionManager | null = null;

export function getCDPConnectionManager(config?: CDPConnectionConfig): CDPConnectionManager {
  if (!globalInstance) {
    globalInstance = new CDPConnectionManager(config);
  }
  return globalInstance;
}

export function destroyCDPConnectionManager(): void {
  if (globalInstance) {
    globalInstance.destroy();
    globalInstance = null;
  }
}
