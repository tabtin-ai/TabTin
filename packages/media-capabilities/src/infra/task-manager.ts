/**
 * In-memory task store for long-running local capabilities.
 *
 * Capabilities like video analysis or smart reframe can take 30s+.
 * Instead of blocking the HTTP response, they return a task ID immediately
 * and the caller polls GET /video/tasks/{id} or listens via WS.
 *
 * Safety:
 * - maxTasks: 防止内存泄漏（默认 100），超过时拒绝创建
 * - processingTimeoutMs: 超时自动标记为 failed（默认 10 分钟）
 * - complete()/fail() 检查当前状态，已完成的不能重复标记
 */

import type { Provenance, TaskQueryResult } from '../types.js';

export type TaskStatus = 'processing' | 'completed' | 'failed';

export interface TaskProgress {
  phase: string;
  percent: number;
  detail?: string;
}

export interface Task<TResult = unknown> {
  id: string;
  type: string;
  status: TaskStatus;
  progress: TaskProgress;
  result?: TResult;
  error?: string;
  createdAt: number;
  /** 附加元数据（例如 thread_id），不影响核心生命周期 */
  meta?: Record<string, unknown>;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_MAX_TASKS = 100;
const DEFAULT_PROCESSING_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export interface TaskManagerOptions {
  ttlMs?: number;
  maxTasks?: number;
  processingTimeoutMs?: number;
}

export class TaskManager {
  private tasks = new Map<string, Task>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private readonly ttlMs: number;
  private readonly maxTasks: number;
  private readonly processingTimeoutMs: number;

  constructor(opts?: number | TaskManagerOptions) {
    if (typeof opts === 'number') {
      this.ttlMs = opts;
      this.maxTasks = DEFAULT_MAX_TASKS;
      this.processingTimeoutMs = DEFAULT_PROCESSING_TIMEOUT_MS;
    } else {
      this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
      this.maxTasks = opts?.maxTasks ?? DEFAULT_MAX_TASKS;
      this.processingTimeoutMs = opts?.processingTimeoutMs ?? DEFAULT_PROCESSING_TIMEOUT_MS;
    }
  }

  create(id: string, type: string = 'default', meta?: Record<string, unknown>): Task {
    if (this.tasks.size >= this.maxTasks) {
      throw new Error(
        `任务数量已达上限 (${this.maxTasks})，请等待现有任务完成或清理过期任务`,
      );
    }

    const task: Task = {
      id,
      type,
      status: 'processing',
      progress: { phase: 'initializing', percent: 0 },
      createdAt: Date.now(),
      meta,
    };
    this.tasks.set(id, task);
    this.ensureCleanup();
    return task;
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  updateProgress(id: string, phase: string, percent: number, detail?: string): void {
    const task = this.tasks.get(id);
    if (task && task.status === 'processing') {
      task.progress = { phase, percent, detail };
    }
  }

  complete<TResult>(id: string, result: TResult): void {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'processing') return;
    task.status = 'completed';
    task.progress = { phase: 'done', percent: 100 };
    task.result = result;
  }

  fail(id: string, error: string): void {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'processing') return;
    task.status = 'failed';
    task.error = error;
  }

  /**
   * 优雅关闭：标记所有进行中任务为失败。
   * 可选回调用于通知外部（如 WS 推送失败事件）。
   */
  shutdown(onTaskFailed?: (task: Task) => void): void {
    for (const task of this.tasks.values()) {
      if (task.status === 'processing') {
        task.status = 'failed';
        task.error = '进程关闭，任务被中断';
        onTaskFailed?.(task);
      }
    }
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /** Number of tasks that still own background work. */
  getActiveCount(): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.status === 'processing') count += 1;
    }
    return count;
  }

  /**
   * 将内部 Task 映射到统一的 HTTP 响应格式 {@link TaskQueryResult}。
   *
   * - completed → succeeded
   * - 从 result 中提取 image_urls / video_url → result_urls
   * - 从 result 中提取 provenance
   */
  static formatResult(task: Task): TaskQueryResult {
    const mapped: TaskQueryResult = {
      task_id: task.id,
      status: task.status === 'completed' ? 'succeeded' : task.status,
      task_type: task.type,
      progress: task.progress,
    };

    if (task.result !== undefined) {
      const r = task.result as Record<string, unknown>;

      if (Array.isArray(r.image_urls) && r.image_urls.length > 0) {
        mapped.result_urls = r.image_urls as string[];
      } else if (typeof r.video_url === 'string' && r.video_url) {
        mapped.result_urls = [r.video_url];
      }

      if (r.provenance) {
        mapped.provenance = r.provenance as Provenance;
      }

      mapped.result = task.result;
    }

    if (task.error !== undefined) {
      mapped.error_message = task.error;
    }

    return mapped;
  }

  private ensureCleanup(): void {
    if (this.cleanupInterval) return;
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [taskId, task] of this.tasks) {
        if (task.status === 'processing' && now - task.createdAt > this.processingTimeoutMs) {
          task.status = 'failed';
          task.error = `任务处理超时（${Math.round(this.processingTimeoutMs / 1000)}s）`;
        }
        if (task.status !== 'processing' && now - task.createdAt > this.ttlMs) {
          this.tasks.delete(taskId);
        }
      }
      if (this.tasks.size === 0 && this.cleanupInterval) {
        clearInterval(this.cleanupInterval);
        this.cleanupInterval = null;
      }
    }, 60_000);
  }
}
