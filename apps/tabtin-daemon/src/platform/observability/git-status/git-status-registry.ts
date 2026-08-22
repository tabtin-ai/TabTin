import { normalize } from 'node:path';
import type { Logger } from '../logging/logger.js';
import type { GitStatusData } from './parsers/types.js';
import { GitStatusCollector, type GitStatusReadyCallback } from './git-status-collector.js';

/**
 * Manages multiple GitStatusCollector instances keyed by workspace / repo path.
 * Provides a backward-compatible API so existing single-workspace callers
 * (heartbeat, action-bridge, daemon) require minimal changes.
 */
export class GitStatusRegistry {
  private readonly logger: Logger;
  private readonly collectors = new Map<string, GitStatusCollector>();
  private onStatusReady: GitStatusReadyCallback | null = null;
  private primaryKey: string | null = null;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  // ---------------------------------------------------------------------------
  // Callback
  // ---------------------------------------------------------------------------

  setOnStatusReady(callback: GitStatusReadyCallback): void {
    this.onStatusReady = callback;
    for (const collector of this.collectors.values()) {
      collector.setOnStatusReady(callback);
    }
  }

  // ---------------------------------------------------------------------------
  // Collector lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Return an existing collector whose resolved git root matches `repoPath`,
   * or create a new one. The first registered path becomes the "primary".
   */
  getOrCreate(repoPath: string): GitStatusCollector {
    const key = normalize(repoPath);

    const existing = this.collectors.get(key);
    if (existing) return existing;

    for (const collector of this.collectors.values()) {
      const resolved = collector.getRepoPath();
      if (!resolved) continue;
      const resolvedNorm = normalize(resolved);
      if (resolvedNorm === key || key.startsWith(resolvedNorm + '/')) {
        return collector;
      }
    }

    const collector = new GitStatusCollector(this.logger);
    collector.setRepoPath(repoPath);
    if (this.onStatusReady) {
      collector.setOnStatusReady(this.onStatusReady);
    }
    this.collectors.set(key, collector);
    this.logger.debug(`GitStatusRegistry: created collector for ${key} (total: ${this.collectors.size})`);

    if (!this.primaryKey) {
      this.primaryKey = key;
    }

    return collector;
  }

  // ---------------------------------------------------------------------------
  // Lookup helpers
  // ---------------------------------------------------------------------------

  /**
   * Find the collector whose repo root best matches the given file path.
   * Falls back to the primary collector.
   */
  findForFile(filePath: string): GitStatusCollector | null {
    const normalized = normalize(filePath);
    let bestMatch: GitStatusCollector | null = null;
    let bestLen = 0;

    for (const collector of this.collectors.values()) {
      const repoPath = collector.getRepoPath();
      if (!repoPath) continue;
      const repoNorm = normalize(repoPath);
      if ((normalized === repoNorm || normalized.startsWith(repoNorm + '/')) && repoNorm.length > bestLen) {
        bestMatch = collector;
        bestLen = repoNorm.length;
      }
    }
    return bestMatch ?? this.getPrimary();
  }

  getPrimary(): GitStatusCollector | null {
    if (this.primaryKey) {
      return this.collectors.get(this.primaryKey) ?? null;
    }
    const first = this.collectors.values().next();
    return first.done ? null : first.value;
  }

  // ---------------------------------------------------------------------------
  // Backward-compatible single-workspace API
  // ---------------------------------------------------------------------------

  /** Cached status from the primary collector. */
  getCachedStatus(): GitStatusData | null {
    return this.getPrimary()?.getCachedStatus() ?? null;
  }

  /** Cached statuses from all tracked repos. */
  getAllCachedStatuses(): GitStatusData[] {
    const result: GitStatusData[] = [];
    for (const collector of this.collectors.values()) {
      const s = collector.getCachedStatus();
      if (s) result.push(s);
    }
    return result;
  }

  /** Kick off async collection on every tracked repo. */
  collectAll(): void {
    for (const collector of this.collectors.values()) {
      collector.collect().catch(() => {});
    }
  }

  /**
   * Invalidate + schedule collect-and-notify for a specific workspace.
   * Without a workspace, targets the primary collector.
   */
  invalidateAndNotify(workspaceRoot?: string): void {
    const collector = workspaceRoot
      ? this.getOrCreate(workspaceRoot)
      : this.getPrimary();
    if (collector) {
      collector.invalidate();
      collector.scheduleCollectAndNotify();
    }
  }

  /** Route a file diff request to the appropriate collector. */
  async getFileDiff(filePath: string, staged?: boolean): Promise<string> {
    const collector = this.findForFile(filePath);
    if (!collector) return '';
    return collector.getFileDiff(filePath, staged);
  }

  /**
   * @deprecated Use getOrCreate() for multi-workspace.
   * Kept for backward compatibility — registers the path as a new workspace.
   */
  setRepoPath(path: string): void {
    this.getOrCreate(path);
  }

  getRepoPath(): string | null {
    return this.getPrimary()?.getRepoPath() ?? null;
  }

  get size(): number {
    return this.collectors.size;
  }

  /**
   * RM-P1-1: 批量销毁所有 collector，清理 debounce 定时器。
   * 关闭时调用，防止 debounce 触发后向已关闭的 WebSocket 写入。
   */
  destroy(): void {
    for (const collector of this.collectors.values()) {
      collector.destroy();
    }
    this.collectors.clear();
    this.primaryKey = null;
    this.onStatusReady = null;
  }
}
