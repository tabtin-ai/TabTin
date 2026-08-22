/**
 * File-history IPC facade — wraps `window.tabtin.fileHistory` (per-file rewind).
 *
 * 这是"本地文件回退"在 renderer 侧的新实现，**替代** shadow git 的
 * `checkpointIpc.restore`（见 file-history / checkpoint §3.5 / §3.9）。
 *
 * 与 `checkpointIpc` 的关键差异：
 * - **按 thread + anchor 寻址**，不依赖 spacePath / git / 工作区根权限白名单（INV-5）。
 *   `anchorId = 那一轮顶层 agentRunId`（§3.9 规则 3）。
 * - 只还原账本里 track 过的文件（INV-3：文件工具 + shell pre-track 的修改/删除；
 *    / ）。不碰用户手改、未备份的终端新建，以及扫描护栏外漏掉的改动。
 * - **fail-visible**：单文件恢复失败计入 `failedFiles`，绝不静默当成功（INV-4）。
 *
 * 契约（与主进程 `file-history-ipc.ts` handler 一致）：
 * - 业务成功 → 返 `FileHistoryRewindResult`（剥掉 envelope）。
 * - 业务失败（未知 anchor / path guard 拒绝 / 该 thread 未在本进程建过 file-history，
 *   如 Daemon 宿主会话）→ throw，由 caller 处理（caller 不应据此回滚对话——回退即终态）。
 */
import type {
  FileHistoryPreviewResult,
  FileHistoryRewindResult,
} from '../../../preload/file-history'

export type { FileHistoryRewindResult }

export type FileHistoryUnavailableReason =
  | 'no_file_history'
  | 'file_snapshot_missing'
  | 'path_guard_denied'
  | 'unrestorable_files'
  | 'preview_stale'
  | 'local_file_preview_failed'

export type ConversationOnlyFileReason = Extract<
  FileHistoryUnavailableReason,
  'no_file_history' | 'file_snapshot_missing' | 'path_guard_denied' | 'unrestorable_files'
>

/**
 * 主进程 file-history IPC 仍以错误文本保持旧客户端兼容。renderer 在这一处把
 * 稳定错误归一化，供“预览授权”与“执行结果”做精确匹配；未知错误不得据此放行。
 */
export function classifyFileHistoryUnavailableReason(error: unknown): FileHistoryUnavailableReason {
  const stableReason = error && typeof error === 'object' && 'reason' in error
    ? (error as { reason?: unknown }).reason
    : undefined
  if (
    stableReason === 'no_file_history'
    || stableReason === 'file_snapshot_missing'
    || stableReason === 'path_guard_denied'
    || stableReason === 'unrestorable_files'
    || stableReason === 'preview_stale'
  ) return stableReason
  const detail = error instanceof Error ? error.message : String(error)
  const normalized = detail.toLowerCase()
  if (normalized.includes('no file-history for thread')) return 'no_file_history'
  if (normalized.includes('snapshot not found')) return 'file_snapshot_missing'
  if (
    normalized.includes('outside your workspace')
    || normalized.includes('protected path')
    || normalized.includes('path guard')
  ) {
    return 'path_guard_denied'
  }
  return 'local_file_preview_failed'
}

class FileHistoryRewindError extends Error {
  constructor(message: string, readonly reason?: string) {
    super(message)
  }
}

export function canContinueWithoutFileRestore(
  reason: string | null | undefined,
): reason is ConversationOnlyFileReason {
  return reason === 'no_file_history'
    || reason === 'file_snapshot_missing'
    || reason === 'path_guard_denied'
    || reason === 'unrestorable_files'
}

function api() {
  return window.tabtin?.fileHistory
}

/** 当前宿主是否暴露了 per-file 回退桥（非 Electron 宿主返 false）。 */
export function isAvailable(): boolean {
  return !!api()
}

/**
 * 把 `threadId` 在 `anchorId(=agentRunId)` 那一轮**开始前** track 的文件还原。
 *
 * 抛错语义：API 不可用 / 主进程返 `{ success:false }`（未知 anchor、path guard
 * 拒绝、thread 无 file-history）。引擎在抛错时保证未触碰任何文件（原子拒绝），
 * 故 caller 可安全地"保留对话回退、仅提示文件层失败"。
 */
export async function rewind(
  threadId: string,
  anchorId: string,
  expectedPreviewRevision?: string,
): Promise<FileHistoryRewindResult> {
  const fh = api()
  if (!fh) throw new Error('File history API not available')
  const res = await fh.rewind(threadId, anchorId, expectedPreviewRevision)
  if (!res.success) throw new FileHistoryRewindError(res.error || 'File history rewind failed', res.reason)
  return res.result
}

/**
 * 预览：列出把 `threadId` 在 `anchorId(=agentRunId)` 那一轮回退会**实际写/删**的文件
 * （绝对路径），不写盘。回退预览面板据此用 **per-file 本地能力**判定"将恢复哪些文件"，
 * 覆盖后端基于旧 shadow-git `checkpoint_hash` 的文件能力误报（见 §3.5 / Bug 2）。
 *
 * 抛错语义同 `rewind`：API 不可用 / 主进程返 `{ success:false }`（未知 anchor、path guard
 * 拒绝、**该 thread 在本机磁盘无账本——典型即 Daemon 宿主会话**）。调用方应在抛错时
 * **回退到后端能力**（不把本地缺账本当"无文件可恢复"），仅当成功时才用本地结果覆盖。
 */
export async function getAffectedPaths(threadId: string, anchorId: string): Promise<string[]> {
  const fh = api()
  if (!fh) throw new Error('File history API not available')
  const res = await fh.getAffectedPaths(threadId, anchorId)
  if (!res.success) throw new Error(res.error || 'File history getAffectedPaths failed')
  return res.paths
}

/**
 * 本机权威文件预览。revision 绑定 anchor、受影响路径与 diff 当前/目标内容；
 * Host 会在任何时间线/文件副作用前用同源逻辑复验。
 */
export async function getPreview(
  threadId: string,
  anchorId: string | null,
): Promise<FileHistoryPreviewResult> {
  const fh = api()
  if (!fh?.getPreview) throw new Error('File history preview API not available')
  return fh.getPreview(threadId, anchorId)
}

/**
 * 回退前 safety 快照：把当前 tracked 文件状态记入专用 anchor，供 unrevert 时
 * `rewind(safetyAnchorId)` 还原到回退前工作区。
 */
export async function createSafetySnapshot(threadId: string, safetyAnchorId: string): Promise<void> {
  const fh = api()
  if (!fh?.createSafetySnapshot) throw new Error('File history safety snapshot API not available')
  const res = await fh.createSafetySnapshot(threadId, safetyAnchorId)
  if (!res.success) throw new Error(res.error || 'File history createSafetySnapshot failed')
}

export interface FileHistoryDiffEntry {
  path: string
  status: 'added' | 'modified' | 'deleted'
  before?: string
  after?: string
}

/**
 * 预览：回退到 anchor 会变更的文件 diff（与 `rewind` 同 anchor，）。
 * shadow-git `checkpoint_hash` 仅作 fallback。
 */
export async function getRewindDiff(threadId: string, anchorId: string): Promise<FileHistoryDiffEntry[]> {
  const fh = api()
  if (!fh?.getRewindDiff) throw new Error('File history getRewindDiff API not available')
  const res = await fh.getRewindDiff(threadId, anchorId)
  if (!res.success) throw new Error(res.error || 'File history getRewindDiff failed')
  return res.diffs
}
