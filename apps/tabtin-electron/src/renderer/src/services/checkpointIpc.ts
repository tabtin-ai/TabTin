/**
 * Checkpoint IPC facade — wraps `window.tabtin.checkpoint` calls.
 *
 * ## Wave 2-β 改造（contract / 2026-05-03）
 *
 * 旧形态：每个 method 返 `{ success: boolean, ...data, error? } | null`，caller
 * 必须先判断 null 再判断 `success` 字段，三层判断写起来啰嗦且容易漏。
 *
 * 新形态（W2 invokeIpc 契约）：
 * - **API 不可用**（`isAvailable() === false`）→ throw `Error('Checkpoint API not available')`
 * - **业务失败**（旧 `success: false`）→ throw `Error(detail)` 由 caller `catch`
 * - **业务成功** → 直接返业务数据（剥掉 `success` 字段）
 *
 * 这样 caller 写法统一为 `try { const data = await checkpointIpc.foo(...) ... } catch (err) { ... }`，
 * 跟 `invokeIpc` 全栈契约对齐。
 *
 * **过渡期保护**：W2-α 的 `preload/ipc-shim.ts` 完成前，preload `window.tabtin.checkpoint.*`
 * 仍返旧 `{ success, ... }` 形态。本 facade 内部主动检测 `success === false` 并 throw——
 * 让 caller 行为不依赖 W2-α 完成时机（Tier 1 LEGACY_HANDLERS 路径同款）。
 * W2-α 完成后 preload 已经自动 throw / 解包，本层主动检测自然变成 no-op，可在 W3 删除。
 */

import type {
  CheckpointCommitPolicy,
  CheckpointDiffEntry,
  CheckpointRestoreOptions,
  DiffSummaryFileEntry,
} from '@tabtin/checkpoint-core'
import { createLogger } from '@/utils/logger'

export type { CheckpointDiffEntry, DiffSummaryFileEntry }

const log = createLogger('CheckpointIPC')

function api() {
  return window.tabtin?.checkpoint
}

/**
 * Checkpoint 业务错误 —— 携带主进程返回的 errorType，让 UI 可据此分流降级
 * （e.g. `'project_path_not_exist'` 走"项目目录已不存在"占位，
 * `'worktree_mismatch'` 走"shadow repo 与项目不匹配"占位）。
 */
export class CheckpointError extends Error {
  readonly errorType?: string
  constructor(message: string, errorType?: string) {
    super(message)
    this.name = 'CheckpointError'
    this.errorType = errorType
  }
}

/** 类型守卫：判断捕获的错误是否带 errorType（兼容跨 worker 边界丢失原型链的场景）。 */
export function getCheckpointErrorType(err: unknown): string | undefined {
  if (err instanceof CheckpointError) return err.errorType
  if (err && typeof err === 'object' && 'errorType' in err) {
    const t = (err as { errorType?: unknown }).errorType
    if (typeof t === 'string') return t
  }
  return undefined
}

/**
 * 主动 unwrap：拿 IPC 返回值，若是旧 envelope `{ success: false }` 形态则 throw，
 * 否则返 data。W2-α 完成后此函数等价于 identity——届时可删除。
 *
 * @internal
 */
function unwrapLegacyEnvelope<T extends object>(raw: unknown, op: string): T {
  if (raw === null || raw === undefined) {
    throw new CheckpointError(`Checkpoint ${op}: empty result`)
  }
  if (typeof raw !== 'object') {
    throw new CheckpointError(`Checkpoint ${op}: invalid result type`)
  }
  const r = raw as Record<string, unknown>
  if (r.success === false) {
    const errorType = typeof r.errorType === 'string' ? r.errorType : undefined
    throw new CheckpointError(
      typeof r.error === 'string' ? r.error : `Checkpoint ${op} failed`,
      errorType,
    )
  }
  return raw as T
}

export function isAvailable(): boolean {
  return !!api()
}

export async function init(spacePath: string): Promise<void> {
  const ck = api()
  if (!ck) throw new Error('Checkpoint API not available')
  unwrapLegacyEnvelope(await ck.init(spacePath), 'init')
}

export async function commit(
  spacePath: string,
  policy?: CheckpointCommitPolicy,
): Promise<{ commitHash: string | null; skipped?: boolean }> {
  const ck = api()
  if (!ck) throw new Error('Checkpoint API not available')
  const data = unwrapLegacyEnvelope<{ commitHash: string | null }>(
    await ck.commit(spacePath, policy),
    'commit',
  )
  return { commitHash: data.commitHash, skipped: !data.commitHash }
}

export async function writeTree(spacePath: string): Promise<{ treeHash: string }> {
  const ck = api()
  if (!ck) throw new Error('Checkpoint API not available')
  const data = unwrapLegacyEnvelope<{ treeHash: string | null }>(
    await ck.writeTree(spacePath),
    'writeTree',
  )
  if (!data.treeHash) throw new Error('Checkpoint writeTree returned empty hash')
  return { treeHash: data.treeHash }
}

export async function restore(spacePath: string, hash: string, options?: CheckpointRestoreOptions): Promise<void> {
  const ck = api()
  if (!ck) throw new Error('Checkpoint API not available')
  unwrapLegacyEnvelope(await ck.restore(spacePath, hash, options), 'restore')
}

/**
 * Best-effort restore：内部 swallow 一切错误，返 boolean 给调用方决定后续逻辑。
 *
 * 用于"尝试恢复，失败也别中断主流程"的场景（譬如撤销失败时回退到 safety checkpoint）。
 * 与 `restore()` 的区别：本函数 **不抛异常**——所有错误都进 log.warn。
 */
export async function restoreSafe(spacePath: string, hash: string): Promise<boolean> {
  try {
    await restore(spacePath, hash)
    return true
  } catch (err) {
    log.warn('Safety restore failed (best-effort, swallowed):', err)
    return false
  }
}

export async function initial(spacePath: string): Promise<{ commitHash: string }> {
  const ck = api()
  if (!ck) throw new Error('Checkpoint API not available')
  const data = unwrapLegacyEnvelope<{ commitHash: string | null }>(
    await ck.initial(spacePath),
    'initial',
  )
  if (!data.commitHash) throw new Error('Checkpoint initial returned empty hash')
  return { commitHash: data.commitHash }
}

export async function diff(
  spacePath: string,
  hash: string,
  toHash?: string,
): Promise<{ diffs: CheckpointDiffEntry[] }> {
  const ck = api()
  if (!ck) throw new Error('Checkpoint API not available')
  const data = unwrapLegacyEnvelope<{ diffs?: CheckpointDiffEntry[] }>(
    await ck.diff(spacePath, hash, toHash),
    'diff',
  )
  return { diffs: Array.isArray(data.diffs) ? data.diffs : [] }
}

export interface DiffSummaryResult {
  files: DiffSummaryFileEntry[]
  summary: { changed: number; insertions: number; deletions: number }
}

export async function diffSummary(
  spacePath: string,
  commitHash: string,
  baseHash?: string,
): Promise<DiffSummaryResult> {
  const ck = api()
  if (!ck) throw new Error('Checkpoint API not available')
  return unwrapLegacyEnvelope<DiffSummaryResult>(
    await ck.diffSummary(spacePath, commitHash, baseHash),
    'diffSummary',
  )
}

export interface CommitLogEntry {
  hash: string
  message: string
  date: string
}

export interface ListCommitsResult {
  commits: CommitLogEntry[]
  /**
   * 标记错误类型——commit list 在某些场景（譬如 not-a-repo）下后端会返 errorType
   * 而不是真正失败。caller 可基于 `errorType` 做 UI 分流（譬如显示"该项目尚未启用版本管理"）。
   *
   * **注意**：当后端返 errorType 时，旧形态 success 仍是 true（业务上属于"成功识别非 repo"）；
   * 新形态保留 errorType 字段作为可选信号，commits 是空数组。
   */
  errorType?: string
}

export async function listCommits(
  spacePath: string,
  options?: { limit?: number; skip?: number },
): Promise<ListCommitsResult> {
  const ck = api()
  if (!ck) throw new Error('Checkpoint API not available')
  const data = unwrapLegacyEnvelope<{ commits?: CommitLogEntry[]; errorType?: string }>(
    await ck.listCommits(spacePath, options),
    'listCommits',
  )
  return {
    commits: Array.isArray(data.commits) ? data.commits : [],
    errorType: data.errorType,
  }
}

export async function gc(spacePath: string): Promise<void> {
  const ck = api()
  if (!ck) throw new Error('Checkpoint API not available')
  unwrapLegacyEnvelope(await ck.gc(spacePath), 'gc')
}

export async function destroy(spacePath: string): Promise<void> {
  const ck = api()
  if (!ck) throw new Error('Checkpoint API not available')
  unwrapLegacyEnvelope(await ck.destroy(spacePath), 'destroy')
}

export interface DiskUsageResult {
  sizeBytes: number
  sizeHuman: string
}

export async function getDiskUsage(spacePath: string): Promise<DiskUsageResult> {
  const ck = api()
  if (!ck) throw new Error('Checkpoint API not available')
  return unwrapLegacyEnvelope<DiskUsageResult>(await ck.diskUsage(spacePath), 'diskUsage')
}
