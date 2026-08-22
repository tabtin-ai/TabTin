/**
 * 能力层公共辅助函数。
 *
 * - createProvenance: 统一 provenance 构建，消除 4 处重复
 * - pollDjangoTask: 异步任务轮询（指数退避），复用于 image/video/未来的 upscale
 * - toErrorMessage: 安全地从 unknown 提取错误信息
 */

import type { Provenance, ExecutionContext } from '../types.js';

// ── Provenance 构建 ───────────────────────────────────────────────

export function createProvenance(
  capability: string,
  params: Record<string, unknown>,
  startTime: number,
  extra?: Partial<Provenance>,
): Provenance {
  return {
    capability,
    params,
    createdAt: new Date().toISOString(),
    durationMs: Date.now() - startTime,
    ...extra,
  };
}

// ── Django 异步任务轮询 ───────────────────────────────────────────

export interface PollOptions {
  /** 初始轮询间隔（毫秒），默认 2000 */
  initialIntervalMs?: number;
  /** 最大轮询间隔（毫秒），默认 10000 */
  maxIntervalMs?: number;
  /** 退避乘数，默认 1.5 */
  backoffFactor?: number;
  /** 最大轮询总时长（毫秒），默认 600000（10 分钟） */
  timeoutMs?: number;
  /** 进度报告回调 */
  onProgress?: (info: { phase: string; percent: number; detail?: string }) => void;
}

export interface DjangoTaskResult {
  task_id: string;
  status: string;
  result_urls?: string[];
  result_url?: string;
  error_message?: string;
  error_code?: string;
  [key: string]: unknown;
}

/**
 * 轮询 Django 异步任务直到终态（succeeded / failed / cancelled）。
 *
 * 使用指数退避策略：2s → 3s → 4.5s → ... → 最大 10s。
 */
export async function pollDjangoTask(
  ctx: ExecutionContext,
  taskId: string,
  opts: PollOptions = {},
): Promise<DjangoTaskResult> {
  const {
    initialIntervalMs = 2000,
    maxIntervalMs = 10_000,
    backoffFactor = 1.5,
    timeoutMs = 600_000,
    onProgress,
  } = opts;

  const start = Date.now();
  let interval = initialIntervalMs;

  while (Date.now() - start < timeoutMs) {
    ctx.signal?.throwIfAborted();

    await sleep(interval);
    interval = Math.min(interval * backoffFactor, maxIntervalMs);

    const res = await ctx.djangoRequest<DjangoTaskResult>(
      'GET',
      `/api/services/media/tasks/${taskId}`,
    );

    const data = res.data;
    const status = typeof data === 'object' && data !== null
      ? (data as Record<string, unknown>).status as string
      : undefined;

    if (status === 'succeeded') return data;

    if (status === 'failed' || status === 'cancelled') {
      const errMsg = (data as Record<string, unknown>).error_message as string | undefined;
      throw new Error(
        `任务 ${taskId} ${status === 'failed' ? '失败' : '已取消'}: ${errMsg ?? '未知原因'}`,
      );
    }

    onProgress?.({
      phase: 'polling',
      percent: Math.min(90, Math.round(((Date.now() - start) / timeoutMs) * 90)),
      detail: `等待任务完成 (${status ?? 'unknown'})...`,
    });
  }

  throw new Error(`任务 ${taskId} 轮询超时（${Math.round(timeoutMs / 1000)}s）`);
}

// ── 错误处理 ──────────────────────────────────────────────────────

export function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

// ── 内部工具 ──────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
