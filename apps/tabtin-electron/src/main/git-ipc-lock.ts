/**
 * Git index.lock 竞态防护：读侧避锁由 runGit 的 GIT_OPTIONAL_LOCKS 负责；
 * 本模块提供写侧 per-cwd 串行队列 + 锁冲突短重试。
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * 跨 IPC 返回的稳定锁冲突原因。不要附带 Git stderr：其中含仓库绝对路径，
 * 会进入 preload 的通用 IPC 诊断缓冲。渲染层按 `index.lock` 标识本地化展示。
 */
export const GIT_INDEX_LOCK_ERROR_MESSAGE =
  'GIT_INDEX_LOCK: index.lock already exists; another Git process may be running, or a stale lock may remain after an interrupted Git operation.'

/** 写操作遇 index.lock 时的 backoff（ms），共重试 delays.length 次 */
export const INDEX_LOCK_RETRY_DELAYS_MS = [50, 100, 200] as const

export function isGitIndexLockError(error: unknown): boolean {
  const msg = extractErrorText(error).toLowerCase()
  return msg.includes('index.lock') || msg.includes('another git process')
}

function extractErrorText(error: unknown): string {
  if (error && typeof error === 'object') {
    const withText = error as { stderr?: string; stdout?: string; message?: string }
    return [withText.stderr, withText.stdout, withText.message]
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter(Boolean)
      .join('\n')
  }
  return String(error ?? '')
}

export function normalizeCwdKey(cwd: string): string {
  const resolved = path.resolve(cwd)
  let canonical = path.normalize(resolved)
  try {
    canonical = fs.realpathSync.native(resolved)
  } catch {
    // Missing paths cannot be canonicalized; retain exact normalized spelling.
  }
  const normalized = canonical.replace(/\\/g, '/').normalize('NFC')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

const pendingByCwd = new Map<string, Promise<void>>()
const pendingCountByCwd = new Map<string, number>()

export interface CwdWriteQueueStart {
  queuedAhead: number
  waitMs: number
}

export interface CwdWriteQueueOptions {
  onStart?: (event: CwdWriteQueueStart) => void
  now?: () => number
}

/**
 * 同一 cwd 上的写操作串行排队，避免本进程并发抢 index.lock。
 */
export async function withCwdWriteQueue<T>(
  cwd: string,
  fn: () => Promise<T>,
  options?: CwdWriteQueueOptions,
): Promise<T> {
  const key = normalizeCwdKey(cwd)
  const now = options?.now ?? Date.now
  const queuedAt = now()
  const queuedAhead = pendingCountByCwd.get(key) ?? 0
  pendingCountByCwd.set(key, queuedAhead + 1)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const prev = pendingByCwd.get(key) ?? Promise.resolve()
  pendingByCwd.set(key, gate)

  try {
    await prev
  } catch {
    // 前序失败不阻塞后续写操作
  }

  try {
    options?.onStart?.({
      queuedAhead,
      waitMs: Math.max(0, now() - queuedAt),
    })
  } catch {
    // 诊断观察器失败不能改变 Git 写操作结果。
  }

  try {
    return await fn()
  } finally {
    release()
    const remaining = (pendingCountByCwd.get(key) ?? 1) - 1
    if (remaining > 0) {
      pendingCountByCwd.set(key, remaining)
    } else {
      pendingCountByCwd.delete(key)
    }
    if (pendingByCwd.get(key) === gate) {
      pendingByCwd.delete(key)
    }
  }
}

export async function withCwdWriteQueues<T>(
  cwds: readonly string[],
  fn: () => Promise<T>,
  options?: CwdWriteQueueOptions,
): Promise<T> {
  const uniqueByKey = new Map<string, string>()
  for (const cwd of cwds) {
    const key = normalizeCwdKey(cwd)
    if (!uniqueByKey.has(key)) uniqueByKey.set(key, cwd)
  }
  const ordered = [...uniqueByKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, cwd]) => cwd)
  let aggregate: CwdWriteQueueStart = { queuedAhead: 0, waitMs: 0 }

  const acquire = (index: number): Promise<T> => {
    const cwd = ordered[index]
    if (!cwd) {
      try {
        options?.onStart?.(aggregate)
      } catch {
        // Diagnostics must not change queue or Git operation semantics.
      }
      return fn()
    }
    return withCwdWriteQueue(
      cwd,
      () => acquire(index + 1),
      {
        onStart: (event) => {
          aggregate = {
            queuedAhead: aggregate.queuedAhead + event.queuedAhead,
            waitMs: aggregate.waitMs + event.waitMs,
          }
        },
      },
    )
  }

  return acquire(0)
}

export interface IndexLockRetryOptions {
  delaysMs?: readonly number[]
  sleep?: (ms: number) => Promise<void>
  onLockConflict?: (event: IndexLockRetryEvent) => void | Promise<void>
  /** 在 backoff 睡眠前调用，可用于清理陈旧 index.lock 等恢复动作 */
  beforeRetry?: (event: IndexLockRetryEvent) => void | Promise<void>
  now?: () => number
}

export interface IndexLockRetryEvent {
  attempt: number
  maxAttempts: number
  nextDelayMs: number | null
  exhausted: boolean
  elapsedMs: number
}

/**
 * 对短暂 index.lock 冲突做有限 backoff 重试；非锁错误立即抛出。
 */
export async function withIndexLockRetry<T>(
  fn: () => Promise<T>,
  options?: IndexLockRetryOptions,
): Promise<T> {
  const delays = options?.delaysMs ?? INDEX_LOCK_RETRY_DELAYS_MS
  const sleep =
    options?.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = options?.now ?? Date.now
  const startedAt = now()

  let lastError: unknown
  const maxAttempts = delays.length + 1
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (!isGitIndexLockError(error)) {
        throw error
      }
      const exhausted = attempt >= delays.length
      try {
        await options?.onLockConflict?.({
          attempt: attempt + 1,
          maxAttempts,
          nextDelayMs: exhausted ? null : delays[attempt]!,
          exhausted,
          elapsedMs: Math.max(0, now() - startedAt),
        })
      } catch {
        // 诊断观察器失败不能中断既有重试或改变最终 Git 错误。
      }
      if (exhausted) throw error
      try {
        await options?.beforeRetry?.({
          attempt: attempt + 1,
          maxAttempts,
          nextDelayMs: delays[attempt]!,
          exhausted: false,
          elapsedMs: Math.max(0, now() - startedAt),
        })
      } catch {
        // 恢复动作失败不能中断既有重试或改变最终 Git 错误。
      }
      await sleep(delays[attempt]!)
    }
  }
  throw lastError
}

/** 测试用：清空 cwd 写队列 */
export function resetCwdWriteQueuesForTests(): void {
  pendingByCwd.clear()
  pendingCountByCwd.clear()
}
