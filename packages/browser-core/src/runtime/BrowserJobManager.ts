/**
 * BrowserJobManager —— browser 长任务的「可取消 + 进度」运行时句柄（BR-10 P0）。
 *
 * 背景（设计正典 docs/agent/browser-br-10-design.md §2.2）：
 * stream download / smart-download / replay.run 这类长任务现在阻塞整个 HTTP 响应、
 * 且 client 断开也停不下 server 端的下载循环。BR-10 的方向是把「job」概念下沉到
 * browser-core runtime（对齐 BR-8 WS-B 的状态收编）：长任务起一个 job、立即返回 jobId，
 * 调用方轮询进度 / 主动 cancel；cancel 经 AbortController 把信号传到引擎里真正停下循环。
 *
 * 已落能力：
 * - create → 起一个 running job，返回 `{ id, signal }`；signal 交给引擎，引擎须监听
 *   `signal.aborted` 主动中止（P1 的 stream-downloader 已接）。
 * - reportProgress / complete / fail：引擎跑动时回报进度与终态。
 * - cancel(jobId) → controller.abort() + 标记 cancelled（终态守卫保证 cancelled 不被
 *   随后到达的 AbortError → fail 覆盖）。
 * - get / list：供 route 查询状态。
 * - TTL / shutdown：终态 job 到期移除，超时 running job 自动取消，进程退出时清空。
 *
 * ⚠️ electron-free / 零副作用：只持有数据结构 + 纯逻辑 + 标准 AbortController，
 * 不 import 任何运行时（不碰 electron / playwright / 两端 route），可被两端共同驱动。
 * `BrowserActionErrorInfo` 仅作类型导入（编译期擦除，不引入运行时依赖、不成环）。
 *
 * 进程语义：一个进程只跑一个运行时（Electron 或 Daemon），共享单例承载所有 job。
 *
 */

import type { BrowserActionErrorInfo } from '../orchestration/act-request';

/** 长任务的进度快照。`percent` 0–100；`completed`/`total` 给分片类任务的「N/M」展示用。 */
export interface BrowserJobProgress {
  phase: string;
  percent: number;
  detail?: string;
  completed?: number;
  total?: number;
}

export type BrowserJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * 对外暴露的 job 记录（形状严格对齐设计 §2.2）。
 * `result` 为成功载荷（如下载结果）；`error` 为失败/取消的结构化错误决策载荷，
 * 复用 Orchestrator 的 `BrowserActionErrorInfo`，便于 route 落地成各自 envelope。
 */
export interface BrowserJobRecord {
  id: string;
  actionId: string;
  status: BrowserJobStatus;
  progress: BrowserJobProgress;
  result?: unknown;
  error?: BrowserActionErrorInfo;
  createdAt: number;
  updatedAt: number;
}

/** create 的返回：jobId + 交给引擎监听的取消信号。 */
export interface BrowserJobHandle {
  id: string;
  signal: AbortSignal;
}

/** 内部条目：对外记录 + 取消控制器 + 创建时的入参（留给 P2 executeJob / 调试取证）。 */
interface BrowserJobEntry {
  record: BrowserJobRecord;
  controller: AbortController;
  body: unknown;
}

const INITIAL_PROGRESS: BrowserJobProgress = { phase: 'initializing', percent: 0 };
const DEFAULT_TERMINAL_JOB_TTL_MS = 30 * 60 * 1000;
const DEFAULT_RUNNING_JOB_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 1000;

type TimerHandle = ReturnType<typeof setInterval>;

export interface BrowserJobManagerOptions {
  /**
   * 已 completed/failed/cancelled 的 job 保留多久。保留窗口给 CLI 轮询终态，之后清理避免长进程累积。
   */
  terminalJobTtlMs?: number;
  /** running 超过该时间视为孤儿任务：触发 abort 并标 cancelled，下一轮按终态 TTL 移除。 */
  runningJobTtlMs?: number;
  /** 自动清理间隔。测试可传 0 关闭 timer。 */
  cleanupIntervalMs?: number;
  /** 测试注入时钟；生产默认 Date.now。 */
  now?: () => number;
}

/** 终态：到达后 progress/complete/fail/cancel 均不再改写（保护 cancelled 不被晚到的 fail 覆盖）。 */
function isTerminal(status: BrowserJobStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/**
 * 把任意抛出物归一成 `BrowserActionErrorInfo`：
 * - 携 `info`（如 Orchestrator 的 BrowserActionError）→ 直接取其结构化决策载荷（鸭子判定，
 *   不 import 该类、不引运行时依赖）。
 * - 普通 Error → AbortError 记 `aborted`，其余记 `job_failed`。
 * - 其它 → 字符串化兜底。
 */
function toJobErrorInfo(error: unknown): BrowserActionErrorInfo {
  if (error && typeof error === 'object' && 'info' in error) {
    const info = (error as { info?: unknown }).info;
    if (
      info && typeof info === 'object' &&
      typeof (info as Record<string, unknown>).code === 'string' &&
      typeof (info as Record<string, unknown>).message === 'string'
    ) {
      return info as BrowserActionErrorInfo;
    }
  }
  if (error instanceof Error) {
    return { code: error.name === 'AbortError' ? 'aborted' : 'job_failed', message: error.message };
  }
  return { code: 'job_failed', message: String(error) };
}

export class BrowserJobManager {
  private readonly jobs = new Map<string, BrowserJobEntry>();
  private readonly terminalJobTtlMs: number;
  private readonly runningJobTtlMs: number;
  private readonly now: () => number;
  private cleanupTimer: TimerHandle | null = null;
  private isShutdown = false;
  private seq = 0;

  constructor(options: BrowserJobManagerOptions = {}) {
    this.terminalJobTtlMs = options.terminalJobTtlMs ?? DEFAULT_TERMINAL_JOB_TTL_MS;
    this.runningJobTtlMs = options.runningJobTtlMs ?? DEFAULT_RUNNING_JOB_TTL_MS;
    this.now = options.now ?? Date.now;

    const intervalMs = options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
    if (intervalMs > 0) {
      this.cleanupTimer = setInterval(() => {
        this.cleanupExpired();
      }, intervalMs);
      (this.cleanupTimer as { unref?: () => void }).unref?.();
    }
  }

  private nextId(): string {
    const rand = Math.random().toString(36).slice(2, 8);
    return `job-${this.now().toString(36)}-${(++this.seq).toString(36)}-${rand}`;
  }

  /**
   * 起一个长任务 job：登记为 running、返回 jobId + 取消 signal。
   * 引擎拿 signal 跑活、监听 `signal.aborted` 主动中止；body 暂存供 P2/调试用。
   */
  create(actionId: string, body?: unknown): BrowserJobHandle {
    if (this.isShutdown) {
      throw new Error('BrowserJobManager has been shut down');
    }
    this.cleanupExpired();
    const id = this.nextId();
    const now = this.now();
    const controller = new AbortController();
    const record: BrowserJobRecord = {
      id,
      actionId,
      status: 'running',
      progress: { ...INITIAL_PROGRESS },
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(id, { record, controller, body });
    return { id, signal: controller.signal };
  }

  /** 回报进度：仅 running 态生效（终态后忽略，避免覆盖最终 progress）。 */
  reportProgress(jobId: string, progress: BrowserJobProgress): void {
    const entry = this.jobs.get(jobId);
    if (!entry || entry.record.status !== 'running') return;
    entry.record.progress = progress;
    entry.record.updatedAt = this.now();
  }

  /** 标记完成：仅非终态生效；进度归到 100/done。 */
  complete(jobId: string, result?: unknown): void {
    const entry = this.jobs.get(jobId);
    if (!entry || isTerminal(entry.record.status)) return;
    entry.record.status = 'completed';
    entry.record.progress = { phase: 'done', percent: 100 };
    entry.record.result = result;
    entry.record.updatedAt = this.now();
  }

  /** 标记失败：仅非终态生效（已 cancelled 的 job 收到晚到的 AbortError→fail 会被忽略）。 */
  fail(jobId: string, error: unknown): void {
    const entry = this.jobs.get(jobId);
    if (!entry || isTerminal(entry.record.status)) return;
    entry.record.status = 'failed';
    entry.record.error = toJobErrorInfo(error);
    entry.record.updatedAt = this.now();
  }

  /**
   * 取消 job：abort() 触发 signal.aborted（引擎据此停循环）+ 立即标记 cancelled。
   * 已是终态则 no-op。返回是否真的取消了一个进行中的 job。
   */
  cancel(jobId: string): boolean {
    const entry = this.jobs.get(jobId);
    if (!entry || isTerminal(entry.record.status)) return false;
    entry.controller.abort();
    entry.record.status = 'cancelled';
    entry.record.updatedAt = this.now();
    return true;
  }

  /**
   * 清理过期 job：
   * - running 超过 runningJobTtlMs：abort + 标 cancelled（给调用方留可见终态）；
   * - terminal 超过 terminalJobTtlMs：从内存移除。
   *
   * 返回本轮被取消或删除的 job 数，供测试 / 诊断使用。
   */
  cleanupExpired(now = this.now()): number {
    let changed = 0;
    for (const [id, entry] of this.jobs) {
      const { record } = entry;
      if (record.status === 'running' && now - record.createdAt >= this.runningJobTtlMs) {
        entry.controller.abort();
        record.status = 'cancelled';
        record.updatedAt = now;
        changed++;
        continue;
      }
      if (isTerminal(record.status) && now - record.updatedAt >= this.terminalJobTtlMs) {
        this.jobs.delete(id);
        changed++;
      }
    }
    return changed;
  }

  /** 停止自动清理、abort 所有未终态 job，并清空内存记录（进程退出 / 测试 teardown 用）。 */
  shutdown(): number {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    let cancelled = 0;
    for (const entry of this.jobs.values()) {
      if (!isTerminal(entry.record.status)) {
        entry.controller.abort();
        cancelled++;
      }
    }
    const removed = this.jobs.size;
    this.jobs.clear();
    this.isShutdown = true;
    return Math.max(cancelled, removed);
  }

  /** 查询单个 job 记录（route/CLI 轮询用）。 */
  get(jobId: string): BrowserJobRecord | undefined {
    return this.jobs.get(jobId)?.record;
  }

  /** 列出所有 job 记录（诊断/管理用）。 */
  list(): BrowserJobRecord[] {
    return Array.from(this.jobs.values(), (e) => e.record);
  }
}

let shared: BrowserJobManager | null = null;

/** 进程级共享 job 管理器。 */
export function getSharedBrowserJobManager(): BrowserJobManager {
  if (!shared) shared = new BrowserJobManager();
  return shared;
}

/** 进程退出时调用：取消并清空所有 browser job。 */
export function shutdownSharedBrowserJobManager(): void {
  shared?.shutdown();
  shared = null;
}

/** 重置共享 job 管理器（仅供测试隔离用）。 */
export function resetSharedBrowserJobManager(): void {
  shared?.shutdown();
  shared = null;
}
