/**
 * Metrics Extension — 观测指标收集
 *
 * 收集 collab-live 运行指标：
 * - 活跃连接数
 * - 活跃文档数
 * - store 延迟
 * - 错误计数
 * - 认证成功/失败率
 */

import type { Extension, onStoreDocumentPayload, onLoadDocumentPayload } from "@hocuspocus/server";

/** 单个 push 端点的统计 */
export interface PushEndpointStats {
  success: number;
  failed: number;
  totalChanges: number;
  lastPushAt: string | null;
}

/** 实时指标快照 */
export interface MetricsSnapshot {
  /** 活跃 WebSocket 连接数 */
  activeConnections: number;
  /** 活跃文档数（已加载到内存） */
  activeDocuments: number;
  /** 总 store 次数 */
  totalStores: number;
  /** store 失败次数 */
  storeErrors: number;
  /** 最近 store 延迟（ms） */
  lastStoreLatency: number;
  /** 平均 store 延迟（ms，最近 100 次） */
  avgStoreLatency: number;
  /** P95 store 延迟（ms） */
  p95StoreLatency: number;
  /** P99 store 延迟（ms） */
  p99StoreLatency: number;
  /** 总 fetch 次数 */
  totalFetches: number;
  /** fetch 失败次数 */
  fetchErrors: number;
  /** 认证成功次数 */
  authSuccess: number;
  /** 认证失败次数 */
  authFailed: number;
  /** 重连次数 */
  reconnections: number;
  /** force-close 次数 */
  forceCloses: number;
  /** 按模块统计的连接数 */
  connectionsByModule: Record<string, number>;
  /** 按模块统计的文档数 */
  documentsByModule: Record<string, number>;
  /** Agent push 端点统计 */
  pushEndpoints: Record<string, PushEndpointStats>;
  /** Redis 连接指标 (PERF-028) */
  redis: {
    totalConnections: number;
    activeConnections: number;
    reconnections: number;
    messagesSent: number;
    messagesReceived: number;
    offlineQueueFlushes: number;
  };
  /** 各模块 snapshotCache 大小 */
  snapshotCacheSizes: Record<string, number>;
  /** 服务启动时间 */
  startedAt: string;
  /** 运行时长（秒） */
  uptimeSeconds: number;
}

class MetricsCollector {
  private startedAt = new Date();
  private storeLatencies: number[] = [];
  private maxLatencyHistory = 200;

  public activeConnections = 0;
  public activeDocuments = 0;
  public totalStores = 0;
  public storeErrors = 0;
  public lastStoreLatency = 0;
  public totalFetches = 0;
  public fetchErrors = 0;
  public authSuccess = 0;
  public authFailed = 0;
  public reconnections = 0;
  public forceCloses = 0;
  public connectionsByModule: Record<string, number> = {};
  public documentsByModule: Record<string, number> = {};
  public pushEndpoints: Record<string, PushEndpointStats> = {};
  private counters: Record<string, number> = {};

  // Redis 指标 (PERF-028)
  public redisTotalConnections = 0;
  public redisActiveConnections = 0;
  public redisReconnections = 0;
  public redisMessagesSent = 0;
  public redisMessagesReceived = 0;
  public redisOfflineQueueFlushes = 0;
  public snapshotCacheSizes: Record<string, number> = {};

  increment(key: string, delta: number = 1): void {
    this.counters[key] = (this.counters[key] || 0) + delta;
  }

  getCounter(key: string): number {
    return this.counters[key] || 0;
  }

  recordPush(endpoint: string, success: boolean, changeCount: number = 0): void {
    if (!this.pushEndpoints[endpoint]) {
      this.pushEndpoints[endpoint] = { success: 0, failed: 0, totalChanges: 0, lastPushAt: null };
    }
    const stats = this.pushEndpoints[endpoint];
    if (success) {
      stats.success++;
      stats.totalChanges += changeCount;
    } else {
      stats.failed++;
    }
    stats.lastPushAt = new Date().toISOString();
  }

  recordStoreLatency(ms: number): void {
    this.lastStoreLatency = ms;
    this.storeLatencies.push(ms);
    if (this.storeLatencies.length > this.maxLatencyHistory) {
      this.storeLatencies.shift();
    }
  }

  recordModuleConnection(module: string, delta: number): void {
    this.connectionsByModule[module] = (this.connectionsByModule[module] || 0) + delta;
    if ((this.connectionsByModule[module] || 0) < 0) {
      this.connectionsByModule[module] = 0;
    }
  }

  recordModuleDocument(module: string, delta: number): void {
    this.documentsByModule[module] = (this.documentsByModule[module] || 0) + delta;
    if ((this.documentsByModule[module] || 0) < 0) {
      this.documentsByModule[module] = 0;
    }
  }

  getAvgStoreLatency(): number {
    if (this.storeLatencies.length === 0) return 0;
    const sum = this.storeLatencies.reduce((a, b) => a + b, 0);
    return Math.round(sum / this.storeLatencies.length);
  }

  getPercentileLatency(percentile: number): number {
    if (this.storeLatencies.length === 0) return 0;
    const sorted = [...this.storeLatencies].sort((a, b) => a - b);
    const idx = Math.ceil(sorted.length * (percentile / 100)) - 1;
    return sorted[Math.max(0, idx)];
  }

  getSnapshot(): MetricsSnapshot {
    const now = new Date();
    return {
      activeConnections: this.activeConnections,
      activeDocuments: this.activeDocuments,
      totalStores: this.totalStores,
      storeErrors: this.storeErrors,
      lastStoreLatency: this.lastStoreLatency,
      avgStoreLatency: this.getAvgStoreLatency(),
      p95StoreLatency: this.getPercentileLatency(95),
      p99StoreLatency: this.getPercentileLatency(99),
      totalFetches: this.totalFetches,
      fetchErrors: this.fetchErrors,
      authSuccess: this.authSuccess,
      authFailed: this.authFailed,
      reconnections: this.reconnections,
      forceCloses: this.forceCloses,
      connectionsByModule: { ...this.connectionsByModule },
      documentsByModule: { ...this.documentsByModule },
      pushEndpoints: { ...this.pushEndpoints },
      redis: {
        totalConnections: this.redisTotalConnections,
        activeConnections: this.redisActiveConnections,
        reconnections: this.redisReconnections,
        messagesSent: this.redisMessagesSent,
        messagesReceived: this.redisMessagesReceived,
        offlineQueueFlushes: this.redisOfflineQueueFlushes,
      },
      snapshotCacheSizes: { ...this.snapshotCacheSizes },
      startedAt: this.startedAt.toISOString(),
      uptimeSeconds: Math.floor((now.getTime() - this.startedAt.getTime()) / 1000),
    };
  }

  /**
   * Check if any metric exceeds alert thresholds.
   * Returns list of triggered alerts.
   */
  checkAlerts(): string[] {
    const alerts: string[] = [];

    if (this.getAvgStoreLatency() > 5000) {
      alerts.push(`avg_store_latency=${this.getAvgStoreLatency()}ms > 5000ms`);
    }

    if (this.storeErrors > 0 && this.totalStores > 0) {
      const errorRate = this.storeErrors / this.totalStores;
      if (errorRate > 0.1) {
        alerts.push(`store_error_rate=${(errorRate * 100).toFixed(1)}% > 10%`);
      }
    }

    if (this.fetchErrors > 0 && this.totalFetches > 0) {
      const errorRate = this.fetchErrors / this.totalFetches;
      if (errorRate > 0.1) {
        alerts.push(`fetch_error_rate=${(errorRate * 100).toFixed(1)}% > 10%`);
      }
    }

    for (const [endpoint, stats] of Object.entries(this.pushEndpoints)) {
      const total = stats.success + stats.failed;
      if (total > 10 && stats.failed / total > 0.1) {
        alerts.push(`push_error_rate[${endpoint}]=${((stats.failed / total) * 100).toFixed(1)}% > 10%`);
      }
    }

    // Redis alerts (PERF-028)
    if (this.redisTotalConnections > 0 && this.redisActiveConnections === 0) {
      alerts.push("redis_all_connections_down");
    }
    if (this.redisOfflineQueueFlushes > 0) {
      alerts.push(`redis_offline_queue_flushes=${this.redisOfflineQueueFlushes}`);
    }

    return alerts;
  }
}

/** 全局 metrics 实例，供 health API 读取 */
export const metrics = new MetricsCollector();

/**
 * Hocuspocus Metrics Extension
 *
 * 通过 Hocuspocus 生命周期钩子收集观测数据。
 */
export class MetricsExtension implements Extension {
  async onLoadDocument(payload: onLoadDocumentPayload): Promise<void> {
    metrics.totalFetches++;
    metrics.activeDocuments++;
  }

  async afterUnloadDocument(): Promise<void> {
    metrics.activeDocuments = Math.max(0, metrics.activeDocuments - 1);
  }

  async onConnect(): Promise<void> {
    metrics.activeConnections++;
  }

  async onDisconnect(): Promise<void> {
    metrics.activeConnections = Math.max(0, metrics.activeConnections - 1);
  }

  async onStoreDocument(payload: onStoreDocumentPayload): Promise<void> {
    // store 延迟在 database.ts 中测量（因为要包含网络请求时间）
    // 这里只计数
    metrics.totalStores++;
  }

  async onAuthenticate(): Promise<void> {
    metrics.authSuccess++;
  }
}
